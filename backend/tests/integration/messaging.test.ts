/**
 * resolvePartner: routing and replay protection, which are deliberately the
 * same script (§10.17, I14).
 */
import { createTestContext, enqueue, type TestContext } from '../helpers/redis';
import { newMatchId } from '../../src/util/ids';

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

async function pair(
  context: TestContext = ctx,
  instances: { a?: string; b?: string } = {},
): Promise<{ a: string; b: string; mid: string }> {
  const a = await context.session({ instanceId: instances.a ?? 'i_one' });
  const b = await context.session({ instanceId: instances.b ?? 'i_one' });
  await enqueue(context, a);
  await enqueue(context, b);
  const mid = newMatchId();
  const result = await context.store.tryMatch(b, context.segment, mid);
  if (result.status !== 'matched') throw new Error(`expected a match, got ${result.status}`);
  return { a, b, mid };
}

describe('resolvePartner', () => {
  it('resolves the recipient from server state, in both directions', async () => {
    const { a, b, mid } = await pair();
    expect(await ctx.store.resolvePartner(a, 'c_1')).toEqual({
      status: 'ok',
      matchId: mid,
      partnerSessionId: b,
      partnerInstanceId: 'i_one',
    });
    expect(await ctx.store.resolvePartner(b, 'c_2')).toEqual({
      status: 'ok',
      matchId: mid,
      partnerSessionId: a,
      partnerInstanceId: 'i_one',
    });
  });

  it('reports which instance owns the partner socket, for the local/remote split (D9)', async () => {
    const { a } = await pair(ctx, { a: 'i_one', b: 'i_two' });
    const result = await ctx.store.resolvePartner(a, 'c_1');
    expect(result).toMatchObject({ status: 'ok', partnerInstanceId: 'i_two' });
  });

  it('refuses to route for a session that is not in a match', async () => {
    const sid = await ctx.session();
    expect(await ctx.store.resolvePartner(sid, 'c_1')).toEqual({ status: 'not_matched' });
  });

  it('refuses to route through a match record that is gone (I6)', async () => {
    const { a, mid } = await pair();
    await ctx.client.del(ctx.keys.match(mid));
    expect(await ctx.store.resolvePartner(a, 'c_1')).toEqual({ status: 'not_matched' });
  });

  it('refuses to route when the caller is not a participant', async () => {
    const { mid } = await pair();
    const outsider = await ctx.session();
    // Forge a user_match pointing at someone else's conversation: the script
    // must check membership, not just that a match record exists.
    await ctx.client.set(ctx.keys.userMatch(outsider), mid);
    expect(await ctx.store.resolvePartner(outsider, 'c_1')).toEqual({ status: 'not_matched' });
  });

  it('reports a partner whose session has vanished', async () => {
    const { a, b, mid } = await pair();
    await ctx.client.del(ctx.keys.session(b));
    expect(await ctx.store.resolvePartner(a, 'c_1')).toEqual({ status: 'partner_gone', matchId: mid });
  });

  it('does not burn the dedupe id when the message could not be routed', async () => {
    const { a, b, mid } = await pair();
    await ctx.client.del(ctx.keys.session(b));
    await ctx.store.resolvePartner(a, 'c_retry');
    expect(await ctx.client.sismember(ctx.keys.dedupe(mid), 'c_retry')).toBe(0);
  });
});

