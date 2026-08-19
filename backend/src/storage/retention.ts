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

export interface RetentionCounters {
  queued: number;
  written: number;
  /** By class and reason. Every drop is counted; none is silent. */
  dropped: Record<string, number>;
  spooled: number;
  drained: number;
  quotaEvictions: number;
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
  };

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly db: Database,
    private readonly spool: Spool,
  ) {
    this.queue = new RetentionQueue(config);
    this.repositories = new Repositories(config);
    this.breaker = new CircuitBreaker(config, logger);
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
      this.countDrop(priority, 'queue_full');
      this.reportDrop(priority, record);
      return { accepted: false, priority };
    }

    this.counters.queued += 1;

    if (outcome.evicted) {
      // Something older was shed to make room. A `quota` eviction means the
      // incoming session was over its share of the class and displaced its own
      // record rather than someone else's — which is the whole reason the
      // sub-quota exists (D26).
      const evicted = outcome.evicted;
      this.countDrop(evicted.priority, outcome.reason === 'quota' ? 'session_quota' : 'evicted');
      if (outcome.reason === 'quota') this.counters.quotaEvictions += 1;
      this.reportDrop(evicted.priority, evicted.record);
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
    try {
      await this.repositories.writeBatch(this.db, batch, nowMs);
      this.breaker.recordSuccess();
      this.counters.written += batch.length;
      return;
    } catch (err) {
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
      await this.salvage(batch, nowMs, err);
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
   */
  private async salvage(batch: QueuedRecord[], nowMs: number, err: unknown): Promise<void> {
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
      if (group !== undefined) await this.writeGroup(group, nowMs);
    }
  }

  /** One kind, one transaction. Narrows further only when it has to. */
  private async writeGroup(group: QueuedRecord[], nowMs: number): Promise<void> {
    try {
      await this.repositories.writeBatch(this.db, group, nowMs);
      this.counters.written += group.length;
      return;
    } catch (err) {
      if (!isPermanentWriteError(err)) {
        this.breaker.recordFailure(nowMs);
        this.queue.requeue(group);
        return;
      }

      if (isMissingParentError(err)) {
        this.deferForParent(group, err);
        return;
      }

      if (group.length === 1) {
        this.discard(group, err);
        return;
      }

      // A genuinely bad row somewhere in here. Isolate it so the rest survive.
      for (const entry of group) await this.writeGroup([entry], nowMs);
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
  private deferForParent(group: QueuedRecord[], err: unknown): void {
    const waiting: QueuedRecord[] = [];
    const exhausted: QueuedRecord[] = [];

    for (const entry of group) {
      const waits = (entry.parentWaits ?? 0) + 1;
      if (waits > this.config.retention.missingParentRetries) exhausted.push(entry);
      else waiting.push({ ...entry, parentWaits: waits });
    }

    if (waiting.length > 0) this.queue.defer(waiting);
    if (exhausted.length > 0) {
      this.logger.error('discarding retention records whose parent row never arrived', {
        count: exhausted.length,
        ...dbErrorFields(err),
      });
      for (const entry of exhausted) {
        this.countDrop(entry.priority, 'rejected');
        this.reportDrop(entry.priority, entry.record);
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
      this.countDrop(entry.priority, 'rejected');
      this.reportDrop(entry.priority, entry.record);
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
      if (remaining.length > 0) this.spool.write(remaining);
    } catch (err) {
      if (isPermanentWriteError(err)) {
        // Same reasoning, and it matters more here: a spooled record the
        // database will always refuse would otherwise block the drain of every
        // record written after it, forever, while the breaker reported an
        // outage that was not happening.
        this.logger.error('discarding spooled records the database rejected', {
          batchSize: batch.length,
          ...dbErrorFields(err),
        });
        this.breaker.recordSuccess();
        for (const entry of batch) {
          this.countDrop(entry.priority, 'rejected');
          this.reportDrop(entry.priority, entry.record);
        }
        const remaining = spooled.slice(batch.length);
        this.spool.clear();
        if (remaining.length > 0) this.spool.write(remaining);
        return;
      }

      this.logger.error('spool drain failed', { batchSize: batch.length, ...dbErrorFields(err) });
      this.breaker.recordFailure(nowMs);
    }
  }

  private toSpool(entries: QueuedRecord[]): void {
    const written = this.spool.write(entries);
    this.counters.spooled += written;
    if (written < entries.length) {
      for (const entry of entries.slice(written)) {
        this.countDrop(entry.priority, 'spool_full');
        this.reportDrop(entry.priority, entry.record);
      }
    }
  }

  private countDrop(priority: RetentionPriority, reason: string): void {
    const key = `${priority}:${reason}`;
    this.counters.dropped[key] = (this.counters.dropped[key] ?? 0) + 1;
  }

  /**
   * A dropped record is always counted and, for P0, always logged at error.
   *
   * P0 being full requires a sustained database outage *and* a report flood
   * beyond the per-session report limit. That is page-worthy: the system is
   * losing safety evidence, and nothing else in the process will notice.
   */
  private reportDrop(priority: RetentionPriority, record: RetentionRecord): void {
    const fields = { priority, recordKind: record.kind };
    if (priority === 'p0') {
      this.logger.error('dropped a safety record: retention capacity exhausted', fields);
    } else if (!this.stopped) {
      this.logger.warn('dropped a retention record', fields);
    }
  }
}
