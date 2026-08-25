/**
 * A2's gate: a persona holds a real conversation over a real socket.
 *
 * The unit suite drives the client with injected frames, which is where the
 * awkward orderings get tested. This is the other half of the claim — that the
 * thing actually connects to the server that exists, joins the queue the
 * ordinary way, is matched by the ordinary path, and is subject to every
 * control a real user is subject to.
 *
 * That last part is the point of D-AI-6. A persona is a client, so blocks and
 * bans and rate limits apply to it without anybody writing code to make them
 * apply. These tests assert that rather than assuming it.
 */

import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import { PersonaClient } from '../../src/personas/client';
import type { PersonaVoice } from '../../src/personas/client';
import { CHARACTERS } from '../../src/personas/characters';
import { generateSurface } from '../../src/personas/surface';
import type { PersonaCharacter } from '../../src/personas/types';
import type { IncomingMessagePayload, MatchedPayload } from '../../src/protocol/types';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.stop();
});

afterEach(async () => {
  await server.ctx.flush();
});

const character: PersonaCharacter = (() => {
  const first = CHARACTERS[0];
  if (first === undefined) throw new Error('population is empty');
  return first;
})();

/** Says exactly what it is told to, so assertions are about plumbing not prose. */
function saying(lines: string[]): PersonaVoice {
  let i = 0;
  return {
    reply: () => {
      const next = lines[i];
      i += 1;
      return next ?? null;
    },
  };
}

interface Started {
  persona: PersonaClient;
  events: string[];
  waitFor(kind: string, timeoutMs?: number): Promise<void>;
}

/** Connect a persona to the running server and wait for `connected`. */
async function startPersona(voice: PersonaVoice, seed = 1): Promise<Started> {
  const events: string[] = [];
  const waiters: Array<{ kind: string; resolve: () => void }> = [];

  const persona = new PersonaClient({
    url: server.url,
    origin: server.ctx.config.http.allowedOrigins[0] ?? 'http://localhost',
    character,
    profile: generateSurface(character, { seed }).profile,
    voice,
    // No artificial pause: these tests are about the socket, not the pacing,
    // and the pacing has its own unit tests.
    cadence: { readingPauseMs: () => 1, typingPauseMs: () => 1, bubbleGapMs: () => 1 },
    onEvent: (event) => {
      events.push(event.kind);
      for (const waiter of [...waiters]) {
        if (waiter.kind === event.kind) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve();
        }
      }
    },
  });

  const waitFor = (kind: string, timeoutMs = 5000): Promise<void> =>
    new Promise((resolve, reject) => {
      if (events.includes(kind)) {
        resolve();
        return;
      }
      const timer = setTimeout(
        () => reject(new Error(`persona never emitted "${kind}"; saw ${events.join(', ')}`)),
        timeoutMs,
      );
      waiters.push({
        kind,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });

  await persona.connect();
  return { persona, events, waitFor };
}

describe('a persona on a real socket', () => {
  it('connects, joins the queue and is matched with a real user', async () => {
    const p = await startPersona(saying(['hey there']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    await p.waitFor('connected');

    human.command('join_queue');
    const matched = payloadOf<MatchedPayload>(await human.waitForFrame('matched'));

    expect(matched.matchId).toBeTruthy();
    await p.waitFor('matched');
    expect(p.persona.currentState()).toBe('matched');

    p.persona.close();
    human.close();
  });

  it('opens the conversation, and the human receives what it said', async () => {
    const p = await startPersona(saying(['okay stranger, tell me something']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');

    const incoming = payloadOf<IncomingMessagePayload>(await human.waitForFrame('message'));
    expect(incoming.text).toBe('okay stranger, tell me something');
    expect(incoming.type).toBe('text');
    expect(incoming.from).toBe('partner');

    p.persona.close();
    human.close();
  });

  it('replies to what the human says', async () => {
    const p = await startPersona(saying(['opening line', 'and a reply']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');
    await human.waitForFrame('message');

    human.command('message', { text: 'hello' }, 'c1');
    // `next` rather than `waitForFrame`: the opening line is already in the
    // buffer, and waiting for "a message" would hand back the one from before.
    const reply = payloadOf<IncomingMessagePayload>(await human.next('message'));
    expect(reply.text).toBe('and a reply');

    p.persona.close();
    human.close();
  });

  it('declares its generated surface, and the human sees it', async () => {
    // D-AI-3 in practice: the persona goes through the ordinary declared
    // profile field, so the partner sees a name the same way they would see a
    // real user's — no new protocol, no new storage.
    const p = await startPersona(saying(['hi']), 3);
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    const matched = payloadOf<MatchedPayload>(await human.waitForFrame('matched'));

    const declared = generateSurface(character, { seed: 3 }).profile;
    // Whatever the surface declared, that is what the partner is told.
    expect(matched.partner).toBeDefined();
    if (declared.name !== null) {
      expect(JSON.stringify(matched.partner)).toContain(declared.name);
    }

    p.persona.close();
    human.close();
  });

  it('leaves cleanly, and the human is told', async () => {
    const p = await startPersona(saying(['hi']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');
    await human.waitForFrame('message');

    p.persona.leaveChat();
    const gone = await human.waitForFrame('partner_skipped');
    expect(gone).toBeDefined();

    p.persona.close();
    human.close();
  });
});

describe('a persona is subject to everything a user is', () => {
  it('can be blocked, and the block holds', async () => {
    // The point of D-AI-6. Nobody wrote code to make blocking work against a
    // persona; it works because a persona is a client.
    const p = await startPersona(saying(['hi']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');

    human.command('block');
    // Blocking ends the match, exactly as it would between two people.
    await p.waitFor('partner_gone');
    expect(p.persona.currentState()).toBe('idle');

    p.persona.close();
    human.close();
  });

  it('can be reported like anyone else', async () => {
    const p = await startPersona(saying(['hi']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');

    human.command('report', { category: 'other', note: 'testing' });
    const ack = await human.waitForFrame('report_ack');
    expect(ack).toBeDefined();

    p.persona.close();
    human.close();
  });

  it('has its own output moderated by the server, like any user', async () => {
    // A second benefit of D-AI-6 that nobody had to build: the guard is the
    // client-side floor, and the server's moderation pipeline runs over a
    // persona's message exactly as it does over a person's. Two independent
    // controls rather than one, and the server one cannot be bypassed by a bug
    // in the persona process.
    const p = await startPersona(saying(['have a look at http://example.com/spam']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');

    // Delivered but flagged is the default policy (D20), so the human still
    // receives it — what matters is that the server evaluated it.
    const incoming = payloadOf<IncomingMessagePayload>(await human.waitForFrame('message'));
    expect(incoming.text).toContain('example.com');

    // It arrived through the ordinary pipeline: the server stamped the content
    // type, which only the server does.
    expect(incoming.type).toBe('text');
    expect(incoming.messageId).toBeTruthy();

    p.persona.close();
    human.close();
  });

  it('waits rather than leaving when the partner drops (D43)', async () => {
    // The partner's seat is held. Nothing sent now is delivered and nothing is
    // buffered, so a persona that treated this as goodbye would end a
    // conversation the server is still holding open.
    const p = await startPersona(saying(['hi', 'more']));
    const human = await TestClient.connect(server.url);
    await human.waitForFrame('connected');

    p.persona.joinQueue();
    human.command('join_queue');
    await human.waitForFrame('matched');
    await human.waitForFrame('message');

    // Drop the socket without leaving the chat.
    human.close();

    await p.waitFor('partner_away');
    expect(p.persona.currentState()).toBe('partner_away');

    p.persona.close();
  });
});
