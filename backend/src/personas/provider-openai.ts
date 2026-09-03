/**
 * The OpenAI adapter.
 *
 * The second adapter, and the reason `provider.ts` exists (D-AI-10). **One of
 * exactly two files in this repository that may import a model vendor's SDK**,
 * the other being `provider-anthropic.ts`. If an import of `openai` appears
 * anywhere else, the abstraction has already failed.
 *
 * ---------------------------------------------------------------------------
 * WHAT DOES NOT TRANSFER FROM THE ANTHROPIC ADAPTER
 * ---------------------------------------------------------------------------
 * `provider.ts` warns that caching semantics and prices do not survive the
 * abstraction. Writing the second adapter is where that stops being a warning:
 *
 *  1. **Caching is implicit and has no breakpoint.** Anthropic takes an
 *     explicit `cache_control` marker; here, prefixes are cached automatically
 *     once they are long enough, and an exact prefix match is what decides it.
 *     So there is nothing to mark — but the stable/volatile split still earns
 *     its keep, because it is what keeps the prefix byte-identical between
 *     turns. Sending the volatile half first would silently cost several times
 *     more, with no error and nothing in the response to say so.
 *
 *  2. **A cache write is free.** There is no premium for populating the cache,
 *     so `cacheWriteTokens` is always reported as zero. It is not missing data;
 *     it is a charge that does not exist here.
 *
 *  3. **`prompt_tokens` INCLUDES the cached tokens, and Anthropic's
 *     `input_tokens` EXCLUDES them.** This is the trap in this file. Passing
 *     the vendor's number through unchanged would bill every cached token twice
 *     — once at the full input rate and once at the cached rate — so the
 *     budget would bind early and the persona would fall back to the scripted
 *     voice for the rest of the month, which is exactly the failure this whole
 *     subsystem was just repaired for. `normaliseUsage` subtracts.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT USED
 * ---------------------------------------------------------------------------
 * No streaming, for the same reason as the other adapter: the reply pause in
 * the client is longer than the generation time at these lengths.
 *
 * No `temperature`, `top_p` or any other sampling parameter. The newer models
 * reject them outright, and a persona's variation comes from its character
 * sheet and its generated surface, not from a decoding knob.
 *
 * ---------------------------------------------------------------------------
 * REASONING IS ON UNLESS YOU TURN IT OFF, AND IT EATS THE WHOLE CEILING
 * ---------------------------------------------------------------------------
 * The gpt-5 family reasons by default, and `max_completion_tokens` bounds
 * **reasoning plus visible output** rather than just the reply. A persona's
 * reply ceiling is 300 tokens, so the first live conversation produced this,
 * over and over:
 *
 *   400 Could not finish the message because max_tokens or model output limit
 *   was reached.
 *
 * — and, on the calls that did return, an empty `content` with
 * `finish_reason: "length"`. The model had spent the entire allowance thinking
 * and had nothing left to say with. A stranger saw a greeting and then silence.
 *
 * Two things fix it, and both are needed:
 *
 *   `reasoning_effort: 'minimal'` — there is nothing to reason about in a
 *   two-line chat reply, and reasoning tokens are billed at the output rate.
 *
 *   Headroom on top of the reply ceiling — a ceiling is not a charge, so the
 *   room costs nothing unless it is used, and without it a single stray
 *   thinking token still ends the message.
 *
 * Neither parameter may be sent to a model that does not reason, which is why
 * `REASONING_MODELS` is an explicit list rather than a prefix test: a wrong
 * guess here is a 400 on every call, which the scripted fallback would hide.
 */

import OpenAI from 'openai';
import type { Logger } from '../logger';
import { errorFields } from '../logger';
import type {
  ModelProvider,
  ProviderReply,
  ProviderRequest,
  ProviderStop,
  ProviderUsage,
} from './provider';
import { NO_USAGE } from './provider';

export interface OpenAIProviderOptions {
  readonly apiKey: string;
  /**
   * Which model answers.
   *
   * Defaults to `gpt-5-mini`, which is the tier the cost work in D-AI-7 settled
   * on applied to this vendor: casual two-line chat replies do not need a
   * frontier model. Raising it is a deliberate quality decision with a cost
   * attached, taken with the ceiling already in place.
   *
   * Whatever is chosen must appear in `MODEL_PRICES`. `loadConfig` refuses to
   * start otherwise, because an unpriced model spends against a budget that
   * cannot bind.
   */
  readonly model?: string;
  /**
   * Headroom left for a reasoning model's hidden tokens
   * (`PERSONA_REASONING_HEADROOM_TOKENS`).
   *
   * Optional so a test can construct a provider with a key and a stub client
   * and nothing else; production passes `config.personas`, which is where the
   * default that ships actually lives.
   */
  readonly reasoningHeadroomTokens?: number;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Injected in tests so no network is touched. */
  readonly client?: Pick<OpenAI, 'chat'>;
}

const DEFAULT_MODEL = 'gpt-5-mini';

/**
 * Models that reason, and therefore need to be told not to.
 *
 * Explicit rather than a `gpt-5` prefix test, because sending
 * `reasoning_effort` to a model that does not support it is a 400 on every
 * call — a failure the scripted fallback would quietly absorb.
 */
