/**
 * Integration-suite preflight.
 *
 * Fails fast, with the command to fix it, rather than letting every test in the
 * suite time out one by one against a Redis that is not running.
 */
import { Redis } from 'ioredis';

import { TEST_REDIS_URL } from './redis';

export default async function globalSetup(): Promise<void> {
  const client = new Redis(TEST_REDIS_URL, {
    lazyConnect: true,
    connectTimeout: 3000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    retryStrategy: () => null,
  });

  try {
    await client.connect();
    const pong = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`unexpected PING reply: ${pong}`);
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `integration tests need Redis at ${TEST_REDIS_URL} — ${reason}\n` +
        '  start it from the repository root:  npm run redis:test:up\n' +
        '  stop it afterwards:                 npm run redis:test:down',
    );
  } finally {
    client.disconnect();
  }
}
