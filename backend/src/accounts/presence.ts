/**
 * Who is online, for the people they connected with.
 *
 * ---------------------------------------------------------------------------
 * A KEY WITH A TTL, AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 * Presence is true for seconds at a time. It is written while a session
 * carrying an account is connected, refreshed on the heartbeat that already
 * exists, and allowed to expire on its own — there is no "went offline" event
 * to miss, because a socket that dies takes the refresh with it and the key
 * lapses. Redis is the right home for exactly the reason it is the wrong home
 * for a record: it forgets, and presence that survived a restart would be
 * presence that was wrong.
 *
 * ---------------------------------------------------------------------------
 * LAST-SEEN EXISTS NOW, AND IT IS COARSE ON PURPOSE (D65)
 * ---------------------------------------------------------------------------
 * This file used to say there would never be one. "Are they here" is a fact
 * about this moment; "when were they last here" is a history of somebody's
 * habits — when they wake up, when they are at work — and it is a larger
 * disclosure wearing the same words. The operator chose to offer it anyway,
 * and D65 is the reversal. What survives of the old argument is its shape:
 *
 *   * The key above still holds no timestamp. Last-active lives in PostgreSQL
 *     (`accounts.last_active_at`), truncated to the hour, and leaves the server
 *     only as a bucket (`lastActiveBucket`) — never the value.
 *   * It is written only while the account shares presence and erased the
 *     moment it stops. Hiding means not being remembered.
 *   * It is shown only to connections who share their own, so nobody can
 *     watch while invisible. That rule lives in the route.
 *   * One write per account per hour at most, gated in Redis, and never
 *     awaited by the heartbeat that triggers it.
 *
 * ---------------------------------------------------------------------------
 * THE CHOICE IS DURABLE EVEN THOUGH THE PRESENCE IS NOT
 * ---------------------------------------------------------------------------
 * `accounts.share_presence` lives in PostgreSQL. A privacy setting that resets
 * when a process restarts is not a setting — it is the same reasoning that
 * keeps the persona kill switch out of Redis. Turning it off also deletes the
 * key that is already published, so it takes effect now rather than within a
 * TTL.
 */
import type { Redis } from 'ioredis';

