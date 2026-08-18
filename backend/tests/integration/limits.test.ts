/**
 * Rate limiting and connection limits (R7, R8, §17).
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

describe('token bucket', () => {
  it('allows a full burst and then refuses', async () => {
    const sid = await ctx.session();
    const burst = ctx.config.limits.rates.message.burst;
    for (let i = 0; i < burst; i += 1) {
      const result = await ctx.store.rateLimit('message', sid);
      expect(result.allowed).toBe(true);
    }
    const denied = await ctx.store.rateLimit('message', sid);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(0);
  });

  it('refills over real elapsed time, not in whole tokens', async () => {
    const fast = await createTestContext({ MESSAGE_RATE_PER_SEC: '10', MESSAGE_BURST: '10' });
    try {
      const sid = await fast.session();
      for (let i = 0; i < 10; i += 1) await fast.store.rateLimit('message', sid);
      expect((await fast.store.rateLimit('message', sid)).allowed).toBe(false);

      // A whole-number bucket would still be empty here; a fractional one has
      // earned back two tokens. Truncating the stored value is exactly the bug
      // that would make every configured limit stricter than it says.
      await delay(220);
      expect((await fast.store.rateLimit('message', sid)).allowed).toBe(true);
    } finally {
      await fast.close();
    }
  });

  it('never refills past the burst', async () => {
    const sid = await ctx.session();
    const burst = ctx.config.limits.rates.message.burst;
    // An hour of idle time, written straight into the bucket rather than
    // waited for. Without the clamp this bucket would be worth 18000 tokens.
    const [seconds] = await ctx.client.time();
    const longAgo = (Number(seconds) - 3600) * 1000;
    await ctx.client.hset(ctx.keys.rateLimit('message', sid), 't', '0', 'ts', String(longAgo));

    for (let i = 0; i < burst; i += 1) {
      expect((await ctx.store.rateLimit('message', sid)).allowed).toBe(true);
    }
    expect((await ctx.store.rateLimit('message', sid)).allowed).toBe(false);
  });

  it('treats a bucket timestamp from the future as no elapsed time, not as credit', async () => {
    const sid = await ctx.session();
    const [seconds] = await ctx.client.time();
    const future = (Number(seconds) + 3600) * 1000;
    await ctx.client.hset(ctx.keys.rateLimit('message', sid), 't', '0', 'ts', String(future));

    // Only reachable if Redis' own clock stepped backwards. Negative elapsed
    // time must not become negative spend.
    expect((await ctx.store.rateLimit('message', sid)).allowed).toBe(false);
  });

  it('keeps one bucket per command, so a cheap command cannot spend the message budget', async () => {
    const sid = await ctx.session();
    for (let i = 0; i < ctx.config.limits.rates.typing.burst; i += 1) {
      await ctx.store.rateLimit('typing', sid);
    }
    expect((await ctx.store.rateLimit('typing', sid)).allowed).toBe(false);
    // Security §12: the whole point of per-command buckets.
    expect((await ctx.store.rateLimit('message', sid)).allowed).toBe(true);
  });

  it('keeps one bucket per session', async () => {
    const noisy = await ctx.session();
    const quiet = await ctx.session();
    for (let i = 0; i < ctx.config.limits.rates.message.burst + 2; i += 1) {
      await ctx.store.rateLimit('message', noisy);
    }
    expect((await ctx.store.rateLimit('message', quiet)).allowed).toBe(true);
  });

  it('gives every bucket a TTL, so the limiter cannot grow without bound', async () => {
    const sid = await ctx.session();
    await ctx.store.rateLimit('report', sid);
    const ttl = await ctx.client.ttl(ctx.keys.rateLimit('report', sid));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(ctx.config.limits.rateLimitTtlSeconds);
  });

  it('enforces the hourly commands strictly', async () => {
    const sid = await ctx.session();
    // report: 3 burst, then ~6 minutes per token. A bucket that reset on TTL
    // expiry would turn this into "3 per RATE_LIMIT_TTL_SECONDS".
    for (let i = 0; i < ctx.config.limits.rates.report.burst; i += 1) {
      expect((await ctx.store.rateLimit('report', sid)).allowed).toBe(true);
    }
    const denied = await ctx.store.rateLimit('report', sid);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterMs).toBeGreaterThan(60_000);
  });

  it('charges a configurable cost', async () => {
    const sid = await ctx.session();
    const burst = ctx.config.limits.rates.message.burst;
    const bulk = await ctx.store.rateLimit('message', sid, burst);
    expect(bulk.allowed).toBe(true);
    expect((await ctx.store.rateLimit('message', sid)).allowed).toBe(false);
  });
});

describe('connection attempt rate (per IP hash)', () => {
  it('counts attempts in a fixed window and then refuses', async () => {
    const strict = await createTestContext({ CONN_RATE_LIMIT: '3', CONN_RATE_WINDOW_SECONDS: '60' });
    try {
      const ipHash = fakeHash('attacker');
      for (let i = 1; i <= 3; i += 1) {
        const result = await strict.store.connectionRateLimit(ipHash);
        expect(result).toMatchObject({ allowed: true, count: i });
      }
      const denied = await strict.store.connectionRateLimit(ipHash);
      expect(denied.allowed).toBe(false);
      expect(denied.resetSeconds).toBeGreaterThan(0);
    } finally {
      await strict.close();
    }
  });

  it('counts each IP hash separately', async () => {
    const strict = await createTestContext({ CONN_RATE_LIMIT: '1' });
    try {
      expect((await strict.store.connectionRateLimit(fakeHash('one'))).allowed).toBe(true);
      expect((await strict.store.connectionRateLimit(fakeHash('two'))).allowed).toBe(true);
    } finally {
      await strict.close();
    }
  });

  it('always leaves a TTL on the counter, even if one went missing', async () => {
    const ipHash = fakeHash('ttl');
    await ctx.store.connectionRateLimit(ipHash);
    await ctx.client.persist(ctx.keys.connRate(ipHash));
    const result = await ctx.store.connectionRateLimit(ipHash);
    expect(result.resetSeconds).toBeGreaterThan(0);
    expect(await ctx.client.ttl(ctx.keys.connRate(ipHash))).toBeGreaterThan(0);
  });
});

describe('concurrent connections per IP hash (R8)', () => {
  it('admits up to the cap and refuses beyond it', async () => {
    const strict = await createTestContext({ MAX_CONNECTIONS_PER_IP: '2' });
    try {
      const ipHash = fakeHash('office');
      const first = await strict.session({ ipHash });
      const second = await strict.session({ ipHash });
      expect(await strict.store.acquireConnectionSlot(ipHash, first)).toEqual({
        allowed: true,
        count: 1,
      });
      expect(await strict.store.acquireConnectionSlot(ipHash, second)).toEqual({
        allowed: true,
        count: 2,
      });

      const third = await strict.session({ ipHash });
      const denied = await strict.store.acquireConnectionSlot(ipHash, third);
      expect(denied).toEqual({ allowed: false, count: 2 });
      // The refused session must not be left holding a slot.
      expect(await strict.client.sismember(strict.keys.connSessions(ipHash), third)).toBe(0);
    } finally {
      await strict.close();
    }
  });

  it('is idempotent for the same session', async () => {
    const ipHash = fakeHash('same');
    const sid = await ctx.session({ ipHash });
    await ctx.store.acquireConnectionSlot(ipHash, sid);
    expect(await ctx.store.acquireConnectionSlot(ipHash, sid)).toEqual({ allowed: true, count: 1 });
  });

  it('reclaims slots left behind by a killed instance (§10.20)', async () => {
    const strict = await createTestContext({ MAX_CONNECTIONS_PER_IP: '2' });
    try {
      const ipHash = fakeHash('cgnat');
      // Two sessions whose rows are gone: exactly what a SIGKILLed instance
      // leaves behind. A plain counter could not tell these from live ones
      // without a global scan, and the IP would stay locked out.
      const ghostOne = newSessionId();
      const ghostTwo = newSessionId();
      await strict.client.sadd(strict.keys.connSessions(ipHash), ghostOne, ghostTwo);

      const live = await strict.session({ ipHash });
      const result = await strict.store.acquireConnectionSlot(ipHash, live);
      expect(result).toEqual({ allowed: true, count: 1 });
      expect(await strict.client.smembers(strict.keys.connSessions(ipHash))).toEqual([live]);
    } finally {
      await strict.close();
    }
  });

  it('still refuses when every slot holder is alive', async () => {
    const strict = await createTestContext({ MAX_CONNECTIONS_PER_IP: '1' });
    try {
      const ipHash = fakeHash('full');
      const held = await strict.session({ ipHash });
      await strict.store.acquireConnectionSlot(ipHash, held);
      const next = await strict.session({ ipHash });
      expect(await strict.store.acquireConnectionSlot(ipHash, next)).toEqual({
        allowed: false,
        count: 1,
      });
    } finally {
      await strict.close();
    }
  });

  it('releases a slot and deletes the key when the last one goes', async () => {
    const ipHash = fakeHash('release');
    const a = await ctx.session({ ipHash });
    const b = await ctx.session({ ipHash });
    await ctx.store.acquireConnectionSlot(ipHash, a);
    await ctx.store.acquireConnectionSlot(ipHash, b);

    expect(await ctx.store.releaseConnectionSlot(ipHash, a)).toBe(1);
    expect(await ctx.store.releaseConnectionSlot(ipHash, b)).toBe(0);
    expect(await ctx.client.exists(ctx.keys.connSessions(ipHash))).toBe(0);
  });

  it('tolerates releasing a slot that was never held', async () => {
    const ipHash = fakeHash('never');
    expect(await ctx.store.releaseConnectionSlot(ipHash, newSessionId())).toBe(0);
  });
});
