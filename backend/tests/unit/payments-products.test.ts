import {
  capturedAmountMatches,
  findProduct,
  PRODUCTS,
  resolveAmountPaise,
} from '../../src/payments/products';

describe('the catalogue', () => {
  it('prices premium at ₹99 a month, in paise', () => {
    // The figure the premium page has shown since it was written. If this
    // changes, the copy on `PremiumPage.tsx` changes in the same commit.
    expect(PRODUCTS.premium_1_month?.pricePaise).toBe(9900);
    expect(PRODUCTS.premium_1_month?.grantDays).toBe(30);
  });

  it('requires an account for anything that grants an entitlement', () => {
    for (const [key, product] of Object.entries(PRODUCTS)) {
      if (product.grantDays > 0) {
        expect([key, product.requiresAccount]).toEqual([key, true]);
      }
    }
  });

  it('grants nothing for a donation', () => {
    expect(PRODUCTS.donation?.grantDays).toBe(0);
    expect(PRODUCTS.donation?.requiresAccount).toBe(false);
  });

  it('resolves a known product and refuses anything else', () => {
    expect(findProduct('premium_1_month')).not.toBeNull();
    expect(findProduct('premium_1_year')).toBeNull();
    expect(findProduct('')).toBeNull();
    expect(findProduct(null)).toBeNull();
    expect(findProduct(42)).toBeNull();
  });

  /**
   * `PRODUCTS[key]` on a plain object resolves inherited names too, so a body
   * of `{"product":"constructor"}` would otherwise hand the caller a function
   * and be treated as a purchasable thing.
   */
  it('does not resolve inherited object properties as products', () => {
    expect(findProduct('constructor')).toBeNull();
    expect(findProduct('__proto__')).toBeNull();
    expect(findProduct('toString')).toBeNull();
  });
});

describe('resolveAmountPaise', () => {
  const fixed = PRODUCTS.premium_1_month!;
  const variable = PRODUCTS.donation!;

  /** The whole point of server-side pricing. */
  it('ignores the requested amount entirely for a fixed product', () => {
    for (const requested of [1, 0, -5, 99_999_999, 'free', null, undefined]) {
      const result = resolveAmountPaise(fixed, requested);
      expect(result).toEqual({ ok: true, amountPaise: 9900 });
    }
  });

  it('accepts a variable amount inside its bounds', () => {
    expect(resolveAmountPaise(variable, 5000)).toEqual({ ok: true, amountPaise: 5000 });
    expect(resolveAmountPaise(variable, 250_000)).toEqual({ ok: true, amountPaise: 250_000 });
  });

  it('refuses a variable amount outside its bounds, at both ends', () => {
    expect(resolveAmountPaise(variable, 4999)).toEqual({
      ok: false,
      refusal: { reason: 'below_minimum' },
    });
    expect(resolveAmountPaise(variable, 5_000_001)).toEqual({
      ok: false,
      refusal: { reason: 'above_maximum' },
    });
  });

  /**
   * `parseInt('500abc')` is 500, which is how a malformed body becomes a
   * plausible-looking charge. Nothing here calls it.
   */
  it('refuses anything that is not already a whole number', () => {
    for (const requested of ['5000', '5000abc', 5000.5, NaN, Infinity, null, {}, []]) {
      expect(resolveAmountPaise(variable, requested)).toEqual({
        ok: false,
        refusal: { reason: 'not_an_integer' },
      });
    }
  });
});

describe('capturedAmountMatches', () => {
  it('accepts only an exact match', () => {
    expect(capturedAmountMatches(9900, 9900)).toBe(true);
    expect(capturedAmountMatches(9900, 9899)).toBe(false);
  });

  /**
   * An overpayment is refused too. The only ways it happens are a bug on our
   * side or a tampered flow, and accepting it quietly makes both harder to see.
   */
  it('refuses an overpayment as well as an underpayment', () => {
    expect(capturedAmountMatches(9900, 19_800)).toBe(false);
  });

  it('refuses a non-integer captured amount', () => {
    expect(capturedAmountMatches(9900, 9900.0001)).toBe(false);
    expect(capturedAmountMatches(9900, NaN)).toBe(false);
  });
});
