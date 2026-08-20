/**
 * The console listener, over real HTTP.
 *
 * The guard is the thing under test: an unauthenticated caller must not reach
 * a mounted route, and the cookie that carries a session must be shaped so a
 * browser will not hand it to another site.
 */
import { AdminAuth } from '../../src/admin/auth';
import { hashPassword } from '../../src/admin/password';
import { hotp, newTotpSecret, totpCounter } from '../../src/admin/totp';
import {
  ADMIN_SESSION_COOKIE,
  createAdminServer,
  readCookie,
  type AdminRoute,
  type AdminServer,
} from '../../src/admin/server';
import { newAdminAccountId } from '../../src/util/ids';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: PostgresContext;
let server: AdminServer;
let base: string;

const PASSWORD = 'a-long-enough-console-password';
let username: string;
let secret: string;

/** A route mounted behind the guard, so "does the guard hold" is observable. */
const probe: AdminRoute = {
  method: 'GET',
  path: '/api/probe',
  handle: async (context) => ({ status: 200, body: { seenBy: context.identity.username } }),
};

async function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; setCookie: string | null }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    setCookie: response.headers.get('set-cookie'),
  };
}

async function get(
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${base}${path}`, { headers });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
    headers: response.headers,
  };
}

/** Log in and return the session cookie header a browser would send back. */
async function loginCookie(): Promise<string> {
  const code = hotp(secret, totpCounter(Date.now()));
  const result = await post('/api/login', { username, password: PASSWORD, code });
  if (result.status !== 200 || result.setCookie === null) {
    throw new Error(`login failed with ${result.status}`);
  }
  const token = readCookie(result.setCookie.split(';')[0], ADMIN_SESSION_COOKIE);
  if (token === null) throw new Error('no session cookie');
  return `${ADMIN_SESSION_COOKIE}=${token}`;
}

beforeAll(async () => {
  // A generous budget here so the throttle does not starve the rest of the
  // suite; the throttle itself gets its own server below, with its own budget.
  ctx = await createPostgresContext({
    ADMIN_CONSOLE_ENABLED: 'true',
    ADMIN_CONSOLE_PORT: '0',
    ADMIN_LOGIN_ATTEMPTS_PER_MINUTE: '1000',
  });
  const auth = new AdminAuth(ctx.db, ctx.config, ctx.logger);
  server = createAdminServer({ config: ctx.config, logger: ctx.logger, auth, routes: [probe] });
  const port = await server.listen();
  base = `http://127.0.0.1:${port}`;
});

beforeEach(async () => {
  await ctx.db.query('delete from admin_sessions');
  await ctx.db.query('delete from admin_accounts');
  username = `moderator-${newAdminAccountId().slice(4, 12)}`;
  secret = newTotpSecret();
  await ctx.db.query(
    `insert into admin_accounts (account_id, username, password_hash, totp_secret, role, created_at)
     values ($1, $2, $3, $4, 'moderator', now())`,
    [newAdminAccountId(), username, await hashPassword(PASSWORD), secret],
  );
});

afterAll(async () => {
  await server.close();
  await ctx.close();
});

describe('the guard', () => {
  it('refuses a mounted route without a session', async () => {
    const result = await get('/api/probe');
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'not_authenticated' });
  });

  it('refuses a session cookie that is not a real token', async () => {
    const result = await get('/api/probe', { cookie: `${ADMIN_SESSION_COOKIE}=made-up` });
    expect(result.status).toBe(401);
  });

  it('admits a logged-in operator', async () => {
    const cookie = await loginCookie();
    const result = await get('/api/probe', { cookie });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ seenBy: username });
  });

  it('stops admitting after logout', async () => {
    const cookie = await loginCookie();
    expect((await get('/api/probe', { cookie })).status).toBe(200);
    expect((await post('/api/logout', {}, { cookie })).status).toBe(200);
    expect((await get('/api/probe', { cookie })).status).toBe(401);
  });

  it('404s an unknown path only once authenticated', async () => {
    // An unauthenticated 404 would let anyone enumerate which routes exist.
    expect((await get('/api/nope')).status).toBe(401);
    const cookie = await loginCookie();
    expect((await get('/api/nope', { cookie })).status).toBe(404);
  });
});

