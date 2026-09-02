/**
 * Lifecycle behaviour against an in-memory store.
 *
 * These tests assert on the state the lifecycle left behind and the frames the
 * peer received, not on which store methods were called — the point is what
 * happened, not how.
 */
import { FakeConnection, FakePublisher, FakeStore, silentLogger } from '../helpers/fakes';
import { loadConfig, type Config, type Env } from '../../src/config';
import { EventDispatcher } from '../../src/ws/dispatch';
import { SessionLifecycle } from '../../src/ws/lifecycle';
import { NullRetentionSink } from '../../src/storage/sink';
import { EMPTY_PROFILE } from '../../src/protocol/types';
import { ConnectionRegistry } from '../../src/ws/registry';

function buildConfig(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_one',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

function build(overrides: Env = {}) {
  const logger = silentLogger();
  const config = buildConfig(overrides);
  const store = new FakeStore();
  const registry = new ConnectionRegistry(logger);
  const publisher = new FakePublisher();
  const dispatcher = new EventDispatcher(registry, publisher, logger);
  const lifecycle = new SessionLifecycle(store, dispatcher, registry, config, logger, new NullRetentionSink());
  return { logger, config, store, registry, publisher, dispatcher, lifecycle };
}

/** Attach a socket for a session so its events are delivered locally. */
function attach(
  ctx: ReturnType<typeof build>,
  sessionId: string,
): FakeConnection {
  const connection = new FakeConnection(sessionId);
  ctx.registry.add(connection);
  return connection;
}

describe('open', () => {
  it('creates a session and claims a connection slot', async () => {
    const ctx = build();
    const result = await ctx.lifecycle.open('ip-a', 'client-a');

    expect(result.kind).toBe('opened');
    if (result.kind !== 'opened') return;
    expect(ctx.store.sessions.get(result.sessionId)).toMatchObject({
      state: 'IDLE',
      ipHash: 'ip-a',
      clientHash: 'client-a',
      instanceId: 'i_one',
    });
    expect(ctx.store.connSlots.get('ip-a')?.has(result.sessionId)).toBe(true);
  });

  it('refuses when the connection attempt rate is exhausted', async () => {
    const ctx = build();
    ctx.store.connectionRateAllowed = false;

    expect(await ctx.lifecycle.open('ip-a', 'client-a')).toEqual({
      kind: 'rate_limited',
      retryAfterSeconds: 42,
    });
    // Nothing was created: the attempt never became a session.
    expect(ctx.store.sessions.size).toBe(0);
  });

  it('rolls the session back when the concurrency cap refuses the slot', async () => {
    const ctx = build();
    ctx.store.connectionSlotAllowed = false;
    ctx.store.connectionSlotCount = 40;

    expect(await ctx.lifecycle.open('ip-a', 'client-a')).toEqual({
      kind: 'too_many_connections',
      count: 40,
    });
    // A leaked row would be a matchable ghost until its TTL expired.
    expect(ctx.store.sessions.size).toBe(0);
  });
});

describe('joinQueue', () => {
  it('queues a lone user and reports the depth', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });

    expect(await ctx.lifecycle.joinQueue('s_a')).toEqual({ kind: 'searching', waiting: 1 });
    expect(ctx.store.sessions.get('s_a')?.state).toBe('SEARCHING');
  });

  it('pairs two searchers and gives each side distinguishable identities', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    await ctx.lifecycle.joinQueue('s_a');

    const result = await ctx.lifecycle.joinQueue('s_b');
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.partnerSessionId).toBe('s_a');
    expect(result.you.nickname).not.toBe(result.partner.nickname);
    expect(result.you.colour).not.toBe(result.partner.colour);
  });

  it('shows the same nickname to every stranger a session meets', async () => {
    /*
     * The reason the nickname moved onto the session hash. A name redrawn per
     * match made somebody unrecognisable in Recent, and unrecognisable across a
     * skip that paired the same two people again.
     *
     * Asserted from the *partner's* side of two separate matches, because that
     * is where it is visible: what one session shows to the strangers it meets.
     */
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedSession({ sessionId: 's_c' });
    ctx.store.nicknames.set('s_a', 'Gentle Otter');

    await ctx.lifecycle.joinQueue('s_a');
    const first = await ctx.lifecycle.joinQueue('s_b');
    expect(first.kind).toBe('matched');
    if (first.kind !== 'matched') return;
    expect(first.partner.nickname).toBe('Gentle Otter');

    // Skipped by `s_a`, so `s_a` searches again and `s_b` is left idle. The
    // other way round leaves both searching and they simply re-pair with each
    // other, which is a match but not a second stranger.
    await ctx.lifecycle.skip('s_a');
    const second = await ctx.lifecycle.joinQueue('s_c');
    expect(second.kind).toBe('matched');
    if (second.kind !== 'matched') return;
    expect(second.partner.nickname).toBe('Gentle Otter');
  });

  it('keeps the waiting name and redraws the arriving one on a collision', async () => {
    // Both sessions drew the same name independently. The one already using it
    // with other people keeps it; the newcomer changes for this match only.
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.nicknames.set('s_a', 'Gentle Otter');
    ctx.store.nicknames.set('s_b', 'Gentle Otter');

    await ctx.lifecycle.joinQueue('s_a');
    const result = await ctx.lifecycle.joinQueue('s_b');
    expect(result.kind).toBe('matched');
    if (result.kind !== 'matched') return;
    expect(result.partner.nickname).toBe('Gentle Otter');
    expect(result.you.nickname).not.toBe('Gentle Otter');
    // Never written back: a stranger colliding with somebody must not be able
    // to change the name they use with everybody else.
    expect(ctx.store.nicknames.get('s_b')).toBe('Gentle Otter');
  });

  it('tells the partner, with the identities swapped', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    const partnerSocket = attach(ctx, 's_a');
    await ctx.lifecycle.joinQueue('s_a');

    const result = await ctx.lifecycle.joinQueue('s_b');
    if (result.kind !== 'matched') throw new Error('expected a match');

    const frame = partnerSocket.parsed()[0];
    expect(frame?.type).toBe('matched');
    // What the winner calls "partner" is what the peer must call "you".
    expect(frame?.payload).toMatchObject({
      matchId: result.matchId,
      startedAt: result.startedAt,
      you: result.partner,
      partner: result.you,
    });
  });

  it('reports which route the partner notification took', async () => {
    const local = build();
    local.store.seedSession({ sessionId: 's_a' });
    local.store.seedSession({ sessionId: 's_b' });
    attach(local, 's_a');
    await local.lifecycle.joinQueue('s_a');
    const localResult = await local.lifecycle.joinQueue('s_b');
    expect(localResult.kind === 'matched' && localResult.partnerRoute).toBe('local');

    const remote = build();
    remote.store.seedSession({ sessionId: 's_a' });
    remote.store.seedSession({ sessionId: 's_b' });
    remote.publisher.subscribed.add('s_a');
    await remote.lifecycle.joinQueue('s_a');
    const remoteResult = await remote.lifecycle.joinQueue('s_b');
    expect(remoteResult.kind === 'matched' && remoteResult.partnerRoute).toBe('remote');
  });

  it('still reports the match when the partner could not be notified', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    await ctx.lifecycle.joinQueue('s_a');
    ctx.publisher.failNextPublish = true;

    const result = await ctx.lifecycle.joinQueue('s_b');
    // The match is committed in Redis. Rolling it back because a notification
    // failed would turn a cosmetic failure into a real one.
    expect(result.kind).toBe('matched');
    expect(result.kind === 'matched' && result.partnerRoute).toBe('dropped');
    expect(ctx.store.matches.size).toBe(1);
  });

  it('is idempotent while already searching', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    await ctx.lifecycle.joinQueue('s_a');
    expect(await ctx.lifecycle.joinQueue('s_a')).toEqual({ kind: 'searching', waiting: 1 });
    expect(ctx.store.queue.size).toBe(1);
  });

  it('reports a vanished session', async () => {
    const ctx = build();
    expect(await ctx.lifecycle.joinQueue('s_missing')).toEqual({ kind: 'session_gone' });
  });

  it('says nothing to send when a peer matched us first (§10.1)', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');

    // The matched frame is already inbound from the instance that won.
    expect(await ctx.lifecycle.joinQueue('s_a')).toEqual({ kind: 'matched_elsewhere' });
  });
});

