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
import { enforcementRowIds, newAuditId, newEnforcementId } from '../util/ids';
import type { AdminIdentity } from './auth';

/**
 * The vocabulary the `enforcement` table accepts.
 *
 * Wider than what this build enforces, deliberately: the words are reserved by
 * the schema so adding one later is not a migration, and `source` already
 * allows `'automated'` for a heuristic that does not exist yet.
 *
 * That reservation is also the hazard. A row written with an action nothing
 * reads is a sanction that was recorded, reports success, and changes nothing —
 * the moderator believes the user was dealt with and the user notices no
 * difference. The two sets below are what keep that from happening quietly.
 */
export type EnforcementAction = 'warn' | 'ratelimit' | 'quarantine' | 'suspend' | 'ban';

/**
 * Actions that are enforced at the upgrade rather than merely recorded.
 *
 * `suspend` is here because it is a ban with an end date and the upgrade path
 * treats the two identically; nothing issues one today, but a row carrying it
 * would be honoured rather than ignored.
 */
const REFUSING_ACTIONS: ReadonlySet<EnforcementAction> = new Set(['ban', 'suspend']);

/**
 * Everything this build can actually carry out.
 *
 * Identical to `REFUSING_ACTIONS` today and separate from it on purpose: they
 * answer different questions. This one is "can we do it at all", that one is
 * "does it refuse a connection". An action that warns a user or narrows their
 * rate limits would belong here and not there, and conflating the two is how
 * the first such action would come to be silently ignored.
 *
 * `warn`, `ratelimit` and `quarantine` are absent because nothing reads them.
 * Each needs a delivery mechanism this build does not have — a way to show a
 * user a notice, a per-identity limiter, a segregated queue — so they are
 * deferred rather than half-built (`PHASES.md`).
 */
export const IMPLEMENTED_ACTIONS: ReadonlySet<EnforcementAction> = new Set([
  'ban',
  'suspend',
]);

/** Whether this build can carry out a sanction, as opposed to recording one. */
export function isEnforceable(action: string): action is EnforcementAction {
  return IMPLEMENTED_ACTIONS.has(action as EnforcementAction);
}

export interface BanRequest {
  /** The report this came from. Carried into the audit row as the case id. */
  readonly reportId: string;
  /**
   * The subject's identity hashes.
   *
   * **Never taken from a request body.** `issueBanForReport` derives these
   * from the report itself; this shape exists for that caller and for tests.
   * A route that accepted hashes from the client would let anyone holding a
   * console session ban an arbitrary third party — including, with a guessed
   * or observed hash, someone who was never reported at all — and the audit
   * row would faithfully record a decision nobody could tell was forged.
   */
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
            // the id instead. The two forms are reconstructed exactly by
            // `enforcementRowIds`, never matched by prefix — see the note
            // there on why `like` was the wrong tool for this.
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
   * Ban the party a report names, resolving the subject on the server.
   *
   * This is the only entry point a route may use. The caller supplies a report
   * id, a duration and a reason; **which identity is sanctioned is decided
   * here**, from the block rows that report's own conversation produced.
   *
   * The alternative — letting the request body carry the hashes — is the same
   * mistake the chat protocol refuses on every frame (the server is
   * authoritative; identity never comes from the client). Here it would be
   * worse than in chat: a console session could ban any hash it could observe
   * or guess, and the audit row would record a well-formed decision with no
   * way to tell it was forged.
   */
  async issueBanForReport(
    input: {
      reportId: string;
      seconds: number;
      reason: string;
      justification: string;
      identity: AdminIdentity;
    },
    nowMs = Date.now(),
  ): Promise<BanResult> {
    const { rows } = await this.db.query<{ dimension: string; blocked_key: string }>(
      `select b.dimension, b.blocked_key
         from reports r
         join blocks b on b.conversation_id = r.conversation_id
        where r.report_id = $1`,
      [input.reportId],
    );
    if (rows.length === 0) return { status: 'no_subject' };

    return this.issueBan(
      {
        reportId: input.reportId,
        ipHash: rows.find((row) => row.dimension === 'ip')?.blocked_key ?? null,
        clientHash: rows.find((row) => row.dimension === 'client')?.blocked_key ?? null,
        reason: input.reason,
        seconds: input.seconds,
        justification: input.justification,
        identity: input.identity,
      },
      nowMs,
    );
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
    // Exactly the two rows this decision could have written, or nothing at all.
    // Never the caller's string as a `LIKE` pattern: `%` revoked the whole
    // table, and the audit row recorded the wildcard rather than what it lifted.
    const target = enforcementRowIds(enforcementId);
    if (target === null) {
      this.logger.warn('console sent a malformed enforcement id', { actor: identity.accountId });
      return false;
    }
    const { base, rowIds } = target;

    const affected = await this.db.transaction(async (client) => {
      const updated = await client.query(
        `update enforcement
            set revoked_at = $2, revoked_by = $3
          where enforcement_id = any($1::text[]) and revoked_at is null`,
        [rowIds, new Date(nowMs), identity.accountId],
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
          // The decision, not the form of the id the console happened to send.
          base,
          justification,
          new Date(nowMs),
          new Date(nowMs + this.config.retention.days.adminAudit * 24 * 60 * 60 * 1000),
        ],
      );
      return updated.rowCount;
    });

    if (affected === 0) return false;

    const { rows } = await this.db.query<{ subject_key: string }>(
      `select subject_key from enforcement where enforcement_id = any($1::text[])`,
      [rowIds],
    );
    for (const row of rows) await this.store.revokeBan(row.subject_key);
    this.logger.info('console revoked a ban', { enforcementId: base });
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

      // Anything live that this build cannot carry out. Counted separately and
      // reported, because the failure is otherwise perfectly silent: a
      // moderator sees a sanction in the record, the subject notices nothing,
      // and no number moves. The schema reserves these words and `source`
      // already allows `'automated'`, so the first heuristic that writes one
      // will find out here rather than in a complaint.
      const unenforceable = await this.db.query<{ action: string; count: string }>(
        `select action, count(*)::text as count
           from enforcement
          where not (action = any($1))
            and revoked_at is null
            and (expires_at is null or expires_at > $2)
          group by action`,
        [[...IMPLEMENTED_ACTIONS], new Date(nowMs)],
      );
      for (const row of unenforceable.rows) {
        this.logger.error('a live sanction cannot be carried out by this build', {
          enforcementAction: row.action,
          count: Number(row.count),
        });
      }
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
      // Exact rows, not a prefix. This id is server-generated so `%` cannot
      // reach here, but base64url contains `_` — a single-character wildcard —
      // so even a well-formed id was a pattern rather than a value.
      const target = enforcementRowIds(enforcementId);
      if (target === null) return;
      await this.db.query(
        `update enforcement
            set revoked_at = $2, revoked_by = 'system:apply_failed'
          where enforcement_id = any($1::text[]) and revoked_at is null`,
        [target.rowIds, new Date(nowMs)],
      );
    } catch (err) {
      // Now the record and reality genuinely disagree, which is worth an error
      // rather than a warning: the row says "banned" and nothing is enforcing
      // it. `reapplyActiveBans` will try again on its next pass.
      this.logger.error('could not mark a ban as unapplied', dbErrorFields(err));
    }
  }
}
