/**
 * A4 — the model-backed voice, and the one thing about it that must never
 * regress.
 *
 * The Messages API requires `messages[0]` to carry the `user` role. A persona
 * opens the conversation, so its transcript naturally begins with its own
 * `assistant` turn, and every call after the opening line was rejected. The
 * adapter turns a rejection into `stop: 'error'`, and `stop: 'error'` falls
 * back to the scripted voice — so the persona kept talking and the failure
 * never surfaced as one. What a user saw was a stranger who opened with a non
 * sequitur and then answered "where are you from?" with a line about
 * houseplants.
 *
 * These assert the shape of the request rather than the quality of the reply,
 * because the shape is what was broken and the shape is checkable.
 */

import { modelVoice } from '../../src/personas/voice-model';
import type { PersonaBudget } from '../../src/personas/budget';
import type { PersonaVoice, VoiceTurn } from '../../src/personas/client';
import type {
  ModelProvider,
  ProviderReply,
  ProviderRequest,
} from '../../src/personas/provider';
import { NO_USAGE } from '../../src/personas/provider';
import { CHARACTERS } from '../../src/personas/characters';
import type { PersonaCharacter } from '../../src/personas/types';
import type { TranscriptLine } from '../../src/personas/judge';

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
} as unknown as Parameters<typeof modelVoice>[0]['logger'];

/** Records every request and answers with a fixed line. */
function recordingProvider(): { provider: ModelProvider; requests: ProviderRequest[] } {
  const requests: ProviderRequest[] = [];
  const provider: ModelProvider = {
    name: 'test',
    async complete(request: ProviderRequest): Promise<ProviderReply> {
      requests.push(request);
      return {
        text: 'a reply',
        stop: 'complete',
        usage: NO_USAGE,
        model: 'claude-haiku-4-5',
      };
    },
  };
  return { provider, requests };
}

const okBudget = {
  check: async () => ({ state: 'ok' as const, spent: 0, limit: 100 }),
  record: async () => ({ state: 'ok' as const, spent: 0, limit: 100 }),
} as unknown as PersonaBudget;

/** A fallback that is never supposed to run, and says so if it does. */
const loudFallback: PersonaVoice = {
  reply: () => 'THE FALLBACK RAN',
};

/**
 * The conversation so far, kept the way the client keeps it: the stranger's
 * lines as `turn` delivers them and the persona's as `build`'s voice returns
 * them. The voice holds no history of its own any more.
 */
let log: TranscriptLine[] = [];
beforeEach(() => {
  log = [];
});

function build(provider: ModelProvider): PersonaVoice {
  const voice = modelVoice({
    provider,
    budget: okBudget,
    character,
    surfaceDescription: 'Ana, 24, female, India',
    logger,
    fallback: loudFallback,
  });
  return {
    async reply(t: VoiceTurn): Promise<string | null> {
      const said = await voice.reply(t);
      if (said !== null) log.push({ role: 'persona', text: said });
      return said;
    },
  };
}

const turn = (sent: number, incoming?: string): VoiceTurn => {
  if (incoming !== undefined) log.push({ role: 'stranger', text: incoming });
  return {
    character,
    sent,
    transcript: [...log],
    ...(incoming === undefined ? {} : { incoming }),
  };
};

describe('the shape of every request', () => {
  it('is user-first once the persona has spoken — this was the bug', async () => {
    // The first generated turn is the one that used to be rejected: history
    // was [assistant, user] and the API refuses a list that starts with the
    // assistant. Every reply after the opening line came from the fallback.
    const { provider, requests } = recordingProvider();
    const voice = build(provider);

    await voice.reply(turn(0));
    const second = await voice.reply(turn(1, 'hi'));

    expect(second).toBe('a reply');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.role).toBe('user');
  });

  it('stays user-first across a long conversation, where the window cuts', async () => {
    // The window slices the last N turns, and a slice can land on an assistant
    // turn even with a user-first transcript. Losing one line of context is a
    // rounding error; losing every call is not.
    const { provider, requests } = recordingProvider();
    const voice = build(provider);

    await voice.reply(turn(0));
    for (let i = 1; i <= 12; i += 1) {
      await voice.reply(turn(i, `message ${i}`));
    }

    expect(requests).toHaveLength(12);
    for (const request of requests) {
      expect(request.messages.length).toBeGreaterThan(0);
      expect(request.messages[0]?.role).toBe('user');
    }
  });

  it('carries what the stranger actually said, so a reply can be a reply', async () => {
    const { provider, requests } = recordingProvider();
    const voice = build(provider);

    await voice.reply(turn(0));
    await voice.reply(turn(1, 'where are you from?'));

    const texts = (requests[0]?.messages ?? []).map((m) => m.text);
    expect(texts).toContain('where are you from?');
  });

  it('never reaches the fallback while the provider is answering', async () => {
    const { provider } = recordingProvider();
    const voice = build(provider);

    const said = [await voice.reply(turn(0)), await voice.reply(turn(1, 'hi'))];
    expect(said).not.toContain('THE FALLBACK RAN');
  });
});