describe('search retries', () => {
  it('does not retry when the queue was genuinely empty', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    await ctx.lifecycle.joinQueue('s_a');
    // Resampling an empty set finds the same nothing.
    expect(ctx.store.tryMatchCalls).toHaveLength(1);
  });

  it('retries when the attempt cleaned stale entries out of its sample', async () => {
    const ctx = build({ MATCH_RETRY_ATTEMPTS: '3' });
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.nextWaitingCleaned = 2;

    await ctx.lifecycle.joinQueue('s_a');
    // A fresh random sample can contain someone the polluted one did not (D3).
    expect(ctx.store.tryMatchCalls).toHaveLength(3);
  });

  it('retries when candidates were skipped for a block', async () => {
    const ctx = build({ MATCH_RETRY_ATTEMPTS: '2' });
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.nextWaitingBlockedSkipped = 1;

    await ctx.lifecycle.joinQueue('s_a');
    expect(ctx.store.tryMatchCalls).toHaveLength(2);
  });

  it('uses a fresh match id per attempt', async () => {
    const ctx = build({ MATCH_RETRY_ATTEMPTS: '3' });
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.nextWaitingCleaned = 1;

    await ctx.lifecycle.joinQueue('s_a');
    expect(new Set(ctx.store.tryMatchCalls).size).toBe(ctx.store.tryMatchCalls.length);
  });
});

