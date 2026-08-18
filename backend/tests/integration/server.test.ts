/**
 * The WebSocket server over real sockets: handshake, limits, and the control
 * commands.
 *
 * Everything here needs an actual handshake, an actual frame-size limit or an
 * actual close code, which is why none of it is a unit test.
 */
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import { CLIENT_TOKEN_COOKIE } from '../../src/ws/upgrade';
import type { ConnectedPayload, ErrorPayload, MatchedPayload, PresencePayload, QueueStatusPayload } from '../../src/protocol/types';

let http: TestServer;

async function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const base = http.url.replace('ws://', 'http://').replace(/\/ws$/, '');
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeAll(async () => {
  http = await startTestServer();
});

afterAll(async () => {
  await http.stop();
});

afterEach(async () => {
  await http.ctx.flush();
});

describe('health and readiness', () => {
  it('serves /health from the process alone', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ok', instance: http.ctx.config.instanceId });
  });

  it('serves /ready from Redis', async () => {
    const { status, body } = await get('/ready');
    // A backend with a dead database still serves chat and must stay in the
    // load balancer; one with dead Redis cannot and must leave it (§10.18).
    expect(status).toBe(200);
    expect(body).toMatchObject({ status: 'ready', redis: 'ready' });
    expect(Object.keys(body)).not.toContain('database');
  });

  it('404s an unknown path and 405s a non-GET', async () => {
    expect((await get('/nope')).status).toBe(404);
    const base = http.url.replace('ws://', 'http://').replace(/\/ws$/, '');
    const posted = await fetch(`${base}/health`, { method: 'POST' });
    expect(posted.status).toBe(405);
  });
});

describe('the handshake', () => {
  it('accepts an upgrade on the configured path and sends connected first', async () => {
    const client = await TestClient.connect(http.url);
    try {
      const frame = await client.waitForFrame('connected');
      const payload = payloadOf<ConnectedPayload>(frame);
      expect(payload.sessionId).toMatch(/^s_/);
      expect(payload.protocolVersion).toBe(1);
      expect(payload.limits.maxMessageLength).toBe(http.ctx.config.limits.maxMessageLength);
      // The UI hides what the server cannot do rather than discovering it
      // through a rejection.
      expect(payload.features).toEqual({
        typing: true,
        presence: true,
        report: false,
        block: true,
      });
    } finally {
      client.close();
    }
  });

  it('refuses an upgrade on any other path', async () => {
    const wrongPath = http.url.replace(/\/ws$/, '/socket');
    expect(await TestClient.expectRefusal(wrongPath)).toMatchObject({ status: 404 });
  });

  it('refuses a disallowed Origin without naming what would be allowed', async () => {
    const refusal = await TestClient.expectRefusal(http.url, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(refusal.status).toBe(403);
    expect(refusal.body).not.toContain('localhost');
  });

  it('accepts the configured Origin', async () => {
    const client = await TestClient.connect(http.url, {
      headers: { Origin: 'http://localhost:5173' },
    });
    try {
      await client.waitForFrame('connected');
    } finally {
      client.close();
    }
  });

  it('issues an HttpOnly block-token cookie and reuses it when presented', async () => {
    const first = await TestClient.connect(http.url);
    try {
      await first.waitForFrame('connected');
      expect(first.setCookies).toHaveLength(1);
      const cookie = first.setCookies[0] ?? '';
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toMatch(new RegExp(`^${CLIENT_TOKEN_COOKIE}=`));

      const token = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
      const second = await TestClient.connect(http.url, {
        headers: { Cookie: `${CLIENT_TOKEN_COOKIE}=${token}` },
      });
      try {
        await second.waitForFrame('connected');
        // Presented and accepted, so nothing new is minted.
        expect(second.setCookies).toEqual([]);
      } finally {
        second.close();
      }
    } finally {
      first.close();
    }
  });

  it('stores the client hash, never the token itself', async () => {
    const client = await TestClient.connect(http.url);
    try {
      const frame = await client.waitForFrame('connected');
      const { sessionId } = payloadOf<ConnectedPayload>(frame);
      const row = await http.ctx.store.readSession(sessionId);
      const cookie = client.setCookies[0] ?? '';
      const token = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));

      expect(row?.clientHash).toMatch(/^[a-f0-9]{32}$/);
      expect(row?.clientHash).not.toBe(token);
      expect(JSON.stringify(row)).not.toContain(token);
      // The address is hashed too: raw IPs never reach Redis.
      expect(row?.ipHash).toMatch(/^[a-f0-9]{32}$/);
    } finally {
      client.close();
    }
  });

  it('refuses once the per-IP concurrency cap is reached', async () => {
    const strict = await startTestServer({ MAX_CONNECTIONS_PER_IP: '1' });
    try {
      const held = await TestClient.connect(strict.url);
      await held.waitForFrame('connected');
      expect(await TestClient.expectRefusal(strict.url)).toMatchObject({ status: 429 });
      held.close();
    } finally {
      await strict.stop();
    }
  });

  it('refuses once the connection attempt rate is exhausted', async () => {
    const strict = await startTestServer({ CONN_RATE_LIMIT: '2', MAX_CONNECTIONS_PER_IP: '50' });
    try {
      const one = await TestClient.connect(strict.url);
      const two = await TestClient.connect(strict.url);
      const refusal = await TestClient.expectRefusal(strict.url);
      expect(refusal.status).toBe(429);
      one.close();
      two.close();
    } finally {
      await strict.stop();
    }
  });

  it('refuses once the instance is at capacity', async () => {
    const tiny = await startTestServer({ MAX_CONNECTIONS: '1', MAX_CONNECTIONS_PER_IP: '50' });
    try {
      const held = await TestClient.connect(tiny.url);
      await held.waitForFrame('connected');
      expect(await TestClient.expectRefusal(tiny.url)).toMatchObject({ status: 503 });
      held.close();
    } finally {
      await tiny.stop();
    }
  });
});

