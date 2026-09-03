/**
 * The catalogue.
 *
 * ---------------------------------------------------------------------------
 * PRICES ARE SERVER-SIDE AND NOTHING ELSE IS ACCEPTED
 * ---------------------------------------------------------------------------
 * A fixed-price product takes its amount from here and ignores whatever the
 * request body said, and the webhook re-checks the captured amount against the
 * same number before granting anything. Both halves are needed: the first stops
 * a cheap order being created, the second stops an order created honestly and
 * paid through a tampered client.
 *
 * A variable-price product — the Support page donation — is the one case where
 * an amount arrives from outside, and it is bounded on both ends. The floor
 * stops the payment provider being used as a free ping; the ceiling stops a
 * mistyped amount becoming a chargeback, and a refund is more expensive to
 * everybody than a refused order.
 *
 * ---------------------------------------------------------------------------
 * WHY A GRANT IS A NUMBER OF DAYS AND NOT AN INTERVAL STRING
 * ---------------------------------------------------------------------------
 * The obvious shape is `duration: '1 month'` dropped into `INTERVAL '...'`.
 * That is a string interpolated into SQL, and its safety rests entirely on this
 * file being the only source of the string — which is true today and is one
 * careless edit from not being. A number goes through `make_interval()` as a
 * bound parameter and the question never arises.
 *
 * Days rather than months also removes an ambiguity nobody wants to discover
 * from a support ticket: a month bought on the 31st.
 */

export type ProductKind = 'fixed' | 'variable';

export interface Product {
  readonly kind: ProductKind;
  /** Fixed products only. Paise, integer, never a float. */
  readonly pricePaise?: number;
  /** Variable products only. Inclusive bounds, in paise. */
  readonly minPaise?: number;
  readonly maxPaise?: number;
  /**
   * Days of premium this grants, or 0 for a product that grants nothing.
   *
   * A donation deliberately grants nothing. Buying goodwill is not an
   * entitlement, and the Support page says so.
   */
  readonly grantDays: number;
  /** Whether an authenticated account is required to buy it. */
  readonly requiresAccount: boolean;
  /** Shown in the Razorpay checkout. Developer-authored, never user text. */
  readonly description: string;
}

/**
 * What is for sale, built from configuration.
 *
 * ₹99 a month is the price the premium page has said since it was written and
 * the one the copy review signed off; it is a default here rather than a
 * constant so a deployment can move it without a rebuild. Paise because that
 * is the unit Razorpay charges in — a rupees field that gets multiplied
 * somewhere is an extra place for a factor of 100 to go missing.
 *
 * **The Premium page states the price in prose.** Nothing can check that from
 * here: moving `PREMIUM_PRICE_PAISE` without changing the copy advertises a
 * price the checkout does not charge.
 */
export function buildProducts(pricing: Pricing): Readonly<Record<string, Product>> {
  return Object.freeze({
  premium_1_month: Object.freeze({
    kind: 'fixed',
    pricePaise: pricing.premiumPricePaise,
    grantDays: pricing.premiumGrantDays,
    requiresAccount: true,
    description: 'Premium — 1 month',
  }),
  /**
   * Anonymous by construction: no account, no entitlement, no record of who
   * sent it beyond the order row the payment provider needs us to keep. The
   * Support page promises the note is not stored, and nothing here stores it.
   */
  donation: Object.freeze({
    kind: 'variable',
    minPaise: pricing.donationMinPaise,
    maxPaise: pricing.donationMaxPaise,
    grantDays: 0,
    requiresAccount: false,
    description: 'Support karobakbak',
  }),
  });
}

/** The four numbers `buildProducts` needs, as `config.payments` supplies them. */
export interface Pricing {
  readonly premiumPricePaise: number;
  readonly premiumGrantDays: number;
  readonly donationMinPaise: number;
  readonly donationMaxPaise: number;
}

export function findProduct(
  catalogue: Readonly<Record<string, Product>>,
  key: unknown,
): Product | null {
  if (typeof key !== 'string') return null;
  // `Object.hasOwn` rather than a truthiness check on the lookup: the catalogue
  // is a plain record, and `'constructor'` would otherwise resolve to a
  // function and be treated as a product.
  if (!Object.hasOwn(catalogue, key)) return null;
  return catalogue[key] ?? null;
}

export interface AmountRefusal {
  readonly reason: 'not_an_integer' | 'below_minimum' | 'above_maximum';
}

/**
 * The amount to charge for one order.
 *
 * Returns the server-decided figure for a fixed product regardless of what was
 * requested, and a validated figure for a variable one. The caller never sees
 * a requested amount it could accidentally prefer.
 */
export function resolveAmountPaise(
  product: Product,
  requestedPaise: unknown,
): { ok: true; amountPaise: number } | { ok: false; refusal: AmountRefusal } {
  if (product.kind === 'fixed') {
    return { ok: true, amountPaise: product.pricePaise ?? 0 };
  }

  // Deliberately strict: no `parseInt`, which happily reads "500abc" as 500 and
  // would let a malformed body through as a plausible-looking amount.
  if (typeof requestedPaise !== 'number' || !Number.isSafeInteger(requestedPaise)) {
    return { ok: false, refusal: { reason: 'not_an_integer' } };
  }
  const min = product.minPaise ?? 1;
  const max = product.maxPaise ?? Number.MAX_SAFE_INTEGER;
  if (requestedPaise < min) return { ok: false, refusal: { reason: 'below_minimum' } };
  if (requestedPaise > max) return { ok: false, refusal: { reason: 'above_maximum' } };
  return { ok: true, amountPaise: requestedPaise };
}

/**
 * Whether a captured amount matches what the order was for.
 *
 * Exact equality, both directions. An underpayment is obvious; an overpayment
 * is refused too, because the only ways it happens are a bug on our side or a
 * tampered flow, and silently accepting more money than we asked for makes both
 * harder to notice.
 */
export function capturedAmountMatches(orderAmountPaise: number, capturedPaise: number): boolean {
  return Number.isSafeInteger(capturedPaise) && capturedPaise === orderAmountPaise;
}
