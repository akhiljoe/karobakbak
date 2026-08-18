/**
 * The deletion worker (§15, I10).
 *
 * ---------------------------------------------------------------------------
 * EXPIRY IS ENFORCED, NOT INTENDED
 * ---------------------------------------------------------------------------
 * A retention policy that only exists in configuration is a promise nobody
 * keeps. This is the thing that keeps it: it deletes rows past their stamped
 * deadline, in batches, on a schedule, and a failed pass raises an alert rather
 * than passing quietly (I10). "We meant to delete it" is not a defence anyone
 * gets to make twice.
 *
 * ---------------------------------------------------------------------------
 * THE CASCADE HAS TO BE GUARDED
 * ---------------------------------------------------------------------------
 * `messages.conversation_id` is `on delete cascade`, so deleting an expired
 * conversation takes its messages with it — *including messages under a legal
 * hold*, whose own deadline may have been extended past the conversation's.
 * The conversation query therefore excludes any conversation that still has a
 * held message. Without that, a hold placed on a message would be silently
 * defeated by the expiry of its parent, which is the exact failure a hold
 * exists to prevent.
 *
 * ---------------------------------------------------------------------------
 * ONE INSTANCE AT A TIME
 * ---------------------------------------------------------------------------
 * Leader-locked through Redis, like the janitor. Several instances deleting the
 * same batches would not corrupt anything — the deletes are idempotent — but it
 * would multiply the load on a database that is doing this work precisely
 * because it is not urgent.
 */
import type { Config } from '../config';
import { dbErrorFields, type Logger } from '../logger';
import type { Database } from './pool';

export interface DeletionCounts {
  conversations: number;
  messages: number;
  reports: number;
  moderationEvents: number;
  enforcement: number;
  adminAudit: number;
}

export interface DeletionPassResult {
  /** False when another instance held the lock; this pass did nothing. */
  ran: boolean;
  deleted: DeletionCounts;
  /** True when a batch was full, so more remains for the next pass. */
  more: boolean;
}

/** Takes the distributed lock, so only one instance deletes at a time. */
export interface DeletionLock {
  acquireDeletionLock(instanceId: string): Promise<boolean>;
}

const EMPTY: DeletionCounts = {
  conversations: 0,
  messages: 0,
  reports: 0,
  moderationEvents: 0,
  enforcement: 0,
  adminAudit: 0,
};

export class DeletionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  /** Cumulative, for the metrics registry and for the failure alert (I10). */
  readonly totals: DeletionCounts = { ...EMPTY };
  failures = 0;
  lastSuccessMs: number | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly db: Database,
    private readonly lock: DeletionLock,
  ) {}

  start(): void {
    if (!this.config.deletion.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass();
    }, this.config.deletion.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One pass. Never throws: a deletion failure is an operational alert, not a
   * reason to take down a process that is otherwise serving chat.
   */
  async runPass(): Promise<DeletionPassResult> {
    if (this.running) return { ran: false, deleted: { ...EMPTY }, more: false };
    this.running = true;
    try {
      const holdsLock = await this.lock.acquireDeletionLock(this.config.instanceId);
      if (!holdsLock) return { ran: false, deleted: { ...EMPTY }, more: false };

      const deleted = await this.deleteExpired();
      this.lastSuccessMs = Date.now();
      for (const key of Object.keys(deleted) as Array<keyof DeletionCounts>) {
        this.totals[key] += deleted[key];
      }

      const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
      if (total > 0) {
        this.logger.info('deleted expired rows', { ...deleted, total });
      }

      const batch = this.config.deletion.batch;
      const more = Object.values(deleted).some((count) => count >= batch);
      return { ran: true, deleted, more };
    } catch (err) {
      this.failures += 1;
      // I10: a deletion failure never fails silently. This is the line that
      // pages somebody, because nothing else in the process will notice that
      // data which should be gone is still there.
      this.logger.error('deletion pass failed: retained data is past its deadline', {
        failures: this.failures,
        ...dbErrorFields(err),
      });
      return { ran: true, deleted: { ...EMPTY }, more: true };
    } finally {
      this.running = false;
    }
  }

  /** Run passes until nothing is left, for tests and for an explicit sweep. */
  async runUntilDrained(maxPasses = 100): Promise<DeletionCounts> {
    const total: DeletionCounts = { ...EMPTY };
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await this.runPass();
      for (const key of Object.keys(result.deleted) as Array<keyof DeletionCounts>) {
        total[key] += result.deleted[key];
      }
      if (!result.more) break;
    }
    return total;
  }

  /* --- internals ----------------------------------------------------------- */

  private async deleteExpired(): Promise<DeletionCounts> {
    const batch = this.config.deletion.batch;

    // Messages first, so a message whose own deadline passed is removed even
    // while its conversation is still within retention.
    const messages = await this.deleteBatch(
      `delete from messages where message_id in (
         select message_id from messages
          where retention_expires_at < now() and legal_hold = false
          limit $1)`,
      batch,
    );

    // Then conversations — excluding any that still holds a held message,
    // because the cascade would take it with them.
    const conversations = await this.deleteBatch(
      `delete from conversations where conversation_id in (
         select c.conversation_id from conversations c
          where c.retention_expires_at < now()
            and c.legal_hold = false
            and not exists (
              select 1 from messages m
               where m.conversation_id = c.conversation_id and m.legal_hold = true)
            and not exists (
              select 1 from reports r
               where r.conversation_id = c.conversation_id and r.legal_hold = true)
          limit $1)`,
      batch,
    );

    const reports = await this.deleteBatch(
      `delete from reports where report_id in (
         select report_id from reports
          where retention_expires_at < now() and legal_hold = false
          limit $1)`,
      batch,
    );

    const moderationEvents = await this.deleteBatch(
      `delete from moderation_events where event_id in (
         select event_id from moderation_events
          where retention_expires_at < now()
          limit $1)`,
      batch,
    );

    const enforcement = await this.deleteBatch(
      `delete from enforcement where enforcement_id in (
         select enforcement_id from enforcement
          where retention_expires_at < now()
          limit $1)`,
      batch,
    );

    // The audit log expires too — on its own, much longer period. An
    // append-only log that is never trimmed is just an unbounded one.
    const adminAudit = await this.deleteBatch(
      `delete from admin_audit where audit_id in (
         select audit_id from admin_audit
          where retention_expires_at < now()
          limit $1)`,
      batch,
    );

    return { conversations, messages, reports, moderationEvents, enforcement, adminAudit };
  }

  private async deleteBatch(sql: string, batch: number): Promise<number> {
    const result = await this.db.query(sql, [batch]);
    return result.rowCount;
  }
}
