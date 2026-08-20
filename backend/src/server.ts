/**
 * The HTTP server, the WebSocket upgrade path, and the command router.
 *
 * No framework (D10): three endpoints and one upgrade do not justify one, and
 * the routing below is short enough to read in full — which matters, because
 * the upgrade handler is where every untrusted HTTP-level input is decided on.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF CHECKS AT UPGRADE
 * ---------------------------------------------------------------------------
 * Cheapest and most absolute first, so an abusive client is refused before it
 * costs a Redis round trip:
 *
 *   path → origin → per-instance capacity → identity → connection rate →
 *   subscribe → session row → concurrency cap
 *
 * `/ready` reflects **Redis only**. A backend whose database is down still
 * serves chat correctly and must stay in the load balancer (§10.18); one whose
 * Redis is down cannot serve a single transition and must leave it.
 */
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import type { Config, RateLimitedCommand } from './config';
import { moderate } from './moderation';
import type { Logger } from './logger';
import { CLOSE_CODES, type ServerFeatures, type ServerLimits } from './protocol/types';
import type { ValidatedCommand } from './protocol/validate';
import type { RedisClients } from './redis/client';
import { createKeys } from './redis/keys';
import type { BanCheck, RedisStore } from './redis/store';
import type { Metrics } from './metrics/registry';
import type { RetentionSink } from './storage/sink';
import { hashIp } from './util/ids';
import { monotonicMs, nowIso, secondsSince } from './util/time';
import { SocketConnection } from './ws/connection';
import { EventDispatcher } from './ws/dispatch';
import { SessionLifecycle, type SearchOutcome } from './ws/lifecycle';
import { MessagePipeline, type MessageOutcome } from './ws/messages';
import { ConnectionRegistry } from './ws/registry';
import { Janitor } from './ws/janitor';
import { SessionSubscriber } from './ws/subscriber';
import {
  clientAddress,
  clientTokenCookie,
  isOriginAllowed,
  resolveClientToken,
} from './ws/upgrade';

export interface ChatServerDeps {
  config: Config;
  logger: Logger;
  store: RedisStore;
  clients: RedisClients;
  /** Where retained records go. Never awaited on the chat path (D16). */
  retention: RetentionSink;
  metrics: Metrics;
}

export interface ChatServer {
  readonly httpServer: Server;
  readonly registry: ConnectionRegistry;
  readonly lifecycle: SessionLifecycle;
  /** The port actually bound. Differs from the configured one when it was 0. */
  readonly port: number;
  /** True once shutdown has begun: /ready reports 503 and upgrades are refused. */
  readonly draining: boolean;
  listen(): Promise<number>;
  stop(): Promise<void>;
}

/**
 * Features this build has actually wired up.
 *
 * Advertised rather than assumed, so the UI hides what the server cannot do
 * instead of discovering it through a rejection (§6.3). `typing` and `report`
 * arrive with the message pipeline and the retention store respectively.
 */
const FEATURES: ServerFeatures = {
  typing: true,
  presence: true,
  report: true,
  block: true,
};

