/**
 * The friends drawer's server half, against real Redis and PostgreSQL (D65).
 *
 * Three things changed at once and each has a failure that would look like it
 * works: a last-active stamp that is written for somebody who hid, a list that
 * shows it to somebody watching while invisible, and a Chat button that reaches
 * a friend who turned presence off. Every one of those reads as a feature
 * working from the side that benefits, so these tests are written from the
 * side that does not.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { accountForSubject, mintCredential } from '../../src/accounts/credentials';
import { createConnectionRepository, type ConnectionRepository } from '../../src/accounts/connections';
import { createPresenceService, type PresenceService } from '../../src/accounts/presence';
import { createAuthRoutes, type AuthRoutes } from '../../src/accounts/routes';
import { createOidcClient } from '../../src/accounts/oidc';
import type { Database } from '../../src/storage/pool';
import { createTestContext, type TestContext } from '../helpers/redis';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: TestContext;
let pg: PostgresContext;
let presence: PresenceService;
let connections: ConnectionRepository;
let auth: AuthRoutes;
let base: string;
let close: () => Promise<void>;

const delivered: Array<{ to: string; event: Record<string, unknown> }> = [];

beforeAll(async () => {
  ctx = await createTestContext({
    AUTH_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example',
    AUTH_AUTHORIZE_URL: 'https://issuer.example/oauth2/authorize',
    AUTH_TOKEN_URL: 'https://issuer.example/oauth2/token',
    AUTH_JWKS_URL: 'https://issuer.example/.well-known/jwks.json',
    AUTH_CLIENT_ID: 'client_1',
    AUTH_REDIRECT_URI: 'https://karobakbak.example/auth/callback',
    AUTH_SECURE_COOKIES: 'false',
  });
  pg = await createPostgresContext();

  presence = createPresenceService(pg.db, ctx.client, pg.logger, ctx.config.redis.keyPrefix);
  connections = createConnectionRepository(pg.db, pg.logger);

  auth = createAuthRoutes({
    config: ctx.config,
    logger: pg.logger,
    db: pg.db,
    oidc: createOidcClient(ctx.config, pg.logger),
    redis: ctx.client,
    presence,
    connections,
    reconnect: {
      async notify(sessionId, event) {
        delivered.push({ to: sessionId, event: { ...event } });
        return true;
      },
      async block() {
        return true;
      },
      async pair() {},
    },
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/auth/connections') void auth.connections(req, res);
    else if (req.method === 'POST' && path === '/auth/reconnect/ask') void auth.reconnectAsk(req, res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
});

afterAll(async () => {
  await close();
  await ctx.close();
  await pg.close();
});

beforeEach(async () => {
  delivered.length = 0;
  await ctx.flush();
  await pg.db.query('delete from connection_labels');
  await pg.db.query('delete from connections');
  await pg.db.query('delete from account_credentials');
  await pg.db.query('delete from accounts');
});

async function account(subject: string, share = true) {
  const made = await accountForSubject(pg.db, pg.logger, subject, 365);
  if (!made.ok) throw new Error('could not create an account');
  await presence.setSharing(made.accountId, share);
  const token = await mintCredential(pg.db, pg.logger, made.accountId, 3600);
  if (token === null) throw new Error('could not mint a credential');
  return { accountId: made.accountId, cookie: `kbb_kbb_session=${token}` };
}

async function befriend(a: string, b: string): Promise<void> {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  await connections.save(lo, hi);
}

async function lastActiveOf(accountId: string): Promise<Date | null> {
  const { rows } = await pg.db.query<{ last_active_at: Date | null }>(
    'select last_active_at from accounts where id = $1',
    [accountId],
  );
  return rows[0]?.last_active_at ?? null;
}

/** The stamp is written without being awaited; wait for it, briefly. */
async function settle(accountId: string): Promise<Date | null> {
  for (let i = 0; i < 40; i += 1) {
    const value = await lastActiveOf(accountId);
    if (value !== null) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

async function setStamp(accountId: string, at: Date): Promise<void> {
  await pg.db.query('update accounts set last_active_at = $2 where id = $1', [accountId, at]);
}

async function list(cookie: string): Promise<{
  sharing: boolean;
  connections: Array<Record<string, unknown>>;
}> {
  const response = await fetch(`${base}/auth/connections`, { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json()) as { sharing: boolean; connections: Array<Record<string, unknown>> };
}

async function ask(body: unknown, cookie: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}/auth/reconnect/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

describe('the last-active stamp', () => {
  it('is written on a heartbeat while sharing, truncated to the hour', async () => {
    const me = await account('sub_me');
    await presence.announce(me.accountId, await ctx.session());

    const stamp = await settle(me.accountId);
    expect(stamp).not.toBeNull();
    expect(stamp!.getTime() % (60 * 60 * 1000)).toBe(0);
    expect(Date.now() - stamp!.getTime()).toBeLessThan(60 * 60 * 1000);
  });

  it('is written once an hour, not on every beat', async () => {
    const me = await account('sub_me');
    const session = await ctx.session();
    await presence.announce(me.accountId, session);
    await settle(me.accountId);

    // Moved back by hand; a second beat in the same hour must leave it there,
    // which proves the gate stopped the write rather than rewriting a value
    // that happened to be equal.
    const sentinel = new Date('2020-01-01T00:00:00Z');
    await setStamp(me.accountId, sentinel);
    await presence.announce(me.accountId, session);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await lastActiveOf(me.accountId)).toEqual(sentinel);
  });

  it('is never written for somebody who hides', async () => {
    const me = await account('sub_me', false);
    await presence.announce(me.accountId, await ctx.session());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await lastActiveOf(me.accountId)).toBeNull();
  });

  it('is erased the moment presence is turned off, and resumes when it is turned on', async () => {
    const me = await account('sub_me');
    const session = await ctx.session();
    await presence.announce(me.accountId, session);
    expect(await settle(me.accountId)).not.toBeNull();

    await presence.setSharing(me.accountId, false);
    expect(await lastActiveOf(me.accountId)).toBeNull();

    // Not next hour: the gate was cleared with the stamp.
    await presence.setSharing(me.accountId, true);
    await presence.announce(me.accountId, session);
    expect(await settle(me.accountId)).not.toBeNull();
  });

  it('can be erased by the chat role, which is the role that runs it', async () => {
    const me = await account('sub_me');
    await setStamp(me.accountId, new Date('2026-01-01T10:00:00Z'));

    await pg.db.query(`grant usage on schema ${pg.schema} to karobakbak_app`);
    const client = await pg.db.pool.connect();
    try {
      await client.query('set role karobakbak_app');
      const db: Database = {
        pool: pg.db.pool,
        query: async <R extends Record<string, unknown>>(text: string, values?: unknown[]) => {
          const result = await client.query<R>(text, values);
          return { rows: result.rows, rowCount: result.rowCount ?? 0 };
        },
        transaction: () => {
          throw new Error('not used');
        },
        close: async () => undefined,
      };
      const asChat = createPresenceService(db, ctx.client, pg.logger, ctx.config.redis.keyPrefix);
      await asChat.setSharing(me.accountId, false);
      // And the stamp itself, as the statement the heartbeat issues.
      await client.query(
        'update accounts set last_active_at = to_timestamp($2) where id = $1 and share_presence',
        [me.accountId, 0],
      );
    } finally {
      await client.query('reset role');
      client.release();
    }
    expect(await lastActiveOf(me.accountId)).toBeNull();
  });
});

describe('last-active in the friends list', () => {
  it('is a bucket, never the stamp', async () => {
    const me = await account('sub_me');
    const friend = await account('sub_friend');
    await befriend(me.accountId, friend.accountId);
    await setStamp(friend.accountId, new Date(Date.now() - 5 * 60 * 60 * 1000));

    const body = await list(me.cookie);
    expect(body.sharing).toBe(true);
    const row = body.connections[0]!;
    expect(row.lastActive).toEqual({ unit: 'hour', count: expect.any(Number) });
    // Exactly these keys: nothing finer than the bucket reaches the page.
    expect(Object.keys(row).sort()).toEqual(['handle', 'label', 'lastActive', 'online', 'since']);
  });

  it('is withheld from a viewer who hides their own (mutual)', async () => {
    const me = await account('sub_me', false);
    const friend = await account('sub_friend');
    await befriend(me.accountId, friend.accountId);
    await setStamp(friend.accountId, new Date(Date.now() - 5 * 60 * 60 * 1000));

    const body = await list(me.cookie);
    expect(body.sharing).toBe(false);
    expect(body.connections[0]!.lastActive).toBeNull();
  });

  it('is absent for a friend who hides, exactly as for one never seen', async () => {
    const me = await account('sub_me');
    const hidden = await account('sub_hidden');
    const never = await account('sub_never');
    await befriend(me.accountId, hidden.accountId);
    await befriend(me.accountId, never.accountId);
    // A stale value left in the column must not leak through the setting.
    await setStamp(hidden.accountId, new Date(Date.now() - 2 * 60 * 60 * 1000));
    await pg.db.query('update accounts set share_presence = false where id = $1', [hidden.accountId]);
    await presence.announce(hidden.accountId, await ctx.session());

    const rows = (await list(me.cookie)).connections;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.lastActive).toBeNull();
      expect(row.online).toBe(false);
    }
  });
});

