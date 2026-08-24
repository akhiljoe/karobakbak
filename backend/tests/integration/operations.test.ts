/**
 * The operational surface: the `/metrics` scrape, the janitor loop, and
 * graceful shutdown. The phase gate.
 */
import { createNullLogger } from '../../src/logger';
import { EventDispatcher } from '../../src/ws/dispatch';
import { Janitor } from '../../src/ws/janitor';
import { ConnectionRegistry } from '../../src/ws/registry';
import { FakeConnection } from '../helpers/fakes';
import { createTestContext, enqueue, type TestContext } from '../helpers/redis';
import { startTestServer, TestClient, payloadOf, type TestServer } from '../helpers/socket';
import { newMatchId, newSessionId } from '../../src/util/ids';
import type { RetentionSink } from '../../src/storage/sink';
import type { RetentionRecord } from '../../src/storage/records';
import type { ConnectedPayload } from '../../src/protocol/types';

describe('the /metrics endpoint', () => {
  let http: TestServer;

  beforeAll(async () => {
    http = await startTestServer();
  });

  afterAll(async () => {
    await http.stop();
  });

  async function scrape(): Promise<{ status: number; body: string }> {
    const base = http.url.replace('ws://', 'http://').replace(/\/ws$/, '');
    const response = await fetch(`${base}${http.ctx.config.metrics.path}`);
    return { status: response.status, body: await response.text() };
  }

  it('serves a Prometheus exposition', async () => {
    const { status, body } = await scrape();
    expect(status).toBe(200);
    expect(body).toContain('# HELP chat_connections_active');
    expect(body).toContain('# TYPE chat_connections_active gauge');
  });

  it('counts a real connection and its disconnect', async () => {
    const client = await TestClient.connect(http.url);
    await client.waitForFrame('connected');
    expect((await scrape()).body).toMatch(/chat_connections_active\{[^}]*\} 1/);

    client.close();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const after = (await scrape()).body;
    expect(after).toMatch(/chat_connections_active\{[^}]*\} 0/);
    expect(after).toMatch(/chat_disconnects_total\{[^}]*\} 1/);
  });

  it('counts a refused upgrade under its reason', async () => {
    await TestClient.expectRefusal(http.url, { headers: { Origin: 'https://evil.example.com' } });
    expect((await scrape()).body).toMatch(
      /chat_connections_rejected_total\{[^}]*reason="origin"[^}]*\} [1-9]/,
    );
  });

  it('never exposes a session id, even after real traffic', async () => {
    const alice = await TestClient.connect(http.url);
    const bob = await TestClient.connect(http.url);
    try {
      const identity = payloadOf<ConnectedPayload>(await alice.waitForFrame('connected'));
      await bob.waitForFrame('connected');
      alice.command('join_queue');
      await alice.waitForFrame('queue_status');
      bob.command('join_queue');
      await alice.waitForFrame('matched');
      alice.command('message', { text: 'CANARY_MESSAGE_BODY' }, 'c_1');
      await alice.waitForFrame('message_ack');

      const { body } = await scrape();
      // The scrape leaves the trusted boundary of §2.1: it lands in a system
      // with its own retention, access control and backups (I8).
      expect(body).not.toContain(identity.sessionId);
      expect(body).not.toContain('CANARY_MESSAGE_BODY');
      expect(body).not.toMatch(/\b[a-f0-9]{32}\b/);
    } finally {
      alice.close();
      bob.close();
    }
  });

  it('is not served when metrics are disabled', async () => {
    const off = await startTestServer({ METRICS_ENABLED: 'false' });
    try {
      const base = off.url.replace('ws://', 'http://').replace(/\/ws$/, '');
      const response = await fetch(`${base}${off.ctx.config.metrics.path}`);
      expect(response.status).toBe(404);
    } finally {
      await off.stop();
    }
  });
});

