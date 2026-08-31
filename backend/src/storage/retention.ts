/**
 * The write-behind retention writer (D16).
 *
 * ---------------------------------------------------------------------------
 * CHAT NEVER WAITS ON THIS
 * ---------------------------------------------------------------------------
 * `enqueue` is synchronous and returns immediately. It performs no I/O, takes
 * no lock and cannot block. If you ever find yourself awaiting a database
 * insert on the message path, that is the bug (D16): a synchronous insert makes
 * database latency into chat latency, and a database outage into a chat outage.
 *
 * The consequence is stated plainly rather than hidden: retention is
 * best-effort under queue overflow and under a database outage. Drops are
 * counted and alerted, never silent.
 *
 *   enqueue → bounded queue (per class + per session) → breaker
 *                                                        ├── CLOSED → batch → INSERT
 *                                                        └── OPEN   → spool
 *                                                                       └── recovery: paced drain
 */
import type { Config, RetentionPriority } from '../config';
import { dbErrorFields, type Logger } from '../logger';
import { CircuitBreaker, DrainPacer, type BreakerState } from './breaker';
import { isMissingParentError, isPermanentWriteError, type Database } from './pool';
import { RetentionQueue, type QueueStats } from './queue';
import type {
  MessagePriorityContext,
  QueuedRecord,
  RecordKind,
  RetentionRecord,
} from './records';
import { priorityFor } from './records';
import { Repositories } from './repositories';
import type { RetentionSink } from './sink';
import type { Spool } from './spool';
import { monotonicMs, secondsSince } from '../util/time';

/**
 * How many unobserved batch durations to keep.
 *
 * Generous next to the publish interval, and bounded so a process with metrics
 * switched off does not accumulate an array for its whole life.
 */
const MAX_PENDING_DURATIONS = 512;

/**
 * The SQLSTATE of a driver error, or a placeholder.
 *
 * A code and nothing else. The error object itself is never read further here
 * for the same reason `dbErrorFields` exists: `pg` echoes the parameters of the
 * failing statement on a constraint violation, and those parameters are message
 * bodies (I8). SQLSTATE is a fixed five-character vocabulary, which is also
 * what makes it safe as a metric label.
 */
function sqlStateOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'unknown';
}

export interface RetentionCounters {
  queued: number;
  written: number;
  /** By class and reason. Every drop is counted; none is silent. */
  dropped: Record<string, number>;
  spooled: number;
  drained: number;
  quotaEvictions: number;
  /**
   * Failed batch writes by SQL state, cumulative.
   *
   * A code, never a driver error object: `pg` echoes the parameters of the
   * failing statement, and those parameters are message bodies (I8).
   */
  writeFailures: Record<string, number>;
  /** Breaker state changes by target state, cumulative. */
  breakerTransitions: Record<string, number>;
}

export type EnqueueResult =
  | { accepted: true }
  /**
   * Refused. For a P0 record the caller **must** fail the client operation
   * that produced it: acknowledging a report the system could not record would
   * be a lie to a user asking for help (§14.3).
   */
  | { accepted: false; priority: RetentionPriority };

/**
 * The order tables must be written in, matching `Repositories.writeBatch`.
 * `messages` and `reports` carry foreign keys into `conversations`, so the
 * parent has to go first or the salvage pass recreates the problem it exists
 * to solve.
 */
const KIND_WRITE_ORDER: readonly RecordKind[] = [
  'conversation_started',
  'conversation_ended',
  'message',
  'report',
  'block',
  'moderation_event',
  'enforcement',
  'admin_audit',
];

/**
 * Where a record goes when this cycle could not write it.
 *
 * The salvage pass is shared by the live queue and the spool drain, and it used
 * to send everything it rescued to the in-memory queue regardless of where the
 * record came from (F-034). For a record that arrived through `enqueue` that is
 * right — memory is where it already lived. For one recovered from the spool it
 * silently downgraded its durability: a record written to disk precisely
 * because the database was down was moved back into process memory to wait
 * there, and a restart — the likely event right after a database outage — lost
 * it with no counter moving.
 *
 * So the destination is a parameter. `RetentionQueue` satisfies this shape
 * already; the spool drain passes a collector instead and writes what it
 * collects back to disk.
 */
interface RetryTarget {
  /** Waiting on a parent row another instance has not flushed yet. */
  defer(entries: readonly QueuedRecord[]): void;
  /** Failed for a reason that may not recur — a timeout, a dead connection. */
  requeue(entries: readonly QueuedRecord[]): void;
}

