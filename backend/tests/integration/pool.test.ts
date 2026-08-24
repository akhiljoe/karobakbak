/**
 * The transaction helper's failure paths, against a real PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS NEEDED A REAL SERVER
 * ---------------------------------------------------------------------------
 * The distinction under test is between an error PostgreSQL *sent* and an error
 * the driver *manufactured* after giving up waiting, and only a real connection
 * can produce both. A fake pool can be told to throw either one, which means it
 * can only ever confirm the branch it was told to take.
 *
 * Making the client-side timeout win against a live server takes one trick:
 * `SET statement_timeout = 0` inside the transaction disables the server's own
 * deadline for that session, so a long `pg_sleep` runs to completion on the
 * server while the driver's `query_timeout` expires underneath it. That is the
 * same shape as the failure that motivated this -- a paused database container,
 * where the server was not enforcing anything because it was not running.
 *
 * ---------------------------------------------------------------------------
 * WHAT WENT WRONG
 * ---------------------------------------------------------------------------
 * Chaos scenario C1 paused PostgreSQL for 60 seconds under load and the circuit
 * breaker never opened. The reason was arithmetic: every failed write cost
 * *two* timeouts rather than one, because the rollback issued after the failure
 * queued behind the statement that had already hung and waited out the same
 * deadline in its turn. The breaker opens on BREAKER_FAILURE_THRESHOLD
 * consecutive failures, so at the defaults it needed 5 x 20s = 100 seconds of
 * downtime before it could open at all -- and until it opens, the outage spool
 * that exists to absorb exactly this is unreachable. The retention queue grew
 * from 30 records to 3320 while the breaker reported CLOSED.
 *
 * The second defect was in the same six lines and had no symptom yet: the
 * cleanup released the client bare while its comment claimed it was releasing
 * with an error, so a connection that timed out mid-transaction went back into
 * the pool for the next borrower to inherit.
 */
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

/**
 * Comfortably longer than the driver deadline below, so the server is still
 * working when the client stops listening.
 */
const SERVER_SLEEP_SECONDS = 30;
const CLIENT_DEADLINE_MS = 1000;

let ctx: PostgresContext;

beforeAll(async () => {
  ctx = await createPostgresContext({
    DATABASE_STATEMENT_TIMEOUT_MS: String(CLIENT_DEADLINE_MS),
  });
});

afterAll(async () => {
  await ctx.close();
});

describe('transaction cleanup after a failure', () => {
  it('costs one deadline, not two, when the server never answers', async () => {
    const startedAt = Date.now();

    await expect(
      ctx.db.transaction(async (client) => {
        // The server stops enforcing its own deadline, so the driver's is the
        // only one left and the statement outlives the client's patience.
        await client.query('SET statement_timeout = 0');
        await client.query(`SELECT pg_sleep(${SERVER_SLEEP_SECONDS})`);
      }),
    ).rejects.toThrow();

    const elapsed = Date.now() - startedAt;

    // The assertion is the whole finding. A rollback sent down a connection
    // nobody is answering cannot succeed and is not free: it waits out the
    // deadline again, doubling how long a single failure takes to report and
    // therefore doubling the outage the breaker needs before it can open.
    expect(elapsed).toBeLessThan(CLIENT_DEADLINE_MS * 1.8);
  });

  it('does not return a connection whose fate is unknown to the pool', async () => {
    await expect(
      ctx.db.transaction(async (client) => {
        await client.query('SET statement_timeout = 0');
        await client.query(`SELECT pg_sleep(${SERVER_SLEEP_SECONDS})`);
      }),
    ).rejects.toThrow();

    // Destroyed rather than released. Handing this one back would lend the next
    // caller a session with a transaction still open on the server and a
    // `pg_sleep` still running in it.
    expect(ctx.db.pool.totalCount).toBe(0);

    // And the pool still works: the connection was removed, not the pool.
    const alive = await ctx.db.query<{ ok: number }>('select 1 as ok');
    expect(alive.rows[0]?.ok).toBe(1);
  });

  it('still rolls back and keeps the connection when the server answers', async () => {
    await expect(
      ctx.db.transaction(async (client) => {
        // A real SQLSTATE (22012, division_by_zero) on a connection that is
        // alive and listening. Nothing here is a reason to discard it.
        await client.query('select 1 / 0');
      }),
    ).rejects.toThrow();

    expect(ctx.db.pool.totalCount).toBe(1);

    // Proves the ROLLBACK was actually issued: a connection still inside an
    // aborted transaction refuses every subsequent statement with 25P02.
    const after = await ctx.db.query<{ ok: number }>('select 1 as ok');
    expect(after.rows[0]?.ok).toBe(1);
  });
});
