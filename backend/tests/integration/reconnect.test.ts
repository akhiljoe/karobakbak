/**
 * Reconnecting with somebody you met before, against real Redis and PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The feature shipped broken and nothing caught it. The ask route took the
 * asking session from the request body, the client had nothing sensible to send
 * and sent the string "me", and accepting therefore set a queue lane on a
 * session that did not exist. Both people saw nothing, and every unit test
 * passed, because the fault was in how three real subsystems agreed with each
 * other rather than in any one of them.
 *
 * So this drives the actual pieces — the presence service against Redis, the
 * account lookup against PostgreSQL, the routes over real `http` — and asserts
 * on the state they leave behind rather than on what they return.
 *
 * The tests that matter here are the negative ones. A reconnect that works is
 * visible the moment somebody uses it; a reconnect that pairs the wrong session,
 * or reaches somebody who hid, or survives being answered twice, is not.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { accountForSubject, mintCredential } from '../../src/accounts/credentials';
import { createPresenceService, type PresenceService } from '../../src/accounts/presence';
import { createAuthRoutes, type AuthRoutes } from '../../src/accounts/routes';
import { createOidcClient } from '../../src/accounts/oidc';
import { createTestContext, type TestContext } from '../helpers/redis';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: TestContext;
let pg: PostgresContext;
let presence: PresenceService;
let auth: AuthRoutes;
let base: string;
let close: () => Promise<void>;

/** Sessions the routes were told to pair, in the order `pair` saw them. */
const paired: Array<[string, string]> = [];
/** Events the routes tried to deliver, and to whom. */
const delivered: Array<{ to: string; event: Record<string, unknown> }> = [];
/** Pairs the routes were told to block. */
const blocked: Array<[string, string]> = [];
/** Sessions that are not reachable, so `notify` reports failure for them. */
const unreachable = new Set<string>();

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

  auth = createAuthRoutes({
    config: ctx.config,
    logger: pg.logger,
    db: pg.db,
    oidc: createOidcClient(ctx.config, pg.logger),
    redis: ctx.client,
    presence,
    reconnect: {
      async notify(sessionId, event) {
        delivered.push({ to: sessionId, event: { ...event } });
        return !unreachable.has(sessionId);
      },
      async block(asker, target) {
        blocked.push([asker, target]);
        return true;
      },
      async pair(a, b) {
        paired.push([a, b]);
        await Promise.all([ctx.store.setSegment(a, 'pair-test'), ctx.store.setSegment(b, 'pair-test')]);
      },
    },
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'POST' && path === '/auth/reconnect/ask') void auth.reconnectAsk(req, res);
    else if (req.method === 'POST' && path === '/auth/reconnect/accept')
      void auth.reconnectAccept(req, res);
    else if (req.method === 'POST' && path === '/auth/reconnect/block')
      void auth.reconnectBlock(req, res);
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
  paired.length = 0;
  blocked.length = 0;
  delivered.length = 0;
  unreachable.clear();
  await ctx.flush();
  await pg.db.query('delete from account_credentials');
  await pg.db.query('delete from accounts');
});

/** An account with a live session, and the cookie that authenticates it. */
async function signedIn(subject: string, sessionId: string, share = true) {
  const account = await accountForSubject(pg.db, pg.logger, subject, 365);
  if (!account.ok) throw new Error('could not create an account');
  await presence.setSharing(account.accountId, share);
  await presence.announce(account.accountId, sessionId);
  const token = await mintCredential(pg.db, pg.logger, account.accountId, 3600);
  if (token === null) throw new Error('could not mint a credential');
  return { accountId: account.accountId, sessionId, cookie: `kbb_kbb_session=${token}` };
}

async function post(
  path: string,
  body: unknown,
  cookie?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>) };
}