describe('leaveQueue', () => {
  it('returns a searcher to idle', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    await ctx.lifecycle.joinQueue('s_a');

    expect(await ctx.lifecycle.leaveQueue('s_a')).toEqual({ kind: 'idle' });
    expect(ctx.store.queue.size).toBe(0);
  });

  it('is idempotent', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    expect(await ctx.lifecycle.leaveQueue('s_a')).toEqual({ kind: 'idle' });
    expect(await ctx.lifecycle.leaveQueue('s_a')).toEqual({ kind: 'idle' });
  });

  it('refuses for a matched session', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');

    expect(await ctx.lifecycle.leaveQueue('s_a')).toEqual({
      kind: 'already_matched',
      matchId: 'm_1',
    });
  });
});

describe('skip', () => {
  it('ends the match, tells the partner, and searches again (§12)', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');
    const partnerSocket = attach(ctx, 's_b');

    const result = await ctx.lifecycle.skip('s_a');
    expect(partnerSocket.parsed()).toEqual([
      expect.objectContaining({ type: 'partner_skipped', payload: { matchId: 'm_1' } }),
    ]);
    expect(ctx.store.matches.size).toBe(0);
    expect(result).toEqual({ kind: 'searching', waiting: 1 });
    expect(ctx.store.sessions.get('s_a')?.state).toBe('SEARCHING');
  });

  it('leaves the partner idle rather than re-queueing them for us', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');

    await ctx.lifecycle.skip('s_a');
    // The skipped user decides for themselves whether to keep looking.
    expect(ctx.store.sessions.get('s_b')?.state).toBe('IDLE');
    expect(ctx.store.queue.has('s_b')).toBe(false);
  });

  it('can re-pair immediately with a waiting stranger', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedSession({ sessionId: 's_c' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');
    await ctx.lifecycle.joinQueue('s_c');

    const result = await ctx.lifecycle.skip('s_a');
    expect(result).toMatchObject({ kind: 'matched', partnerSessionId: 's_c' });
  });

  it('is a no-op that reports state when there is no match (§5)', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_idle' });
    expect(await ctx.lifecycle.skip('s_idle')).toEqual({ kind: 'idle' });

    ctx.store.seedSession({ sessionId: 's_searching' });
    await ctx.lifecycle.joinQueue('s_searching');
    // An impatient double-tap must not become a visible failure.
    expect(await ctx.lifecycle.skip('s_searching')).toEqual({ kind: 'searching', waiting: 1 });
  });

  it('converges when both sides skip at the same instant (§10.7)', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');
    const aSocket = attach(ctx, 's_a');
    const bSocket = attach(ctx, 's_b');

    await Promise.all([ctx.lifecycle.skip('s_a'), ctx.lifecycle.skip('s_b')]);

    // Exactly one side ended the match, so exactly one notification exists.
    // Both sides telling the peer would end the conversation twice.
    const notifications = [...aSocket.parsed(), ...bSocket.parsed()].filter(
      (frame) => frame.type === 'partner_skipped',
    );
    expect(notifications).toHaveLength(1);
    // The original match is gone. Both then re-queued and were free to pair
    // with each other again — deliberate (§12.6): a cooldown list is not the
    // MVP remedy, blocking is.
    expect(ctx.store.matches.has('m_1')).toBe(false);
    for (const sid of ['s_a', 's_b']) {
      expect(ctx.store.sessions.get(sid)?.matchId).not.toBe('m_1');
    }
  });

  it('reports a vanished session', async () => {
    const ctx = build();
    expect(await ctx.lifecycle.skip('s_missing')).toEqual({ kind: 'session_gone' });
  });
});

