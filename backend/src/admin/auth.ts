/**
 * Console authentication: password, then TOTP, then a session.
 *
 * ---------------------------------------------------------------------------
 * WHAT A SESSION HERE IS WORTH
 * ---------------------------------------------------------------------------
 * A chat session id identifies one anonymous stranger for the life of a
 * socket. A console session authorises reading every retained conversation in
 * the database. They are not the same kind of object and are deliberately not
 * built from the same pieces: this token is 256 bits, is stored only as a
 * hash, has an absolute expiry that activity does not extend, and can be
 * revoked in the table rather than by hoping a browser dropped a cookie.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE CALLER LEARNS FROM A FAILURE
 * ---------------------------------------------------------------------------
 * `invalid` covers no-such-account, wrong password, wrong code and replayed
 * code. One outcome, one message, and the password is verified even when the
 * username does not exist — otherwise the response time alone enumerates
 * accounts.
 *
 * `locked` is the single exception, and it is only ever returned once the
 * password and code were *correct*. A lockout reported before that would
 * confirm an account exists to someone guessing at usernames; reported after,
 * it tells the real operator why their correct credentials were refused, which
 * is the difference between a security control and a mystery.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import type { Config } from '../config';
import type { Logger } from '../logger';
import { dbErrorFields } from '../logger';
import type { Database } from '../storage/pool';
import { newAdminSessionToken } from '../util/ids';
import { hashPassword, verifyPassword } from './password';
import { verifyTotp } from './totp';

export type AdminRole = 'moderator' | 'senior_moderator' | 'security_admin';

export interface AdminIdentity {
  readonly accountId: string;
  readonly username: string;
  readonly role: AdminRole;
}

export type LoginResult =
  | { status: 'ok'; token: string; expiresAt: Date; identity: AdminIdentity }
  | { status: 'invalid' }
  | { status: 'locked'; until: Date }
  | { status: 'unavailable' };

export type SessionResult =
  | { status: 'ok'; identity: AdminIdentity; expiresAt: Date }
  | { status: 'invalid' }
  | { status: 'unavailable' };

interface AccountRow extends Record<string, unknown> {
  account_id: string;
  username: string;
  password_hash: string;
  totp_secret: string;
  totp_last_counter: string;
  role: AdminRole;
  disabled_at: Date | null;
  failed_attempts: number;
  locked_until: Date | null;
}

/**
 * A real scrypt hash of a value nobody knows, verified against when the
 * username does not exist.
 *
 * Skipping the hash for an unknown account makes that path ~100ms faster than
 * the known-account path, which is a reliable account-enumeration oracle over
 * a handful of requests. Hashing anyway costs one login's worth of CPU on a
 * path that is already rate limited.
 *
 * Generated rather than written as a literal, and generated *once* per
 * process. A hand-written hash string is a plausible-looking constant that
 * nothing verifies: a single wrong base64 character would make
 * `verifyPassword` reject it as malformed and return early, silently removing
 * the timing defence this exists to provide, with no test able to see it.
 */
let decoyHash: Promise<string> | null = null;
function decoy(): Promise<string> {
  decoyHash ??= hashPassword(randomBytes(32).toString('base64'));
  return decoyHash;
}

