/**
 * A4 — the spend ceiling and the cost model.
 *
 * The claims worth testing are the ones that cost money when wrong:
 *
 *   - the ceiling actually stops calls
 *   - an unreadable budget refuses rather than spending
 *   - cost is computed from real usage, in integers, with cache tiers priced
 *     differently
 *   - an unpriced model cannot spend silently
 *   - the model voice falls back rather than going quiet
 */

import { PersonaBudget } from '../../src/personas/budget';
import { costOf, formatMicroCents, priceFor, MODEL_PRICES, NO_USAGE } from '../../src/personas/provider';
import type { ModelProvider, ProviderReply, ProviderUsage } from '../../src/personas/provider';
import { modelVoice } from '../../src/personas/voice-model';
import { CHARACTERS } from '../../src/personas/characters';
import type { PersonaVoice } from '../../src/personas/client';
import type { Logger } from '../../src/logger';
import type { Database } from '../../src/storage/pool';

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

const character = (() => {
  const first = CHARACTERS[0];
  if (first === undefined) throw new Error('population is empty');
  return first;
})();

/** A database holding one spend row, able to fail on demand. */
class FakeSpendDb {
  spent = 0;
  limit = 0;
  created = false;
  fail = false;
  updates = 0;

  async query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    if (this.fail) throw new Error('database unavailable');
    const sql = text.trim();

    if (sql.startsWith('insert')) {
      if (!this.created) {
        this.created = true;
        this.limit = Number(values[1]);
        this.spent = 0;
      }
      return { rows: [], rowCount: 1 };
    }

    if (sql.startsWith('select')) {
      const rows = [
        { spent_micro_cents: String(this.spent), limit_micro_cents: String(this.limit) },
      ] as unknown as T[];
      return { rows, rowCount: 1 };
    }

    // update ... returning
    this.updates += 1;
    this.spent += Number(values[1]);
    const rows = [
      { spent_micro_cents: String(this.spent), limit_micro_cents: String(this.limit) },
    ] as unknown as T[];
    return { rows, rowCount: 1 };
  }
}

function budgetWith(limit: number): { budget: PersonaBudget; db: FakeSpendDb } {
  const db = new FakeSpendDb();
  const budget = new PersonaBudget({
    db: db as unknown as Database,
    logger: silentLogger,
    monthlyLimitMicroCents: limit,
  });
  return { budget, db };
}

describe('the spend ceiling', () => {
  it('allows a call while under the limit', async () => {
    const { budget } = budgetWith(1_000_000);
    const check = await budget.check();
    expect(check.state).toBe('ok');
    expect(check.limit).toBe(1_000_000);
  });

  it('refuses once the limit is reached', async () => {
    const { budget } = budgetWith(1000);
    await budget.record(1000);
    expect((await budget.check()).state).toBe('exhausted');
  });

  it('refuses when spend overshoots, not only when it lands exactly', async () => {
    const { budget } = budgetWith(1000);
    const after = await budget.record(1500);
    expect(after.state).toBe('exhausted');
    expect(after.spent).toBe(1500);
  });

  it('accumulates across calls', async () => {
    const { budget } = budgetWith(1000);
    await budget.record(300);
    await budget.record(300);
    const check = await budget.check();
    expect(check.spent).toBe(600);
    expect(check.state).toBe('ok');
  });

  it('refuses to spend when the budget cannot be read', async () => {
    // Failing open costs whatever the outage lasts multiplied by the request
    // rate, discovered on an invoice. Failing closed costs one bot conversation.
    const { budget, db } = budgetWith(1_000_000);
    db.fail = true;
    expect((await budget.check()).state).toBe('unreadable');
  });

  it('rejects a negative cost rather than crediting the budget', async () => {
    const { budget } = budgetWith(1000);
    await expect(budget.record(-5)).rejects.toThrow(/cannot be negative/);
  });

  it('refuses to be constructed with a non-positive limit', () => {
    const db = new FakeSpendDb();
    expect(
      () =>
        new PersonaBudget({
          db: db as unknown as Database,
          logger: silentLogger,
          monthlyLimitMicroCents: 0,
        }),
    ).toThrow(/must be positive/);
  });

  it('keeps the period ceiling from the row, not from a later config change', async () => {
    // Lowering the limit mid-month must not retroactively make past spending
    // over budget, and a redeploy must not silently rewrite the ceiling.
    const db = new FakeSpendDb();
    const first = new PersonaBudget({
      db: db as unknown as Database,
      logger: silentLogger,
      monthlyLimitMicroCents: 5000,
    });
    await first.check();

    const second = new PersonaBudget({
      db: db as unknown as Database,
      logger: silentLogger,
      monthlyLimitMicroCents: 99_999,
    });
    expect((await second.check()).limit).toBe(5000);
  });
});

