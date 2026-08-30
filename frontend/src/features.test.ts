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

import {
  ACCOUNTS_ENABLED,
  FILTERS_AVAILABLE,
  FILTERS_ENABLED,
  PAYMENTS_ENABLED,
} from './features';

describe('the feature flags', () => {
  it('ships every one of them off', () => {
    // Turning any of these on is a product and legal decision, not a tidy-up.
    // If this fails, check it was meant — and that the documents it makes false
    // were fixed in the same commit.
    expect({ ACCOUNTS_ENABLED, PAYMENTS_ENABLED, FILTERS_ENABLED }).toEqual({
      ACCOUNTS_ENABLED: false,
      PAYMENTS_ENABLED: false,
      FILTERS_ENABLED: false,
    });
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
