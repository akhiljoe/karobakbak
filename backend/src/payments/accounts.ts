/**
 * Resolving an account from a bearer credential.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS LIVES HERE AND WHERE IT GOES
 * ---------------------------------------------------------------------------
 * It belongs in an accounts module, and there is not one yet: `010_accounts.sql`
 * is staged in `migrations-pending/` and nothing reads it. Payments are the
 * first caller that needs an authenticated subject, so the minimum lives here
 * and moves out when the accounts phase ships. It is deliberately small enough
 * that moving it is a `git mv` and an import change.
 *
 * What it must not become in the meantime is a second identity system. It reads
 * the tables `010_accounts.sql` defines and creates nothing of its own — no
 * user row, no password, no session. The whole reason the payment integration
 * this replaced was rejected is that it shipped a rival `users(email,
 * password_hash)` table beside them.
 *
 * ---------------------------------------------------------------------------
 * THE CREDENTIAL IS A BEARER TOKEN AND IS TREATED LIKE THE RESUME TOKEN
 * ---------------------------------------------------------------------------
 * Only its SHA-256 is ever compared, because only its SHA-256 is stored — the
 * plaintext exists in the browser that holds it and nowhere else. The hash is
 * the primary key, so the lookup is a single index probe and there is no path
 * that reads a credential *by account*, which is the query an attacker with
 * read access would want.
 *
 * Unsalted SHA-256 is correct here for the same reason it is correct for the
 * resume token (`hashResumeToken`): the input is 256 bits of
 * `crypto.randomBytes`, so there is no dictionary for a salt to defeat. A
 * password would need a KDF; this is not one.
 */
import { createHash } from 'node:crypto';

import { dbErrorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';

export type AccountResolution =
  | { readonly ok: true; readonly accountId: string }
  | { readonly ok: false; readonly reason: 'absent' | 'unknown' | 'suspended' | 'error' };

/**
 * Pull the bearer token out of an `Authorization` header.
 *
 * Returns the empty string for anything that is not exactly one `Bearer`
 * credential, including a header that is present but malformed. There is no
 * fallback to a query parameter or a body field: a credential in a URL ends up
 * in access logs, and one in a body cannot be checked before the body is read.
 */
export function bearerToken(header: unknown): string {
  if (typeof header !== 'string') return '';
  if (!header.startsWith('Bearer ')) return '';
  const token = header.slice(7).trim();
  // Bounded before it is hashed. An unbounded header would let a caller make
  // this process hash a megabyte per request, which is a cheap way to spend
  // somebody else's CPU.
  if (token === '' || token.length > 512) return '';
  return token;
}

/**
 * Which account a credential belongs to, if it is live.
 *
 * A revoked, expired or unknown credential all return `unknown`. The three are
 * distinguishable in the database and deliberately not in the answer: a caller
 * that can tell "revoked" from "never existed" can confirm a token was once
 * real, and nothing legitimate needs to know that.
 *
 * `last_used_at` is touched on success, which is the only write this makes and
 * the only column the chat role is granted on that table.
 */
export async function resolveAccount(
  db: Database,
  logger: Logger,
  token: string,
): Promise<AccountResolution> {
  if (token === '') return { ok: false, reason: 'absent' };

  const tokenHash = createHash('sha256').update(token).digest();

  try {
    const found = await db.query<{ account_id: string; status: string }>(
      `select c.account_id, a.status
         from account_credentials c
         join accounts a on a.id = c.account_id
        where c.token_hash = $1
          and c.revoked_at is null
          and c.expires_at > now()`,
      [tokenHash],
    );

    const row = found.rows[0];
    if (row === undefined) return { ok: false, reason: 'unknown' };
    // A suspended or closed account may not buy anything. Selling a
    // subscription to somebody who cannot use the product is a refund with
    // extra steps.
    if (row.status !== 'active') return { ok: false, reason: 'suspended' };

    // Best effort, and deliberately not awaited into the failure path: a
    // successful authentication must not become a failure because a bookkeeping
    // update did not land.
    await db
      .query('update account_credentials set last_used_at = now() where token_hash = $1', [
        tokenHash,
      ])
      .catch(() => undefined);

    return { ok: true, accountId: row.account_id };
  } catch (err) {
    logger.error('could not resolve an account credential', dbErrorFields(err));
    return { ok: false, reason: 'error' };
  }
}
