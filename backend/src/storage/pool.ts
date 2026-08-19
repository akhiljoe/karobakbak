/**
 * The PostgreSQL connection pool.
 *
 * ---------------------------------------------------------------------------
 * WHY A `pg` ERROR IS NEVER LOGGED DIRECTLY
 * ---------------------------------------------------------------------------
 * A driver error object echoes the parameters of the failing statement. On a
 * constraint violation or a timeout that means the row you just tried to insert
 * — including `messages.body` and `reports.note` — ends up inside the error,
 * and from there in a log line. `dbErrorFields()` in `logger.ts` exists for
 * exactly this and emits code, constraint, table and routine only. Nothing here
 * passes a `pg` error to a logger by any other route (I8).
 *
 * ---------------------------------------------------------------------------
 * WHY THE POOL IS SMALL AND ITS TIMEOUTS ARE SHORT
 * ---------------------------------------------------------------------------
 * Chat never waits on this database (D16). The pool exists to serve a
 * background writer, so a large pool buys nothing and costs the database
 * connections it could give to something that matters. Short timeouts are what
 * turn a hung database into a *fast* failure the circuit breaker can act on;
 * with long ones the breaker never trips and the queue fills instead.
 */
import { Pool, type PoolClient, type PoolConfig } from 'pg';

import type { Config } from '../config';
import { dbErrorFields, type Logger } from '../logger';

export interface Database {
  readonly pool: Pool;
  /** Run one statement. Never called on the chat hot path. */
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number }>;
  /** Run a function inside a transaction, rolling back on any throw. */
  transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DatabaseTlsError extends Error {
  constructor() {
    super(
      'refusing to start: DATABASE_URL does not require TLS and ' +
        'DATABASE_REQUIRE_SSL_IN_PRODUCTION is set. Message bodies are plaintext ' +
        'application data (D15); their confidentiality depends on the transport.',
    );
    this.name = 'DatabaseTlsError';
  }
}

/**
 * Whether a connection string will actually negotiate TLS.
 *
 * Checked against the URL rather than trusted from a config flag, because the
 * usual way this goes wrong is a correct flag and a connection string copied
 * from a development environment.
 */
export function connectionUsesTls(url: string, sslEnabled: boolean): boolean {
  if (sslEnabled) return true;
  try {
    const parsed = new URL(url);
    const mode = parsed.searchParams.get('sslmode');
    return mode !== null && mode !== 'disable' && mode !== 'allow';
  } catch {
    return false;
  }
}

export function assertTlsWhereRequired(config: Config): void {
  if (!config.database.requireSslInProduction) return;
  if (!config.isProduction) return;
  if (connectionUsesTls(config.database.url, config.database.ssl)) return;
  throw new DatabaseTlsError();
}

/**
 * SQLSTATE classes that mean "this write will never succeed", as opposed to
 * "the database could not take it right now".
 *
 * The distinction is load-bearing. A constraint violation is *proof the
 * database is available* — it parsed the statement and rejected the data. A
 * connection failure is proof it is not. Treating the first as the second is
 * how one permanently-unwritable record opens the circuit breaker, stalls the
 * drain behind it, and silently disables retention on that instance for good.
 *
 *   22  data exception (bad value for the column type)
 *   23  integrity constraint violation (foreign key, unique, check)
 *   42  syntax error or access rule violation (a bug in this code)
 */
const PERMANENT_SQLSTATE_CLASSES = ['22', '23', '42'];

export function isPermanentWriteError(err: unknown): boolean {
  const code = sqlState(err);
  if (code === null) return false;
  return PERMANENT_SQLSTATE_CLASSES.includes(code.slice(0, 2));
}

/**
 * `23503 foreign_key_violation` — a row whose parent is not there **yet**.
 *
 * This is the one member of class 23 that is not permanent in this system, and
 * the reason is the architecture. A conversation row is written by whichever
 * instance won `tryMatch`, but the two participants' sockets live on different
 * instances, and each instance flushes its own retention queue on its own
 * timer. So an instance can perfectly well hold a message for a conversation
 * whose parent row is still sitting in another instance's queue.
 *
 * Treating that as permanent is wrong twice over: the record is discarded
 * although it would have been writable a second later, and — because a batch is
 * one transaction — it takes every other record in the batch with it, including
 * the reports and blocks that are the whole point of retention.
 *
 * The caller retries these a bounded number of times and only then gives up.
 * Every other class-23 violation (unique, check, not-null) stays permanent:
 * those describe the row itself, and waiting will not change them.
 */
export function isMissingParentError(err: unknown): boolean {
  return sqlState(err) === '23503';
}

function sqlState(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.length >= 2 ? code : null;
}

function poolConfig(config: Config): PoolConfig {
  return {
    connectionString: config.database.url,
    max: config.database.poolMax,
    connectionTimeoutMillis: config.database.connectTimeoutMs,
    // Bounds a single statement rather than the whole pool: a query that hangs
    // must fail fast enough for the breaker to count it, not sit on a
    // connection until something else times out.
    statement_timeout: config.database.statementTimeoutMs,
    query_timeout: config.database.statementTimeoutMs,
    idleTimeoutMillis: 30_000,
    ssl: config.database.ssl ? { rejectUnauthorized: true } : undefined,
    application_name: 'karobakbak',
  };
}

export function createDatabase(config: Config, logger: Logger): Database {
  const pool = new Pool(poolConfig(config));

  // Without this listener an idle-client error takes the process down. It is
  // logged through dbErrorFields, never as the error object.
  pool.on('error', (err: Error) => {
    logger.error('database pool error', dbErrorFields(err));
  });

  return {
    pool,

    async query(text, values) {
      const result = await pool.query(text, values);
      return {
        rows: result.rows as never[],
        rowCount: result.rowCount ?? 0,
      };
    },

    async transaction(work) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // The connection is already unusable; releasing it with an error
          // below is what removes it from the pool.
        }
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };
}
