/**
 * The lifecycle driven against a real Redis, from two independent instances.
 *
 * The unit tests prove the decisions; these prove that the decisions survive
 * two processes racing through real Lua. Each instance has its own connection,
 * its own registry and its own dispatcher — nothing is shared in process
 * memory, which is the only way the two-instance claim means anything.
 */
import { createNullLogger } from '../../src/logger';
import { decodeSessionEvent, type SessionEvent } from '../../src/ws/events';
import { EventDispatcher } from '../../src/ws/dispatch';
import { SessionLifecycle } from '../../src/ws/lifecycle';
import { NullRetentionSink } from '../../src/storage/sink';
import { ConnectionRegistry } from '../../src/ws/registry';
import { FakeConnection } from '../helpers/fakes';
import { createTestContext, delay, type TestContext } from '../helpers/redis';

interface Instance {
  ctx: TestContext;
  registry: ConnectionRegistry;
  lifecycle: SessionLifecycle;
}

function instanceFor(ctx: TestContext): Instance {
  const logger = createNullLogger();
  const registry = new ConnectionRegistry(logger);
  const dispatcher = new EventDispatcher(registry, ctx.store, logger);
  return {
    ctx,
    registry,
    lifecycle: new SessionLifecycle(ctx.store, dispatcher, registry, ctx.config, logger, new NullRetentionSink()),
  };
}

let one: Instance;
let two: Instance;

beforeAll(async () => {
  const first = await createTestContext();
  const second = await createTestContext({
    REDIS_KEY_PREFIX: first.config.redis.keyPrefix,
    INSTANCE_ID: 'i_two',
  });
  one = instanceFor(first);
  two = instanceFor(second);
});

afterEach(async () => {
  one.registry.clear();
  two.registry.clear();
  await one.ctx.flush();
});

afterAll(async () => {
  await one.ctx.close();
  await two.ctx.close();
});

/** Open a session on an instance and attach a fake socket to it. */
async function connect(
  instance: Instance,
  ipHash = `ip${Math.random().toString(36).slice(2, 10)}`,
): Promise<{ sessionId: string; socket: FakeConnection; ipHash: string }> {
  const clientHash = `cl${Math.random().toString(36).slice(2, 10)}`;
  const opened = await instance.lifecycle.open(ipHash, clientHash);
  if (opened.kind !== 'opened') throw new Error(`expected to open, got ${opened.kind}`);
  const socket = new FakeConnection(opened.sessionId, ipHash, clientHash);
  instance.registry.add(socket);
  return { sessionId: opened.sessionId, socket, ipHash };
}

/** Subscribe to a session's channel, as the instance owning its socket would. */
async function listen(
  instance: Instance,
  sessionId: string,
): Promise<{ events: SessionEvent[]; stop: () => void }> {
  const events: SessionEvent[] = [];
  // A dedicated connection: a Redis connection in subscriber mode refuses
  // ordinary commands, which is why the real client is a pair as well.
  const subscriber = instance.ctx.client.duplicate();
  await subscriber.subscribe(instance.ctx.keys.sessionChannel(sessionId));
  subscriber.on('message', (_channel, payload) => {
    const event = decodeSessionEvent(payload);
    if (event) events.push(event);
  });
  return { events, stop: () => subscriber.disconnect() };
}

describe('open, against real limits', () => {
  it('creates a session row and claims a slot', async () => {
    const { sessionId, ipHash } = await connect(one);
    expect(await one.ctx.store.readSession(sessionId)).toMatchObject({ state: 'IDLE' });
    expect(await one.ctx.client.sismember(one.ctx.keys.connSessions(ipHash), sessionId)).toBe(1);
  });

  it('refuses past the concurrency cap and leaves no ghost session behind', async () => {
    const strict = await createTestContext({ MAX_CONNECTIONS_PER_IP: '1' });
    const instance = instanceFor(strict);
    try {
      const held = await connect(instance, 'ipsharedaddress0000000000000000');
      const denied = await instance.lifecycle.open('ipsharedaddress0000000000000000', 'cl2');
      expect(denied).toMatchObject({ kind: 'too_many_connections' });

      // Exactly one session row for that address: the rejected one was rolled
      // back rather than left as a matchable ghost.
      const members = await strict.client.smembers(
        strict.keys.connSessions('ipsharedaddress0000000000000000'),
      );
      expect(members).toEqual([held.sessionId]);
      expect(await strict.client.scard(strict.keys.sessions())).toBe(1);
    } finally {
      await strict.close();
    }
  });

  it('refuses once the attempt rate is exhausted', async () => {
    const strict = await createTestContext({ CONN_RATE_LIMIT: '2' });
    const instance = instanceFor(strict);
    try {
      const ipHash = 'ipattacker000000000000000000000';
      await instance.lifecycle.open(ipHash, 'cl1');
      await instance.lifecycle.open(ipHash, 'cl2');
      expect(await instance.lifecycle.open(ipHash, 'cl3')).toMatchObject({ kind: 'rate_limited' });
    } finally {
      await strict.close();
    }
  });
});

