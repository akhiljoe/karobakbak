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
 * THERE IS NO LAST-SEEN, AND THERE WILL NOT BE ONE
 * ---------------------------------------------------------------------------
 * "Are they here" is a fact about this moment that stops being true on its own.
 * "When were they last here" is a history of somebody's habits — when they wake
 * up, when they are at work, how long they were away — and it is a far larger
 * disclosure wearing the same words. The key holds no timestamp to read.
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
        await redis.set(
          keys.presenceToken(token),
          accountId,
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

    async resolveTokens(tokens) {
      const here = new Set<string>();
      if (tokens.length === 0) return here;
      try {
        const accounts = await redis.mget(...tokens.map((t) => keys.presenceToken(t)));
        const pairs = tokens
          .map((token, i) => ({ token, account: accounts[i] }))
          .filter((pair): pair is { token: string; account: string } => typeof pair.account === 'string');
        if (pairs.length === 0) return here;

        // Two round trips for the whole list rather than two per row.
        const live = await redis.mget(...pairs.map((pair) => keys.presence(pair.account)));
        pairs.forEach((pair, i) => {
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
        const accountId = await redis.get(keys.presenceToken(token));
        if (accountId === null) return null;
        const sessionId = await redis.get(keys.presence(accountId));
        return sessionId === null || sessionId === '' ? null : sessionId;
      } catch (err) {
        logger.warn('could not resolve a presence token to a session', errorFields(err));
        return null;
      }
    },

    async setSharing(accountId, share) {
      try {
        await db.query(`update accounts set share_presence = $2 where id = $1`, [accountId, share]);
      } catch (err) {
        logger.error('could not change the presence setting', dbErrorFields(err));
        throw new Error('presence setting could not be saved');
      }
      // Immediately, not within a TTL. Somebody turning this off is asking to
      // stop being visible now, and up to 75 seconds of "still online" would be
      // the interface ignoring them.
      if (!share) await this.withdraw(accountId);
    },
  };
}
