/**
 * Which topology the client is actually built for (F-033, D13).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TEST AND NOT A COMMENT
 * ---------------------------------------------------------------------------
 * The bug this covers was not a crash. `REDIS_URL` accepted any address and the
 * process connected happily to it, so a deployment that had stood up a replica
 * and a Sentinel quorum still reached one fixed node and still died with it —
 * with nothing anywhere reporting a problem. ioredis reaches a Sentinel set
 * through a completely different constructor shape (`sentinels` plus `name`)
 * rather than a different address, and no URL can express it.
 *
 * So the property worth asserting is which shape came out, for both connections.
 * `connect: false` keeps this a unit test: the clients are constructed and
 * inspected, and no socket is opened.
 */
import { createRedisClients } from '../../src/redis/client';
import { loadConfig, type Env } from '../../src/config';
import { createNullLogger } from '../../src/logger';

function config(overrides: Env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

describe('the Redis connections', () => {
  it('connects to one address when no sentinels are configured', async () => {
    const clients = await createRedisClients(
      config({ REDIS_URL: 'redis://localhost:6399' }),
      createNullLogger(),
      { connect: false },
    );

    try {
      for (const client of [clients.command, clients.subscriber]) {
        // Falsy rather than a specific empty value: whether ioredis leaves this
        // null or undefined is its business, and "not in sentinel mode" is the
        // property.
        expect(client.options.sentinels).toBeFalsy();
        expect(client.options.host).toBe('localhost');
        expect(client.options.port).toBe(6399);
      }
    } finally {
      clients.command.disconnect();
      clients.subscriber.disconnect();
    }
  });

  it('asks the sentinels for the primary when they are configured', async () => {
    const clients = await createRedisClients(
      config({
        REDIS_URL: '',
        REDIS_SENTINELS: 'sentinel-a:26379,sentinel-b:26379,sentinel-c:26379',
        REDIS_SENTINEL_NAME: 'karobakbak',
      }),
      createNullLogger(),
      { connect: false },
    );

    try {
      // Both, not just the command connection. The subscriber holds every live
      // session's event channel, so a subscriber left pointing at a demoted
      // primary would keep the process nominally healthy while `matched` and
      // `partner_skipped` events stopped arriving — the failure that is hardest
      // to attribute, because chat still half works.
      for (const client of [clients.command, clients.subscriber]) {
        expect(client.options.sentinels).toEqual([
          { host: 'sentinel-a', port: 26379 },
          { host: 'sentinel-b', port: 26379 },
          { host: 'sentinel-c', port: 26379 },
        ]);
        expect(client.options.name).toBe('karobakbak');
      }
    } finally {
      clients.command.disconnect();
      clients.subscriber.disconnect();
    }
  });

  it('keeps the sentinel password off the data connection and vice versa', async () => {
    const clients = await createRedisClients(
      config({
        REDIS_URL: '',
        REDIS_SENTINELS: 'sentinel-a:26379',
        REDIS_SENTINEL_NAME: 'karobakbak',
        REDIS_PASSWORD: 'node-secret',
        REDIS_SENTINEL_PASSWORD: 'sentinel-secret',
      }),
      createNullLogger(),
      { connect: false },
    );

    try {
      expect(clients.command.options.password).toBe('node-secret');
      expect(clients.command.options.sentinelPassword).toBe('sentinel-secret');
    } finally {
      clients.command.disconnect();
      clients.subscriber.disconnect();
    }
  });

  it('reconnects on the reply a promoted replica gives, in either topology', async () => {
    // The other half of failover, and it predates the config for it: after a
    // promotion the old primary is a replica and answers writes with READONLY
    // rather than an error, so a client without this keeps a healthy-looking
    // socket to a node that refuses every write.
    for (const env of [
      { REDIS_URL: 'redis://localhost:6399' },
      {
        REDIS_URL: '',
        REDIS_SENTINELS: 'sentinel-a:26379',
        REDIS_SENTINEL_NAME: 'karobakbak',
      },
    ]) {
      const clients = await createRedisClients(config(env), createNullLogger(), {
        connect: false,
      });
      try {
        const reconnectOnError = clients.command.options.reconnectOnError;
        expect(reconnectOnError).toBeDefined();
        expect(
          reconnectOnError?.(new Error("READONLY You can't write against a read only replica.")),
        ).toBe(true);
        expect(reconnectOnError?.(new Error('ERR unknown command'))).toBe(false);
      } finally {
        clients.command.disconnect();
        clients.subscriber.disconnect();
      }
    }
  });

  it('never queues commands while it is between primaries', async () => {
    // A failover has a window where no write can succeed. Queueing them means
    // delivering a matchmaking transition tens of seconds late, to sessions
    // that have since expired -- and an unbounded queue turns an outage into a
    // memory leak. Failing fast is what lets `/ready` go red and the instance
    // leave the load balancer instead.
    const clients = await createRedisClients(
      config({
        REDIS_URL: '',
        REDIS_SENTINELS: 'sentinel-a:26379',
        REDIS_SENTINEL_NAME: 'karobakbak',
      }),
      createNullLogger(),
      { connect: false },
    );

    try {
      expect(clients.command.options.enableOfflineQueue).toBe(false);
      expect(clients.subscriber.options.enableOfflineQueue).toBe(false);
    } finally {
      clients.command.disconnect();
      clients.subscriber.disconnect();
    }
  });
});
