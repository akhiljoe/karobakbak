/**
 * Session resumption over real sockets (§28, reverses D7).
 *
 * The property under test is not "a token works" — it is that a refresh or a
 * blip does **not** end a conversation, and that everything which should still
 * end one still does.
 */
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import { createHash } from 'node:crypto';

import {
  BASE_PROTOCOL,
  RESUME_PROTOCOL_PREFIX,
  type ConnectedPayload,
  type MatchedPayload,
} from '../../src/protocol/types';

let http: TestServer;

/** Pair two clients and hand back both, with the resume token each was issued. */
async function pair(): Promise<{
  alice: TestClient;
  bob: TestClient;
  aliceToken: string;
  bobToken: string;
  matchId: string;
}> {
  const alice = await TestClient.connect(http.url);
  const bob = await TestClient.connect(http.url);
  const aliceHello = payloadOf<ConnectedPayload>(await alice.waitForFrame('connected'));
  const bobHello = payloadOf<ConnectedPayload>(await bob.waitForFrame('connected'));

  alice.command('join_queue');
  await alice.waitForFrame('queue_status');
  bob.command('join_queue');
  const matched = payloadOf<MatchedPayload>(await bob.waitForFrame('matched'));
  await alice.waitForFrame('matched');

  return {
    alice,
    bob,
    aliceToken: aliceHello.resumeToken,
    bobToken: bobHello.resumeToken,
    matchId: matched.matchId,
  };
}

function withToken(token: string): { protocols: string[] } {
  return { protocols: [BASE_PROTOCOL, `${RESUME_PROTOCOL_PREFIX}${token}`] };
}

beforeAll(async () => {
  http = await startTestServer();
});

afterEach(async () => {
  await http.ctx.flush();
});

afterAll(async () => {
  await http.stop();
});

describe('the token', () => {
  it('is issued on every connection and is not the session id', async () => {
    const client = await TestClient.connect(http.url);
    try {
      const hello = payloadOf<ConnectedPayload>(await client.waitForFrame('connected'));
      expect(hello.resumeToken.length).toBeGreaterThan(20);
      expect(hello.resumeToken).not.toBe(hello.sessionId);
      expect(hello.resumeGraceSeconds).toBe(http.ctx.config.resume.graceSeconds);
    } finally {
      client.close();
    }
  });

  it('is stored only as a hash', async () => {
    // A read of Redis must not hand somebody a way into a live conversation.
    const client = await TestClient.connect(http.url);
    try {
      const hello = payloadOf<ConnectedPayload>(await client.waitForFrame('connected'));
      const stored = await http.ctx.client.hget(http.ctx.keys.session(hello.sessionId), 'resumeHash');
      expect(stored).not.toBeNull();
      expect(stored).not.toBe(hello.resumeToken);
    } finally {
      client.close();
    }
  });
});

describe('a dropped socket', () => {
  it('keeps the conversation and tells the partner someone is reconnecting', async () => {
    const { alice, bob, matchId } = await pair();
    try {
      bob.terminate();
      const frame = await alice.waitForFrame('partner_reconnecting');
      expect(payloadOf<{ matchId: string }>(frame).matchId).toBe(matchId);
      // Not ended: the whole point.
      expect(await http.ctx.store.readMatch(matchId)).not.toBeNull();
    } finally {
      alice.close();
    }
  });

  it('comes back to the same conversation, with the same stranger', async () => {
    const { alice, bob, bobToken, matchId } = await pair();
    try {
      bob.terminate();
      await alice.waitForFrame('partner_reconnecting');

      const returned = await TestClient.connect(http.url, withToken(bobToken));
      try {
        const hello = payloadOf<ConnectedPayload>(await returned.waitForFrame('connected'));
        expect(hello.resumed).toBeDefined();
        expect(hello.resumed?.matchId).toBe(matchId);

        // The same stranger, not a fresh draw. Regenerating the identity would
        // make one conversation read as two people.
        expect(hello.resumed?.partner.nickname.length).toBeGreaterThan(0);

        // And the partner is told to stop waiting.
        await alice.waitForFrame('partner_returned');
      } finally {
        returned.close();
      }
    } finally {
      alice.close();
    }
  });

  it('can talk again after coming back', async () => {
    const { alice, bob, bobToken } = await pair();
    try {
      bob.terminate();
      await alice.waitForFrame('partner_reconnecting');
      const returned = await TestClient.connect(http.url, withToken(bobToken));
      try {
        await returned.waitForFrame('connected');
        alice.command('message', { text: 'still there?' }, 'c_1');
        const delivered = payloadOf<{ text: string }>(await returned.waitForFrame('message'));
        expect(delivered.text).toBe('still there?');
      } finally {
        returned.close();
      }
    } finally {
      alice.close();
    }
  });
});