describe('block', () => {
  it('records the block, ends the match and leaves the blocker idle', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a', ipHash: 'ip-a', clientHash: 'cl-a' });
    ctx.store.seedSession({ sessionId: 's_b', ipHash: 'ip-b', clientHash: 'cl-b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');

    expect(await ctx.lifecycle.block('s_a', { ipHash: 'ip-s_a', clientHash: 'cl-s_a' })).toEqual({
      kind: 'blocked',
      matchId: 'm_1',
      recorded: 2,
    });
    expect(ctx.store.blockedBy('ip-a')).toEqual(['ip-b']);
    expect(ctx.store.blockedBy('cl-a')).toEqual(['cl-b']);
    // Not re-queued: someone who just blocked a stranger has said something
    // about wanting to stop.
    expect(ctx.store.sessions.get('s_a')?.state).toBe('IDLE');
    expect(ctx.store.queue.has('s_a')).toBe(false);
  });

  it('tells the blocked user it was a skip, and nothing more (security §32)', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');
    const blockedSocket = attach(ctx, 's_b');

    await ctx.lifecycle.block('s_a', { ipHash: 'ip-s_a', clientHash: 'cl-s_a' });
    const frames = blockedSocket.parsed();
    // A distinct signal would tell an abuser which behaviour got them blocked.
    expect(frames).toEqual([
      expect.objectContaining({ type: 'partner_skipped', payload: { matchId: 'm_1' } }),
    ]);
    expect(JSON.stringify(frames)).not.toContain('block');
  });

  it('refuses when there is no partner to block', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    expect(await ctx.lifecycle.block('s_a', { ipHash: 'ip-s_a', clientHash: 'cl-s_a' })).toEqual({ kind: 'not_matched' });
  });
});

describe('close (§13)', () => {
  it('removes the session, ends its match and tells the survivor', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');
    const connection = attach(ctx, 's_a');
    const survivorSocket = attach(ctx, 's_b');

    const result = await ctx.lifecycle.close('s_a', 'ip-s_a', connection);
    expect(result).toEqual({ endedMatchId: 'm_1' });
    expect(survivorSocket.parsed()).toEqual([
      expect.objectContaining({ type: 'partner_disconnected', payload: { matchId: 'm_1' } }),
    ]);
    expect(ctx.store.sessions.has('s_a')).toBe(false);
    expect(ctx.registry.has('s_a')).toBe(false);
    expect(ctx.store.sessions.get('s_b')?.state).toBe('IDLE');
  });

  it('is safe to run twice, from both the close and the error handler', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');
    const survivorSocket = attach(ctx, 's_b');

    const first = await ctx.lifecycle.close('s_a', 'ip-s_a');
    const second = await ctx.lifecycle.close('s_a', 'ip-s_a');
    expect(first).toEqual({ endedMatchId: 'm_1' });
    expect(second).toEqual({ endedMatchId: null });
    // The survivor is told once, not once per handler.
    expect(survivorSocket.parsed()).toHaveLength(1);
  });

  it('releases the connection slot', async () => {
    const ctx = build();
    const opened = await ctx.lifecycle.open('ip-a', 'client-a');
    if (opened.kind !== 'opened') throw new Error('expected an opened session');

    await ctx.lifecycle.close(opened.sessionId, 'ip-a');
    expect(ctx.store.connSlots.get('ip-a')?.size ?? 0).toBe(0);
  });

  it('cleans up a session whose row already expired', async () => {
    const ctx = build();
    expect(await ctx.lifecycle.close('s_gone', 'ip-x')).toEqual({ endedMatchId: null });
  });

  it('does not evict the connection that replaced this one', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    const stale = new FakeConnection('s_a');
    ctx.registry.add(stale);
    const current = new FakeConnection('s_a');
    ctx.registry.add(current);

    await ctx.lifecycle.close('s_a', 'ip-a', stale);
    expect(ctx.registry.get('s_a')).toBe(current);
  });
});

describe('heartbeat', () => {
  it('reports the current match', async () => {
    const ctx = build();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });
    ctx.store.seedMatch('m_1', 's_a', 's_b');

    expect(await ctx.lifecycle.heartbeat('s_a')).toEqual({ kind: 'ok', matchId: 'm_1' });
  });

  it('reports a vanished session rather than recreating it', async () => {
    const ctx = build();
    expect(await ctx.lifecycle.heartbeat('s_missing')).toEqual({ kind: 'session_gone' });
    expect(ctx.store.sessions.size).toBe(0);
  });
});

/**
 * Who declares a gender, measured where it is not distorted (§29.6).
 *
 * `chat_queue_composition` answers "who is waiting", which is biased by how long
 * each group waits — a group that matches quickly is under-represented in any
 * snapshot, because they are not in the queue for long. This counter answers
 * "who arrives", and the gap between the two is the harm signal: arrivals at 15%
 * and a pool at 5% means that group is matching three times faster, which is
 * exactly what a gender preference would cause.
 */
