/**
 * The two limits that answer D37's targeting objection (§29.4).
 *
 * ---------------------------------------------------------------------------
 * WHY THESE RUN AGAINST REAL REDIS
 * ---------------------------------------------------------------------------
 * The whole of both limits is one Lua script. The fake store returns whatever a
 * test sets, which is right for proving that `joinQueue` *reacts* correctly and
 * proves nothing about whether the cooldown or the budget actually bind. A fake
 * agreeing with itself is not evidence about a script.
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY WORTH MOST
 * ---------------------------------------------------------------------------
 * `survives a new session on the same address`. Every other limiter here keys
 * on the session id, which is one connection — and somebody hunting would
 * reconnect without thinking about it. These key on the IP hash, read from the
 * session's own row, which is the same dimension a block uses (D18). If that
 * test ever fails, the limits are decorative.
 */
import { createTestContext, type TestContext } from '../helpers/redis';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A session that is entitled to a preference, so the two limits are reachable.
 *
 * The gate is checked first and refuses everybody by default, which is correct
 * — nothing can be bought yet — and means a limit test using a bare session
 * would pass for the wrong reason for ever. Stamping the deadline is what the
 * server does when a connection binds an account.
 */
async function premiumSession(c: TestContext, overrides: { ipHash?: string } = {}): Promise<string> {
  const sid = await c.session(overrides);
  await c.store.setPremiumUntil(sid, Date.now() + 3_600_000);
  return sid;
}

describe('the entitlement gate', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      FILTERS_ENABLED: 'true',
      PREFERENCE_COOLDOWN_MS: '0',
      PREFERENCE_HOURLY_BUDGET: '100',
    });
  });

  afterEach(async () => {
    await ctx.flush();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('refuses a session with no entitlement stamped on it', async () => {
    /*
     * The state every session is in today, and the reason this shipped ahead of
     * payments: with nothing purchasable there is no account with a future
     * deadline, so the gate is provably closed before anything can be bought.
     * `premium_until` used to be written by the webhook and read by nothing.
     */
    const sid = await ctx.session();

    expect(await ctx.store.preferenceAllowance(sid)).toEqual({
      granted: false,
      reason: 'not_premium',
    });
  });

  it('refuses an entitlement that has lapsed', async () => {
    const sid = await ctx.session();
    await ctx.store.setPremiumUntil(sid, Date.now() - 1000);

    expect(await ctx.store.preferenceAllowance(sid)).toEqual({
      granted: false,
      reason: 'not_premium',
    });
  });

  it('grants one that is still live', async () => {
    const sid = await ctx.session();
    await ctx.store.setPremiumUntil(sid, Date.now() + 60_000);

    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
  });

  it('spends no budget on a search it refused for the entitlement', async () => {
    /*
     * The ordering inside the script. Somebody without the entitlement must not
     * burn a budget belonging to a dimension they are not being given — and if
     * they could, the first thing a paying user would notice is that their
     * first search of the hour had already been spent by the sessions they
     * opened before subscribing.
     */
    const sid = await ctx.session();
    for (let i = 0; i < 5; i += 1) {
      expect((await ctx.store.preferenceAllowance(sid)).granted).toBe(false);
    }

    await ctx.store.setPremiumUntil(sid, Date.now() + 60_000);
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
  });
});

