/**
 * The moderation console, as its own process.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT A THREAD OF THE CHAT SERVER
 * ---------------------------------------------------------------------------
 * The chat backend and the console are different trust levels wearing the same
 * image. The console holds credentials that read every retained conversation;
 * the chat backend holds none and has no need of any. Running them as one
 * process would put both sets of credentials in one address space, and a
 * compromise of the socket-facing half — the half exposed to the internet —
 * would hand over the other.
 *
 * Separate processes make the separation real rather than notional: the chat
 * containers connect as `karobakbak_app`, which is denied `admin_accounts`
 * outright, and this one connects as `karobakbak_console`, which cannot delete
 * a conversation. Neither can do the other's job even by mistake.
 *
 * It also means the console can be absent. A deployment that has not started
 * this process has no console, no open port and no operator credentials in
 * memory anywhere — which is the correct posture for a service nobody is
 * moderating yet.
 */
import { configWarnings, loadConfig } from '../config';
import { createLoggerFromConfig } from '../logger';
import { createKeys } from '../redis/keys';
import { createRedisClients } from '../redis/client';
import { ScriptRunner } from '../redis/scripts';
import { RedisStore } from '../redis/store';
import { assertTlsWhereRequired, createDatabase } from '../storage/pool';
import { PersonaControl } from '../personas/control';
import { AdminAuth } from './auth';
import { EnforcementService } from './enforce';
import { PersonaConsoleService } from './personas';
import { ReviewService } from './review';
import { createConsoleRoutes } from './routes';
import { createAdminServer } from './server';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLoggerFromConfig(config).child({ component: 'console' });

  for (const warning of configWarnings(config)) logger.warn(warning);

  if (!config.admin.enabled) {
    // Refusing rather than idling. A process that starts, opens nothing and
    // logs nothing looks healthy to an orchestrator, and the operator finds
    // out the console is missing when they try to use it.
    process.stderr.write('ADMIN_CONSOLE_ENABLED is false; refusing to start the console\n');
    process.exit(1);
  }

  // The console is useless without its database, unlike the chat server, which
  // must keep serving through an outage (D16). Failing here is correct: there
  // is nothing to moderate from without the retained record.
  assertTlsWhereRequired(config);
  const database = createDatabase(config, logger);

  // Redis is needed only to make a sanction take effect. A console that could
  // read cases but not act on them is still worth having, so this is opened
  // eagerly and its failure is fatal only because acting is the point.
  const clients = await createRedisClients(config, logger);
  await clients.waitUntilReady();
  const runner = new ScriptRunner(clients.command);
  const store = new RedisStore(
    clients.command,
    runner,
    createKeys(config.redis.keyPrefix),
    config,
  );

  const auth = new AdminAuth(database, config, logger);
  const review = new ReviewService(database, config, logger);
  const enforcement = new EnforcementService(database, store, config, logger);

  /**
   * The persona view is always mounted, even where personas are not deployed.
   *
   * The tables exist from the migration regardless, so the list is simply empty
   * — and an empty view is a better answer than a missing route, which looks
   * like a broken console rather than a feature nobody turned on. The switch it
   * writes is the same durable one the persona service reads, so an operator
   * can disable personas from here even while that service is down, which is
   * exactly when they would want to.
   */
  const personas = new PersonaConsoleService(database, config);
  const personaControl = new PersonaControl({
    db: database,
    redis: clients.command,
    logger,
    cacheKey: `${config.redis.keyPrefix}:persona:control`,
    cacheTtlSeconds: config.personas.controlCacheTtlSeconds,
    hours: {
      startHour: config.personas.activeStartHour,
      endHour: config.personas.activeEndHour,
      utcOffsetMinutes: config.personas.utcOffsetMinutes,
    },
  });

  const routes = createConsoleRoutes({
    config,
    logger,
    review,
    enforcement,
    personas,
    personaControl,
  });

  const server = createAdminServer({ config, logger, auth, routes });
  await server.listen();

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('console shutting down', { signal });
    await server.close();
    await database.close();
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
  const message = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown startup failure';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
