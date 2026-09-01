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
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import type { Config, RateLimitedCommand } from './config';
import { moderate } from './moderation';
import { errorFields, type Logger } from './logger';
import {
  BASE_PROTOCOL,
  CLOSE_CODES,
  GENDERS,
  RESUME_PROTOCOL_PREFIX,
  type MatchedPayload,
  type ServerFeatures,
  type ServerLimits,
} from './protocol/types';
import type { ValidatedCommand } from './protocol/validate';

/**
 * Every label the queue-composition gauge may carry (§29.6).
 *
 * `none` is not a gender and is not padding: a session that declared nothing is
 * in the pool and can never satisfy a preference, so counting it is what makes
 * the preferred share honest. Closed, and low-cardinality, which is the reason
 * a declared gender is safe as a label where a conversation id never is.
 */
const COMPOSITION_LABELS: readonly string[] = [...GENDERS, 'none'];
import type { RedisClients } from './redis/client';
import { createKeys } from './redis/keys';
import type { BanCheck, RedisStore } from './redis/store';
import type { Metrics } from './metrics/registry';
import type { PaymentRoutes } from './payments/routes';
import type { AuthRoutes } from './accounts/routes';
import type { RetentionSink } from './storage/sink';
import type { ConnectionRepository } from './accounts/connections';
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
  clientCountry,
  clientTokenCookie,
  isOriginAllowed,
  resolveClientToken,
} from './ws/upgrade';

export interface ChatServerDeps {
  config: Config;
  logger: Logger;
  /**
   * Told when the backup job reports in.
   *
   * The application deliberately does not reach into the backup system — that
   * would hand the chat process credentials to the thing backups exist to
   * protect against. The report comes inward instead, and this is where it
   * lands.
   */
  onBackupReported?: (ok: boolean) => void;
  store: RedisStore;
  clients: RedisClients;
  /** Where retained records go. Never awaited on the chat path (D16). */
  retention: RetentionSink;
  /**
   * Saved connections, or absent when accounts are not wired up.
   *
   * Optional rather than a no-op, for the reason the payment routes are null:
   * an unconfigured deployment gets no surface rather than one that pretends.
   * The pipeline's default throws if it is ever reached, which it cannot be
   * while no session carries an account id.
   */
  connections?: ConnectionRepository;
  metrics: Metrics;
  /**
   * The payment routes, or null when payments are off.
   *
   * Null rather than a no-op implementation, so an unconfigured deployment has
   * no extra surface at all rather than a surface that refuses — the same shape
   * as the backup report route, which 404s when no token is configured.
   *
   * They live on this server rather than in a separate process, unlike the
   * moderation console (D32). The console is separated because it holds a
   * credential that can read every retained conversation; these two routes hold
   * no such authority and add one bounded, rate-limited POST each. The vendor
   * SDK is still kept out of the general address space — `gateway.ts` requires
   * it lazily, so a process with payments off never loads it.
   */
  payments?: PaymentRoutes | null;
  /**
   * The sign-in routes, or null when `AUTH_ENABLED` is false.
   *
   * Null rather than a no-op, the same shape as `payments`: an unconfigured
   * deployment gets no surface at all rather than one that refuses.
   */
  auth?: AuthRoutes | null;
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
  const payments = deps.payments ?? null;
  const auth = deps.auth ?? null;
  const keys = createKeys(config.redis.keyPrefix);
  const registry = new ConnectionRegistry(logger);
  /**
   * The wait ends when the session is told it matched.
   *
   * Both delivery paths land here — the dispatcher when the winning instance
   * also holds the socket, the subscriber when it does not — and both run on
   * the instance that started the clock, because that is the instance the
   * socket is attached to.
   *
   * A session with no entry is one that was never queued: the searcher whose
   * own join found somebody waited for nothing, and putting a zero in the
   * histogram for it would drag the distribution toward a wait nobody had.
   */
  function onEventDelivered(sessionId: string, event: string): void {
    if (event !== 'matched') return;
    const startedAt = searchStartedAt.get(sessionId);
    if (startedAt === undefined) return;
    searchStartedAt.delete(sessionId);
    metrics.matchmakingLatency.observe(secondsSince(startedAt));
  }

