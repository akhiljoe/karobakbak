/**
 * The spend ceiling (D-AI-7).
 *
 * ---------------------------------------------------------------------------
 * CHECKED BEFORE, COUNTED AFTER
 * ---------------------------------------------------------------------------
 * `check()` runs before the request is made. `record()` runs after it returns,
 * from the usage the provider actually reported rather than from an estimate.
 *
 * The gap between them is real and deliberate: a call in flight when the
 * ceiling is crossed still completes and is still counted. Closing that would
 * mean reserving tokens before knowing how many the reply will use, which
 * over-reserves on every short answer and would make the ceiling bind long
 * before the money was spent. A single reply's overshoot is a rounding error
 * against a monthly budget; a ceiling that binds early is a feature that stops
 * working for no visible reason.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED
 * ---------------------------------------------------------------------------
 * If the spend cannot be read, no call is made. This is the same direction as
 * the control plane and D30's ban check, and for a sharper reason: the failure
 * being guarded against is *spending money nobody authorised*. A refused reply
 * costs one conversation with a bot. Failing open costs whatever the outage
 * lasts, multiplied by the request rate, discovered on an invoice.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A REDIS COUNTER
 * ---------------------------------------------------------------------------
 * Redis persistence is off (D12). A spend counter there resets to zero on
 * restart, which is not a budget — it is a budget that silently refills, and it
 * stops binding exactly when something has gone wrong enough to restart the
 * process. PostgreSQL is the truth; see `008_persona_spend.sql`.
 */

import type { Logger } from '../logger';
import { dbErrorFields } from '../logger';
import type { Database } from '../storage/pool';
import { formatMicroCents } from './provider';

export type BudgetState = 'ok' | 'exhausted' | 'unreadable';

export interface BudgetCheck {
  readonly state: BudgetState;
  /** Micro-cents spent in the current period. Zero when unreadable. */
  readonly spent: number;
  /** The ceiling in force for the period. Zero when unreadable. */
  readonly limit: number;
}

export interface PersonaBudgetOptions {
  readonly db: Database;
  readonly logger: Logger;
  /** The ceiling written when a period's row is first created. */
  readonly monthlyLimitMicroCents: number;
  readonly now?: () => Date;
}

/**
 * Reads and adds to the monthly spend.
 *
 * Every method is one statement. There is no cache: the read runs once per
 * model call, model calls take hundreds of milliseconds, and a cached spend
 * total is a ceiling that binds late by exactly the cache TTL.
 */
export class PersonaBudget {
  private readonly db: Database;
  private readonly logger: Logger;
  private readonly limit: number;
  private readonly now: () => Date;

  constructor(options: PersonaBudgetOptions) {
    if (options.monthlyLimitMicroCents <= 0) {
      throw new Error('persona budget limit must be positive');
    }
    this.db = options.db;
    this.logger = options.logger;
    this.limit = options.monthlyLimitMicroCents;
    this.now = options.now ?? (() => new Date());
  }

  /** May a model call be made right now? */
  async check(): Promise<BudgetCheck> {
    try {
      const row = await this.ensurePeriod();
      return {
        state: row.spent >= row.limit ? 'exhausted' : 'ok',
        spent: row.spent,
        limit: row.limit,
      };
    } catch (err) {
      this.logger.error('persona budget unreadable; refusing to spend', dbErrorFields(err));
      return { state: 'unreadable', spent: 0, limit: 0 };
    }
  }

  /**
   * Add the cost of one call, and report the new total.
   *
   * The update and the read are one statement, so two instances adding at once
   * cannot lose an increment — PostgreSQL serialises the row. That is the whole
   * reason this is a single-row upsert rather than a select-then-write.
   */
  async record(costMicroCents: number): Promise<BudgetCheck> {
    if (costMicroCents < 0) throw new Error('persona budget cost cannot be negative');

    const period = this.periodStart();
    try {
      await this.ensurePeriod();

      const { rows } = await this.db.query<{ spent_micro_cents: string; limit_micro_cents: string }>(
        `update persona_spend
            set spent_micro_cents = spent_micro_cents + $2,
                updated_at = now(),
                exhausted_at = case
                  when exhausted_at is null
                   and spent_micro_cents + $2 >= limit_micro_cents
                  then now()
                  else exhausted_at
                end
          where period = $1
      returning spent_micro_cents, limit_micro_cents`,
        [period, costMicroCents],
      );

      const row = rows[0];
      if (row === undefined) throw new Error('persona spend row vanished mid-update');

      const spent = Number(row.spent_micro_cents);
      const limit = Number(row.limit_micro_cents);

      if (spent >= limit) {
        this.logger.warn('persona spend ceiling reached', {
          spent: formatMicroCents(spent),
          limit: formatMicroCents(limit),
        });
      }

      return { state: spent >= limit ? 'exhausted' : 'ok', spent, limit };
    } catch (err) {
      // The money is already spent; failing to record it is worse than the
      // spend itself, because the next check will under-count. Loud, and the
      // caller carries on — refusing here would not un-spend anything.
      this.logger.error('persona spend could not be recorded', dbErrorFields(err));
      return { state: 'unreadable', spent: 0, limit: 0 };
    }
  }

  /** The current period's row, for the console. */
  async current(): Promise<BudgetCheck> {
    return this.check();
  }

  /**
   * Create this period's row if it does not exist, and return it.
   *
   * `on conflict do nothing` then select, rather than `do update`: the ceiling
   * is copied in at creation and must not be rewritten by a later start-up
   * whose configuration has changed. Lowering the limit mid-month is an
   * explicit operator action, not something a deploy does silently.
   */
  private async ensurePeriod(): Promise<{ spent: number; limit: number }> {
    const period = this.periodStart();

    await this.db.query(
      `insert into persona_spend (period, spent_micro_cents, limit_micro_cents)
            values ($1, 0, $2)
       on conflict (period) do nothing`,
      [period, this.limit],
    );

    const { rows } = await this.db.query<{
      spent_micro_cents: string;
      limit_micro_cents: string;
    }>('select spent_micro_cents, limit_micro_cents from persona_spend where period = $1', [
      period,
    ]);

    const row = rows[0];
    if (row === undefined) throw new Error('persona spend row missing after insert');

    return { spent: Number(row.spent_micro_cents), limit: Number(row.limit_micro_cents) };
  }

  /** First day of the current month, UTC, as `YYYY-MM-DD`. */
  private periodStart(): string {
    const now = this.now();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}-01`;
  }
}
