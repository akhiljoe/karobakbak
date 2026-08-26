/**
 * A2 — the persona WebSocket client.
 *
 * Frames are injected rather than delivered over a socket, and time is
 * injected rather than waited for, so these run in milliseconds and can
 * construct orderings a real server would produce only occasionally — a
 * partner leaving during the reply pause, a message arriving after teardown
 * began, a `partner_reconnecting` that must not be treated as goodbye.
 *
 * The socket path itself is covered by the integration test; what is asserted
 * here is the behaviour that is expensive to provoke against a real server and
 * cheap to get wrong.
 */

import { PersonaClient } from '../../src/personas/client';
import { humanCadence, openingBrevity, splitIntoBubbles } from '../../src/personas/cadence';
import type {
  PersonaClientEvent,
  PersonaVoice,
  VoiceTurn,
} from '../../src/personas/client';
import { CHARACTERS } from '../../src/personas/characters';
import { generateSurface } from '../../src/personas/surface';
import { PROTOCOL_VERSION } from '../../src/protocol/types';
import type { PersonaCharacter } from '../../src/personas/types';

const character: PersonaCharacter = (() => {
  const first = CHARACTERS[0];
  if (first === undefined) throw new Error('population is empty');
  return first;
})();

/** A socket that records what was written and never opens anything. */
class FakeSocket {
  sent: string[] = [];
  closedWith: number | null = null;

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number): void {
    this.closedWith = code;
  }

  frames(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.sent.map((raw) => JSON.parse(raw) as { type: string; payload: Record<string, unknown> });
  }

  typesSent(): string[] {
    return this.frames().map((f) => f.type);
  }
}

/** Runs scheduled callbacks on demand, so no test waits. */
class Clock {
  private queue: Array<{ fn: () => void; cancelled: boolean }> = [];
  time = 1_000_000;

  now = (): number => this.time;

  schedule = (fn: () => void): (() => void) => {
    const entry = { fn, cancelled: false };
    this.queue.push(entry);
    return () => {
      entry.cancelled = true;
    };
  };

  /**
   * Fire everything pending, and everything that firing schedules, until the
   * queue stays empty.
   *
   * Drains the microtask queue first. `speak()` awaits before it schedules, so
   * a naive implementation runs while the client is still suspended on that
   * await, finds nothing queued, and the timer that registers a moment later
   * never fires. `setImmediate` runs after all pending microtasks, which is
   * precisely the point the timer exists by.
   *
   * The loop is what a turn now needs: delivering one reply is a reading pause,
   * then a typing pause and a send per bubble, with a gap between them. Firing
   * one round would leave a persona frozen mid-sentence, which is not a state
   * the client can ever be observed in for real.
   */
  async run(): Promise<void> {
    // Bounded, so a scheduling bug fails as a test rather than as a hang.
    for (let round = 0; round < 50; round += 1) {
      await new Promise((resolve) => setImmediate(resolve));

      const pending = this.queue;
      if (pending.length === 0) break;
      this.queue = [];
      for (const entry of pending) {
        if (!entry.cancelled) entry.fn();
      }
    }

    await new Promise((resolve) => setImmediate(resolve));
  }

  advance(ms: number): void {
    this.time += ms;
  }
}

function scriptedVoice(replies: string[]): PersonaVoice {
  let index = 0;
  return {
    reply(): string | null {
      const next = replies[index];
      index += 1;
      return next ?? null;
    },
  };
}

interface Harness {
  client: PersonaClient;
  socket: FakeSocket;
  clock: Clock;
  events: PersonaClientEvent[];
  feed(type: string, payload?: Record<string, unknown>): void;
}

