/**
 * The janitor: the recovery net for anything a process never got to clean up
 * (§10.11, §10.12, §10.13).
 */
import { createTestContext, enqueue, type TestContext } from '../helpers/redis';
import { newMatchId, newSessionId } from '../../src/util/ids';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});

beforeEach(async () => {
  // Every session in these tests belongs to a live instance unless the test
  // says otherwise, so the beacon has to exist before the sweep runs.
  await ctx.store.refreshInstanceBeacon(ctx.config.instanceId);
});

afterEach(async () => {
  await ctx.flush();
});

afterAll(async () => {
  await ctx.close();
});

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

describe('janitorQueue', () => {
  it('removes entries whose session is gone', async () => {
    const ghost = await ctx.session();
    await enqueue(ctx, ghost);
    await ctx.client.del(ctx.keys.session(ghost));

    expect(await ctx.store.janitorQueue(ctx.segment)).toEqual({ removed: 1, remaining: 0 });
  });

  it('removes entries whose session is no longer searching (I3)', async () => {
    const sid = await ctx.session();
    await enqueue(ctx, sid);
    await ctx.client.hset(ctx.keys.session(sid), 'state', 'IDLE');

    expect(await ctx.store.janitorQueue(ctx.segment)).toEqual({ removed: 1, remaining: 0 });
  });

  it('removes entries for a session that is secretly matched', async () => {
    const sid = await ctx.session();
    await enqueue(ctx, sid);
    await ctx.client.set(ctx.keys.userMatch(sid), 'm_elsewhere');

    expect(await ctx.store.janitorQueue(ctx.segment)).toEqual({ removed: 1, remaining: 0 });
  });

  it('leaves healthy waiters alone', async () => {
    const a = await ctx.session();
    const b = await ctx.session();
    await enqueue(ctx, a);
    await enqueue(ctx, b);

    expect(await ctx.store.janitorQueue(ctx.segment)).toEqual({ removed: 0, remaining: 2 });
  });

  it('matters most for a queue nobody is scanning', async () => {
    // tryMatch repairs whatever it walks over, but a queue of only dead
    // entries has no live searcher to do the walking.
    for (let i = 0; i < 5; i += 1) {
      const ghost = await ctx.session();
      await enqueue(ctx, ghost);
      await ctx.client.del(ctx.keys.session(ghost));
    }
    expect(await ctx.store.janitorQueue(ctx.segment)).toEqual({ removed: 5, remaining: 0 });
  });
});

/**
 * §10.5 — the identity write racing teardown.
 *
 * `tryMatch` creates the match; the display identities are generated and
 * written a moment later. In between, the match can end — a socket drops,
 * either side skips — and `endMatchInline` deletes the hash and removes the id
 * from the janitor's discovery set.
 *
 * The identity write used to be a bare `HSET`, which does not fail against a
 * deleted key: it recreates it. What came back was a hash holding nothing but
 * `identA` and `identB`, with no TTL and no membership of `chat:matches` — so
 * nothing expired it and no janitor pass could see it, because the janitor
 * finds matches through that set. It survived until Redis was flushed or
 * restarted, and a run of fast disconnects accumulates them until a
 * `noeviction` instance runs out of memory.
 */
describe('an identity write that arrives after teardown', () => {
  it('does not recreate the match it was meant to describe', async () => {
    const { mid } = await pair();
    expect(await ctx.store.endMatch(mid)).toMatchObject({ status: 'ended' });

    const saved = await ctx.store.saveMatchIdentities(mid, '{"nickname":"A"}', '{"nickname":"B"}');

    expect(saved).toEqual({ status: 'match_gone' });
    expect(await ctx.client.exists(ctx.keys.match(mid))).toBe(0);
    expect(await ctx.client.sismember(ctx.keys.matches(), mid)).toBe(0);
  });

  it('leaves nothing for the janitor to find, because there is nothing to find', async () => {
    // The consequence that made it a leak rather than a curiosity: the janitor
    // discovers matches through the set, so a key recreated after its id was
    // removed from that set is invisible to every recovery path there is.
    const { mid } = await pair();
    await ctx.store.endMatch(mid);
    await ctx.store.saveMatchIdentities(mid, '{"nickname":"A"}', '{"nickname":"B"}');

    const result = await ctx.store.janitorMatches();
    expect(result).toMatchObject({ dropped: 0, ended: 0, survivors: [] });
    expect(await ctx.client.keys(`${ctx.keys.match(mid)}`)).toEqual([]);
  });

  it('writes onto a live match and leaves its expiry alone', async () => {
    // The other half: the ordinary path still works, and the script does not
    // re-apply a TTL — which would be an identity write quietly extending the
    // life of a conversation.
    const { mid } = await pair();
    const ttlBefore = await ctx.client.ttl(ctx.keys.match(mid));
    expect(ttlBefore).toBeGreaterThan(0);

    const saved = await ctx.store.saveMatchIdentities(mid, '{"nickname":"A"}', '{"nickname":"B"}');

    expect(saved).toEqual({ status: 'ok' });
    const record = await ctx.store.readMatch(mid);
    expect(record).toMatchObject({ identA: '{"nickname":"A"}', identB: '{"nickname":"B"}' });
    const ttlAfter = await ctx.client.ttl(ctx.keys.match(mid));
    expect(ttlAfter).toBeGreaterThan(0);
    expect(ttlAfter).toBeLessThanOrEqual(ttlBefore);
  });
});

