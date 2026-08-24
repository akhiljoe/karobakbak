/**
 * The bounded write-behind queue (D26).
 *
 * ---------------------------------------------------------------------------
 * TWO BOUNDS, NOT ONE
 * ---------------------------------------------------------------------------
 * **Per class.** Each priority class has its own hard capacity, and the
 * capacities are not shared. A flood of ordinary messages fills P3 and stops;
 * it cannot reach into P0's budget. That is what makes "shed chat before
 * evidence" structural rather than a matter of ordering.
 *
 * **Per session, within each class.** Per-class caps alone are gameable: an
 * attacker who deliberately trips a mild moderation rule promotes their own
 * traffic into P1, fills it, and evicts *other people's* genuine evidence. A
 * sub-quota bounds how much of any one class a single session can occupy, so
 * the flood displaces its own records first.
 *
 * Eviction order when a class is full: the oldest entry belonging to the
 * offending session, if that session is over quota; otherwise the oldest entry
 * in the class. Either way something is dropped, counted, and never silently
 * forgotten — the caller is told which, because P0 has to fail the client
 * operation that produced it (§14.3).
 *
 * ---------------------------------------------------------------------------
 * P0 IS NEVER TAKEN FROM SOMEBODY ELSE
 * ---------------------------------------------------------------------------
 * The second half of that rule — "otherwise the oldest entry in the class" —
 * is right for chat and wrong for safety evidence, because P0 is the one class
 * whose records have already been *acknowledged to a user*. A report is
 * answered with `report_ack` the moment its record is accepted here, so
 * displacing an older P0 turns a visible refusal for the newest report into a
 * silent loss of somebody else's, after they were told it was filed.
 *
 * So a P0 record from a session that is *within* its quota does not evict; it
 * is refused, and the caller fails the client operation honestly. The
 * per-session branch above it stays exactly as it was: a session over its
 * share still displaces its own oldest record, which is the whole point of the
 * sub-quota (D26) and is what stops one flooder from making the class refuse
 * everybody. Contained to the flooder, never charged to a bystander.
 *
 * Anonymous users can open fresh sessions freely, so the sub-quota is not a
 * defence against a distributed report flood — which is exactly the case that
 * used to reach the cross-session eviction. Under pressure P0 now fills and
 * refuses, `chat_retention_dropped_total{class="p0"}` moves, and
 * `SafetyRecordsDropped` pages. That is the correct outcome: the operator
 * learns, and no evidence anybody was promised is quietly gone.
 */
import type { Config, RetentionPriority } from '../config';
import { priorityFor, quotaSessionFor, type MessagePriorityContext, type QueuedRecord, type RetentionRecord } from './records';

export const PRIORITIES: readonly RetentionPriority[] = ['p0', 'p1', 'p2', 'p3'];

export type EnqueueOutcome =
  | { accepted: true; evicted: null; reason: null }
  /**
   * Accepted, but something older had to go. `reason` says which rule chose
   * the victim: `quota` when the incoming session was over its share of the
   * class and paid for its own flood, `class_full` when it was within quota and
   * the class's oldest entry went instead.
   */
  | { accepted: true; evicted: QueuedRecord; reason: 'quota' | 'class_full' }
  /**
   * Refused: the class was full and this record was the one to drop.
   *
   * For P0 this is the ordinary outcome of a full class rather than an
   * exceptional one — see the note above on why safety evidence is never taken
   * from another session. The caller **must** fail the client operation that
   * produced the record (§14.3).
   */
  | { accepted: false; evicted: null; reason: 'class_full' };

/**
 * Classes whose records may not be displaced to make room for another
 * session's record.
 *
 * P0 alone. It is the class whose acceptance has already been reported to a
 * user, so an eviction there is a broken promise rather than shed load. P1
 * also carries evidence and is deliberately *not* here: nothing acknowledges a
 * P1 record to anyone, so shedding its oldest under pressure is honest
 * load-shedding, and the per-session sub-quota is the control that keeps one
 * session from aiming it at other people (D26).
 */
const NEVER_EVICTED_FOR_ANOTHER_SESSION: ReadonlySet<RetentionPriority> = new Set(['p0']);

export interface QueueStats {
  readonly depth: Readonly<Record<RetentionPriority, number>>;
  readonly total: number;
}

export class RetentionQueue {
  /** One FIFO per class. Arrays, because every operation is a shift or a push. */
  private readonly lanes = new Map<RetentionPriority, QueuedRecord[]>();
  /** Per class, per session, how many entries are held. */
  private readonly perSession = new Map<RetentionPriority, Map<string, number>>();

  constructor(private readonly config: Config) {
    for (const priority of PRIORITIES) {
      this.lanes.set(priority, []);
      this.perSession.set(priority, new Map());
    }
  }

  /** The most entries one session may hold in one class. Always at least one. */
  quotaFor(priority: RetentionPriority): number {
    const capacity = this.config.retention.queueMax[priority];
    return Math.max(1, Math.floor((capacity * this.config.retention.sessionQuotaPct) / 100));
  }

