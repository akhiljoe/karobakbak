/**
 * Preference matching against a real Redis (D44, §29).
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE ARE FOR
 * ---------------------------------------------------------------------------
 * The whole decision rests on one distinction, and it is a behavioural one
 * rather than a structural one: a preference that misses **falls through on the
 * same pass** to an ordinary match, where a filter would hold a seat and wait.
 * Nothing in the type system says which of those was built. These tests do.
 *
 * They run against the real script because that is where the selection happens;
 * the fake mirrors it, and a fake agreeing with itself proves nothing about the
 * Lua.
 */
import { createTestContext, enqueue, fakeHash, type TestContext } from '../helpers/redis';
import { newMatchId } from '../../src/util/ids';
import { EMPTY_PROFILE } from '../../src/protocol/types';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext({
    FILTERS_ENABLED: 'true',
    MATCH_CANDIDATE_SAMPLE: '8',
    PREFERENCE_WIDE_SAMPLE: '64',
  });
});

afterEach(async () => {
  await ctx.flush();
});

afterAll(async () => {
  await ctx.close();
});

/** A queued session that has declared a gender, or declared nothing. */
async function waiting(gender: string | null): Promise<string> {
  const sid = await ctx.session();
  await ctx.store.setProfile(sid, { ...EMPTY_PROFILE, gender });
  await enqueue(ctx, sid);
  return sid;
}

describe('a preference that can be satisfied', () => {
  it('takes the preferred candidate over an older one who does not match', async () => {
    // The older session joins first, so the ordinary rule would pick it. This is
    // the assertion that the preference is doing anything at all.
    const older = await waiting('male');
    const preferred = await waiting('female');

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);

    expect(result).toMatchObject({ status: 'matched', partnerSessionId: preferred });
    expect(result).toMatchObject({ preference: { preferred: true } });
    expect(preferred).not.toBe(older);
  });

  it('still gives the longest-waiting of the preferred candidates', async () => {
    // Fairness (D2/D3) is not weakened by the preference, it is applied twice —
    // once inside the preferred pool and once inside the ordinary one.
    const first = await waiting('female');
    await waiting('female');
    await waiting('female');

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);
    expect(result).toMatchObject({ status: 'matched', partnerSessionId: first });
  });

  it('accepts any of several preferred values', async () => {
    const nb = await waiting('nonbinary');
    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), [
      'female',
      'nonbinary',
    ]);
    expect(result).toMatchObject({ status: 'matched', partnerSessionId: nb });
  });

  it('never matches a partial value', async () => {
    // 'male' is a substring of 'female'. The comma wrapping in the store is what
    // stops a preference for one silently accepting the other, and this asserts
    // the wrapping rather than trusting it.
    const female = await waiting('female');
    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['male']);

    // Matched — because a preference falls back — but explicitly NOT as a
    // preferred match.
    expect(result).toMatchObject({
      status: 'matched',
      partnerSessionId: female,
      preference: { preferred: false },
    });
  });
});

describe('a preference that cannot be satisfied', () => {
  it('falls back to an ordinary match on the same pass, rather than waiting', async () => {
    // The single most important behaviour in D44. A filter would return WAITING
    // here and hold the searcher until a match appeared; a preference does not.
    const only = await waiting('male');

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);

    expect(result).toMatchObject({
      status: 'matched',
      partnerSessionId: only,
      preference: { preferred: false, widened: true },
    });
  });

  it('never prefers somebody who declared no gender', async () => {
    const undeclared = await waiting(null);

    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);
    expect(result).toMatchObject({
      status: 'matched',
      partnerSessionId: undeclared,
      preference: { preferred: false },
    });
  });

  it('waits when the queue is empty, exactly as it would without a preference', async () => {
    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);
    expect(result).toMatchObject({
      status: 'waiting',
      queueDepth: 1,
      preference: { preferred: false },
    });
  });
});

