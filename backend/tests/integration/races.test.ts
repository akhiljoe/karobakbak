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
/** Same Redis, resumption disabled — for the teardown races (§28). */
let noResume: TestContext;

beforeAll(async () => {
  one = await createTestContext();
  // Same keyspace, different connection, different instance id: a second
  // backend, as far as Redis is concerned.
  two = await createTestContext({
    REDIS_KEY_PREFIX: one.config.redis.keyPrefix,
    INSTANCE_ID: 'i_two',
  });
  noResume = await createTestContext({
    REDIS_KEY_PREFIX: one.config.redis.keyPrefix,
    RESUME_GRACE_SECONDS: '0',
  });
});

afterEach(async () => {
  await one.flush();
});

afterAll(async () => {
  await one.close();
  await two.close();
  await noResume.close();
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
        expect(await noResume.store.currentMatchId(a)).toBeNull();
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

describe('§10.5 — matched, then one side disconnects immediately', () => {
  it('hands the caller the match to end and releases the survivor', async () => {
    // Resumption off: this is the teardown path, where a dropped socket ends
    // the conversation. The held-seat path has its own suite (§28).
    const a = await noResume.session();
    const b = await noResume.session({ instanceId: 'i_two' });
    await enqueue(noResume, a);
    await enqueue(noResume, b);
    const mid = newMatchId();
    expect(await noResume.store.tryMatch(a, noResume.segment, mid)).toMatchObject({
      status: 'matched',
    });

    // b's socket dies a millisecond after pairing.
    const closed = await noResume.store.closeSession(b, fakeHash(b));
    // closeSession deliberately does not end the match — it reports which one
    // to end, because endMatch is what cleans both sides.
    expect(closed).toEqual({ status: 'closed', matchId: mid });

    const ended = await noResume.store.endMatch(mid);
    expect(ended).toMatchObject({ status: 'ended', segment: noResume.segment });
    // The survivor is named, so the instance owning a's socket knows whom to
    // notify. Nobody has to guess it from a routing table.
    if (ended.status === 'ended') expect([ended.a, ended.b].sort()).toEqual([a, b].sort());

    expect(await noResume.store.currentMatchId(a)).toBeNull();
    expect((await one.store.readSession(a))?.state).toBe('IDLE');
    expect(await one.store.readMatch(mid)).toBeNull();
  });

  it('converges when the same disconnect is cleaned up twice', async () => {
    const a = await noResume.session();
    const b = await noResume.session();
    await enqueue(noResume, a);
    await enqueue(noResume, b);
    const mid = newMatchId();
    await noResume.store.tryMatch(a, noResume.segment, mid);

    await noResume.store.closeSession(b, fakeHash(b));
    await noResume.store.endMatch(mid);

    // A duplicate cleanup — a retried close handler, or the janitor arriving
    // behind it — must not error or resurrect state (I3, rule 4).
    expect(await noResume.store.closeSession(b, fakeHash(b))).toEqual({
      status: 'gone',
      matchId: null,
    });
    expect(await noResume.store.endMatch(mid)).toEqual({ status: 'already_ended' });
    expect((await noResume.store.readSession(a))?.state).toBe('IDLE');
  });
});

/**
 * These describe the *teardown* path, so they run with resumption disabled.
 *
 * With a held seat a dropped socket deliberately stays routable — that is the
 * fix which stops one message during the gap from ending the conversation — so
 * "gone the instant the socket closed" is no longer what a disconnect means
 * unless resumption is off. The window §10.9 is about still exists there, and
 * still has to be safe.
 */
describe('§10.9 — message racing a partner disconnect (no resumption)', () => {
  it('refuses to route to a session that is gone, without burning the message id', async () => {
    const a = await noResume.session();
    const b = await noResume.session();
    await enqueue(noResume, a);
    await enqueue(noResume, b);
    const mid = newMatchId();
    await noResume.store.tryMatch(a, noResume.segment, mid);

    // The window §10.9 is about: b's session row is gone, but the match record
    // has not been torn down yet.
    await noResume.store.closeSession(b, fakeHash(b));
    expect(await noResume.store.resolvePartner(a, 'c_gone')).toEqual({
      status: 'partner_gone',
      matchId: mid,
    });

    // The id was not consumed: the dedupe SADD happens only after a partner is
    // resolved, so an undeliverable message stays retryable (§10.17).
    expect(await noResume.client.sismember(noResume.keys.dedupe(mid), 'c_gone')).toBe(0);

    // Once the match is ended there is no match to speak of at all.
    await noResume.store.endMatch(mid);
    expect(await noResume.store.resolvePartner(a, 'c_gone')).toEqual({ status: 'not_matched' });
  });

  it('never resolves a deliverable partner once the disconnect has landed', async () => {
    for (let round = 0; round < 12; round += 1) {
      const a = await noResume.session();
      const b = await noResume.session();
      await enqueue(noResume, a);
      await enqueue(noResume, b);
      const mid = newMatchId();
      await noResume.store.tryMatch(a, noResume.segment, mid);

      const [routed] = await Promise.all([
        noResume.store.resolvePartner(a, `c_${round}`),
        noResume.store.closeSession(b, fakeHash(b)),
      ]);

      // Three orderings, all safe: the send beat the close (`ok`, and the
      // delivering instance then finds a closed socket — fire-and-forget by
      // design), or the close landed first (`partner_gone`). What must never
      // happen is a resolve *after* the close claiming a live partner.
      expect(['ok', 'partner_gone']).toContain(routed.status);
      const after = await noResume.store.resolvePartner(a, `c_after_${round}`);
      expect(after.status).not.toBe('ok');

      await noResume.flush();
    }
  });
});

describe('§10.10 — duplicate queue entries', () => {
  it('is structurally impossible under concurrent joins', async () => {
    const sid = await noResume.session();
    await Promise.all([
      noResume.store.joinQueue(sid, noResume.segment),
      noResume.store.joinQueue(sid, two.segment),
      noResume.store.joinQueue(sid, noResume.segment),
    ]);
    expect(await noResume.store.queueDepth(noResume.segment)).toBe(1);
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
    await one.store.joinQueue(sid, two.segment);
    const partner = await two.session({ instanceId: 'i_two' });
    await enqueue(one, partner);

    const result = await one.store.tryMatch(sid, one.segment, newMatchId());
    expect(result).toMatchObject({ status: 'matched', partnerSessionId: partner });
    expect(await one.store.heartbeat(sid)).toMatchObject({ state: 'MATCHED' });
  });

  it('routes to whichever instance owns the partner socket', async () => {
    const local = await one.session({ instanceId: 'i_one' });
    const remote = await two.session({ instanceId: 'i_two' });
    await enqueue(one, local);
    await enqueue(one, remote);
    await one.store.tryMatch(local, one.segment, newMatchId());

    expect(await one.store.resolvePartner(local, 'c_1')).toMatchObject({
      partnerInstanceId: 'i_two',
    });
    expect(await one.store.resolvePartner(remote, 'c_2')).toMatchObject({
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

/*
 * The catalogued R rows that had no test.
 *
 * `docs/LOADTEST-SCENARIOS.md` lists fifteen and records the group as having no
 * dedicated coverage. That was out of date: R1, R4, R13 and R14 are already
 * exercised above, under names that describe the behaviour rather than the row.
 * These are four of the ones that genuinely were not.
 *
 * They are here rather than in the swarm for the reason the catalogue's own
 * preamble gives — "these need both sides under one controller" — which is a
 * description of an integration test. A harness that has to synchronise two
 * bots across a network to hit a Redis race is testing its own scheduler as
 * much as the server's scripts.
 */
describe('R10 — block and skip issued together', () => {
  /**
   * Exactly one teardown, and **the block is recorded regardless of which
   * won**. The second half is the one that matters: a user who pressed Block
   * and whose partner skipped in the same instant must still be protected, and
   * the losing path must not quietly discard the protection they asked for.
   */
  it('records the block whichever of the two ends the match', async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await one.flush();
      const a = await one.session();
      const b = await two.session();
      await enqueue(one, a);
      await enqueue(two, b);
      const mid = newMatchId();
      const matched = await one.store.tryMatch(a, one.segment, mid);
      expect(matched.status).toBe('matched');

      // `a` blocks while `b` skips, in the same tick.
      const [blocked, ended] = await Promise.all([
        one.store.blockPartner(a),
        two.store.endMatch(mid),
      ]);

      // Exactly one teardown: either the block ended it or the skip did, never
      // both and never neither.
      const teardowns =
        (blocked.status === 'blocked' && blocked.endedByUs ? 1 : 0) +
        (ended.status === 'ended' ? 1 : 0);
      expect(teardowns).toBe(1);

      // And the protection exists either way. A block that raced a teardown and
      // recorded nothing is the user's request silently dropped.
      if (blocked.status === 'blocked') {
        expect(blocked.recorded).toBeGreaterThan(0);
      }

      for (const sid of [a, b]) {
        expect(await one.store.currentMatchId(sid)).toBeNull();
      }
    }
  });
});

describe('R12 — join_queue and leave_queue together', () => {
  /**
   * A deterministic final state, and the point is that it is *readable*: after
   * both have returned, the session is either queued or not, and the queue
   * agrees with the session row. A coin flip between two writers that left the
   * two disagreeing would be the bug — a session listed in the queue with no
   * row behind it is a candidate every searcher walks past and cleans up.
   */
  it('leaves the queue and the session row agreeing, however it resolves', async () => {
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await one.flush();
      const a = await one.session();

      await Promise.all([
        one.store.joinQueue(a, one.segment),
        two.store.leaveQueue(a, two.segment),
      ]);

      const queued = await one.store.queueDepth(one.segment);
      const session = await one.store.readSession(a);
      expect(session).not.toBeNull();

      // The two views agree. Whichever won, the state is one of the two legal
      // ones and never a queue entry with no session behind it.
      if (queued === 1) expect(session?.state).toBe('SEARCHING');
      else expect(queued).toBe(0);
    }
  });
});

describe('R5 — two sessions skipping into each other', () => {
  /**
   * No livelock, and no monopoly.
   *
   * Two sessions alone in the queue will re-match each other, which is correct
   * — there is nobody else. What must not happen is the pair getting stuck in a
   * state where neither is matched and neither is queued, which is what a
   * teardown that loses a re-queue looks like.
   */
  it('converges on every cycle rather than stranding either side', async () => {
    const a = await one.session();
    const b = await two.session();

    for (let cycle = 0; cycle < 10; cycle += 1) {
      await enqueue(one, a);
      await enqueue(two, b);
      const mid = newMatchId();
      const matched = await one.store.tryMatch(a, one.segment, mid);
      expect(matched.status).toBe('matched');

      // Both skip at once, every cycle.
      await Promise.all([one.store.endMatch(mid), two.store.endMatch(mid)]);

      for (const sid of [a, b]) {
        expect(await one.store.currentMatchId(sid)).toBeNull();
        // Still a live session: a skip must never cost somebody their session.
        expect(await one.store.readSession(sid)).not.toBeNull();
      }
    }
  });
});

describe('R15 — a delayed message from a previous match', () => {
  /**
   * The match id on the record is what makes this decidable.
   *
   * A message accepted in one conversation and routed a moment late must never
   * arrive in the next one. Sessions are reused across matches — that is the
   * whole of §28 — so the session id cannot answer this and the match id has
   * to, which is why every routing decision carries one.
   */
  it('cannot be routed into the match that replaced it', async () => {
    const a = await one.session();
    const b = await two.session();
    await enqueue(one, a);
    await enqueue(two, b);

    const first = newMatchId();
    const matched = await one.store.tryMatch(a, one.segment, first);
    expect(matched.status).toBe('matched');

    // The conversation ends and the same two are matched again, which is
    // exactly what a skip with nobody else waiting produces.
    await one.store.endMatch(first);
    await enqueue(one, a);
    await enqueue(two, b);
    const second = newMatchId();
    expect((await one.store.tryMatch(a, one.segment, second)).status).toBe('matched');

    // A route resolved now names the NEW match. Anything holding the old id is
    // holding a value that no longer describes where this session is.
    const route = await one.store.resolveRoute(a);
    expect(route.status).toBe('ok');
    if (route.status === 'ok') {
      expect(route.matchId).toBe(second);
      expect(route.matchId).not.toBe(first);
    }

    // And the old match is gone rather than merely superseded.
    expect(await one.store.endMatch(first)).toMatchObject({ status: 'already_ended' });
  });
});
