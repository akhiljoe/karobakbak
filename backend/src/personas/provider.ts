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
 *  1. **Caching semantics differ sharply**, and both adapters now demonstrate
 *     it rather than predicting it. Anthropic takes an explicit prefix
 *     breakpoint with a minimum cacheable size and charges a premium to write;
 *     OpenAI caches implicitly on an exact prefix match and charges nothing to
 *     write. They also disagree about what "input tokens" counts — one excludes
 *     the cached ones and the other includes them, which is a double-billing
 *     bug in whichever adapter forgets to subtract. The cost model is therefore
 *     **per provider**,
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
 * What each model costs, per vendor.
 *
 * A model missing from this table cannot be used: `priceFor` throws rather than
 * defaulting, because a default price is a budget that silently does not bind.
 * `assertCoherent` checks the configured model against this table at startup,
 * so an unpriced one is a refused boot rather than a ceiling discovered to have
 * been decorative a month later.
 *
 * **Rates are first-party and per vendor.** Nothing about one vendor's numbers
 * transfers to another's, and two of the ratios differ in kind rather than in
 * degree:
 *
 *  - Anthropic charges a **premium to write** the cache (1.25x input) and a
 *    tenth of input to read it.
 *  - OpenAI charges **nothing to write** it. The cache-write columns below are
 *    zero for that reason, and `provider-openai.ts` always reports zero written
 *    tokens — an absent charge, not absent data.
 *
 * Verified against each vendor's published pricing page. They change; a stale
 * number here is a ceiling that binds at the wrong place, so re-check this
 * table when adding a model rather than copying the shape of a neighbouring row.
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

  /* ---- OpenAI. Cache writes are free, hence the zeroes. ---- */

  'gpt-5-nano': {
    inputMicroCentsPerMTok: dollars(0.05),
    outputMicroCentsPerMTok: dollars(0.4),
    cacheReadMicroCentsPerMTok: dollars(0.005),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-5-mini': {
    inputMicroCentsPerMTok: dollars(0.25),
    outputMicroCentsPerMTok: dollars(2),
    cacheReadMicroCentsPerMTok: dollars(0.025),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-5': {
    inputMicroCentsPerMTok: dollars(1.25),
    outputMicroCentsPerMTok: dollars(10),
    cacheReadMicroCentsPerMTok: dollars(0.125),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-4.1-nano': {
    inputMicroCentsPerMTok: dollars(0.1),
    outputMicroCentsPerMTok: dollars(0.4),
    cacheReadMicroCentsPerMTok: dollars(0.025),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-4.1-mini': {
    inputMicroCentsPerMTok: dollars(0.4),
    outputMicroCentsPerMTok: dollars(1.6),
    cacheReadMicroCentsPerMTok: dollars(0.1),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-4.1': {
    inputMicroCentsPerMTok: dollars(2),
    outputMicroCentsPerMTok: dollars(8),
    cacheReadMicroCentsPerMTok: dollars(0.5),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-4o-mini': {
    inputMicroCentsPerMTok: dollars(0.15),
    outputMicroCentsPerMTok: dollars(0.6),
    cacheReadMicroCentsPerMTok: dollars(0.075),
    cacheWriteMicroCentsPerMTok: 0,
  },
  'gpt-4o': {
    inputMicroCentsPerMTok: dollars(2.5),
    outputMicroCentsPerMTok: dollars(10),
    cacheReadMicroCentsPerMTok: dollars(1.25),
    cacheWriteMicroCentsPerMTok: 0,
  },
};

/**
 * Which adapter answers for a provider name, and which models it may be asked
 * for.
 *
 * Held here rather than in `main.ts` so `assertCoherent` can refuse a
 * mismatched pair — an Anthropic model id against an OpenAI key authenticates
 * fine and then 404s on every single call, which the fallback would turn into a
 * month of scripted conversations with nothing in the logs saying why.
 */
export const PROVIDER_MODELS: Readonly<Record<string, readonly string[]>> = {
  anthropic: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5'],
  openai: [
    'gpt-5-nano',
    'gpt-5-mini',
    'gpt-5',
    'gpt-4.1-nano',
    'gpt-4.1-mini',
    'gpt-4.1',
    'gpt-4o-mini',
    'gpt-4o',
  ],
};

/** The provider names `PERSONA_PROVIDER` accepts. */
export const PROVIDER_NAMES: readonly string[] = Object.keys(PROVIDER_MODELS);

/**
 * Strip a dated snapshot suffix, or null if there is none.
 *
 * Both vendors answer with a **dated** id even when asked for an undated one —
 * `gpt-5-mini` comes back as `gpt-5-mini-2025-08-07`, `claude-haiku-4-5` as
 * `claude-haiku-4-5-20251001`. Two spellings, one idea.
 */
function snapshotBase(model: string): string | null {
  const match = /^(.+)-(\d{4}-\d{2}-\d{2}|\d{8})$/.exec(model);
  return match?.[1] ?? null;
}

/**
 * What a model costs.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATED SUFFIX IS HANDLED HERE AND NOT IGNORED
 * ---------------------------------------------------------------------------
 * `costOf` is called with the model the *response* reported, deliberately,
 * because that is what was actually billed. Both vendors report a dated
 * snapshot id, and a dated id has no row in `MODEL_PRICES` — so every call
 * threw, `safeCost` downgraded the throw to a log line and a **zero**, and the
 * monthly ceiling counted nothing at all.
 *
 * That is the exact failure `MODEL_PRICES` exists to prevent, arriving through
 * the one door the boot-time check does not cover: `assertCoherent` validates
 * the id that is *configured*, and this is the id that comes *back*. It was
 * found in a log line reading "model returned an unpriced model id" next to a
 * `persona_spend` row that had not moved.
 *
 * A snapshot of a priced model is that model. An id that is not a snapshot of
 * anything still throws, because a genuinely unknown model must not be given a
 * default price.
 */
export function priceFor(model: string): ModelPrice {
  const exact = MODEL_PRICES[model];
  if (exact !== undefined) return exact;

  const base = snapshotBase(model);
  if (base !== null) {
    const dated = MODEL_PRICES[base];
    if (dated !== undefined) return dated;
  }

  throw new Error(
    `no price recorded for model "${model}". Add it to MODEL_PRICES rather than ` +
      'letting it default: an unpriced model spends against a budget that cannot bind.',
  );
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
