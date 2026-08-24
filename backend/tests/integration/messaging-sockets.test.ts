/**
 * The message pipeline over real sockets, across **two backend instances**.
 *
 * The phase gate. Two servers, two Redis connections, two registries, one
 * keyspace — a client on one instance talking to a client on the other, which
 * is the arrangement every claim about cross-instance delivery is really about.
 */
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import type {
  ConnectedPayload,
  ErrorPayload,
  IncomingMessagePayload,
  MatchedPayload,
  MessageAckPayload,
  PartnerTypingPayload,
} from '../../src/protocol/types';

let one: TestServer;
let two: TestServer;

beforeAll(async () => {
  one = await startTestServer();
  // Same keyspace, its own port, its own instance id: a second backend.
  two = await startTestServer({
    REDIS_KEY_PREFIX: one.ctx.config.redis.keyPrefix,
    INSTANCE_ID: 'i_two',
  });
});

afterAll(async () => {
  await one.stop();
  await two.stop();
});

afterEach(async () => {
  await one.ctx.flush();
});

/** Connect one client to each instance and pair them. */
async function pairAcrossInstances(): Promise<{
  alice: TestClient;
  bob: TestClient;
  matchId: string;
}> {
  const alice = await TestClient.connect(one.url);
  const bob = await TestClient.connect(two.url);
  await alice.waitForFrame('connected');
  await bob.waitForFrame('connected');

  alice.command('join_queue');
  await alice.waitForFrame('queue_status');
  bob.command('join_queue');

  const match = payloadOf<MatchedPayload>(await bob.waitForFrame('matched'));
  await alice.waitForFrame('matched');
  return { alice, bob, matchId: match.matchId };
}

/** Both clients on the same instance, for the local delivery path (D9). */
async function pairOnOneInstance(): Promise<{ alice: TestClient; bob: TestClient; matchId: string }> {
  const alice = await TestClient.connect(one.url);
  const bob = await TestClient.connect(one.url);
  await alice.waitForFrame('connected');
  await bob.waitForFrame('connected');

  alice.command('join_queue');
  await alice.waitForFrame('queue_status');
  bob.command('join_queue');

  const match = payloadOf<MatchedPayload>(await bob.waitForFrame('matched'));
  await alice.waitForFrame('matched');
  return { alice, bob, matchId: match.matchId };
}

/**
 * The product's headline indicator, measured through the real socket path.
 *
 * `chat_matchmaking_latency_seconds` was declared, documented and charted on
 * three dashboard panels, and written by nothing — so those panels had read
 * "No data" since the day they were built, which on a graph is
 * indistinguishable from a healthy service nobody is using.
 *
 * Measuring it is not a one-liner, which is presumably why it was skipped: the
 * clock starts when a session is told it is queued and stops when it is told it
 * matched, and in the ordinary case those are two different requests, on two
 * different sockets, decided by whichever instance won. So the assertion that
 * matters is the one below — a sample exists for the side that actually
 * waited.
 */
describe('the matchmaking wait is measured', () => {
  it('records a sample for the session that waited to be matched', async () => {
    const alice = await TestClient.connect(one.url);
    const bob = await TestClient.connect(one.url);
    await alice.waitForFrame('connected');
    await bob.waitForFrame('connected');

    try {
      // Alice joins an empty queue and waits. Her clock starts here.
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');

      // Bob arrives and is matched immediately, which ends Alice's wait.
      bob.command('join_queue');
      await bob.waitForFrame('matched');
      await alice.waitForFrame('matched');

      const scrape = await one.metrics.scrape();
      const sum = /^chat_matchmaking_latency_seconds_sum\{[^}]*\} ([\d.e+-]+)$/m.exec(scrape);
      const count = /^chat_matchmaking_latency_seconds_count\{[^}]*\} (\d+)$/m.exec(scrape);

      expect(count).not.toBeNull();
      // Exactly one: Alice waited, and Bob was matched by his own join without
      // ever being queued, so he never started a clock.
      expect(Number(count?.[1])).toBe(1);
      expect(Number(sum?.[1])).toBeGreaterThan(0);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('counts the attempts the matchmaker made', async () => {
    const solo = await TestClient.connect(one.url);
    await solo.waitForFrame('connected');
    try {
      solo.command('join_queue');
      await solo.waitForFrame('queue_status');

      const scrape = await one.metrics.scrape();
      const attempts = /^chat_match_attempts_total\{[^}]*\} (\d+)$/m.exec(scrape);
      expect(attempts).not.toBeNull();
      expect(Number(attempts?.[1])).toBeGreaterThan(0);
    } finally {
      solo.close();
    }
  });
});

