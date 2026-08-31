/**
 * joinQueue / leaveQueue / tryMatch / endMatch against a real Redis.
 */
import { createTestContext, delay, enqueue, type TestContext } from '../helpers/redis';
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

describe('joinQueue', () => {
  it('moves an idle session into the queue and reports the depth', async () => {
    const sid = await ctx.session();
    const result = await ctx.store.joinQueue(sid, ctx.segment);
    expect(result).toEqual({ status: 'ok', waiting: 1 });

    const row = await ctx.store.readSession(sid);
    expect(row?.state).toBe('SEARCHING');
    expect(Number(row?.enqueuedAt)).toBeGreaterThan(0);
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(1);
  });

  it('is idempotent — a second join is not an error (I3)', async () => {
    const sid = await ctx.session();
    await ctx.store.joinQueue(sid, ctx.segment);
    const again = await ctx.store.joinQueue(sid, ctx.segment);
    expect(again).toEqual({ status: 'already_searching', waiting: 1 });
    // A SET keyed by a server-generated id makes a duplicate entry structurally
    // impossible (§10.10).
    expect(await ctx.store.queueDepth(ctx.segment)).toBe(1);
  });

  it('repairs a session that says SEARCHING but was dropped from the queue', async () => {
    const sid = await ctx.session();
    await ctx.store.joinQueue(sid, ctx.segment);
    await ctx.client.srem(ctx.keys.queue(ctx.segment), sid);

    const again = await ctx.store.joinQueue(sid, ctx.segment);
    expect(again.status).toBe('already_searching');
    // Without the repair the session would sit in SEARCHING forever, in no
    // queue, and never match.
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(1);
  });

  it('refuses to queue a matched session', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    const mid = newMatchId();
    await ctx.store.tryMatch(b, ctx.segment, mid);

    expect(await ctx.store.joinQueue(a, ctx.segment)).toEqual({
      status: 'already_matched',
      matchId: mid,
    });
  });

  it('reports a vanished session instead of creating queue state for it', async () => {
    const sid = await ctx.session();
    await ctx.client.del(ctx.keys.session(sid));
    expect(await ctx.store.joinQueue(sid, ctx.segment)).toEqual({ status: 'session_gone' });
    expect(await ctx.store.queueDepth(ctx.segment)).toBe(0);
  });

  it('registers the segment, so the janitor can find every queue', async () => {
    const sid = await ctx.session();
    await ctx.store.joinQueue(sid, ctx.segment);
    expect(await ctx.client.sismember(ctx.keys.segments(), ctx.segment)).toBe(1);
  });
});

describe('leaveQueue', () => {
  it('returns a searching session to IDLE', async () => {
    const sid = await ctx.session();
    await enqueue(ctx, sid);
    expect(await ctx.store.leaveQueue(sid, ctx.segment)).toEqual({ status: 'ok' });

    const row = await ctx.store.readSession(sid);
    expect(row?.state).toBe('IDLE');
    expect(row?.enqueuedAt).toBeUndefined();
    expect(await ctx.store.queueDepth(ctx.segment)).toBe(0);
  });

  it('is idempotent for a session that is already idle', async () => {
    const sid = await ctx.session();
    expect(await ctx.store.leaveQueue(sid, ctx.segment)).toEqual({ status: 'ok' });
    expect(await ctx.store.leaveQueue(sid, ctx.segment)).toEqual({ status: 'ok' });
  });

  it('refuses to dequeue a matched session', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    const mid = newMatchId();
    await ctx.store.tryMatch(b, ctx.segment, mid);

    expect(await ctx.store.leaveQueue(a, ctx.segment)).toEqual({
      status: 'already_matched',
      matchId: mid,
    });
    expect((await ctx.store.readSession(a))?.state).toBe('MATCHED');
  });
});