describe('matching across two instances', () => {
  it('produces exactly one match when both join at the same moment', async () => {
    const a = await connect(one);
    const b = await connect(two);

    const [ra, rb] = await Promise.all([
      one.lifecycle.joinQueue(a.sessionId),
      two.lifecycle.joinQueue(b.sessionId),
    ]);

    const matched = [ra, rb].filter((r) => r.kind === 'matched');
    expect(matched).toHaveLength(1);
    // The loser is told a peer matched it, and sends nothing: the matched frame
    // is already on its way from the instance that won (§10.1).
    expect([ra, rb].filter((r) => r.kind === 'matched_elsewhere')).toHaveLength(1);
    expect(await one.ctx.client.scard(one.ctx.keys.matches())).toBe(1);
  });

  it('delivers matched to the partner over Pub/Sub with the identities swapped', async () => {
    const a = await connect(one);
    const b = await connect(two);
    // Only instance two owns b's socket, so instance one must publish.
    const heard = await listen(two, b.sessionId);
    try {
      await two.lifecycle.joinQueue(b.sessionId);
      const result = await one.lifecycle.joinQueue(a.sessionId);
      if (result.kind !== 'matched') throw new Error('expected a match');
      expect(result.partnerRoute).toBe('remote');

      await delay(80);
      expect(heard.events).toHaveLength(1);
      expect(heard.events[0]).toMatchObject({
        event: 'matched',
        matchId: result.matchId,
        you: result.partner,
        partner: result.you,
      });
    } finally {
      heard.stop();
    }
  });

  it('takes the local path when both sockets are on one instance (D9)', async () => {
    const a = await connect(one);
    const b = await connect(one);
    await one.lifecycle.joinQueue(a.sessionId);

    const result = await one.lifecycle.joinQueue(b.sessionId);
    expect(result).toMatchObject({ kind: 'matched', partnerRoute: 'local' });
    expect(a.socket.parsed()[0]).toMatchObject({ type: 'matched' });
  });
});

describe('skip across two instances (§12)', () => {
  it('notifies the remote partner exactly once and re-queues only the skipper', async () => {
    const a = await connect(one);
    const b = await connect(two);
    const heard = await listen(two, b.sessionId);
    try {
      await two.lifecycle.joinQueue(b.sessionId);
      const matched = await one.lifecycle.joinQueue(a.sessionId);
      if (matched.kind !== 'matched') throw new Error('expected a match');
      await delay(60);
      heard.events.length = 0;

      const result = await one.lifecycle.skip(a.sessionId);
      await delay(60);

      expect(heard.events).toEqual([{ event: 'partner_skipped', matchId: matched.matchId }]);
      expect(result).toMatchObject({ kind: 'searching' });
      // The skipped user decides for themselves whether to keep looking.
      expect((await two.ctx.store.readSession(b.sessionId))?.state).toBe('IDLE');
    } finally {
      heard.stop();
    }
  });

  it('sends exactly one notification when both sides skip at once (§10.7)', async () => {
    const a = await connect(one);
    const b = await connect(two);
    const heardA = await listen(one, a.sessionId);
    const heardB = await listen(two, b.sessionId);
    try {
      await two.lifecycle.joinQueue(b.sessionId);
      const matched = await one.lifecycle.joinQueue(a.sessionId);
      if (matched.kind !== 'matched') throw new Error('expected a match');
      await delay(60);
      heardA.events.length = 0;
      heardB.events.length = 0;

      await Promise.all([one.lifecycle.skip(a.sessionId), two.lifecycle.skip(b.sessionId)]);
      await delay(80);

      const skips = [...heardA.events, ...heardB.events].filter(
        (event) => event.event === 'partner_skipped' && event.matchId === matched.matchId,
      );
      // Only the caller whose endMatch won notifies. Both notifying would end
      // the conversation twice on one screen.
      expect(skips).toHaveLength(1);
      expect(await one.ctx.store.readMatch(matched.matchId)).toBeNull();
    } finally {
      heardA.stop();
      heardB.stop();
    }
  });
});

