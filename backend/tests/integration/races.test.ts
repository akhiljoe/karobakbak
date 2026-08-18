/**
 * The concurrency scenarios of `DESIGN.md` §10, exercised rather than argued.
 *
 * Where a scenario is about two backend instances, the test drives a second
 * `TestContext` sharing the same key prefix on its own Redis connection. Node's
 * single thread proves nothing here; what is being tested is that the scripts
 * serialise correctly when two processes race.
 */
import { createTestContext, enqueue, fakeHash, type TestContext } from '../helpers/redis';
import { newMatchId, newSessionId } from '../../src/util/ids';

let one: TestContext;
let two: TestContext;

beforeAll(async () => {
  one = await createTestContext();
  // Same keyspace, different connection, different instance id: a second
  // backend, as far as Redis is concerned.
  two = await createTestContext({
    REDIS_KEY_PREFIX: one.config.redis.keyPrefix,
    INSTANCE_ID: 'i_two',
  });
});

afterEach(async () => {
  await one.flush();
});

afterAll(async () => {
  await one.close();
  await two.close();
});

/** Every live match, as { mid: [a, b] }. */
async function liveMatches(ctx: TestContext): Promise<Record<string, string[]>> {
  const mids = await ctx.client.smembers(ctx.keys.matches());
  const out: Record<string, string[]> = {};
  for (const mid of mids) {
    const match = await ctx.store.readMatch(mid);
    if (match) out[mid] = [match.a ?? '', match.b ?? ''];
  }
  return out;
}

describe('§10.1 — two users queue simultaneously', () => {
  it('produces exactly one match, from two different instances', async () => {
    const a = await one.session();
    const b = await two.session({ instanceId: 'i_two' });
    await enqueue(one, a);
    await enqueue(two, b);

    const [ra, rb] = await Promise.all([
      one.store.tryMatch(a, one.segment, newMatchId()),
      two.store.tryMatch(b, two.segment, newMatchId()),
    ]);

    const matched = [ra, rb].filter((r) => r.status === 'matched');
    const other = [ra, rb].filter((r) => r.status !== 'matched');
    expect(matched).toHaveLength(1);
    // The loser is told it was already matched, not that something failed.
    expect(other[0]).toEqual({ status: 'abort', reason: 'already_matched' });

    expect(await one.client.scard(one.keys.matches())).toBe(1);
    expect(await one.store.currentMatchId(a)).toBe(await one.store.currentMatchId(b));
  });

  it('leaves neither side in the queue', async () => {
    const a = await one.session();
    const b = await two.session();
    await enqueue(one, a);
    await enqueue(two, b);
    await Promise.all([
      one.store.tryMatch(a, one.segment, newMatchId()),
      two.store.tryMatch(b, two.segment, newMatchId()),
    ]);
    expect(await one.store.queueDepth(one.segment)).toBe(0);
  });
});

describe('§10.2 — many users queue at once', () => {
  it('never puts a session in two matches (I5)', async () => {
    const sessions: string[] = [];
    for (let i = 0; i < 21; i += 1) {
      const ctx = i % 2 === 0 ? one : two;
      const sid = await ctx.session({ instanceId: i % 2 === 0 ? 'i_one' : 'i_two' });
      sessions.push(sid);
    }

    await Promise.all(
      sessions.map(async (sid, i) => {
        const ctx = i % 2 === 0 ? one : two;
        await ctx.store.joinQueue(sid, ctx.segment);
        // Retry, exactly as the real flow does, so an ABORT is not a lost user.
        for (let attempt = 0; attempt < one.config.matchmaking.retryAttempts; attempt += 1) {
          const result = await ctx.store.tryMatch(sid, ctx.segment, newMatchId());
          if (result.status !== 'waiting') return;
        }
      }),
    );

    const matches = await liveMatches(one);
    const seen = new Set<string>();
    for (const [mid, [a, b]] of Object.entries(matches)) {
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      expect(a).not.toBe(b); // I2
      for (const sid of [a, b]) {
        expect(seen.has(sid as string)).toBe(false); // I5
        seen.add(sid as string);
        expect(await one.store.currentMatchId(sid as string)).toBe(mid); // I4
      }
    }

    // 21 sessions: an odd one out is expected, and it must still be waiting
    // rather than lost.
    const unmatched = sessions.filter((sid) => !seen.has(sid));
    expect(unmatched.length).toBe(1);
    expect(await one.store.queueDepth(one.segment)).toBe(1);
  });
});