describe('a block outranks a preference', () => {
  it('refuses a preferred candidate this searcher has blocked', async () => {
    // I12 is not negotiable and is not a tie-break. A blocked candidate is not
    // eligible at all, so the preference never gets to consider them — and the
    // ordinary fallback must not quietly reinstate them either. Blocked through
    // the real path rather than by writing the key, so this exercises what a
    // user's block button actually produces.
    const blockerIp = fakeHash('ipsearcher');
    const blockedIp = fakeHash('ipblocked');
    const searcher = await ctx.session({ ipHash: blockerIp, clientHash: fakeHash('clsearcher') });
    const blocked = await ctx.session({ ipHash: blockedIp, clientHash: fakeHash('clblocked') });
    await ctx.store.setProfile(blocked, { ...EMPTY_PROFILE, gender: 'female' });

    await enqueue(ctx, blocked);
    await enqueue(ctx, searcher);
    const matched = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId());
    expect(matched.status).toBe('matched');
    expect((await ctx.store.blockPartner(searcher)).status).toBe('blocked');

    // Both back in the queue. The only candidate is preferred *and* blocked.
    await enqueue(ctx, blocked);
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);
    // One, not two. Nothing preferred is findable, so the wider pass runs and
    // draws an overlapping sample -- the script tracks what it has already
    // considered so this candidate is counted once. Without that the counters
    // §29.6 uses to size the sample would inflate exactly when widening happens.
    expect(result).toMatchObject({ status: 'waiting', blockedSkipped: 1 });
  });
});

describe('escalating the sample', () => {
  it('finds the one preferred session in a crowd a small sample would miss', async () => {
    // The point of widening (§29.3), made deterministic. With a sample of one
    // the first look almost never contains the single preferred candidate among
    // twenty; with a wide sample larger than the pool it always does.
    //
    // SRANDMEMBER returns the whole set when asked for more than it holds, so
    // "widen" degrades to "consider everyone" — which is what makes this exact
    // rather than probabilistic.
    const narrow = await createTestContext({
      FILTERS_ENABLED: 'true',
      MATCH_CANDIDATE_SAMPLE: '1',
      PREFERENCE_WIDE_SAMPLE: '200',
    });

    try {
      for (let i = 0; i < 20; i += 1) {
        const sid = await narrow.session();
        await narrow.store.setProfile(sid, { ...EMPTY_PROFILE, gender: 'male' });
        await enqueue(narrow, sid);
      }
      const needle = await narrow.session();
      await narrow.store.setProfile(needle, { ...EMPTY_PROFILE, gender: 'female' });
      await enqueue(narrow, needle);

      const searcher = await narrow.session();
      await enqueue(narrow, searcher);

      const result = await narrow.store.tryMatch(searcher, narrow.segment, newMatchId(), [
        'female',
      ]);

      expect(result).toMatchObject({
        status: 'matched',
        partnerSessionId: needle,
        preference: { preferred: true, widened: true },
      });
    } finally {
      await narrow.flush();
      await narrow.close();
    }
  });

  it('does not widen when the ordinary sample already held a preferred candidate', async () => {
    await waiting('female');
    const searcher = await ctx.session();
    await enqueue(ctx, searcher);

    const result = await ctx.store.tryMatch(searcher, ctx.segment, newMatchId(), ['female']);
    // The second look costs a round trip through the pool and is only worth
    // paying for when the first one missed.
    expect(result).toMatchObject({ preference: { preferred: true, widened: false } });
  });
});

describe('the feature flag', () => {
  it('ignores a preference entirely while FILTERS_ENABLED is false', async () => {
    // Off is the shipped state, and "off" has to mean the preference cannot
    // influence a match even when one is passed — not merely that no UI offers
    // it. The older non-matching session must win on the ordinary rule.
    const off = await createTestContext({ FILTERS_ENABLED: 'false' });

    try {
      const older = await off.session();
      await off.store.setProfile(older, { ...EMPTY_PROFILE, gender: 'male' });
      await enqueue(off, older);

      const female = await off.session();
      await off.store.setProfile(female, { ...EMPTY_PROFILE, gender: 'female' });
      await enqueue(off, female);

      const searcher = await off.session();
      await enqueue(off, searcher);

      const result = await off.store.tryMatch(searcher, off.segment, newMatchId(), ['female']);

      expect(result).toMatchObject({
        status: 'matched',
        partnerSessionId: older,
        preference: { preferred: false, widened: false },
      });
    } finally {
      await off.flush();
      await off.close();
    }
  });
});
