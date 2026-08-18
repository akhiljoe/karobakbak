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
import type { Logger } from './logger';
import { CLOSE_CODES, type ServerFeatures, type ServerLimits } from './protocol/types';
import type { ValidatedCommand } from './protocol/validate';
import type { RedisClients } from './redis/client';
import { createKeys } from './redis/keys';
import type { RedisStore } from './redis/store';
import type { RetentionSink } from './storage/sink';
import { hashIp } from './util/ids';
import { nowIso } from './util/time';
import { SocketConnection } from './ws/connection';
import { EventDispatcher } from './ws/dispatch';
import { SessionLifecycle, type SearchOutcome } from './ws/lifecycle';
import { MessagePipeline, type MessageOutcome } from './ws/messages';
import { ConnectionRegistry } from './ws/registry';
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
}

export interface ChatServer {
  readonly httpServer: Server;
  readonly registry: ConnectionRegistry;
  readonly lifecycle: SessionLifecycle;
  /** The port actually bound. Differs from the configured one when it was 0. */
  readonly port: number;
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
  const { config, logger, store, clients, retention } = deps;
  const keys = createKeys(config.redis.keyPrefix);
  const registry = new ConnectionRegistry(logger);
  const dispatcher = new EventDispatcher(registry, store, logger);
  const lifecycle = new SessionLifecycle(store, dispatcher, registry, config, logger, retention);
  const subscriber = new SessionSubscriber(clients.subscriber, keys, registry, logger);
  const pipeline = new MessagePipeline(store, dispatcher, config, logger, retention);

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
      refuse(socket, 404, 'not_found');
      return;
    }

    if (draining) {
      refuse(socket, 503, 'shutting_down');
      return;
    }

    if (!isOriginAllowed(req.headers.origin, config.http.allowedOrigins)) {
      // Refused without saying what would have been accepted: the allowlist is
      // not something a caller needs to enumerate.
      logger.warn('rejected a websocket upgrade from a disallowed origin');
      refuse(socket, 403, 'origin_not_allowed');
      return;
    }

    if (registry.size >= config.limits.maxConnections) {
      logger.warn('refusing a connection: instance at capacity', { connections: registry.size });
      refuse(socket, 503, 'at_capacity');
      return;
    }

    const address = clientAddress(req, config.http.trustProxyHops);
    const ipHash = hashIp(address, config.security.ipHashSalt);
    const { token, issued } = resolveClientToken(req);
    const clientHash = hashIp(token, config.security.ipHashSalt);

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
      logger.error('failed to open a session', {
        errName: err instanceof Error ? err.name : 'unknown',
      });
      refuse(socket, 503, 'unavailable');
      return;
    }

    if (outcome.kind !== 'opened') {
      await releaseSubscription();
      if (outcome.kind === 'rate_limited') {
        refuse(socket, 429, 'too_many_attempts', { 'retry-after': String(outcome.retryAfterSeconds) });
      } else {
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
      },
    });

    registry.add(connection);
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
        const outcome = await pipeline.send(
          connection.sessionId,
          command.clientId,
          command.contentType,
          command.text,
        );
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
        const outcome = await lifecycle.joinQueue(connection.sessionId);
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

      case 'skip': {
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

      logger.info('listening', { port: boundPort, wsPath: config.http.wsPath });
      return boundPort;
    },

    async stop(): Promise<void> {
      draining = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (presenceTimer) clearInterval(presenceTimer);

      // Tell every client before the socket goes, so a reconnect is a decision
      // rather than a surprise. Their sessions are closed through the ordinary
      // path, which ends matches and releases partners.
      for (const connection of registry.all()) {
        if (connection instanceof SocketConnection) {
          connection.sendEvent('server_shutdown', { reason: 'shutdown' });
          connection.close(CLOSE_CODES.GOING_AWAY, 'server shutting down');
        }
      }

      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Sockets already closed above; this bounds anything still lingering.
        setTimeout(resolve, config.timers.shutdownTimeoutMs).unref();
      });
      wss.close();
    },
  };
}