function build(voice: PersonaVoice = scriptedVoice(['hello there'])): Harness {
  const socket = new FakeSocket();
  const clock = new Clock();
  const events: PersonaClientEvent[] = [];

  const client = new PersonaClient({
    url: 'ws://unused/ws',
    origin: 'http://unused',
    character,
    profile: generateSurface(character, { seed: 1 }).profile,
    voice,
    now: clock.now,
    schedule: clock.schedule,
    cadence: { readingPauseMs: () => 1500, typingPauseMs: () => 1500, bubbleGapMs: () => 800 },
    // Off by default here. The fake clock fires everything pending regardless
    // of the delay asked for, so a live silence timer would trip on the first
    // `run()` of every test in this file rather than after two minutes. The
    // tests that are about moving on turn it on deliberately.
    silenceTimeoutMs: 0,
    onEvent: (e) => events.push(e),
  });

  // Attach the fake socket without opening a real one.
  (client as unknown as { socket: FakeSocket }).socket = socket;

  const feed = (type: string, payload: Record<string, unknown> = {}): void => {
    client.onFrame(JSON.stringify({ type, version: PROTOCOL_VERSION, payload }));
  };

  return { client, socket, clock, events, feed };
}

const CONNECTED = {
  sessionId: 's_test',
  protocolVersion: PROTOCOL_VERSION,
  serverTime: new Date().toISOString(),
  limits: {
    maxMessageLength: 500,
    maxReportNoteLength: 500,
    messagesPerSecond: 2,
    burst: 5,
    typingPerSecond: 2,
    maxFrameBytes: 8192,
  },
  features: { typing: true, presence: true, report: true, block: true },
};

const MATCHED = { matchId: 'm_1', startedAt: new Date().toISOString(), you: {}, partner: {} };

describe('the handshake', () => {
  it('records the session and limits from connected', () => {
    const h = build();
    h.feed('connected', CONNECTED);

    expect(h.client.currentState()).toBe('idle');
    expect(h.client.currentSessionId()).toBe('s_test');
    expect(h.events).toContainEqual({ kind: 'connected', sessionId: 's_test' });
  });

  it('declares the generated surface on the join, through the ordinary field', () => {
    // This is the whole of D-AI-3's cheapness: a persona uses the same declared
    // profile a real user does, so there is no new storage and no new path.
    const h = build();
    h.feed('connected', CONNECTED);
    expect(h.client.joinQueue()).toBe(true);

    const join = h.socket.frames().find((f) => f.type === 'join_queue');
    expect(join).toBeDefined();
    expect(join?.payload).toHaveProperty('profile');
    expect(h.client.currentState()).toBe('searching');
  });

  it('ignores a frame it cannot parse rather than throwing', () => {
    // The payload might contain message content (I8), so there is nothing safe
    // to log and nothing useful to do.
    const h = build();
    expect(() => h.client.onFrame('{not json')).not.toThrow();
    expect(h.client.currentState()).toBe('connecting');
  });
});

