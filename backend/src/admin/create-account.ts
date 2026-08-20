/**
 * Create the first operator account.
 *
 *   ADMIN_PASSWORD='...' node dist/admin/create-account.js <username> [role]
 *
 * ---------------------------------------------------------------------------
 * WHY THE SECRET IS PRINTED
 * ---------------------------------------------------------------------------
 * The TOTP secret has to reach an authenticator app exactly once, and there is
 * no second channel. It goes to stdout, is never stored anywhere but the
 * database, and cannot be retrieved again — a lost secret means deleting the
 * account and making another. That is the correct trade: a console that can
 * re-display an enrolled secret is a console where reading one row of the
 * database is enough to log in as its owner.
 *
 * Run it attached to a terminal, not into a log file.
 *
 * The password arrives through the environment rather than as an argument,
 * because arguments are visible in `ps` to every other user on the host.
 */
import { loadConfig } from '../config';
import { createLoggerFromConfig } from '../logger';
import { createDatabase } from '../storage/pool';
import { hashPassword, MIN_PASSWORD_LENGTH } from './password';
import { newTotpSecret, totpUri } from './totp';
import { newAdminAccountId } from '../util/ids';

const ROLES = new Set(['moderator', 'senior_moderator', 'security_admin']);

async function main(): Promise<void> {
  const username = process.argv[2];
  const role = process.argv[3] ?? 'moderator';
  const password = process.env.ADMIN_PASSWORD ?? '';

  if (username === undefined || username.length === 0 || username.length > 64) {
    fail('usage: create-account <username> [role]   (password in ADMIN_PASSWORD)');
  }
  if (!ROLES.has(role)) fail(`role must be one of ${[...ROLES].join(', ')}`);
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const config = loadConfig(process.env);
  const logger = createLoggerFromConfig(config);
  const database = createDatabase(config, logger);

  const secret = newTotpSecret();
  const accountId = newAdminAccountId();

  try {
    await database.query(
      `insert into admin_accounts
         (account_id, username, password_hash, totp_secret, role, created_at)
       values ($1, $2, $3, $4, $5, now())`,
      [accountId, username!, await hashPassword(password), secret, role],
    );
  } catch (err) {
    // Never the driver's error object: it echoes parameter values on a
    // constraint violation, and two of these parameters are credentials.
    const duplicate =
      typeof (err as { code?: unknown }).code === 'string' &&
      (err as { code: string }).code === '23505';
    await database.close();
    fail(duplicate ? `an account named "${username}" already exists` : 'could not create account');
  }

  await database.close();

  process.stdout.write(
    [
      '',
      `Created ${role} account: ${username!}`,
      '',
      'Add this to an authenticator app now. It is not stored anywhere else and',
      'cannot be shown again:',
      '',
      `  secret: ${secret}`,
      `  uri:    ${totpUri(secret, username!)}`,
      '',
    ].join('\n'),
  );
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : 'failed'}\n`);
  process.exit(1);
});