describe('resolveRoute — routing without dedupe', () => {
  it('resolves the same partner as resolvePartner, without touching the dedupe set', async () => {
    const { a, b, mid } = await pair();

    expect(await ctx.store.resolveRoute(a)).toEqual({
      status: 'ok',
      matchId: mid,
      partnerSessionId: b,
      partnerInstanceId: 'i_one',
    });
    // The whole point: a typing indicator must not consume a message id, or a
    // client could exhaust its own replay protection by typing.
    expect(await ctx.client.exists(ctx.keys.dedupe(mid))).toBe(0);
  });

  it('can be called repeatedly with no accumulating state', async () => {
    const { a, mid } = await pair();
    for (let i = 0; i < 20; i += 1) {
      expect((await ctx.store.resolveRoute(a)).status).toBe('ok');
    }
    expect(await ctx.client.exists(ctx.keys.dedupe(mid))).toBe(0);
  });

  it('refuses for a session with no match', async () => {
    const lonely = await ctx.session();
    expect(await ctx.store.resolveRoute(lonely)).toEqual({ status: 'not_matched' });
  });

  it('refuses through a match record that is gone (I6)', async () => {
    const { a, mid } = await pair();
    await ctx.client.del(ctx.keys.match(mid));
    expect(await ctx.store.resolveRoute(a)).toEqual({ status: 'not_matched' });
  });

  it('reports a partner whose session has vanished', async () => {
    const { a, b, mid } = await pair();
    await ctx.client.del(ctx.keys.session(b));
    expect(await ctx.store.resolveRoute(a)).toEqual({ status: 'partner_gone', matchId: mid });
  });

  it('refuses for a session that is not a participant', async () => {
    const { mid } = await pair();
    const outsider = await ctx.session();
    await ctx.client.set(ctx.keys.userMatch(outsider), mid);
    expect(await ctx.store.resolveRoute(outsider)).toEqual({ status: 'not_matched' });
  });
});

describe('replay protection (I14)', () => {
  it('accepts an id once and rejects the repeat', async () => {
    const { a, mid } = await pair();
    expect((await ctx.store.resolvePartner(a, 'c_dup')).status).toBe('ok');
    expect(await ctx.store.resolvePartner(a, 'c_dup')).toEqual({ status: 'duplicate', matchId: mid });
  });

  it('rejects a replay even when it arrives concurrently', async () => {
    const { a } = await pair();
    // The check and the resolve are one script, so two copies cannot both pass
    // no matter how they interleave (§10.17).
    const results = await Promise.all([
      ctx.store.resolvePartner(a, 'c_race'),
      ctx.store.resolvePartner(a, 'c_race'),
      ctx.store.resolvePartner(a, 'c_race'),
    ]);
    expect(results.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'duplicate')).toHaveLength(2);
  });

  it('scopes ids to one match, so the same id works in the next conversation', async () => {
    const first = await pair();
    expect((await ctx.store.resolvePartner(first.a, 'c_1')).status).toBe('ok');
    await ctx.store.endMatch(first.mid);

    const second = await pair();
    expect((await ctx.store.resolvePartner(second.a, 'c_1')).status).toBe('ok');
  });

  it('scopes ids to one match, not to one sender', async () => {
    const { a, b } = await pair();
    expect((await ctx.store.resolvePartner(a, 'c_shared')).status).toBe('ok');
    // Both participants share the match's dedupe set. That is intentional: the
    // set answers "has this id already been accepted for this conversation",
    // and clients generate random ids per send, so a collision is a replay.
    expect((await ctx.store.resolvePartner(b, 'c_shared')).status).toBe('duplicate');
  });

  it('gives the dedupe set the match TTL, so it cannot outlive the conversation', async () => {
    const { a, mid } = await pair();
    await ctx.store.resolvePartner(a, 'c_1');
    const ttl = await ctx.client.ttl(ctx.keys.dedupe(mid));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.ttl.matchSeconds);
  });

  it('fails closed when the dedupe set is full rather than dropping replay protection', async () => {
    const small = await createTestContext({ DEDUPE_MAX_ENTRIES: '16' });
    try {
      const { a, mid } = await pair(small);
      for (let i = 0; i < 16; i += 1) {
        expect((await small.store.resolvePartner(a, `c_${i}`)).status).toBe('ok');
      }
      // Accepting past the cap would mean a replay is deliverable; the cap is
      // reached only by sustained maximum-rate sending, so refusing is the
      // right end of that trade.
      expect(await small.store.resolvePartner(a, 'c_over')).toEqual({
        status: 'dedupe_full',
        matchId: mid,
      });
      expect(await small.client.scard(small.keys.dedupe(mid))).toBe(16);
    } finally {
      await small.close();
    }
  });
});