describe('janitorMatches', () => {
  it('drops set membership for a match whose record expired', async () => {
    const { mid } = await pair();
    await ctx.client.del(ctx.keys.match(mid));

    const result = await ctx.store.janitorMatches();
    expect(result).toMatchObject({ dropped: 1, ended: 0, survivors: [] });
    expect(await ctx.client.sismember(ctx.keys.matches(), mid)).toBe(0);
  });

  it('ends a match that lost a participant and names the survivor to notify', async () => {
    const { a, b, mid } = await pair();
    await ctx.client.del(ctx.keys.session(b));

    const result = await ctx.store.janitorMatches();
    expect(result.ended).toBe(1);
    expect(result.survivors).toEqual([{ sessionId: a, matchId: mid }]);
    // Which match, not just how many. Without the id the caller can count
    // endings and cannot record one, which is how every janitor-reaped
    // conversation came to have a null `ended_at`.
    expect(result.endedMatchIds).toEqual([mid]);
    expect(await ctx.store.readMatch(mid)).toBeNull();
    expect(await ctx.store.currentMatchId(a)).toBeNull();
    expect((await ctx.store.readSession(a))?.state).toBe('IDLE');
  });

  it('reports the match it ended even when nobody survived to be told', async () => {
    // The case the survivor list cannot cover: both sides gone, so there is
    // nobody to notify — and the conversation still needs its ending recorded.
    const { mid } = await pair();
    const both = await pair();
    void both;

    const { a, b } = await pair();
    await ctx.client.del(ctx.keys.session(a), ctx.keys.session(b));

    const result = await ctx.store.janitorMatches();
    expect(result.survivors).toEqual([]);
    expect(result.endedMatchIds.length).toBeGreaterThanOrEqual(1);
    void mid;
  });

  it('names nobody when both participants are gone', async () => {
    const { a, b } = await pair();
    await ctx.client.del(ctx.keys.session(a), ctx.keys.session(b));

    const result = await ctx.store.janitorMatches();
    expect(result).toMatchObject({ ended: 1, survivors: [] });
  });

  it('leaves healthy matches untouched', async () => {
    await pair();
    expect(await ctx.store.janitorMatches()).toMatchObject({ dropped: 0, ended: 0 });
  });

  it('is safe to run repeatedly', async () => {
    const { b } = await pair();
    await ctx.client.del(ctx.keys.session(b));
    await ctx.store.janitorMatches();
    expect(await ctx.store.janitorMatches()).toMatchObject({ dropped: 0, ended: 0, survivors: [] });
  });

  it('drops the dedupe set of an expired match', async () => {
    const { a, mid } = await pair();
    await ctx.store.resolvePartner(a, 'c_1');
    await ctx.client.del(ctx.keys.match(mid));

    await ctx.store.janitorMatches();
    expect(await ctx.client.exists(ctx.keys.dedupe(mid))).toBe(0);
  });
});

