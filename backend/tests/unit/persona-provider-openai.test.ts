/**
 * The OpenAI adapter, and the places the two vendors disagree.
 *
 * These assert the translation, not the model. What is checkable here is the
 * request shape, the stop-reason mapping and — the reason most of this file
 * exists — the usage arithmetic, because the two vendors mean different things
 * by "input tokens" and the difference is a double-billed cache read on every
 * turn of every conversation.
 */

import { OpenAIProvider } from '../../src/personas/provider-openai';
import { costOf, priceFor, MODEL_PRICES, PROVIDER_MODELS } from '../../src/personas/provider';
import type { ProviderRequest } from '../../src/personas/provider';

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Parameters<typeof buildProvider>[0]['logger'];

interface FakeCompletion {
  readonly choices: ReadonlyArray<{
    readonly message: { content: string | null; refusal?: string | null };
    readonly finish_reason: string | null;
  }>;
  readonly usage?: unknown;
  readonly model: string;
}

/** A client that records what it was asked and answers with a canned response. */
function fakeClient(response: FakeCompletion | (() => never)): {
  client: { chat: { completions: { create: (body: unknown) => Promise<unknown> } } };
  bodies: Array<Record<string, unknown>>;
} {
  const bodies: Array<Record<string, unknown>> = [];
  return {
    bodies,
    client: {
      chat: {
        completions: {
          create: async (body: unknown): Promise<unknown> => {
            bodies.push(body as Record<string, unknown>);
            if (typeof response === 'function') response();
            return response;
          },
        },
      },
    },
  };
}

function buildProvider(options: {
  response: FakeCompletion | (() => never);
  model?: string;
  logger?: unknown;
}): {
  provider: OpenAIProvider;
  bodies: Array<Record<string, unknown>>;
} {
  const { client, bodies } = fakeClient(options.response);
  const provider = new OpenAIProvider({
    apiKey: 'test-key',
    logger: (options.logger ?? logger) as never,
    ...(options.model === undefined ? {} : { model: options.model }),
    client: client as never,
  });
  return { provider, bodies };
}

const request: ProviderRequest = {
  stableSystem: 'STABLE HALF',
  volatileSystem: 'VOLATILE HALF',
  messages: [
    { role: 'user', text: 'hey' },
    { role: 'assistant', text: 'hey yourself' },
    { role: 'user', text: 'where are you from?' },
  ],
  maxOutputTokens: 300,
};