describe('tryMatch', () => {
  it('waits when nobody else is queued', async () => {
    const sid = await ctx.session();
    await enqueue(ctx, sid);
    const result = await ctx.store.tryMatch(sid, ctx.segment, newMatchId());
    expect(result).toEqual({
      status: 'waiting',
      cleaned: 0,
      blockedSkipped: 0,
      queueDepth: 1,
      // No preference was asked for, so nothing was preferred and the wider
      // sample was never reached (D44, §29.2).
      preference: { preferred: false, widened: false },
    });
    // Still queued: waiting is not a reason to leave.
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(1);
  });

  it('pairs two searchers and writes both sides of the match (I2, I4, I5)', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);

    const mid = newMatchId();
    const result = await ctx.store.tryMatch(b, ctx.segment, mid);
    expect(result).toMatchObject({ status: 'matched', matchId: mid, partnerSessionId: a });

    const match = await ctx.store.readMatch(mid);
    expect(match).toMatchObject({ a: b, b: a, segment: ctx.segment });
    expect(await ctx.store.currentMatchId(a)).toBe(mid);
    expect(await ctx.store.currentMatchId(b)).toBe(mid);
    expect((await ctx.store.readSession(a))?.state).toBe('MATCHED');
    expect((await ctx.store.readSession(b))?.state).toBe('MATCHED');
    expect((await ctx.store.readSession(a))?.matchId).toBe(mid);
    expect(await ctx.store.queueDepth(ctx.segment)).toBe(0);
    expect(await ctx.client.sismember(ctx.keys.matches(), mid)).toBe(1);
  });

  it('clears enqueuedAt on both sides, so a re-queue is not credited with old waiting time', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    await ctx.store.tryMatch(b, ctx.segment, newMatchId());

    expect((await ctx.store.readSession(a))?.enqueuedAt).toBeUndefined();
    expect((await ctx.store.readSession(b))?.enqueuedAt).toBeUndefined();
  });

  it('never pairs a session with itself', async () => {
    const sid = await ctx.session();
    await enqueue(ctx, sid);
    for (let i = 0; i < 10; i += 1) {
      const result = await ctx.store.tryMatch(sid, ctx.segment, newMatchId());
      expect(result.status).toBe('waiting');
    }
  });

  it('gives both sides TTLs, so an abandoned match cannot live forever', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    const mid = newMatchId();
    await ctx.store.tryMatch(b, ctx.segment, mid);

    for (const key of [ctx.keys.match(mid), ctx.keys.userMatch(a), ctx.keys.userMatch(b)]) {
      const ttl = await ctx.client.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(ctx.config.ttl.matchSeconds);
    }
  });

  it('prefers the oldest waiter among the sampled candidates (D3)', async () => {
    const oldest = await ctx.session();
    await enqueue(ctx, oldest);
    // Redis is the clock, so the gap has to be real time, not a written value.
    await delay(15);
    const middle = await ctx.session();
    await enqueue(ctx, middle);
    await delay(15);
    const newest = await ctx.session();
    await enqueue(ctx, newest);

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);
    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'matched', partnerSessionId: oldest });
    expect([middle, newest]).not.toContain(
      result.status === 'matched' ? result.partnerSessionId : null,
    );
  });

  it('aborts and dequeues when the session is gone', async () => {
    const sid = await ctx.session();
    await enqueue(ctx, sid);
    await ctx.client.del(ctx.keys.session(sid));

    const result = await ctx.store.tryMatch(sid, ctx.segment, newMatchId());
    expect(result).toEqual({ status: 'abort', reason: 'session_gone' });
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(0);
  });

  it('aborts when a peer already matched us (§10.1)', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    await ctx.store.tryMatch(b, ctx.segment, newMatchId());

    // `a` was matched by `b`; its own attempt has nothing left to do and must
    // not create a second match.
    const result = await ctx.store.tryMatch(a, ctx.segment, newMatchId());
    expect(result).toEqual({ status: 'abort', reason: 'already_matched' });
    expect(await ctx.client.scard(ctx.keys.matches())).toBe(1);
  });

  it('aborts when the session is not searching', async () => {
    const sid = await ctx.session();
    await ctx.client.sadd(ctx.keys.queue(ctx.segment), sid);
    const result = await ctx.store.tryMatch(sid, ctx.segment, newMatchId());
    expect(result).toEqual({ status: 'abort', reason: 'not_searching' });
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), sid)).toBe(0);
  });

  it('garbage-collects stale candidates as it walks past them (§10.11)', async () => {
    const ghost = await ctx.session();
    await enqueue(ctx, ghost);
    await ctx.client.del(ctx.keys.session(ghost));

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);
    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId());

    expect(result).toMatchObject({ status: 'waiting', cleaned: 1 });
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), ghost)).toBe(0);
  });

  it('drops a queued candidate that is secretly already matched', async () => {
    const impostor = await ctx.session();
    await enqueue(ctx, impostor);
    await ctx.client.set(ctx.keys.userMatch(impostor), 'm_elsewhere');

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);
    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', cleaned: 1 });
  });

  it('keeps segments apart, even though only one is implemented (D23)', async () => {
    const other = 'other-segment';
    const a = await ctx.session({ segment: other });
    await ctx.store.joinQueue(a, other);
    const b = await ctx.session();
    await enqueue(ctx, b);

    const result = await ctx.store.tryMatch(b, ctx.segment, newMatchId());
    expect(result.status).toBe('waiting');
    expect(await ctx.store.queueDepth(other)).toBe(1);
  });
});