describe('the cost model', () => {
  const usage = (over: Partial<ProviderUsage>): ProviderUsage => ({ ...NO_USAGE, ...over });

  it('prices input and output differently', () => {
    const input = costOf('claude-haiku-4-5', usage({ inputTokens: 1_000_000 }));
    const output = costOf('claude-haiku-4-5', usage({ outputTokens: 1_000_000 }));
    expect(output).toBe(input * 5);
  });

  it('prices a cache read at a tenth of an input token', () => {
    // This ratio is the entire reason the prompt is split into a stable and a
    // volatile half. If it stops holding, the split stops paying.
    const input = costOf('claude-haiku-4-5', usage({ inputTokens: 1_000_000 }));
    const cached = costOf('claude-haiku-4-5', usage({ cacheReadTokens: 1_000_000 }));
    expect(cached * 10).toBe(input);
  });

  it('prices a cache write above an input token', () => {
    const input = costOf('claude-haiku-4-5', usage({ inputTokens: 1_000_000 }));
    const write = costOf('claude-haiku-4-5', usage({ cacheWriteTokens: 1_000_000 }));
    expect(write).toBeGreaterThan(input);
  });

  it('returns integers, because money is never a float here', () => {
    const cost = costOf('claude-haiku-4-5', usage({ inputTokens: 1337, outputTokens: 42 }));
    expect(Number.isInteger(cost)).toBe(true);
  });

  it('costs nothing for no usage', () => {
    expect(costOf('claude-haiku-4-5', NO_USAGE)).toBe(0);
  });

  it('refuses an unpriced model rather than defaulting to free', () => {
    // A default price is a budget that silently does not bind.
    expect(() => priceFor('some-new-model')).toThrow(/no price recorded/);
    expect(() => costOf('some-new-model', NO_USAGE)).toThrow(/no price recorded/);
  });

  it('prices the cheap tier below the expensive one', () => {
    const sample = usage({ inputTokens: 100_000, outputTokens: 2000 });
    expect(costOf('claude-haiku-4-5', sample)).toBeLessThan(costOf('claude-sonnet-5', sample));
    expect(costOf('claude-sonnet-5', sample)).toBeLessThan(costOf('claude-opus-5', sample));
  });

  it('prices every model it lists', () => {
    for (const model of Object.keys(MODEL_PRICES)) {
      expect(() => priceFor(model)).not.toThrow();
    }
  });

  it('puts a realistic reply in the fraction-of-a-cent range', () => {
    // The A4 estimate: ~1,300 cached prefix tokens, ~500 fresh, ~40 out.
    const cost = costOf(
      'claude-haiku-4-5',
      usage({ cacheReadTokens: 1300, inputTokens: 500, outputTokens: 40 }),
    );
    // $0.00083: 1300 cache reads at a tenth, 500 fresh input, 40 out. Ten of
    // these is a conversation, so roughly 0.75 rupees — which is the number the
    // cost work in D-AI-7 quotes, now checked rather than asserted in prose.
    expect(formatMicroCents(cost)).toBe('$0.0008');
    expect(cost * 10).toBeLessThan(costOf('claude-haiku-4-5', usage({ outputTokens: 20_000 })));
  });
});

/* -------------------------------------------------------------------------- */

/** A provider that returns whatever the test says, with no network. */
function stubProvider(reply: Partial<ProviderReply>): ModelProvider {
  return {
    name: 'stub',
    complete: async () => ({
      text: 'a model reply',
      stop: 'complete',
      usage: NO_USAGE,
      model: 'claude-haiku-4-5',
      ...reply,
    }),
  };
}

const fallback: PersonaVoice = { reply: () => 'fallback line' };

