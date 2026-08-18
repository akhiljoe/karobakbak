/**
 * Backup freshness (§8.1, §15).
 *
 * ---------------------------------------------------------------------------
 * WHY AN APPLICATION KNOWS ANYTHING ABOUT BACKUPS
 * ---------------------------------------------------------------------------
 * Taking backups is infrastructure's job. Noticing that they stopped is not
 * anybody's job by default, and that is the failure mode: an unmonitored backup
 * is indistinguishable from no backup right up until the restore. So the
 * application carries one number — when a backup was last observed to succeed —
 * and reports whether it is older than the configured window.
 *
 * The observation is pushed in rather than discovered. This process has no
 * business reaching into a backup system, and giving it credentials to do so
 * would widen the blast radius of the very thing the backups protect against.
 * A backup job reports success; this decides whether the silence has gone on
 * too long.
 */
import type { Config } from '../config';

export type BackupHealth = 'ok' | 'stale' | 'unknown';

export interface BackupStatus {
  readonly health: BackupHealth;
  /** Epoch milliseconds of the last observed success, or null. */
  readonly lastSuccessMs: number | null;
  readonly ageSeconds: number | null;
  readonly failures: number;
}

export class BackupMonitor {
  private lastSuccessMs: number | null = null;
  private failures = 0;

  constructor(private readonly config: Config) {}

  /** Record a successful backup, as reported by whatever takes them. */
  recordSuccess(atMs = Date.now()): void {
    this.lastSuccessMs = atMs;
  }

  recordFailure(): void {
    this.failures += 1;
  }

  /**
   * `unknown` is deliberately not `ok`.
   *
   * A process that has never been told about a backup has no evidence that any
   * exist, and treating absence of news as good news is how this check would
   * come to mean nothing. It is reported as its own state rather than as a
   * failure, because a freshly started process legitimately knows nothing yet.
   */
  status(nowMs = Date.now()): BackupStatus {
    if (this.lastSuccessMs === null) {
      return { health: 'unknown', lastSuccessMs: null, ageSeconds: null, failures: this.failures };
    }
    const ageSeconds = Math.max(0, Math.floor((nowMs - this.lastSuccessMs) / 1000));
    return {
      health: ageSeconds > this.config.backup.maxAgeSeconds ? 'stale' : 'ok',
      lastSuccessMs: this.lastSuccessMs,
      ageSeconds,
      failures: this.failures,
    };
  }
}