describe('asking somebody to chat again', () => {
  it('reaches them, and pairs the two real sessions when accepted', async () => {
    const asker = await signedIn('sub_asker', await ctx.session());
    const target = await signedIn('sub_target', await ctx.session());

    const token = await presence.mintToken(target.accountId);
    expect(token).not.toBeNull();

    const ask = await post('/auth/reconnect/ask', { token }, asker.cookie);
    expect(ask.status).toBe(200);
    expect(ask.body.asked).toBe(true);

    // Delivered to the target's session, and to nobody else.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.to).toBe(target.sessionId);
    const offer = delivered[0]?.event.offer as string;
    expect(offer).toMatch(/^[0-9a-f]{32}$/);

    const accept = await post('/auth/reconnect/accept', { offer }, target.cookie);
    expect(accept.status).toBe(200);

    /*
     * The assertion the original bug would have failed. It paired *the asker's
     * real session*, not a value taken from the request — the broken version
     * stored the literal string the client sent and set a lane on a session
     * that did not exist, so both people waited for a match that could never
     * happen.
     */
    expect(paired).toEqual([[asker.sessionId, target.sessionId]]);

    // Both are actually in the same lane afterwards, read back from Redis.
    const [laneA, laneB] = await Promise.all([
      ctx.store.readSegment(asker.sessionId, 'default'),
      ctx.store.readSegment(target.sessionId, 'default'),
    ]);
    expect(laneA).toBe(laneB);
    expect(laneA).not.toBe('default');

    // And both are told to start looking, or only one of them would be in it.
    const readied = delivered.filter((d) => 'startedAt' in d.event).map((d) => d.to).sort();
    expect(readied).toEqual([asker.sessionId, target.sessionId].sort());
  });

  it('refuses an unauthenticated ask', async () => {
    // Routing comes from the credential, so there is no such thing as an
    // anonymous ask — a caller who could name the asking session could push two
    // other people into a conversation.
    const target = await signedIn('sub_target', await ctx.session());
    const token = await presence.mintToken(target.accountId);

    const ask = await post('/auth/reconnect/ask', { token });
    expect(ask.status).toBe(401);
    expect(delivered).toHaveLength(0);
  });

  it('says away for somebody who turned presence off, and mints them no token', async () => {
    const asker = await signedIn('sub_asker', await ctx.session());
    const hidden = await signedIn('sub_hidden', await ctx.session(), false);

    // Nothing to hold: opting out means not being remembered, not merely hidden.
    expect(await presence.mintToken(hidden.accountId)).toBeNull();

    const ask = await post(
      '/auth/reconnect/ask',
      { token: '0'.repeat(32) },
      asker.cookie,
    );
    expect(ask.status).toBe(200);
    expect(ask.body.asked).toBe(false);
    expect(ask.body.reason).toBe('away');
    expect(delivered).toHaveLength(0);
  });

  it('answers away identically for an invented token', async () => {
    // The same answer as "opted out" and "not here", so this cannot be used to
    // test whether a token ever referred to anybody.
    const asker = await signedIn('sub_asker', await ctx.session());
    const ask = await post('/auth/reconnect/ask', { token: 'a'.repeat(32) }, asker.cookie);
    expect(ask.body).toEqual({ asked: false, reason: 'away' });
  });

  it('reports away when the target has gone offline between listing and asking', async () => {
    const asker = await signedIn('sub_asker', await ctx.session());
    const target = await signedIn('sub_target', await ctx.session());
    const token = await presence.mintToken(target.accountId);

    // The socket dropped: the token still resolves, the session does not.
    unreachable.add(target.sessionId);

    const ask = await post('/auth/reconnect/ask', { token }, asker.cookie);
    expect(ask.body.asked).toBe(false);
    expect(ask.body.reason).toBe('away');
  });
});

describe('somebody who is not signed in', () => {
  it('can still be asked, and the token dies with their session', async () => {
    // The bug this replaced: no token was minted for a signed-out partner at
    // all, so the request could not be addressed and they were told nothing —
    // which reads as the feature being broken rather than as a rule.
    const asker = await signedIn('sub_asker', await ctx.session());
    const strangerSession = await ctx.session();

    const token = await presence.mintSessionToken(strangerSession);
    expect(token).not.toBeNull();

    const ask = await post('/auth/reconnect/ask', { token }, asker.cookie);
    expect(ask.body.asked).toBe(true);
    expect(delivered[0]?.to).toBe(strangerSession);
  });

  it('reads as online without an account behind it', async () => {
    // A session token is its own liveness check: the key exists only while the
    // heartbeat keeps it, so there is no account to look up.
    const strangerSession = await ctx.session();
    const token = (await presence.mintSessionToken(strangerSession)) as string;
    expect(await presence.resolveTokens([token])).toEqual(new Set([token]));
  });

  it('cannot accept until they sign in', async () => {
    /*
      Receiving needs no account; taking it does. Chatting with a stranger never
      needs one — chatting with a *chosen* person is what an account is for, and
      is the one direction of contact that should be opted into.
    */
    const asker = await signedIn('sub_asker', await ctx.session());
    const strangerSession = await ctx.session();
    const token = await presence.mintSessionToken(strangerSession);

    await post('/auth/reconnect/ask', { token }, asker.cookie);
    const offer = delivered[0]?.event.offer as string;

    const accept = await post('/auth/reconnect/accept', { offer });
    expect(accept.status).toBe(401);
    expect(paired).toHaveLength(0);

    // And the offer survives the refusal, so signing in and answering works —
    // spending it on a rejected attempt would make the prompt a dead end.
    const late = await signedIn('sub_late', strangerSession);
    expect((await post('/auth/reconnect/accept', { offer }, late.cookie)).status).toBe(200);
    expect(paired).toEqual([[asker.sessionId, strangerSession]]);
  });
});

