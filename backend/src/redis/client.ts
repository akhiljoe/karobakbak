/**
 * Redis connections.
 *
 * Two connections, always:
 *
 *  - **command** — every script, read and write.
 *  - **subscriber** — nothing but `SUBSCRIBE`/`UNSUBSCRIBE`. A Redis connection
 *    in subscriber mode refuses ordinary commands, so sharing one connection
 *    would break the first `EVALSHA` issued after the first subscribe. This is
 *    a protocol constraint, not a performance choice.
 *
 * `keyPrefix` is deliberately NOT used. ioredis rewrites key arguments for the
 * commands it recognises, which would double-prefix the keys this codebase
 * builds explicitly in `keys.ts` and would silently disagree with the keys the
 * Lua scripts derive from the prefix they are handed in ARGV. One place builds
 * keys, and it is `keys.ts`.
 */
import { Redis, type RedisOptions } from 'ioredis';

import type { Config } from '../config';
import type { Logger } from '../logger';

/** Connection health, as reported to `/ready`. */
export type RedisHealth = 'connecting' | 'ready' | 'down';

export interface RedisClients {
  /** Issues scripts and ordinary commands. */
  readonly command: Redis;
  /** Subscriber-mode connection; only (p)subscribe/unsubscribe are legal on it. */
  readonly subscriber: Redis;
  /**
   * Whether Redis is usable right now.
   *
   * `/ready` is derived from this and from nothing else: a backend whose Redis
   * is down cannot serve a single matchmaking transition, so it must leave the
   * load balancer. PostgreSQL deliberately does not appear here — a backend
   * with a dead database still serves chat correctly (§10.18).
   */
  health(): RedisHealth;
  /** Resolves once both connections have reached `ready` at least once. */
  waitUntilReady(timeoutMs?: number): Promise<void>;
  /** Quit both connections, falling back to a hard disconnect on timeout. */
  close(): Promise<void>;
}

/**
 * One connection, pointed at whatever topology is configured.
 *
 * ioredis reaches a Sentinel set through an options object — `sentinels` plus
 * the primary's `name` — and a single node through a URL. Those are two
 * different constructor shapes rather than two spellings of an address, which
 * is why no value of `REDIS_URL` could ever have produced failover.
 *
 * In Sentinel mode the client asks the Sentinels where the primary is, and asks
 * again whenever its connection drops, so a promotion moves it without anybody
 * editing configuration. `reconnectOnError` below is the other half of that and
 * predates it: a client still holding a socket to the demoted primary is not in
 * error, it is being answered `READONLY`, and without that line it would keep
 * writing there for good.
 */
function createClient(config: Config, connectionName: string): Redis {
  const base: RedisOptions = { ...baseOptions(config), connectionName };

  if (config.redis.sentinels.length === 0) {
    return new Redis(config.redis.url, base);
  }

  return new Redis({
    ...base,
    sentinels: config.redis.sentinels.map(({ host, port }) => ({ host, port })),
    name: config.redis.sentinelName,
    // Separate on purpose: the Sentinels and the data nodes are different
    // processes and routinely hold different credentials. Passing one where the
    // other belongs authenticates against nothing and fails at the first
    // command — after connecting successfully, which is the confusing part.
    ...(config.redis.password === '' ? {} : { password: config.redis.password }),
    ...(config.redis.sentinelPassword === ''
      ? {}
      : { sentinelPassword: config.redis.sentinelPassword }),
  });
}

function baseOptions(config: Config): RedisOptions {
  return {
    commandTimeout: config.redis.commandTimeoutMs,
    // Fail a command rather than queueing it forever while Redis is unreachable:
    // an unbounded offline queue turns a Redis outage into a memory leak and
    // delivers commands minutes late, long after the client gave up.
    maxRetriesPerRequest: 2,
    enableOfflineQueue: false,
    enableReadyCheck: true,
    // Exponential-ish backoff with a ceiling. Reconnection is expected and
    // routine (D12: Redis holds no persistence and may restart empty).
    retryStrategy: (times: number) => Math.min(times * 200, 5000),
    // ioredis reconnects by itself on a READONLY reply from a failed-over
    // replica, which is what a replica promotion looks like to a client.
    reconnectOnError: (err: Error) => err.message.includes('READONLY'),
    lazyConnect: true,
  };
}

/**
 * Build both connections. They are created lazily and connected here, so a
 * misconfigured URL fails at startup rather than on the first user action.
 */
export async function createRedisClients(
  config: Config,
  logger: Logger,
  options: { connect?: boolean } = {},
): Promise<RedisClients> {
  const command = createClient(config, 'command');
  const subscriber = createClient(config, 'subscriber');

  const state: Record<'command' | 'subscriber', RedisHealth> = {
    command: 'connecting',
    subscriber: 'connecting',
  };

  const attach = (client: Redis, role: 'command' | 'subscriber'): void => {
    const roleLogger = logger.child({ component: 'redis', role });
    client.on('ready', () => {
      state[role] = 'ready';
      roleLogger.info('redis ready');
    });
    client.on('end', () => {
      state[role] = 'down';
      roleLogger.warn('redis connection ended');
    });
    client.on('reconnecting', (delay: number) => {
      state[role] = 'connecting';
      roleLogger.warn('redis reconnecting', { delayMs: delay });
    });
    // An 'error' listener is mandatory: without one, ioredis emits an unhandled
    // 'error' event and takes the process down on a transient network blip.
    client.on('error', (err: Error) => {
      state[role] = 'down';
      roleLogger.error('redis error', { errName: err.name, errMsg: err.message });
    });
  };

  attach(command, 'command');
  attach(subscriber, 'subscriber');

  const clients: RedisClients = {
    command,
    subscriber,

    health: () => {
      if (state.command === 'ready' && state.subscriber === 'ready') return 'ready';
      if (state.command === 'down' || state.subscriber === 'down') return 'down';
      return 'connecting';
    },

    waitUntilReady: async (timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (state.command === 'ready' && state.subscriber === 'ready') return;
        if (Date.now() >= deadline) {
          throw new Error('redis did not become ready before the timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },

    close: async () => {
      await Promise.all(
        [command, subscriber].map(async (client) => {
          try {
            await client.quit();
          } catch {
            // QUIT fails if the connection is already gone; that is the state
            // we wanted anyway, so force it closed and move on.
            client.disconnect();
          }
        }),
      );
    },
  };

  if (options.connect !== false) {
    await Promise.all([command.connect(), subscriber.connect()]);
  }

  return clients;
}
