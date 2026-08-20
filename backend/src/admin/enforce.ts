/**
 * Issuing and lifting sanctions from the console.
 *
 * ---------------------------------------------------------------------------
 * THE DECISION AND THE EFFECT ARE DIFFERENT THINGS
 * ---------------------------------------------------------------------------
 * The `enforcement` row is the decision: who, what, why, for how long, ordered
 * by whom. The Redis ban key is the effect: what the upgrade path actually
 * reads. PostgreSQL is the source of truth and Redis is a cache of it, and the
 * write order follows from that.
 *
 * The decision is committed first, with its audit row, in one transaction.
 * Only then is the key written. The other order — key first — would allow a
 * database failure to leave a live ban with no record: an unexplained refusal
 * that no operator can trace, revoke through the console, or justify.
 *
 * If applying the key fails after the row is committed, the row is immediately
 * revoked with `revoked_by = 'system:apply_failed'`. The two then agree, and
 * the audit trail shows an attempt that did not take effect rather than a
 * sanction that silently never happened.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS A RECONCILER
 * ---------------------------------------------------------------------------
 * Redis runs with persistence deliberately switched off (D12), so that no
 * Redis structure — including a Pub/Sub payload carrying message text — can
 * reach disk. Every ban key therefore dies with a Redis restart.
 *
 * Without `reapplyActiveBans` that makes every sanction quietly temporary:
 * bans would survive exactly until the next Redis restart and nothing would
 * report that they had gone. Since the durable record is in PostgreSQL, the
 * fix is to replay it — at startup and periodically — which is only safe
 * because `applyBan` is idempotent.
 */
import type { Config } from '../config';
import type { Logger } from '../logger';
import { dbErrorFields } from '../logger';
import type { RedisStore } from '../redis/store';
import type { Database } from '../storage/pool';
import { newAuditId, newEnforcementId } from '../util/ids';
import type { AdminIdentity } from './auth';

/** The sanctions the console can issue. Only `ban` has an effect today. */
export type EnforcementAction = 'warn' | 'ratelimit' | 'quarantine' | 'suspend' | 'ban';

/** Actions that are enforced at the upgrade rather than merely recorded. */
const REFUSING_ACTIONS: ReadonlySet<EnforcementAction> = new Set(['ban', 'suspend']);

export interface BanRequest {
  /** The report this came from. Carried into the audit row as the case id. */
  readonly reportId: string;
  readonly ipHash: string | null;
  readonly clientHash: string | null;
  readonly reason: string;
  readonly seconds: number;
  readonly justification: string;
  readonly identity: AdminIdentity;
}

export type BanResult =
  | { status: 'applied'; enforcementId: string; dimensions: number; expiresAt: Date }
  | { status: 'no_subject' }
  | { status: 'apply_failed'; enforcementId: string };

export class InvalidBanDurationError extends Error {
  constructor(maxSeconds: number) {
    super(`ban duration must be between 60 and ${maxSeconds} seconds`);
    this.name = 'InvalidBanDurationError';
  }
}