describe('counting declared genders', () => {
  function buildObserved() {
    const logger = silentLogger();
    const config = buildConfig();
    const store = new FakeStore();
    const registry = new ConnectionRegistry(logger);
    const dispatcher = new EventDispatcher(registry, new FakePublisher(), logger);
    const declared: string[] = [];
    const limited: string[] = [];
    const intents: string[] = [];
    const scored: Array<{ score: number; widened: boolean; matched: boolean }> = [];
    let abandoned = 0;
    const lifecycle = new SessionLifecycle(
      store,
      dispatcher,
      registry,
      config,
      logger,
      new NullRetentionSink(),
      {
        attempt: () => {},
        aborted: () => {},
        conversationEnded: () => {},
        profileDeclared: (gender) => declared.push(gender),
        preferenceLimited: (reason) => limited.push(reason),
        intentDeclared: (intent) => intents.push(intent),
        preferenceScored: (score, widened, matched) => scored.push({ score, widened, matched }),
        searchAbandoned: () => {
          abandoned += 1;
        },
      },
    );
    return {
      store,
      lifecycle,
      declared,
      limited,
      intents,
      scored,
      abandoned: () => abandoned,
    };
  }

  it('writes the preference when the §29.4 limits allow it', async () => {
    const ctx = buildObserved();
    ctx.store.seedSession({ sessionId: 's_a' });

    await ctx.lifecycle.joinQueue('s_a', undefined, { genders: ['female'], countries: [] });

    expect(ctx.store.preferenceAllowanceCalls).toEqual(['s_a']);
    expect(ctx.store.preferences.get('s_a')).toEqual({ genders: ['female'], countries: [] });
    expect(ctx.limited).toEqual([]);
  });

  it.each(['cooldown', 'budget', 'no_session'] as const)(
    'drops the preference and still searches when the limit says %s',
    async (reason) => {
      /*
       * The whole of §29.4's "degrades, never refuses". The join must succeed
       * and the preference must simply not be written — `tryMatch` then scores
       * every candidate at zero and takes the longest-waiting one, which is
       * what a preference matching nobody already does (D44).
       *
       * Asserting the outcome is `searching` matters as much as the missing
       * preference: a limit that returned an error here would be visible to a
       * paying user as their search failing.
       */
      const ctx = buildObserved();
      ctx.store.seedSession({ sessionId: 's_a' });
      ctx.store.preferenceAllowanceResult = { granted: false, reason };

      const outcome = await ctx.lifecycle.joinQueue('s_a', undefined, {
        genders: ['female'],
        countries: [],
      });

      expect(outcome.kind).toBe('searching');
      expect(ctx.store.preferences.has('s_a')).toBe(false);
      expect(ctx.limited).toEqual([reason]);
    },
  );

  it('does not spend a token on a search that declared no preference', async () => {
    // A free user must not be able to exhaust a budget belonging to a feature
    // they do not have, and every ordinary search would otherwise consume one.
    const ctx = buildObserved();
    ctx.store.seedSession({ sessionId: 's_a' });

    await ctx.lifecycle.joinQueue('s_a');

    expect(ctx.store.preferenceAllowanceCalls).toEqual([]);
  });

  it('records the declared gender, and "none" for declining it', async () => {
    const ctx = buildObserved();
    ctx.store.seedSession({ sessionId: 's_a' });
    ctx.store.seedSession({ sessionId: 's_b' });

    await ctx.lifecycle.joinQueue('s_a', { ...EMPTY_PROFILE, gender: 'female' });
    await ctx.lifecycle.joinQueue('s_b', { ...EMPTY_PROFILE, name: 'sam' });

    // Declining is a data point, not a gap: it is the share of the pool no
    // preference can ever match, and the number that decides whether preference
    // matching is worth enabling at all.
    expect(ctx.declared).toEqual(['female', 'none']);
  });

  it('does not count an internal re-search as a fresh declaration', async () => {
    // A skip re-enters the queue carrying no profile, because nothing about the
    // declaration changed. Counting those would measure how often people skip —
    // weighting the heaviest skippers highest — rather than how often people
    // declare.
    const ctx = buildObserved();
    ctx.store.seedSession({ sessionId: 's_a' });

    await ctx.lifecycle.joinQueue('s_a', { ...EMPTY_PROFILE, gender: 'male' });
    await ctx.lifecycle.joinQueue('s_a');
    await ctx.lifecycle.joinQueue('s_a');

    expect(ctx.declared).toEqual(['male']);
  });
});
