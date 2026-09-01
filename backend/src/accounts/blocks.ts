/**
 * The blocks a signed-in person made, and the two things they can do with them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 * ---------------------------------------------------------------------------
 * Blocks are enforced from Redis, keyed on a salted IP hash and a client token
 * hash, checked in both directions inside `tryMatch` (D18). Both of those keys
 * change: a different network gives a different IP, a cleared cookie gives a
 * different token. So a block is enforced perfectly and is impossible to *find*
 * — there is nothing stable to ask "which of these are mine" about.
 *
 * An account id is the one durable identity in the system. Recording it beside
 * a block, which `blocks` has stored durably since `001_initial.sql` anyway,
 * makes the block findable again from anywhere. That is the whole feature.
 *
 * ---------------------------------------------------------------------------
 * POSTGRES IS THE RECORD, REDIS IS THE ENFORCEMENT
 * ---------------------------------------------------------------------------
 * Exactly the shape bans already use (D31), and for the same reason: Redis has
 * persistence off (D12), so anything held only there returns to nothing on a
 * restart. The database holds what is true; Redis holds what is fast.
 *
 * `tryMatch` is untouched. Adding an account lookup to the most race-tested
 * script in the system, to serve a list nobody reads during matchmaking, would
 * be paying in the one currency this codebase says not to spend.
 *
 * `replay` is what keeps the two in step, and it runs on the connection that
 * carries an account — writing the stored blocks into the Redis sets under
 * whatever keys that person is presenting *now*. A block made at home is
 * enforced at work, which is the thing the key-only model could never do.
 *
 * ---------------------------------------------------------------------------
 * WHAT A LIST MAY SAY
 * ---------------------------------------------------------------------------
 * When, and nothing else. The blocked person is a hash and stays one: they may
 * have no account, and resolving one for them would mean turning a pair of key
 * hashes into an identity, which is the cross-chat correlation §24.3 exists to
 * prevent. You see that you blocked somebody three days ago. You do not see who
 * they were, and neither does anybody else.
 */
import type { Redis } from 'ioredis';

import { dbErrorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';
import { createKeys } from '../redis/keys';

/** One block, as its owner may see it. */
export interface AccountBlock {
  /** Opaque, per-viewer. The only way to address this block. */
  readonly handle: string;
  readonly since: Date;
}

export interface BlockRepository {
  list(accountId: string): Promise<AccountBlock[]>;
  /** Answers whether a block was found and removed. */
  remove(accountId: string, handle: string): Promise<boolean>;
  /** Re-arms this account's still-live blocks under the keys it presents now. */
  replay(accountId: string, keys: { ipHash: string; clientHash: string }): Promise<number>;
}

interface Row extends Record<string, unknown> {
  readonly block_id: string;
  readonly blocker_key: string;
  readonly blocked_key: string;
  readonly dimension: 'ip' | 'client';
  readonly created_at: Date;
  readonly expires_at: Date;
}

export function createBlockRepository(
  db: Database,
  redis: Redis,
  logger: Logger,
  keyPrefix: string,
  ttlSeconds: number,
): BlockRepository {
  const keys = createKeys(keyPrefix);

  /**
   * Rows for one account, still in force, newest first.
   *
   * `expires_at > now()` because the deletion worker runs on a schedule and a
   * list is read on demand: a block that expired four minutes ago is not
   * enforced any more, so offering to unblock it would be offering to undo
   * something that has already stopped.
   */
  async function live(accountId: string): Promise<Row[]> {
    const { rows } = await db.query<Row>(
      `select block_id, blocker_key, blocked_key, dimension, created_at, expires_at
         from blocks
        where blocker_account_id = $1
          and expires_at > now()
        order by created_at desc`,
      [accountId],
    );
    return rows;
  }

  /**
   * Every blocker key this account's blocks are currently armed under.
   *
   * The row records the key presented when the block was *made*. `replay` arms
   * the same block under whatever key is presented later, so an unblock has to
   * reach both — and the replayed one is not in the row. Rather than keep that
   * in process memory, which would be a singleton and wrong across two
   * replicas, each replay records the key it armed in a Redis set beside the
   * blocks themselves. It is a cache in the same store as the thing it
   * describes, and it expires with it.
   */
  function armedKeys(accountId: string): string {
    return `${keyPrefix}:blockarm:${accountId}`;
  }

  return {
    async list(accountId) {
      try {
        const rows = await live(accountId);
        /*
          One entry per *person*, not per dimension. A single block writes two
          rows — an IP one and a client one — and showing both would tell
          somebody they blocked two people when they blocked one, and let them
          unblock half of it. They are grouped by the moment they were made,
          which is what the two rows share and all that is shown.
        */
        const byMoment = new Map<string, Row>();
        for (const row of rows) {
          const moment = String(row.created_at.getTime());
          if (!byMoment.has(moment)) byMoment.set(moment, row);
        }
        return [...byMoment.entries()].map(([moment, row]) => ({
          handle: moment,
          since: row.created_at,
        }));
      } catch (err) {
        logger.error('could not list blocks', dbErrorFields(err));
        throw new Error('blocks could not be listed');
      }
    },

    async remove(accountId, handle) {
      const moment = Number(handle);
      if (!Number.isFinite(moment)) return false;

      try {
        const rows = await live(accountId);
        // Both dimensions of the one block, found by the moment it was made.
        // Removing only one would leave the other half enforcing a block the
        // interface says is gone.
        const mine = rows.filter((row) => row.created_at.getTime() === moment);
        if (mine.length === 0) return false;

        // Redis first, and from every key the block could be armed under: the
        // one recorded on the row, plus any this account has presented since.
        // If this succeeds and the delete fails the block is still listed and
        // still enforced, which the user can retry; the other order would leave
        // it enforced with no record and no way to reach it.
        const armed = await redis.smembers(armedKeys(accountId)).catch(() => [] as string[]);
        for (const row of mine) {
          for (const key of [row.blocker_key, ...armed]) {
            if (key === '') continue;
            await redis.srem(keys.blocks(key), row.blocked_key);
          }
        }

        await db.query(`delete from blocks where block_id = any($1::uuid[])`, [
          mine.map((row) => row.block_id),
        ]);
        return true;
      } catch (err) {
        logger.error('could not remove a block', dbErrorFields(err));
        throw new Error('block could not be removed');
      }
    },

    async replay(accountId, presenting) {
      let armed = 0;
      try {
        const rows = await live(accountId);
        for (const row of rows) {
          const mine = row.dimension === 'ip' ? presenting.ipHash : presenting.clientHash;
          if (mine === '' || mine === row.blocker_key) continue;
          // The remaining life, never the original duration — the mistake
          // `reapplyActiveBans` exists to avoid, where every restart renews
          // every ban.
          const remaining = Math.floor((row.expires_at.getTime() - Date.now()) / 1000);
          if (remaining <= 0) continue;
          const ttl = Math.min(remaining, ttlSeconds);

          await redis.sadd(keys.blocks(mine), row.blocked_key);
          await redis.expire(keys.blocks(mine), ttl);
          // Remembered so an unblock can find this copy. Same TTL, so it cannot
          // outlive what it describes.
          await redis.sadd(armedKeys(accountId), mine);
          await redis.expire(armedKeys(accountId), ttl);
          armed += 1;
        }
      } catch (err) {
        // Never fatal. A failed replay costs enforcement of an old block from a
        // new network — the thing this feature adds — and must not cost the
        // connection it runs on.
        logger.warn('could not replay account blocks', dbErrorFields(err));
      }
      return armed;
    },
  };
}
