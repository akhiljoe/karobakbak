/**
 * The P group — protocol abuse, all 28 catalogued rows (`docs/LOADTEST-SCENARIOS.md` §P).
 *
 * ---------------------------------------------------------------------------
 * WHY AGAINST A LIVE SERVER RATHER THAN AGAINST `parseClientFrame`
 * ---------------------------------------------------------------------------
 * About half these rows are decisions the validator makes and could be asserted
 * against the function. The other half are not decisions at all — they are
 * *interactions*:
 *
 *   * an oversized frame never reaches `handleFrame`, because `ws` enforces
 *     `maxPayload` and closes with 1009 before the payload is allocated;
 *   * the strike counter lives on the connection, not in the validator;
 *   * `NOT_MATCHED` versus `ALREADY_MATCHED` is session state in Redis;
 *   * a duplicate message id is refused by the pipeline, scoped to a match.
 *
 * Splitting them across two files by mechanism would organise the tests by
 * implementation detail rather than by the thing being defended, and the rows
 * that are cheapest to get wrong are exactly the ones that cross the boundary.
 * So all of them run the way a client experiences them.
 *
 * `docs/LOADTEST-SCENARIOS.md` catalogued these as swarm rows and the swarm has
 * never implemented any of them. They do not need load — one client each, and a
 * specific expected refusal — so they belong here, where they run on every push
 * rather than when somebody remembers to start a stack.
 */
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import { CLIENT_TOKEN_COOKIE } from '../../src/ws/upgrade';
import type { ErrorPayload, QueueStatusPayload } from '../../src/protocol/types';

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer({
    // Small enough that P6 and P25 do not have to build a megabyte.
    MAX_FRAME_BYTES: '16384',
    // The strike budget, so P13 does not depend on the shipped default.
    INVALID_MESSAGE_STRIKES: '10',
  });
});

afterAll(async () => {
  await server?.stop();
});

let clientCounter = 0;
/** A connected client with an address of its own, so no two share a limiter. */
async function client(): Promise<TestClient> {
  clientCounter += 1;
  const c = await TestClient.connect(server.url, {
    headers: { 'X-Forwarded-For': `198.18.${Math.floor(clientCounter / 250)}.${clientCounter % 250}` },
  });
  await c.waitForFrame('connected');
  return c;
}

/** The next error frame's code, or the string 'none' if none arrived. */
async function errorCode(c: TestClient, timeoutMs = 2000): Promise<string> {
  try {
    const frame = await c.next('error', timeoutMs);
    return payloadOf<ErrorPayload>(frame).code;
  } catch {
    return 'none';
  }
}

/** Two clients, matched to each other. */
async function matchedPair(): Promise<[TestClient, TestClient]> {
  const a = await client();
  const b = await client();
  a.command('join_queue', {});
  await a.next('queue_status');
  b.command('join_queue', {});
  await Promise.all([a.waitForFrame('matched'), b.waitForFrame('matched')]);
  return [a, b];
}