describe('holding a conversation', () => {
  it('opens the conversation when matched', async () => {
    const h = build(scriptedVoice(['hey, what are you up to']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    const messages = h.socket.frames().filter((f) => f.type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]?.payload['text']).toBe('hey, what are you up to');
    expect(messages[0]?.payload['type']).toBe('text');
  });

  it('replies to a partner message', async () => {
    const h = build(scriptedVoice(['opening', 'a reply']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hi', sentAt: '', from: 'partner' });
    await h.clock.run();

    const texts = h.socket.frames().filter((f) => f.type === 'message').map((f) => f.payload['text']);
    expect(texts).toEqual(['opening', 'a reply']);
  });

  it('stays quiet when the voice returns null, because real people do', async () => {
    const h = build({ reply: () => null });
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    expect(h.socket.typesSent()).not.toContain('message');
  });

  it('never sends past the server message limit', async () => {
    // Being refused for length wastes a round trip and, after A4, a model call
    // that has already been paid for.
    const long = 'x'.repeat(900);
    const h = build(scriptedVoice([long]));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    const lengths = h.socket
      .frames()
      .filter((f) => f.type === 'message')
      .map((f) => String(f.payload['text']).length);
    expect(lengths.length).toBeGreaterThan(0);
    for (const length of lengths) expect(length).toBeLessThanOrEqual(500);
  });

  it('counts its own messages so the voice knows how far in it is', async () => {
    const seen: number[] = [];
    const voice: PersonaVoice = {
      reply: (turn: VoiceTurn) => {
        seen.push(turn.sent);
        return 'ok';
      },
    };
    const h = build(voice);
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();
    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'a', sentAt: '', from: 'partner' });
    await h.clock.run();

    expect(seen).toEqual([0, 1]);
  });
});

describe('a partner who goes away', () => {
  it('treats partner_reconnecting as wait, not goodbye', () => {
    // The conversation has NOT ended. Nothing sent now is delivered and nothing
    // is buffered (D43), so leaving would end a conversation the server is
    // still holding open.
    const h = build();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    h.feed('partner_reconnecting', { graceSeconds: 30 });

    expect(h.client.currentState()).toBe('partner_away');
    expect(h.socket.typesSent()).not.toContain('leave_chat');
    expect(h.socket.typesSent()).not.toContain('skip');
    expect(h.events).toContainEqual({ kind: 'partner_away' });
  });

  it('carries on when the partner returns', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    h.feed('partner_reconnecting', { graceSeconds: 30 });
    h.feed('partner_returned', {});

    expect(h.client.currentState()).toBe('matched');
    expect(h.events).toContainEqual({ kind: 'partner_back' });
  });

  it('does not send a reply that was pending when the partner went away', async () => {
    const h = build(scriptedVoice(['opening', 'this must not be sent']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    // A message arrives, the reply pause begins, and the partner drops during it.
    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hi', sentAt: '', from: 'partner' });
    h.feed('partner_reconnecting', { graceSeconds: 30 });
    await h.clock.run();

    const texts = h.socket.frames().filter((f) => f.type === 'message').map((f) => f.payload['text']);
    expect(texts).toEqual(['opening']);
  });

  it('does not reply to a message that arrives after the partner left', async () => {
    const h = build(scriptedVoice(['opening', 'should not appear']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    h.feed('partner_skipped', {});
    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'late', sentAt: '', from: 'partner' });
    await h.clock.run();

    const texts = h.socket.frames().filter((f) => f.type === 'message').map((f) => f.payload['text']);
    expect(texts).toEqual(['opening']);
    expect(h.client.currentState()).toBe('idle');
  });

  it('reports why the partner went', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    h.feed('partner_disconnected', {});

    expect(h.events).toContainEqual({ kind: 'partner_gone', reason: 'partner_disconnected' });
  });
});

describe('moving on from a conversation that has stopped', () => {
  /**
   * A client with the silence timer live.
   *
   * The fake clock ignores the delay, so any positive value means "fires on the
   * next drain" — which is what makes this testable without waiting.
   */
  function buildImpatient(voice: PersonaVoice = scriptedVoice(['hey', 'still here?'])): Harness {
    const socket = new FakeSocket();
    const clock = new Clock();
    const events: PersonaClientEvent[] = [];

    const client = new PersonaClient({
      url: 'ws://unused/ws',
      origin: 'http://unused',
      character,
      profile: generateSurface(character, { seed: 1 }).profile,
      voice,
      now: clock.now,
      schedule: clock.schedule,
      cadence: { readingPauseMs: () => 1, typingPauseMs: () => 1, bubbleGapMs: () => 1 },
      silenceTimeoutMs: 1,
      onEvent: (e) => events.push(e),
    });

    (client as unknown as { socket: FakeSocket }).socket = socket;

    const feed = (type: string, payload: Record<string, unknown> = {}): void => {
      client.onFrame(JSON.stringify({ type, version: PROTOCOL_VERSION, payload }));
    };

    return { client, socket, clock, events, feed };
  }

  it('skips rather than leaving, so it is back in the queue in one frame', async () => {
    // `leave_chat` would end the conversation and leave the persona idle,
    // holding a connection and talking to nobody until something stopped it.
    const h = buildImpatient();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    expect(h.socket.typesSent()).toContain('skip');
    expect(h.socket.typesSent()).not.toContain('leave_chat');
    expect(h.client.currentState()).toBe('searching');
  });

  it('says why it moved on, so it can be counted', async () => {
    const h = buildImpatient();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    expect(h.events).toContainEqual({ kind: 'moved_on', reason: 'silence' });
  });

  it('answers the stranger before it ever considers moving on', async () => {
    // The clock restarts only after this persona has spoken, so an answer
    // always gets replied to. (The fake clock fires every pending callback
    // regardless of its delay, so what is checkable here is the ordering
    // rather than the two minutes.)
    const h = buildImpatient();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hey', sentAt: '', from: 'partner' });
    await h.clock.run();

    const kinds = h.events.map((e) => e.kind);
    expect(kinds).toContain('sent');
    expect(kinds.indexOf('sent')).toBeLessThan(kinds.indexOf('moved_on'));
  });

  it('does not time out a partner whose socket dropped', async () => {
    // They have not gone quiet on us — the server is holding their seat, and
    // ending it during the grace window would destroy what §28 exists for.
    const h = buildImpatient();
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    h.feed('partner_reconnecting', { graceSeconds: 30 });
    await h.clock.run();

    expect(h.socket.typesSent()).not.toContain('skip');
    expect(h.client.currentState()).toBe('partner_away');
  });

  it('moves on when the same message arrives over and over', async () => {
    const h = buildImpatient({ reply: () => null });
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);

    const same = { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hello', sentAt: '', from: 'partner' };
    for (let i = 0; i < 3; i += 1) h.feed('message', same);
    await h.clock.run();

    expect(h.events).toContainEqual({ kind: 'moved_on', reason: 'repetition' });
  });

  it('forgives one repeat, because people resend when a message looks stuck', async () => {
    const h = buildImpatient({ reply: () => null });
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);

    const same = { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hello', sentAt: '', from: 'partner' };
    h.feed('message', same);
    h.feed('message', same);

    expect(h.events).not.toContainEqual({ kind: 'moved_on', reason: 'repetition' });
  });

  it('counts a run, not a total, so a repeated word does not end a chat', async () => {
    const h = buildImpatient({ reply: () => null });
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);

    const say = (text: string): void =>
      h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text, sentAt: '', from: 'partner' });

    say('lol');
    say('lol');
    say('what about you');
    say('lol');

    expect(h.events).not.toContainEqual({ kind: 'moved_on', reason: 'repetition' });
  });

  it('never moves on when the timeout is disabled', async () => {
    // `PERSONA_SILENCE_TIMEOUT_SECONDS=0` is a supported setting, not a
    // disabled feature nobody tests.
    const h = build(scriptedVoice(['hey']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    expect(h.socket.typesSent()).not.toContain('skip');
  });
});