  const dispatcher = new EventDispatcher(registry, store, logger, onEventDelivered);
  const lifecycle = new SessionLifecycle(store, dispatcher, registry, config, logger, retention, {
    attempt: () => metrics.matchAttempts.inc(),
    profileDeclared: (gender) => metrics.profilesDeclared.labels(gender).inc(),
    aborted: (reason) => metrics.matchmakingFailures.labels(reason).inc(),
    conversationEnded: (reason, seconds) => {
      // Nothing is recorded when the duration is unknown. A zero here would be
      // indistinguishable from an instant skip, which is the exact signal this
      // histogram exists to measure.
      if (seconds === null) return;
      metrics.conversationDuration.labels(reason).observe(seconds);
    },
  });

  /**
   * When each locally-attached session started looking, for the wait histogram.
   *
   * `chat_matchmaking_latency_seconds` is the product's headline indicator —
   * "how long does it take to find somebody a stranger" — and it was declared,
   * documented, charted on three dashboard panels, and written by nothing. It
   * needs a start and an end, and the two do not happen in the same call: a
   * session usually joins the queue, finds nobody, and is matched later by
   * *another* session's attempt, learning about it through a Pub/Sub event
   * from whichever instance won.
   *
   * So the start is recorded here, on the instance holding the socket, and the
   * end is the `matched` frame reaching that socket — which is the moment the
   * user actually stops waiting, and is the same moment however the match was
   * made. The alternative, stamping the join time into the session hash, would
   * mean changing the `joinQueue` Lua script, and `tryMatch` and its
   * neighbours are the most race-tested code in this repository; a metric is
   * not worth re-verifying them for.
   *
   * Bounded by the sockets this instance holds: an entry appears when a search
   * starts and is removed when the match is announced or the socket closes.
   */
  const searchStartedAt = new Map<string, number>();
  const subscriber = new SessionSubscriber(
    clients.subscriber,
    keys,
    registry,
    logger,
    onEventDelivered,
  );
  const pipeline = new MessagePipeline(
    store,
    dispatcher,
    config,
    logger,
    retention,
    deps.connections,
  );
  const janitor = new Janitor(config, logger, store, dispatcher, (counts) => {
    // Cluster-wide gauges, refreshed by whichever instance holds the lock. They
    // are the same Redis cardinalities the presence frame reports, so the
    // dashboard and the UI cannot disagree.
    //
    // A follower publishes zero rather than leaving its series frozen at
    // whatever it last observed while it was the leader. Zero is the honest
    // answer to "what does this instance know about the cluster", and it makes
    // `max` and `sum` both correct: one live value beside any number of zeros.
    // `reset()` is deliberately not used — it clears a labelled gauge's series
    // and re-zeroes an unlabelled one, so the two here would behave
    // differently for no reason a reader could infer.
    const segment = config.matchmaking.defaultSegment;
    if (counts === null) {
      metrics.activeMatches.set(0);
      metrics.queueDepth.labels(segment).set(0);
      for (const gender of COMPOSITION_LABELS) {
        metrics.queueComposition.labels(segment, gender).set(0);
      }
      return;
    }
    metrics.activeMatches.set(counts.conversations);
    metrics.queueDepth.labels(segment).set(counts.queueDepth);

    // Deliberately not awaited: this callback belongs to the janitor's sweep
    // and a slow read here would delay reaping, which is a correctness job.
    // The gauge lands a moment after the depth beside it, which is a difference
    // no query can observe at a 15-second scrape.
    void store
      .queueComposition(segment)
      .then((composition) => {
        // Every known label is written every pass, including the zeros. A
        // gauge that only sets the genders it happened to see leaves the
        // others frozen at their last value, so a group that empties out
        // appears to still be waiting — the exact reading this metric exists
        // to get right.
        for (const gender of COMPOSITION_LABELS) {
          metrics.queueComposition.labels(segment, gender).set(composition[gender] ?? 0);
        }
      })
      .catch((err: unknown) => {
        logger.debug('could not sample the queue composition', errorFields(err));
      });
  }, retention);

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
    // Never echo the resume entry: a server must select a protocol the client
    // offered, and selecting that one would repeat the token in the response
    // headers. Clients offer `kbb.v1` beside it precisely so there is something
    // harmless to agree on, and offering nothing at all is still fine.
    handleProtocols: (protocols) => (protocols.has(BASE_PROTOCOL) ? BASE_PROTOCOL : false),
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