  enqueue(
    record: RetentionRecord,
    context?: MessagePriorityContext,
    nowMs = Date.now(),
  ): EnqueueOutcome {
    const priority = priorityFor(record, context);
    const sessionId = quotaSessionFor(record);
    const lane = this.laneFor(priority);
    const capacity = this.config.retention.queueMax[priority];

    const entry: QueuedRecord = { record, priority, sessionId, enqueuedAtMs: nowMs };

    if (lane.length < capacity) {
      this.push(entry);
      return { accepted: true, evicted: null, reason: null };
    }

    // The class is full. Whoever is over their share pays for it first.
    const counts = this.countsFor(priority);
    const mine = counts.get(sessionId) ?? 0;
    if (mine >= this.quotaFor(priority)) {
      const evicted = this.evictOldestFrom(priority, sessionId);
      if (evicted) {
        this.push(entry);
        return { accepted: true, evicted, reason: 'quota' };
      }
      // Unreachable while `mine > 0`, and if it ever is reachable the safe
      // answer is to refuse rather than to grow past the cap.
      return { accepted: false, evicted: null, reason: 'class_full' };
    }

    // Within quota, and the class is full — so every entry in it belongs to
    // somebody else. For safety evidence that is where eviction stops.
    if (NEVER_EVICTED_FOR_ANOTHER_SESSION.has(priority)) {
      return { accepted: false, evicted: null, reason: 'class_full' };
    }

    const evicted = this.evictOldest(priority);
    if (!evicted) return { accepted: false, evicted: null, reason: 'class_full' };
    this.push(entry);
    return { accepted: true, evicted, reason: 'class_full' };
  }

  /**
   * Take up to `limit` entries, highest priority first.
   *
   * Strict priority rather than weighted: under pressure the point is that
   * safety records leave the queue before ordinary chat, and a weighting would
   * make that "mostly".
   */
  take(limit: number): QueuedRecord[] {
    const taken: QueuedRecord[] = [];
    for (const priority of PRIORITIES) {
      const lane = this.laneFor(priority);
      while (lane.length > 0 && taken.length < limit) {
        const entry = lane.shift();
        if (!entry) break;
        this.release(entry);
        taken.push(entry);
      }
      if (taken.length >= limit) break;
    }
    return taken;
  }

  /**
   * Put entries back at the front of their lanes, for a batch that failed to
   * write. Order within a lane is restored, because a batch is taken in order.
   */
  /**
   * Return records to the **back** of their lane.
   *
   * For records waiting on something outside their own validity — a parent row
   * another instance has not flushed yet. They go behind whatever is already
   * queued rather than in front of it: a record that is waiting has no claim on
   * the next batch, and putting it at the front lets a small number of waiting
   * records starve fresh work at small batch sizes.
   */
  defer(entries: readonly QueuedRecord[]): void {
    for (const priority of PRIORITIES) {
      const returning = entries.filter((entry) => entry.priority === priority);
      if (returning.length === 0) continue;
      this.laneFor(priority).push(...returning);
      for (const entry of returning) this.retain(entry);
    }
  }

  requeue(entries: readonly QueuedRecord[]): void {
    for (const priority of PRIORITIES) {
      const returning = entries.filter((entry) => entry.priority === priority);
      if (returning.length === 0) continue;
      const lane = this.laneFor(priority);
      lane.unshift(...returning);
      for (const entry of returning) this.retain(entry);
    }
  }

  stats(): QueueStats {
    const depth = {} as Record<RetentionPriority, number>;
    let total = 0;
    for (const priority of PRIORITIES) {
      const size = this.laneFor(priority).length;
      depth[priority] = size;
      total += size;
    }
    return { depth, total };
  }

  get size(): number {
    return this.stats().total;
  }

  /** Everything currently held, highest priority first. Used when spooling out. */
  drainAll(): QueuedRecord[] {
    return this.take(Number.MAX_SAFE_INTEGER);
  }

  /* --- internals ----------------------------------------------------------- */

  private laneFor(priority: RetentionPriority): QueuedRecord[] {
    const lane = this.lanes.get(priority);
    if (!lane) throw new Error('retention queue: unknown priority class');
    return lane;
  }

  private countsFor(priority: RetentionPriority): Map<string, number> {
    const counts = this.perSession.get(priority);
    if (!counts) throw new Error('retention queue: unknown priority class');
    return counts;
  }

  private push(entry: QueuedRecord): void {
    this.laneFor(entry.priority).push(entry);
    this.retain(entry);
  }

  private retain(entry: QueuedRecord): void {
    const counts = this.countsFor(entry.priority);
    counts.set(entry.sessionId, (counts.get(entry.sessionId) ?? 0) + 1);
  }

  private release(entry: QueuedRecord): void {
    const counts = this.countsFor(entry.priority);
    const next = (counts.get(entry.sessionId) ?? 1) - 1;
    if (next <= 0) counts.delete(entry.sessionId);
    else counts.set(entry.sessionId, next);
  }

  private evictOldest(priority: RetentionPriority): QueuedRecord | null {
    const lane = this.laneFor(priority);
    const entry = lane.shift();
    if (!entry) return null;
    this.release(entry);
    return entry;
  }

  private evictOldestFrom(priority: RetentionPriority, sessionId: string): QueuedRecord | null {
    const lane = this.laneFor(priority);
    const index = lane.findIndex((entry) => entry.sessionId === sessionId);
    if (index === -1) return null;
    const [entry] = lane.splice(index, 1);
    if (!entry) return null;
    this.release(entry);
    return entry;
  }
}