describe('§10.3 / §10.4 — disconnect racing matchmaking', () => {
  it('leaves nothing to trip over when a queued session disconnects cleanly', async () => {
    const ghost = await one.session();
    await enqueue(one, ghost);
    await one.store.closeSession(ghost, fakeHash(ghost));

    const searcher = await two.session();
    await enqueue(two, searcher);
    const result = await two.store.tryMatch(searcher, two.segment, newMatchId());
    // Nothing to clean: closeSession took the entry out itself. The GC counter
    // is for entries left by a process that never got to run its handler.
    expect(result).toMatchObject({ status: 'waiting', cleaned: 0, queueDepth: 1 });
  });

  it('skips and reaps a candidate whose process died without cleaning up', async () => {
    const killed = await one.session();
    await enqueue(one, killed);
    // SIGKILL: no close handler ran, only the TTL and the next scanner remain.
    await one.client.del(one.keys.session(killed));

    const searcher = await two.session();
    await enqueue(two, searcher);
    const result = await two.store.tryMatch(searcher, two.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', cleaned: 1 });
    expect(await one.client.sismember(one.keys.queue(one.segment), killed)).toBe(0);
  });

  it('resolves a match/close race one way or the other, never half-way', async () => {
    for (let round = 0; round < 12; round += 1) {
      const a = await one.session();
      const b = await two.session();
      await enqueue(one, a);
      await enqueue(two, b);
      const mid = newMatchId();

      const [match, close] = await Promise.all([
        one.store.tryMatch(a, one.segment, mid),
        two.store.closeSession(b, fakeHash(b)),
      ]);

      if (match.status === 'matched') {
        // The match won the race. The disconnecting side's cleanup then ends
        // it, and the survivor is released — never left pointing at a partner
        // that no longer exists.
        expect(close.matchId === mid || close.matchId === null).toBe(true);
        await one.store.endMatch(mid);
        expect(await one.store.currentMatchId(a)).toBeNull();
        expect((await one.store.readSession(a))?.state).toBe('IDLE');
      } else {
        // The close won: the candidate was skipped and no match exists.
        expect(match.status).toBe('waiting');
        expect(await one.store.readMatch(mid)).toBeNull();
      }
      await one.flush();
    }
  });
});

describe('§10.6 / §10.7 — skip semantics', () => {
  it('names exactly one winner when both sides skip at the same instant', async () => {
    const a = await one.session();
    const b = await two.session();
    await enqueue(one, a);
    await enqueue(two, b);
    const mid = newMatchId();
    await one.store.tryMatch(a, one.segment, mid);

    const [first, second] = await Promise.all([
      one.store.endMatch(mid),
      two.store.endMatch(mid),
    ]);
    const ended = [first, second].filter((r) => r.status === 'ended');
    const already = [first, second].filter((r) => r.status === 'already_ended');
    expect(ended).toHaveLength(1);
    expect(already).toHaveLength(1);

    // The winner cleaned BOTH sides, so the loser has nothing left to do.
    for (const sid of [a, b]) {
      expect(await one.store.currentMatchId(sid)).toBeNull();
      expect((await one.store.readSession(sid))?.state).toBe('IDLE');
    }
  });

  it('makes a repeated skip converge instead of erroring', async () => {
    const a = await one.session();
    const b = await two.session();
    await enqueue(one, a);
    await enqueue(two, b);
    const mid = newMatchId();
    await one.store.tryMatch(a, one.segment, mid);

    await one.store.endMatch(mid);
    // Second skip: no match to end, and "ensure I am searching" still works.
    expect(await one.store.endMatch(mid)).toEqual({ status: 'already_ended' });
    expect(await one.store.joinQueue(a, one.segment)).toMatchObject({ status: 'ok' });
    expect(await one.store.joinQueue(a, one.segment)).toMatchObject({
      status: 'already_searching',
    });
  });
});

describe('§10.8 — message racing a skip', () => {
  it('cannot deliver through a match that has been ended', async () => {
    const a = await one.session();
    const b = await two.session();
    await enqueue(one, a);
    await enqueue(two, b);
    const mid = newMatchId();
    await one.store.tryMatch(a, one.segment, mid);

    const [routed] = await Promise.all([
      one.store.resolvePartner(a, 'c_race'),
      two.store.endMatch(mid),
    ]);

    // Either the message resolved before the match died, or it did not resolve
    // at all. There is no third outcome: a deleted match can never deliver (I6).
    expect(['ok', 'not_matched']).toContain(routed.status);
    expect(await one.store.resolvePartner(a, 'c_after')).toEqual({ status: 'not_matched' });
  });
});

describe('§10.10 — duplicate queue entries', () => {
  it('is structurally impossible under concurrent joins', async () => {
    const sid = await one.session();
    await Promise.all([
      one.store.joinQueue(sid, one.segment),
      two.store.joinQueue(sid, two.segment),
      one.store.joinQueue(sid, one.segment),
    ]);
    expect(await one.store.queueDepth(one.segment)).toBe(1);
  });
});

describe('§10.14 — Redis lost its scripts', () => {
  it('recovers from an empty script cache without an outage', async () => {
    const sid = await one.session();
    // SCRIPT FLUSH, a failover to a replica that never loaded them, or a Redis
    // restart (routine here — persistence is off, D12) all look like this.
    await one.client.script('FLUSH');
    one.runner.reset();

    expect(await one.store.joinQueue(sid, one.segment)).toMatchObject({ status: 'ok' });
    expect(await one.store.heartbeat(sid)).toMatchObject({ status: 'ok' });
  });

  it('reports SESSION_GONE for everything after Redis loses its state', async () => {
    const sid = await one.session();
    await enqueue(one, sid);
    // Wiping the keyspace is what a Redis restart looks like to a client.
    await one.flush();

    expect(await one.store.heartbeat(sid)).toEqual({ status: 'session_gone' });
    expect(await one.store.joinQueue(sid, one.segment)).toEqual({ status: 'session_gone' });
    expect(await one.store.leaveQueue(sid, one.segment)).toEqual({ status: 'session_gone' });
    expect(await one.store.resolvePartner(sid, 'c_1')).toEqual({ status: 'not_matched' });
  });
});

describe('§10.15 — two instances, no process-local state', () => {
  it('lets either instance drive any session', async () => {
    // Created by instance one, queued by instance two, matched by instance one:
    // no decision reads process-local state, so none of this is unusual.
    const sid = await one.session();
    await two.store.joinQueue(sid, two.segment);
    const partner = await two.session({ instanceId: 'i_two' });
    await enqueue(two, partner);

    const result = await one.store.tryMatch(sid, one.segment, newMatchId());
    expect(result).toMatchObject({ status: 'matched', partnerSessionId: partner });
    expect(await two.store.heartbeat(sid)).toMatchObject({ state: 'MATCHED' });
  });

  it('routes to whichever instance owns the partner socket', async () => {
    const local = await one.session({ instanceId: 'i_one' });
    const remote = await two.session({ instanceId: 'i_two' });
    await enqueue(one, local);
    await enqueue(two, remote);
    await one.store.tryMatch(local, one.segment, newMatchId());

    expect(await one.store.resolvePartner(local, 'c_1')).toMatchObject({
      partnerInstanceId: 'i_two',
    });
    expect(await two.store.resolvePartner(remote, 'c_2')).toMatchObject({
      partnerInstanceId: 'i_one',
    });
  });
});

describe('cross-instance events (§11)', () => {
  it('delivers on a per-session channel, so the channel name is the routing key', async () => {
    const sid = newSessionId();
    const received: string[] = [];
    const subscriber = two.client.duplicate();
    try {
      await subscriber.subscribe(two.keys.sessionChannel(sid));
      subscriber.on('message', (_channel, payload) => received.push(payload));

      const delivered = await one.store.publishToSession(sid, '{"v":1,"event":"matched"}');
      expect(delivered).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(received).toEqual(['{"v":1,"event":"matched"}']);
    } finally {
      subscriber.disconnect();
    }
  });

  it('drops an event for a session nobody is listening to', async () => {
    // Correct by design: every event reports state already committed in Redis,
    // and the client's next action re-reads authoritative state.
    expect(await one.store.publishToSession(newSessionId(), '{"v":1}')).toBe(0);
  });
});
