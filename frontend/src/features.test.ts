/**
 * The build-time flags.
 *
 * These are constants, so most of what could be tested is tautology. Two things
 * are not, and both are the kind of mistake that ships quietly:
 *
 *  * a flag left on in a commit, which turns a deliberate product decision into
 *    an accident;
 *  * `FILTERS_AVAILABLE` losing one of its two conditions, which would put a
 *    paid control on the chat surface for free — or one the queue cannot act on.
 */
import { describe, expect, it } from 'vitest';

/*
 * The two files as text. A Vite `?raw` import, matching `content/pages.test.ts`
 * — this package compiles with `types: ["vite/client"]` and nothing else, so
 * reading a file through `node:fs` would mean putting every Node builtin within
 * reach of a browser bundle to enforce one rule.
 */
import appHeaderSource from './components/AppHeader.tsx?raw';
import authModalSource from './components/AuthModal.tsx?raw';

import {
  ACCOUNTS_ENABLED,
  FILTERS_AVAILABLE,
  FILTERS_ENABLED,
  PAYMENTS_ENABLED,
} from './features';

describe('the feature flags', () => {
  it('is the state somebody decided, not the state a commit drifted into', () => {
    // Turning any of these on is a product and legal decision, not a tidy-up.
    // If this fails, check it was meant — and that the documents it makes false
    // were fixed in the same commit.
    //
    // ACCOUNTS is on: sign-in over OIDC (§31, §32, D48). It is free, it holds
    // no credential here, and it gates saved connections and recent history.
    // The two that remain off are the paid tier, and they are off for their own
    // reasons — nothing can be bought, and only the `default` queue segment
    // exists (R6, D23).
    expect({ ACCOUNTS_ENABLED, PAYMENTS_ENABLED, FILTERS_ENABLED }).toEqual({
      ACCOUNTS_ENABLED: true,
      PAYMENTS_ENABLED: false,
      FILTERS_ENABLED: false,
    });
  });

  it.each([
    ['AuthModal', authModalSource],
    ['AppHeader', appHeaderSource],
  ])('keeps %s free of the payment flag', (_name, source) => {
    /*
     * The coupling this exists to prevent, and it is not hypothetical: the old
     * `AuthModal` computed `ACCOUNTS_ENABLED && PAYMENTS_ENABLED` and refused
     * itself whenever payments were off. Signing in is free (§31), so that put
     * a free feature behind the paid flag — silently, because the surface
     * simply never appeared and the natural diagnosis is "sign-in is broken"
     * rather than "a flag is wrong".
     *
     * A source check rather than a value check, because the property is
     * structural: it must keep holding after `PAYMENTS_ENABLED` is turned on,
     * and at that point no assertion over the constants can tell the two
     * situations apart. The comment prose is stripped first so the paragraph
     * above does not trip its own test — the same shape as the `console.js`
     * innerHTML rule.
     */
    expect(withoutComments(source)).not.toContain('PAYMENTS_ENABLED');
  });
});

describe('FILTERS_AVAILABLE', () => {
  it('is the conjunction of both conditions, not either one', () => {
    expect(FILTERS_AVAILABLE).toBe(FILTERS_ENABLED && PAYMENTS_ENABLED);
  });

  /*
   * The table the constant exists to enforce. Written out rather than asserted
   * on the live value, because the live value is one row of it and the other
   * three are the ones worth being sure about.
   */
  it('refuses each half on its own', () => {
    const available = (filters: boolean, payments: boolean): boolean => filters && payments;

    // Filters exist but nothing can be bought: the paid feature would be free,
    // and would then be taken away when payments arrive.
    expect(available(true, false)).toBe(false);
    // Payments exist but only the `default` queue segment does (R6, D23), so a
    // filter control would set something nothing reads.
    expect(available(false, true)).toBe(false);
    expect(available(false, false)).toBe(false);
    // Only when both hold.
    expect(available(true, true)).toBe(true);
  });

  it('is false today, so the chat header carries no filter control', () => {
    expect(FILTERS_AVAILABLE).toBe(false);
  });
});

/**
 * Block and line comments removed, so a rule can be explained in the file it
 * governs without the explanation counting as a violation.
 */
function withoutComments(source: string): string {
  const block = /\/\*[\s\S]*?\*\//g;
  const line = /\/\/.*/g;
  return source.replace(block, '').replace(line, '');
}
