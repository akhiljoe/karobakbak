/**
 * The persona service, as its own process.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE PROCESS
 * ---------------------------------------------------------------------------
 * The same reason the console is one. A persona holds a model provider's API
 * key and talks to the internet; the chat backend holds neither and needs
 * neither. Running them together would put that credential in the address space
 * of the process facing every user's socket.
 *
 * It also makes the feature genuinely optional. A deployment that has not
 * started this process has no personas, no key in memory, and no possibility of
 * spending money — which is the right posture for something off by default.
 *
 * And it means the persona service can crash without touching chat. That is
 * D16's principle applied to a second dependency: the product must survive its
 * dependencies failing, and this is now one of them.
 *
 * ---------------------------------------------------------------------------
 * TWO SWITCHES, BOTH OF WHICH MUST SAY YES
 * ---------------------------------------------------------------------------
 * `PERSONAS_ENABLED` starts the process. `persona_control` decides, at every
 * tick, whether anything may join — and it ships disabled. Enabling personas
 * therefore takes a deployment change *and* a deliberate, audited act.
 *
 * That is not belt and braces for its own sake. The deployment setting is the
 * operator's; the durable switch is the one somebody reaches for at 2am when
 * the bill or the behaviour is wrong, and it must not be undone by a redeploy.
 */

