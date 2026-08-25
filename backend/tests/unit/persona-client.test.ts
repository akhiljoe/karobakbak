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

import { PersonaClient, defaultReplyDelay } from '../../src/personas/client';
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
   * Fire everything currently pending.
   *
   * Drains the microtask queue first. `speak()` awaits the voice before it
   * schedules the send, so a naive implementation runs while the client is
   * still suspended on that await, finds nothing queued, and the timer that
   * registers a moment later never fires. `setImmediate` runs after all pending
   * microtasks, which is precisely the point the timer exists by.
   */
  async run(): Promise<void> {
    await new Promise((resolve) => setImmediate(resolve));

    const pending = this.queue;
    this.queue = [];
    for (const entry of pending) {
      if (!entry.cancelled) entry.fn();
    }

    // Firing can schedule more work; let it settle before returning.
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
    replyDelayMs: () => 1500,
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

    const sent = h.socket.frames().find((f) => f.type === 'message');
    expect(String(sent?.payload['text']).length).toBe(500);
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
  it('never answers instantly, because that is the clearest tell there is', () => {
    expect(defaultReplyDelay('ok')).toBeGreaterThanOrEqual(1200);
  });

  it('takes longer over a longer message', () => {
    expect(defaultReplyDelay('x'.repeat(100))).toBeGreaterThan(defaultReplyDelay('ok'));
  });

  it('caps the pause so a long reply does not stall the conversation', () => {
    expect(defaultReplyDelay('x'.repeat(5000))).toBeLessThanOrEqual(9000);
  });
});