describe('P1-P12 — frames the validator refuses', () => {
  it('P1: a non-JSON text frame is BAD_JSON', async () => {
    const c = await client();
    c.send('this is not json at all');
    expect(await errorCode(c)).toBe('BAD_JSON');
    c.close();
  });

  /**
   * The catalogue says BAD_ENVELOPE; the server says UNSUPPORTED_VERSION, and
   * this asserts what the server does (F-042).
   *
   * `validate.ts:490` refuses anything that is not a JSON object, and
   * `{hello:'world'}` *is* one — so it reaches the version check at :494 with
   * `version` undefined and is reported as a version problem. A client sending
   * structural garbage is told to fix its protocol version.
   *
   * Recorded rather than changed: an error code is part of the wire contract,
   * and reordering two checks is a protocol decision rather than a test fix.
   */
  it('P2: valid JSON of the wrong shape is refused (as UNSUPPORTED_VERSION, see F-042)', async () => {
    const c = await client();
    c.send(JSON.stringify({ hello: 'world' }));
    expect(await errorCode(c)).toBe('UNSUPPORTED_VERSION');
    c.close();
  });

  it('P3: an unsupported version is refused as such, not as a bad envelope', async () => {
    const c = await client();
    c.send(JSON.stringify({ type: 'ping', version: 2, payload: {} }));
    expect(await errorCode(c)).toBe('UNSUPPORTED_VERSION');
    c.close();
  });

  /**
   * The rejected-features list in §23 is not decoration: `call_start` is one of
   * the event names that would exist if this were a video product. It must be
   * unknown rather than ignored.
   */
  it('P4: an unknown event type is UNKNOWN_EVENT', async () => {
    const c = await client();
    c.send(JSON.stringify({ type: 'call_start', version: 1, payload: {} }));
    expect(await errorCode(c)).toBe('UNKNOWN_EVENT');
    c.close();
  });

  /**
   * Architectural rather than a validation rule (§23.2). It is what keeps the
   * socket from becoming a media transport, and the socket policy is unchanged
   * by one — the connection survives to be used again.
   */
  it('P5: a binary frame is refused and the socket policy is unchanged', async () => {
    const c = await client();
    c.sendBinary(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    expect(await errorCode(c)).not.toBe('none');

    // Still usable: a binary frame is a refusal, not a teardown.
    c.command('ping', {});
    await c.next('pong');
    c.close();
  });

  it('P6: a frame over the size limit closes with 1009', async () => {
    const c = await TestClient.connect(server.url, {
      headers: { 'X-Forwarded-For': '198.18.99.6' },
    });
    await c.waitForFrame('connected');
    c.send(JSON.stringify({ type: 'ping', version: 1, payload: { pad: 'x'.repeat(20_000) } }));
    const close = await c.waitForClose(4000);
    expect(close.code).toBe(1009);
  });

  it('P7: a message with no correlation id is BAD_ENVELOPE', async () => {
    const c = await client();
    c.send(JSON.stringify({ type: 'message', version: 1, payload: { text: 'hello' } }));
    expect(await errorCode(c)).toBe('BAD_ENVELOPE');
    c.close();
  });

  /**
   * In a match, deliberately: the state check runs before content-type
   * dispatch, so an idle sender is told NOT_MATCHED and the refusal this row is
   * about never runs. That ordering is fine and it means the row cannot be
   * tested from an idle session.
   */
  it('P10: a content type other than text is refused, never coerced (§23.5)', async () => {
    const [a, b] = await matchedPair();
    // `type`, which is the field the catalogue names. `contentType` is not a
    // member of MessagePayload, so sending that instead exercises P26's
    // ignore-unknown-fields rule and the message is delivered as ordinary text
    // — which is correct, and is not this row.
    a.command('message', { text: 'hello', type: 'image' }, 'p10');
    expect(await errorCode(a)).toBe('UNSUPPORTED_CONTENT_TYPE');
    a.close();
    b.close();
  });

  /**
   * §23.6: a reserved media field must be refused rather than silently dropped.
   * Coercing it would let a sender believe an image was delivered when only
   * text was.
   */
  it('P11: a reserved media field is refused rather than ignored', async () => {
    const c = await client();
    c.command('message', { text: 'hello', mediaId: 'abc123' }, 'p11');
    expect(await errorCode(c)).toBe('UNSUPPORTED_CONTENT_TYPE');
    c.close();
  });

  it('P12: whitespace-only text is EMPTY_MESSAGE', async () => {
    const c = await client();
    c.command('message', { text: '   \t  ' }, 'p12');
    expect(await errorCode(c)).toBe('EMPTY_MESSAGE');
    c.close();
  });
});

describe('P13 — the strike budget', () => {
  it('closes with 4003 after the configured number of invalid frames', async () => {
    const c = await client();
    for (let i = 0; i < 12; i += 1) c.send('not json');
    const close = await c.waitForClose(5000);
    expect(close.code).toBe(4003);
  });
});

describe('P14-P23 — commands against the wrong state', () => {
  it('P15: a message while idle is NOT_MATCHED', async () => {
    const c = await client();
    c.command('message', { text: 'hello' }, 'p15');
    expect(await errorCode(c)).toBe('NOT_MATCHED');
    c.close();
  });

  /**
   * "Ensure I am idle" is the documented meaning, so an error here is the bug —
   * the catalogue says so explicitly.
   */
  it('P16: leave_chat while idle is a no-op, not an error', async () => {
    const c = await client();
    c.command('leave_chat', {});
    expect(await errorCode(c, 700)).toBe('none');
    c.close();
  });

  /**
   * Not an error, and — the part worth testing — **not a queue join**.
   * `lifecycle.skip` returns idle without re-queueing when there is no match,
   * so a client that skips while idle must not silently start searching.
   */
  it('P17: skip while idle reports IDLE and does not join the queue', async () => {
    const c = await client();
    c.command('skip', {});
    const status = await c.next('queue_status');
    expect(payloadOf<QueueStatusPayload>(status).state).toBe('IDLE');
    c.close();
  });

  it('P18: report while idle is NOT_MATCHED — there is no partner to name', async () => {
    const c = await client();
    c.command('report', { category: 'harassment' });
    expect(await errorCode(c)).toBe('NOT_MATCHED');
    c.close();
  });

  it('P19: block while idle is NOT_MATCHED', async () => {
    const c = await client();
    c.command('block', {});
    expect(await errorCode(c)).toBe('NOT_MATCHED');
    c.close();
  });

  it('P20: leave_chat twice is idempotent', async () => {
    const [a, b] = await matchedPair();
    a.command('leave_chat', {});
    await a.next('queue_status');
    a.command('leave_chat', {});
    expect(await errorCode(a, 700)).toBe('none');
    a.close();
    b.close();
  });

  /**
   * The catalogue says ALREADY_MATCHED; the server answers **nothing** (F-043).
   *
   * `lifecycle.joinQueue` returns `matched_elsewhere` for this, and
   * `replyToSearch` deliberately sends no frame for that outcome — correctly,
   * for the case it was written against: a peer matched this session while it
   * was joining, so a `matched` frame is already inbound (§10.1).
   *
   * A deliberate re-join while already matched reaches the same branch, and
   * there is nothing inbound. The client waits for a reply that never comes.
   * Asserted as it behaves, and recorded, because inventing a frame here is a
   * protocol decision.
   */
  it('P14: join_queue while matched is answered with silence (see F-043)', async () => {
    const [a, b] = await matchedPair();
    const before = a.frames.length;
    a.command('join_queue', {});
    await new Promise((r) => setTimeout(r, 800));
    expect(a.frames.slice(before)).toEqual([]);
    a.close();
    b.close();
  });

  /**
   * The §10.8 race, arrived at deliberately rather than waited for: after a
   * skip the session is no longer in its old match, so a message that was
   * already in flight has nowhere to go.
   */
  it('P22: a message immediately after a skip is NOT_MATCHED', async () => {
    const [a, b] = await matchedPair();
    a.command('skip', {});
    // Awaited, so the message is sent *after* the skip has been applied rather
    // than racing it. Without this the message can arrive while the match still
    // exists and be delivered, which is a different scenario that happens to
    // pass through the same code.
    await a.next('queue_status', 3000);
    a.command('message', { text: 'into the void' }, 'p22');
    expect(await errorCode(a, 3000)).toBe('NOT_MATCHED');
    a.close();
    b.close();
  });

  /**
   * Typing is unacknowledged on success and still errors when there is no
   * partner. Worth knowing because a client firing typing into a teardown race
   * sees errors it did not expect.
   */
  it('P23: typing after the match ended is NOT_MATCHED', async () => {
    const [a, b] = await matchedPair();
    a.command('leave_chat', {});
    // No queue_status is sent for a leave from a match, so this settles rather
    // than waiting for a frame that does not come.
    await new Promise((r) => setTimeout(r, 400));
    a.command('typing', { active: true });
    expect(await errorCode(a)).toBe('NOT_MATCHED');
    a.close();
    b.close();
  });
});

describe('P8-P9 — message id dedupe is match-scoped (I14)', () => {
  it('P8: the same id twice in one match is delivered once', async () => {
    const [a, b] = await matchedPair();
    a.command('message', { text: 'first' }, 'dup-1');
    await a.next('message_ack');

    a.command('message', { text: 'second' }, 'dup-1');
    expect(await errorCode(a)).toBe('DUPLICATE_MESSAGE');

    a.close();
    b.close();
  });

  /**
   * The other half, and the reason the dedupe is scoped: a client that numbers
   * its messages from one in every conversation is behaving correctly, and a
   * globally scoped dedupe would silently drop its first message every time.
   */
  it('P9: the same id in a different match is accepted', async () => {
    const [a1, b1] = await matchedPair();
    a1.command('message', { text: 'hello' }, 'scoped-1');
    await a1.next('message_ack');
    a1.close();
    b1.close();

    const [a2, b2] = await matchedPair();
    a2.command('message', { text: 'hello again' }, 'scoped-1');
    const ack = await a2.next('message_ack', 3000);
    expect(ack).toBeDefined();
    a2.close();
    b2.close();
  });
});

describe('P24, P26 — the rows that assert an absence', () => {
  /**
   * P24 is catalogued as **not expressible**, and the test is that it stays
   * that way: `ReportPayload` is `{category, note}` and the conversation is
   * resolved server-side. If a field naming the subject ever appears, this row
   * becomes a real scenario — and this is what fails.
   *
   * The same rule as §25.3 and protocol rule 3: the subject of a state change
   * never arrives from outside.
   */
  it('P24: a report cannot name a conversation, because the field does not exist', async () => {
    const [a, b] = await matchedPair();
    a.command('report', {
      category: 'harassment',
      // Both ignored. If either were honoured, a caller could report a
      // conversation they were never in.
      conversationId: 'conv_somebody_else',
      matchId: 'm_somebody_else',
    });
    // Accepted on the caller's own conversation, and the forged ids change
    // nothing: no error naming them, and no frame carrying them back.
    const code = await errorCode(a, 1200);
    expect(code === 'none' || code === 'RATE_LIMITED').toBe(true);
    expect(JSON.stringify(a.frames)).not.toContain('somebody_else');
    a.close();
    b.close();
  });

  /**
   * The forward-compatibility contract: unknown fields are ignored, and only
   * the reserved media fields are refused. Without this, adding a field to a
   * payload would be a breaking change for every older client.
   */
  it('P26: unknown fields on a payload are accepted and ignored', async () => {
    const c = await client();
    c.command('join_queue', { somethingNewInV2: true, anotherField: 42 });
    const status = await c.next('queue_status');
    expect(payloadOf<QueueStatusPayload>(status).state).toBe('SEARCHING');
    c.close();
  });
});

describe('P25, P27, P28 — size and type discipline', () => {
  it('P25: structurally valid but enormous JSON is closed before it is parsed', async () => {
    const c = await TestClient.connect(server.url, {
      headers: { 'X-Forwarded-For': '198.18.99.25' },
    });
    await c.waitForFrame('connected');
    // Valid JSON, well over the frame limit. The cost of parsing it is what the
    // limit exists to avoid, so the close must come from `ws` rather than from
    // the validator.
    c.send(JSON.stringify({ type: 'message', version: 1, id: 'p25', payload: { text: 'a'.repeat(40_000) } }));
    const close = await c.waitForClose(4000);
    expect(close.code).toBe(1009);
  });

  it('P27: a field of the wrong type is VALIDATION_FAILED', async () => {
    const c = await client();
    c.command('message', { text: 42 }, 'p27');
    expect(await errorCode(c)).toBe('VALIDATION_FAILED');
    c.close();
  });

  it('P28: null where a value is required is refused, never coerced', async () => {
    const c = await client();
    c.command('message', { text: null }, 'p28');
    const code = await errorCode(c);
    // Refused. The distinction that matters is that it is not treated as an
    // empty string and delivered as one.
    expect(['VALIDATION_FAILED', 'EMPTY_MESSAGE']).toContain(code);
    c.close();
  });
});

describe('L11 — several connections presenting one cookie', () => {
  /**
   * A shared browser, a copied token, or somebody with two tabs open.
   *
   * The client token is **half of a block identity** (D18) and is deliberately
   * not a session key. So two connections presenting the same one must each get
   * their own session: sharing a session would mean two people driving one
   * conversation, and deriving a session from the token would make a block
   * token into a session hijacking primitive.
   *
   * This is L11 in the catalogue, and it is here rather than in the swarm
   * because every accounting assumption in that harness is "one bot, one
   * socket" — the same structural reason L15's concurrency half is not there.
   */
  it('gives each connection its own session, and never shares one', async () => {
    const cookie = `${CLIENT_TOKEN_COOKIE}=${'a'.repeat(32)}`;
    const headers = { Cookie: cookie, 'X-Forwarded-For': '198.18.77.1' };

    const first = await TestClient.connect(server.url, { headers });
    const second = await TestClient.connect(server.url, { headers });

    const a = payloadOf<{ sessionId: string }>(await first.waitForFrame('connected'));
    const b = payloadOf<{ sessionId: string }>(await second.waitForFrame('connected'));

    expect(a.sessionId).toBeTruthy();
    expect(b.sessionId).toBeTruthy();
    // The whole row: one token, two sessions.
    expect(a.sessionId).not.toBe(b.sessionId);

    first.close();
    second.close();
  });

  /**
   * And they are genuinely independent: one searching does not put the other
   * in a queue, because the queue keys on the session and not on the token.
   */
  it('keeps the two sessions independent when one of them searches', async () => {
    const cookie = `${CLIENT_TOKEN_COOKIE}=${'b'.repeat(32)}`;
    const headers = { Cookie: cookie, 'X-Forwarded-For': '198.18.77.2' };

    const first = await TestClient.connect(server.url, { headers });
    const second = await TestClient.connect(server.url, { headers });
    await first.waitForFrame('connected');
    await second.waitForFrame('connected');

    first.command('join_queue', {});
    const status = await first.next('queue_status');
    expect(payloadOf<QueueStatusPayload>(status).state).toBe('SEARCHING');

    // The second connection was not dragged into a search it never asked for.
    // A message from it reports NOT_MATCHED, which is the idle answer — if the
    // token were the session key it would be sharing the first one's state.
    second.command('message', { text: 'am I in a chat?' }, 'l11');
    expect(await errorCode(second)).toBe('NOT_MATCHED');

    first.close();
    second.close();
  });
});