const REASONING_MODELS: ReadonlySet<string> = new Set(['gpt-5-nano', 'gpt-5-mini', 'gpt-5']);

/**
 * Room reserved above the reply ceiling for a reasoning model to think in.
 *
 * Generous on purpose. `max_completion_tokens` is a bound, not a bill, so
 * unused headroom costs nothing — while too little of it truncates the reply to
 * an empty string and the persona goes silent, which is what this whole number
 * exists to stop.
 */
const DEFAULT_REASONING_HEADROOM_TOKENS = 1000;

export class OpenAIProvider implements ModelProvider {
  readonly name = 'openai';

  private readonly client: Pick<OpenAI, 'chat'>;
  private readonly model: string;
  private readonly reasoningHeadroomTokens: number;
  private readonly logger: Logger;

  constructor(options: OpenAIProviderOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.reasoningHeadroomTokens =
      options.reasoningHeadroomTokens ?? DEFAULT_REASONING_HEADROOM_TOKENS;
    this.logger = options.logger;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 20_000,
        // Two retries is the SDK default and the right number here: a persona
        // that retries for a minute has already lost the conversation.
        maxRetries: 2,
      });
  }

  async complete(request: ProviderRequest): Promise<ProviderReply> {
    const reasons = REASONING_MODELS.has(this.model);

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        // `max_tokens` is refused by the newer models. This is the parameter
        // that replaced it — and on a reasoning model it bounds the thinking as
        // well as the reply, so the reply ceiling alone leaves nothing to answer
        // with.
        max_completion_tokens: reasons
          ? request.maxOutputTokens + this.reasoningHeadroomTokens
          : request.maxOutputTokens,
        // Only where it is supported. Elsewhere it is a 400 on every call.
        ...(reasons ? { reasoning_effort: 'minimal' as const } : {}),
        messages: [
          // Stable half first, and byte-identical between turns. There is no
          // breakpoint to declare — the prefix match *is* the breakpoint, so
          // the ordering here is the whole of the cost story.
          { role: 'system', content: request.stableSystem },
          { role: 'system', content: request.volatileSystem },
          ...request.messages.map((m) => ({ role: m.role, content: m.text })),
        ],
      });

      const choice = response.choices[0];

      return {
        text: choice?.message.content ?? '',
        stop: normaliseStop(choice?.finish_reason ?? null, choice?.message.refusal ?? null),
        usage: normaliseUsage(response.usage),
        model: response.model,
      };
    } catch (err) {
      // `errorFields` truncates and the denylist scans field names, but this
      // vendor echoes the offending request back on a 400 — and the request
      // contains message content (I8). So nothing from it is logged, and the
      // failure is reported as a normalised outcome rather than thrown: a
      // persona that cannot answer stays quiet, and the supervisor decides what
      // to do about it.
      this.logger.warn('model provider call failed', {
        provider: this.name,
        model: this.model,
        ...errorFields(err),
      });
      return { text: '', stop: 'error', usage: NO_USAGE, model: this.model };
    }
  }
}

/**
 * Vendor stop reasons to ours.
 *
 * A declined generation reaches us two ways here, and they must both land on
 * `refused` rather than `error`: a `content_filter` finish reason, and a
 * populated `refusal` field on the message with an otherwise ordinary stop.
 * The distinction matters because `error` falls back to the scripted voice and
 * `refused` stays silent — falling back would put words in the persona's mouth
 * that the model has just declined to say.
 */
function normaliseStop(finishReason: string | null, refusal: string | null): ProviderStop {
  if (refusal !== null && refusal !== '') return 'refused';

  switch (finishReason) {
    case 'stop':
      return 'complete';
    case 'length':
      return 'truncated';
    case 'content_filter':
      return 'refused';
    case null:
      return 'complete';
    default:
      return 'complete';
  }
}

/**
 * Token usage, normalised — and this is where the vendors actually disagree.
 *
 * `prompt_tokens` is the **total** prompt, cached tokens included.
 * `ProviderUsage.inputTokens` means "billed at the full input rate", cached
 * tokens excluded, because that is what the other vendor reports and what
 * `costOf` prices. Subtracting is not a tidying step; passing the number
 * through would bill every cached token twice.
 *
 * Floored at zero. If a future response ever reports more cached tokens than
 * prompt tokens, a negative input count would *reduce* the recorded spend —
 * a budget that runs backwards is worse than one that over-counts.
 */
function normaliseUsage(usage: unknown): ProviderUsage {
  const read = (source: unknown, field: string): number => {
    if (typeof source !== 'object' || source === null) return 0;
    const value = (source as Record<string, unknown>)[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };

  const prompt = read(usage, 'prompt_tokens');
  const details =
    typeof usage === 'object' && usage !== null
      ? (usage as Record<string, unknown>)['prompt_tokens_details']
      : null;
  const cached = read(details, 'cached_tokens');

  return {
    inputTokens: Math.max(0, prompt - cached),
    outputTokens: read(usage, 'completion_tokens'),
    cacheReadTokens: cached,
    // No such charge exists with this vendor. Reporting a number here would
    // invent one.
    cacheWriteTokens: 0,
  };
}
