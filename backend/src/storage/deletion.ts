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
  /**
   * Payment orders past their statutory period.
   *
   * Always zero on a deployment that has not applied `011_payments.sql`, which
   * is every deployment until payments are switched on — the table is staged in
   * `migrations-pending/` on purpose.
   */
  paymentOrders: number;
  /**
   * Accounts nobody has signed in to for `AUTH_ACCOUNT_RETENTION_DAYS` (D66).
   * Counts accounts only; what cascades with each — credentials, friendships,
   * labels, block records — is not counted separately.
   */
  accounts: number;
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
  paymentOrders: 0,
  accounts: 0,
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
      const pictures = await this.clearDeadPictures();
      this.lastSuccessMs = Date.now();
      for (const key of Object.keys(deleted) as Array<keyof DeletionCounts>) {
        this.totals[key] += deleted[key];
      }

      const total = Object.values(deleted).reduce((sum, count) => sum + count, 0);
      if (total > 0) {
        this.logger.info('deleted expired rows', { ...deleted, total });
      }
      if (pictures > 0) this.logger.info('cleared expired picture urls', { count: pictures });

      const batch = this.config.deletion.batch;
      const more = Object.values(deleted).some((count) => count >= batch) || pictures >= batch;
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
   * Rows past their deadline that still exist, per table. Refreshed each pass.
   *
   * The measurement that proves expiry is being *enforced* rather than
   * attempted. `chat_retention_deleted_total` cannot answer it: a worker
   * falling behind still deletes steadily, so throughput looks identical
   * whether the backlog is empty or growing without bound. This is zero when
   * the worker is keeping up, whatever the volume, batch size or interval.
   *
   * Held rows are excluded. A hold suspends deletion deliberately, so counting
   * held rows as a backlog would alert on the system working as designed.
   *
   * Cheap: every predicate is served by the partial indexes on
   * `retention_expires_at where legal_hold = false` that the delete statements
   * already use.
   */
  lastBacklog: Record<string, number> | null = null;

  /**
   * How far this process's clock is from the database's, in milliseconds.
   *
   * Positive means this process is ahead. Null until a sample has succeeded —
   * the same rule `lastBacklog` follows, because publishing zero from a failed
   * read is the most reassuring thing this process could wrongly say.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS WORTH MEASURING AT ALL
   * ---------------------------------------------------------------------------
   * `retention_expires_at` is stamped from **this process's** clock
   * (`expiryFrom(nowMs, days)` in `repositories.ts`, D17) and every deletion
   * statement compares it against **the database's** `now()`. The two clocks are
   * coupled and nothing checked they agree.
   *
   * On one host with the database in a container beside it they are the same
   * clock and this reads zero. On a managed database (§16) they are different
   * machines, and a skew moves every retention deadline by exactly that much: a
   * process running an hour fast keeps conversations an hour longer than the
   * privacy policy says, and nothing anywhere would have said so.
   *
   * NTP normally makes this a non-issue, which is the argument for measuring it
   * rather than engineering around it — the failure is rare, silent, and
   * directly contradicts a published claim.
   */
  lastClockSkewMs: number | null = null;

  async sampleBacklog(): Promise<void> {
    try {
      // The clock reading rides along on the query that was happening anyway.
      // A round trip of its own would be a second thing to fail for a number
      // that is only interesting when it is large.
      const clock = await this.db.query<{ db_ms: string }>(
        `select (extract(epoch from now()) * 1000)::bigint::text as db_ms`,
      );
      const dbMs = Number(clock.rows[0]?.db_ms ?? Number.NaN);
      if (Number.isFinite(dbMs)) this.lastClockSkewMs = Date.now() - dbMs;

      const { rows } = await this.db.query<{ table_name: string; n: string }>(
        `select 'conversations' as table_name, count(*)::text as n
           from conversations
          where retention_expires_at < now() and legal_hold = false
         union all
         select 'messages', count(*)::text
           from messages m
          where m.retention_expires_at < now() and m.legal_hold = false
            and not exists (
              select 1 from conversations c
               where c.conversation_id = m.conversation_id and c.legal_hold = true)
         union all
         select 'reports', count(*)::text
           from reports r
          where r.retention_expires_at < now() and r.legal_hold = false
            and not exists (
              select 1 from conversations c
               where c.conversation_id = r.conversation_id and c.legal_hold = true)`,
      );
      const next: Record<string, number> = {};
      for (const row of rows) next[row.table_name] = Number(row.n);
      this.lastBacklog = next;
    } catch (err) {
      // Keep the last good answer. Publishing zero from a failed read would be
      // the most reassuring thing this process could wrongly say.
      this.logger.warn('could not sample the retention backlog', dbErrorFields(err));
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
      if (result.failed) {
        // No backlog sample. The database has just refused every statement in
        // a pass, so asking it one more question adds load to something already
        // unwell and would only fail too — and the monitor keeps its last good
        // answer rather than publishing a zero it did not measure.
        return total;
      }
      if (!result.more) break;
    }
    // After draining, so the number reflects what is left rather than what was
    // waiting when the run started.
    await this.sampleBacklog();
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
    //
    // Through a function, not a delete: this process runs as the chat role,
    // which holds no delete on `admin_audit` and must not (I11). The function
    // removes only rows past their own deadline. A plain `delete` here failed
    // with 42501 on every pass in production, from the first deployment until
    // 018_audit_expiry.sql — and took the payment sweep below down with it.
    const adminAudit = await this.expireBatch('expire_admin_audit', batch);

    /*
      Payment orders, on a period that is statutory rather than chosen.

      Seven years, which is the common Indian bookkeeping figure and is now the
      operator's decision rather than a placeholder (`PAYMENT_RECORD_RETENTION_DAYS`,
      row 22 of the decision register). It is longer than everything above by an
      order of magnitude, and deliberately so: every other retention period here
      argues for keeping as little as possible for as short as possible, and
      this one argues the opposite way, because a financial record that is gone
      when somebody with a statutory right to see it asks for it is not a
      privacy win.

      The table may not exist. `011_payments.sql` is staged in
      `migrations-pending/`, so on every deployment that has not turned payments
      on there is nothing here to sweep — and a `delete from` against a missing
      table raises 42P01, which would fail the whole pass and take the six
      deletions above with it. `to_regclass` returns null rather than raising,
      so the guard costs one cheap lookup and the pass stays correct on both
      shapes of database.
    */
    const paymentOrders = (await this.tableExists('payment_orders'))
      ? await this.expireBatch('expire_payment_orders', batch)
      : 0;

    /*
      Dormant accounts, last: an account's removal cascades into tables the
      steps above never touch, so nothing earlier depends on it.

      Through a function for the reason the audit log is: the chat role holds
      no delete on `accounts`. Only active accounts past their own deadline go;
      a suspended one is kept so dormancy cannot wash out a suspension
      (022_account_expiry.sql).
    */
    const accounts = await this.expireBatch('expire_accounts', batch);

    return {
      conversations,
      messages,
      reports,
      moderationEvents,
      enforcement,
      adminAudit,
      paymentOrders,
      accounts,
    };
  }

  /**
   * Clear the picture URL from credentials that no longer work.
   *
   * Credential rows outlive their usefulness on purpose (010_accounts.sql keeps
   * a revoked one so a replayed token is recognisable), but the picture they
   * carry has no such reason (020_credential_picture.sql). Sign-out clears it
   * on the spot; this catches expiry, and anything revoked some other way.
   *
   * An update of one column, not a delete: that column is all the chat role is
   * granted on the table. Not a `DeletionCounts` entry, because nothing is
   * deleted and `chat_retention_deleted_total{table}` would say otherwise.
   */
  private async clearDeadPictures(): Promise<number> {
    const result = await this.db.query(
      `update account_credentials set picture_url = null
        where token_hash in (
          select token_hash from account_credentials
           where picture_url is not null
             and (expires_at <= now() or revoked_at is not null)
           limit $1)`,
      [this.config.deletion.batch],
    );
    return result.rowCount;
  }

  /**
   * Whether a table is present in this database.
   *
   * `to_regclass` answers null for a name that does not resolve instead of
   * raising, which is what makes it usable as a guard — the alternative,
   * catching 42P01 from the delete itself, would mean an aborted transaction to
   * recover from on every pass of every deployment that has not applied the
   * staged payments migration.
   */
  private async tableExists(table: string): Promise<boolean> {
    const result = await this.db.query<{ present: boolean }>(
      `select to_regclass($1) is not null as present`,
      [table],
    );
    return result.rows[0]?.present === true;
  }

  private async deleteBatch(sql: string, batch: number): Promise<number> {
    const result = await this.db.query(sql, [batch]);
    return result.rowCount;
  }

  /**
   * Call one of the expiry functions for tables this role may not delete from.
   *
   * The name is one of three literals, never a parameter that came from anywhere
   * else, so interpolating it is not an injection path; a function name cannot
   * be a bind parameter.
   */
  private async expireBatch(
    fn: 'expire_admin_audit' | 'expire_payment_orders' | 'expire_accounts',
    batch: number,
  ): Promise<number> {
    const result = await this.db.query<{ removed: number }>(`select ${fn}($1::integer) as removed`, [batch]);
    return Number(result.rows[0]?.removed ?? 0);
  }
}
