/**
 * Process entry point.
 *
 * Everything here is startup order and signal handling; the interesting code is
 * behind `createChatServer`. Configuration is loaded exactly once, here, and
 * passed down — there is no module-level singleton to import, so a test can
 * build its own without touching `process.env`.
 */
import { configWarnings, loadConfig } from './config';
import { createLoggerFromConfig } from './logger';
import { createRedisClients } from './redis/client';
import { createKeys } from './redis/keys';
import { ScriptRunner } from './redis/scripts';
import { RedisStore } from './redis/store';
import { createMetrics } from './metrics/registry';
import { publishLimits } from './metrics/limits';
import { RetentionMetricsPublisher } from './metrics/retention';
import { BackupMonitor } from './storage/backup';
import { ReportQueueMonitor } from './storage/reportqueue';
import { createChatServer } from './server';
import { RazorpayGateway } from './payments/gateway';
import { PaymentRepository } from './payments/repository';
import { createPaymentRoutes, type PaymentRoutes } from './payments/routes';
import { createAuthRoutes, type AuthRoutes } from './accounts/routes';
import { createOidcClient } from './accounts/oidc';
import { createConnectionRepository, type ConnectionRepository } from './accounts/connections';
import { createBlockRepository, type BlockRepository } from './accounts/blocks';
import { createEntitlementService, type EntitlementService } from './accounts/entitlement';
import { createPresenceService, type PresenceService } from './accounts/presence';
import { randomBytes } from 'node:crypto';

import { newMessageId } from './util/ids';

import { encodeSessionEvent } from './ws/events';
import { DeletionWorker } from './storage/deletion';
import { createDatabase, assertTlsWhereRequired } from './storage/pool';
import { RetentionWriter } from './storage/retention';
import { EnforcementService } from './admin/enforce';
import { NullRetentionSink, type RetentionSink } from './storage/sink';
import { DisabledSpool, FileSpool, type Spool } from './storage/spool';

