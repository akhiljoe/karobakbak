/**
 * Session lifecycle against a real Redis: create, heartbeat, close.
 */
import { createTestContext, delay, fakeHash, type TestContext } from '../helpers/redis';
import { newSessionId } from '../../src/util/ids';

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

describe('createSession', () => {
  it('creates exactly one row, in exactly one state (I1)', async () => {
    const sid = newSessionId();
    const result = await ctx.store.createSession(
      {
        sessionId: sid,
        instanceId: 'i_one',
        ipHash: fakeHash('ip'),
        clientHash: fakeHash('client'),
      },
      ctx.segment,
    );
    expect(result.status).toBe('ok');
    expect(result.createdAtMs).toBeGreaterThan(1_700_000_000_000);

    const row = await ctx.store.readSession(sid);
    expect(row).toMatchObject({
      sid,
      state: 'IDLE',
      instanceId: 'i_one',
      segment: ctx.segment,
      ipHash: fakeHash('ip'),
      clientHash: fakeHash('client'),
    });
    expect(await ctx.client.sismember(ctx.keys.sessions(), sid)).toBe(1);
  });

  it('gives the row a TTL, so a crashed instance forgets it (I7)', async () => {
    const sid = await ctx.session();
    const ttl = await ctx.client.ttl(ctx.keys.session(sid));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.ttl.sessionSeconds);
  });

  it('stores no raw IP anywhere in the row', async () => {
    const sid = await ctx.session({ ipHash: fakeHash('deadbeef') });
    const row = await ctx.store.readSession(sid);
    // The salted hash is what lives here; the address it came from does not.
    expect(JSON.stringify(row)).not.toContain('.');
    expect(row?.ipHash).toMatch(/^[a-z0-9]{32}$/);
  });
});

describe('heartbeat', () => {
  it('refreshes the session TTL', async () => {
    const sid = await ctx.session();
    await ctx.client.expire(ctx.keys.session(sid), 5);
    expect(await ctx.client.ttl(ctx.keys.session(sid))).toBeLessThanOrEqual(5);

    const result = await ctx.store.heartbeat(sid);
    expect(result).toEqual({ status: 'ok', state: 'IDLE', matchId: null });
    expect(await ctx.client.ttl(ctx.keys.session(sid))).toBeGreaterThan(5);
  });

  it('reports the current state and match', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await ctx.store.joinQueue(a, ctx.segment);
    expect(await ctx.store.heartbeat(a)).toMatchObject({ state: 'SEARCHING', matchId: null });

    await ctx.store.joinQueue(b, ctx.segment);
    const matched = await ctx.store.tryMatch(b, ctx.segment, 'm_hb');
    expect(matched.status).toBe('matched');

    const beat = await ctx.store.heartbeat(a);
    expect(beat).toMatchObject({ status: 'ok', state: 'MATCHED', matchId: 'm_hb' });
  });

  it('refreshes the match and dedupe TTLs too, so a live conversation cannot expire', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await ctx.store.joinQueue(a, ctx.segment);
    await ctx.store.joinQueue(b, ctx.segment);
    await ctx.store.tryMatch(b, ctx.segment, 'm_ttl');
    await ctx.store.resolvePartner(a, 'c_1');

    for (const key of [ctx.keys.match('m_ttl'), ctx.keys.dedupe('m_ttl'), ctx.keys.userMatch(a)]) {
      await ctx.client.expire(key, 5);
    }
    await ctx.store.heartbeat(a);
    for (const key of [ctx.keys.match('m_ttl'), ctx.keys.dedupe('m_ttl'), ctx.keys.userMatch(a)]) {
      expect(await ctx.client.ttl(key)).toBeGreaterThan(5);
    }
  });

  it('reports a vanished session rather than recreating it', async () => {
    const sid = await ctx.session();
    await ctx.client.del(ctx.keys.session(sid));
    expect(await ctx.store.heartbeat(sid)).toEqual({ status: 'session_gone' });
    // A heartbeat must never resurrect a row: reconnect creates a new session (D7).
    expect(await ctx.store.readSession(sid)).toBeNull();
  });
});

