/**
 * The model provider seam (D-AI-10).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS BEFORE THERE ARE TWO VENDORS
 * ---------------------------------------------------------------------------
 * The operator intends to use more than one. Retrofitting an abstraction after
 * the call sites exist is far more expensive than carrying one from the start,
 * and the call sites here are the hot ones — the reply path, the budget
 * accounting, the metrics labels.
 *
 * No vendor SDK is imported anywhere except inside its own adapter. That rule
 * is what keeps a vendor's error shapes, retry semantics and caching vocabulary
 * from leaking into the persona layer, where they would have to be re-learned
 * for every new vendor.
 *
 * ---------------------------------------------------------------------------
 * THREE THINGS THAT DO NOT SURVIVE THE ABSTRACTION
 * ---------------------------------------------------------------------------
 * Recorded here so nobody assumes they do:
 *
 *  1. **Caching semantics differ sharply.** One vendor takes explicit prefix
 *     breakpoints with a minimum cacheable size; another caches implicitly,
 *     differently, or not at all. The cost model is therefore **per provider**,
 *     and a provider without prefix caching can be several times more expensive
 *     for identical traffic. `PricedUsage` normalises the *reporting* of this;
 *     it does not make the numbers comparable.
 *  2. **Refusals are not portable.** Each vendor declines differently and
 *     reports it differently. The adapter normalises to `stop: 'refused'` so
 *     the persona layer never branches on a vendor's error shape.
 *  3. **Token counts are not comparable.** Different tokenisers, so the same
 *     conversation is a different number of tokens per vendor. Re-baseline
 *     rather than carrying a measurement across.
 *
 * ---------------------------------------------------------------------------
 * AND ONE THING THAT IS NOT TECHNICAL
 * ---------------------------------------------------------------------------
 * Every vendor is a **named processor** in the Privacy Policy, because user
 * messages reach it (D-AI-2). Adding one is a policy change and a 14-day notice
 * before it is a configuration change. A vendor whose terms permit training on
 * submitted content is not eligible.
 */

/** One turn of the conversation, as the provider sees it. */
export interface ProviderMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
}

export interface ProviderRequest {
  /**
   * The stable prefix: instructions plus the persona character.
   *
   * Split from `volatile` because this is the part worth caching, and caching
   * is a prefix match — any byte change invalidates everything after it. Kept
   * as one string so the adapter can mark exactly one breakpoint.
   */
  readonly stableSystem: string;
  /**
   * The part that changes every conversation: the generated surface, the
   * session summary. Sent after the stable prefix so it cannot invalidate it.
   */
  readonly volatileSystem: string;
  readonly messages: readonly ProviderMessage[];
  readonly maxOutputTokens: number;
}

/** Why generation stopped. Normalised: vendors disagree about the vocabulary. */
export type ProviderStop = 'complete' | 'truncated' | 'refused' | 'error';

/**
 * Token usage, normalised.
 *
 * All four are reported separately because they are priced differently — a
 * cache read is roughly a tenth of an ordinary input token, and a cache write
 * is more than one. Collapsing them into "input" would make the bill
 * unexplainable at exactly the moment somebody asks why it is what it is.
 */
export interface ProviderUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export const NO_USAGE: ProviderUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export interface ProviderReply {
  readonly text: string;
  readonly stop: ProviderStop;
  readonly usage: ProviderUsage;
  /** The model that actually answered, which may differ from the one asked for. */
  readonly model: string;
}

export interface ModelProvider {
  /** Stable name. A metric label and a control-plane subject, so keep it short. */
  readonly name: string;
  complete(request: ProviderRequest): Promise<ProviderReply>;
}

/* -------------------------------------------------------------------------- */
/* Pricing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Price per million tokens, in US cents, so arithmetic stays in integers.
 *
 * Money is never held as a float here. Accumulating thousands of fractional
 * dollars in a double and then comparing against a ceiling is how a budget
 * check ends up off by a rounding error in the direction nobody wanted.
 * Micro-cents give plenty of headroom for a per-message cost of ~0.08 cents.
 */
export interface ModelPrice {
  readonly inputMicroCentsPerMTok: number;
  readonly outputMicroCentsPerMTok: number;
  readonly cacheReadMicroCentsPerMTok: number;
  readonly cacheWriteMicroCentsPerMTok: number;
}

const MC = 1_000_000; // micro-cents in a cent
const dollars = (perMTok: number): number => Math.round(perMTok * 100 * MC);

/**
 * What each model costs.
 *
 * Cache reads are a tenth of input and cache writes are 1.25x, which is the
 * published Anthropic ratio. **These are Anthropic first-party rates and do not
 * transfer to another vendor** — see the note at the top of this file.
 *
 * A model missing from this table cannot be used: `priceFor` throws rather than
 * defaulting, because a default price is a budget that silently does not bind.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-haiku-4-5': {
    inputMicroCentsPerMTok: dollars(1),
    outputMicroCentsPerMTok: dollars(5),
    cacheReadMicroCentsPerMTok: dollars(0.1),
    cacheWriteMicroCentsPerMTok: dollars(1.25),
  },
  'claude-sonnet-5': {
    inputMicroCentsPerMTok: dollars(3),
    outputMicroCentsPerMTok: dollars(15),
    cacheReadMicroCentsPerMTok: dollars(0.3),
    cacheWriteMicroCentsPerMTok: dollars(3.75),
  },
  'claude-opus-5': {
    inputMicroCentsPerMTok: dollars(5),
    outputMicroCentsPerMTok: dollars(25),
    cacheReadMicroCentsPerMTok: dollars(0.5),
    cacheWriteMicroCentsPerMTok: dollars(6.25),
  },
};

export function priceFor(model: string): ModelPrice {
  const price = MODEL_PRICES[model];
  if (price === undefined) {
    throw new Error(
      `no price recorded for model "${model}". Add it to MODEL_PRICES rather than ` +
        'letting it default: an unpriced model spends against a budget that cannot bind.',
    );
  }
  return price;
}

/** What one call cost, in micro-cents. Integer arithmetic throughout. */
export function costOf(model: string, usage: ProviderUsage): number {
  const price = priceFor(model);
  return (
    Math.round((usage.inputTokens * price.inputMicroCentsPerMTok) / 1_000_000) +
    Math.round((usage.outputTokens * price.outputMicroCentsPerMTok) / 1_000_000) +
    Math.round((usage.cacheReadTokens * price.cacheReadMicroCentsPerMTok) / 1_000_000) +
    Math.round((usage.cacheWriteTokens * price.cacheWriteMicroCentsPerMTok) / 1_000_000)
  );
}

/** Micro-cents to a readable string, for logs and the console. */
export function formatMicroCents(microCents: number): string {
  return `$${(microCents / (100 * MC)).toFixed(4)}`;
}