describe('janitorSessions', () => {
  it('reaps a session whose row expired but whose id is still registered', async () => {
    const sid = await ctx.session();
    await ctx.client.del(ctx.keys.session(sid));

    expect(await ctx.store.janitorSessions()).toMatchObject({ reaped: 1, ended: 0 });
    expect(await ctx.client.sismember(ctx.keys.sessions(), sid)).toBe(0);
  });

  it('closes sessions owned by an instance whose beacon expired (§10.13)', async () => {
    const orphan = await ctx.session({ instanceId: 'i_crashed' });
    // No beacon for i_crashed: from every surviving instance's point of view
    // that process is gone and its sockets with it.
    const result = await ctx.store.janitorSessions();
    expect(result.reaped).toBe(1);
    expect(await ctx.store.readSession(orphan)).toBeNull();
    expect(await ctx.client.sismember(ctx.keys.sessions(), orphan)).toBe(0);
  });

  it('ends the match of a crashed instance session and names the survivor', async () => {
    const survivor = await ctx.session();
    const doomed = await ctx.session({ instanceId: 'i_crashed' });
    await enqueue(ctx, survivor);
    await enqueue(ctx, doomed);
    const mid = newMatchId();
    await ctx.store.tryMatch(doomed, ctx.segment, mid);

    const result = await ctx.store.janitorSessions();
    expect(result).toMatchObject({ reaped: 1, ended: 1 });
    expect(result.survivors).toEqual([{ sessionId: survivor, matchId: mid }]);
    expect(await ctx.store.currentMatchId(survivor)).toBeNull();
    expect((await ctx.store.readSession(survivor))?.state).toBe('IDLE');
    expect(await ctx.store.currentMatchId(doomed)).toBeNull();
  });

  it('leaves sessions of live instances alone', async () => {
    await ctx.session();
    await ctx.session();
    expect(await ctx.store.janitorSessions()).toMatchObject({ reaped: 0, ended: 0 });
  });

  it('is idempotent', async () => {
    const sid = await ctx.session();
    await ctx.client.del(ctx.keys.session(sid));
    await ctx.store.janitorSessions();
    expect(await ctx.store.janitorSessions()).toMatchObject({ reaped: 0, ended: 0 });
  });

  it('does not hand back a survivor whose own session is also gone', async () => {
    const a = await ctx.session({ instanceId: 'i_crashed' });
    const b = await ctx.session({ instanceId: 'i_crashed' });
    await enqueue(ctx, a);
    await enqueue(ctx, b);
    await ctx.store.tryMatch(a, ctx.segment, newMatchId());

    const result = await ctx.store.janitorSessions();
    expect(result.reaped).toBe(2);
    expect(result.survivors).toEqual([]);
  });
});

describe('janitorInstances', () => {
  it('prunes instance ids whose beacon expired', async () => {
    await ctx.client.sadd(ctx.keys.instances(), 'i_ghost');
    const result = await ctx.store.janitorInstances();
    expect(result.removed).toBe(1);
    expect(await ctx.client.sismember(ctx.keys.instances(), 'i_ghost')).toBe(0);
  });

  it('keeps instances that are still beaconing', async () => {
    const result = await ctx.store.janitorInstances();
    expect(result.removed).toBe(0);
    expect(await ctx.client.sismember(ctx.keys.instances(), ctx.config.instanceId)).toBe(1);
  });
});

describe('janitor lock', () => {
  it('is held by exactly one instance at a time', async () => {
    expect(await ctx.store.acquireJanitorLock('i_one')).toBe(true);
    expect(await ctx.store.acquireJanitorLock('i_two')).toBe(false);
    expect(await ctx.client.get(ctx.keys.janitorLock())).toBe('i_one');
  });

  it('expires, so a crash while holding it does not stop the janitor forever', async () => {
    await ctx.store.acquireJanitorLock('i_one');
    const ttl = await ctx.client.ttl(ctx.keys.janitorLock());
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.timers.janitorLockTtlSeconds);

    await ctx.client.del(ctx.keys.janitorLock());
    expect(await ctx.store.acquireJanitorLock('i_two')).toBe(true);
  });
});

describe('presence counts (D21)', () => {
  it('reports real cardinalities, never a synthesised number', async () => {
    expect(await ctx.store.presenceCounts()).toEqual({ online: 0, conversations: 0 });

    const { a, b } = await pair();
    expect(await ctx.store.presenceCounts()).toEqual({ online: 2, conversations: 1 });

    await ctx.store.closeSession(a, 'x'.repeat(32));
    await ctx.store.closeSession(b, 'x'.repeat(32));
    expect(await ctx.store.presenceCounts()).toMatchObject({ online: 0 });
  });

  it('counts a lone waiter as online with no conversation', async () => {
    const sid = newSessionId();
    await ctx.session({ sessionId: sid });
    await enqueue(ctx, sid);
    expect(await ctx.store.presenceCounts()).toEqual({ online: 1, conversations: 0 });
  });
});
