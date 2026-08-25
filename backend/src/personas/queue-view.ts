/**
 * The supervisor's read-only window onto the queue.
 *
 * Two reads, both of live matchmaking state, neither of which mutates
 * anything. It is deliberately not part of `RedisStore`: everything there is a
 * state *transition* and goes through a Lua script so transitions cannot
 * interleave (I2). This is a supervisor asking "how busy is it right now", and
 * giving it a home among the transition scripts would invite somebody to add a
 * write next to it.
 *
 * The answer is a snapshot and is understood to be one. By the time a persona's
 * `join_queue` lands the queue may have changed — the supervisor's design
 * accounts for that rather than pretending otherwise, and withdraws when it
 * turns out to have guessed wrong.
 */

import type { RedisKeys } from '../redis/keys';
import type { QueueView } from './supervisor';

/** The Redis commands this needs, and nothing else. */
export interface QueueReader {
  smembers(key: string): Promise<string[]>;
  hget(key: string, field: string): Promise<string | null>;
}

/**
 * `enqueuedAt` is written by the join script and cleared on leaving.
 *
 * Reading it rather than tracking wait time locally matters: the supervisor may
 * have started after the person did, and several backend instances may be
 * running. The server's stamp is the only value every instance agrees on, which
 * is the same reasoning that makes the matchmaking scripts compare it rather
 * than a local clock.
 */
const ENQUEUED_AT_FIELD = 'enqueuedAt';

export function redisQueueView(client: QueueReader, keys: RedisKeys): QueueView {
  return {
    async searching(segment: string): Promise<readonly string[]> {
      return client.smembers(keys.queue(segment));
    },

    async enqueuedAt(sessionId: string): Promise<number | null> {
      const raw = await client.hget(keys.session(sessionId), ENQUEUED_AT_FIELD);
      if (raw === null) return null;

      const parsed = Number(raw);
      // A session that left the queue between the two reads has no stamp, and a
      // malformed one is treated the same way: "no answer" rather than a
      // fabricated wait of zero, which would look like somebody who just
      // arrived and suppress a dispatch that was due.
      return Number.isFinite(parsed) ? parsed : null;
    },
  };
}
