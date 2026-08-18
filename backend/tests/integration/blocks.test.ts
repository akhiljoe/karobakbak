/**
 * Blocks (D18) and the matchmaking filter that enforces them (I12).
 *
 * A block is only reachable from inside a match, so every test here forms one
 * first. That is deliberate: the script resolves the partner, records the block
 * and ends the match in one atomic step, and testing it any other way would be
 * testing a path the product does not have.
 */
import { createTestContext, enqueue, fakeHash, type TestContext } from '../helpers/redis';
import { newMatchId } from '../../src/util/ids';

let ctx: TestContext;

interface Party {
  sessionId: string;
  ipHash: string;
  clientHash: string;
}

async function party(context: TestContext, name: string): Promise<Party> {
  const ipHash = fakeHash(`ip${name}`);
  const clientHash = fakeHash(`cl${name}`);
  const sessionId = await context.session({ ipHash, clientHash });
  return { sessionId, ipHash, clientHash };
}

/** Pair two parties, then have the first block the second. */
async function matchThenBlock(
  context: TestContext,
  blocker: Party,
  blocked: Party,
): Promise<{ matchId: string; recorded: number }> {
  await enqueue(context, blocked.sessionId);
  await enqueue(context, blocker.sessionId);
  const matched = await context.store.tryMatch(blocker.sessionId, context.segment, newMatchId());
  if (matched.status !== 'matched') throw new Error(`expected a match, got ${matched.status}`);

  const result = await context.store.blockPartner(blocker.sessionId);
  if (result.status !== 'blocked') throw new Error(`expected a block, got ${result.status}`);
  return { matchId: result.matchId, recorded: result.recorded };
}

beforeAll(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.flush();
});

afterAll(async () => {
  await ctx.close();
});

describe('blockPartner', () => {
  it('records both dimensions, in one direction only', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    const { recorded } = await matchThenBlock(ctx, alice, mallory);

    expect(recorded).toBe(2);
    expect(await ctx.client.sismember(ctx.keys.blocks(alice.ipHash), mallory.ipHash)).toBe(1);
    expect(await ctx.client.sismember(ctx.keys.blocks(alice.clientHash), mallory.clientHash)).toBe(1);
    // Nothing is written under the blocked user's key. A record there is a
    // record they could observe, and a block must be invisible to its target.
    expect(await ctx.client.exists(ctx.keys.blocks(mallory.ipHash))).toBe(0);
    expect(await ctx.client.exists(ctx.keys.blocks(mallory.clientHash))).toBe(0);
  });

  it('ends the match and returns both sides to IDLE', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    const { matchId } = await matchThenBlock(ctx, alice, mallory);

    expect(await ctx.store.readMatch(matchId)).toBeNull();
    for (const sid of [alice.sessionId, mallory.sessionId]) {
      expect(await ctx.store.currentMatchId(sid)).toBeNull();
      expect((await ctx.store.readSession(sid))?.state).toBe('IDLE');
    }
  });

  it('resolves the partner itself, so nothing can change under it', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    const result = await (async () => {
      await enqueue(ctx, mallory.sessionId);
      await enqueue(ctx, alice.sessionId);
      await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
      return ctx.store.blockPartner(alice.sessionId);
    })();

    // The caller never names who to block. Resolving and recording in two round
    // trips would leave a window where the match ends and another begins in
    // between, and the user blocks someone they never spoke to.
    expect(result).toMatchObject({ status: 'blocked', partnerSessionId: mallory.sessionId });
  });

  it('refuses when there is no match to block', async () => {
    const lonely = await party(ctx, 'lonely');
    expect(await ctx.store.blockPartner(lonely.sessionId)).toEqual({ status: 'not_matched' });
  });

  it('refuses when the match record is gone (I6)', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    const mid = newMatchId();
    await ctx.store.tryMatch(alice.sessionId, ctx.segment, mid);
    await ctx.client.del(ctx.keys.match(mid));

    expect(await ctx.store.blockPartner(alice.sessionId)).toEqual({ status: 'not_matched' });
  });

  it('reports recording nothing when the partner session has already expired', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    await ctx.client.del(ctx.keys.session(mallory.sessionId));

    const result = await ctx.store.blockPartner(alice.sessionId);
    // The hashes to record are gone with the row. The match still ends, but
    // the caller must not be told a block was stored when none was.
    expect(result).toMatchObject({ status: 'blocked', recorded: 0 });
    expect(await ctx.client.exists(ctx.keys.blocks(alice.ipHash))).toBe(0);
  });

  it('names exactly one ender when both sides act at the same instant (D6)', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    const mid = newMatchId();
    await ctx.store.tryMatch(alice.sessionId, ctx.segment, mid);

    const [block, end] = await Promise.all([
      ctx.store.blockPartner(alice.sessionId),
      ctx.store.endMatch(mid),
    ]);
    const enders = [
      block.status === 'blocked' && block.endedByUs,
      end.status === 'ended',
    ].filter(Boolean);
    expect(enders).toHaveLength(1);
  });

  it('is idempotent in effect: a second block finds no match', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await matchThenBlock(ctx, alice, mallory);
    expect(await ctx.store.blockPartner(alice.sessionId)).toEqual({ status: 'not_matched' });
    expect(await ctx.client.scard(ctx.keys.blocks(alice.ipHash))).toBe(1);
  });

  it('gives blocks a TTL, so they do not accumulate forever', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await matchThenBlock(ctx, alice, mallory);

    const ttl = await ctx.client.ttl(ctx.keys.blocks(alice.ipHash));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.blocks.ttlSeconds);
  });

  it('honours a disabled dimension', async () => {
    const clientOnly = await createTestContext({ BLOCK_DIMENSION_IP_ENABLED: 'false' });
    try {
      const alice = await party(clientOnly, 'alice');
      const mallory = await party(clientOnly, 'mallory');
      const { recorded } = await matchThenBlock(clientOnly, alice, mallory);

      expect(recorded).toBe(1);
      // The IP dimension catches bystanders behind CGNAT, so an operator must
      // be able to turn it off without turning blocking off.
      expect(await clientOnly.client.exists(clientOnly.keys.blocks(alice.ipHash))).toBe(0);
      expect(
        await clientOnly.client.sismember(
          clientOnly.keys.blocks(alice.clientHash),
          mallory.clientHash,
        ),
      ).toBe(1);
    } finally {
      await clientOnly.close();
    }
  });
});