export function createChatServer(deps: ChatServerDeps): ChatServer {
  const { config, logger, store, clients, retention, metrics } = deps;
  const keys = createKeys(config.redis.keyPrefix);
  const registry = new ConnectionRegistry(logger);
  const dispatcher = new EventDispatcher(registry, store, logger);
  const lifecycle = new SessionLifecycle(store, dispatcher, registry, config, logger, retention);
  const subscriber = new SessionSubscriber(clients.subscriber, keys, registry, logger);
  const pipeline = new MessagePipeline(store, dispatcher, config, logger, retention);
  const janitor = new Janitor(config, logger, store, dispatcher, (counts) => {
    // Cluster-wide gauges, refreshed by whichever instance held the lock. They
    // are the same Redis cardinalities the presence frame reports, so the
    // dashboard and the UI cannot disagree.
    metrics.activeMatches.set(counts.conversations);
    metrics.queueDepth.labels(config.matchmaking.defaultSegment).set(counts.queueDepth);
  });

  const limits: ServerLimits = {
    maxMessageLength: config.limits.maxMessageLength,
    maxReportNoteLength: config.limits.maxReportNoteLength,
    messagesPerSecond: config.limits.rates.message.perSecond,
    burst: config.limits.rates.message.burst,
    typingPerSecond: config.limits.rates.typing.perSecond,
    maxFrameBytes: config.limits.maxFrameBytes,
  };

  const httpServer = createHttpServer((req, res) => handleHttp(req, res));
  const wss = new WebSocketServer({
    noServer: true,
    // `ws` closes the socket with 1009 on an oversized frame before this
    // process ever allocates the payload — the check has to be here rather
    // than after parsing, or the limit protects nothing.
    maxPayload: config.limits.maxFrameBytes,
  });

  /** Handshake headers staged per request; see the upgrade handler. */
  const pendingHeaders = new WeakMap<IncomingMessage, string[]>();
  wss.on('headers', (headers: string[], req: IncomingMessage) => {
    const staged = pendingHeaders.get(req);
    if (staged) {
      headers.push(...staged);
      pendingHeaders.delete(req);
    }
  });

  let heartbeatTimer: NodeJS.Timeout | null = null;
  let presenceTimer: NodeJS.Timeout | null = null;
  let boundPort = config.http.port;
  let draining = false;

  /* --- HTTP --------------------------------------------------------------- */

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method !== 'GET') {
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }

    if (path === '/health') {
      // Liveness: is this process running. Deliberately independent of every
      // dependency, so a Redis outage does not make an orchestrator restart
      // processes that are working fine.
      json(res, 200, { status: draining ? 'draining' : 'ok', instance: config.instanceId });
      return;
    }

    if (path === '/ready') {
      const health = clients.health();
      const ready = health === 'ready' && !draining;
      json(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        redis: health,
        draining,
      });
      return;
    }

    if (config.metrics.enabled && path === config.metrics.path) {
      void metrics
        .scrape()
        .then((body) => {
          res.writeHead(200, {
            'content-type': metrics.registry.contentType,
            'cache-control': 'no-store',
          });
          res.end(body);
        })
        .catch(() => json(res, 500, { error: 'scrape_failed' }));
      return;
    }

    json(res, 404, { error: 'not_found' });
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      'cache-control': 'no-store',
    });
    res.end(payload);
  }

  /* --- upgrade ------------------------------------------------------------ */

  httpServer.on('upgrade', (req, socket, head) => {
    void handleUpgrade(req, socket, head);
  });

  async function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const path = (req.url ?? '/').split('?')[0];
    if (path !== config.http.wsPath) {
      metrics.connectionsRejected.labels('bad_path').inc();
      refuse(socket, 404, 'not_found');
      return;
    }

    if (draining) {
      metrics.connectionsRejected.labels('draining').inc();
      refuse(socket, 503, 'shutting_down');
      return;
    }

    if (!isOriginAllowed(req.headers.origin, config.http.allowedOrigins)) {
      // Refused without saying what would have been accepted: the allowlist is
      // not something a caller needs to enumerate.
      metrics.connectionsRejected.labels('origin').inc();
      logger.warn('rejected a websocket upgrade from a disallowed origin');
      refuse(socket, 403, 'origin_not_allowed');
      return;
    }

    if (registry.size >= config.limits.maxConnections) {
      metrics.connectionsRejected.labels('at_capacity').inc();
      logger.warn('refusing a connection: instance at capacity', { connections: registry.size });
      refuse(socket, 503, 'at_capacity');
      return;
    }

    const address = clientAddress(req, config.http.trustProxyHops);
    const ipHash = hashIp(address, config.security.ipHashSalt);
    const { token, issued } = resolveClientToken(req);
    const clientHash = hashIp(token, config.security.ipHashSalt);

    // Enforcement, before a session exists (I11). Placed here rather than in
    // `lifecycle.open` on purpose: a banned connection should consume no
    // session id, no Pub/Sub subscription and no connection slot, so the check
    // has to precede the first thing that allocates any of them.
    //
    // A Redis failure here refuses the connection rather than admitting it. The
    // opposite default — fail open, so an outage cannot lock everyone out — is
    // the usual instinct and is wrong for this specific check: `/ready` already
    // drops an instance with unhealthy Redis out of the load balancer, so the
    // failure mode is a connection that was going to fail moments later anyway,
    // whereas failing open would silently un-ban every sanctioned user for the
    // duration of the outage.
    let ban: BanCheck;
    try {
      ban = await store.checkBan(ipHash, clientHash);
    } catch (err) {
      metrics.connectionsRejected.labels('error').inc();
      logger.error('failed to check enforcement state', {
        errName: err instanceof Error ? err.name : 'unknown',
      });
      refuse(socket, 503, 'unavailable');
      return;
    }

    if (ban.banned) {
      metrics.connectionsRejected.labels('banned').inc();
      // The enforcement id, never the hash: it identifies the decision, not the
      // person, and it is the handle an operator needs to find the audit row.
      logger.info('refused a banned connection', {
        dimension: ban.dimension,
        enforcementId: ban.enforcementId,
      });
      // Deliberately the same shape of refusal a disallowed origin gets, with
      // no detail about which dimension matched or how long it lasts. Telling a
      // banned client that its cookie is the problem is telling it exactly what
      // to change.
      refuse(socket, 403, 'forbidden');
      return;
    }

    const subscribedTo: string[] = [];
    const releaseSubscription = async (): Promise<void> => {
      for (const sessionId of subscribedTo) await subscriber.unsubscribe(sessionId);
    };

    let outcome;
    try {
      outcome = await lifecycle.open(ipHash, clientHash, async (sessionId) => {
        // Before the session row exists, so no event can be published to a
        // session this instance is not yet listening for (§11).
        await subscriber.subscribe(sessionId);
        subscribedTo.push(sessionId);
      });
    } catch (err) {
      await releaseSubscription();
      metrics.connectionsRejected.labels('error').inc();
      logger.error('failed to open a session', {
        errName: err instanceof Error ? err.name : 'unknown',
      });
      refuse(socket, 503, 'unavailable');
      return;
    }

    if (outcome.kind !== 'opened') {
      await releaseSubscription();
      if (outcome.kind === 'rate_limited') {
        metrics.connectionsRejected.labels('rate_limited').inc();
        refuse(socket, 429, 'too_many_attempts', { 'retry-after': String(outcome.retryAfterSeconds) });
      } else {
        metrics.connectionsRejected.labels('too_many_connections').inc();
        refuse(socket, 429, 'too_many_connections');
      }
      return;
    }

    const sessionId = outcome.sessionId;

    // `ws` writes the handshake response itself and emits 'headers'
    // synchronously from inside handleUpgrade, so the header has to be staged
    // *before* the call. Keyed by the request rather than registered as a
    // one-shot listener: a one-shot on a shared emitter would attach the
    // cookie to whichever upgrade happened to be handled next.
    if (issued) {
      pendingHeaders.set(req, [`Set-Cookie: ${clientTokenCookie(token, config)}`]);
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      attach(ws, sessionId, ipHash, clientHash);
    });
  }

  function refuse(
    socket: Duplex,
    status: number,
    reason: string,
    headers: Record<string, string> = {},
  ): void {
    const statusText: Record<number, string> = {
      403: 'Forbidden',
      404: 'Not Found',
      429: 'Too Many Requests',
      503: 'Service Unavailable',
    };
    const body = JSON.stringify({ error: reason });
    const lines = [
      `HTTP/1.1 ${status} ${statusText[status] ?? 'Error'}`,
      'content-type: application/json',
      `content-length: ${Buffer.byteLength(body)}`,
      'connection: close',
      ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
      '',
      body,
    ];
    socket.write(lines.join('\r\n'));
    socket.destroy();
  }

  /* --- connection --------------------------------------------------------- */

  function attach(ws: WebSocket, sessionId: string, ipHash: string, clientHash: string): void {
    const connection = new SocketConnection({
      socket: ws,
      sessionId,
      ipHash,
      clientHash,
      config,
      logger,
      onCommand: (command, conn) => handleCommand(command, conn),
      onClose: async (conn) => {
        // A socket closing while Redis is unavailable — a restart, a failover,
        // a test tearing its server down — must not produce an unhandled
        // rejection. The TTLs and the janitor are the recovery net for whatever
        // this could not clean up (§13).
        try {
          await lifecycle.close(conn.sessionId, conn.ipHash, conn);
        } catch (err) {
          logger.warn('session cleanup failed', {
            sessionId: conn.sessionId,
            errName: err instanceof Error ? err.name : 'unknown',
          });
        }
        await subscriber.unsubscribe(conn.sessionId);
        metrics.disconnects.inc();
        metrics.connectionsActive.set(registry.size);
      },
    });

    registry.add(connection);
    metrics.connectionsTotal.inc();
    metrics.connectionsActive.set(registry.size);
    connection.sendEvent('connected', {
      sessionId,
      protocolVersion: 1,
      serverTime: nowIso(),
      limits,
      features: FEATURES,
    });
    void sendPresence(connection);
  }

  /**
   * Every state-changing command passes its own token bucket before it does
   * anything (R7, §17).
   *
   * Per command, not per connection: a cheap protocol command must not be
   * usable to spend the message budget, and a strict limit on `report` must not
   * be reachable by sending something else. `ping` has no bucket by design —
   * it is the liveness probe, already bounded by the heartbeat interval, and
   * limiting it would let an idle client be reaped for keeping itself alive.
   *
   * The client is told `RATE_LIMITED` and nothing else: which bucket, how full
   * it was and when it refills are all internal (§17).
   */
  async function withinRateLimit(
    command: RateLimitedCommand,
    connection: SocketConnection,
  ): Promise<boolean> {
    const limit = await store.rateLimit(command, connection.sessionId);
    if (limit.allowed) return true;
    metrics.rateLimited.labels(command).inc();
    connection.sendError('RATE_LIMITED', 'slow down');
    return false;
  }

  async function handleCommand(
    command: ValidatedCommand,
    connection: SocketConnection,
  ): Promise<void> {
    // `message` and `typing` check their own buckets inside the pipeline, where
    // the rest of their ordering lives (§14.1).
    if (
      command.type !== 'ping' &&
      command.type !== 'message' &&
      command.type !== 'typing' &&
      !(await withinRateLimit(command.type, connection))
    ) {
      return;
    }

    switch (command.type) {
      case 'ping':
        connection.sendEvent('pong', { serverTime: nowIso() });
        return;

      case 'message': {
        metrics.messagesReceived.inc();
        const started = monotonicMs();
        const outcome = await pipeline.send(
          connection.sessionId,
          command.clientId,
          command.contentType,
          command.text,
        );
        if (outcome.kind === 'accepted') {
          metrics.messagesDelivered.labels(outcome.delivered ? outcome.route : 'dropped').inc();
          metrics.deliveryLatency.labels(outcome.route).observe(secondsSince(started));
          for (const flag of outcome.flags) void flag;
          metrics.moderationFlags.labels(outcome.flags.length > 0 ? 'flag' : 'allow').inc();
        } else {
          metrics.messagesRejected.labels(outcome.kind).inc();
          if (outcome.kind === 'withheld') metrics.moderationFlags.labels('block').inc();
        }
        replyToMessage(connection, command.clientId, outcome);
        return;
      }

      case 'typing': {
        const outcome = await pipeline.typing(connection.sessionId, command.active);
        // Nothing is sent back on success: an acknowledged typing indicator
        // would double this command's traffic to confirm something advisory.
        if (outcome.kind === 'rate_limited') {
          connection.sendError('RATE_LIMITED', 'slow down');
        } else if (outcome.kind === 'not_matched') {
          connection.sendError('NOT_MATCHED', 'you are not in a conversation');
        }
        return;
      }

      case 'join_queue': {
        // A declared name is shown to every stranger this session meets, so it
        // is moderated more strictly than a message: *any* rule firing refuses
        // it, rather than the default flag-and-deliver (D20). A message is one
        // utterance judged in context; a name is a label on a person, and a
        // contact handle in a name is unambiguously an advert rather than
        // something a moderator should weigh later.
        const declaredName = command.profile.name;
        if (declaredName !== null && config.moderation.enabled) {
          const verdict = moderate({ type: 'text', text: declaredName }, config.moderation);
          if (verdict.flags.length > 0) {
            metrics.profilesRefused.labels('name_moderation').inc();
            // Rule ids only. The name itself is user content and must not reach
            // a log line (I8).
            logger.info('refused a declared name', { flags: verdict.flags });
            connection.sendError('VALIDATION_FAILED', 'that name cannot be used');
            return;
          }
        }

        const outcome = await lifecycle.joinQueue(connection.sessionId, command.profile);
        replyToSearch(connection, outcome);
        return;
      }

      case 'leave_queue': {
        const outcome = await lifecycle.leaveQueue(connection.sessionId);
        if (outcome.kind === 'session_gone') return sessionGone(connection);
        if (outcome.kind === 'already_matched') {
          connection.sendError('ALREADY_MATCHED', 'you are in a conversation');
          return;
        }
        connection.sendEvent('queue_status', { state: 'IDLE', waiting: 0 });
        return;
      }

      case 'leave_chat': {
        const outcome = await lifecycle.leaveChat(connection.sessionId);
        if (outcome.kind === 'session_gone') return sessionGone(connection);
        // Both 'left' and 'idle' end in the same place, and the client asked to
        // be there. Reporting them differently would describe the server's
        // bookkeeping rather than the user's situation.
        connection.sendEvent('queue_status', { state: 'IDLE', waiting: 0 });
        return;
      }

      case 'skip': {
        metrics.skips.inc();
        const outcome = await lifecycle.skip(connection.sessionId);
        replyToSearch(connection, outcome);
        return;
      }

      case 'block': {
        const outcome = await lifecycle.block(connection.sessionId, {
          ipHash: connection.ipHash,
          clientHash: connection.clientHash,
        });
        if (outcome.kind === 'session_gone') return sessionGone(connection);
        if (outcome.kind === 'not_matched') {
          connection.sendError('NOT_MATCHED', 'you are not in a conversation');
          return;
        }
        metrics.blocks.labels('recorded').inc(outcome.recorded);
        // The blocker is returned to IDLE rather than re-queued (§5).
        connection.sendEvent('queue_status', { state: 'IDLE', waiting: 0 });
        return;
      }

      case 'report': {
        // The reported party is resolved server-side; a client never names who
        // it is reporting, because it is never told a partner session id.
        const route = await store.resolveRoute(connection.sessionId);
        if (route.status === 'not_matched') {
          connection.sendError('NOT_MATCHED', 'you are not in a conversation');
          return;
        }
        // A partner whose session expired is still reportable: the conversation
        // and its messages are what the report references, and refusing here
        // would mean the moment somebody leaves is the moment they stop being
        // reportable.
        const reportedSessionId = route.status === 'ok' ? route.partnerSessionId : '';

        const reportId = randomUUID();
        const acceptedAt = nowIso();
        const accepted = retention.enqueue({
          kind: 'report',
          reportId,
          conversationId: route.matchId,
          reporterSessionId: connection.sessionId,
          reportedSessionId,
          category: command.category,
          note: command.note,
          createdAt: acceptedAt,
        });

        if (!accepted.accepted) {
          // A report the system could not record must not be acknowledged:
          // telling a user asking for help that it was filed would be a lie
          // (§14.3). Retryable, because the queue may drain.
          logger.error('refusing to acknowledge a report that could not be recorded', {
            sessionId: connection.sessionId,
            matchId: route.matchId,
          });
          connection.sendError('INTERNAL_ERROR', 'could not record that report; please retry');
          return;
        }

        metrics.reports.inc();
        // No moderation detail, no verdict, nothing about the reported user
        // (security §31).
        connection.sendEvent('report_ack', { reportId, acceptedAt });
        return;
      }

      default: {
        const exhaustive: never = command;
        void exhaustive;
        connection.sendError('UNKNOWN_EVENT', 'unknown event type');
      }
    }
  }

  function replyToMessage(
    connection: SocketConnection,
    clientMsgId: string,
    outcome: MessageOutcome,
  ): void {
    switch (outcome.kind) {
      case 'accepted':
        connection.sendEvent('message_ack', {
          clientMsgId,
          messageId: outcome.messageId,
          matchId: outcome.matchId,
          acceptedAt: outcome.acceptedAt,
          route: outcome.route,
          delivered: outcome.delivered,
        });
        return;
      case 'withheld':
        // The hard rule set refused it. Not retryable, and deliberately vague:
        // naming the rule would tell someone probing the filter exactly which
        // pattern to work around.
        connection.sendError('MESSAGE_WITHHELD', 'that message was not delivered');
        return;
      case 'rate_limited':
        connection.sendError('RATE_LIMITED', 'slow down');
        return;
      case 'duplicate':
        // The first copy was delivered; this one was not (I14). Not retryable:
        // retrying is what produced it, and a new message needs a new id.
        connection.sendError('DUPLICATE_MESSAGE', 'that message id was already used');
        return;
      case 'dedupe_full':
        connection.sendError('DUPLICATE_MESSAGE', 'too many messages in this conversation');
        return;
      case 'not_matched':
        connection.sendError('NOT_MATCHED', 'you are not in a conversation');
        return;
    }
  }

  function replyToSearch(connection: SocketConnection, outcome: SearchOutcome): void {
    switch (outcome.kind) {
      case 'matched':
        metrics.matchesCreated.inc();
        connection.sendEvent('matched', {
          matchId: outcome.matchId,
          startedAt: outcome.startedAt,
          you: outcome.you,
          partner: outcome.partner,
        });
        return;
      case 'searching':
        connection.sendEvent('queue_status', { state: 'SEARCHING', waiting: outcome.waiting });
        return;
      case 'idle':
        connection.sendEvent('queue_status', { state: 'IDLE', waiting: 0 });
        return;
      case 'matched_elsewhere':
        // Nothing to send: the `matched` frame is already inbound from the
        // instance that won the race (§10.1).
        return;
      case 'session_gone':
        sessionGone(connection);
        return;
    }
  }

  function sessionGone(connection: SocketConnection): void {
    connection.sendError('SESSION_GONE', 'your session expired; reconnect');
    connection.close(CLOSE_CODES.SESSION_GONE, 'session gone');
  }

  /* --- periodic work ------------------------------------------------------ */

  /**
   * One sweep for every local socket, rather than a timer per connection: at
   * five thousand sockets the per-connection version is five thousand timers
   * and five thousand closures held live for no benefit.
   */
  async function heartbeatSweep(): Promise<void> {
    for (const connection of registry.all()) {
      // Re-checked inside the loop, not just at entry: a sweep already running
      // when shutdown begins would otherwise keep issuing Redis commands after
      // the connection was closed, which surfaces as an unhandled rejection
      // from whatever ran next.
      if (draining) return;
      if (!(connection instanceof SocketConnection)) continue;
      if (!connection.pingOrTimeout()) continue;
      try {
        const beat = await lifecycle.heartbeat(connection.sessionId);
        if (beat.kind === 'session_gone') sessionGone(connection);
      } catch (err) {
        // A Redis blip must not take the socket down: /ready has already gone
        // red, and the next sweep will retry.
        logger.debug('heartbeat failed', {
          sessionId: connection.sessionId,
          errName: err instanceof Error ? err.name : 'unknown',
        });
      }
    }
  }

  /** Real Redis cardinalities, cached by the interval itself (D21). */
  async function presenceSweep(): Promise<void> {
    if (draining || registry.size === 0) return;
    try {
      const counts = await store.presenceCounts();
      for (const connection of registry.all()) {
        if (connection instanceof SocketConnection) {
          connection.sendEvent('presence', { ...counts, approximate: true });
        }
      }
    } catch (err) {
      logger.debug('presence sweep failed', {
        errName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  async function sendPresence(connection: SocketConnection): Promise<void> {
    if (draining) return;
    try {
      const counts = await store.presenceCounts();
      connection.sendEvent('presence', { ...counts, approximate: true });
    } catch {
      // A missing presence count is cosmetic; the connection is still usable.
    }
  }

  /* --- lifecycle ---------------------------------------------------------- */

  return {
    httpServer,
    registry,
    lifecycle,
    get port() {
      return boundPort;
    },

    get draining() {
      return draining;
    },

    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(config.http.port, config.http.host, () => {
          httpServer.removeListener('error', reject);
          resolve();
        });
      });
      const address = httpServer.address();
      if (address !== null && typeof address === 'object') boundPort = address.port;

      heartbeatTimer = setInterval(() => {
        void heartbeatSweep();
      }, config.timers.heartbeatIntervalMs);
      heartbeatTimer.unref();

      presenceTimer = setInterval(() => {
        void presenceSweep();
      }, config.presence.intervalMs);
      presenceTimer.unref();

      janitor.start();

      logger.info('listening', { port: boundPort, wsPath: config.http.wsPath });
      return boundPort;
    },

    async stop(): Promise<void> {
      // Refusing new upgrades is the first thing that happens: a load balancer
      // that has not yet noticed /ready going red must not be able to hand this
      // instance a connection it is about to drop.
      //
      // The listener closes at the end of this method, so anything arriving
      // after that is refused at the TCP level. Holding the port open for a
      // grace period while /ready reports 503 is deliberately **not** done
      // here: how long to wait for a load balancer to deregister is a property
      // of the deployment, not of the process, and it belongs in a preStop
      // hook or a deregistration delay where an operator can see it.
      draining = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (presenceTimer) clearInterval(presenceTimer);
      janitor.stop();

      // Tell every client before the socket goes, so a reconnect is a decision
      // rather than a surprise. Their sessions are closed through the ordinary
      // path, which ends matches and releases partners.
      // Every socket is closed through the ordinary path, so each session's
      // match is ended and its partner released. A process that simply dropped
      // its sockets would leave every partner waiting for a TTL.
      const closing = registry.all().filter((c): c is SocketConnection => c instanceof SocketConnection);
      for (const connection of closing) {
        connection.sendEvent('server_shutdown', { reason: 'shutdown' });
        connection.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
      }

      // Give the close handlers time to finish their Redis work before the
      // caller tears the connections down underneath them.
      const deadline = Date.now() + config.timers.shutdownTimeoutMs;
      while (registry.size > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (registry.size > 0) {
        logger.warn('shutting down with sessions still attached', { remaining: registry.size });
      }

      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // `close` waits for every open connection, and an idle keep-alive HTTP
        // connection is open — a scraper polling /metrics would hold a draining
        // instance until its timeout. The WebSockets are already closed above;
        // this drops what is left.
        httpServer.closeAllConnections();
        // Bounds anything the platform still will not let go of.
        setTimeout(resolve, config.timers.shutdownTimeoutMs).unref();
      });
      wss.close();
    },
  };
}