describe('frame handling', () => {
  it('rejects a binary frame — the socket is not a media transport (§23.2)', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      client.sendBinary(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
      const error = payloadOf<ErrorPayload>(await client.waitForFrame('error'));
      expect(error.code).toBe('BAD_ENVELOPE');
    } finally {
      client.close();
    }
  });

  it('rejects malformed frames without dropping the connection', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      client.send('not json at all');
      expect(payloadOf<ErrorPayload>(await client.next('error')).code).toBe('BAD_JSON');

      client.send({ type: 'ping', version: 99, payload: {} });
      expect(payloadOf<ErrorPayload>(await client.next('error')).code).toBe('UNSUPPORTED_VERSION');

      // Still usable: a bad frame is not a reason to end a conversation.
      client.command('ping');
      await client.waitForFrame('pong');
    } finally {
      client.close();
    }
  });

  it('closes a connection that keeps sending invalid frames', async () => {
    const strict = await startTestServer({ INVALID_MESSAGE_STRIKES: '3' });
    try {
      const client = await TestClient.connect(strict.url);
      await client.waitForFrame('connected');
      for (let i = 0; i < 3; i += 1) client.send('garbage');

      const closed = await client.waitForClose();
      expect(closed.code).toBe(4003);
      const codes = client.frames
        .filter((frame) => frame.type === 'error')
        .map((frame) => payloadOf<ErrorPayload>(frame).code);
      expect(codes).toContain('TOO_MANY_INVALID_MESSAGES');
    } finally {
      await strict.stop();
    }
  });

  it('closes with 1009 when a frame exceeds the size limit', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      // Rejected by the transport before this process allocates the payload —
      // a check after parsing would protect nothing.
      client.send('x'.repeat(http.ctx.config.limits.maxFrameBytes + 1024));
      expect((await client.waitForClose()).code).toBe(1009);
    } finally {
      client.close();
    }
  });

  it('never echoes user content back in an error', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      const canary = 'SECRET_CANARY_BODY';
      client.command('message', { text: `${canary}${'x'.repeat(600)}` }, 'c_1');
      const error = payloadOf<ErrorPayload>(await client.next('error'));
      expect(error.code).toBe('MESSAGE_TOO_LONG');
      expect(JSON.stringify(error)).not.toContain(canary);
    } finally {
      client.close();
    }
  });
});