describe('tryMatch honours blocks (I12)', () => {
  it('refuses the pair in the blocker → blocked direction', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await matchThenBlock(ctx, alice, mallory);

    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    const result = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', blockedSkipped: 1 });
  });

  it('refuses the pair in the blocked → blocker direction too', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await matchThenBlock(ctx, alice, mallory);

    // Mallory is the one searching this time. A one-directional check would
    // pair them and make the block useless the moment the blocker waits.
    await enqueue(ctx, alice.sessionId);
    await enqueue(ctx, mallory.sessionId);
    const result = await ctx.store.tryMatch(mallory.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', blockedSkipped: 1 });
  });

  it('leaves the blocked candidate queued and matchable by everyone else', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    const bob = await party(ctx, 'bob');
    await matchThenBlock(ctx, alice, mallory);

    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    // The block is relative to Alice only: removing Mallory from the queue
    // would let one user quietly deny service to everyone.
    expect(await ctx.client.sismember(ctx.keys.queue(ctx.segment), mallory.sessionId)).toBe(1);

    await enqueue(ctx, bob.sessionId);
    const result = await ctx.store.tryMatch(bob.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'matched' });
  });

  it('matches an unblocked candidate in the same sweep as a blocked one', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    const bob = await party(ctx, 'bob');
    await matchThenBlock(ctx, alice, mallory);

    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, bob.sessionId);
    await enqueue(ctx, alice.sessionId);

    const result = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({
      status: 'matched',
      partnerSessionId: bob.sessionId,
      blockedSkipped: 1,
    });
  });

  it('blocks on the client dimension even when the IP moved', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await matchThenBlock(ctx, alice, mallory);

    // Same browser token, different network: the precise dimension still holds.
    const roaming = await ctx.session({
      ipHash: fakeHash('newnetwork'),
      clientHash: mallory.clientHash,
    });
    await enqueue(ctx, roaming);
    await enqueue(ctx, alice.sessionId);
    const result = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', blockedSkipped: 1 });
  });

  it('blocks on the IP dimension even when the client token rotated', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await matchThenBlock(ctx, alice, mallory);

    const rotated = await ctx.session({
      ipHash: mallory.ipHash,
      clientHash: fakeHash('freshtoken'),
    });
    await enqueue(ctx, rotated);
    await enqueue(ctx, alice.sessionId);
    const result = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', blockedSkipped: 1 });
  });

  it('stops filtering on a dimension that is disabled', async () => {
    const ipOnly = await createTestContext({ BLOCK_DIMENSION_CLIENT_ENABLED: 'false' });
    try {
      const alice = await party(ipOnly, 'alice');
      const mallory = await party(ipOnly, 'mallory');
      await matchThenBlock(ipOnly, alice, mallory);

      const roaming = await ipOnly.session({
        ipHash: fakeHash('newnetwork'),
        clientHash: mallory.clientHash,
      });
      await enqueue(ipOnly, roaming);
      await enqueue(ipOnly, alice.sessionId);
      const result = await ipOnly.store.tryMatch(alice.sessionId, ipOnly.segment, newMatchId());
      // Documented consequence of turning a dimension off, asserted rather
      // than assumed.
      expect(result).toMatchObject({ status: 'matched', partnerSessionId: roaming });
    } finally {
      await ipOnly.close();
    }
  });

  it('applies from the next match onward, not retroactively (§10.16)', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    const bob = await party(ctx, 'bob');
    await matchThenBlock(ctx, alice, mallory);

    // A block already exists between alice and mallory. Alice now matches bob,
    // and blocking mallory again cannot reach into that conversation: blocks
    // are a matching filter, not an undo, and the UI must not promise otherwise.
    await enqueue(ctx, bob.sessionId);
    await enqueue(ctx, alice.sessionId);
    const second = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(second).toMatchObject({ status: 'matched', partnerSessionId: bob.sessionId });
    expect(await ctx.store.readMatch(second.status === 'matched' ? second.matchId : '')).not.toBeNull();
  });
});