describe('the opening, which is not generated', () => {
  it('costs no model call at all', async () => {
    // Asked for "a greeting and nothing else", a model produced a greeting and
    // then an opener — the exact behaviour removing `starters` was meant to
    // end, relocated into the generation. So it is a fact now, not a request.
    const { provider, requests } = recordingProvider();
    await build(provider).reply(turn(0));

    expect(requests).toHaveLength(0);
  });

  it('is a greeting, and only a greeting', async () => {
    const { provider } = recordingProvider();
    const opening = await build(provider).reply(turn(0));

    expect(opening).not.toBeNull();
    expect(opening).not.toContain('?');
    expect((opening ?? '').split(/\s+/).length).toBeLessThanOrEqual(2);
  });

  it('is remembered, so the model does not greet a second time', async () => {
    const { provider, requests } = recordingProvider();
    const voice = build(provider);

    const opening = await voice.reply(turn(0));
    await voice.reply(turn(1, 'hey'));

    const texts = (requests[0]?.messages ?? []).map((m) => m.text);
    expect(texts).toContain(opening);
  });
});

describe('the cacheable half', () => {
  it('is identical on every turn, because caching is a prefix match', async () => {
    const { provider, requests } = recordingProvider();
    const voice = build(provider);

    await voice.reply(turn(0));
    await voice.reply(turn(1, 'hi'));
    await voice.reply(turn(2, 'still here'));

    const stable = requests.map((r) => r.stableSystem);
    expect(new Set(stable).size).toBe(1);
  });

  it('keeps the generated surface out of it, so the cache can hit', async () => {
    // The surface is regenerated per conversation (D-AI-3). In the stable half
    // it would invalidate the cache on every conversation, with no error and a
    // bill several times larger.
    const { provider, requests } = recordingProvider();
    const voice = build(provider);
    await voice.reply(turn(0));
    await voice.reply(turn(1, 'hi'));

    expect(requests[0]?.stableSystem).not.toContain('Ana');
    expect(requests[0]?.volatileSystem).toContain('Ana');
  });

  it('tells the model to answer what was asked, before anything of its own', async () => {
    const { provider, requests } = recordingProvider();
    const voice = build(provider);
    await voice.reply(turn(0));
    await voice.reply(turn(1, 'hi'));

    expect(requests[0]?.stableSystem.toLowerCase()).toContain('answer what they actually said');
  });

  it('names the declared profile as the answer to who you are', async () => {
    // "old enough to remember dial-up" was a live answer to "age?" while the
    // declared age sat on the other person's screen. A non-answer to that
    // question is the most suspicious thing a stranger can say.
    const { provider, requests } = recordingProvider();
    const voice = build(provider);
    await voice.reply(turn(0));
    await voice.reply(turn(1, 'how old are you'));

    expect(requests[0]?.stableSystem.toLowerCase()).toContain('never dodge');
  });

  it('bans the em dash, which is the loudest tell in a chat message', async () => {
    const { provider, requests } = recordingProvider();
    const voice = build(provider);
    await voice.reply(turn(0));
    await voice.reply(turn(1, 'hi'));

    expect(requests[0]?.stableSystem.toLowerCase()).toContain('no em dashes');
  });
});

