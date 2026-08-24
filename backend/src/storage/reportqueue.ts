/**
 * How long the oldest unanswered report has been waiting.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A METRIC AND NOT A CONSOLE SCREEN
 * ---------------------------------------------------------------------------
 * The console already lists open reports, and a person looking at it can see
 * how many there are. That is the wrong shape for the question that decides
 * whether a moderation model works: *is anybody waiting, and for how long,
 * when nobody is looking at the console.*
 *
 * A response target you cannot measure is an intention. This is the number the
 * target is set against, and the one an alert can watch — which matters most
 * when there is exactly one moderator, because then there is no rota to notice
 * that the queue has grown while they were asleep.
 *
 * ---------------------------------------------------------------------------
 * SAMPLED ON A TIMER, READ SYNCHRONOUSLY
 * ---------------------------------------------------------------------------
 * The metrics publisher is synchronous by design — nothing in the write path
 * carries a metrics dependency, and nothing on the chat path waits on
 * PostgreSQL (D16). So this keeps its own slow timer, holds the last answer,
 * and hands it over without a query. A sample that fails leaves the previous
 * one in place and is counted, rather than publishing a zero that would read
 * as an empty queue.
 *
 * ---------------------------------------------------------------------------
 * NOT LEADER-LOCKED, UNLIKE THE JANITOR
 * ---------------------------------------------------------------------------
 * Every instance can compute the true cluster-wide answer from one query, so
 * they all publish the same number and `max`, `min` and a bare selector agree.
 * That is the opposite of `chat_active_matches`, where only the lock holder
 * knows the value and a follower's copy would freeze — the reason that gauge
 * needs a leader and this one does not.
 */
import { dbErrorFields, type Logger } from '../logger';
import type { Database } from './pool';

export interface ReportQueueSnapshot {
  /** Reports nobody has triaged yet. */
  readonly open: number;
  /** Age of the oldest open report, in seconds. Zero when there are none. */
  readonly oldestSeconds: number;
  /** Cumulative failed samples, so a blind monitor is visible as a number. */
  readonly failures: number;
  /** False until a sample has succeeded; the gauges stay unpublished. */
  readonly known: boolean;
}

const EMPTY: ReportQueueSnapshot = { open: 0, oldestSeconds: 0, failures: 0, known: false };

export class ReportQueueMonitor {
  private open = 0;
  private oldestSeconds = 0;
  private failures = 0;
  private known = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly intervalMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    void this.sample();
    this.timer = setInterval(() => void this.sample(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshot(): ReportQueueSnapshot {
    if (!this.known) return { ...EMPTY, failures: this.failures };
    return {
      open: this.open,
      oldestSeconds: this.oldestSeconds,
      failures: this.failures,
      known: true,
    };
  }

  /**
   * One read. Never throws: a database that is unavailable must not take down
   * a process that is otherwise serving chat, and the retention path already
   * treats a database outage as survivable (D16).
   */
  async sample(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // One pass over the open reports. `state = 'OPEN'` is the same predicate
      // the console's queue uses, and `reports_open_idx` is a partial index on
      // exactly it, so this stays cheap as the table grows.
      const { rows } = await this.db.query<{ open: string; oldest: string | null }>(
        `select count(*)::text as open,
                extract(epoch from (now() - min(created_at)))::text as oldest
           from reports
          where state = 'OPEN'`,
      );
      const row = rows[0];
      this.open = Number(row?.open ?? 0);
      this.oldestSeconds = Math.max(0, Math.floor(Number(row?.oldest ?? 0) || 0));
      this.known = true;
    } catch (err) {
      this.failures += 1;
      // Never the error object: `pg` echoes the parameters of the failing
      // statement, and rows in this table carry a reporter's own words (I8).
      this.logger.warn('could not sample the report queue', {
        failures: this.failures,
        ...dbErrorFields(err),
      });
    } finally {
      this.running = false;
    }
  }
}