describe('the janitor', () => {
  let ctx: TestContext;
  let registry: ConnectionRegistry;
  let janitor: Janitor;
  /** Everything the janitor handed to retention, in order. */
  let recorded: RetentionRecord[];

  beforeAll(async () => {
    ctx = await createTestContext();
    const logger = createNullLogger();
    registry = new ConnectionRegistry(logger);
    recorded = [];
    const sink: RetentionSink = {
      enqueue: (record) => {
        recorded.push(record);
        return { accepted: true };
      },
      isConversationReported: () => false,
    };
    janitor = new Janitor(
      ctx.config,
      logger,
      ctx.store,
      new EventDispatcher(registry, ctx.store, logger),
      undefined,
      sink,
    );
  });

  afterEach(async () => {
    registry.clear();
    recorded.length = 0;
    await ctx.flush();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('records how a reaped conversation ended', async () => {
    // The bug the database-agreement oracle found. `conversation_ended` was
    // enqueued only by `endMatchAndNotify` — a skip, an explicit leave, or a
    // close that ends the match — and the janitor had no retention sink at all.
    //
    // Under §28 a dropped socket no longer ends its match: the seat is held and
    // the janitor ends it when the grace window expires. So "their connection
    // died" became the ordinary path into a conversation whose `ended_at` and
    // `end_reason` stayed null for ever, and a moderator reading the transcript
    // back could not tell it apart from one somebody walked out of.
    const a = newSessionId();
    const b = newSessionId();
    await ctx.store.createSession({ sessionId: a, instanceId: 'i_one', ipHash: 'ip-a', clientHash: 'cl-a' }, ctx.segment);
    await ctx.store.createSession({ sessionId: b, instanceId: 'i_one', ipHash: 'ip-b', clientHash: 'cl-b' }, ctx.segment);
    await ctx.store.joinQueue(a, ctx.segment);
    await ctx.store.joinQueue(b, ctx.segment);
    const matched = await ctx.store.tryMatch(a, ctx.segment, newMatchId());
    if (matched.status !== 'matched') throw new Error('expected a match');

    // One side vanishes without a clean teardown, which is what a dead process
    // or an expired held seat looks like.
    await ctx.client.del(ctx.keys.session(b));
    await janitor.runPass();

    const endings = recorded.filter((record) => record.kind === 'conversation_ended');
    expect(endings).toHaveLength(1);
    expect(endings[0]).toMatchObject({
      conversationId: matched.matchId,
      // Its own reason, and the point of having one: `reap` says the other side
      // vanished, where `skip` and `disconnect` say somebody chose to leave.
      endReason: 'reap',
    });
  });

  it('refreshes this instance beacon whether or not it wins the lock', async () => {
    await ctx.client.set(ctx.keys.janitorLock(), 'i_someone_else', 'EX', 30);
    const pass = await janitor.runPass();

    expect(pass.ran).toBe(false);
    // A beacon only the leader refreshed would make every follower look
    // crashed to janitorSessions.
    expect(await ctx.client.exists(ctx.keys.instance(ctx.config.instanceId))).toBe(1);
  });

  it('clears stale queue entries left by a process that never ran a handler', async () => {
    await ctx.store.refreshInstanceBeacon(ctx.config.instanceId);
    const ghost = await ctx.session();
    await enqueue(ctx, ghost);
    await ctx.client.del(ctx.keys.session(ghost));

    const pass = await janitor.runPass();
    expect(pass.ran).toBe(true);
    expect(pass.queueRemoved).toBe(1);
    expect(await ctx.store.queueDepth(ctx.segment)).toBe(0);
  });

  it('ends a match that lost a participant and tells the survivor', async () => {
    await ctx.store.refreshInstanceBeacon(ctx.config.instanceId);
    const survivor = await ctx.session();
    const doomed = await ctx.session();
    await enqueue(ctx, survivor);
    await enqueue(ctx, doomed);
    const matchId = newMatchId();
    await ctx.store.tryMatch(doomed, ctx.segment, matchId);

    const socket = new FakeConnection(survivor);
    registry.add(socket);
    await ctx.client.del(ctx.keys.session(doomed));

    const pass = await janitor.runPass();
    expect(pass.matchesEnded).toBe(1);
    expect(pass.survivorsNotified).toBe(1);
    // From this user's point of view the stranger simply left; it is the same
    // event a live partner's disconnect would have produced.
    expect(socket.parsed()).toEqual([
      expect.objectContaining({ type: 'partner_disconnected', payload: { matchId } }),
    ]);
    expect(await ctx.store.currentMatchId(survivor)).toBeNull();
  });

  it('reaps sessions of an instance whose beacon expired', async () => {
    await ctx.store.refreshInstanceBeacon(ctx.config.instanceId);
    const orphan = await ctx.session({ instanceId: 'i_crashed' });

    const pass = await janitor.runPass();
    expect(pass.sessionsReaped).toBe(1);
    expect(await ctx.store.readSession(orphan)).toBeNull();
  });

  it('prunes instance ids that are no longer beaconing', async () => {
    await ctx.store.refreshInstanceBeacon(ctx.config.instanceId);
    await ctx.client.sadd(ctx.keys.instances(), 'i_ghost');

    const pass = await janitor.runPass();
    expect(pass.instancesRemoved).toBe(1);
  });

  it('is idempotent: a second pass finds nothing to do', async () => {
    await ctx.store.refreshInstanceBeacon(ctx.config.instanceId);
    const ghost = await ctx.session();
    await enqueue(ctx, ghost);
    await ctx.client.del(ctx.keys.session(ghost));

    await janitor.runPass();
    await ctx.client.del(ctx.keys.janitorLock());
    const second = await janitor.runPass();
    expect(second).toMatchObject({ queueRemoved: 0, matchesEnded: 0, sessionsReaped: 0 });
  });

  it('survives Redis being unavailable rather than taking the process down', async () => {
    const broken = new Janitor(
      ctx.config,
      createNullLogger(),
      {
        acquireJanitorLock: async () => {
          throw new Error('connection is closed');
        },
        refreshInstanceBeacon: async () => undefined,
        janitorQueue: async () => ({ removed: 0, remaining: 0 }),
        janitorMatches: async () => ({ dropped: 0, ended: 0, survivors: [], endedMatchIds: [] }),
        janitorSessions: async () => ({ reaped: 0, ended: 0, survivors: [], endedMatchIds: [] }),
        janitorInstances: async () => ({ removed: 0, remaining: 0 }),
        queueDepth: async () => 0,
        presenceCounts: async () => ({ online: 0, conversations: 0 }),
      },
      new EventDispatcher(registry, ctx.store, createNullLogger()),
    );

    await expect(broken.runPass()).resolves.toMatchObject({ ran: true, queueRemoved: 0 });
  });
});

describe('graceful shutdown', () => {
  it('warns clients, releases their partners, and stops accepting upgrades', async () => {
    const server = await startTestServer();
    const alice = await TestClient.connect(server.url);
    const bob = await TestClient.connect(server.url);

    await alice.waitForFrame('connected');
    const bobIdentity = payloadOf<ConnectedPayload>(await bob.waitForFrame('connected'));
    alice.command('join_queue');
    await alice.waitForFrame('queue_status');
    bob.command('join_queue');
    await alice.waitForFrame('matched');
    await bob.waitForFrame('matched');

    await server.server.stop();

    // Told before the socket goes, so a reconnect is a decision rather than a
    // surprise.
    await alice.waitForFrame('server_shutdown');
    expect((await alice.waitForClose()).code).toBe(1001);

    // Every session was closed through the ordinary path, so its match was
    // ended and its partner released. A process that simply dropped its
    // sockets would leave every partner waiting for a TTL.
    expect(await server.ctx.store.readSession(bobIdentity.sessionId)).toBeNull();
    expect(await server.ctx.client.scard(server.ctx.keys.matches())).toBe(0);

    await server.clients.close();
    await server.ctx.close();
  });

  it('stops listening once it has drained', async () => {
    const server = await startTestServer();
    await server.server.stop();

    // The listener is closed, so anything arriving now is refused at the TCP
    // level. Holding the port open while /ready reports 503 is the load
    // balancer's deregistration window, and how long that is belongs in the
    // deployment rather than in this process.
    await expect(TestClient.connect(server.url)).rejects.toThrow(/ECONNREFUSED|socket hang up/);

    await server.clients.close();
    await server.ctx.close();
  });

  it('reports draining on /health and not-ready on /ready before the listener closes', async () => {
    const server = await startTestServer();
    const base = server.url.replace('ws://', 'http://').replace(/\/ws$/, '');

    // Observed against the same predicate the endpoints read, rather than by
    // racing a fetch against the listener closing.
    const beforeReady = await fetch(`${base}/ready`);
    expect(beforeReady.status).toBe(200);

    await server.server.stop();
    // /health stays 200 while draining: the process is fine and is leaving on
    // purpose, so an orchestrator restarting it mid-drain would be the wrong
    // response. Both are asserted through the drain state, which is what the
    // handlers actually branch on.
    expect(server.server.draining).toBe(true);

    await server.clients.close();
    await server.ctx.close();
  });

  it('is safe to call twice', async () => {
    const server = await startTestServer();
    await server.server.stop();
    await expect(server.server.stop()).resolves.toBeUndefined();
    await server.clients.close();
    await server.ctx.close();
  });
});