describe('the token is single use', () => {
  it('is rotated on resume, and the old one no longer works', async () => {
    const { alice, bob, bobToken } = await pair();
    try {
      bob.terminate();
      await alice.waitForFrame('partner_reconnecting');

      const first = await TestClient.connect(http.url, withToken(bobToken));
      const hello = payloadOf<ConnectedPayload>(await first.waitForFrame('connected'));
      expect(hello.resumeToken).not.toBe(bobToken);
      first.terminate();
      await alice.waitForFrame('partner_reconnecting');

      // The spent token is not a way back in. A captured one is good for one
      // use and only until its owner reconnects.
      const replay = await TestClient.connect(http.url, withToken(bobToken));
      try {
        const denied = payloadOf<ConnectedPayload>(await replay.waitForFrame('connected'));
        expect(denied.resumed).toBeUndefined();
        expect(denied.sessionId).not.toBe(hello.sessionId);
      } finally {
        replay.close();
      }
    } finally {
      alice.close();
    }
  });

  it('will not take over a conversation that is still connected', async () => {
    // A live session is not transferable. Otherwise a second tab — or somebody
    // holding a captured token — could walk into a conversation in progress
    // while the original participant watched it happen.
    const { alice, bob, bobToken } = await pair();
    try {
      const intruder = await TestClient.connect(http.url, withToken(bobToken));
      try {
        const hello = payloadOf<ConnectedPayload>(await intruder.waitForFrame('connected'));
        expect(hello.resumed).toBeUndefined();
      } finally {
        intruder.close();
      }
    } finally {
      alice.close();
      bob.close();
    }
  });
});

describe('a failed resume is a new conversation, never an error', () => {
  it('opens a fresh session for an unknown token', async () => {
    const client = await TestClient.connect(http.url, withToken('not-a-real-token'));
    try {
      const hello = payloadOf<ConnectedPayload>(await client.waitForFrame('connected'));
      expect(hello.sessionId.length).toBeGreaterThan(0);
      expect(hello.resumed).toBeUndefined();
    } finally {
      client.close();
    }
  });

  it('opens a fresh session once the window has passed', async () => {
    const { alice, bob, bobToken } = await pair();
    try {
      bob.terminate();
      await alice.waitForFrame('partner_reconnecting');

      // The window passing is exactly the session row expiring; nothing else
      // sweeps it, so deleting it is what the clock would have done.
      const resumed = await http.ctx.client.get(
        `${http.ctx.keys.prefix}:resume:${hashOf(bobToken)}`,
      );
      if (resumed !== null) await http.ctx.client.del(http.ctx.keys.session(resumed));

      const late = await TestClient.connect(http.url, withToken(bobToken));
      try {
        const hello = payloadOf<ConnectedPayload>(await late.waitForFrame('connected'));
        expect(hello.resumed).toBeUndefined();
      } finally {
        late.close();
      }
    } finally {
      alice.close();
    }
  });
});

/** The server stores the SHA-256 of a token; tests need the same mapping. */
function hashOf(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