describe('the local rate-limit mirror', () => {
  it('spends the join burst and then refuses, rather than being refused', () => {
    // join_queue refills one token per five seconds with a burst of five, and
    // the server does not publish it. A client that ignores this spends its
    // life being rejected.
    const h = build();
    h.feed('connected', CONNECTED);

    const results = [1, 2, 3, 4, 5, 6].map(() => h.client.joinQueue());
    expect(results).toEqual([true, true, true, true, true, false]);
  });

  it('refills over time', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    for (let i = 0; i < 5; i += 1) h.client.joinQueue();
    expect(h.client.joinQueue()).toBe(false);

    h.clock.advance(5_000);
    expect(h.client.joinQueue()).toBe(true);
  });

  it('keeps separate buckets per command', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    for (let i = 0; i < 5; i += 1) h.client.joinQueue();

    expect(h.client.joinQueue()).toBe(false);
    expect(h.client.skip()).toBe(true);
  });

  it('does not send the frame it refused', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    for (let i = 0; i < 6; i += 1) h.client.joinQueue();

    expect(h.socket.typesSent().filter((t) => t === 'join_queue')).toHaveLength(5);
  });
});

describe('leaving', () => {
  it('leaves when the voice says to, without sending a reply first', async () => {
    const voice: PersonaVoice = {
      reply: () => 'never sent',
      shouldLeave: (turn) => turn.sent > 0,
    };
    const h = build(voice);
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hi', sentAt: '', from: 'partner' });
    await h.clock.run();

    expect(h.socket.typesSent()).toContain('leave_chat');
    expect(h.client.currentState()).toBe('idle');
  });

  it('closes the socket cleanly', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    h.client.close();

    expect(h.socket.closedWith).toBe(1000);
    expect(h.client.currentState()).toBe('closed');
  });
});