describe('answering', () => {
  it('spends the offer, so it cannot be replayed', async () => {
    const asker = await signedIn('sub_asker', await ctx.session());
    const target = await signedIn('sub_target', await ctx.session());
    const token = await presence.mintToken(target.accountId);

    await post('/auth/reconnect/ask', { token }, asker.cookie);
    const offer = delivered[0]?.event.offer as string;

    expect((await post('/auth/reconnect/accept', { offer }, target.cookie)).status).toBe(200);
    // A second acceptance would put somebody back into a private lane long
    // after the moment passed, which is a conversation nobody asked for.
    expect((await post('/auth/reconnect/accept', { offer }, target.cookie)).status).toBe(404);
    expect(paired).toHaveLength(1);
  });

  it('refuses an offer nobody issued', async () => {
    const target = await signedIn('sub_target', await ctx.session());
    const accept = await post('/auth/reconnect/accept', { offer: 'b'.repeat(32) }, target.cookie);
    expect(accept.status).toBe(404);
    expect(paired).toHaveLength(0);
  });

  it('refuses a malformed offer without touching Redis', async () => {
    const target = await signedIn('sub_target', await ctx.session());
    const accept = await post('/auth/reconnect/accept', { offer: 'not-an-offer' }, target.cookie);
    expect(accept.status).toBe(400);
  });
});

describe('blocking from the prompt', () => {
  it('spends the offer and blocks the pair, telling the asker nothing', async () => {
    const asker = await signedIn('sub_asker', await ctx.session());
    const target = await signedIn('sub_target', await ctx.session());
    const token = await presence.mintToken(target.accountId);

    await post('/auth/reconnect/ask', { token }, asker.cookie);
    const offer = delivered[0]?.event.offer as string;
    delivered.length = 0;

    const block = await post('/auth/reconnect/block', { offer }, target.cookie);
    expect(block.status).toBe(200);
    expect(block.body.blocked).toBe(true);
    expect(blocked).toEqual([[asker.sessionId, target.sessionId]]);

    // Nothing goes back. A refusal is never disclosed, and blocking is the
    // strongest refusal there is — announcing it would be worse than the
    // ordinary decline, not better.
    expect(delivered).toHaveLength(0);
  });

  it('needs no account', async () => {
    // Refusing somebody is not a capability to gate behind signing in, and the
    // person pressing it is often the one who never did.
    const asker = await signedIn('sub_asker', await ctx.session());
    const strangerSession = await ctx.session();
    const token = await presence.mintSessionToken(strangerSession);

    await post('/auth/reconnect/ask', { token }, asker.cookie);
    const offer = delivered[0]?.event.offer as string;

    const block = await post('/auth/reconnect/block', { offer });
    expect(block.status).toBe(200);
    expect(blocked).toHaveLength(1);
  });

  it('cannot be answered again after being blocked', async () => {
    const asker = await signedIn('sub_asker', await ctx.session());
    const target = await signedIn('sub_target', await ctx.session());
    const token = await presence.mintToken(target.accountId);

    await post('/auth/reconnect/ask', { token }, asker.cookie);
    const offer = delivered[0]?.event.offer as string;

    await post('/auth/reconnect/block', { offer }, target.cookie);
    // Spent by the block, or whoever still held the offer could accept the
    // request that was just refused.
    expect((await post('/auth/reconnect/accept', { offer }, target.cookie)).status).toBe(404);
    expect(paired).toHaveLength(0);
  });
});

describe('declining', () => {
  it('has no route at all', async () => {
    // Not an omission. There is nothing to call, so a refusal cannot be
    // disclosed even by accident, and doing nothing is a refusal.
    const response = await fetch(`${base}/auth/reconnect/decline`, { method: 'POST' });
    expect(response.status).toBe(404);
  });
});
