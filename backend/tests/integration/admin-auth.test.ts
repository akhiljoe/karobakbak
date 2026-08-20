/**
 * Console login, against a real database.
 *
 * Most of what matters here is what a *failure* does, not what a success does:
 * whether it distinguishes a missing account from a wrong password, whether a
 * code can be used twice, and whether guessing is bounded. Those are the
 * properties an attacker interacts with.
 */
import { AdminAuth, hashSessionToken } from '../../src/admin/auth';
import { hashPassword } from '../../src/admin/password';
import { hotp, newTotpSecret, totpCounter, TOTP_STEP_SECONDS } from '../../src/admin/totp';
import { newAdminAccountId } from '../../src/util/ids';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: PostgresContext;
let auth: AdminAuth;

const PASSWORD = 'a-long-enough-console-password';
const NOW = 1_700_000_000_000;

/** Insert an account and return everything a test needs to log in as it. */
async function createAccount(
  overrides: { username?: string; disabled?: boolean; lockedUntil?: Date } = {},
): Promise<{ accountId: string; username: string; secret: string }> {
  const accountId = newAdminAccountId();
  const username = overrides.username ?? `moderator-${accountId.slice(4, 12)}`;
  const secret = newTotpSecret();
  await ctx.db.query(
    `insert into admin_accounts
       (account_id, username, password_hash, totp_secret, role, created_at, disabled_at, locked_until)
     values ($1, $2, $3, $4, 'moderator', $5, $6, $7)`,
    [
      accountId,
      username,
      await hashPassword(PASSWORD),
      secret,
      new Date(NOW),
      overrides.disabled === true ? new Date(NOW) : null,
      overrides.lockedUntil ?? null,
    ],
  );
  return { accountId, username, secret };
}

function codeFor(secret: string, nowMs = NOW): string {
  return hotp(secret, totpCounter(nowMs));
}

beforeAll(async () => {
  ctx = await createPostgresContext();
  auth = new AdminAuth(ctx.db, ctx.config, ctx.logger);
});

afterEach(async () => {
  await ctx.db.query('delete from admin_sessions');
  await ctx.db.query('delete from admin_accounts');
});

afterAll(async () => {
  await ctx.close();
});

describe('login', () => {
  it('issues a session for a correct password and code', async () => {
    const account = await createAccount();
    const result = await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW);

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.identity).toEqual({
      accountId: account.accountId,
      username: account.username,
      role: 'moderator',
    });
    expect(result.expiresAt.getTime()).toBe(NOW + ctx.config.admin.sessionTtlSeconds * 1000);
  });

  it('stores only the hash of the session token', async () => {
    // A backup or a replica read must not hand over the ability to act as a
    // logged-in operator.
    const account = await createAccount();
    const result = await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW);
    if (result.status !== 'ok') throw new Error('expected a session');

    const rows = await ctx.rows<{ token_hash: string }>('select token_hash from admin_sessions');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBe(hashSessionToken(result.token));
    expect(rows[0]!.token_hash).not.toBe(result.token);
  });

  it('refuses a wrong password, a wrong code and an unknown account identically', async () => {
    const account = await createAccount();
    expect(await auth.login(account.username, 'wrong-password-here', codeFor(account.secret), NOW)).toEqual({
      status: 'invalid',
    });
    expect(await auth.login(account.username, PASSWORD, '000000', NOW)).toEqual({
      status: 'invalid',
    });
    expect(await auth.login('no-such-operator', PASSWORD, '123456', NOW)).toEqual({
      status: 'invalid',
    });
  });

  it('treats a disabled account exactly like a missing one', async () => {
    // Disabling must not become a way to discover which usernames exist.
    const account = await createAccount({ disabled: true });
    expect(await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW)).toEqual({
      status: 'invalid',
    });
  });

  it('opens no session for any failed attempt', async () => {
    const account = await createAccount();
    await auth.login(account.username, 'wrong-password-here', codeFor(account.secret), NOW);
    await auth.login(account.username, PASSWORD, '000000', NOW);
    expect(await ctx.count('admin_sessions')).toBe(0);
  });
});

describe('code replay', () => {
  it('refuses the same code twice', async () => {
    // A code is valid for a whole step and one step of drift either side is
    // accepted, so without the stored counter a code read over a shoulder is
    // usable for up to ninety seconds.
    const account = await createAccount();
    const code = codeFor(account.secret);

    expect((await auth.login(account.username, PASSWORD, code, NOW)).status).toBe('ok');
    expect(await auth.login(account.username, PASSWORD, code, NOW)).toEqual({ status: 'invalid' });
    expect(await ctx.count('admin_sessions')).toBe(1);
  });

  it('accepts the next step, so the account is not locked out by its own defence', async () => {
    const account = await createAccount();
    expect((await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW)).status).toBe(
      'ok',
    );

    const later = NOW + TOTP_STEP_SECONDS * 1000;
    expect(
      (await auth.login(account.username, PASSWORD, codeFor(account.secret, later), later)).status,
    ).toBe('ok');
  });

  it('lets only one of two simultaneous logins with the same code through', async () => {
    // The `totp_last_counter < $2` guard is what makes this safe: both reads
    // see the old counter, and the database decides which write lands.
    const account = await createAccount();
    const code = codeFor(account.secret);

    const [first, second] = await Promise.all([
      auth.login(account.username, PASSWORD, code, NOW),
      auth.login(account.username, PASSWORD, code, NOW),
    ]);

    const succeeded = [first, second].filter((result) => result.status === 'ok');
    expect(succeeded).toHaveLength(1);
    expect(await ctx.count('admin_sessions')).toBe(1);
  });
});