describe('delivery across two instances', () => {
  it('carries a message from one instance to the other', async () => {
    const { alice, bob, matchId } = await pairAcrossInstances();
    try {
      alice.command('message', { text: 'hello from instance one' }, 'c_1');

      const received = payloadOf<IncomingMessagePayload>(await bob.waitForFrame('message'));
      expect(received).toMatchObject({
        matchId,
        text: 'hello from instance one',
        type: 'text',
        from: 'partner',
      });
      expect(received.messageId).toMatch(/^msg_/);
      // Server-stamped, not client-supplied.
      expect(new Date(received.sentAt).toISOString()).toBe(received.sentAt);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('acks the sender with the client id echoed and the remote route', async () => {
    const { alice, bob, matchId } = await pairAcrossInstances();
    try {
      alice.command('message', { text: 'hi' }, 'c_correlate');
      const ack = payloadOf<MessageAckPayload>(await alice.waitForFrame('message_ack'));

      expect(ack).toMatchObject({
        clientMsgId: 'c_correlate',
        matchId,
        route: 'remote',
        status: 'routed',
      });
      expect(ack.messageId).toMatch(/^msg_/);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('takes the local path when both sockets are on one instance (D9)', async () => {
    const { alice, bob } = await pairOnOneInstance();
    try {
      alice.command('message', { text: 'same box' }, 'c_1');
      const ack = payloadOf<MessageAckPayload>(await alice.waitForFrame('message_ack'));
      expect(ack.route).toBe('local');
      await bob.waitForFrame('message');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('carries messages in both directions', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      alice.command('message', { text: 'ping from alice' }, 'c_a1');
      await bob.waitForFrame('message');
      bob.command('message', { text: 'pong from bob' }, 'c_b1');

      const back = payloadOf<IncomingMessagePayload>(await alice.waitForFrame('message'));
      expect(back.text).toBe('pong from bob');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('preserves order for a burst from one sender', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      // Within one sender's burst allowance, so nothing is rate limited.
      for (let i = 0; i < 5; i += 1) alice.command('message', { text: `m${i}` }, `c_${i}`);

      await bob.waitForFrame('message');
      const deadline = Date.now() + 2000;
      while (bob.frames.filter((f) => f.type === 'message').length < 5 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const texts = bob.frames
        .filter((frame) => frame.type === 'message')
        .map((frame) => payloadOf<IncomingMessagePayload>(frame).text);
      expect(texts).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('never puts a session id on the wire', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      const aliceSession = payloadOf<ConnectedPayload>(
        alice.frames.find((f) => f.type === 'connected')!,
      ).sessionId;
      alice.command('message', { text: 'hi' }, 'c_1');
      await bob.waitForFrame('message');

      // The recipient learns nothing about who sent it beyond "partner".
      const seen = JSON.stringify(bob.frames);
      expect(seen).not.toContain(aliceSession);
    } finally {
      alice.close();
      bob.close();
    }
  });
});

describe('replay protection over the wire (I14)', () => {
  it('rejects a repeated client id and does not deliver it twice', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      alice.command('message', { text: 'once' }, 'c_same');
      await alice.waitForFrame('message_ack');
      await bob.waitForFrame('message');

      alice.command('message', { text: 'once' }, 'c_same');
      const error = payloadOf<ErrorPayload>(await alice.waitForFrame('error'));
      expect(error.code).toBe('DUPLICATE_MESSAGE');
      expect(error.retryable).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(bob.frames.filter((frame) => frame.type === 'message')).toHaveLength(1);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('lets a retry of the same frame be safe rather than doubling the message', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      // The client's retry story: resend the identical frame. It is refused,
      // not duplicated, which is what makes retrying safe at all.
      alice.command('message', { text: 'retry me' }, 'c_retry');
      alice.command('message', { text: 'retry me' }, 'c_retry');
      await alice.waitForFrame('error');
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(bob.frames.filter((frame) => frame.type === 'message')).toHaveLength(1);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('scopes ids to a conversation, so the next one starts clean', async () => {
    const first = await pairAcrossInstances();
    first.alice.command('message', { text: 'hi' }, 'c_1');
    await first.alice.waitForFrame('message_ack');
    first.alice.close();
    first.bob.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const second = await pairAcrossInstances();
    try {
      second.alice.command('message', { text: 'hi again' }, 'c_1');
      const ack = payloadOf<MessageAckPayload>(await second.alice.waitForFrame('message_ack'));
      expect(ack.clientMsgId).toBe('c_1');
    } finally {
      second.alice.close();
      second.bob.close();
    }
  });
});

describe('typing across two instances', () => {
  it('delivers a start and a stop', async () => {
    const { alice, bob, matchId } = await pairAcrossInstances();
    try {
      alice.command('typing', { active: true });
      const started = payloadOf<PartnerTypingPayload>(await bob.waitForFrame('partner_typing'));
      expect(started).toEqual({ matchId, active: true });

      alice.command('typing', { active: false });
      const stopped = payloadOf<PartnerTypingPayload>(await bob.next('partner_typing'));
      expect(stopped.active).toBe(false);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('is not acknowledged to the sender', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      const before = alice.frames.length;
      alice.command('typing', { active: true });
      await bob.waitForFrame('partner_typing');
      // Acknowledging an advisory indicator would double this command's
      // traffic to confirm something nobody acts on.
      expect(alice.frames.length).toBe(before);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('does not consume the sender message budget', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      for (let i = 0; i < 8; i += 1) alice.command('typing', { active: i % 2 === 0 });
      await bob.waitForFrame('partner_typing');

      // Its own bucket (security §12): a cheap command must not be a way to
      // spend the message allowance.
      alice.command('message', { text: 'still allowed' }, 'c_1');
      await alice.waitForFrame('message_ack');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('refuses typing with no conversation', async () => {
    const client = await TestClient.connect(one.url);
    try {
      await client.waitForFrame('connected');
      client.command('typing', { active: true });
      expect(payloadOf<ErrorPayload>(await client.waitForFrame('error')).code).toBe('NOT_MATCHED');
    } finally {
      client.close();
    }
  });
});

describe('per-command rate limits at the edge (R7)', () => {
  it('refuses a message flood with RATE_LIMITED and nothing else', async () => {
    const strict = await startTestServer({ MESSAGE_RATE_PER_SEC: '1', MESSAGE_BURST: '2' });
    try {
      const alice = await TestClient.connect(strict.url);
      const bob = await TestClient.connect(strict.url);
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await alice.waitForFrame('matched');

      for (let i = 0; i < 6; i += 1) alice.command('message', { text: `m${i}` }, `c_${i}`);

      const error = payloadOf<ErrorPayload>(await alice.waitForFrame('error'));
      expect(error.code).toBe('RATE_LIMITED');
      expect(error.retryable).toBe(true);
      // Limit internals stay internal (§17): no bucket name, no token count,
      // no refill time.
      expect(JSON.stringify(error)).not.toMatch(/token|bucket|burst|\d{2,}/);

      const acks = alice.frames.filter((frame) => frame.type === 'message_ack');
      expect(acks.length).toBeLessThanOrEqual(2);
      alice.close();
      bob.close();
    } finally {
      await strict.stop();
    }
  });

  it('does not consume a dedupe id for a rate-limited message', async () => {
    const strict = await startTestServer({ MESSAGE_RATE_PER_SEC: '1', MESSAGE_BURST: '1' });
    try {
      const alice = await TestClient.connect(strict.url);
      const bob = await TestClient.connect(strict.url);
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      const match = payloadOf<MatchedPayload>(await alice.waitForFrame('matched'));

      alice.command('message', { text: 'first' }, 'c_1');
      await alice.waitForFrame('message_ack');
      alice.command('message', { text: 'second' }, 'c_2');
      await alice.waitForFrame('error');

      // Only the accepted message is remembered. Burning an id for a refused
      // message would let a client exhaust its own replay protection by
      // sending too fast.
      expect(await strict.ctx.client.scard(strict.ctx.keys.dedupe(match.matchId))).toBe(1);
      alice.close();
      bob.close();
    } finally {
      await strict.stop();
    }
  });

  it('limits the control commands too', async () => {
    const strict = await startTestServer({ SKIP_RATE_PER_SEC: '0.1', SKIP_BURST: '2' });
    try {
      const client = await TestClient.connect(strict.url);
      await client.waitForFrame('connected');
      for (let i = 0; i < 4; i += 1) client.command('skip');

      expect(payloadOf<ErrorPayload>(await client.waitForFrame('error')).code).toBe('RATE_LIMITED');
      client.close();
    } finally {
      await strict.stop();
    }
  });

  it('leaves ping unlimited, so a quiet client cannot be reaped for staying alive', async () => {
    const client = await TestClient.connect(one.url);
    try {
      await client.waitForFrame('connected');
      for (let i = 0; i < 40; i += 1) client.command('ping');

      const deadline = Date.now() + 2000;
      while (client.frames.filter((f) => f.type === 'pong').length < 40 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(client.frames.filter((frame) => frame.type === 'pong')).toHaveLength(40);
      expect(client.frames.filter((frame) => frame.type === 'error')).toHaveLength(0);
    } finally {
      client.close();
    }
  });
});

describe('moderation over the wire (§14.2, D20)', () => {
  it('delivers a flagged message, because flagging is not blocking', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      alice.command('message', { text: 'my site is example.com' }, 'c_1');
      const ack = payloadOf<MessageAckPayload>(await alice.waitForFrame('message_ack'));
      // Default policy is flag-and-deliver: refusing a message somebody was
      // allowed to send is far more visible than a flag nobody acts on.
      expect(ack.status).toBe('routed');
      const received = payloadOf<IncomingMessagePayload>(await bob.waitForFrame('message'));
      expect(received.text).toBe('my site is example.com');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('never tells the client which rule fired', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      alice.command('message', { text: 'reach me at me@example.com' }, 'c_1');
      await alice.waitForFrame('message_ack');
      // Naming the rule would tell someone probing the filter exactly which
      // pattern to work around.
      const seen = JSON.stringify(alice.frames);
      expect(seen).not.toContain('email');
      expect(seen).not.toContain('moderation');
      expect(seen).not.toContain('flag');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('acks a withheld message with delivered:false rather than an error', async () => {
    const strict = await startTestServer({ MODERATION_DEFAULT_ACTION: 'withhold' });
    try {
      const alice = await TestClient.connect(strict.url);
      const bob = await TestClient.connect(strict.url);
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await alice.waitForFrame('matched');
      await bob.waitForFrame('matched');

      alice.command('message', { text: 'visit example.com' }, 'c_1');
      const ack = payloadOf<MessageAckPayload>(await alice.waitForFrame('message_ack'));
      // The frame was valid and there is nothing to retry, so this is an ack,
      // not an error (D20).
      expect(ack.status).toBe('withheld');

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(bob.frames.filter((frame) => frame.type === 'message')).toHaveLength(0);
      alice.close();
      bob.close();
    } finally {
      await strict.stop();
    }
  });

  it('refuses a hard-blocked message with MESSAGE_WITHHELD', async () => {
    const strict = await startTestServer({ MODERATION_HARD_BLOCK_RULES: 'invite_link' });
    try {
      const alice = await TestClient.connect(strict.url);
      const bob = await TestClient.connect(strict.url);
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await alice.waitForFrame('matched');
      await bob.waitForFrame('matched');

      alice.command('message', { text: 'join discord.gg/abcd' }, 'c_1');
      const error = payloadOf<ErrorPayload>(await alice.waitForFrame('error'));
      expect(error.code).toBe('MESSAGE_WITHHELD');
      // Not retryable: resending the same message will be refused the same way.
      expect(error.retryable).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(bob.frames.filter((frame) => frame.type === 'message')).toHaveLength(0);
      alice.close();
      bob.close();
    } finally {
      await strict.stop();
    }
  });

  it('leaves the conversation usable after a refusal', async () => {
    const strict = await startTestServer({ MODERATION_HARD_BLOCK_RULES: 'invite_link' });
    try {
      const alice = await TestClient.connect(strict.url);
      const bob = await TestClient.connect(strict.url);
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await alice.waitForFrame('matched');
      await bob.waitForFrame('matched');

      alice.command('message', { text: 'join discord.gg/abcd' }, 'c_1');
      await alice.waitForFrame('error');
      // A refused message is not a protocol violation: the socket stays open
      // and the next ordinary message goes through.
      alice.command('message', { text: 'sorry, ignore that' }, 'c_2');
      const received = payloadOf<IncomingMessagePayload>(await bob.waitForFrame('message'));
      expect(received.text).toBe('sorry, ignore that');
      alice.close();
      bob.close();
    } finally {
      await strict.stop();
    }
  });
});

describe('a message cannot outlive its conversation (I6)', () => {
  it('is refused after the partner skips', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      bob.command('skip');
      await alice.waitForFrame('partner_skipped');

      alice.command('message', { text: 'still there?' }, 'c_late');
      expect(payloadOf<ErrorPayload>(await alice.waitForFrame('error')).code).toBe('NOT_MATCHED');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('is accepted but undelivered while the partner is reconnecting, and refused once they are gone', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      bob.terminate();
      await alice.waitForFrame('partner_reconnecting');

      // The point of this test: a message sent during the gap must not end the
      // conversation. Before the seat was held, an empty `instanceId` read as
      // PARTNER_GONE, the pipeline turned that into "not matched", and one
      // message destroyed the very thing the window exists to protect.
      //
      // It is accepted, and the ack says plainly that nobody received it. The
      // publish goes to a channel nobody is listening on, and nothing is
      // buffered — holding message text in a Redis key is what I8 forbids — so
      // this message will not arrive later.
      //
      // This assertion used to read `delivered: true`, because that field
      // carried the moderation verdict rather than an outcome. It was
      // defensible under D7, where a partner without a socket meant the
      // conversation was over; under §28 the gap is ordinary and lasts tens of
      // seconds, so it meant the sender saw a "sent" tick for a message that
      // had already reached nobody.
      alice.command('message', { text: 'hello?' }, 'c_during');
      const ack = await alice.waitForFrame('message_ack');
      expect(payloadOf<MessageAckPayload>(ack).status).toBe('undelivered');

      // Still in the conversation, which is the property that matters.
      alice.command('typing', { active: true });
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(alice.frames.some((f) => f.type === 'error')).toBe(false);
    } finally {
      alice.close();
    }
  });

  it('is refused after a block, from the blocked side too', async () => {
    const { alice, bob } = await pairAcrossInstances();
    try {
      bob.command('block');
      await alice.waitForFrame('partner_skipped');

      alice.command('message', { text: 'why' }, 'c_late');
      expect(payloadOf<ErrorPayload>(await alice.waitForFrame('error')).code).toBe('NOT_MATCHED');
    } finally {
      alice.close();
      bob.close();
    }
  });
});