describe('endMatch', () => {
  async function pair(): Promise<{ a: string; b: string; mid: string }> {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    const mid = newMatchId();
    const result = await ctx.store.tryMatch(b, ctx.segment, mid);
    if (result.status !== 'matched') throw new Error(`expected a match, got ${result.status}`);
    return { a, b, mid };
  }

  it('cleans both sides symmetrically (§12)', async () => {
    const { a, b, mid } = await pair();
    const result = await ctx.store.endMatch(mid);
    expect(result).toMatchObject({ status: 'ended', segment: ctx.segment });
    expect([result.status === 'ended' ? result.a : '', result.status === 'ended' ? result.b : ''].sort()).toEqual([a, b].sort());

    expect(await ctx.store.readMatch(mid)).toBeNull();
    expect(await ctx.client.sismember(ctx.keys.matches(), mid)).toBe(0);
    for (const sid of [a, b]) {
      expect(await ctx.store.currentMatchId(sid)).toBeNull();
      const row = await ctx.store.readSession(sid);
      expect(row?.state).toBe('IDLE');
      expect(row?.matchId).toBeUndefined();
    }
  });

  it('drops the dedupe set with the match', async () => {
    const { a, mid } = await pair();
    await ctx.store.resolvePartner(a, 'c_1');
    expect(await ctx.client.exists(ctx.keys.dedupe(mid))).toBe(1);

    await ctx.store.endMatch(mid);
    expect(await ctx.client.exists(ctx.keys.dedupe(mid))).toBe(0);
  });

  it('names exactly one winner; the loser is told it already ended (D6)', async () => {
    const { mid } = await pair();
    const first = await ctx.store.endMatch(mid);
    const second = await ctx.store.endMatch(mid);
    expect(first.status).toBe('ended');
    expect(second).toEqual({ status: 'already_ended' });
  });

  it('makes the old match unable to deliver ever again (I6)', async () => {
    const { a, mid } = await pair();
    await ctx.store.endMatch(mid);
    expect(await ctx.store.resolvePartner(a, 'c_after')).toEqual({ status: 'not_matched' });
  });

  it('tidies the set membership of a match whose record already expired', async () => {
    const { mid } = await pair();
    await ctx.client.del(ctx.keys.match(mid));
    expect(await ctx.store.endMatch(mid)).toEqual({ status: 'already_ended' });
    expect(await ctx.client.sismember(ctx.keys.matches(), mid)).toBe(0);
  });

  it('leaves both sides immediately matchable again (§12.6)', async () => {
    const { a, b, mid } = await pair();
    await ctx.store.endMatch(mid);
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    const result = await ctx.store.tryMatch(a, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'matched', partnerSessionId: b });
  });
});