describe('the model voice', () => {
  it('returns what the model said', async () => {
    const { budget } = budgetWith(1_000_000);
    const voice = modelVoice({
      provider: stubProvider({ text: 'hello from the model' }),
      budget,
      character,
      surfaceDescription: 'Nadia, 31, GB',
      logger: silentLogger,
      fallback,
    });

    expect(await voice.reply({ character, sent: 1, incoming: 'hi' })).toBe('hello from the model');
  });

  it('falls back rather than going silent when the ceiling is reached', async () => {
    // A stranger who stops replying mid-conversation reads as rude or broken.
    const { budget } = budgetWith(100);
    await budget.record(100);

    const voice = modelVoice({
      provider: stubProvider({ text: 'should not be reached' }),
      budget,
      character,
      surfaceDescription: 'Nadia, 31, GB',
      logger: silentLogger,
      fallback,
    });

    expect(await voice.reply({ character, sent: 1 })).toBe('fallback line');
  });

  it('does not call the provider at all once exhausted', async () => {
    const { budget } = budgetWith(100);
    await budget.record(100);

    let calls = 0;
    const provider: ModelProvider = {
      name: 'counting',
      complete: async () => {
        calls += 1;
        return { text: 'x', stop: 'complete', usage: NO_USAGE, model: 'claude-haiku-4-5' };
      },
    };

    const voice = modelVoice({
      provider,
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    });
    await voice.reply({ character, sent: 1 });

    expect(calls).toBe(0);
  });

  it('falls back when the budget is unreadable, rather than spending to find out', async () => {
    const { budget, db } = budgetWith(1_000_000);
    db.fail = true;

    const voice = modelVoice({
      provider: stubProvider({}),
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    });

    expect(await voice.reply({ character, sent: 1 })).toBe('fallback line');
  });

  it('records spend from real usage, not an estimate', async () => {
    const { budget } = budgetWith(10_000_000);
    const spends: number[] = [];

    const voice = modelVoice({
      provider: stubProvider({
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 2000, cacheWriteTokens: 0 },
      }),
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
      onSpend: (e) => spends.push(e.costMicroCents),
    });

    await voice.reply({ character, sent: 1, incoming: 'hi' });

    const expected = costOf('claude-haiku-4-5', {
      inputTokens: 1000,
      outputTokens: 100,
      cacheReadTokens: 2000,
      cacheWriteTokens: 0,
    });
    expect(spends).toEqual([expected]);
    expect((await budget.check()).spent).toBe(expected);
  });

  it('counts a truncated call, because it still consumed tokens', async () => {
    const { budget } = budgetWith(10_000_000);
    const voice = modelVoice({
      provider: stubProvider({
        stop: 'truncated',
        usage: { inputTokens: 500, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    });

    await voice.reply({ character, sent: 1, incoming: 'hi' });
    expect((await budget.check()).spent).toBeGreaterThan(0);
  });

  it('says nothing on a refusal rather than putting words in its mouth', async () => {
    // A refusal is the model declining. Falling back would say something the
    // model just declined to say.
    const { budget } = budgetWith(10_000_000);
    const voice = modelVoice({
      provider: stubProvider({ stop: 'refused', text: '' }),
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    });

    expect(await voice.reply({ character, sent: 1 })).toBeNull();
  });

  it('falls back on a provider error', async () => {
    const { budget } = budgetWith(10_000_000);
    const voice = modelVoice({
      provider: stubProvider({ stop: 'error', text: '' }),
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    });

    expect(await voice.reply({ character, sent: 1 })).toBe('fallback line');
  });

  it('sends the character in the cacheable half and the surface in the volatile half', async () => {
    // Getting this backwards costs several times more with no error anywhere:
    // the surface is regenerated per conversation, so it would invalidate the
    // prefix on every single conversation.
    let captured: { stable: string; volatile: string } | null = null;
    const provider: ModelProvider = {
      name: 'capturing',
      complete: async (req) => {
        captured = { stable: req.stableSystem, volatile: req.volatileSystem };
        return { text: 'x', stop: 'complete', usage: NO_USAGE, model: 'claude-haiku-4-5' };
      },
    };

    const { budget } = budgetWith(10_000_000);
    const voice = modelVoice({
      provider,
      budget,
      character,
      surfaceDescription: 'Nadia, 31, GB',
      logger: silentLogger,
      fallback,
    });
    await voice.reply({ character, sent: 1, incoming: 'hi' });

    expect(captured).not.toBeNull();
    const seen = captured as unknown as { stable: string; volatile: string };
    expect(seen.stable).toContain(character.summary);
    expect(seen.stable).not.toContain('Nadia, 31, GB');
    expect(seen.volatile).toContain('Nadia, 31, GB');
  });

  it('tells the model never to deny being automated (D-AI-4)', async () => {
    // The prompt is not where the guarantee lives — A5 enforces it between the
    // model and the socket — but it should not be fighting the prompt either.
    let stable = '';
    const provider: ModelProvider = {
      name: 'capturing',
      complete: async (req) => {
        stable = req.stableSystem;
        return { text: 'x', stop: 'complete', usage: NO_USAGE, model: 'claude-haiku-4-5' };
      },
    };

    const { budget } = budgetWith(10_000_000);
    await modelVoice({
      provider,
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    }).reply({ character, sent: 1, incoming: 'hi' });

    expect(stable).toMatch(/never claim to be human/i);
    expect(stable).toMatch(/never ask for a real name/i);
  });

  it('keeps the conversation, so the model sees what was already said', async () => {
    const seen: number[] = [];
    const provider: ModelProvider = {
      name: 'capturing',
      complete: async (req) => {
        seen.push(req.messages.length);
        return { text: 'reply', stop: 'complete', usage: NO_USAGE, model: 'claude-haiku-4-5' };
      },
    };

    const { budget } = budgetWith(10_000_000);
    const voice = modelVoice({
      provider,
      budget,
      character,
      surfaceDescription: 's',
      logger: silentLogger,
      fallback,
    });

    await voice.reply({ character, sent: 1, incoming: 'hi' });
    await voice.reply({ character, sent: 1, incoming: 'hello' });
    await voice.reply({ character, sent: 2, incoming: 'and again' });

    // Opening turn is synthesised; after that the history grows.
    expect(seen[0]).toBe(1);
    expect(seen[1]).toBeGreaterThan(1);
    expect(seen[2]).toBeGreaterThan(seen[1] as number);
  });
});