describe('login', () => {
  it('returns one message for every kind of bad credential', async () => {
    const code = hotp(secret, totpCounter(Date.now()));
    const wrongPassword = await post('/api/login', { username, password: 'nope-nope-nope', code });
    const wrongCode = await post('/api/login', { username, password: PASSWORD, code: '000000' });
    const noAccount = await post('/api/login', {
      username: 'ghost',
      password: PASSWORD,
      code: '000000',
    });

    for (const result of [wrongPassword, wrongCode, noAccount]) {
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: 'invalid_credentials' });
      expect(result.setCookie).toBeNull();
    }
  });

  it('rejects a body missing any factor without touching the database', async () => {
    expect((await post('/api/login', { username, password: PASSWORD })).status).toBe(400);
    expect((await post('/api/login', {})).status).toBe(400);
  });

  it('sets a cookie a browser will not hand to another site', async () => {
    const code = hotp(secret, totpCounter(Date.now()));
    const result = await post('/api/login', { username, password: PASSWORD, code });
    expect(result.status).toBe(200);

    const cookie = result.setCookie ?? '';
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/');
    // Not Secure outside production: it would make the cookie undeliverable
    // over the plain-HTTP tunnel a developer uses locally.
    expect(cookie).not.toContain('Secure');
  });

  it('never puts the token in the response body', async () => {
    // The cookie is HttpOnly for a reason; echoing the token into JSON would
    // hand it straight back to any script on the page.
    const code = hotp(secret, totpCounter(Date.now()));
    const result = await post('/api/login', { username, password: PASSWORD, code });
    expect(JSON.stringify(result.body)).not.toContain('kbb');
    expect(Object.keys(result.body).sort()).toEqual(['expiresAt', 'role', 'username']);
  });

  it('throttles repeated attempts from one address', async () => {
    // The per-account lockout bounds guessing at one account; this bounds the
    // cost of guessing at many, since each attempt otherwise buys an scrypt
    // verification. Its own server, so the budget it spends is its own.
    const throttled = await createPostgresContext({
      ADMIN_CONSOLE_ENABLED: 'true',
      ADMIN_CONSOLE_PORT: '0',
      ADMIN_LOGIN_ATTEMPTS_PER_MINUTE: '3',
    });
    const auth = new AdminAuth(throttled.db, throttled.config, throttled.logger);
    const guarded = createAdminServer({
      config: throttled.config,
      logger: throttled.logger,
      auth,
    });
    const port = await guarded.listen();
    try {
      const attempt = async (): Promise<number> => {
        const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'ghost', password: PASSWORD, code: '000000' }),
        });
        return response.status;
      };
      expect(await attempt()).toBe(401);
      expect(await attempt()).toBe(401);
      expect(await attempt()).toBe(401);
      // Budget spent: refused before any database work or password hashing.
      expect(await attempt()).toBe(429);
    } finally {
      await guarded.close();
      await throttled.close();
    }
  });
});

describe('request hygiene', () => {
  it('sends security headers on every response, including errors', async () => {
    const result = await get('/api/probe');
    expect(result.status).toBe(401);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(result.headers.get('x-content-type-options')).toBe('nosniff');
    expect(result.headers.get('x-frame-options')).toBe('DENY');
    expect(result.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(result.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('refuses a POST from a disallowed origin', async () => {
    const restricted = await createPostgresContext({
      ADMIN_CONSOLE_ENABLED: 'true',
      ADMIN_CONSOLE_PORT: '0',
      ADMIN_ALLOWED_ORIGINS: 'https://console.example',
    });
    const auth = new AdminAuth(restricted.db, restricted.config, restricted.logger);
    const guarded = createAdminServer({
      config: restricted.config,
      logger: restricted.logger,
      auth,
    });
    const port = await guarded.listen();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ username: 'x', password: 'y', code: '000000' }),
      });
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'origin_not_allowed' });
    } finally {
      await guarded.close();
      await restricted.close();
    }
  });

  it('refuses a malformed or oversized body', async () => {
    const malformed = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(malformed.status).toBe(400);

    const oversized = await fetch(`${base}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'x'.repeat(20_000), password: PASSWORD, code: '000000' }),
    });
    expect(oversized.status).toBe(400);
  });

  it('serves an unauthenticated health check and nothing else', async () => {
    const health = await get('/health');
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
  });
});

describe('/api/session', () => {
  it('reports who is logged in, without the token', async () => {
    const cookie = await loginCookie();
    const result = await get('/api/session', { cookie });
    expect(result.status).toBe(200);
    expect(result.body.username).toBe(username);
    expect(result.body.role).toBe('moderator');
    expect(Object.keys(result.body).sort()).toEqual(['expiresAt', 'role', 'username']);
  });
});