describe('the cooldown between preference-applied searches', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext({
      FILTERS_ENABLED: 'true',
      PREFERENCE_COOLDOWN_MS: '300',
      PREFERENCE_HOURLY_BUDGET: '1000',
    });
  });

  afterEach(async () => {
    await ctx.flush();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('grants the first search and refuses the one straight after it', async () => {
    const sid = await premiumSession(ctx);

    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({
      granted: false,
      reason: 'cooldown',
    });
  });

  it('grants again once the cooldown has elapsed', async () => {
    const sid = await premiumSession(ctx);

    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
    await sleep(350);
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
  });

  it('survives a new session on the same address', async () => {
    /*
     * The property the whole design rests on. A limit keyed on the session id
     * would be reset by pressing reconnect, which is free — so somebody walking
     * a scarce group would never touch it. The hash is read from the session's
     * own row, so no caller can name a bucket other than its own.
     */
    const first = await premiumSession(ctx, { ipHash: 'shared-address' });
    expect(await ctx.store.preferenceAllowance(first)).toEqual({ granted: true });

    const second = await premiumSession(ctx, { ipHash: 'shared-address' });
    expect(await ctx.store.preferenceAllowance(second)).toEqual({
      granted: false,
      reason: 'cooldown',
    });
  });

  it('does not follow somebody else on a different address', async () => {
    // The other half of the same property: a shared bucket would mean one
    // person's searching silently costs a stranger their preference.
    const mine = await premiumSession(ctx, { ipHash: 'address-a' });
    const theirs = await premiumSession(ctx, { ipHash: 'address-b' });

    expect(await ctx.store.preferenceAllowance(mine)).toEqual({ granted: true });
    expect(await ctx.store.preferenceAllowance(theirs)).toEqual({ granted: true });
  });

  it('answers no_session for a session that has no row', async () => {
    // The row expiring between the join arriving and this read. Not an error:
    // the join fails on its own, and until it does, declining to apply a
    // preference is the correct degraded answer.
    expect(await ctx.store.preferenceAllowance('s_never_existed')).toEqual({
      granted: false,
      reason: 'no_session',
    });
  });
});

describe('the hourly preference budget', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // No cooldown, so the budget is the only thing under test. With one it
    // would be impossible to tell which limit refused an attempt.
    ctx = await createTestContext({
      FILTERS_ENABLED: 'true',
      PREFERENCE_COOLDOWN_MS: '0',
      PREFERENCE_HOURLY_BUDGET: '3',
    });
  });

  afterEach(async () => {
    await ctx.flush();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('grants exactly the budget, then refuses', async () => {
    const sid = await premiumSession(ctx);

    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({
      granted: false,
      reason: 'budget',
    });
  });

  it('stays refused rather than restarting its refill on every attempt', async () => {
    /*
     * The bug this is named after: writing the bucket back only on a grant
     * would leave `ts` at the last successful search, so each refused attempt
     * would compute its refill from an older timestamp and eventually hand back
     * a token that was never earned. Writing it back on refusal too keeps the
     * clock honest, and the refusal stable.
     */
    const sid = await premiumSession(ctx);
    for (let i = 0; i < 3; i += 1) {
      expect((await ctx.store.preferenceAllowance(sid)).granted).toBe(true);
    }

    for (let i = 0; i < 5; i += 1) {
      expect(await ctx.store.preferenceAllowance(sid)).toEqual({
        granted: false,
        reason: 'budget',
      });
    }
  });

  it('is spent per address, not per session', async () => {
    const first = await premiumSession(ctx, { ipHash: 'one-address' });
    for (let i = 0; i < 3; i += 1) {
      expect((await ctx.store.preferenceAllowance(first)).granted).toBe(true);
    }

    // Reconnecting is free and gives a new session id. It must not give a new
    // budget.
    const second = await premiumSession(ctx, { ipHash: 'one-address' });
    expect(await ctx.store.preferenceAllowance(second)).toEqual({
      granted: false,
      reason: 'budget',
    });
  });
});

describe('a refused search costs nothing it did not use', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    // A long cooldown and a budget of two, so a run of attempts is refused by
    // the cooldown and the budget is observably untouched afterwards.
    ctx = await createTestContext({
      FILTERS_ENABLED: 'true',
      PREFERENCE_COOLDOWN_MS: '400',
      PREFERENCE_HOURLY_BUDGET: '2',
    });
  });

  afterEach(async () => {
    await ctx.flush();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('does not spend a token on an attempt the cooldown refused', async () => {
    /*
     * The ordering inside the script, asserted from outside it. If the budget
     * were checked first, somebody pressing next repeatedly would burn an
     * hour's worth of preference on searches that were never granted one — and
     * the symptom would be a paying user whose preference stopped working for
     * reasons nothing could show them.
     */
    const sid = await premiumSession(ctx);
    expect((await ctx.store.preferenceAllowance(sid)).granted).toBe(true);

    for (let i = 0; i < 6; i += 1) {
      expect(await ctx.store.preferenceAllowance(sid)).toEqual({
        granted: false,
        reason: 'cooldown',
      });
    }

    // One token spent, one left. If the refusals had spent tokens this is the
    // line that fails.
    await sleep(450);
    expect(await ctx.store.preferenceAllowance(sid)).toEqual({ granted: true });
  });
});
