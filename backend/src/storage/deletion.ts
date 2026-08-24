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
 * AND SO DOES THE OTHER DIRECTION
 * ---------------------------------------------------------------------------
 * The guard above was written for children protecting a parent, and the
 * reverse was missing: a hold on a *conversation* set one boolean, on one row,
 * and every child query filtered on its own `legal_hold` alone. So a
 * conversation could sit held while its transcript, the reports filed against
 * it and the moderation events that flagged it expired underneath it — leaving
 * the row the hold names and none of the evidence it was placed to preserve.
 * An empty shell with a timestamp is not a suspended conversation.
 *
 * Containment is expressed here rather than by cascading the flag onto
 * children, and that is deliberate. `holds.ts` is explicit that the boolean is
 * *not* the hold: the hold is a row naming an owner, a case and a reason, and
 * the flag is derived from whether such a row is still open. A flag written
 * onto a message because its parent was held would be a flag with no hold row
 * naming it — and on release nothing could tell it apart from a hold placed on
 * that message directly, so releasing the parent would either strand the child
 * held for ever or silently clear a hold somebody else had placed. Reading the
 * parent at deletion time keeps one hold, one row, one meaning.
 *
 * `enforcement` is deliberately not part of this. It is keyed on an identity
 * hash and has no conversation, so there is no containment relationship to
 * express; a sanction that must outlive its retention needs a hold subject of
 * its own, which is a change to `holds.ts` and not to a query here.
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
  /**
   * True when the pass threw.
   *
   * Separate from `more` because the two mean opposite things to a caller that
   * is draining: `more` says "go again", and a failure says "stop, and let the
   * next scheduled run retry". Without the distinction a database that is
   * refusing every statement would be retried in a tight loop for as long as
   * the drain allowed, which turns one outage into two.
   */
  failed: boolean;
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
      // Drain, not one batch. A single pass deletes at most `DELETION_BATCH`
      // rows *per table*, so scheduling one pass an hour capped this worker at
      // 500 rows per table per hour however much had expired. Any real volume
      // outruns that, and the backlog then grows for ever while every signal
      // stays green: the pass succeeded, `chat_retention_deleted_total` rises
      // steadily, and `chat_deletion_failures_total` never moves. The batch
      // size was never the problem — the scheduling was.
      void this.runUntilDrained();
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
    if (this.running) return { ran: false, deleted: { ...EMPTY }, more: false, failed: false };
    this.running = true;
    try {
      const holdsLock = await this.lock.acquireDeletionLock(this.config.instanceId);
      if (!holdsLock) return { ran: false, deleted: { ...EMPTY }, more: false, failed: false };

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
      return { ran: true, deleted, more, failed: false };
    } catch (err) {
      this.failures += 1;
      // I10: a deletion failure never fails silently. This is the line that
      // pages somebody, because nothing else in the process will notice that
      // data which should be gone is still there.
      this.logger.error('deletion pass failed: retained data is past its deadline', {
        failures: this.failures,
        ...dbErrorFields(err),
      });
      return { ran: true, deleted: { ...EMPTY }, more: false, failed: true };
    } finally {
      this.running = false;
    }
  }

  /**
   * Run passes until nothing is left. The scheduled path, and an explicit sweep.
   *
   * `maxPasses` bounds one run so a large backlog cannot hold the connection
   * pool for the whole interval — whatever is left is picked up by the next
   * run rather than by this one. It is a fairness bound, not a correctness one.
   *
   * Stops on the first failed pass. Retrying a database that is refusing every
   * statement, up to `maxPasses` times, would add load to the thing that is
   * already unwell; the next scheduled run is soon enough, and the failure has
   * already been logged and counted for the alert (I10).
   */
  async runUntilDrained(maxPasses = 100): Promise<DeletionCounts> {
    const total: DeletionCounts = { ...EMPTY };
    for (let pass = 0; pass < maxPasses; pass += 1) {
      const result = await this.runPass();
      for (const key of Object.keys(result.deleted) as Array<keyof DeletionCounts>) {
        total[key] += result.deleted[key];
      }
      if (result.failed || !result.more) break;
    }
    return total;
  }

  /* --- internals ----------------------------------------------------------- */

  private async deleteExpired(): Promise<DeletionCounts> {
    const batch = this.config.deletion.batch;

    // Messages first, so a message whose own deadline passed is removed even
    // while its conversation is still within retention — unless that
    // conversation is held, which is the containment rule described at the top
    // of this file.
    const messages = await this.deleteBatch(
      `delete from messages where message_id in (
         select m.message_id from messages m
          where m.retention_expires_at < now() and m.legal_hold = false
            and not exists (
              select 1 from conversations c
               where c.conversation_id = m.conversation_id and c.legal_hold = true)
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

    // A report is usually the reason a conversation is held in the first place.
    const reports = await this.deleteBatch(
      `delete from reports where report_id in (
         select r.report_id from reports r
          where r.retention_expires_at < now() and r.legal_hold = false
            and not exists (
              select 1 from conversations c
               where c.conversation_id = r.conversation_id and c.legal_hold = true)
          limit $1)`,
      batch,
    );

    // A moderation event has no `legal_hold` of its own and needs none: it is
    // never a hold subject, and it is the explanation of *why* a message was
    // flagged, so it is held by whatever holds the thing it describes. Both
    // parents count — the conversation and the message — and either being held
    // keeps it. `conversation_id` and `message_id` are both nullable, and an
    // event with neither is protected by nothing, which is correct: there is
    // nothing for a hold to reach it through.
    const moderationEvents = await this.deleteBatch(
      `delete from moderation_events where event_id in (
         select e.event_id from moderation_events e
          where e.retention_expires_at < now()
            and not exists (
              select 1 from conversations c
               where c.conversation_id = e.conversation_id and c.legal_hold = true)
            and not exists (
              select 1 from messages m
               where m.message_id = e.message_id and m.legal_hold = true)
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
