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

  const server = createChatServer({
    config,
    logger,
    store,
    clients,
    retention,
    metrics,
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
