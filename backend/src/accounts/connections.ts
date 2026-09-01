/**
 * Saved connections — the durable half of mutual consent (D47, §31).
 *
 * ---------------------------------------------------------------------------
 * THIS WRITE IS ALLOWED TO WAIT ON POSTGRES, AND THAT IS NOT A D16 VIOLATION
 * ---------------------------------------------------------------------------
 * D16 says chat must never wait on the database, and the retention path is
 * write-behind and lossy under overflow because of it. This write is direct and
 * synchronous, and the distinction is what the rule is actually about.
 *
 * Retention is a side effect of every message: it is on the hot path, it
 * happens thousands of times a conversation, and a dropped record costs
 * evidence rather than a promise. A connection is a discrete act by two people
 * who both pressed a button, it happens at most once per conversation, and it
 * is the entire content of the feature — a lost one is a broken promise to two
 * users who watched it succeed.
 *
 * So it takes the same shape `report` does, not the shape `message` does. What
 * it must not do is block message delivery, and it does not: nothing on the
 * message path calls into this file.
 *
 * ---------------------------------------------------------------------------
 * ORDERING IS THE CALLER'S, AND IS ASSERTED HERE ANYWAY
 * ---------------------------------------------------------------------------
 * The pair arrives sorted, because the Lua script that completed the agreement
 * held both ids at once and sorted them there. This re-checks it rather than
 * trusting it: the check constraint would refuse an unsorted pair with a
 * constraint violation naming a column, which is a much worse thing to read at
 * three in the morning than a thrown error naming the invariant.
 */
import { dbErrorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';

/** Thrown rather than interpolated, so no id reaches an error message (I8). */
const UNORDERED = new Error('connection pair reached the repository unsorted');

/** The other side of one connection, and when it was made. */
export interface Connection {
  /** The other account's id. Opaque, and never sent to a browser as-is. */
  readonly other: string;
  /** When the pair connected. */
  readonly since: Date;
}

export interface ConnectionRepository {
  save(accountLo: string, accountHi: string): Promise<boolean>;
  list(accountId: string): Promise<Connection[]>;
  remove(accountId: string, otherId: string): Promise<boolean>;
}

export function createConnectionRepository(
  db: Database,
  logger: Logger,
): ConnectionRepository {
  return {
    /**
     * Record the connection. Returns whether this call created it.
     *
     * `on conflict do nothing` rather than an existence check, because two
     * instances can reach this at once: the Lua script guarantees exactly one
     * caller is told `made`, but a retry of that caller's own request is an
     * ordinary thing and must not become an error. The insert is the
     * idempotency (rule 4), and `rowCount` is how the caller learns whether to
     * announce.
     */
    async save(accountLo: string, accountHi: string): Promise<boolean> {
      if (accountLo >= accountHi) throw UNORDERED;
      try {
        const result = await db.query(
          `insert into connections (account_lo, account_hi)
           values ($1, $2)
           on conflict (account_lo, account_hi) do nothing`,
          [accountLo, accountHi],
        );
        return (result.rowCount ?? 0) > 0;
      } catch (err) {
        // Never the raw error: a `pg` error echoes its parameters on a
        // constraint violation, and these parameters are account ids.
        logger.error('failed to save a connection', dbErrorFields(err));
        throw new Error('connection could not be saved');
      }
    },

    /**
     * Everyone this account is connected to.
     *
     * Both columns, because the ordering is on the opaque id and says nothing
     * about who is whose friend — a person is on whichever side sorts lower.
     * The union is two index probes rather than a scan with an OR.
     */
    async list(accountId: string): Promise<Connection[]> {
      try {
        // `created_at` comes back because it is the only thing this table holds
        // about a connection besides the pair itself, and therefore the only
        // thing a list can honestly show. Ordered newest first, which is the
        // order somebody reads such a list in; the previous ordering by id was
        // ordering by a random string.
        const { rows } = await db.query<{ other: string; since: Date }>(
          `select account_hi as other, created_at as since from connections where account_lo = $1
           union all
           select account_lo as other, created_at as since from connections where account_hi = $1
           order by since desc, other`,
          [accountId],
        );
        return rows.map((row) => ({ other: row.other, since: row.since }));
      } catch (err) {
        logger.error('failed to list connections', dbErrorFields(err));
        throw new Error('connections could not be listed');
      }
    },

    /**
     * Remove a connection, from one side.
     *
     * A hard delete and a unilateral one, deliberately on both counts. Removal
     * is not negotiated — requiring the other person to agree would mean
     * somebody cannot stop being contactable by someone they no longer want to
     * hear from, which is the opposite of what the control is for. And the other
     * side is not told, because a notification turns "I quietly left" into an
     * event addressed at somebody.
     *
     * The asymmetry with saving is intentional: consent to connect is mutual,
     * consent to stay connected is not.
     */
    async remove(accountId: string, otherId: string): Promise<boolean> {
      const [lo, hi] = accountId < otherId ? [accountId, otherId] : [otherId, accountId];
      try {
        const result = await db.query(
          `delete from connections where account_lo = $1 and account_hi = $2`,
          [lo, hi],
        );
        return (result.rowCount ?? 0) > 0;
      } catch (err) {
        logger.error('failed to remove a connection', dbErrorFields(err));
        throw new Error('connection could not be removed');
      }
    },
  };
}
