/**
 * Integration-test fixture for the Redis layer.
 *
 * Every context gets its own key prefix, so a test can assert on global
 * cardinalities — queue depth, session count, live matches — without another
 * test's data being counted. That is what makes the race tests meaningful:
 * `SCARD` has to mean "the sessions this test created" and nothing else.
 *
 * Nothing here reads `process.env` for configuration beyond the Redis URL. The
 * config is built explicitly so a test can state the limit it is exercising.
 */
import { Redis } from 'ioredis';

import { loadConfig, type Config, type Env } from '../../src/config';
import { createKeys, type RedisKeys } from '../../src/redis/keys';
import { ScriptRunner } from '../../src/redis/scripts';
import { RedisStore } from '../../src/redis/store';
import { newSessionId } from '../../src/util/ids';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6380';

let prefixCounter = 0;

/** A prefix unique to one test context, and legal as a Redis key component. */
function uniquePrefix(): string {
  prefixCounter += 1;
  return `t${process.pid}x${Date.now().toString(36)}x${prefixCounter}`;
}

export interface TestContext {
  readonly config: Config;
  readonly keys: RedisKeys;
  readonly client: Redis;
  readonly runner: ScriptRunner;
  readonly store: RedisStore;
  readonly segment: string;
  /** Create a session row and return its id, with sensible identity defaults. */
  session(overrides?: Partial<SessionSpec>): Promise<string>;
  /** Delete every key this context created. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionSpec {
  sessionId: string;
  instanceId: string;
  ipHash: string;
  clientHash: string;
  segment: string;
}

/**
 * Hashes in tests are fixed-length hex like the real ones, so a test never
 * accidentally passes because a hash happened to be a friendly short string.
 */
export function fakeHash(seed: string): string {
  const base = seed.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'seed';
  return base.repeat(Math.ceil(32 / base.length)).slice(0, 32);
}

export async function createTestContext(envOverrides: Env = {}): Promise<TestContext> {
  const prefix = uniquePrefix();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: `i_test_${prefix}`,
    REDIS_URL: TEST_REDIS_URL,
    REDIS_KEY_PREFIX: prefix,
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...envOverrides,
  });

  const keys = createKeys(config.redis.keyPrefix);
  const client = new Redis(TEST_REDIS_URL, {
    maxRetriesPerRequest: 3,
    enableOfflineQueue: true,
  });
  const runner = new ScriptRunner(client);
  const store = new RedisStore(client, runner, keys, config);
  const segment = config.matchmaking.defaultSegment;

  const flush = async (): Promise<void> => {
    // SCAN rather than KEYS: the pattern is scoped to this context's prefix, and
    // a blocking KEYS against a shared test Redis is a habit worth not forming.
    let cursor = '0';
    const doomed: string[] = [];
    do {
      const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
      cursor = next;
      doomed.push(...batch);
    } while (cursor !== '0');
    if (doomed.length > 0) await client.del(...doomed);
  };

  return {
    config,
    keys,
    client,
    runner,
    store,
    segment,

    async session(overrides: Partial<SessionSpec> = {}): Promise<string> {
      const sessionId = overrides.sessionId ?? newSessionId();
      await store.createSession(
        {
          sessionId,
          instanceId: overrides.instanceId ?? config.instanceId,
          ipHash: overrides.ipHash ?? fakeHash(sessionId),
          clientHash: overrides.clientHash ?? fakeHash(`c${sessionId}`),
        },
        overrides.segment ?? segment,
      );
      return sessionId;
    },

    flush,

    async close(): Promise<void> {
      await flush();
      client.disconnect();
    },
  };
}

/**
 * Put a session into the queue and leave it there, without attempting a match.
 * Used by tests that need a specific queue population before the interesting
 * call runs.
 */
export async function enqueue(ctx: TestContext, sessionId: string): Promise<void> {
  const result = await ctx.store.joinQueue(sessionId, ctx.segment);
  if (result.status !== 'ok' && result.status !== 'already_searching') {
    throw new Error(`expected ${sessionId} to enter the queue, got ${result.status}`);
  }
}

/** Wall-clock delay, for the few tests that genuinely need Redis time to pass. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