describe('asking a friend to chat', () => {
  async function pair() {
    const me = await account('sub_me');
    const friend = await account('sub_friend');
    await befriend(me.accountId, friend.accountId);
    const friendSession = await ctx.session();
    await presence.announce(friend.accountId, friendSession);
    // The asker needs a live session of their own: that is what gets paired.
    await presence.announce(me.accountId, await ctx.session());
    const handle = (await list(me.cookie)).connections[0]!.handle as string;
    return { me, friend, friendSession, handle };
  }

  it("reaches their session, carrying the recipient's own name for the asker", async () => {
    const { me, friend, friendSession, handle } = await pair();
    await connections.setLabel(friend.accountId, me.accountId, 'Sam from Pune');
    await connections.setLabel(me.accountId, friend.accountId, 'what I call them');

    const result = await ask({ handle }, me.cookie);
    expect(result.body).toEqual({ asked: true });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.to).toBe(friendSession);
    expect(delivered[0]!.event.friend).toEqual({ label: 'Sam from Pune' });
    // The asker's word for them never travels to them.
    expect(JSON.stringify(delivered[0]!.event)).not.toContain('what I call them');
  });

  it('says "a friend" when the recipient never named them', async () => {
    const { me, handle } = await pair();
    await ask({ handle }, me.cookie);
    expect(delivered[0]!.event.friend).toEqual({ label: null });
  });

  it('answers "away" for a friend who hides, and delivers nothing', async () => {
    const { me, friend, handle } = await pair();
    await presence.setSharing(friend.accountId, false);

    const result = await ask({ handle }, me.cookie);
    expect(result.body).toEqual({ asked: false, reason: 'away' });
    expect(delivered).toHaveLength(0);
  });

  it('allows one ask per friend per minute', async () => {
    const { me, handle } = await pair();
    expect((await ask({ handle }, me.cookie)).body).toEqual({ asked: true });
    expect((await ask({ handle }, me.cookie)).body).toEqual({ asked: false, reason: 'wait' });
    expect(delivered).toHaveLength(1);
  });

  it('refuses a handle that is not one of the caller\'s connections', async () => {
    const { me, friend } = await pair();
    const stranger = await account('sub_stranger');
    await befriend(stranger.accountId, friend.accountId);
    // A real handle for the same friend — but minted for somebody else's list,
    // so it means nothing in the caller's.
    const theirs = (await list(stranger.cookie)).connections[0]!.handle as string;
    const result = await ask({ handle: theirs }, me.cookie);
    expect(result.status).toBe(404);
    expect(delivered).toHaveLength(0);
  });

  it('refuses a body naming both a token and a handle', async () => {
    const { me, handle } = await pair();
    const result = await ask({ handle, token: 'b'.repeat(32) }, me.cookie);
    expect(result.status).toBe(400);
  });
});