async function main(): Promise<void> {
  // A misconfigured process fails here, before it can accept a connection and
  // fail unpredictably under load.
  const config = loadConfig(process.env);
  const logger = createLoggerFromConfig(config);

  for (const warning of configWarnings(config)) {
    logger.warn(warning);
  }

  const clients = await createRedisClients(config, logger);
  await clients.waitUntilReady();

  const runner = new ScriptRunner(clients.command);
  await runner.loadAll();

  const store = new RedisStore(clients.command, runner, createKeys(config.redis.keyPrefix), config);
  await store.refreshInstanceBeacon(config.instanceId);

  // Retention is optional at runtime: a deployment that has not provisioned a
  // database still serves chat, which is the whole point of the write-behind
  // path (D16). Migrations are a deploy-time step run as a different role, so
  // nothing here creates schema.
  let retention: RetentionSink = new NullRetentionSink();
  let writer: RetentionWriter | null = null;
  let deletion: DeletionWorker | null = null;
  let database: ReturnType<typeof createDatabase> | null = null;
  let banReloadTimer: NodeJS.Timeout | null = null;

  if (config.retention.enabled) {
    assertTlsWhereRequired(config);
    database = createDatabase(config, logger);
    const spool: Spool = config.spool.enabled
      ? new FileSpool(config, logger)
      : new DisabledSpool();
    writer = new RetentionWriter(config, logger, database, spool);
    writer.start();
    retention = writer;

    // Leader-locked through Redis, so one instance does the deleting. A
    // retention policy that only exists in configuration is a promise nobody
    // keeps (I10).
    deletion = new DeletionWorker(config, logger, database, store);
    deletion.start();

    // Sanctions live in PostgreSQL and are *cached* in Redis, which holds no
    // persistence by design (D12) — so a Redis restart empties every ban key.
    // Replaying them is what stops every ban being quietly temporary, lasting
    // only until the next restart with nothing reporting that it had gone.
    //
    // Not leader-locked, unlike the deletion worker: the write is an
    // idempotent SET with a recomputed TTL, so instances converge instead of
    // contending, and a pass only the leader ran would leave every other
    // instance enforcing nothing.
    if (config.enforcement.enabled) {
      const sanctions = new EnforcementService(database, store, config, logger);
      // Awaited once at startup so an instance does not begin accepting
      // connections with an empty ban list. It never throws — a database
      // outage must not stop the chat from serving (D16) — so a failure here
      // costs one interval, not the boot.
      await sanctions.reapplyActiveBans();
      banReloadTimer = setInterval(() => {
        void sanctions.reapplyActiveBans();
      }, config.enforcement.reloadIntervalMs);
      banReloadTimer.unref();
    }
  }

  const metrics = createMetrics(config);
  publishLimits(metrics, config);

  /*
    Tracing is started by `dist/tracing/preload.js`, not here (phase 29).

    It has to be: `registerInstrumentations` patches a module by replacing its
    exports, and by the time this function runs `pg` and `ioredis` have already
    been imported at the top of this file. The first version started it here and
    produced **no spans at all** while reporting no error — a tracing pipeline
    that exports nothing is indistinguishable from a quiet system.

    The preload reads `TRACING_ENABLED` from the raw environment before
    requiring anything OpenTelemetry, so a process with tracing off still never
    loads the SDK. This line records that it is running so an operator reading
    the startup log knows which of the two states they are in.
  */
  if (config.tracing.enabled) {
    logger.info('tracing is enabled', {
      endpoint: config.tracing.endpoint,
      serviceName: config.tracing.serviceName,
    });
  }

  // Sampled rather than pushed, so nothing in the write path carries a metrics
  // dependency. The interval is the scrape cache window: sampling faster would
  // publish numbers nobody reads.
  const backup = new BackupMonitor(config);

  // How long the oldest untriaged report has waited. With one moderator there
  // is no rota to notice a queue growing overnight, so it is a number and an
  // alert rather than a screen somebody has to remember to open.
  const reportQueue = database
    ? new ReportQueueMonitor(database, logger, config.moderation_response.sampleIntervalMs)
    : null;
  reportQueue?.start();

  const publisher = new RetentionMetricsPublisher(
    metrics,
    writer,
    deletion,
    backup,
    reportQueue,
    config.moderation_response.targetSeconds,
  );
  const metricsTimer = setInterval(() => publisher.publish(), Math.max(1000, config.metrics.cacheMs));
  metricsTimer.unref();

  // Payments. Both halves must agree before a single route exists: the server
  // flag here, and the frontend's compiled-in `PAYMENTS_ENABLED`. `assertCoherent`
  // has already refused to start if the flag is on without credentials or
  // without a database, so reaching this point with `database` null is not
  // possible — the check is here because a reader should not have to know that.
  let payments: PaymentRoutes | null = null;
  if (config.payments.enabled && database !== null) {
    payments = createPaymentRoutes({
      config,
      logger,
      db: database,
      store,
      gateway: new RazorpayGateway(
        { keyId: config.payments.keyId, keySecret: config.payments.keySecret },
        logger,
      ),
      repository: new PaymentRepository(database, logger),
    });
    logger.info('payment routes enabled');
  }

  // Sign-in, and the connections it unlocks. Both need a database: an account
  // is a row, and a connection is a row. A database that is unreachable
  // therefore turns sign-in off and leaves chat entirely unaffected, which is
  // the line `010_accounts.sql` draws and the reason `/ready` reflects Redis
  // rather than PostgreSQL.
  let auth: AuthRoutes | null = null;
  let connections: ConnectionRepository | undefined;
  let accountBlocks: BlockRepository | undefined;
  let presence: PresenceService | undefined;
  let entitlement: EntitlementService | undefined;
  if (config.auth.enabled && database !== null) {
    connections = createConnectionRepository(database, logger);
    accountBlocks = createBlockRepository(
      database,
      clients.command,
      logger,
      config.redis.keyPrefix,
      config.blocks.ttlSeconds,
    );
    presence = createPresenceService(database, clients.command, logger, config.redis.keyPrefix);
    entitlement = createEntitlementService(
      database,
      clients.command,
      logger,
      config.redis.keyPrefix,
    );
    auth = createAuthRoutes({
      config,
      logger,
      db: database,
      oidc: createOidcClient(config, logger),
      // Only for the avatar URL cache. Sign-in itself is a PostgreSQL flow and
      // works without Redis; an unavailable Redis costs a picture, never a
      // session.
      redis: clients.command,
      connections,
      blocks: accountBlocks,
      presence,
      /*
        Sign-in, the avatar relay and reconnect wrote no metrics at all until
        now — nor did anything else in `accounts/`, so phases 20 to 24 shipped
        entirely unlit and "is anybody signing in" was not a question the
        running system could answer.

        Callbacks rather than the registry, so these routes can reach exactly
        the counters they were handed. Nothing here counts a refusal: an ignored
        reconnect and a connection that was not saved back are private
        decisions, and `RECONNECT_FAILURES` records why an aggregate of them is
        still the wrong thing to publish.
      */
      observer: {
        authStarted: () => metrics.authStarts.inc(),
        authCallback: (outcome) => metrics.authCallbacks.labels(outcome).inc(),
        accountCreated: () => metrics.accountsCreated.inc(),
        reconnectPaired: () => metrics.reconnectPaired.inc(),
        reconnectFailed: (reason) => metrics.reconnectFailures.labels(reason).inc(),
        connectionRemoved: () => metrics.connectionsRemoved.inc(),
        avatarRelayed: (outcome) => metrics.avatarRelay.labels(outcome).inc(),
      },
      /*
        The whole of what an HTTP handler may do to matchmaking: deliver one
        event to one session, and put two sessions in a lane. Deliberately not
        the lifecycle itself — a route that could reach the rest of it is a
        route somebody will eventually use to reach the rest of it.

        `pair` writes a segment nobody else is in, so the pairing is done by
        ordinary `tryMatch` with every guard it already applies. There is no
        reconnect-specific matching code, and therefore no reconnect-specific
        way to get the block check wrong.
      */
      reconnect: {
        async notify(sessionId, event) {
          const frame =
            'offer' in event
              ? ({ event: 'reconnect_request', matchId: '', offer: event.offer } as const)
              : ({ event: 'reconnect_ready', matchId: '', startedAt: event.startedAt } as const);
          /*
            Published on the session's own channel rather than handed to the
            dispatcher, which lives inside the chat server and is not reachable
            from here. The channel name *is* the routing key (D8), so this
            reaches whichever instance holds that socket without a routing table
            — and a publish with no subscriber returns zero, which is exactly
            the "they are not here after all" answer the caller needs.
          */
          const receivers = await store.publishToSession(
            sessionId,
            encodeSessionEvent(frame, new Date().toISOString()),
          );
          return receivers > 0;
        },
        /**
         * Write the block, and record it the way every other block is recorded.
         *
         * The durable row goes through the same retention queue the in-chat
         * block uses, so this appears in the same place, expires on the same
         * schedule, and shows up in a signed-in person's block list without a
         * second code path deciding what a block is.
         */
        async block(asker, target) {
          const keysFor = await store.readBlockKeys(target, asker);
          if (keysFor.a === null || keysFor.b === null) return false;

          const written = await store.blockPair(keysFor.a, keysFor.b, config.blocks.ttlSeconds);
          if (written.length === 0) return false;

          const expiresAt = new Date(
            Date.now() + config.blocks.ttlSeconds * 1000,
          ).toISOString();
          const accounts = await store.readAccounts(target, asker);
          for (const entry of written) {
            retention.enqueue({
              kind: 'block',
              blockId: newMessageId(),
              blockerKey: entry.blockerKey,
              blockedKey: entry.blockedKey,
              dimension: entry.dimension,
              blockerAccountId: accounts.a,
              // There is no conversation: this refuses one rather than ending
              // one, and a null says so honestly.
              conversationId: null,
              createdAt: new Date().toISOString(),
              expiresAt,
            });
          }
          return true;
        },

        async pair(sessionA, sessionB) {
          // Random rather than derived from the two session ids: a derived
          // lane would be identical every time the same two people reconnect,
          // which is a stable identifier for a pair sitting in a key name.
          const lane = `pair-${randomBytes(8).toString('hex')}`;
          await Promise.all([store.setSegment(sessionA, lane), store.setSegment(sessionB, lane)]);
        },
      },
    });
    logger.info('sign-in enabled');
  }

  const server = createChatServer({
    config,
    logger,
    store,
    clients,
    retention,
    metrics,
    payments,
    accountPresence: presence ?? null,
    entitlement: entitlement ?? null,
    auth,
    connections,
    // The backup job reports inward; nothing here reaches out to look.
    onBackupReported: (ok) => {
      if (ok) backup.recordSuccess();
      else backup.recordFailure();
    },
  });
  await server.listen();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second signal during a slow drain must not start a second drain.
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    await server.stop();
    // The writer is stopped after the sockets, so records produced by the last
    // conversations to close are still placed - written if the database is up,
    // spooled if it is not.
    clearInterval(metricsTimer);
    if (banReloadTimer) clearInterval(banReloadTimer);
    deletion?.stop();
    reportQueue?.stop();
    if (writer) await writer.stop();
    if (database) await database.close();
    await clients.close();
    process.exit(0);
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }
}

main().catch((err: unknown) => {
  // Startup failed, so there may be no logger yet. One line on stderr, and a
  // non-zero exit so an orchestrator does not treat this as a healthy start.
  const message = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown startup failure';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
