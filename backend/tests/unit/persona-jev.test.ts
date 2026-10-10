/**
 * Jev, the decision model beside the persona voice, and every way it can fail.
 *
 * The property that matters most is not that Jev's answers are used — it is
 * that every failure (timeout, refusal, malformed body, a host that is down)
 * comes back as `null` and costs the conversation nothing but the judgement.
 * The judge then reads the turn from rules, and the guard's word lists run
 * either way.
 */

import { jevClient, parseResult } from '../../src/personas/jev';
import type { JevClientOptions, JevOutcome } from '../../src/personas/jev';
import { personaJudge, ruleKind, RULES_ONLY_JUDGE } from '../../src/personas/judge';
import type { PersonaJudge, IncomingReading, OutgoingReading } from '../../src/personas/judge';
import { guardVoice, SEXUAL_DECLINES } from '../../src/personas/guard';
import type { PersonaVoice, VoiceTurn } from '../../src/personas/client';
import { CHARACTERS } from '../../src/personas/characters';
import type { PersonaCharacter } from '../../src/personas/types';

const character: PersonaCharacter = (() => {
  const first = CHARACTERS[0];
  if (first === undefined) throw new Error('population is empty');
  return first;
})();

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as JevClientOptions['logger'];

const QUESTIONS = { kind: { type: 'noul' as const, instructions: 'q' } };

function okBody(noul = 0.9): unknown {
  return {
    model: 'jev-1.13.0',
    answers: { kind: { type: 'noul', noul } },
    usage: { input_tokens: 300, output_tokens: 20 },
  };
}

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

interface Call {
  url: string;
  auth: string | null;
  body: Record<string, unknown>;
}

function fakeFetch(handler: (call: Call, n: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const call: Call = {
      url: String(input),
      auth: headers.get('Authorization'),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    return handler(call, calls.length);
  }) as typeof fetch;
  return { fetch: f, calls };
}

function client(
  f: typeof fetch,
  extra: Partial<JevClientOptions> = {},
): { jev: ReturnType<typeof jevClient>; outcomes: Array<[number, JevOutcome]>; clock: { t: number } } {
  const outcomes: Array<[number, JevOutcome]> = [];
  const clock = { t: 1_000 };
  const jev = jevClient({
    hosts: [
      { url: 'https://primary.test/', apiKey: 'k1' },
      { url: 'https://fallback.test', apiKey: 'k2' },
    ],
    model: 'jev-latest',
    timeoutMs: 1000,
    breakerThreshold: 2,
    breakerCooldownMs: 60_000,
    logger,
    fetch: f,
    now: () => clock.t,
    onCall: (host, outcome) => outcomes.push([host, outcome]),
    ...extra,
  });
  return { jev, outcomes, clock };
}

