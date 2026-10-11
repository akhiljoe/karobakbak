/**
 * Resolving an account from a bearer credential, and minting one.
 *
 * ---------------------------------------------------------------------------
 * IT MOVED, AS ITS OLD HEADER SAID IT WOULD
 * ---------------------------------------------------------------------------
 * This was `payments/accounts.ts`, holding the minimum a payment route needed
 * while `010_accounts.sql` was still staged and nothing read it. That header
 * said moving it should be a `git mv` and an import change, and it was.
 *
 * What it must not become is a second identity system. It reads the tables
 * `010_accounts.sql` defines and creates nothing of its own — no user row, no
 * password, no rival session table. The whole reason the payment integration
 * this replaced was rejected is that it shipped a `users(email, password_hash)`
 * table beside them.
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

import { newAccountId, newSessionToken } from '../util/ids';

import { dbErrorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';

export type AccountResolution =
  | {
      readonly ok: true;
      readonly accountId: string;
      /**
       * Where this browser's profile picture lives on the provider's CDN, or
       * null. Per credential, not per account (`020_credential_picture.sql`).
       * Only `/auth/session` and `/auth/avatar` read it, and the browser is
       * never handed it.
       */
      readonly pictureUrl: string | null;
    }
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
    const found = await db.query<{ account_id: string; status: string; picture_url: string | null }>(
      `select c.account_id, a.status, c.picture_url
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

    return { ok: true, accountId: row.account_id, pictureUrl: row.picture_url };
  } catch (err) {
    logger.error('could not resolve an account credential', dbErrorFields(err));
    return { ok: false, reason: 'error' };
  }
}

/* -------------------------------------------------------------------------- */
/* Signing in                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Find or create the account behind a verified OIDC subject (§32, D48).
 *
 * Upsert rather than select-then-insert, because two tabs finishing a redirect
 * at once is ordinary and the losing insert would otherwise surface as a unique
 * violation on a successful sign-in. The partial unique index on `external_id`
 * is what makes `on conflict` able to name a target at all.
 *
 * The account stores the subject and **nothing describing a person** — no
 * email, no name, no age. That is an achieved property rather than an omission:
 * it keeps the Privacy Policy's new data row a single line with one retention
 * period, and it keeps "we know almost nothing about you" true for users who
 * sign in. The verified email is read from the token and deliberately dropped.
 *
 * `retention_expires_at` is stamped here because D17 forbids computing a
 * deadline at deletion time — at insert, and again on every returning sign-in
 * (D66), so the deadline is always "this long after the last sign-in" under the
 * setting in force at that moment. The deletion worker removes an active
 * account once it passes.
 */
export async function accountForSubject(
  db: Database,
  logger: Logger,
  subject: string,
  retentionDays: number,
): Promise<
  | { ok: true; accountId: string; created: boolean }
  | { ok: false; reason: 'suspended' | 'error' }
> {
  const expires = new Date(Date.now() + retentionDays * 86_400_000);

  try {
    // The insert returns nothing when the row already exists, so the select is
    // not an optimisation to remove — `do nothing` cannot return the row it did
    // not touch, and `do update` would rewrite `created_at` semantics for a
    // sign-in that changed nothing.
    const created = await db.query<{ id: string; status: string }>(
      `insert into accounts (id, external_id, retention_expires_at)
       values ($1, $2, $3)
       on conflict (external_id) where external_id is not null do nothing
       returning id, status`,
      [newAccountId(), subject, expires],
    );

    let row = created.rows[0];
    // The insert returning a row is the only place a first sign-in is
    // distinguishable from a returning one — the update below cannot tell them
    // apart, because by then the row exists either way.
    const isNew = row !== undefined;
    if (row === undefined) {
      // The deadline moves forward with use. Without this an account expired a
      // fixed period after it was made, however active its owner still was.
      const found = await db.query<{ id: string; status: string }>(
        `update accounts
            set last_seen_at = now(),
                retention_expires_at = $2
          where external_id = $1
      returning id, status`,
        [subject, expires],
      );
      row = found.rows[0];
    }

    if (row === undefined) return { ok: false, reason: 'error' };
    // A suspended or closed account signs in to nothing. Returning a session
    // for one would produce an account that can save connections and cannot be
    // matched, which is worse than a refusal it can act on.
    if (row.status !== 'active') return { ok: false, reason: 'suspended' };
    return { ok: true, accountId: row.id, created: isNew };
  } catch (err) {
    logger.error('could not resolve an account for a subject', dbErrorFields(err));
    return { ok: false, reason: 'error' };
  }
}

/**
 * Mint a session credential and return the plaintext, once.
 *
 * The plaintext exists in exactly two places — the response that carries it and
 * the browser that holds it. Only the SHA-256 is stored, so a database read
 * yields nothing that can be presented, and there is no column here that could
 * hold it even by accident.
 *
 * Unsalted SHA-256 is correct for the same reason it is correct for the resume
 * token: the input is 256 bits of `crypto.randomBytes`, so there is no
 * dictionary for a salt to defeat. A password would need a KDF; this is not one.
 *
 * `expires_at` is absolute and never extended on use — `010_accounts.sql` gives
 * the reason: a credential that renews itself on every use never expires for an
 * active user, which is the property a stolen one benefits from most.
 */
export async function mintCredential(
  db: Database,
  logger: Logger,
  accountId: string,
  ttlSeconds: number,
  pictureUrl: string | null = null,
): Promise<string | null> {
  const token = newSessionToken();
  const tokenHash = createHash('sha256').update(token).digest();
  const expires = new Date(Date.now() + ttlSeconds * 1000);
  // Checked here as well as by the column's constraint, because the constraint
  // would refuse the whole insert: a picture is decoration and must never cost
  // somebody their sign-in.
  const picture = storablePicture(pictureUrl);

  try {
    await db.query(
      `insert into account_credentials (token_hash, account_id, expires_at, picture_url)
       values ($1, $2, $3, $4)`,
      [tokenHash, accountId, expires, picture],
    );
    return token;
  } catch (err) {
    logger.error('could not mint a session credential', dbErrorFields(err));
    return null;
  }
}

/**
 * Revoke one credential. Signing out ends this browser's session and no other.
 *
 * Set rather than deleted, so a token presented after revocation is
 * distinguishable in the database from one that never existed — the two want
 * different investigations, even though `resolveAccount` deliberately gives the
 * caller the same answer for both.
 *
 * Idempotent (rule 4): revoking an already-revoked or absent credential is
 * success, because the caller's goal — that this token no longer works — holds
 * either way.
 */
export async function revokeCredential(
  db: Database,
  logger: Logger,
  token: string,
): Promise<void> {
  if (token === '') return;
  const tokenHash = createHash('sha256').update(token).digest();
  try {
    await db.query(
      // The picture goes with it: a signed-out browser has no reason to keep
      // pointing at somebody's face.
      `update account_credentials set revoked_at = now(), picture_url = null
        where token_hash = $1 and revoked_at is null`,
      [tokenHash],
    );
  } catch (err) {
    logger.error('could not revoke a session credential', dbErrorFields(err));
  }
}

/** A picture URL the `account_credentials` constraint will accept, or null. */
export function storablePicture(url: string | null): string | null {
  if (url === null || !url.startsWith('https://') || url.length > 2048) return null;
  return url;
}