describe('block across two instances (D18)', () => {
  it('ends the match, tells the partner it was a skip, and refuses the re-match', async () => {
    const a = await connect(one);
    const b = await connect(two);
    const heard = await listen(two, b.sessionId);
    try {
      await two.lifecycle.joinQueue(b.sessionId);
      const matched = await one.lifecycle.joinQueue(a.sessionId);
      if (matched.kind !== 'matched') throw new Error('expected a match');
      await delay(60);
      heard.events.length = 0;

      const blocked = await one.lifecycle.block(a.sessionId, { ipHash: a.ipHash, clientHash: 'cl' });
      expect(blocked).toMatchObject({ kind: 'blocked', recorded: 2 });
      await delay(60);
      // Indistinguishable from a skip (security §32).
      expect(heard.events).toEqual([{ event: 'partner_skipped', matchId: matched.matchId }]);

      // Both re-queue: the block must survive into matchmaking (I12).
      await two.lifecycle.joinQueue(b.sessionId);
      const again = await one.lifecycle.joinQueue(a.sessionId);
      expect(again).toMatchObject({ kind: 'searching' });
    } finally {
      heard.stop();
    }
  });

  it('leaves the blocker idle rather than searching', async () => {
    const a = await connect(one);
    const b = await connect(one);
    await one.lifecycle.joinQueue(a.sessionId);
    await one.lifecycle.joinQueue(b.sessionId);

    await one.lifecycle.block(a.sessionId, { ipHash: a.ipHash, clientHash: 'cl' });
    expect((await one.ctx.store.readSession(a.sessionId))?.state).toBe('IDLE');
    expect(await one.ctx.store.queueDepth(one.ctx.segment)).toBe(0);
  });
});

describe('leave_chat — end the conversation without re-queueing', () => {
  it('lands the leaver in IDLE, not back in the queue', async () => {
    const a = await connect(one);
    const b = await connect(two);
    await two.lifecycle.joinQueue(b.sessionId);
    const matched = await one.lifecycle.joinQueue(a.sessionId);
    if (matched.kind !== 'matched') throw new Error('expected a match');

    expect(await one.lifecycle.leaveChat(a.sessionId)).toEqual({ kind: 'left' });

    // The whole point of the command: `skip` would have re-queued them here.
    expect((await one.ctx.store.readSession(a.sessionId))?.state).toBe('IDLE');
    expect(await one.ctx.store.currentMatchId(a.sessionId)).toBeNull();
  });

  it('cannot be re-matched by the partner it just left', async () => {
    const a = await connect(one);
    const b = await connect(two);
    await two.lifecycle.joinQueue(b.sessionId);
    const matched = await one.lifecycle.joinQueue(a.sessionId);
    if (matched.kind !== 'matched') throw new Error('expected a match');

    await one.lifecycle.leaveChat(a.sessionId);
    // The partner is released and searches again. With `skip` the leaver would
    // still be in the queue and these two would pair straight back up, which is
    // precisely the bug this command exists to avoid.
    const partnerAgain = await two.lifecycle.joinQueue(b.sessionId);
    expect(partnerAgain).toMatchObject({ kind: 'searching' });
    expect(await one.ctx.store.currentMatchId(a.sessionId)).toBeNull();
  });

  it('tells the partner exactly what a skip would have (security §32)', async () => {
    const a = await connect(one);
    const b = await connect(two);
    const heard = await listen(two, b.sessionId);
    try {
      await two.lifecycle.joinQueue(b.sessionId);
      const matched = await one.lifecycle.joinQueue(a.sessionId);
      if (matched.kind !== 'matched') throw new Error('expected a match');
      await delay(60);
      heard.events.length = 0;

      await one.lifecycle.leaveChat(a.sessionId);
      await delay(60);
      expect(heard.events).toEqual([{ event: 'partner_skipped', matchId: matched.matchId }]);
    } finally {
      heard.stop();
    }
  });

  it('stops a search when there is no conversation to leave', async () => {
    const a = await connect(one);
    await one.lifecycle.joinQueue(a.sessionId);
    expect(await one.ctx.store.queueDepth(one.ctx.segment)).toBe(1);

    expect(await one.lifecycle.leaveChat(a.sessionId)).toEqual({ kind: 'left' });
    expect(await one.ctx.store.queueDepth(one.ctx.segment)).toBe(0);
    expect((await one.ctx.store.readSession(a.sessionId))?.state).toBe('IDLE');
  });

  it('is idempotent — leaving twice converges instead of erroring', async () => {
    const a = await connect(one);
    const b = await connect(two);
    await two.lifecycle.joinQueue(b.sessionId);
    await one.lifecycle.joinQueue(a.sessionId);

    await one.lifecycle.leaveChat(a.sessionId);
    expect(await one.lifecycle.leaveChat(a.sessionId)).toEqual({ kind: 'idle' });
    expect((await one.ctx.store.readSession(a.sessionId))?.state).toBe('IDLE');
  });
});