/** SHA-256 of a bearer token. Not a KDF, and does not need to be: the token is
 * 256 random bits, so there is no dictionary to slow an attacker down over. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export class AdminAuth {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * Verify a username, password and TOTP code, and issue a session.
   *
   * Never logs the username on failure. An operator username is not user
   * content, but a log line pairing a username with repeated failures is a
   * list of valid accounts for anyone who reaches the logs.
   */
  async login(
    username: string,
    password: string,
    code: string,
    nowMs = Date.now(),
  ): Promise<LoginResult> {
    let account: AccountRow | undefined;
    try {
      const { rows } = await this.db.query<AccountRow>(
        `select account_id, username, password_hash, totp_secret, totp_last_counter,
                role, disabled_at, failed_attempts, locked_until
           from admin_accounts
          where username = $1`,
        [username],
      );
      account = rows[0];
    } catch (err) {
      this.logger.error('console login could not read the account', dbErrorFields(err));
      return { status: 'unavailable' };
    }

    // A disabled account behaves exactly like a missing one, including the
    // decoy hash, so disabling does not become a way to discover usernames.
    const usable = account !== undefined && account.disabled_at === null;
    const passwordOk = await verifyPassword(
      password,
      usable ? account!.password_hash : await decoy(),
    );

    if (!usable || !passwordOk) {
      if (usable) await this.recordFailure(account!.account_id, nowMs);
      return { status: 'invalid' };
    }

    const verified = verifyTotp(account!.totp_secret, code, {
      nowMs,
      // The replay floor. A code stays valid for a whole step and one step of
      // drift either side is accepted, so without this a code observed once is
      // usable for up to ninety seconds.
      minCounter: Number(account!.totp_last_counter),
    });
    if (verified === null) {
      await this.recordFailure(account!.account_id, nowMs);
      return { status: 'invalid' };
    }

    // Only now, with both factors correct, is a lockout worth reporting.
    if (account!.locked_until !== null && account!.locked_until.getTime() > nowMs) {
      return { status: 'locked', until: account!.locked_until };
    }

    // Consume the counter and clear the failure state in one statement. The
    // `<` guard is what makes two logins racing on the same code safe: the
    // second one updates no rows and is refused, rather than both succeeding
    // because each read the old counter before either wrote.
    let consumed: number;
    try {
      const result = await this.db.query(
        `update admin_accounts
            set totp_last_counter = $2,
                failed_attempts = 0,
                locked_until = null,
                last_login_at = $3
          where account_id = $1 and totp_last_counter < $2`,
        [account!.account_id, verified.counter, new Date(nowMs)],
      );
      consumed = result.rowCount;
    } catch (err) {
      this.logger.error('console login could not consume the code', dbErrorFields(err));
      return { status: 'unavailable' };
    }
    if (consumed === 0) return { status: 'invalid' };

    const token = newAdminSessionToken();
    const expiresAt = new Date(nowMs + this.config.admin.sessionTtlSeconds * 1000);
    try {
      await this.db.query(
        `insert into admin_sessions (token_hash, account_id, created_at, expires_at, last_seen_at)
         values ($1, $2, $3, $4, $3)`,
        [hashSessionToken(token), account!.account_id, new Date(nowMs), expiresAt],
      );
    } catch (err) {
      this.logger.error('console login could not open a session', dbErrorFields(err));
      return { status: 'unavailable' };
    }

    this.logger.info('console session opened', {
      accountId: account!.account_id,
      role: account!.role,
    });
    return {
      status: 'ok',
      token,
      expiresAt,
      identity: {
        accountId: account!.account_id,
        username: account!.username,
        role: account!.role,
      },
    };
  }

  /**
   * Resolve a session cookie to an identity.
   *
   * Every guarded request runs this, so it is one indexed lookup on the
   * primary key and nothing else. `last_seen_at` is updated at most once a
   * minute rather than on every call: the column exists so an operator can see
   * a session is live, not to be an access log, and a write per request would
   * make reading the queue a write workload.
   */
  async resolveSession(token: string, nowMs = Date.now()): Promise<SessionResult> {
    const tokenHash = hashSessionToken(token);
    try {
      const { rows } = await this.db.query<{
        account_id: string;
        username: string;
        role: AdminRole;
        expires_at: Date;
        revoked_at: Date | null;
        disabled_at: Date | null;
        last_seen_at: Date;
      }>(
        `select s.account_id, a.username, a.role, s.expires_at, s.revoked_at,
                a.disabled_at, s.last_seen_at
           from admin_sessions s
           join admin_accounts a on a.account_id = s.account_id
          where s.token_hash = $1`,
        [tokenHash],
      );
      const session = rows[0];
      if (session === undefined) return { status: 'invalid' };
      if (session.revoked_at !== null) return { status: 'invalid' };
      if (session.disabled_at !== null) return { status: 'invalid' };
      if (session.expires_at.getTime() <= nowMs) return { status: 'invalid' };

      if (nowMs - session.last_seen_at.getTime() > 60_000) {
        await this.db.query(`update admin_sessions set last_seen_at = $2 where token_hash = $1`, [
          tokenHash,
          new Date(nowMs),
        ]);
      }

      return {
        status: 'ok',
        expiresAt: session.expires_at,
        identity: {
          accountId: session.account_id,
          username: session.username,
          role: session.role,
        },
      };
    } catch (err) {
      this.logger.error('console session lookup failed', dbErrorFields(err));
      return { status: 'unavailable' };
    }
  }

  /**
   * Revoke one session. Idempotent, and deliberately does not report whether
   * the token existed: logout is not a lookup oracle for valid tokens.
   */
  async logout(token: string, nowMs = Date.now()): Promise<void> {
    try {
      await this.db.query(
        `update admin_sessions set revoked_at = $2 where token_hash = $1 and revoked_at is null`,
        [hashSessionToken(token), new Date(nowMs)],
      );
    } catch (err) {
      this.logger.error('console logout failed', dbErrorFields(err));
    }
  }

  /** Revoke every live session for an account — used when a password changes. */
  async revokeAllForAccount(accountId: string, nowMs = Date.now()): Promise<number> {
    const result = await this.db.query(
      `update admin_sessions set revoked_at = $2 where account_id = $1 and revoked_at is null`,
      [accountId, new Date(nowMs)],
    );
    return result.rowCount;
  }

  /**
   * Count a failed attempt and lock the account once the budget is spent.
   *
   * Counted per account rather than per address: the console has no origin
   * allowlist to lean on at this layer, and an attacker rotating addresses is
   * the expected case rather than the exotic one. The cost is that a noisy
   * attacker can lock a real operator out for the lockout window — acceptable
   * for a console with one or two accounts and an owner who can wait, and much
   * better than an unbounded guessing budget.
   */
  private async recordFailure(accountId: string, nowMs: number): Promise<void> {
    try {
      await this.db.query(
        `update admin_accounts
            set failed_attempts = failed_attempts + 1,
                locked_until = case
                  when failed_attempts + 1 >= $2 then $3
                  else locked_until
                end
          where account_id = $1`,
        [accountId, this.config.admin.maxFailedAttempts, new Date(nowMs + this.lockoutMs())],
      );
    } catch (err) {
      // A failure to *record* a failure must not become a way to distinguish
      // outcomes, so this is logged and swallowed; the caller still returns
      // `invalid`.
      this.logger.error('console could not record a failed attempt', dbErrorFields(err));
    }
  }

  private lockoutMs(): number {
    return this.config.admin.lockoutSeconds * 1000;
  }
}

/**
 * Constant-time comparison for two hex token hashes.
 *
 * Exported for the session store rather than used above — the primary-key
 * lookup already compares in the database — but kept here so anything else
 * comparing a console token reaches for the safe version.
 */
export function equalTokenHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