describe('lockout', () => {
  it('locks the account after the configured number of failures', async () => {
    const account = await createAccount();
    const budget = ctx.config.admin.maxFailedAttempts;

    for (let attempt = 0; attempt < budget; attempt += 1) {
      expect(await auth.login(account.username, 'wrong-password-here', '000000', NOW)).toEqual({
        status: 'invalid',
      });
    }

    const [row] = await ctx.rows<{ failed_attempts: number; locked_until: Date | null }>(
      'select failed_attempts, locked_until from admin_accounts where account_id = $1',
      [account.accountId],
    );
    expect(row!.failed_attempts).toBe(budget);
    expect(row!.locked_until).not.toBeNull();
  });

  it('reports the lockout only once the credentials are correct', async () => {
    // Reported earlier, a lockout would confirm to someone guessing usernames
    // that this one exists.
    const lockedUntil = new Date(NOW + 600_000);
    const account = await createAccount({ lockedUntil });

    expect(await auth.login(account.username, 'wrong-password-here', '000000', NOW)).toEqual({
      status: 'invalid',
    });

    const result = await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW);
    expect(result.status).toBe('locked');
    if (result.status === 'locked') expect(result.until.getTime()).toBe(lockedUntil.getTime());
    expect(await ctx.count('admin_sessions')).toBe(0);
  });

  it('clears the lock and the counter on a successful login', async () => {
    const expired = new Date(NOW - 1000);
    const account = await createAccount({ lockedUntil: expired });
    await ctx.db.query('update admin_accounts set failed_attempts = 3 where account_id = $1', [
      account.accountId,
    ]);

    expect((await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW)).status).toBe(
      'ok',
    );

    const [row] = await ctx.rows<{ failed_attempts: number; locked_until: Date | null }>(
      'select failed_attempts, locked_until from admin_accounts where account_id = $1',
      [account.accountId],
    );
    expect(row!.failed_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();
  });
});

describe('sessions', () => {
  async function loggedIn(): Promise<{ token: string; accountId: string }> {
    const account = await createAccount();
    const result = await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW);
    if (result.status !== 'ok') throw new Error('expected a session');
    return { token: result.token, accountId: account.accountId };
  }

  it('resolves a live token to an identity', async () => {
    const { token, accountId } = await loggedIn();
    const resolved = await auth.resolveSession(token, NOW + 1000);
    expect(resolved.status).toBe('ok');
    if (resolved.status === 'ok') expect(resolved.identity.accountId).toBe(accountId);
  });

  it('refuses an unknown token, a revoked one and an expired one', async () => {
    const { token } = await loggedIn();
    expect(await auth.resolveSession('not-a-real-token', NOW)).toEqual({ status: 'invalid' });

    // Expiry is absolute and activity does not extend it.
    const afterExpiry = NOW + ctx.config.admin.sessionTtlSeconds * 1000 + 1;
    expect(await auth.resolveSession(token, afterExpiry)).toEqual({ status: 'invalid' });

    await auth.logout(token, NOW);
    expect(await auth.resolveSession(token, NOW + 1000)).toEqual({ status: 'invalid' });
  });

  it('stops resolving once the account is disabled', async () => {
    // Disabling an account must end its live sessions, not merely stop new
    // logins — otherwise the person keeps their access until the cookie ages
    // out.
    const { token, accountId } = await loggedIn();
    await ctx.db.query('update admin_accounts set disabled_at = $2 where account_id = $1', [
      accountId,
      new Date(NOW),
    ]);
    expect(await auth.resolveSession(token, NOW + 1000)).toEqual({ status: 'invalid' });
  });

  it('revokes every session for an account at once', async () => {
    const account = await createAccount();
    const first = await auth.login(account.username, PASSWORD, codeFor(account.secret), NOW);
    const laterMs = NOW + TOTP_STEP_SECONDS * 1000;
    const second = await auth.login(
      account.username,
      PASSWORD,
      codeFor(account.secret, laterMs),
      laterMs,
    );
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected two sessions');

    expect(await auth.revokeAllForAccount(account.accountId, laterMs)).toBe(2);
    expect(await auth.resolveSession(first.token, laterMs)).toEqual({ status: 'invalid' });
    expect(await auth.resolveSession(second.token, laterMs)).toEqual({ status: 'invalid' });
  });

  it('is idempotent on logout', async () => {
    const { token } = await loggedIn();
    await auth.logout(token, NOW);
    await expect(auth.logout(token, NOW + 1)).resolves.toBeUndefined();
  });

  it('does not write on every resolve', async () => {
    // `last_seen_at` exists so an operator can see a session is live, not as
    // an access log. A write per request would make reading the queue a write
    // workload.
    const { token } = await loggedIn();
    await auth.resolveSession(token, NOW + 1000);
    const [before] = await ctx.rows<{ last_seen_at: Date }>(
      'select last_seen_at from admin_sessions',
    );

    await auth.resolveSession(token, NOW + 2000);
    const [unchanged] = await ctx.rows<{ last_seen_at: Date }>(
      'select last_seen_at from admin_sessions',
    );
    expect(unchanged!.last_seen_at.getTime()).toBe(before!.last_seen_at.getTime());

    await auth.resolveSession(token, NOW + 120_000);
    const [moved] = await ctx.rows<{ last_seen_at: Date }>('select last_seen_at from admin_sessions');
    expect(moved!.last_seen_at.getTime()).toBeGreaterThan(before!.last_seen_at.getTime());
  });
});
