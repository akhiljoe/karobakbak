/**
 * The migration runner.
 *
 * Applies the `.sql` files in `migrations/` in filename order, once each,
 * inside a transaction, recording what it applied. Deliberately small: a
 * migration framework would bring a dependency, a DSL and a rollback story for
 * a schema that is one file long.
 *
 * ---------------------------------------------------------------------------
 * RUN AS THE MIGRATION ROLE, NOT THE APPLICATION ROLE
 * ---------------------------------------------------------------------------
 * This needs `CREATE`; the application role deliberately does not have it
 * (§8.1). Running migrations from the application process at boot would mean
 * granting the running server the privilege to rewrite its own schema, which
 * is exactly the privilege an attacker who reaches the process wants. It is a
 * deploy-time step with its own credentials.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { PoolClient } from 'pg';

import { dbErrorFields, type Logger } from '../logger';
import type { Database } from './pool';

const MIGRATIONS_DIR = join(__dirname, 'migrations');

const LEDGER = `
create table if not exists schema_migrations (
  name        text primary key,
  applied_at  timestamptz not null default now()
)`;

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/** Read the migrations from disk, in the order their names sort. */
export function loadMigrations(directory = MIGRATIONS_DIR): Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({ name, sql: readFileSync(join(directory, name), 'utf8') }));
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply every migration that has not been applied yet.
 *
 * Each runs in its own transaction: a failure leaves the database at the last
 * complete migration rather than half-way through one, and the ledger row is
 * written in the same transaction as the schema change, so the two cannot
 * disagree.
 */
export async function migrate(
  db: Database,
  logger: Logger,
  directory = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  await db.query(LEDGER);

  const { rows } = await db.query<{ name: string }>('select name from schema_migrations');
  const already = new Set(rows.map((row) => row.name));

  const result: MigrationResult = { applied: [], skipped: [] };

  for (const migration of loadMigrations(directory)) {
    if (already.has(migration.name)) {
      result.skipped.push(migration.name);
      continue;
    }

    try {
      await db.transaction(async (client: PoolClient) => {
        await client.query(migration.sql);
        await client.query('insert into schema_migrations (name) values ($1)', [migration.name]);
      });
      result.applied.push(migration.name);
      logger.info('applied migration', { migration: migration.name });
    } catch (err) {
      logger.error('migration failed', { migration: migration.name, ...dbErrorFields(err) });
      throw err;
    }
  }

  return result;
}