import { createServer } from 'node:http';
import { configWarnings, loadConfig } from '../config';
import { createLoggerFromConfig } from '../logger';
import type { Logger } from '../logger';
import { createMetrics } from '../metrics/registry';
import { createKeys } from '../redis/keys';
import { createRedisClients } from '../redis/client';
import { assertTlsWhereRequired, createDatabase } from '../storage/pool';
import { PersonaBudget } from './budget';
import { loadCharacters } from './index';
import { personaMetrics } from './metrics';
import { AnthropicProvider } from './provider-anthropic';
import { OpenAIProvider } from './provider-openai';
import type { ModelProvider } from './provider';
import { redisQueueView } from './queue-view';
import { PersonaControl } from './control';
import { startPersona } from './runner';
import { PersonaSupervisor } from './supervisor';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const logger = createLoggerFromConfig(config).child({ component: 'personas' });

  for (const warning of configWarnings(config)) logger.warn(warning);

  if (!config.personas.enabled) {
    // Refusing rather than idling, for the reason the console gives: a process
    // that starts, does nothing and logs nothing looks healthy to an
    // orchestrator, and the operator discovers the truth much later.
    process.stderr.write('PERSONAS_ENABLED is false; refusing to start the persona service\n');
    process.exit(1);
  }

  // Validated at load, with the interchangeability check on. A character that
  // is a near-copy of another fails the build in CI; this catches the case
  // where the population was edited without running it.
  const characters = loadCharacters(undefined, { checkDifferentiation: true });
  logger.info('persona population loaded', { count: characters.length });

  assertTlsWhereRequired(config);
  const database = createDatabase(config, logger);

  const clients = await createRedisClients(config, logger);
  await clients.waitUntilReady();
  const keys = createKeys(config.redis.keyPrefix);

  const registry = createMetrics(config);
  const metrics = personaMetrics(registry);

  const control = new PersonaControl({
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

  // Replay PostgreSQL into Redis before the first tick, so a restart cannot
  // begin by reading an empty cache and treating "no rows" as "nothing is
  // disabled". The ban reconciler exists for the same reason (D31).
  await control.reconcile();

  const budget = new PersonaBudget({
    db: database,
    logger,
    monthlyLimitMicroCents: config.personas.monthlyLimitMicroCents,
  });

  /**
   * No key, no model, and that is a supported mode rather than a broken one.
   *
   * Personas run on the scripted voice: they hold real conversations, exercise
   * every part of the fill policy, the control plane and the console, and cost
   * nothing. It is the right way to see the system work before deciding to pay
   * for it, and it is what the fallback path uses in production anyway.
   */
  const provider: ModelProvider | null = buildProvider(config, logger);

  if (provider !== null) {
    logger.info('persona model provider selected', {
      provider: provider.name,
      model: config.personas.model,
    });
  }

  if (provider === null) {
    logger.warn(
      'no PERSONA_API_KEY set; personas will use the scripted voice and spend nothing. ' +
        'They will greet and acknowledge but cannot answer anything: the scripted voice ' +
        'does not read what the stranger said',
    );
  }

  const url = personaWsUrl(config);
  const origin = config.http.allowedOrigins[0] ?? `http://localhost:${config.http.port}`;

  const supervisor = new PersonaSupervisor({
    control,
    queue: redisQueueView(clients.command, keys),
    logger,
    policy: {
      waitBeforeFillSeconds: config.personas.waitBeforeFillSeconds,
      maxConcurrent: config.personas.maxConcurrent,
      maxPerCharacter: config.personas.maxPerCharacter,
      minDispatchGapMs: config.personas.minDispatchGapMs,
      segment: config.matchmaking.defaultSegment,
    },
    characters,
    provider: provider?.name ?? 'scripted',
    dispatch: (character) =>
      startPersona(character, {
        config,
        logger,
        db: database,
        budget,
        provider,
        metrics,
        url,
        origin,
      }),
  });

  let stopping = false;

  const tick = async (): Promise<void> => {
    if (stopping) return;
    try {
      const outcome = await supervisor.tick();
      metrics.tick(outcome);
      metrics.sessionsActive(supervisor.liveCount());
      metrics.budget(await budget.check());

      if (outcome.action === 'dispatched') {
        logger.info('persona dispatched', { personaId: outcome.characterId });
      }
    } catch (err) {
      // A failed tick must never stop the loop. The supervisor already fails
      // closed on everything it can see; this is the backstop for what it
      // cannot.
      logger.error('persona supervisor tick failed', {
        err: err instanceof Error ? err.name : 'unknown',
      });
    }
  };

  const timer = setInterval(() => void tick(), config.personas.tickIntervalMs);
  const reconciler = setInterval(
    () => void control.reconcile(),
    config.personas.controlCacheTtlSeconds * 1000 * 10,
  );

  /**
   * A scrape endpoint, and nothing else.
   *
   * Without it every `chat_persona_*` series is recorded into a registry
   * nothing can reach, which is the same failure as declaring a metric and
   * never writing it: charted, zero, believed. Prometheus scrapes this the way
   * it scrapes the backends.
   *
   * Deliberately minimal. This process has no users, no sessions and no reason
   * to accept anything but a GET on two paths, so it does not get a router or a
   * framework — the same call D10 made for the chat server's three endpoints.
   */
  const metricsServer = createServer((req, res) => {
    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      return;
    }
    if (req.url !== '/metrics') {
      res.writeHead(404).end();
      return;
    }
    registry
      .scrape()
      .then((body) => {
        res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' }).end(body);
      })
      .catch(() => {
        res.writeHead(500).end();
      });
  });

  const metricsPort = Number(process.env['PERSONA_METRICS_PORT'] ?? 8090);
  await new Promise<void>((resolve) => {
    metricsServer.listen(metricsPort, '0.0.0.0', () => resolve());
  });

  logger.info('persona service started', {
    provider: provider?.name ?? 'none',
    model: provider === null ? 'none' : config.personas.model,
    maxConcurrent: config.personas.maxConcurrent,
    metricsPort,
  });

  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('persona service shutting down', { signal });

    clearInterval(timer);
    clearInterval(reconciler);
    metricsServer.close();

    // Stop every persona before closing the database, so the conversation rows
    // are closed out rather than left open for ever with no end time.
    const stopped = supervisor.stopAll();
    logger.info('personas stopped', { count: stopped });
    await new Promise((resolve) => setTimeout(resolve, 250));

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

/**
 * Which adapter answers, if any.
 *
 * An empty key is a supported mode, not a broken one: personas run on the
 * scripted voice, hold real conversations, exercise the fill policy, the
 * control plane and the console, and spend nothing.
 *
 * The default arm is unreachable — `assertCoherent` refuses an unknown
 * `PERSONA_PROVIDER` at boot, so a name that got this far would be a name
 * added to `PROVIDER_MODELS` and not to this switch. It throws rather than
 * quietly picking one, because silently running on the wrong vendor is how a
 * key ends up somewhere its owner did not send it.
 */
function buildProvider(config: ReturnType<typeof loadConfig>, logger: Logger): ModelProvider | null {
  if (config.personas.apiKey === '') return null;

  const options = {
    apiKey: config.personas.apiKey,
    model: config.personas.model,
    logger,
  };

  switch (config.personas.provider) {
    case 'anthropic':
      return new AnthropicProvider(options);
    case 'openai':
      return new OpenAIProvider(options);
    default:
      throw new Error(
        `PERSONA_PROVIDER "${config.personas.provider}" has no adapter wired in main.ts`,
      );
  }
}

/**
 * Where the personas connect.
 *
 * `PERSONA_WS_URL` when set, so a container can reach the backend by service
 * name; otherwise the local address this build would serve on. Personas are
 * clients and connect the way any client does — there is no internal channel,
 * which is what keeps every invariant applying to them (D-AI-6).
 */
function personaWsUrl(config: ReturnType<typeof loadConfig>): string {
  const configured = process.env['PERSONA_WS_URL'];
  if (configured !== undefined && configured.trim() !== '') return configured.trim();
  return `ws://localhost:${config.http.port}${config.http.wsPath}`;
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : 'unknown startup failure';
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