import { dbErrorFields, errorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';
import { randomBytes } from 'node:crypto';

import { createKeys } from '../redis/keys';

/**
 * How long a published presence survives without a refresh.
 *
 * Comfortably longer than the heartbeat that refreshes it, so an ordinary
 * missed beat does not blink somebody offline, and short enough that a closed
 * laptop stops claiming to be here within about a minute.
 */
export const PRESENCE_TTL_SECONDS = 75;

/**
 * How long a presence token stays usable.
 *
 * Twelve hours, which comfortably outlives the tab that holds it — Recent lives
 * in `sessionStorage` and dies when the tab closes — and is far short of a
 * lasting handle. Nothing revokes these; the TTL is the whole of the bound.
 */
export const PRESENCE_TOKEN_TTL_SECONDS = 12 * 60 * 60;

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * How long ago somebody was last here, as a connection may see it.
 *
 * `{ unit: 'hour', count: 0 }` is "within the last hour". Every other value is
 * a whole number of its unit, rounded down, so "3 hours ago" means somewhere
 * between three and four.
 */
export interface LastActive {
  readonly unit: 'hour' | 'day' | 'week' | 'month' | 'year';
  readonly count: number;
}

/**
 * The bucket a stored stamp is shown as (D65).
 *
 * The stamp is the start of the last hour somebody was here, so they were
 * active at some point before `stamp + 1h`. Measuring from the end of that hour
 * errs toward "more recent" by at most an hour, which is the honest direction
 * for a value that was rounded down when it was written.
 *
 * Coarser the further back it is. "4 months ago" says what a friends list needs
 * to say; "4 months, 3 days and 6 hours ago" is the habit trail D65 exists to
 * refuse. Pure, so the boundaries are tested without a clock.
 */
export function lastActiveBucket(stamp: Date, now: Date): LastActive {
  const elapsed = now.getTime() - (stamp.getTime() + HOUR_MS);
  if (elapsed < HOUR_MS) return { unit: 'hour', count: 0 };
  const hours = Math.floor(elapsed / HOUR_MS);
  if (hours < 24) return { unit: 'hour', count: hours };
  const days = Math.floor(elapsed / DAY_MS);
  if (days < 7) return { unit: 'day', count: days };
  if (days < 30) return { unit: 'week', count: Math.floor(days / 7) };
  const months = Math.floor(days / 30);
  if (months < 12) return { unit: 'month', count: months };
  return { unit: 'year', count: Math.max(1, Math.floor(days / 365)) };
}

export interface PresenceService {
  /**
   * Publish, or refresh, that this account is here, on this session.
   *
   * The session id is the value rather than a flag, because "who is online" and
   * "where do I send them something" are the same question asked twice, and
   * storing only a flag meant answering the second with another lookup that did
   * not exist.
   */
  announce(accountId: string, sessionId: string): Promise<void>;
  /** Stop claiming this account is here. */
  withdraw(accountId: string): Promise<void>;
  /** Which of these accounts are online. Absent means offline or hidden. */
  online(accountIds: readonly string[]): Promise<Set<string>>;
  /**
   * The live session of an account that is visibly online, or null.
   *
   * Reads the visibility key, not the routing one, so somebody who turned
   * presence off answers null exactly as somebody away does. This is what a
   * friend's "Chat" button resolves through — being reachable by a friend is
   * being visible to them.
   */
  visibleSession(accountId: string): Promise<string | null>;
  /** Whether this account currently shares presence. */
  sharing(accountId: string): Promise<boolean>;
  /** This account's own live session, whatever it shows other people. */
  sessionFor(accountId: string): Promise<string | null>;
  /** Change the setting. Turning it off withdraws immediately. */
  setSharing(accountId: string, share: boolean): Promise<void>;
  /**
   * Mint a token a viewer can later use to ask whether this account is here.
   *
   * Null when the account is not sharing presence, so somebody who has turned
   * it off is never remembered by the people they meet — no token, nothing to
   * store, nothing to ask.
   */
  mintToken(accountId: string): Promise<string | null>;
  /**
   * A token for somebody who is not signed in.
   *
   * It resolves straight to a session rather than to an account, which is the
   * whole of the difference: it stops working when that session ends. Somebody
   * signed out never chose to be findable, so what they get is the narrowest
   * version of it — reachable while they are still in the tab you met them in,
   * and not one moment past it.
   */
  mintSessionToken(sessionId: string): Promise<string | null>;
  /** Which of these tokens point at somebody who is online right now. */
  resolveTokens(tokens: readonly string[]): Promise<Set<string>>;
  /**
   * The live session behind a token, or null.
   *
   * Null covers every reason equally — expired token, invented token, opted
   * out, simply not here — which is what stops this being a way to test whether
   * a token ever referred to anybody.
   */
  sessionForToken(token: string): Promise<string | null>;
}

export function createPresenceService(
  db: Database,
  redis: Redis,
  logger: Logger,
  keyPrefix: string,
): PresenceService {
  const keys = createKeys(keyPrefix);

  return {
    async announce(accountId, sessionId) {
      try {
        // Written whatever the setting says: this is routing, not visibility.
        // Somebody who hides from other people still has to be reachable by the
        // things they themselves ask for.
        await redis.set(keys.accountSession(accountId), sessionId, 'EX', PRESENCE_TTL_SECONDS);

        // Checked on every announce rather than cached: the setting is read
        // once per heartbeat, which is cheap, and a cached "yes" would keep
        // publishing somebody who has just turned it off.
        if (!(await this.sharing(accountId))) return;
        await redis.set(keys.presence(accountId), sessionId, 'EX', PRESENCE_TTL_SECONDS);

        // Not awaited. The heartbeat loop walks every socket on this instance
        // in turn, so a slow database here would delay everybody's beat and
        // start timing out connections that are perfectly healthy.
        void stampActive(accountId);
      } catch (err) {
        // Never fatal. Presence is decoration; a heartbeat that fails to
        // publish must not cost the connection it rode in on.
        logger.warn('could not announce presence', errorFields(err));
      }
    },

    async withdraw(accountId) {
      try {
        await redis.del(keys.presence(accountId));
      } catch (err) {
        logger.warn('could not withdraw presence', errorFields(err));
      }
    },

    async visibleSession(accountId) {
      try {
        const sessionId = await redis.get(keys.presence(accountId));
        return sessionId === null || sessionId === '' ? null : sessionId;
      } catch (err) {
        logger.warn('could not resolve a visible account to a session', errorFields(err));
        return null;
      }
    },

    async online(accountIds) {
      const here = new Set<string>();
      if (accountIds.length === 0) return here;
      try {
        // One round trip for the whole list. A friends list is read on open and
        // a `GET` per row would be a request per friend.
        const values = await redis.mget(...accountIds.map((id) => keys.presence(id)));
        accountIds.forEach((id, i) => {
          if (values[i] !== null && values[i] !== undefined) here.add(id);
        });
      } catch (err) {
        // Everybody reads as offline, which is the safe direction: showing
        // somebody as here when they are not is the one wrong answer that
        // matters, because it invites a message into silence.
        logger.warn('could not read presence', errorFields(err));
      }
      return here;
    },

    async sharing(accountId) {
      try {
        const { rows } = await db.query<{ share_presence: boolean }>(
          `select share_presence from accounts where id = $1`,
          [accountId],
        );
        // Default true, matching the column: an account row that has vanished
        // has bigger problems than a dot.
        return rows[0]?.share_presence ?? true;
      } catch (err) {
        logger.warn('could not read the presence setting', dbErrorFields(err));
        // False on failure. If we cannot confirm somebody agreed to be seen,
        // do not show them.
        return false;
      }
    },

    async mintToken(accountId) {
      try {
        if (!(await this.sharing(accountId))) return null;
        // Random, not derived. A derived token would be the same every time the
        // same two people met, which is a stable identifier for a pair — the
        // thing this is careful not to be.
        const token = randomBytes(16).toString('hex');
        // Prefixed, because the two kinds resolve differently and a bare id
        // would make them indistinguishable — an account token that outlived
        // its account would otherwise be read as a session id.
        await redis.set(
          keys.presenceToken(token),
          `a:${accountId}`,
          'EX',
          PRESENCE_TOKEN_TTL_SECONDS,
        );
        return token;
      } catch (err) {
        // No token is an ordinary outcome, so a failure here is simply one more
        // conversation that does not get a dot.
        logger.warn('could not mint a presence token', errorFields(err));
        return null;
      }
    },

    async mintSessionToken(sessionId) {
      try {
        const token = randomBytes(16).toString('hex');
        /*
          The session's own lifetime, not the twelve hours an account token
          gets. There is no setting to consult and nobody agreed to anything, so
          this is bounded by the only consent that exists: they are still here,
          in the conversation you met them in.
        */
        await redis.set(keys.presenceToken(token), `s:${sessionId}`, 'EX', PRESENCE_TTL_SECONDS);
        return token;
      } catch (err) {
        logger.warn('could not mint a session presence token', errorFields(err));
        return null;
      }
    },

    async resolveTokens(tokens) {
      const here = new Set<string>();
      if (tokens.length === 0) return here;
      try {
        const values = await redis.mget(...tokens.map((t) => keys.presenceToken(t)));
        const pairs = tokens
          .map((token, i) => ({ token, value: values[i] }))
          .filter((pair): pair is { token: string; value: string } => typeof pair.value === 'string');
        if (pairs.length === 0) return here;

        /*
          A session token is its own answer: the key exists only while that
          session's heartbeat keeps it alive, so resolving it *is* the liveness
          check. An account token needs the second lookup, because an account
          can exist while nobody is connected to it.
        */
        const accountPairs = pairs.filter((pair) => pair.value.startsWith('a:'));
        pairs.filter((pair) => pair.value.startsWith('s:')).forEach((pair) => here.add(pair.token));
        if (accountPairs.length === 0) return here;

        // One round trip for the whole list rather than one per row.
        const live = await redis.mget(
          ...accountPairs.map((pair) => keys.presence(pair.value.slice(2))),
        );
        accountPairs.forEach((pair, i) => {
          if (live[i] !== null && live[i] !== undefined) here.add(pair.token);
        });
      } catch (err) {
        // Everybody offline, which is the safe direction — showing somebody as
        // here when they are not invites a message into silence.
        logger.warn('could not resolve presence tokens', errorFields(err));
      }
      return here;
    },

    async sessionFor(accountId) {
      try {
        const sessionId = await redis.get(keys.accountSession(accountId));
        return sessionId === null || sessionId === '' ? null : sessionId;
      } catch (err) {
        logger.warn('could not resolve an account to a session', errorFields(err));
        return null;
      }
    },

    async sessionForToken(token) {
      try {
        const value = await redis.get(keys.presenceToken(token));
        if (value === null) return null;
        // A session token points at a session already; it expires with the
        // heartbeat that keeps it, so there is nothing further to check.
        if (value.startsWith('s:')) return value.slice(2) || null;
        const sessionId = await redis.get(keys.presence(value.slice(2)));
        return sessionId === null || sessionId === '' ? null : sessionId;
      } catch (err) {
        logger.warn('could not resolve a presence token to a session', errorFields(err));
        return null;
      }
    },

    async setSharing(accountId, share) {
      try {
        // Turning it off erases the last-active stamp in the same statement, so
        // there is no moment at which somebody is hidden and still remembered.
        await db.query(
          `update accounts
              set share_presence = $2,
                  last_active_at = case when $2 then last_active_at else null end
            where id = $1`,
          [accountId, share],
        );
      } catch (err) {
        logger.error('could not change the presence setting', dbErrorFields(err));
        throw new Error('presence setting could not be saved');
      }
      // Immediately, not within a TTL. Somebody turning this off is asking to
      // stop being visible now, and up to 75 seconds of "still online" would be
      // the interface ignoring them.
      if (!share) {
        await this.withdraw(accountId);
        try {
          // So turning it back on stamps at once rather than next hour.
          await redis.del(keys.activeHour(accountId));
        } catch (err) {
          logger.warn('could not clear the last-active gate', errorFields(err));
        }
      }
    },
  };

  /**
   * Record that this account was here this hour, at most once per hour.
   *
   * The Redis value is the hour last written; PostgreSQL is touched only when it
   * changes. Two instances racing write the same value, which is harmless.
   * `and share_presence` re-checks the setting in the statement itself, so a
   * stamp in flight when somebody turns presence off cannot land after the
   * erase.
   */
  async function stampActive(accountId: string): Promise<void> {
    const hour = Math.floor(Date.now() / HOUR_MS);
    try {
      const gate = keys.activeHour(accountId);
      if ((await redis.get(gate)) === String(hour)) return;
      await redis.set(gate, String(hour), 'EX', 2 * 60 * 60);
      await db.query(
        `update accounts set last_active_at = to_timestamp($2) where id = $1 and share_presence`,
        [accountId, hour * 3600],
      );
    } catch (err) {
      // Lossy by design: a missed stamp makes somebody look an hour staler to
      // their friends, and nothing else.
      logger.warn('could not record last-active', dbErrorFields(err));
    }
  }
}
