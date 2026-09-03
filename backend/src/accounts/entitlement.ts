/**
 * Whether an account is premium right now.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS EXISTS TO CLOSE
 * ---------------------------------------------------------------------------
 * `accounts.premium_until` was written by the payment webhook and read by
 * nothing. Preferences were gated on `FILTERS_ENABLED`, which is process-wide,
 * so turning payments on would have given the preference to everybody or to
 * nobody and paying would have changed neither. That is configuration that
 * looks applied and is not — the shape of `SPOOL_BACKEND=redis` (F-006) — and
 * the person who would have found it is the first person who paid.
 *
 * ---------------------------------------------------------------------------
 * POSTGRESQL IS THE TRUTH, REDIS IS A CACHE, AND CHAT WAITS ON NEITHER
 * ---------------------------------------------------------------------------
 * The deadline is durable, so it lives in PostgreSQL: an entitlement that reset
 * on restart is not an entitlement, which is the same reasoning that keeps bans
 * (D31) and the persona kill switch out of Redis.
 *
 * It is cached in Redis because the read happens on the connect path and must
 * not become a database round trip in front of every search (D16). The cache is
 * warmed once when a connection binds an account, and the value is then copied
 * onto the session hash, where the matchmaking script already reads. A search
 * therefore touches neither PostgreSQL nor an extra Redis key.
 *
 * ---------------------------------------------------------------------------
 * IT FAILS CLOSED, AND THAT IS INVISIBLE RATHER THAN BROKEN
 * ---------------------------------------------------------------------------
 * A database that cannot answer resolves to **not premium**. That is the safe
 * direction and it costs less than it sounds: a session without the entitlement
 * simply searches without its preference, which is what §29.4's limits already
 * do and what a preference matching nobody already does (D44). Nothing is
 * refused, no error reaches anybody, and the conversation is unaffected — the
 * same degradation, reached by a different route.
 *
 * The opposite choice is the dangerous one. Failing open would hand the paid
 * dimension to everybody for the duration of a database outage, which is
 * precisely when nobody is watching the metric that would show it.
 */
import type { Redis } from 'ioredis';

import { dbErrorFields, errorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';
import { createKeys } from '../redis/keys';

export interface EntitlementService {
  /**
   * When this account's premium lapses, in epoch milliseconds, or null.
   *
   * Null covers three different situations on purpose — never subscribed,
   * lapsed, and could not be determined — because the caller does the same
   * thing with all three and a caller that could tell them apart would be
   * tempted to treat one of them as premium.
   */
  premiumUntilMs(accountId: string): Promise<number | null>;
}

/**
 * How long a cached entitlement is trusted.
 *
 * Short enough that a refund or a lapse takes effect within a few minutes
 * without anything having to invalidate the key, and long enough that a burst
 * of reconnections does not become a burst of queries. It is not a correctness
 * boundary: the deadline itself is in the cached value, so an entitlement that
 * expires *during* the cache window is still read as expired.
 */
export function createEntitlementService(
  db: Database,
  redis: Redis,
  logger: Logger,
  keyPrefix: string,
  cacheSeconds: number,
): EntitlementService {
  const keys = createKeys(keyPrefix);

  return {
    async premiumUntilMs(accountId) {
      const key = keys.premium(accountId);

      try {
        const cached = await redis.get(key);
        if (cached !== null) {
          // The empty string is a cached *negative*. Caching "no entitlement"
          // matters more than caching a positive one, because almost every
          // account is in that state and without it almost every connection
          // would query PostgreSQL.
          if (cached === '') return null;
          const parsed = Number.parseInt(cached, 10);
          return Number.isFinite(parsed) ? parsed : null;
        }
      } catch (err) {
        // A cache that cannot be read is not a failure yet — fall through to
        // the database, which is the authority anyway.
        logger.warn('could not read a cached entitlement', errorFields(err));
      }

      let untilMs: number | null = null;
      try {
        const { rows } = await db.query<{ premium_until: Date | null }>(
          `select premium_until from accounts where id = $1`,
          [accountId],
        );
        const until = rows[0]?.premium_until ?? null;
        untilMs = until === null ? null : until.getTime();
      } catch (err) {
        // Not premium, and deliberately not cached: caching a failure would
        // extend a database blip into five minutes of everybody losing a
        // dimension they paid for.
        logger.warn('could not read an entitlement', dbErrorFields(err));
        return null;
      }

      try {
        await redis.set(key, untilMs === null ? '' : String(untilMs), 'EX', cacheSeconds);
      } catch (err) {
        // The answer is already known, so a cache that will not accept it costs
        // a query next time and nothing else.
        logger.warn('could not cache an entitlement', errorFields(err));
      }

      return untilMs;
    },
  };
}