describe('closeSession', () => {
  it('removes the row, the set membership and the queue entry', async () => {
    const sid = await ctx.session();
    await ctx.store.joinQueue(sid, ctx.segment);
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(1);

    const result = await ctx.store.closeSession(sid, fakeHash(sid));
    expect(result).toEqual({ status: 'closed', matchId: null });
    expect(await ctx.store.readSession(sid)).toBeNull();
    expect(await ctx.client.sismember(ctx.keys.sessions(), sid)).toBe(0);
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(0);
  });

  it('returns the match id but leaves the match for endMatch to clean', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await ctx.store.joinQueue(a, ctx.segment);
    await ctx.store.joinQueue(b, ctx.segment);
    await ctx.store.tryMatch(b, ctx.segment, 'm_close');

    const result = await ctx.store.closeSession(a, fakeHash(a));
    expect(result).toEqual({ status: 'closed', matchId: 'm_close' });
    // Still there: clearing only our own side would strand the partner
    // pointing at a match record nobody was going to take down.
    expect(await ctx.store.readMatch('m_close')).not.toBeNull();
    expect(await ctx.store.currentMatchId(b)).toBe('m_close');
  });

  it('is idempotent and safe to run from both the close and error handlers', async () => {
    const sid = await ctx.session();
    const first = await ctx.store.closeSession(sid, fakeHash(sid));
    const second = await ctx.store.closeSession(sid, fakeHash(sid));
    expect(first.status).toBe('closed');
    expect(second.status).toBe('gone');
    expect(second.matchId).toBeNull();
  });

  it('releases the connection slot it was holding', async () => {
    const ipHash = fakeHash('shared-ip');
    const sid = await ctx.session({ ipHash });
    await ctx.store.acquireConnectionSlot(ipHash, sid);
    expect(await ctx.client.scard(ctx.keys.connSessions(ipHash))).toBe(1);

    await ctx.store.closeSession(sid, ipHash);
    expect(await ctx.client.exists(ctx.keys.connSessions(ipHash))).toBe(0);
  });

  it('cleans a session whose row already expired', async () => {
    const sid = await ctx.session();
    await ctx.client.del(ctx.keys.session(sid));
    const result = await ctx.store.closeSession(sid, fakeHash(sid));
    expect(result.status).toBe('gone');
    expect(await ctx.client.sismember(ctx.keys.sessions(), sid)).toBe(0);
  });
});

describe('instance beacon', () => {
  it('publishes a beacon with a TTL and registers the instance', async () => {
    await ctx.store.refreshInstanceBeacon('i_beacon');
    expect(await ctx.client.exists(ctx.keys.instance('i_beacon'))).toBe(1);
    expect(await ctx.client.sismember(ctx.keys.instances(), 'i_beacon')).toBe(1);
    const ttl = await ctx.client.ttl(ctx.keys.instance('i_beacon'));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.ttl.instanceHeartbeatSeconds);
  });

  it('lets the beacon expire so a crash is detectable', async () => {
    const shortLived = await createTestContext({ INSTANCE_HEARTBEAT_TTL_SECONDS: '5' });
    try {
      await shortLived.store.refreshInstanceBeacon('i_dying');
      await shortLived.client.pexpire(shortLived.keys.instance('i_dying'), 50);
      await delay(120);
      expect(await shortLived.client.exists(shortLived.keys.instance('i_dying'))).toBe(0);
      // The id stays in the set until the janitor prunes it — that is exactly
      // the signal janitorSessions uses to find a crashed instance's sessions.
      expect(await shortLived.client.sismember(shortLived.keys.instances(), 'i_dying')).toBe(1);
    } finally {
      await shortLived.close();
    }
  });
});