describe('the Jev client', () => {
  it('sends the documented request shape to the first host', async () => {
    const { fetch, calls } = fakeFetch(() => respond(200, okBody()));
    const { jev } = client(fetch);

    const result = await jev.ask('STATE', QUESTIONS);

    expect(result?.answers['kind']).toEqual({ type: 'noul', noul: 0.9 });
    expect(result?.usage).toEqual({ inputTokens: 300, outputTokens: 20 });
    expect(calls[0]?.url).toBe('https://primary.test/v1/systemone');
    expect(calls[0]?.auth).toBe('Bearer k1');
    expect(calls[0]?.body).toEqual({ model: 'jev-latest', state: 'STATE', questions: QUESTIONS });
  });

  it('falls through to the second host when the first fails', async () => {
    const { fetch, calls } = fakeFetch((call) =>
      call.url.startsWith('https://primary') ? respond(529, {}) : respond(200, okBody()),
    );
    const { jev, outcomes } = client(fetch);

    const result = await jev.ask('s', QUESTIONS);

    expect(result).not.toBeNull();
    expect(calls.map((c) => c.auth)).toEqual(['Bearer k1', 'Bearer k2']);
    expect(outcomes).toEqual([
      [0, 'rate_limited'],
      [1, 'ok'],
    ]);
  });

  it('returns null, never throws, when every host fails', async () => {
    const { fetch } = fakeFetch(() => {
      throw new TypeError('fetch failed');
    });
    const { jev, outcomes } = client(fetch);

    await expect(jev.ask('s', QUESTIONS)).resolves.toBeNull();
    expect(outcomes).toEqual([
      [0, 'network'],
      [1, 'network'],
    ]);
  });

  it('reports a timeout as a timeout', async () => {
    const { fetch } = fakeFetch(() => {
      const err = new Error('timed out');
      err.name = 'TimeoutError';
      throw err;
    });
    const { jev, outcomes } = client(fetch);

    expect(await jev.ask('s', QUESTIONS)).toBeNull();
    expect(outcomes[0]).toEqual([0, 'timeout']);
  });

  it('skips a host whose breaker is open, then tries it again after the cooldown', async () => {
    let primaryUp = false;
    const { fetch, calls } = fakeFetch((call) =>
      call.url.startsWith('https://primary') && !primaryUp ? respond(500, {}) : respond(200, okBody()),
    );
    const { jev, outcomes, clock } = client(fetch);

    await jev.ask('s', QUESTIONS); // primary fails once
    await jev.ask('s', QUESTIONS); // primary fails twice: breaker opens
    const before = calls.filter((c) => c.url.startsWith('https://primary')).length;
    await jev.ask('s', QUESTIONS); // primary skipped
    expect(calls.filter((c) => c.url.startsWith('https://primary')).length).toBe(before);
    expect(outcomes).toContainEqual([0, 'breaker_open']);

    primaryUp = true;
    clock.t += 60_001;
    outcomes.length = 0;
    await jev.ask('s', QUESTIONS);
    expect(outcomes).toEqual([[0, 'ok']]);
  });

  it('does not open the breaker on a malformed body, which is the host answering', async () => {
    const { fetch } = fakeFetch((call) =>
      call.url.startsWith('https://primary') ? respond(200, { nonsense: true }) : respond(200, okBody()),
    );
    const { jev, outcomes } = client(fetch);

    for (let i = 0; i < 4; i += 1) await jev.ask('s', QUESTIONS);
    expect(outcomes.filter(([host, o]) => host === 0 && o === 'breaker_open')).toHaveLength(0);
  });

  it('is off with no hosts, and asks nothing', async () => {
    const { fetch, calls } = fakeFetch(() => respond(200, okBody()));
    const jev = jevClient({
      hosts: [],
      model: 'jev-latest',
      timeoutMs: 1000,
      breakerThreshold: 2,
      breakerCooldownMs: 1000,
      logger,
      fetch,
    });

    expect(jev.enabled).toBe(false);
    expect(await jev.ask('s', QUESTIONS)).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('parsing an answer', () => {
  it('refuses the whole result when any asked question is missing', () => {
    expect(parseResult(okBody(), ['kind', 'other'])).toBeNull();
  });

  it('refuses a probability outside zero to one', () => {
    expect(parseResult({ answers: { kind: { type: 'noul', noul: 1.5 } } }, ['kind'])).toBeNull();
  });

  it('reads a score, which can fall between two levels', () => {
    const parsed = parseResult(
      {
        model: 'jev-1.13.0',
        answers: { urgency: { type: 'score', score: 2.4, confidence: 0.7, legend: {}, probabilities: { '2': 0.6, '3': 0.4 } } },
      },
      ['urgency'],
    );
    expect(parsed?.answers['urgency']).toEqual({
      type: 'score',
      score: 2.4,
      confidence: 0.7,
      probabilities: { '2': 0.6, '3': 0.4 },
    });
  });

  it('refuses a score without a number', () => {
    expect(parseResult({ answers: { urgency: { type: 'score', confidence: 0.7 } } }, ['urgency'])).toBeNull();
  });

  it('reads a choice with its confidence', () => {
    const parsed = parseResult(
      {
        model: 'jev-1.13.0',
        answers: {
          kind: { type: 'choice', choice: 'greeting', confidence: 0.93, probabilities: { greeting: 0.95, question: 0.05 } },
        },
      },
      ['kind'],
    );
    expect(parsed?.answers['kind']).toEqual({
      type: 'choice',
      choice: 'greeting',
      confidence: 0.93,
      probabilities: { greeting: 0.95, question: 0.05 },
    });
  });
});

describe('the turn kind without Jev', () => {
  const NL = String.fromCharCode(10);

  it.each([
    ['hi', 'greeting'],
    ['heyy', 'greeting'],
    ['hello!', 'greeting'],
    ['hi' + NL + 'hey', 'greeting'],
    ['where are you from', 'question'],
    ['kaha se ho?', 'question'],
    ['hi' + NL + 'how are you', 'question'],
    ['bye', 'goodbye'],
    ['gtg', 'goodbye'],
    ['long day at work', 'statement'],
    ['hi im bored', 'statement'],
  ])('reads %j as %s', (text, kind) => {
    expect(ruleKind(text)).toBe(kind);
  });
});

describe('the judge', () => {
  function jevAnswering(answers: Record<string, unknown> | null): {
    enabled: boolean;
    ask: jest.Mock;
  } {
    return {
      enabled: true,
      ask: jest.fn(async () =>
        answers === null ? null : { model: 'jev-1.13.0', answers, usage: { inputTokens: 1_000_000, outputTokens: 5 } },
      ),
    };
  }

  const incomingAnswers = (over: Record<string, number> = {}, kind = 'greeting', confidence = 0.9) => ({
    kind: { type: 'choice', choice: kind, confidence, probabilities: {} },
    sexual: { type: 'noul', noul: over['sexual'] ?? 0.01 },
    minor: { type: 'noul', noul: over['minor'] ?? 0.01 },
    crisis: { type: 'noul', noul: over['crisis'] ?? 0.01 },
    identity: { type: 'noul', noul: over['identity'] ?? 0.01 },
  });

  it('uses Jev\'s reading of the turn when it answers', async () => {
    const judge = personaJudge({
      jev: jevAnswering(incomingAnswers({}, 'question')),
      logger,
      minConfidence: 0.8,
      inputMicroCentsPerMTok: 6_000_000,
    });
    const reading = await judge.readIncoming('hmm', []);
    expect(reading.kind).toBe('question');
    expect(reading.source).toBe('jev');
  });

  it('falls back to the rules when Jev answers nothing', async () => {
    const judge = personaJudge({
      jev: jevAnswering(null),
      logger,
      minConfidence: 0.8,
      inputMicroCentsPerMTok: 6_000_000,
    });
    const reading = await judge.readIncoming('hi', []);
    expect(reading).toEqual({
      kind: 'greeting',
      sexual: false,
      minor: false,
      crisis: false,
      identity: false,
      source: 'rules',
    });
  });

  it('counts a flag only at or above the confidence threshold', async () => {
    const judge = personaJudge({
      jev: jevAnswering(incomingAnswers({ sexual: 0.79, minor: 0.8 })),
      logger,
      minConfidence: 0.8,
      inputMicroCentsPerMTok: 6_000_000,
    });
    const reading = await judge.readIncoming('x', []);
    expect(reading.sexual).toBe(false);
    expect(reading.minor).toBe(true);
  });

  it('keeps the rule\'s kind when Jev is unsure of its own', async () => {
    const judge = personaJudge({
      jev: jevAnswering(incomingAnswers({}, 'statement', 0.4)),
      logger,
      minConfidence: 0.8,
      inputMicroCentsPerMTok: 6_000_000,
    });
    expect((await judge.readIncoming('hi', [])).kind).toBe('greeting');
  });

  it('charges what Jev reported against the persona budget', async () => {
    const recorded: number[] = [];
    const spent: number[] = [];
    const judge = personaJudge({
      jev: jevAnswering(incomingAnswers()),
      logger,
      minConfidence: 0.8,
      inputMicroCentsPerMTok: 6_000_000,
      budget: { record: async (c: number) => recorded.push(c) },
      onSpend: (e) => spent.push(e.costMicroCents),
    });
    await judge.readIncoming('hi', []);
    // One million input tokens at $0.06 per million.
    expect(recorded).toEqual([6_000_000]);
    expect(spent).toEqual([6_000_000]);
  });

  it('calls a draft irrelevant only when Jev is confident it is', async () => {
    const outgoing = (relevant: number) => ({
      relevant: { type: 'noul', noul: relevant },
      sexual: { type: 'noul', noul: 0 },
      solicits: { type: 'noul', noul: 0 },
      claimsHuman: { type: 'noul', noul: 0 },
    });
    const judgeFor = (p: number): PersonaJudge =>
      personaJudge({ jev: jevAnswering(outgoing(p)), logger, minConfidence: 0.8, inputMicroCentsPerMTok: 0 });

    expect((await judgeFor(0.1).readOutgoing('d', 'hi', [])).relevant).toBe(false);
    expect((await judgeFor(0.3).readOutgoing('d', 'hi', [])).relevant).toBe(true);
  });

  it('never sends conversation text anywhere when Jev is off', async () => {
    const jev = { enabled: false, ask: jest.fn() };
    const judge = personaJudge({ jev, logger, minConfidence: 0.8, inputMicroCentsPerMTok: 0 });
    await judge.readIncoming('hi', []);
    await judge.readOutgoing('hey', 'hi', []);
    expect(jev.ask).not.toHaveBeenCalled();
  });
});

describe('the guard with a judge', () => {
  const turn = (incoming: string): VoiceTurn => ({
    character,
    sent: 1,
    incoming,
    transcript: [{ role: 'stranger', text: incoming }],
  });

  const reading = (over: Partial<IncomingReading> = {}): IncomingReading => ({
    kind: 'statement',
    sexual: false,
    minor: false,
    crisis: false,
    identity: false,
    source: 'jev',
    ...over,
  });

  const clean: OutgoingReading = {
    relevant: true,
    sexual: false,
    solicits: false,
    claimsHuman: false,
    source: 'jev',
  };

  function judgeWith(
    incoming: IncomingReading,
    outgoing: OutgoingReading[] | OutgoingReading = clean,
  ): PersonaJudge {
    const queue = Array.isArray(outgoing) ? [...outgoing] : null;
    return {
      readIncoming: async () => incoming,
      readOutgoing: async () => (queue === null ? (outgoing as OutgoingReading) : (queue.shift() ?? clean)),
    };
  }

  function voiceSaying(...lines: string[]): PersonaVoice & { turns: VoiceTurn[] } {
    const turns: VoiceTurn[] = [];
    return {
      turns,
      reply(t: VoiceTurn): string | null {
        turns.push(t);
        return lines[turns.length - 1] ?? null;
      },
    };
  }

  it('declines on a Jev sexual flag the word lists missed', async () => {
    const inner = voiceSaying('should not be reached');
    const voice = guardVoice({ inner, logger, judge: judgeWith(reading({ sexual: true })) });

    const said = await voice.reply(turn('something the lists do not catch'));
    expect(SEXUAL_DECLINES).toContain(said);
    expect(inner.turns).toHaveLength(0);
  });

  it('still declines on the word lists when Jev is down — it can only add, never remove', async () => {
    const inner = voiceSaying('should not be reached');
    const voice = guardVoice({ inner, logger, judge: RULES_ONLY_JUDGE });

    const said = await voice.reply(turn('talk dirty to me'));
    expect(SEXUAL_DECLINES).toContain(said);
    expect(inner.turns).toHaveLength(0);
  });

  it('still declines on the word lists when Jev says everything is fine', async () => {
    const inner = voiceSaying('should not be reached');
    const voice = guardVoice({ inner, logger, judge: judgeWith(reading({ sexual: false })) });

    expect(SEXUAL_DECLINES).toContain(await voice.reply(turn('talk dirty to me')));
  });

  it('hands the reading to the voice, so the model knows what kind of turn it is', async () => {
    const inner = voiceSaying('hii, whats up');
    const voice = guardVoice({ inner, logger, judge: judgeWith(reading({ kind: 'greeting' })) });

    await voice.reply(turn('hi'));
    expect(inner.turns[0]?.reading?.kind).toBe('greeting');
  });

  it('regenerates once when Jev is confident the draft does not answer them', async () => {
    const inner = voiceSaying('haan and you?', 'hii, whats up');
    const regenerated: number[] = [];
    const voice = guardVoice({
      inner,
      logger,
      judge: judgeWith(reading({ kind: 'greeting' }), [{ ...clean, relevant: false }, clean]),
      events: { onRegenerate: () => regenerated.push(1) },
    });

    expect(await voice.reply(turn('hi'))).toBe('hii, whats up');
    expect(regenerated).toHaveLength(1);
    expect(inner.turns[1]?.retryNote).toBeDefined();
  });

  it('regenerates at most once, and sends the second draft if it is safe', async () => {
    const inner = voiceSaying('off one', 'off two', 'never asked for');
    const voice = guardVoice({
      inner,
      logger,
      judge: judgeWith(reading(), { ...clean, relevant: false }),
    });

    expect(await voice.reply(turn('hi'))).toBe('off two');
    expect(inner.turns).toHaveLength(2);
  });

  it('suppresses a draft Jev finds soliciting, and does not regenerate it', async () => {
    const inner = voiceSaying('what is your insta', 'second');
    const trips: string[] = [];
    const voice = guardVoice({
      inner,
      logger,
      judge: judgeWith(reading(), { ...clean, relevant: false, solicits: true }),
      events: { onTrip: (t) => trips.push(t.limit) },
    });

    expect(await voice.reply(turn('hi'))).toBeNull();
    expect(inner.turns).toHaveLength(1);
    expect(trips).toContain('personal_info');
  });

  it('runs the safety checks again on a regenerated draft', async () => {
    const inner = voiceSaying('irrelevant', 'add me on snap');
    const voice = guardVoice({
      inner,
      logger,
      judge: judgeWith(reading(), [{ ...clean, relevant: false }, { ...clean, solicits: true }]),
    });

    expect(await voice.reply(turn('hi'))).toBeNull();
  });

  it('reads the turn from rules if the judge throws, rather than going quiet', async () => {
    const inner = voiceSaying('hii');
    const broken: PersonaJudge = {
      readIncoming: async () => {
        throw new Error('judge exploded');
      },
      readOutgoing: async () => {
        throw new Error('judge exploded');
      },
    };
    const voice = guardVoice({ inner, logger, judge: broken });

    expect(await voice.reply(turn('hi'))).toBe('hii');
    expect(inner.turns[0]?.reading?.source).toBe('rules');
  });
});
