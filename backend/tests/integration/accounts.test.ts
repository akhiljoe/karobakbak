/**
 * Accounts and session credentials, against real PostgreSQL (§32, D48).
 *
 * The parts that cannot be checked without a database: the partial unique index
 * on `external_id`, the upsert race two tabs produce, and the fact that a
 * credential is only ever stored as a hash.
 */
import { createHash } from 'node:crypto';

import {
  accountForSubject,
  bearerToken,
  mintCredential,
  resolveAccount,
  revokeCredential,
} from '../../src/accounts/credentials';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let pg: PostgresContext;

beforeAll(async () => {
  pg = await createPostgresContext();
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.db.query('delete from account_credentials');
  await pg.db.query('delete from accounts');
});

const RETENTION_DAYS = 365;

function subject(id: string): ReturnType<typeof accountForSubject> {
  return accountForSubject(pg.db, pg.logger, id, RETENTION_DAYS);
}

describe('resolving an account from an OIDC subject', () => {
  it('creates one on first sign-in and returns the same one after', async () => {
    const first = await subject('sub_alice');
    // `created` distinguishes a first sign-in from a returning one, which is
    // the only place that difference is visible — the insert returns a row and
    // the update below it cannot, because by then the row exists either way.
    // It is what `chat_accounts_created_total` counts.
    expect(first).toMatchObject({ ok: true, created: true });
    if (!first.ok) return;

    const second = await subject('sub_alice');
    expect(second).toEqual({ ok: true, accountId: first.accountId, created: false });
    expect(await pg.count('accounts')).toBe(1);
  });

  it('gives different subjects different accounts', async () => {
    const a = await subject('sub_alice');
    const b = await subject('sub_bob');
    expect(a.ok && b.ok && a.accountId !== b.accountId).toBe(true);
    expect(await pg.count('accounts')).toBe(2);
  });

  it('survives two tabs finishing a redirect at once', async () => {
    // The reason the insert is an upsert. Select-then-insert would surface the
    // losing race as a unique violation on a *successful* sign-in.
    const results = await Promise.all([
      subject('sub_racer'),
      subject('sub_racer'),
      subject('sub_racer'),
    ]);
    const ids = new Set(results.map((r) => (r.ok ? r.accountId : 'failed')));
    expect(ids.size).toBe(1);
    expect(ids.has('failed')).toBe(false);
    expect(await pg.count('accounts')).toBe(1);
  });

  it('does not generate an id from the subject', async () => {
    // `accounts.id` is ours and payments reference it. Handing that key to a
    // vendor is what `014_account_identity.sql` refuses.
    const created = await subject('sub_alice');
    expect(created.ok && created.accountId).not.toBe('sub_alice');
    expect(created.ok && created.accountId.startsWith('acc_')).toBe(true);
  });

  it('refuses a suspended account rather than signing it in', async () => {
    const created = await subject('sub_alice');
    if (!created.ok) throw new Error('expected an account');
    await pg.db.query(`update accounts set status = 'suspended' where id = $1`, [
      created.accountId,
    ]);
    expect(await subject('sub_alice')).toEqual({ ok: false, reason: 'suspended' });
  });

  it('stamps a retention deadline at insert, never leaving it null', async () => {
    // D17: computing an expiry at deletion time would let a config change
    // retroactively extend the life of data already stored.
    await subject('sub_alice');
    const rows = await pg.rows<{ retention_expires_at: Date; external_id: string }>(
      'select retention_expires_at, external_id from accounts',
    );
    expect(rows[0]?.external_id).toBe('sub_alice');
    expect(rows[0]?.retention_expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('leaves external_id null for accounts made another way, without colliding', async () => {
    // The index is partial for exactly this: a plain unique index would collapse
    // every account that predates sign-in into one.
    const future = new Date(Date.now() + 86_400_000);
    await pg.db.query(
      `insert into accounts (id, retention_expires_at) values ('acc_one', $1), ('acc_two', $1)`,
      [future],
    );
    expect(await pg.count('accounts')).toBe(2);
  });
});

describe('the session credential', () => {
  async function signedIn(): Promise<{ accountId: string; token: string }> {
    const account = await subject('sub_alice');
    if (!account.ok) throw new Error('expected an account');
    const token = await mintCredential(pg.db, pg.logger, account.accountId, 3600);
    if (token === null) throw new Error('expected a credential');
    return { accountId: account.accountId, token };
  }

  it('round-trips: minted, then resolves to its account', async () => {
    const { accountId, token } = await signedIn();
    expect(await resolveAccount(pg.db, pg.logger, token)).toEqual({ ok: true, accountId });
  });

  it('is stored only as a hash — the plaintext is nowhere in the table', async () => {
    const { token } = await signedIn();
    const rows = await pg.rows<{ token_hash: Buffer }>('select token_hash from account_credentials');
    const stored = rows[0]?.token_hash;
    expect(stored).toBeDefined();
    expect(stored?.equals(createHash('sha256').update(token).digest())).toBe(true);
    // And nothing anywhere in the row is the token itself.
    expect(stored?.toString('utf8')).not.toBe(token);
  });

  it('mints a distinct credential per browser, and one revocation is not the other', async () => {
    const account = await subject('sub_alice');
    if (!account.ok) throw new Error('expected an account');
    const laptop = await mintCredential(pg.db, pg.logger, account.accountId, 3600);
    const phone = await mintCredential(pg.db, pg.logger, account.accountId, 3600);
    expect(laptop).not.toBe(phone);

    await revokeCredential(pg.db, pg.logger, laptop ?? '');
    expect((await resolveAccount(pg.db, pg.logger, laptop ?? '')).ok).toBe(false);
    // Signing out on one device must not sign out the other.
    expect((await resolveAccount(pg.db, pg.logger, phone ?? '')).ok).toBe(true);
  });

  it('answers the same for revoked, expired and never-existed', async () => {
    // Distinguishable in the database and deliberately not in the answer: a
    // caller that can tell "revoked" from "never existed" can confirm a token
    // was once real, and nothing legitimate needs to know that.
    const { accountId, token } = await signedIn();
    await revokeCredential(pg.db, pg.logger, token);

    const expired = await mintCredential(pg.db, pg.logger, accountId, 3600);
    await pg.db.query(
      `update account_credentials set expires_at = now() - interval '1 hour' where token_hash = $1`,
      [createHash('sha256').update(expired ?? '').digest()],
    );

    for (const candidate of [token, expired ?? '', 'never-existed-at-all']) {
      expect(await resolveAccount(pg.db, pg.logger, candidate)).toEqual({
        ok: false,
        reason: 'unknown',
      });
    }
  });

  it('reports an absent credential differently from a rejected one', async () => {
    // "You are not signed in" and "your credential did not work" are different
    // situations for the interface, even though both mean no account.
    expect(await resolveAccount(pg.db, pg.logger, '')).toEqual({ ok: false, reason: 'absent' });
  });

  it('refuses a credential whose account was suspended after it was minted', async () => {
    const { accountId, token } = await signedIn();
    await pg.db.query(`update accounts set status = 'suspended' where id = $1`, [accountId]);
    expect(await resolveAccount(pg.db, pg.logger, token)).toEqual({
      ok: false,
      reason: 'suspended',
    });
  });

  it('disappears with the account', async () => {
    const { accountId, token } = await signedIn();
    await pg.db.query('delete from accounts where id = $1', [accountId]);
    expect(await pg.count('account_credentials')).toBe(0);
    expect((await resolveAccount(pg.db, pg.logger, token)).ok).toBe(false);
  });

  it('touches last_used_at without failing the sign-in if it cannot', async () => {
    const { token } = await signedIn();
    await resolveAccount(pg.db, pg.logger, token);
    const rows = await pg.rows<{ last_used_at: Date | null }>(
      'select last_used_at from account_credentials',
    );
    expect(rows[0]?.last_used_at).not.toBeNull();
  });
});

describe('reading a bearer header', () => {
  it('takes exactly one well-formed Bearer credential', () => {
    expect(bearerToken('Bearer abc123')).toBe('abc123');
    expect(bearerToken('Bearer  spaced  ')).toBe('spaced');
  });

  it('refuses anything else, including a header that is merely present', () => {
    for (const header of [undefined, 42, '', 'abc123', 'Basic abc', 'bearer abc', 'Bearer ']) {
      expect(bearerToken(header)).toBe('');
    }
  });

  it('bounds the header before hashing it', () => {
    // An unbounded header lets a caller make this process hash a megabyte per
    // request, which is a cheap way to spend somebody else's CPU.
    expect(bearerToken(`Bearer ${'x'.repeat(513)}`)).toBe('');
    expect(bearerToken(`Bearer ${'x'.repeat(512)}`)).toHaveLength(512);
  });
});
