/**
 * Moderator-issued enforcement, over real Redis and real sockets (I11).
 *
 * The reason this file exists at all: before it, `enforcement` rows could be
 * written and deleted on schedule but nothing ever read them, so a ban was a
 * database row with no effect on anybody. These tests are the difference
 * between a sanction and a record of an intention.
 */
import { createTestContext, fakeHash, type TestContext } from '../helpers/redis';
import { startTestServer, TestClient, type TestServer } from '../helpers/socket';
import { CLIENT_TOKEN_COOKIE } from '../../src/ws/upgrade';
import { hashIp, newClientToken, newEnforcementId } from '../../src/util/ids';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.flush();
});

afterAll(async () => {
  await ctx.close();
});

describe('ban keys', () => {
  it('reports which dimension refused the connection', async () => {
    const ip = fakeHash('ip');
    const client = fakeHash('client');
    const id = newEnforcementId();

    expect(await ctx.store.checkBan(ip, client)).toEqual({ banned: false });

    await ctx.store.applyBan(ip, id, 600);
    expect(await ctx.store.checkBan(ip, client)).toEqual({
      banned: true,
      dimension: 'ip',
      enforcementId: id,
    });

    // The same subject reached through the other dimension is a different key,
    // and an unrelated connection sharing neither hash is unaffected.
    expect(await ctx.store.checkBan(fakeHash('other-ip'), fakeHash('other-client'))).toEqual({
      banned: false,
    });
  });

  it('refuses on the client dimension alone', async () => {
    const client = fakeHash('client');
    const id = newEnforcementId();
    await ctx.store.applyBan(client, id, 600);

    const result = await ctx.store.checkBan(fakeHash('unbanned-ip'), client);
    expect(result).toEqual({ banned: true, dimension: 'client', enforcementId: id });
  });

  it('carries the enforcement id, so a refusal can be traced to its justification', async () => {
    // A ban whose cause cannot be looked up is an unexplained outage for the
    // person on the other end. The id is the link to the enforcement row and,
    // through its case, to the admin_audit row that ordered it.
    const key = fakeHash('subject');
    const id = newEnforcementId();
    await ctx.store.applyBan(key, id, 600);

    const result = await ctx.store.checkBan(key, fakeHash('unrelated'));
    expect(result.banned).toBe(true);
    if (result.banned) expect(result.enforcementId).toBe(id);
  });

  it('expires on its own, and the TTL is the one that was asked for', async () => {
    // Nothing sweeps ban keys, so the TTL is the entire expiry mechanism. A
    // ban written without one would outlive every retention promise the design
    // makes and could never be found again to be lifted.
    const key = fakeHash('subject');
    await ctx.store.applyBan(key, newEnforcementId(), 600);

    const ttl = await ctx.client.ttl(ctx.keys.ban(key));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('re-issuing extends rather than duplicates', async () => {
    // A moderator lengthening a sanction is the same decision, not a second
    // one. The newer enforcement id wins so the trace points at the current
    // justification rather than at the superseded one.
    const key = fakeHash('subject');
    const first = newEnforcementId();
    const second = newEnforcementId();

    await ctx.store.applyBan(key, first, 60);
    await ctx.store.applyBan(key, second, 600);

    const result = await ctx.store.checkBan(key, fakeHash('unrelated'));
    if (!result.banned) throw new Error('expected the ban to still stand');
    expect(result.enforcementId).toBe(second);
    expect(await ctx.client.ttl(ctx.keys.ban(key))).toBeGreaterThan(60);
  });

  it('distinguishes a revocation from a no-op', async () => {
    const key = fakeHash('subject');
    await ctx.store.applyBan(key, newEnforcementId(), 600);

    expect(await ctx.store.revokeBan(key)).toBe(true);
    expect(await ctx.store.checkBan(key, fakeHash('unrelated'))).toEqual({ banned: false });
    // Second call: already gone. An operator reading the audit trail needs to
    // see that this lifted nothing, not a second successful revocation.
    expect(await ctx.store.revokeBan(key)).toBe(false);
  });

  it('never lets a ban and a block reach each other', async () => {
    // Different questions, different actors, different lifetimes (D18 vs I11).
    // If they shared a namespace, revoking a ban would delete a user's own
    // block — silently removing protection the user asked for.
    const key = fakeHash('subject');
    await ctx.store.applyBan(key, newEnforcementId(), 600);

    expect(await ctx.client.exists(ctx.keys.blocks(key))).toBe(0);
    expect(await ctx.client.exists(ctx.keys.ban(key))).toBe(1);
  });
});

describe('ENFORCEMENT_ENABLED=false', () => {
  it('neither reads nor writes ban keys', async () => {
    const off = await createTestContext({ ENFORCEMENT_ENABLED: 'false' });
    try {
      const key = fakeHash('subject');
      await off.store.applyBan(key, newEnforcementId(), 600);
      expect(await off.client.exists(off.keys.ban(key))).toBe(0);

      // And a key written while it was enabled is ignored rather than obeyed,
      // so the switch is a real off switch for a check misfiring at the edge.
      await off.client.set(off.keys.ban(key), newEnforcementId(), 'EX', 600);
      expect(await off.store.checkBan(key, fakeHash('unrelated'))).toEqual({ banned: false });
    } finally {
      await off.flush();
      await off.close();
    }
  });
});

describe('the upgrade path', () => {
  let http: TestServer;

  beforeAll(async () => {
    http = await startTestServer();
  });

  afterEach(async () => {
    await http.ctx.flush();
  });

  afterAll(async () => {
    await http.stop();
  });

  function cookieFor(token: string): Record<string, string> {
    return { cookie: `${CLIENT_TOKEN_COOKIE}=${token}` };
  }

  it('refuses a banned client token before a session exists', async () => {
    const token = newClientToken();
    const headers = cookieFor(token);

    // Same token, before the ban: an ordinary connection.
    const allowed = await TestClient.connect(http.url, { headers });
    allowed.close();

    const clientHash = hashIp(token, http.ctx.config.security.ipHashSalt);
    await http.ctx.store.applyBan(clientHash, newEnforcementId(), 600);

    const refusal = await TestClient.expectRefusal(http.url, { headers });
    expect(refusal.status).toBe(403);
    // Says nothing about which dimension matched or how long it lasts: that
    // would tell a banned client exactly what to change.
    expect(refusal.body).not.toContain('ban');
    expect(refusal.body).not.toContain(clientHash);
  });

  it('consumes no session for a refused connection', async () => {
    // The check sits before the first allocation on purpose. If it ran inside
    // the session lifecycle instead, every banned reconnection attempt would
    // still cost a session id, a Pub/Sub subscription and a connection slot —
    // which is a denial-of-service budget handed to the banned party.
    const token = newClientToken();
    const clientHash = hashIp(token, http.ctx.config.security.ipHashSalt);
    await http.ctx.store.applyBan(clientHash, newEnforcementId(), 600);

    const before = await http.ctx.client.scard(http.ctx.keys.sessions());
    await TestClient.expectRefusal(http.url, { headers: cookieFor(token) });
    expect(await http.ctx.client.scard(http.ctx.keys.sessions())).toBe(before);
  });

  it('lets the connection back in once the ban is revoked', async () => {
    const token = newClientToken();
    const headers = cookieFor(token);
    const clientHash = hashIp(token, http.ctx.config.security.ipHashSalt);

    await http.ctx.store.applyBan(clientHash, newEnforcementId(), 600);
    expect((await TestClient.expectRefusal(http.url, { headers })).status).toBe(403);

    expect(await http.ctx.store.revokeBan(clientHash)).toBe(true);
    const restored = await TestClient.connect(http.url, { headers });
    restored.close();
  });

  it('leaves an unbanned client untouched', async () => {
    const banned = newClientToken();
    await http.ctx.store.applyBan(
      hashIp(banned, http.ctx.config.security.ipHashSalt),
      newEnforcementId(),
      600,
    );

    const bystander = await TestClient.connect(http.url, { headers: cookieFor(newClientToken()) });
    bystander.close();
  });
});