describe('disconnect across two instances (§13)', () => {
  it('holds the seat and tells the survivor someone is reconnecting (§28)', async () => {
    const a = await connect(one);
    const b = await connect(two);
    const heard = await listen(two, b.sessionId);
    try {
      await two.lifecycle.joinQueue(b.sessionId);
      const matched = await one.lifecycle.joinQueue(a.sessionId);
      if (matched.kind !== 'matched') throw new Error('expected a match');
      await delay(60);
      heard.events.length = 0;

      const closed = await one.lifecycle.close(a.sessionId, a.ipHash, a.socket);
      await delay(60);

      // The conversation is not ended: the seat is held for the grace window.
      expect(closed).toEqual({ endedMatchId: null });
      expect(heard.events).toHaveLength(1);
      expect(heard.events[0]).toMatchObject({
        event: 'partner_reconnecting',
        matchId: matched.matchId,
      });
      // Told "reconnecting", a person waits. Told "they left", they move on —
      // which is why this is a different event and not a reworded one.
      expect(await two.ctx.store.currentMatchId(b.sessionId)).toBe(matched.matchId);
    } finally {
      heard.stop();
    }
  });

  it('is idempotent and notifies the survivor only once', async () => {
    // Resumption off, so this is the teardown path: the close and error
    // handlers both run, and the survivor must be told exactly once.
    const offCtx = await createTestContext({
      REDIS_KEY_PREFIX: one.ctx.config.redis.keyPrefix,
      RESUME_GRACE_SECONDS: '0',
    });
    const off = instanceFor(offCtx);
    try {
      const a = await connect(off);
      const b = await connect(off);
      await off.lifecycle.joinQueue(a.sessionId);
      const matched = await off.lifecycle.joinQueue(b.sessionId);
      if (matched.kind !== 'matched') throw new Error('expected a match');

      const first = await off.lifecycle.close(b.sessionId, b.ipHash, b.socket);
      const second = await off.lifecycle.close(b.sessionId, b.ipHash, b.socket);
      expect(first.endedMatchId).toBe(matched.matchId);
      expect(second.endedMatchId).toBeNull();
      expect(a.socket.parsed().filter((f) => f.type === 'partner_disconnected')).toHaveLength(1);
    } finally {
      off.registry.clear();
      await offCtx.close();
    }
  });

  it('releases the connection slot and dequeues a searching session', async () => {
    const a = await connect(one);
    await one.lifecycle.joinQueue(a.sessionId);

    await one.lifecycle.close(a.sessionId, a.ipHash, a.socket);
    expect(await one.ctx.client.exists(one.ctx.keys.connSessions(a.ipHash))).toBe(0);
    expect(await one.ctx.store.queueDepth(one.ctx.segment)).toBe(0);
  });

  it('lets a disconnect and a match race without stranding either side', async () => {
    for (let round = 0; round < 8; round += 1) {
      const a = await connect(one);
      const b = await connect(two);
      await two.lifecycle.joinQueue(b.sessionId);

      const [matched] = await Promise.all([
        one.lifecycle.joinQueue(a.sessionId),
        two.lifecycle.close(b.sessionId, b.ipHash, b.socket),
      ]);

      // Whichever won, nobody is left pointing at a partner that is gone.
      if (matched.kind === 'matched') {
        await one.lifecycle.close(a.sessionId, a.ipHash, a.socket);
      }
      expect(await one.ctx.store.currentMatchId(a.sessionId)).toBeNull();
      expect(await two.ctx.store.currentMatchId(b.sessionId)).toBeNull();
      await one.ctx.flush();
    }
  });
});

describe('heartbeat', () => {
  it('keeps a live session and its match alive', async () => {
    const a = await connect(one);
    const b = await connect(one);
    await one.lifecycle.joinQueue(a.sessionId);
    const matched = await one.lifecycle.joinQueue(b.sessionId);
    if (matched.kind !== 'matched') throw new Error('expected a match');

    await one.ctx.client.expire(one.ctx.keys.session(a.sessionId), 5);
    expect(await one.lifecycle.heartbeat(a.sessionId)).toEqual({
      kind: 'ok',
      matchId: matched.matchId,
    });
    expect(await one.ctx.client.ttl(one.ctx.keys.session(a.sessionId))).toBeGreaterThan(5);
  });

  it('reports a session Redis has forgotten', async () => {
    const a = await connect(one);
    await one.ctx.flush();
    expect(await one.lifecycle.heartbeat(a.sessionId)).toEqual({ kind: 'session_gone' });
  });
});