describe('server refusals', () => {
  it('surfaces an error code rather than swallowing it', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    h.feed('error', { code: 'RATE_LIMITED', retryable: true });

    expect(h.events).toContainEqual({ kind: 'refused', code: 'RATE_LIMITED' });
  });

  it('names an unknown refusal rather than reporting undefined', () => {
    const h = build();
    h.feed('connected', CONNECTED);
    h.feed('error', {});

    expect(h.events).toContainEqual({ kind: 'refused', code: 'UNKNOWN' });
  });
});

describe('reply timing', () => {
  const cadence = humanCadence(() => 0.5);

  it('never answers instantly, because that is the clearest tell there is', () => {
    expect(cadence.readingPauseMs('ok')).toBeGreaterThanOrEqual(900);
  });

  it('takes longer over a longer incoming message, because reading takes time', () => {
    expect(cadence.readingPauseMs('x'.repeat(100))).toBeGreaterThan(cadence.readingPauseMs('ok'));
  });

  it('pauses before its own opening line, when there is nothing to read', () => {
    expect(cadence.readingPauseMs(undefined)).toBeGreaterThan(0);
  });

  it('takes longer to type a longer reply', () => {
    expect(cadence.typingPauseMs('x'.repeat(80))).toBeGreaterThan(cadence.typingPauseMs('ok'));
  });

  it('caps the typing pause so a long reply does not stall the conversation', () => {
    expect(cadence.typingPauseMs('x'.repeat(5000))).toBeLessThanOrEqual(7000);
  });
});

describe('keeping the first few messages short', () => {
  // The prompt already asked for this and the model ignored it. The second
  // message of a live conversation, to somebody who had said "hi" and "m", was
  // thirty-five words carrying a whole declared profile and two anecdotes.
  const DUMP =
    "wait, that's it? i'm 29, nonbinary, us. bought three keyboards i can't " +
    "justify and at least two games i'll never finish. you?";

  it('cuts that opening reply back to its first sentence', () => {
    expect(openingBrevity(DUMP, 1)).toBe("wait, that's it?");
  });

  it('leaves a reply that was already short alone', () => {
    expect(openingBrevity('not much, you?', 1)).toBe('not much, you?');
    expect(openingBrevity('ha fair', 0)).toBe('ha fair');
  });

  it('never stops in the middle of a clause', () => {
    // A bubble that ends mid-thought reads as a truncation bug rather than as
    // somebody being brief.
    const kept = openingBrevity(DUMP, 2);
    expect(kept.endsWith('?') || kept.endsWith('.') || kept.endsWith('!')).toBe(true);
  });

  it('caps a single long sentence at a word boundary', () => {
    const rambling = 'so anyway i was thinking about the thing you said and it made me wonder';
    const kept = openingBrevity(rambling, 0);
    expect(kept.split(/\s+/).length).toBeLessThanOrEqual(12);
    expect(rambling.startsWith(kept)).toBe(true);
  });

  it('takes the first line when the model laid out two', () => {
    expect(openingBrevity('wait\nactually no, forget that entirely', 1)).toBe('wait');
  });

  it('stops applying once the conversation is actually running', () => {
    // Somebody twenty messages deep has earned a longer answer, and by then the
    // other person has decided they are talking to a person.
    expect(openingBrevity(DUMP, 3)).toBe(DUMP);
    expect(openingBrevity(DUMP, 20)).toBe(DUMP);
  });

  it('says nothing rather than something broken when given nothing', () => {
    expect(openingBrevity('   ', 0)).toBe('');
  });
});