export class EnforcementService {
  constructor(
    private readonly db: Database,
    private readonly store: RedisStore,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * Ban both identity dimensions of one party.
   *
   * Both, not one: a block already keys on both (D18), and a ban that covered
   * only the cookie would be lifted by clearing browser storage while a ban
   * that covered only the address would be lifted by moving network. Neither
   * is a wall — both together are a speed bump proportional to what an
   * anonymous product can actually enforce.
   *
   * `no_subject` when neither hash is known: the reported party's session had
   * already expired and nobody blocked them, so there is nothing to attach a
   * sanction to. The console must say that rather than offer a button that
   * writes a row with no effect.
   */
  async issueBan(request: BanRequest, nowMs = Date.now()): Promise<BanResult> {
    const seconds = Math.floor(request.seconds);
    if (seconds < 60 || seconds > this.config.enforcement.maxBanSeconds) {
      throw new InvalidBanDurationError(this.config.enforcement.maxBanSeconds);
    }

    const subjects: Array<{ key: string; dimension: 'ip' | 'client' }> = [];
    if (request.ipHash !== null && this.config.blocks.ipDimensionEnabled) {
      subjects.push({ key: request.ipHash, dimension: 'ip' });
    }
    if (request.clientHash !== null && this.config.blocks.clientDimensionEnabled) {
      subjects.push({ key: request.clientHash, dimension: 'client' });
    }
    if (subjects.length === 0) return { status: 'no_subject' };

    const enforcementId = newEnforcementId();
    const expiresAt = new Date(nowMs + seconds * 1000);

    // One transaction: every dimension's row, plus the audit row. A partial
    // sanction — the address banned and the cookie not — would be a decision
    // nobody made.
    await this.db.transaction(async (client) => {
      for (const subject of subjects) {
        await client.query(
          `insert into enforcement
             (enforcement_id, subject_key, action, reason, source, created_at, expires_at,
              retention_expires_at)
           values ($1, $2, 'ban', $3, 'moderator', $4, $5, $6)`,
          [
            // One id per dimension row would make the Redis value ambiguous
            // about which row it came from, so the dimension is folded into
            // the id instead and both rows stay findable by prefix.
            `${enforcementId}_${subject.dimension}`,
            subject.key,
            request.reason,
            new Date(nowMs),
            expiresAt,
            new Date(nowMs + this.config.retention.days.enforcement * 24 * 60 * 60 * 1000),
          ],
        );
      }

      await client.query(
        `insert into admin_audit
           (audit_id, actor, role, action, subject_type, subject_id, case_id,
            justification, created_at, retention_expires_at)
         values ($1, $2, $3, 'issued_ban', 'enforcement', $4, $5, $6, $7, $8)`,
        [
          newAuditId(),
          request.identity.accountId,
          request.identity.role,
          enforcementId,
          request.reportId,
          request.justification,
          new Date(nowMs),
          new Date(nowMs + this.config.retention.days.adminAudit * 24 * 60 * 60 * 1000),
        ],
      );
    });

    try {
      for (const subject of subjects) {
        await this.store.applyBan(subject.key, `${enforcementId}_${subject.dimension}`, seconds);
      }
    } catch (err) {
      // The decision is committed but has no effect. Rather than leave the two
      // disagreeing, the row is revoked so the record matches reality.
      this.logger.error('console could not apply a ban', dbErrorFields(err));
      await this.markApplyFailed(enforcementId, nowMs);
      return { status: 'apply_failed', enforcementId };
    }

    this.logger.info('console issued a ban', {
      enforcementId,
      dimensions: subjects.length,
      seconds,
    });
    return { status: 'applied', enforcementId, dimensions: subjects.length, expiresAt };
  }

  /**
   * Lift a ban.
   *
   * `update` rather than `delete`, so a lifted sanction leaves `revoked_at`
   * and `revoked_by` behind. A ban that vanishes from the table takes with it
   * the evidence that it was ever issued — and the reason someone lifted it,
   * which is the more interesting half.
   */
  async revokeBan(
    enforcementId: string,
    justification: string,
    identity: AdminIdentity,
    nowMs = Date.now(),
  ): Promise<boolean> {
    const affected = await this.db.transaction(async (client) => {
      const updated = await client.query(
        `update enforcement
            set revoked_at = $2, revoked_by = $3
          where enforcement_id like $1 || '%' and revoked_at is null`,
        [enforcementId, new Date(nowMs), identity.accountId],
      );
      if (updated.rowCount === 0) return 0;

      await client.query(
        `insert into admin_audit
           (audit_id, actor, role, action, subject_type, subject_id, case_id,
            justification, created_at, retention_expires_at)
         values ($1, $2, $3, 'revoked_ban', 'enforcement', $4, null, $5, $6, $7)`,
        [
          newAuditId(),
          identity.accountId,
          identity.role,
          enforcementId,
          justification,
          new Date(nowMs),
          new Date(nowMs + this.config.retention.days.adminAudit * 24 * 60 * 60 * 1000),
        ],
      );
      return updated.rowCount;
    });

    if (affected === 0) return false;

    const { rows } = await this.db.query<{ subject_key: string }>(
      `select subject_key from enforcement where enforcement_id like $1 || '%'`,
      [enforcementId],
    );
    for (const row of rows) await this.store.revokeBan(row.subject_key);
    this.logger.info('console revoked a ban', { enforcementId });
    return true;
  }

  /**
   * Re-apply every live sanction from the database into Redis.
   *
   * Redis holds no persistence by design (D12), so a restart empties the ban
   * keys. Without this, every sanction is quietly temporary — lasting until
   * the next Redis restart, with nothing reporting that it had gone.
   *
   * Safe to run repeatedly and from every instance at once, because
   * `applyBan` is a `SET` with a TTL: concurrent writers converge on the same
   * value and the same remaining lifetime.
   *
   * The remaining TTL is recomputed from `expires_at` rather than reusing the
   * original duration, so a replay does not silently extend a sanction that
   * was half spent.
   */
  async reapplyActiveBans(nowMs = Date.now()): Promise<number> {
    let rows: Array<{ enforcement_id: string; subject_key: string; expires_at: Date | null }>;
    try {
      const result = await this.db.query<{
        enforcement_id: string;
        subject_key: string;
        expires_at: Date | null;
      }>(
        `select enforcement_id, subject_key, expires_at
           from enforcement
          where action = any($1)
            and revoked_at is null
            and expires_at is not null
            and expires_at > $2`,
        [[...REFUSING_ACTIONS], new Date(nowMs)],
      );
      rows = result.rows;
    } catch (err) {
      // A database outage must never become a chat outage (D16), and this runs
      // on the chat instance. Report and move on: the bans that are already in
      // Redis keep working, and the next pass picks up the rest.
      this.logger.warn('could not reload active bans', dbErrorFields(err));
      return 0;
    }

    let applied = 0;
    for (const row of rows) {
      const remaining = Math.floor((row.expires_at!.getTime() - nowMs) / 1000);
      if (remaining <= 0) continue;
      try {
        await this.store.applyBan(row.subject_key, row.enforcement_id, remaining);
        applied += 1;
      } catch (err) {
        this.logger.warn('could not reapply a ban', {
          enforcementId: row.enforcement_id,
          errName: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
    if (applied > 0) this.logger.info('reloaded active bans into Redis', { applied });
    return applied;
  }

  private async markApplyFailed(enforcementId: string, nowMs: number): Promise<void> {
    try {
      await this.db.query(
        `update enforcement
            set revoked_at = $2, revoked_by = 'system:apply_failed'
          where enforcement_id like $1 || '%' and revoked_at is null`,
        [enforcementId, new Date(nowMs)],
      );
    } catch (err) {
      // Now the record and reality genuinely disagree, which is worth an error
      // rather than a warning: the row says "banned" and nothing is enforcing
      // it. `reapplyActiveBans` will try again on its next pass.
      this.logger.error('could not mark a ban as unapplied', dbErrorFields(err));
    }
  }
}
