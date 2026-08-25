/**
 * The Anthropic adapter.
 *
 * **The only file in this repository that imports a model vendor's SDK**
 * (D-AI-10). If an import of `@anthropic-ai/sdk` appears anywhere else, the
 * abstraction has already failed and the second vendor will be expensive.
 *
 * ---------------------------------------------------------------------------
 * CACHING IS THE WHOLE COST STORY, AND IT IS A PREFIX MATCH
 * ---------------------------------------------------------------------------
 * The system prompt splits in two. `stableSystem` — the instructions and the
 * persona character — is identical for every turn of every conversation that
 * persona holds, so it is marked cacheable and read back at roughly a tenth of
 * the input price. `volatileSystem` — the generated surface, the session
 * summary — changes constantly and is sent *after* the breakpoint, where it
 * cannot invalidate anything.
 *
 * Get that order backwards and the cache never hits. There is no error; the
 * bill is simply several times larger, which is the kind of failure that is
 * discovered a month late.
 *
 * The counterintuitive consequence, recorded because it inverts the obvious
 * move: **trimming the persona character to save tokens can raise the bill.**
 * Below the minimum cacheable prefix the whole block silently stops caching and
 * goes from a tenth of the input price to full price. Keep the stable half
 * generous; trim the summary and the message window instead.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT USED
 * ---------------------------------------------------------------------------
 * No streaming. A persona sends one message when it is ready, and the reply
 * pause in the client is longer than the generation time at these lengths, so
 * streaming would add complexity to shave a delay that is deliberately there.
 *
 * No thinking. These are two-line chat replies in a character's voice; there is
 * nothing to reason about, and reasoning tokens are billed.
 */

import Anthropic from '@anthropic-ai/sdk';
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

export interface AnthropicProviderOptions {
  readonly apiKey: string;
  /**
   * Which model answers.
   *
   * Defaults to Haiku 4.5, which is the tier the cost work in D-AI-7 settled
   * on: casual two-line chat replies do not need a frontier model, and the
   * difference is roughly threefold on every message. Raising it is a
   * deliberate quality decision with a cost attached, taken with the ceiling
   * already in place.
   */
  readonly model?: string;
  readonly logger: Logger;
  readonly timeoutMs?: number;
  /** Injected in tests so no network is touched. */
  readonly client?: Pick<Anthropic, 'messages'>;
}

const DEFAULT_MODEL = 'claude-haiku-4-5';

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';

  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly model: string;
  private readonly logger: Logger;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.logger = options.logger;
    this.client =
      options.client ??
      new Anthropic({
        apiKey: options.apiKey,
        timeout: options.timeoutMs ?? 20_000,
        // Two retries is the SDK default and the right number here: a persona
        // that retries for a minute has already lost the conversation.
        maxRetries: 2,
      });
  }

  async complete(request: ProviderRequest): Promise<ProviderReply> {
    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxOutputTokens,
        system: [
          {
            type: 'text',
            text: request.stableSystem,
            // The one breakpoint. Everything before it is cached; everything
            // after it is not. Order matters more than anything else here.
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: request.volatileSystem },
        ],
        messages: request.messages.map((m) => ({
          role: m.role,
          content: m.text,
        })),
      });

      return {
        text: extractText(response.content),
        stop: normaliseStop(response.stop_reason),
        usage: normaliseUsage(response.usage),
        model: response.model,
      };
    } catch (err) {
      // `errorFields` truncates and the denylist scans field names, but a model
      // error can echo the prompt — which contains message content (I8). So
      // nothing from the request is logged, and the error is reported as a
      // normalised outcome rather than thrown: a persona that cannot answer
      // stays quiet, and the supervisor decides what to do about it.
      this.logger.warn('model provider call failed', {
        provider: this.name,
        model: this.model,
        ...errorFields(err),
      });
      return { text: '', stop: 'error', usage: NO_USAGE, model: this.model };
    }
  }
}

/** Concatenate the text blocks, ignoring anything else the model returned. */
function extractText(content: readonly unknown[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === 'object' &&
      block !== null &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block &&
      typeof (block as { text: unknown }).text === 'string'
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('').trim();
}

/**
 * Vendor stop reasons to ours.
 *
 * `refusal` matters most: a model declining is not an error and must not be
 * retried, and the persona layer needs to tell the two apart without knowing
 * this vendor's vocabulary.
 */
function normaliseStop(stopReason: string | null): ProviderStop {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'complete';
    case 'max_tokens':
      return 'truncated';
    case 'refusal':
      return 'refused';
    case null:
      return 'complete';
    default:
      return 'complete';
  }
}

function normaliseUsage(usage: unknown): ProviderUsage {
  const read = (field: string): number => {
    if (typeof usage !== 'object' || usage === null) return 0;
    const value = (usage as Record<string, unknown>)[field];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };

  return {
    inputTokens: read('input_tokens'),
    outputTokens: read('output_tokens'),
    cacheReadTokens: read('cache_read_input_tokens'),
    cacheWriteTokens: read('cache_creation_input_tokens'),
  };
}
