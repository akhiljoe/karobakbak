/**
 * Publishing retention, spool, breaker, deletion and backup state as metrics.
 *
 * These are read from the components rather than pushed by them, so nothing in
 * the write path carries a metrics dependency: the retention writer's job is to
 * not slow chat down, and threading a registry through it would be one more
 * thing on that path to get wrong.
 *
 * The counters are cumulative on both sides, so this sets gauges directly and
 * advances counters by the delta since the last sample. A counter that was
 * `set` would go backwards on a restart of the source and break every rate()
 * over it.
 */
import type { BackupMonitor } from '../storage/backup';
import { BREAKER_STATE_CODE, type BreakerState } from '../storage/breaker';
import type { DeletionWorker } from '../storage/deletion';
import type { RetentionWriter } from '../storage/retention';
import type { Metrics } from './registry';

interface Deltas {
  [key: string]: number;
}

export class RetentionMetricsPublisher {
  private readonly last: Deltas = {};

  constructor(
    private readonly metrics: Metrics,
    private readonly writer: RetentionWriter | null,
    private readonly deletion: DeletionWorker | null,
    private readonly backup: BackupMonitor | null,
  ) {}

  /** Sample every source once. Cheap: all of it is in-memory state. */
  publish(nowMs = Date.now()): void {
    this.publishWriter();
    this.publishDeletion();
    this.publishBackup(nowMs);
  }

  private publishWriter(): void {
    if (!this.writer) return;
    const snapshot = this.writer.snapshot();

    for (const [priority, depth] of Object.entries(snapshot.queue.depth)) {
      this.metrics.retentionQueueDepth.labels(priority).set(depth);
    }

    this.advance('queued', snapshot.counters.queued, this.metrics.retentionQueued);
    this.advance('written', snapshot.counters.written, this.metrics.retentionFlushed);
    this.advance('spooled', snapshot.counters.spooled, this.metrics.spoolWrites);
    this.advance('drained', snapshot.counters.drained, this.metrics.spoolDrained);
    this.advance(
      'quotaEvictions',
      snapshot.counters.quotaEvictions,
      this.metrics.retentionQuotaEvictions,
    );

    // The queue reports drops keyed `class:reason`, which is exactly the label
    // pair the metric carries — both halves are from fixed sets.
    for (const [key, count] of Object.entries(snapshot.counters.dropped)) {
      const [priority, reason] = key.split(':');
      if (!priority || !reason) continue;
      const delta = count - (this.last[`dropped:${key}`] ?? 0);
      if (delta > 0) this.metrics.retentionDropped.labels(priority, reason).inc(delta);
      this.last[`dropped:${key}`] = count;
    }

    this.metrics.spoolRecords.set(snapshot.spool.records);
    this.metrics.spoolBytes.set(snapshot.spool.bytes);
    this.advance('spoolCorrupt', snapshot.spool.corrupt, this.metrics.spoolCorrupt);
    this.advance('spoolExpired', snapshot.spool.expired, this.metrics.spoolExpired);

    this.metrics.breakerState.set(BREAKER_STATE_CODE[snapshot.breaker as BreakerState]);

    // Both keyed by a value from a fixed vocabulary — a breaker state, a
    // SQLSTATE — so the label cardinality is bounded by the vocabulary and not
    // by traffic.
    for (const [to, count] of Object.entries(snapshot.counters.breakerTransitions)) {
      const delta = count - (this.last[`breaker:${to}`] ?? 0);
      if (delta > 0) this.metrics.breakerTransitions.labels(to).inc(delta);
      this.last[`breaker:${to}`] = count;
    }

    for (const [code, count] of Object.entries(snapshot.counters.writeFailures)) {
      const delta = count - (this.last[`dbfail:${code}`] ?? 0);
      if (delta > 0) this.metrics.dbWriteFailures.labels(code).inc(delta);
      this.last[`dbfail:${code}`] = count;
    }

    // Drained rather than diffed: a histogram needs each observation once, and
    // there is no cumulative total to subtract a previous sample from.
    for (const seconds of this.writer.takeWriteDurations()) {
      this.metrics.dbWriteLatency.observe(seconds);
    }
  }

  private publishDeletion(): void {
    if (!this.deletion) return;
    const totals = this.deletion.totals;
    for (const [table, count] of Object.entries(totals)) {
      const delta = count - (this.last[`deleted:${table}`] ?? 0);
      if (delta > 0) this.metrics.retentionDeleted.labels(table).inc(delta);
      this.last[`deleted:${table}`] = count;
    }
    this.advance('deletionFailures', this.deletion.failures, this.metrics.deletionFailures);
  }

  private publishBackup(nowMs: number): void {
    if (!this.backup) return;
    const status = this.backup.status(nowMs);
    if (status.lastSuccessMs !== null) {
      // Seconds, because that is what every "how old is this" alert expression
      // expects to subtract from `time()`.
      this.metrics.backupLastSuccess.set(Math.floor(status.lastSuccessMs / 1000));
    }
    this.advance('backupFailures', status.failures, this.metrics.backupFailures);
  }

  private advance(key: string, total: number, counter: { inc(value: number): void }): void {
    const delta = total - (this.last[key] ?? 0);
    if (delta > 0) counter.inc(delta);
    this.last[key] = total;
  }
}