  /**
   * The one route on this process that changes anything.
   *
   * It exists because `BackupMonitor` can only ever report `unknown` unless
   * something tells it a backup happened, and the alternative — the chat
   * process reaching into the backup system to look — would give it
   * credentials to the thing backups protect against.
   *
   * Four things keep it small. It is off entirely when no token is configured,
   * so an unconfigured deployment has no extra surface rather than a surface
   * that refuses. The token is compared in constant time. It is never proxied:
   * the edge forwards `/ws`, `/health` and `/ready` and nothing else, and the
   * backend publishes no host port in production, so this is reachable only
   * from the compose network. And it carries no user data in either direction.
   */
  function handleBackupReport(req: IncomingMessage, res: ServerResponse): void {
    const expected = config.backup.reportToken;
    if (expected === '') {
      json(res, 404, { error: 'not_found' });
      return;
    }

    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!constantTimeEquals(presented, expected)) {
      // No detail, and the same shape whatever was wrong with it.
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    // A tiny bounded body, or none at all. `{"ok": false}` is how a job that
    // ran and failed says so, which is a different signal from silence: one
    // means backups are broken, the other means they stopped happening.
    let raw = '';
    let oversized = false;
    req.on('data', (chunk: Buffer) => {
      if (oversized) return;
      if (raw.length + chunk.length > 512) {
        oversized = true;
        raw = '';
        return;
      }
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      if (oversized) {
        json(res, 413, { error: 'payload_too_large' });
        return;
      }
      let ok = true;
      if (raw.trim() !== '') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
            ok = (parsed as { ok: unknown }).ok !== false;
          }
        } catch {
          json(res, 400, { error: 'bad_json' });
          return;
        }
      }
      deps.onBackupReported?.(ok);
      logger.info('backup reported', { backupOk: ok });
      json(res, 204, {});
    });
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'POST' && path === '/internal/backup-observed') {
      handleBackupReport(req, res);
      return;
    }

    // Registered only when payments are configured, so the routes do not exist
    // at all in the default build.
    //
    // The path is still taken from `(req.url ?? '/').split('?')[0]`, deliberately.
    // The obvious upgrade is `new URL(req.url, \`http://${req.headers.host}\`)`,
    // which reads better and introduces a crash: `handleHttp` has no try/catch,
    // the URL constructor throws on a malformed `Host`, and a throw inside a
    // request handler takes the process — and every WebSocket on it — down. A
    // header anybody can set must not be able to do that.
    // Registered only when sign-in is configured, so an unconfigured build has
    // no auth surface to probe rather than four routes that refuse.
    if (auth !== null) {
      const authRoute =
        req.method === 'GET' && path === '/auth/start'
          ? auth.start
          : req.method === 'GET' && path === '/auth/callback'
            ? auth.callback
            : req.method === 'GET' && path === '/auth/session'
              ? auth.session
              : req.method === 'GET' && path === '/auth/avatar'
                ? auth.avatar
                : req.method === 'GET' && path === '/auth/connections'
                  ? auth.connections
                  : req.method === 'POST' && path === '/auth/connections/remove'
                    ? auth.removeConnection
              : req.method === 'POST' && path === '/auth/signout'
                ? auth.signout
                : null;
      if (authRoute !== null) {
        // Same shape as the payment routes: answer on failure rather than
        // leaving the socket open until it times out, which hides the only
        // signal that the route is broken.
        void authRoute(req, res).catch((err: unknown) => {
          logger.error('auth route failed', errorFields(err));
          if (!res.headersSent) json(res, 500, { error: 'internal_error' });
          else res.end();
        });
        return;
      }
    }

    if (req.method === 'POST' && payments !== null) {
      if (path === '/api/payments/create-order') {
        // `void` with a catch that answers, rather than `.catch(() => {})`.
        // Swallowing silently leaves the socket open with no response until it
        // times out, and hides the only signal that the route is broken.
        void payments.createOrder(req, res).catch((err: unknown) => {
          logger.error('payment order route failed', errorFields(err));
          if (!res.headersSent) json(res, 500, { error: 'internal_error' });
          else res.end();
        });
        return;
      }
      if (path === '/api/webhooks/razorpay') {
        void payments.webhook(req, res).catch((err: unknown) => {
          logger.error('payment webhook route failed', errorFields(err));
          // 500 rather than 204: a webhook that was not recorded must be
          // retried by the provider, and only a non-2xx asks for that.
          if (!res.headersSent) json(res, 500, { error: 'internal_error' });
          else res.end();
        });
        return;
      }
    }

    if (req.method !== 'GET') {
      json(res, 405, { error: 'method_not_allowed' });
      return;
    }

    if (path === '/health') {
      // Liveness: is this process running. Deliberately independent of every
      // dependency, so a Redis outage does not make an orchestrator restart
      // processes that are working fine.
      // No instance id. This endpoint is proxied to the public edge, and the
      // id is of no use to anyone who cannot already reach the private
      // network — while polling it across a deployment enumerates replicas and
      // shows when one is draining, which is when a system is least robust.
      // The same value is on every metric series, where it belongs.
      json(res, 200, { status: draining ? 'draining' : 'ok' });
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

  /**
   * Compare a presented secret without leaking its length or contents through
   * timing. Hashing both sides first is what makes it safe for values of
   * different lengths — `timingSafeEqual` throws on a length mismatch, and
   * returning early on one would leak the length of the real token.
   */
  function constantTimeEquals(presented: string, expected: string): boolean {
    const a = createHash('sha256').update(presented).digest();
    const b = createHash('sha256').update(expected).digest();
    return timingSafeEqual(a, b);
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

    // Resolved once, here, because the upgrade is the only moment the request
    // headers exist — the same reason `country` is resolved here. A failure to
    // resolve is not a failure to connect: chatting never requires an account,
    // and the anonymous path has to keep working while sign-in is down, which
    // is the line `010_accounts.sql` draws from the other direction.
    let accountId: string | null = null;
    if (auth !== null) {
      accountId = await auth.accountForRequest(req);
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
    // Resolved here because this is the only point the request headers exist.
    // Null on a laptop, where there is no CDN to have set it.
    const country = clientCountry(req, config.http.trustProxyHops);
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

    // A returning browser presents its resume token as a WebSocket subprotocol
    // (§28). The subprotocol is chosen because it is the only channel a browser
    // can put a value on during a handshake — `WebSocket` takes no custom
    // headers — and unlike a query string it does not land in an access log.
    //
    // Anything that fails here falls through to a fresh session rather than
    // refusing the connection. A stale token after a long tab suspension is the
    // common case, and it means "a new conversation", never an error page.
    const presented = resumeTokenFrom(req);
    if (presented !== null) {
      let resumed;
      try {
        resumed = await lifecycle.resume(presented, async (sessionId) => {
          await subscriber.subscribe(sessionId);
          subscribedTo.push(sessionId);
        });
      } catch (err) {
        resumed = { kind: 'no_session' as const };
        logger.warn('resume attempt failed', {
          errName: err instanceof Error ? err.name : 'unknown',
        });
      }

      if (resumed.kind === 'too_many_connections') {
        await releaseSubscription();
        metrics.connectionsRejected.labels('too_many_connections').inc();
        refuse(socket, 429, 'too_many_connections');
        return;
      }

      if (resumed.kind === 'resumed') {
        metrics.resumes.labels('ok').inc();
        const restored = resumed;
        wss.handleUpgrade(req, socket, head, (ws) => {
          attach(
            ws,
            restored.sessionId,
            restored.ipHash,
            restored.clientHash,
            country,
            { resumeToken: restored.resumeToken, matchId: restored.matchId },
            accountId,
          );
        });
        return;
      }

      // Nothing to resume. Release the subscription taken on the way in, or a
      // fresh session would inherit a listener for a session id it is not.
      await releaseSubscription();
      subscribedTo.length = 0;
      metrics.resumes.labels('expired').inc();
    }

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
      attach(
        ws,
        sessionId,
        ipHash,
        clientHash,
        country,
        { resumeToken: outcome.resumeToken },
        accountId,
      );
    });
  }

  /**
   * The resume token a browser offered, or null.
   *
   * Namespaced (`kbb.resume.<token>`) so an unrelated subprotocol cannot be
   * mistaken for one, and length-bounded before anything hashes it.
   */
  function resumeTokenFrom(req: IncomingMessage): string | null {
    const header = req.headers['sec-websocket-protocol'];
    const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
    for (const entry of raw.split(',')) {
      const value = entry.trim();
      if (!value.startsWith(RESUME_PROTOCOL_PREFIX)) continue;
      const token = value.slice(RESUME_PROTOCOL_PREFIX.length);
      if (token.length === 0 || token.length > 128) return null;
      return token;
    }
    return null;
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

  function attach(
    ws: WebSocket,
    sessionId: string,
    ipHash: string,
    clientHash: string,
    /** Resolved at the upgrade; null with no CDN in front. */
    country: string | null,
    session: { resumeToken: string; matchId?: string | null } = { resumeToken: '' },
    /**
     * Resolved from the session cookie at the upgrade, never from a frame.
     *
     * Held on the connection rather than the session hash because it is a
     * property of *this socket's* credential. A resumed session re-presents its
     * cookie and is resolved again, so signing out in one tab cannot leave a
     * live socket holding an authority the credential no longer grants.
     */
    accountId: string | null = null,
  ): void {
    const connection = new SocketConnection({
      socket: ws,
      sessionId,
      ipHash,
      clientHash,
      country,
      accountId,
      config,
      logger,
      onCommand: (command, conn) => handleCommand(command, conn),
      observe: {
        frameRejected: (reason) => {
          if (reason === 'oversized') metrics.oversizedFrames.inc();
          metrics.invalidFrames.labels(reason).inc();
        },
        socketError: () => metrics.socketErrors.inc(),
      },
      onClose: async (conn) => {
        // Whatever this socket was waiting for, it is not waiting any more.
        searchStartedAt.delete(conn.sessionId);
        // A socket closing while Redis is unavailable — a restart, a failover,
        // a test tearing its server down — must not produce an unhandled
        // rejection. The TTLs and the janitor are the recovery net for whatever
        // this could not clean up (§13).
        try {
          await lifecycle.close(conn.sessionId, conn.ipHash, conn, { holdSeat: !draining });
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
    // Built before the frame is sent so a resumed conversation arrives *with*
    // the connection rather than a moment later — a client that saw `connected`
    // first would paint a landing screen and then replace it.
    void (async () => {
      let resumed: MatchedPayload | undefined;
      if (session.matchId != null && session.matchId !== '') {
        // Both calls read Redis and neither catches. This task is detached, so
        // an unhandled rejection here is an uncaught exception — Node's default
        // for one is to terminate the process, which would turn a Redis blip
        // during a single reconnection into the loss of every socket on this
        // instance. Degrade the reconnection instead: the frame goes out
        // without `resumed`, which the client already handles as "the resume
        // did not take", and lands it on the landing screen rather than on a
        // conversation this process could not confirm.
        try {
          resumed = (await lifecycle.restoreMatch(sessionId, session.matchId)) ?? undefined;
          if (resumed) await lifecycle.announceReturn(sessionId, session.matchId);
        } catch (err) {
          resumed = undefined;
          logger.warn('could not restore a resumed conversation', {
            sessionId,
            errName: err instanceof Error ? err.name : 'unknown',
          });
        }
      }
      connection.sendEvent('connected', {
        sessionId,
        protocolVersion: 1,
        serverTime: nowIso(),
        limits,
        features: FEATURES,
        resumeToken: session.resumeToken,
        resumeGraceSeconds: config.resume.graceSeconds,
        ...(resumed ? { resumed } : {}),
      });
      void sendPresence(connection);
    })().catch((err: unknown) => {
      // The backstop. The inner catch handles the one failure worth degrading
      // gracefully; this one exists so that *no* future addition to this task
      // can reach Node's unhandled-rejection handler and take the process with
      // it. One socket failing to receive its opening frame is a lost
      // connection, which the client retries; the alternative is an outage.
      logger.warn('could not complete a connection handshake', {
        sessionId,
        errName: err instanceof Error ? err.name : 'unknown',
      });
    });
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
      // A refused join is the one refusal that leaves the client believing
      // something happened. It moves to "searching" as soon as the frame goes
      // out, and every other path into that screen ends in a `queue_status`
      // this one never sends — so without a word here the client waits for a
      // match that was never being looked for. The client also rolls its own
      // optimistic transition back, but it should not have to infer this from
      // an error code: the session state is the server's to report.
      //
      // IDLE is accurate on this path because the bucket is checked before
      // `joinQueue` runs, so nothing was queued by the frame being refused.
      if (command.type === 'join_queue') {
        connection.sendEvent('queue_status', { state: 'IDLE', waiting: 0 });
      }
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
          // The route it actually took, which is what `dropped` means here:
          // routed at a session whose socket was gone. Previously this read the
          // moderation verdict, so a message that reached nobody was counted as
          // delivered on its nominal route.
          metrics.messagesDelivered
            .labels(outcome.status === 'routed' ? outcome.route : 'dropped')
            .inc();
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

      case 'react': {
        const outcome = await pipeline.react(
          connection.sessionId,
          command.messageId,
          command.reaction,
          command.active,
        );
        // Silent on success, for the same reason typing is: acknowledging an
        // advisory frame doubles its traffic to confirm something nobody waits
        // on.
        if (outcome.kind === 'sent') metrics.reactions.inc();
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
            connection.sendError('NAME_REFUSED', 'that name cannot be used');
            // Same reason as the rate-limited path above: the join did not
            // happen and nothing else will say so.
            connection.sendEvent('queue_status', { state: 'IDLE', waiting: 0 });
            return;
          }
        }

        // The country is the server's, not the client's.
        //
        // It used to be a dropdown, which made it a claim like the name and the
        // age — typed by a stranger and checked by nothing. It is now resolved
        // from the connection at the upgrade, so whatever arrives in the frame
        // is discarded rather than trusted. That is protocol rule 3: the only
        // client-supplied field that survives is the message correlation id.
        //
        // Null when there is no CDN in front, which is every laptop. The field
        // is simply absent then, exactly as it was when somebody declined to
        // pick one.
        const outcome = await lifecycle.joinQueue(
          connection.sessionId,
          { ...command.profile, country: connection.country },
          // Validated against the same closed lists the profile fields use, and
          // refused rather than trimmed when it names something unknown.
          command.preferences,
          // Not folded into the profile above, and that is the feature (D45,
          // §30.1): `Profile` is what reaches the other side, so intent travels
          // beside it and is never a member of it.
          command.intent,
        );
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

      case 'save_connection': {
        // Refused, not queued. A saved state that can never become a connection
        // is worse than a refusal: the user believes it worked, and the absence
        // of a connection afterwards reads as the other person declining.
        if (connection.accountId === null) {
          connection.sendError('ACCOUNT_REQUIRED', 'sign in to save a connection');
          return;
        }
        const outcome = await pipeline.saveConnection(
          connection.sessionId,
          connection.accountId,
          command.active,
        );
        switch (outcome.kind) {
          case 'state':
            // Only to the caller. The partner is told nothing — a save is
            // disclosed on condition of reciprocity, and this is not it.
            connection.sendEvent('connection_state', {
              matchId: outcome.matchId,
              saved: outcome.saved,
            });
            return;
          case 'made': {
            // Both, and simultaneously. This is the only frame that reveals
            // anything about the partner's decision, and it is reachable only
            // when that decision was to agree.
            connection.sendEvent('connection_made', { matchId: outcome.matchId });
            const route = await store.resolveRoute(connection.sessionId);
            if (route.status === 'ok') {
              await dispatcher.toSession(
                route.partnerSessionId,
                { event: 'connection_made', matchId: outcome.matchId },
                new Date().toISOString(),
              );
            }
            if (outcome.created) metrics.connectionsMade.inc();
            return;
          }
          case 'rate_limited':
            connection.sendError('RATE_LIMITED', 'slow down');
            return;
          case 'not_matched':
            connection.sendError('NOT_MATCHED', 'you are not in a conversation');
            return;
          default: {
            const done: never = outcome;
            void done;
            return;
          }
        }
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
          status: outcome.status,
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
    // `searching` means the server put this session in the queue and it is now
    // waiting. That is the clock starting, and it is the only outcome that
    // starts it: `matched` was instantaneous, and the rest are not searches.
    if (outcome.kind === 'searching') {
      searchStartedAt.set(connection.sessionId, monotonicMs());
    }
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