/**
 * Collects what a spool drain could not write, so it can go back to disk.
 *
 * Both methods land in one list because the spool has no lanes and no ordering
 * to restore: it is rewritten whole and read back in file order. The
 * distinction between deferring and requeueing is a queue concept, and
 * flattening it here is deliberate rather than an oversight.
 */
class SpoolRetryTarget implements RetryTarget {
  readonly held: QueuedRecord[] = [];

  defer(entries: readonly QueuedRecord[]): void {
    this.held.push(...entries);
  }

  requeue(entries: readonly QueuedRecord[]): void {
    this.held.push(...entries);
  }
}

export class RetentionWriter implements RetentionSink {
  private readonly queue: RetentionQueue;
  private readonly repositories: Repositories;
  private readonly breaker: CircuitBreaker;
  private readonly pacer: DrainPacer;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private stopped = false;

  readonly counters: RetentionCounters = {
    queued: 0,
    written: 0,
    dropped: {},
    spooled: 0,
    drained: 0,
    quotaEvictions: 0,
    writeFailures: {},
    breakerTransitions: {},
  };

  /**
   * How long recent batch writes took, in seconds, waiting to be observed.
   *
   * A histogram cannot be reconstructed from a cumulative total the way a
   * counter can, so this is the one thing the publisher has to *drain* rather
   * than diff. Bounded by `MAX_PENDING_DURATIONS`: if nothing ever collects
   * them — metrics disabled, publisher not running — the oldest are dropped
   * rather than accumulating for the life of the process.
   */
  private readonly writeDurations: number[] = [];

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly db: Database,
    private readonly spool: Spool,
  ) {
    this.queue = new RetentionQueue(config);
    this.repositories = new Repositories(config);
    this.breaker = new CircuitBreaker(config, logger, (to) => {
      // The breaker already had this hook and nothing used it. Counting here
      // keeps the write path free of any metrics dependency: this increments a
      // number on `counters`, exactly like every other total the publisher
      // pulls.
      this.counters.breakerTransitions[to] = (this.counters.breakerTransitions[to] ?? 0) + 1;
    });
    this.pacer = new DrainPacer(config.breaker.drainBatchesPerSec);
  }

  /**
   * Accept a record for eventual persistence. Never blocks, never throws.
   *
   * The priority is computed from server-side signals only (D27); the context
   * argument carries the moderation result and the conversation's report state,
   * both of which the server produced.
   */
  enqueue(record: RetentionRecord, context?: MessagePriorityContext): EnqueueResult {
    if (!this.config.retention.enabled) return { accepted: true };

    if (record.kind === 'report') this.reportedConversations.add(record.conversationId);

    const priority = priorityFor(record, context);
    const outcome = this.queue.enqueue(record, context);

    if (!outcome.accepted) {
      this.dropRecord(priority, 'queue_full', record);
      return { accepted: false, priority };
    }

    this.counters.queued += 1;

    if (outcome.evicted) {
      // Something older was shed to make room. A `quota` eviction means the
      // incoming session was over its share of the class and displaced its own
      // record rather than someone else's — which is the whole reason the
      // sub-quota exists (D26).
      const evicted = outcome.evicted;
      if (outcome.reason === 'quota') this.counters.quotaEvictions += 1;
      this.dropRecord(
        evicted.priority,
        outcome.reason === 'quota' ? 'session_quota' : 'evicted',
        evicted.record,
      );
    }

    return { accepted: true };
  }

  /**
   * Conversations with an open report, for the P2 priority signal.
   *
   * Held in memory and bounded by the match TTL's worth of conversations this
   * instance has seen: the alternative is a database round trip on the message
   * path, and nothing about the priority of a retention row is worth making
   * chat wait for a query (D16). An instance that has not seen the report
   * simply assigns P3, which is the same answer it would give for a
   * conversation reported a moment later — D27 forbids retroactive promotion
   * either way.
   */
  private readonly reportedConversations = new Set<string>();

  isConversationReported(conversationId: string): boolean {
    return this.reportedConversations.has(conversationId);
  }

  /** Start the periodic flush. */
  start(): void {
    if (!this.config.retention.enabled || this.flushTimer) return;
    this.spool.open();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.retention.flushIntervalMs);
    this.flushTimer.unref();
  }

  /**
   * Stop flushing and make a final attempt to place what is held.
   *
   * On shutdown the remaining records are written if the database is reachable
   * and spooled if it is not — losing them silently at exactly the moment an
   * operator restarts the process would be the least excusable time to do it.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    const remaining = this.queue.drainAll();
    if (remaining.length > 0) this.toSpool(remaining);
  }

  /**
   * One flush cycle.
   *
   * Re-entrancy is guarded rather than queued: a flush that overruns its
   * interval must not have a second one running beside it, doubling the load
   * on a database that is evidently already slow.
   */
  async flush(nowMs = Date.now()): Promise<void> {
    if (this.flushing || !this.config.retention.enabled) return;
    this.flushing = true;
    try {
      if (!this.breaker.canAttempt(nowMs)) {
        // OPEN: no write is attempted at all. That is the point — a dead
        // database must stop consuming connections and latency budget.
        const held = this.queue.drainAll();
        if (held.length > 0) this.toSpool(held);
        return;
      }

      await this.drainSpool(nowMs);

      const batch = this.queue.take(this.config.retention.batchSize);
      if (batch.length === 0) return;
      await this.writeBatch(batch, nowMs);
    } finally {
      this.flushing = false;
    }
  }

  /**
   * Take the batch durations recorded since the last call.
   *
   * Explicitly draining, and named so, because `snapshot()` is a read and must
   * stay one. A histogram needs each observation once; leaving them in place
   * would replay every duration on every publish.
   */
  takeWriteDurations(): number[] {
    return this.writeDurations.splice(0, this.writeDurations.length);
  }

  private recordWriteDuration(startedAtMs: number): void {
    if (this.writeDurations.length >= MAX_PENDING_DURATIONS) this.writeDurations.shift();
    this.writeDurations.push(secondsSince(startedAtMs));
  }

  snapshot(): {
    queue: QueueStats;
    breaker: BreakerState;
    spool: ReturnType<Spool['stats']>;
    counters: RetentionCounters;
  } {
    return {
      queue: this.queue.stats(),
      breaker: this.breaker.current,
      spool: this.spool.stats(),
      counters: this.counters,
    };
  }

  /* --- internals ----------------------------------------------------------- */

  private async writeBatch(batch: QueuedRecord[], nowMs: number): Promise<void> {
    const startedAt = monotonicMs();
    try {
      await this.repositories.writeBatch(this.db, batch, nowMs);
      this.recordWriteDuration(startedAt);
      this.breaker.recordSuccess();
      this.counters.written += batch.length;
      return;
    } catch (err) {
      this.recordWriteDuration(startedAt);
      const code = sqlStateOf(err);
      this.counters.writeFailures[code] = (this.counters.writeFailures[code] ?? 0) + 1;
      // Never the error object: the driver echoes the parameters of the failing
      // statement, and those parameters are message bodies (I8).
      if (!isPermanentWriteError(err)) {
        this.logger.error('retention batch failed', {
          batchSize: batch.length,
          ...dbErrorFields(err),
        });
        this.breaker.recordFailure(nowMs);
        // Put them back rather than dropping: if the breaker has now opened,
        // the next cycle spools them; if not, the next cycle retries.
        this.queue.requeue(batch);
        return;
      }

      // The database is up — it read the statement and refused the data, so
      // this is not a breaker event. But a batch is one transaction, and one
      // refused row has just rolled back every other record in it. Salvage the
      // rest rather than discarding all of them, which is how a single
      // out-of-order message used to destroy a hundred reports and blocks.
      this.breaker.recordSuccess();
      // These came from the queue, so anything rescued goes back to it.
      await this.salvage(batch, nowMs, err, this.queue);
    }
  }

  /**
   * Rescue what a rejected batch was carrying.
   *
   * Written per kind, in the same dependency order `writeBatch` uses, each in
   * its own transaction — so a table the database refuses cannot take the other
   * tables down with it. The kinds that fail are then handled on their own
   * terms: a missing parent is waited on, anything else is narrowed to the
   * individual rows actually at fault.
   *
   * `target` is where anything rescued but unwritten goes. It is a parameter
   * because this pass serves both the live queue and the spool drain, and those
   * two must not share a destination (F-034).
   */
  private async salvage(
    batch: QueuedRecord[],
    nowMs: number,
    err: unknown,
    target: RetryTarget,
  ): Promise<void> {
    this.logger.warn('a retention batch was rejected; salvaging it per table', {
      batchSize: batch.length,
      ...dbErrorFields(err),
    });

    const groups = new Map<RecordKind, QueuedRecord[]>();
    for (const entry of batch) {
      const group = groups.get(entry.record.kind);
      if (group) group.push(entry);
      else groups.set(entry.record.kind, [entry]);
    }

    for (const kind of KIND_WRITE_ORDER) {
      const group = groups.get(kind);
      if (group !== undefined) await this.writeGroup(group, nowMs, target);
    }
  }

  /** One kind, one transaction. Narrows further only when it has to. */
  private async writeGroup(
    group: QueuedRecord[],
    nowMs: number,
    target: RetryTarget,
  ): Promise<void> {
    try {
      await this.repositories.writeBatch(this.db, group, nowMs);
      this.counters.written += group.length;
      return;
    } catch (err) {
      if (!isPermanentWriteError(err)) {
        this.breaker.recordFailure(nowMs);
        target.requeue(group);
        return;
      }

      if (group.length === 1) {
        if (isMissingParentError(err)) this.deferForParent(group, err, target);
        else this.discard(group, err);
        return;
      }

      // A bad row somewhere in here, and the batch is one transaction, so it
      // has already rolled back every innocent row beside it. Isolate it so the
      // rest survive.
      //
      // A missing parent needs this as much as a malformed row does, and used
      // not to get it: the whole group was deferred together, retried together
      // and -- when the one orphan's parent never turned up -- discarded
      // together. Ninety-nine messages whose conversations existed all along
      // were dropped because they shared a batch with one whose did not, which
      // is the failure this narrowing exists to prevent, arriving through the
      // one door left open to it.
      for (const entry of group) await this.writeGroup([entry], nowMs, target);
    }
  }

  /**
   * Hold records whose parent row has not been written yet.
   *
   * Not an error: the conversation is created by whichever instance won the
   * match, and both participants' messages are flushed by whichever instances
   * own their sockets. The parent lands within a cycle or so. Bounded, so a row
   * whose parent genuinely never arrives is eventually dropped and counted
   * rather than circulating forever.
   */
  private deferForParent(group: QueuedRecord[], err: unknown, target: RetryTarget): void {
    const waiting: QueuedRecord[] = [];
    const exhausted: QueuedRecord[] = [];

    for (const entry of group) {
      const waits = (entry.parentWaits ?? 0) + 1;
      if (waits > this.config.retention.missingParentRetries) exhausted.push(entry);
      else waiting.push({ ...entry, parentWaits: waits });
    }

    if (waiting.length > 0) target.defer(waiting);
    if (exhausted.length > 0) {
      this.logger.error('discarding retention records whose parent row never arrived', {
        count: exhausted.length,
        ...dbErrorFields(err),
      });
      for (const entry of exhausted) {
        this.dropRecord(entry.priority, 'no_parent', entry.record);
      }
    }
  }

  /** Give up on records the database will never accept. */
  private discard(group: QueuedRecord[], err: unknown): void {
    this.logger.error('discarding retention records the database rejected', {
      count: group.length,
      ...dbErrorFields(err),
    });
    for (const entry of group) {
      this.dropRecord(entry.priority, 'rejected', entry.record);
    }
  }

  /**
   * Replay what the spool holds, one paced batch per cycle.
   *
   * The pacing is the whole point: replaying a backlog at full speed the
   * instant a database returns is how an outage repeats itself, because the
   * recovery load is exactly the load that could not be served.
   */
  private async drainSpool(nowMs: number): Promise<void> {
    if (this.spool.isEmpty) return;
    if (!this.pacer.tryConsume(nowMs)) return;

    const spooled = this.spool.read(nowMs);
    if (spooled.length === 0) {
      this.spool.clear();
      return;
    }

    const batch = spooled.slice(0, this.config.retention.batchSize);
    try {
      await this.repositories.writeBatch(this.db, batch, nowMs);
      this.breaker.recordSuccess();
      this.counters.drained += batch.length;
      this.counters.written += batch.length;

      // Everything read is rewritten minus what was just persisted. The spool
      // is only cleared once the records are safely in the database, so a
      // failure part-way leaves it intact rather than half-consumed.
      const remaining = spooled.slice(batch.length);
      this.spool.clear();
      this.respool(remaining);
    } catch (err) {
      if (isPermanentWriteError(err)) {
        // The database answered and refused the batch, so this is not a breaker
        // event -- and a spooled record it will always refuse must not be left
        // to block the drain of every record behind it.
        //
        // But refusing the batch is not refusing every record in it. This used
        // to discard all hundred, which is the exact failure `writeBatch`
        // already learnt not to commit: one message whose conversation row had
        // not landed yet would take the conversation rows, the moderation
        // events and the reports sharing its batch down with it. A chaos run
        // made it visible the moment the spool became reachable -- twelve
        // rejected batches, every one of them a single 23503 on
        // messages_conversation_id_fkey, and 345 P0 records destroyed by it.
        //
        // So salvage on the same terms as the live path: per kind, in
        // dependency order, each in its own transaction, with a missing parent
        // waited on rather than discarded.
        //
        // On the same terms, but not to the same place. Salvage returns what it
        // could not write, and for a spooled record that destination has to be
        // the spool again (F-034). Sending it to the in-memory queue -- which is
        // what this did -- took a record that was on disk *because the database
        // was down*, moved it into process memory to wait for a parent row, and
        // then cleared the file. A restart in that window lost it silently, and
        // a restart is the likely event right after a database outage.
        this.breaker.recordSuccess();
        const retry = new SpoolRetryTarget();
        await this.salvage(batch, nowMs, err, retry);

        // Behind `remaining`, not in front of it, for the reason
        // `RetentionQueue.defer` puts deferred records at the back of their
        // lane: a record waiting on a parent has no claim on the next batch,
        // and leading with it would let a few waiting records block the drain
        // of everything queued behind them.
        const remaining = spooled.slice(batch.length);
        this.spool.clear();
        this.respool([...remaining, ...retry.held]);
        return;
      }

      this.logger.error('spool drain failed', { batchSize: batch.length, ...dbErrorFields(err) });
      this.breaker.recordFailure(nowMs);
    }
  }

  /**
   * Put records the drain could not persist back into the spool.
   *
   * Everything passed here was read out of the spool moments ago and the file
   * has just been cleared, so the size bounds cannot bind. The write can still
   * fail on I/O, though, and a record lost that way must be counted rather than
   * disappear — counting the loss is the difference between this path and the
   * one it replaces.
   *
   * Deliberately not `toSpool`: that adds what it writes to `counters.spooled`,
   * and these records were counted when they were spooled the first time.
   * Counting them again on every drain that defers them would make the metric
   * mean something other than "records that entered the spool". The shortfall
   * reuses `spool_full` rather than inventing a reason, so the label set on
   * `chat_retention_dropped_total` stays what it was; `spool.write` already
   * counts its own refusals and logs the I/O error behind them.
   */
  private respool(entries: QueuedRecord[]): void {
    if (entries.length === 0) return;
    const written = this.spool.write(entries);
    if (written < entries.length) {
      for (const entry of entries.slice(written)) {
        this.dropRecord(entry.priority, 'spool_full', entry.record);
      }
    }
  }

  private toSpool(entries: QueuedRecord[]): void {
    const written = this.spool.write(entries);
    this.counters.spooled += written;
    if (written < entries.length) {
      for (const entry of entries.slice(written)) {
        this.dropRecord(entry.priority, 'spool_full', entry.record);
      }
    }
  }

  /**
   * A dropped record is always counted and, for P0, always logged at error.
   *
   * P0 being dropped is page-worthy however it happened: the system is losing
   * safety evidence and nothing else in the process will notice. But *how* it
   * happened decides what the operator does next, and the two causes need
   * opposite responses -- `queue_full` means the writer cannot keep up and the
   * limits or the database need attention, while `rejected` means the database
   * answered and refused the row, which is a schema or data problem no amount
   * of capacity will fix. The reason is on the counter, so it belongs on the
   * line that wakes somebody up too: this used to say "retention capacity
   * exhausted" for every drop, and a chaos run produced 357 of those for
   * records the database had rejected outright.
   */
  private dropRecord(
    priority: RetentionPriority,
    reason: string,
    record: RetentionRecord,
  ): void {
    const key = `${priority}:${reason}`;
    this.counters.dropped[key] = (this.counters.dropped[key] ?? 0) + 1;

    const fields = { priority, reason, recordKind: record.kind };
    if (priority === 'p0') {
      this.logger.error('dropped a safety record', fields);
    } else if (!this.stopped) {
      this.logger.warn('dropped a retention record', fields);
    }
  }
}
