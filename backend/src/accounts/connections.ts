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
  /**
   * What *this* viewer calls them, or null.
   *
   * One-sided by construction: it lives in its own table keyed by owner, so the
   * other side has their own and neither can see the other's. Never shown to
   * the person it names.
   */
  readonly label: string | null;
  /**
   * The start of the last hour they were here, or null (D65).
   *
   * Null whenever they do not share presence, as well as when nothing was ever
   * recorded — the two must look the same, or hiding would be visible. Never
   * sent to a browser as-is; the route turns it into a bucket.
   */
  readonly lastActiveAt: Date | null;
}

export interface ConnectionRepository {
  save(accountLo: string, accountHi: string): Promise<boolean>;
  list(accountId: string): Promise<Connection[]>;
  remove(accountId: string, otherId: string): Promise<boolean>;
  /** Set or clear this viewer's name for somebody. Empty clears it. */
  setLabel(accountId: string, otherId: string, label: string): Promise<void>;
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
        // The label joins from the viewer's side only, so two people looking at
        // the same connection see their own word for each other and never the
        // other's.
        // The other account's last-active rides along, gated on their own
        // setting in the query as well as by the erase in `setSharing`.
        const { rows } = await db.query<{
          other: string;
          since: Date;
          label: string | null;
          last_active_at: Date | null;
        }>(
          `select p.other, p.since, l.label,
                  case when a.share_presence then a.last_active_at end as last_active_at
             from (
               select account_hi as other, created_at as since from connections where account_lo = $1
               union all
               select account_lo as other, created_at as since from connections where account_hi = $1
             ) p
             left join connection_labels l
               on l.owner_account_id = $1 and l.other_account_id = p.other
             left join accounts a on a.id = p.other
            order by p.since desc, p.other`,
          [accountId],
        );
        return rows.map((row) => ({
          other: row.other,
          since: row.since,
          label: row.label,
          lastActiveAt: row.last_active_at,
        }));
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
    /**
     * Name somebody, or stop naming them.
     *
     * Trimmed and bounded here as well as by the column check: the constraint
     * is the guarantee, this is the error message. An empty label is a delete
     * rather than an empty string — "no name" and "a name that is blank" are
     * the same thing to a reader and should be the same thing in the table.
     */
    async setLabel(accountId: string, otherId: string, label: string): Promise<void> {
      const trimmed = label.trim().slice(0, 40);
      try {
        if (trimmed === '') {
          await db.query(
            `delete from connection_labels
              where owner_account_id = $1 and other_account_id = $2`,
            [accountId, otherId],
          );
          return;
        }
        await db.query(
          `insert into connection_labels (owner_account_id, other_account_id, label)
           values ($1, $2, $3)
           on conflict (owner_account_id, other_account_id)
           do update set label = excluded.label, updated_at = now()`,
          [accountId, otherId, trimmed],
        );
      } catch (err) {
        logger.error('failed to set a connection label', dbErrorFields(err));
        throw new Error('label could not be saved');
      }
    },

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
