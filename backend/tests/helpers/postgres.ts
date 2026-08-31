/**
 * Integration fixture for the retention store.
 *
 * Each context gets its own PostgreSQL **schema**, so suites can assert on
 * whole-table contents without another test's rows being counted — the same
 * isolation the Redis fixture gets from a key prefix.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig, type Config, type Env } from '../../src/config';
import { createNullLogger, type Logger } from '../../src/logger';
import { migrate } from '../../src/storage/migrate';
import { createDatabase, type Database } from '../../src/storage/pool';
import { Repositories } from '../../src/storage/repositories';
import { RetentionWriter } from '../../src/storage/retention';
import { FileSpool } from '../../src/storage/spool';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://karobakbak:karobakbak@localhost:5433/karobakbak_test';

let schemaCounter = 0;

export interface PostgresContext {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly repositories: Repositories;
  readonly schema: string;
  readonly spoolDir: string;
  /** Rows in one table of this context's schema. */
  count(table: string): Promise<number>;
  rows<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]>;
  writer(overrides?: Env): RetentionWriter;
  close(): Promise<void>;
}

/**
 * Start a context: a private schema, migrated, with the search path pointed at
 * it so every statement in the code under test lands there unmodified.
 */
export async function createPostgresContext(envOverrides: Env = {}): Promise<PostgresContext> {
  schemaCounter += 1;
  const schema = `t${process.pid}x${Date.now().toString(36)}x${schemaCounter}`;
  const spoolDir = mkdtempSync(join(tmpdir(), 'kbb-pg-spool-'));

  const url = new URL(TEST_DATABASE_URL);
  // `options` is how a connection asks for a search_path before the first
  // statement, which is what makes the schema isolation invisible to the code.
  url.searchParams.set('options', `-c search_path=${schema}`);

  const logger = createNullLogger();
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    DATABASE_URL: url.toString(),
    SPOOL_DIR: spoolDir,
    RETENTION_FLUSH_INTERVAL_MS: '50',
    ...envOverrides,
  });

  // The schema itself is created on a connection that does not depend on it.
  const bootstrap = createDatabase(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      DATABASE_URL: TEST_DATABASE_URL,
    }),
    logger,
  );
  await bootstrap.query(`create schema if not exists ${schema}`);
  await bootstrap.close();

  // Migrations run on their own connection, at the default statement timeout,
  // never on the one the test configured.
  //
  // `pool.test.ts` sets DATABASE_STATEMENT_TIMEOUT_MS to a second because that
  // is the deadline it is testing, and every migration was inheriting it as
  // fixture setup. That was already close to the edge on CI and went over it the
  // moment a migration added three index builds — failing as "Query read
  // timeout" inside `migrate`, which reads as a broken migration rather than as
  // a fixture running out of budget.
  //
  // The short deadline is a property of the queries under test. Schema setup is
  // not under test.
  const migrator = createDatabase(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      ALLOWED_ORIGINS: 'http://localhost:5173',
      DATABASE_URL: url.toString(),
      SPOOL_DIR: spoolDir,
    }),
    logger,
  );
  try {
    await migrate(migrator, logger);
  } finally {
    await migrator.close();
  }

  const db = createDatabase(config, logger);

  const context: PostgresContext = {
    config,
    logger,
    db,
    schema,
    spoolDir,
    repositories: new Repositories(config),

    async count(table: string): Promise<number> {
      const { rows } = await db.query<{ count: string }>(`select count(*)::text from ${table}`);
      return Number(rows[0]?.count ?? 0);
    },

    async rows<T extends Record<string, unknown>>(sql: string, values?: unknown[]): Promise<T[]> {
      const result = await db.query<T>(sql, values);
      return result.rows;
    },

    writer(overrides: Env = {}): RetentionWriter {
      const writerConfig =
        Object.keys(overrides).length === 0
          ? config
          : loadConfig({
              NODE_ENV: 'test',
              LOG_LEVEL: 'error',
              ALLOWED_ORIGINS: 'http://localhost:5173',
              DATABASE_URL: url.toString(),
              SPOOL_DIR: spoolDir,
              RETENTION_FLUSH_INTERVAL_MS: '50',
              ...overrides,
            });
      const spool = new FileSpool(writerConfig, logger);
      spool.open();
      return new RetentionWriter(writerConfig, logger, db, spool);
    },

    async close(): Promise<void> {
      await db.close();
      const cleanup = createDatabase(
        loadConfig({
          NODE_ENV: 'test',
          LOG_LEVEL: 'error',
          ALLOWED_ORIGINS: 'http://localhost:5173',
          DATABASE_URL: TEST_DATABASE_URL,
        }),
        logger,
      );
      await cleanup.query(`drop schema if exists ${schema} cascade`);
      await cleanup.close();
      rmSync(spoolDir, { recursive: true, force: true });
    },
  };

  return context;
}

/** A database whose every write fails, for exercising the breaker. */
export function brokenDatabase(): Database {
  const fail = async (): Promise<never> => {
    const error = new Error('connection terminated unexpectedly') as Error & { code?: string };
    error.code = '57P01';
    throw error;
  };
  return {
    pool: undefined as never,
    query: fail,
    transaction: fail,
    close: async () => undefined,
  };
}
