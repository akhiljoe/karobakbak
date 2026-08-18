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
import { createChatServer } from './server';

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

  const server = createChatServer({ config, logger, store, clients });
  await server.listen();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    // A second signal during a slow drain must not start a second drain.
    if (stopping) return;
    stopping = true;
    logger.info('shutting down', { signal });
    await server.stop();
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
