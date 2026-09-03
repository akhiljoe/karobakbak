/**
 * Session resumption over real sockets (§28, reverses D7).
 *
 * The property under test is not "a token works" — it is that a refresh or a
 * blip does **not** end a conversation, and that everything which should still
 * end one still does.
 */
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import { delay } from '../helpers/redis';
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


/**
 * The seats an instance holds back for people coming back (D63).
 *
 * The property is not "a reserve exists" — it is that when an instance fills
 * up, the connection refused is the one with nothing to lose. A resumption
 * refused destroys a live conversation for two people; a cold arrival refused
 * loses a chat that had not started.
 *
 * Run against a deliberately tiny ceiling — 4 connections with 1 reserved —
 * because the arithmetic is what is under test and it is the same at 1,400
 * with 70.
 *
 * Note what the setup has to do to be a real test of this: the session that
 * comes back is **in a conversation**. `closeSession` holds a seat only for a
 * session with a match (§28); an idle one is deleted on close and has nothing
 * to resume. That is not an inconvenience of the test, it is the case the
 * reserve exists for.
 */
/**
 * The value of the one scrape line starting with `prefix`, or -1.
 *
 * Prefix matching rather than a pattern: every series here carries an
 * `instance_id` default label, so the value is never the second token on the
 * line and a regex over it has to know that.
 */
function sampleOf(scrape: string, prefix: string): number {
  const line = scrape.split('\n').find((entry) => entry.startsWith(prefix));
  if (line === undefined) return -1;
  return Number(line.slice(line.lastIndexOf(' ') + 1));
}

describe('the resumption reserve', () => {
  let rig: TestServer;

  /**
   * Read the gauge rather than sleep. A socket the client has closed is not off
   * the instance until the server has processed the close, and every assertion
   * here is about which band the *next* connection arrives in.
   */
  async function attached(): Promise<number> {
    const text = await rig.metrics.scrape();
    return sampleOf(text, 'chat_connections_active{');
  }

  async function waitUntilAttached(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await attached()) === count) return;
      await delay(20);
    }
    throw new Error(`the instance never settled at ${count} attached connections`);
  }

  /** How many upgrades this instance has refused for one reason. */
  async function refusals(reason: string): Promise<number> {
    const text = await rig.metrics.scrape();
    return sampleOf(text, `chat_connections_rejected_total{reason="${reason}"`);
  }

  /** Two clients in a conversation on this rig, and the first one's token. */
  async function talking(): Promise<{ a: TestClient; b: TestClient; aToken: string; aSession: string }> {
    const a = await TestClient.connect(rig.url);
    const b = await TestClient.connect(rig.url);
    const aHello = payloadOf<ConnectedPayload>(await a.waitForFrame('connected'));
    await b.waitForFrame('connected');
    a.command('join_queue');
    await a.waitForFrame('queue_status');
    b.command('join_queue');
    await b.waitForFrame('matched');
    await a.waitForFrame('matched');
    return { a, b, aToken: aHello.resumeToken, aSession: aHello.sessionId };
  }

  beforeAll(async () => {
    rig = await startTestServer({ MAX_CONNECTIONS: '4', RESUME_RESERVE_PERCENT: '25' });
    expect(rig.ctx.config.limits.resumeReserve).toBe(1);
  });

  afterAll(async () => {
    await rig.stop();
  });

  it('refuses a cold arrival to keep a seat for the conversation coming back', async () => {
    const { a, b, aToken, aSession } = await talking();
    a.close();
    await waitUntilAttached(1);

    // Fill everything that is not reserved. The last seat exists and is not
    // available to anybody new.
    const third = await TestClient.connect(rig.url);
    const fourth = await TestClient.connect(rig.url);
    await waitUntilAttached(3);

    try {
      const before = await refusals('at_capacity_reserved');
      const refused = await TestClient.expectRefusal(rig.url);
      expect(refused.status).toBe(503);
      expect(refused.body).toContain('at_capacity');
      // Which branch refused it, not merely that something did: `at_capacity`
      // and `at_capacity_reserved` want opposite responses from an operator.
      expect(await refusals('at_capacity_reserved')).toBe(before + 1);

      // The same instance, at the same occupancy, takes the browser coming
      // back — into the session it left, with the conversation still live.
      const returned = await TestClient.connect(rig.url, {
        protocols: [BASE_PROTOCOL, `${RESUME_PROTOCOL_PREFIX}${aToken}`],
      });
      try {
        const back = payloadOf<ConnectedPayload>(await returned.waitForFrame('connected'));
        // A failed resume is not an error, it is a brand-new session — so a
        // fresh id here would mean the reserved seat was spent on exactly what
        // it was withheld from a cold arrival to protect against.
        expect(back.sessionId).toBe(aSession);
        expect(back.resumed).not.toBeUndefined();

        // And the ceiling still binds: the reserve is headroom for people
        // coming back, never an extension of what the box can serve.
        await waitUntilAttached(4);
        const atCapacity = await refusals('at_capacity');
        const full = await TestClient.expectRefusal(rig.url, {
          protocols: [BASE_PROTOCOL, `${RESUME_PROTOCOL_PREFIX}${aToken}`],
        });
        expect(full.status).toBe(503);
        expect(await refusals('at_capacity')).toBe(atCapacity + 1);
      } finally {
        returned.close();
      }
    } finally {
      b.close();
      third.close();
      fourth.close();
    }
  });

  /**
   * The reserve has to be unclaimable or it is not a reserve — a subprotocol is
   * the cheapest thing in the world to invent. A token that resumes nothing
   * gets the identical 503 a cold arrival gets, which is why the refusal sits
   * after the resume attempt rather than at the sight of a token.
   */
  it('does not hand a reserved seat to an invented token', async () => {
    await waitUntilAttached(0);
    const first = await TestClient.connect(rig.url);
    const second = await TestClient.connect(rig.url);
    const third = await TestClient.connect(rig.url);
    await waitUntilAttached(3);

    try {
      const before = await refusals('at_capacity_reserved');
      const refused = await TestClient.expectRefusal(rig.url, {
        protocols: [BASE_PROTOCOL, `${RESUME_PROTOCOL_PREFIX}not-a-real-token`],
      });
      expect(refused.status).toBe(503);
      expect(refused.body).toContain('at_capacity');
      expect(await refusals('at_capacity_reserved')).toBe(before + 1);
    } finally {
      first.close();
      second.close();
      third.close();
    }
  });
});