describe('when the provider fails', () => {
  const answering = (stop: ProviderReply['stop'], text = ''): ModelProvider => ({
    name: 'test',
    async complete(): Promise<ProviderReply> {
      return { text, stop, usage: NO_USAGE, model: 'claude-haiku-4-5' };
    },
  });

  it('falls back rather than going silent mid-conversation', async () => {
    const voice = build(answering('error'));
    await voice.reply(turn(0));

    expect(await voice.reply(turn(1, 'hi'))).toBe('THE FALLBACK RAN');
  });

  it('says nothing when the model declines, rather than putting words in its mouth', async () => {
    const voice = build(answering('refused'));
    await voice.reply(turn(0));

    expect(await voice.reply(turn(1, 'hi'))).toBeNull();
  });

  it('falls back when a truncated reply came back empty, rather than going quiet', async () => {
    // A reasoning model that spends its whole allowance thinking returns an
    // empty string with a length stop. Treating that as "chose to say nothing"
    // is how a stranger got a greeting and then silence for a whole
    // conversation.
    const voice = build(answering('truncated'));
    await voice.reply(turn(0));

    expect(await voice.reply(turn(1, 'hi'))).toBe('THE FALLBACK RAN');
  });

  it('still lets an empty complete reply mean silence, because people do that', async () => {
    const voice = build(answering('complete'));
    await voice.reply(turn(0));

    expect(await voice.reply(turn(1, 'hi'))).toBeNull();
  });
});

describe("the transcript, which is the client's and not the voice's", () => {
  it('sends only what the client says was delivered, never a reply it generated and abandoned', async () => {
    // The voice used to push every generated reply into its own history. A
    // reply cancelled because the stranger typed again was still "said", so
    // the next call continued a conversation the stranger never saw.
    const { provider, requests } = recordingProvider();
    const voice = modelVoice({
      provider,
      budget: okBudget,
      character,
      surfaceDescription: 'Ana, 24, female, India',
      logger,
      fallback: loudFallback,
    });

    // First call: generated, then abandoned by the client (not in the transcript).
    await voice.reply({
      character,
      sent: 1,
      incoming: 'hi',
      transcript: [
        { role: 'persona', text: 'hey' },
        { role: 'stranger', text: 'hi' },
      ],
    });
    await voice.reply({
      character,
      sent: 1,
      incoming: 'hi' + String.fromCharCode(10) + 'where are you from',
      transcript: [
        { role: 'persona', text: 'hey' },
        { role: 'stranger', text: 'hi' },
        { role: 'stranger', text: 'where are you from' },
      ],
    });

    const texts = (requests[1]?.messages ?? []).map((m) => m.text);
    expect(texts).not.toContain('a reply');
    expect(texts).toEqual(expect.arrayContaining(['hey', 'hi', 'where are you from']));
  });

  it('tells the model when several messages are waiting to be answered', async () => {
    const { provider, requests } = recordingProvider();
    await build(provider).reply({
      character,
      sent: 1,
      incoming: 'hi' + String.fromCharCode(10) + 'where are you from',
      transcript: [
        { role: 'stranger', text: 'hi' },
        { role: 'stranger', text: 'where are you from' },
      ],
    });

    expect(requests[0]?.volatileSystem).toContain('several messages');
  });
});

describe('the turn reading', () => {
  const reading = (kind: 'greeting' | 'question' | 'statement') => ({
    kind,
    sexual: false,
    minor: false,
    crisis: false,
    identity: false,
    source: 'jev' as const,
  });

  it('tells the model a bare hello is not a question — "hi" got "haan and you?"', async () => {
    const { provider, requests } = recordingProvider();
    await build(provider).reply({ ...turn(1, 'hi'), reading: reading('greeting') });

    expect(requests[0]?.volatileSystem.toLowerCase()).toContain('only said hello');
    expect(requests[0]?.volatileSystem.toLowerCase()).toContain('do not answer any question');
  });

  it('tells the model to answer first when they asked something', async () => {
    const { provider, requests } = recordingProvider();
    await build(provider).reply({ ...turn(1, 'kaha se ho'), reading: reading('question') });

    expect(requests[0]?.volatileSystem.toLowerCase()).toContain('answer it plainly first');
  });

  it('adds nothing for a plain statement, which is the default', async () => {
    const { provider, requests } = recordingProvider();
    await build(provider).reply({ ...turn(1, 'long day'), reading: reading('statement') });

    expect(requests[0]?.volatileSystem).not.toContain('answer it plainly');
    expect(requests[0]?.volatileSystem).not.toContain('only said hello');
  });

  it('carries a retry note into the volatile half, never the cached one', async () => {
    const { provider, requests } = recordingProvider();
    await build(provider).reply({ ...turn(1, 'hi'), retryNote: 'RETRY NOTE' });

    expect(requests[0]?.volatileSystem).toContain('RETRY NOTE');
    expect(requests[0]?.stableSystem).not.toContain('RETRY NOTE');
  });
});