describe('control commands', () => {
  it('answers a ping with a server-stamped pong', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      client.command('ping');
      const pong = await client.waitForFrame('pong');
      expect(new Date(payloadOf<{ serverTime: string }>(pong).serverTime).toISOString()).toBe(
        payloadOf<{ serverTime: string }>(pong).serverTime,
      );
    } finally {
      client.close();
    }
  });

  it('queues a lone user and reports the depth', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      client.command('join_queue');
      const status = payloadOf<QueueStatusPayload>(await client.waitForFrame('queue_status'));
      expect(status).toEqual({ state: 'SEARCHING', waiting: 1 });
    } finally {
      client.close();
    }
  });

  it('pairs two sockets and tells both, with different identities', async () => {
    const alice = await TestClient.connect(http.url);
    const bob = await TestClient.connect(http.url);
    try {
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');

      const bobMatch = payloadOf<MatchedPayload>(await bob.waitForFrame('matched'));
      const aliceMatch = payloadOf<MatchedPayload>(await alice.waitForFrame('matched'));

      expect(aliceMatch.matchId).toBe(bobMatch.matchId);
      // What one side calls "you" is what the other calls "partner".
      expect(aliceMatch.you).toEqual(bobMatch.partner);
      expect(aliceMatch.partner).toEqual(bobMatch.you);
      expect(aliceMatch.you.nickname).not.toBe(aliceMatch.partner.nickname);
      // The partner's session id is never on the wire.
      expect(JSON.stringify(aliceMatch)).not.toContain('s_');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('ends a match on skip and tells the partner', async () => {
    const alice = await TestClient.connect(http.url);
    const bob = await TestClient.connect(http.url);
    try {
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      const match = payloadOf<MatchedPayload>(await bob.waitForFrame('matched'));
      await alice.waitForFrame('matched');

      bob.command('skip');
      const skipped = await alice.waitForFrame('partner_skipped');
      expect(payloadOf<{ matchId: string }>(skipped).matchId).toBe(match.matchId);
      // The skipper goes back to searching; the skipped user does not.
      await bob.waitForFrame('queue_status');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('tells the partner a block is a skip, and nothing else', async () => {
    const alice = await TestClient.connect(http.url);
    const bob = await TestClient.connect(http.url);
    try {
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await bob.waitForFrame('matched');
      await alice.waitForFrame('matched');

      bob.command('block');
      await alice.waitForFrame('partner_skipped');
      // Indistinguishable from a skip (security §32): a distinct signal would
      // tell an abuser which behaviour got them blocked.
      expect(alice.frames.map((frame) => frame.type)).not.toContain('error');
      const status = payloadOf<QueueStatusPayload>(await bob.waitForFrame('queue_status'));
      expect(status.state).toBe('IDLE');
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('refuses a block when there is no conversation', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      client.command('block');
      expect(payloadOf<ErrorPayload>(await client.waitForFrame('error')).code).toBe('NOT_MATCHED');
    } finally {
      client.close();
    }
  });

  it('tells the partner when a socket disconnects', async () => {
    const alice = await TestClient.connect(http.url);
    const bob = await TestClient.connect(http.url);
    try {
      await alice.waitForFrame('connected');
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await bob.waitForFrame('matched');
      await alice.waitForFrame('matched');

      // terminate, not close: a dropped connection, not a polite goodbye.
      bob.terminate();
      await alice.waitForFrame('partner_disconnected');
    } finally {
      alice.close();
    }
  });

  it('cleans up Redis state when a socket goes away', async () => {
    const client = await TestClient.connect(http.url);
    const { sessionId } = payloadOf<ConnectedPayload>(await client.waitForFrame('connected'));
    client.command('join_queue');
    await client.waitForFrame('queue_status');

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(await http.ctx.store.readSession(sessionId)).toBeNull();
    expect(await http.ctx.store.queueDepth(http.ctx.segment)).toBe(0);
  });

  it('reports a command this build does not serve, rather than pretending', async () => {
    const client = await TestClient.connect(http.url);
    try {
      await client.waitForFrame('connected');
      // `features.report` is false because reports are persisted evidence and
      // the retention store does not exist yet. A client that sends anyway
      // gets a retryable error rather than an acknowledgement of a report
      // nobody recorded (§14.3).
      client.command('report', { category: 'spam' });
      const error = payloadOf<ErrorPayload>(await client.waitForFrame('error'));
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(error.retryable).toBe(true);
    } finally {
      client.close();
    }
  });
});

describe('presence (D21)', () => {
  it('sends real counts on connect and marks them approximate', async () => {
    const client = await TestClient.connect(http.url);
    try {
      const presence = payloadOf<PresencePayload>(await client.waitForFrame('presence'));
      expect(presence.approximate).toBe(true);
      expect(presence.online).toBeGreaterThanOrEqual(1);
      expect(presence.conversations).toBe(0);
    } finally {
      client.close();
    }
  });
});

describe('shutdown', () => {
  it('warns every client, closes with 1001 and stops accepting upgrades', async () => {
    const server = await startTestServer();
    const client = await TestClient.connect(server.url);
    await client.waitForFrame('connected');

    await server.server.stop();

    await client.waitForFrame('server_shutdown');
    expect((await client.waitForClose()).code).toBe(1001);
    await server.clients.close();
    await server.ctx.close();
  });
});
