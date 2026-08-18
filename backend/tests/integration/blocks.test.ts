/**
 * Blocks (D18) and the matchmaking filter that enforces them (I12).
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

beforeAll(async () => {
  ctx = await createTestContext();
});

afterEach(async () => {
  await ctx.flush();
});

afterAll(async () => {
  await ctx.close();
});

describe('addBlock', () => {
  it('records both dimensions, one direction', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');

    expect(await ctx.store.addBlock(alice, mallory)).toBe(2);
    expect(await ctx.client.sismember(ctx.keys.blocks(alice.ipHash), mallory.ipHash)).toBe(1);
    expect(await ctx.client.sismember(ctx.keys.blocks(alice.clientHash), mallory.clientHash)).toBe(1);
    // Only one direction is stored. Writing the reverse too would be a second
    // record of an event the blocked user must not be able to observe.
    expect(await ctx.client.exists(ctx.keys.blocks(mallory.ipHash))).toBe(0);
  });

  it('is idempotent', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    expect(await ctx.store.addBlock(alice, mallory)).toBe(2);
    expect(await ctx.store.addBlock(alice, mallory)).toBe(0);
    expect(await ctx.client.scard(ctx.keys.blocks(alice.ipHash))).toBe(1);
  });

  it('gives blocks a TTL, so they do not accumulate forever', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await ctx.store.addBlock(alice, mallory);
    const ttl = await ctx.client.ttl(ctx.keys.blocks(alice.ipHash));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.blocks.ttlSeconds);
  });

  it('honours a disabled dimension', async () => {
    const clientOnly = await createTestContext({ BLOCK_DIMENSION_IP_ENABLED: 'false' });
    try {
      const alice = await party(clientOnly, 'alice');
      const mallory = await party(clientOnly, 'mallory');
      expect(await clientOnly.store.addBlock(alice, mallory)).toBe(1);
      // The IP dimension catches bystanders behind CGNAT, so an operator must
      // be able to turn it off without turning blocking off.
      expect(await clientOnly.client.exists(clientOnly.keys.blocks(alice.ipHash))).toBe(0);
      expect(
        await clientOnly.client.sismember(clientOnly.keys.blocks(alice.clientHash), mallory.clientHash),
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
    await ctx.store.addBlock(alice, mallory);

    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    const result = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(result).toMatchObject({ status: 'waiting', blockedSkipped: 1 });
  });

  it('refuses the pair in the blocked → blocker direction too', async () => {
    const alice = await party(ctx, 'alice');
    const mallory = await party(ctx, 'mallory');
    await ctx.store.addBlock(alice, mallory);

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
    await ctx.store.addBlock(alice, mallory);

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
    await ctx.store.addBlock(alice, mallory);

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
    await ctx.store.addBlock(alice, mallory);

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
    await ctx.store.addBlock(alice, mallory);

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
      await ipOnly.store.addBlock(alice, mallory);

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
    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    const mid = newMatchId();
    await ctx.store.tryMatch(alice.sessionId, ctx.segment, mid);

    await ctx.store.addBlock(alice, mallory);
    // Blocks are a matching filter, not an undo: the current match stands
    // until someone ends it, and the UI must not promise otherwise.
    expect(await ctx.store.readMatch(mid)).not.toBeNull();

    await ctx.store.endMatch(mid);
    await enqueue(ctx, mallory.sessionId);
    await enqueue(ctx, alice.sessionId);
    const again = await ctx.store.tryMatch(alice.sessionId, ctx.segment, newMatchId());
    expect(again.status).toBe('waiting');
  });
});