describe('splitting a reply into bubbles', () => {
  it('leaves a short reply as one message, because it is one thought', () => {
    expect(splitIntoBubbles('yeah same honestly')).toEqual(['yeah same honestly']);
  });

  it('splits a long reply at sentence boundaries, never mid-clause', () => {
    const bubbles = splitIntoBubbles(
      'oh no. that is genuinely the worst thing i have heard all week. ' +
        'did you at least get the money back or is it just gone forever now',
    );
    expect(bubbles.length).toBeGreaterThan(1);
    for (const bubble of bubbles) expect(bubble.trim()).toBe(bubble);
    expect(bubbles.join(' ')).toContain('worst thing');
  });

  it('treats a newline as a break the writer already chose', () => {
    expect(splitIntoBubbles('wait\nactually no, i take that back completely honestly')).toEqual([
      'wait',
      'actually no, i take that back completely honestly',
    ]);
  });

  it('never sends more than three, because a burst of five is its own tell', () => {
    const many = Array.from({ length: 9 }, (_, i) => `sentence number ${i} here.`).join(' ');
    expect(splitIntoBubbles(many).length).toBeLessThanOrEqual(3);
  });

  it('hard-cuts a single sentence longer than the server accepts', () => {
    // The alternative is a frame the server refuses and a model call already
    // paid for.
    for (const bubble of splitIntoBubbles('x'.repeat(1200), 500)) {
      expect(bubble.length).toBeLessThanOrEqual(500);
    }
  });

  it('says nothing at all rather than sending an empty frame', () => {
    expect(splitIntoBubbles('   ')).toEqual([]);
  });
});

describe('the typing indicator', () => {
  it('announces that it is writing before the message, and stops before sending', async () => {
    // Text that appears whole with no warning is the "copy-pasted" tell, and
    // every real client on this server sends `typing` while composing.
    const h = build(scriptedVoice(['hey']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    const frames = h.socket.frames().filter((f) => f.type === 'typing' || f.type === 'message');
    expect(frames.map((f) => f.type)).toEqual(['typing', 'typing', 'message']);
    expect(frames[0]?.payload['active']).toBe(true);
    expect(frames[1]?.payload['active']).toBe(false);
  });

  it('types once per bubble, so a burst looks like a burst', async () => {
    // Driven past the opening turns first. `openingBrevity` deliberately cuts
    // an early reply to one sentence, so a two-bubble burst is only possible
    // once the conversation is actually running — which is the point of it.
    const h = build(
      scriptedVoice([
        'hey',
        'ok',
        'sure',
        'wait\nactually no, i take that back completely honestly',
      ]),
    );
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    for (let i = 0; i < 3; i += 1) {
      h.feed('message', {
        matchId: 'm_1',
        messageId: `x${i}`,
        type: 'text',
        text: 'and?',
        sentAt: '',
        from: 'partner',
      });
      await h.clock.run();
    }

    const tail = h.socket
      .frames()
      .filter((f) => f.type === 'typing' || f.type === 'message')
      .map((f) => f.type)
      .slice(-6);
    expect(tail).toEqual(['typing', 'typing', 'message', 'typing', 'typing', 'message']);
  });

  it('leaves nobody watching "typing…" after the partner has gone', async () => {
    const h = build(scriptedVoice(['opening', 'never arrives']));
    h.feed('connected', CONNECTED);
    h.feed('matched', MATCHED);
    await h.clock.run();

    h.feed('message', { matchId: 'm_1', messageId: 'x', type: 'text', text: 'hi', sentAt: '', from: 'partner' });
    h.feed('partner_skipped', {});
    await h.clock.run();

    const typing = h.socket.frames().filter((f) => f.type === 'typing');
    expect(typing[typing.length - 1]?.payload['active']).toBe(false);
    const texts = h.socket.frames().filter((f) => f.type === 'message').map((f) => f.payload['text']);
    expect(texts).toEqual(['opening']);
  });

  it('says nothing about typing when the server says the feature is off', async () => {
    const h = build(scriptedVoice(['hey']));
    h.feed('connected', {
      ...CONNECTED,
      features: { ...CONNECTED.features, typing: false },
    });
    h.feed('matched', MATCHED);
    await h.clock.run();

    expect(h.socket.typesSent()).not.toContain('typing');
    expect(h.socket.typesSent()).toContain('message');
  });
});