const ok: FakeCompletion = {
  choices: [{ message: { content: 'somewhere boring honestly' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 1000, completion_tokens: 20 },
  model: 'gpt-5-mini',
};

describe('the request it builds', () => {
  it('sends the stable half first, because the prefix match is the breakpoint', async () => {
    // There is no cache_control to declare with this vendor. Ordering is the
    // whole of the cost story: volatile-first would silently stop caching.
    const { provider, bodies } = buildProvider({ response: ok });
    await provider.complete(request);

    const messages = bodies[0]?.['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: 'system', content: 'STABLE HALF' });
    expect(messages[1]).toEqual({ role: 'system', content: 'VOLATILE HALF' });
  });

  it('carries the conversation after the two system turns, in order', async () => {
    const { provider, bodies } = buildProvider({ response: ok });
    await provider.complete(request);

    const messages = bodies[0]?.['messages'] as Array<{ role: string; content: string }>;
    expect(messages.slice(2)).toEqual([
      { role: 'user', content: 'hey' },
      { role: 'assistant', content: 'hey yourself' },
      { role: 'user', content: 'where are you from?' },
    ]);
  });

  it('caps the reply with max_completion_tokens, which replaced max_tokens', async () => {
    // The newer models refuse `max_tokens` outright.
    const { provider, bodies } = buildProvider({ response: ok, model: 'gpt-4o-mini' });
    await provider.complete(request);

    expect(bodies[0]?.['max_completion_tokens']).toBe(300);
    expect(bodies[0]?.['max_tokens']).toBeUndefined();
  });

  it('sends no sampling parameters, which the newer models reject', async () => {
    const { provider, bodies } = buildProvider({ response: ok });
    await provider.complete(request);

    expect(bodies[0]?.['temperature']).toBeUndefined();
    expect(bodies[0]?.['top_p']).toBeUndefined();
  });

  it('defaults to the cheap tier rather than a frontier model', async () => {
    const { provider, bodies } = buildProvider({ response: ok });
    await provider.complete(request);

    expect(bodies[0]?.['model']).toBe('gpt-5-mini');
  });
});

describe('reasoning models, which reason unless told not to', () => {
  it('tells a reasoning model not to reason', async () => {
    // There is nothing to reason about in a two-line chat reply, and reasoning
    // tokens are billed at the output rate.
    const { provider, bodies } = buildProvider({ response: ok, model: 'gpt-5-mini' });
    await provider.complete(request);

    expect(bodies[0]?.['reasoning_effort']).toBe('minimal');
  });

  it('leaves room above the reply ceiling for it to think in', async () => {
    // `max_completion_tokens` bounds reasoning *plus* output. At the bare reply
    // ceiling the model spent the whole allowance thinking and returned an
    // empty string, so a stranger saw a greeting and then silence.
    const { provider, bodies } = buildProvider({ response: ok, model: 'gpt-5-mini' });
    await provider.complete(request);

    expect(bodies[0]?.['max_completion_tokens']).toBeGreaterThan(300);
  });

  it('sends neither parameter to a model that does not reason', async () => {
    // Sending it where it is unsupported is a 400 on every call, which the
    // scripted fallback would quietly absorb.
    const { provider, bodies } = buildProvider({ response: ok, model: 'gpt-4o-mini' });
    await provider.complete(request);

    expect(bodies[0]?.['reasoning_effort']).toBeUndefined();
    expect(bodies[0]?.['max_completion_tokens']).toBe(300);
  });
});

describe('usage, where the vendors disagree', () => {
  it('subtracts cached tokens from the input count — this is the double-bill', async () => {
    // `prompt_tokens` INCLUDES cached tokens here and EXCLUDES them at
    // Anthropic. Passing it through would charge every cached token twice:
    // once at the full input rate and once at the cached rate, so the ceiling
    // binds early and every persona drops to the scripted voice.
    const { provider } = buildProvider({
      response: {
        ...ok,
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      },
    });

    const reply = await provider.complete(request);
    expect(reply.usage.inputTokens).toBe(100);
    expect(reply.usage.cacheReadTokens).toBe(900);
  });

  it('reports no cache writes, because this vendor does not charge for them', async () => {
    const { provider } = buildProvider({ response: ok });
    expect((await provider.complete(request)).usage.cacheWriteTokens).toBe(0);
  });

  it('never lets a strange response drive the recorded spend negative', async () => {
    // A budget that runs backwards is worse than one that over-counts.
    const { provider } = buildProvider({
      response: {
        ...ok,
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_tokens_details: { cached_tokens: 9999 },
        },
      },
    });

    expect((await provider.complete(request)).usage.inputTokens).toBe(0);
  });

  it('reports zeroes rather than throwing when usage is missing entirely', async () => {
    const { provider } = buildProvider({
      response: { ...ok, usage: undefined },
    });

    const reply = await provider.complete(request);
    expect(reply.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('produces a cost the budget can actually charge', async () => {
    const { provider } = buildProvider({
      response: {
        ...ok,
        usage: {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      },
    });

    const reply = await provider.complete(request);
    expect(costOf(reply.model, reply.usage)).toBe(priceFor('gpt-5-mini').inputMicroCentsPerMTok);
  });
});

describe('why generation stopped', () => {
  const stopped = (finish: string | null, refusal?: string | null): FakeCompletion => ({
    choices: [
      {
        message: { content: 'text', ...(refusal === undefined ? {} : { refusal }) },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    model: 'gpt-5-mini',
  });

  it('maps a normal finish to complete', async () => {
    const { provider } = buildProvider({ response: stopped('stop') });
    expect((await provider.complete(request)).stop).toBe('complete');
  });

  it('maps the token cap to truncated', async () => {
    const { provider } = buildProvider({ response: stopped('length') });
    expect((await provider.complete(request)).stop).toBe('truncated');
  });

  it('maps a content filter to refused, never to error', async () => {
    // `error` falls back to the scripted voice and `refused` stays silent.
    // Falling back would put words in the persona's mouth that the model just
    // declined to say.
    const { provider } = buildProvider({ response: stopped('content_filter') });
    expect((await provider.complete(request)).stop).toBe('refused');
  });

  it('treats a populated refusal field as a refusal, whatever the finish reason', async () => {
    const { provider } = buildProvider({ response: stopped('stop', 'I cannot help with that') });
    expect((await provider.complete(request)).stop).toBe('refused');
  });

  it('treats an unknown finish reason as complete rather than failing', async () => {
    const { provider } = buildProvider({ response: stopped('something_new') });
    expect((await provider.complete(request)).stop).toBe('complete');
  });
});

describe('when the call fails', () => {
  it('reports an outcome rather than throwing at the conversation', async () => {
    const { provider } = buildProvider({
      response: () => {
        throw new Error('connection reset');
      },
    });

    const reply = await provider.complete(request);
    expect(reply.stop).toBe('error');
    expect(reply.text).toBe('');
  });

  it('logs nothing from the request, because the request holds message content', async () => {
    // This vendor echoes the offending request back on a 400, and the request
    // contains what a stranger typed (I8).
    const logged: Array<Record<string, unknown>> = [];
    const capturing = {
      debug: () => undefined,
      info: () => undefined,
      warn: (_message: string, fields?: Record<string, unknown>) => {
        logged.push(fields ?? {});
      },
      error: () => undefined,
    };

    const { provider } = buildProvider({
      logger: capturing,
      response: () => {
        throw new Error('400 Bad Request: where are you from?');
      },
    });

    await provider.complete(request);

    const serialised = JSON.stringify(logged);
    expect(serialised).not.toContain('STABLE HALF');
    expect(serialised).not.toContain('hey yourself');
  });

  it('answers with empty text when the response carries no choices', async () => {
    const { provider } = buildProvider({
      response: { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 }, model: 'gpt-5-mini' },
    });

    const reply = await provider.complete(request);
    expect(reply.text).toBe('');
  });
});

describe('the dated snapshot id the vendor answers with', () => {
  it('prices a dated snapshot as the model it is a snapshot of', () => {
    // Asked for `gpt-5-mini`, the API answers `gpt-5-mini-2025-08-07`. That id
    // had no price row, so every call threw, `safeCost` downgraded it to a
    // zero, and the monthly ceiling counted nothing at all.
    expect(priceFor('gpt-5-mini-2025-08-07')).toEqual(priceFor('gpt-5-mini'));
  });

  it('handles the other vendor: an undashed date spelling', () => {
    expect(priceFor('claude-haiku-4-5-20251001')).toEqual(priceFor('claude-haiku-4-5'));
  });

  it('still refuses a model that is not a snapshot of anything priced', () => {
    // A genuinely unknown model must not be given a default price.
    expect(() => priceFor('gpt-9-mini-2027-01-01')).toThrow(/no price recorded/);
    expect(() => priceFor('some-new-model')).toThrow(/no price recorded/);
  });

  it('charges a dated snapshot what the model costs, not nothing', () => {
    const cost = costOf('gpt-5-mini-2025-08-07', {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBe(priceFor('gpt-5-mini').inputMicroCentsPerMTok);
  });
});

describe('the model catalogue', () => {
  it('prices every model each provider offers, so no pairing can be unpriced', async () => {
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const model of models) {
        expect(MODEL_PRICES[model]).toBeDefined();
      }
    }
  });

  it('gives no model to two providers, because the pairing check would be moot', async () => {
    const seen = new Set<string>();
    for (const models of Object.values(PROVIDER_MODELS)) {
      for (const model of models) {
        expect(seen.has(model)).toBe(false);
        seen.add(model);
      }
    }
  });

  it('charges nothing to write the cache on any OpenAI model', async () => {
    // Not an omission: the charge does not exist with this vendor, and a
    // non-zero number here would invent one.
    for (const model of PROVIDER_MODELS['openai'] ?? []) {
      expect(priceFor(model).cacheWriteMicroCentsPerMTok).toBe(0);
    }
  });

  it('keeps a cache read cheaper than a fresh input token everywhere', async () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.cacheReadMicroCentsPerMTok).toBeLessThan(price.inputMicroCentsPerMTok);
      expect(model).not.toBe('');
    }
  });
});
