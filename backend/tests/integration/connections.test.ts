/**
 * Mutual consent, against the real script and the real table (§31, D47).
 *
 * The interesting assertions here are not "a connection is created" but the
 * three things that must never happen:
 *
 *   * one side's save reaching the other side,
 *   * two rows for one relationship,
 *   * both sides being told they connected twice.
 *
 * The first is a privacy property, and the only place it can be checked is
 * here: the unit tests use a scripted store that cannot express two callers
 * racing, which is exactly the case the Lua exists for.
 */
import { newMatchId } from '../../src/util/ids';
import { createConnectionRepository } from '../../src/accounts/connections';
import { createTestContext, enqueue, type TestContext } from '../helpers/redis';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: TestContext;
let pg: PostgresContext;

beforeAll(async () => {
  ctx = await createTestContext();
  pg = await createPostgresContext();
});

afterAll(async () => {
  await ctx.close();
  await pg.close();
});

beforeEach(async () => {
  await ctx.flush();
  await pg.db.query('delete from connections');
  await pg.db.query('delete from accounts');
});

/** Two queued sessions, matched, with an account attached to each. */
async function pair(): Promise<{ a: string; b: string; accountA: string; accountB: string }> {
  const a = await ctx.session();
  const b = await ctx.session();
  await enqueue(ctx, a);
  await enqueue(ctx, b);
  const result = await ctx.store.tryMatch(a, ctx.segment, newMatchId());
  if (result.status !== 'matched') throw new Error('expected a match');
  return { a, b, accountA: 'acc_aaaa', accountB: 'acc_bbbb' };
}

describe('the consent script', () => {
  it('tells the first saver nothing about the partner', async () => {
    const { a, accountA } = await pair();
    expect(await ctx.store.saveConnection(a, accountA, true)).toEqual({
      status: 'pending',
      matchId: expect.any(String),
    });
  });

  it('completes on the second save, and only for the second caller', async () => {
    const { a, b, accountA, accountB } = await pair();

    const first = await ctx.store.saveConnection(a, accountA, true);
    expect(first.status).toBe('pending');

    const second = await ctx.store.saveConnection(b, accountB, true);
    // The pair comes back sorted, decided inside the script where both ids were
    // in hand at once.
    expect(second).toMatchObject({
      status: 'made',
      accountLo: 'acc_aaaa',
      accountHi: 'acc_bbbb',
    });
  });

  it('sorts the pair whichever order it is pressed in', async () => {
    // The account that sorts higher saves first, so the script has to reorder
    // rather than record arrival order. Without the swap this returns the pair
    // backwards and the insert violates the check constraint.
    const { a, b } = await pair();
    await ctx.store.saveConnection(a, 'acc_zzzz', true);
    const made = await ctx.store.saveConnection(b, 'acc_aaaa', true);
    expect(made).toMatchObject({ status: 'made', accountLo: 'acc_aaaa', accountHi: 'acc_zzzz' });
  });

  it('announces once, however many times the completing press is repeated', async () => {
    // Without reading the field before writing it, every retry returns MADE and
    // both people are told they connected several times.
    const { a, b, accountA, accountB } = await pair();
    await ctx.store.saveConnection(a, accountA, true);

    expect((await ctx.store.saveConnection(b, accountB, true)).status).toBe('made');
    expect((await ctx.store.saveConnection(b, accountB, true)).status).toBe('already');
    expect((await ctx.store.saveConnection(b, accountB, true)).status).toBe('already');
  });

  it('lets a save be withdrawn while the conversation is still running', async () => {
    const { a, b, accountA, accountB } = await pair();
    await ctx.store.saveConnection(a, accountA, true);
    expect((await ctx.store.saveConnection(a, accountA, false)).status).toBe('withdrawn');

    // The partner saving now must NOT complete: the first consent is gone.
    expect((await ctx.store.saveConnection(b, accountB, true)).status).toBe('pending');
  });

  it('is idempotent on withdrawal', async () => {
    const { a, accountA } = await pair();
    expect((await ctx.store.saveConnection(a, accountA, false)).status).toBe('withdrawn');
    expect((await ctx.store.saveConnection(a, accountA, false)).status).toBe('withdrawn');
  });

  it('refuses one account on both sides of a conversation', async () => {
    // Two tabs, one account. Not a connection, and the check constraint would
    // refuse the row — so the script says so rather than returning a pair the
    // repository then throws on.
    const { a, b } = await pair();
    await ctx.store.saveConnection(a, 'acc_same', true);
    expect((await ctx.store.saveConnection(b, 'acc_same', true)).status).toBe('self');
  });

  it('is not matched when there is no conversation', async () => {
    const lonely = await ctx.session();
    expect(await ctx.store.saveConnection(lonely, 'acc_aaaa', true)).toEqual({
      status: 'not_matched',
    });
  });

  it('cannot be completed after the match ended', async () => {
    // I6: a deleted match delivers nothing, and that has to include this. A
    // save landing after the conversation ended would connect two people who
    // are no longer talking, one of whom may have left precisely to stop.
    const { a, b, accountA, accountB } = await pair();
    await ctx.store.saveConnection(a, accountA, true);
    const route = await ctx.store.resolveRoute(a);
    if (route.status !== 'ok') throw new Error('expected a live route');
    await ctx.store.endMatch(route.matchId);

    expect((await ctx.store.saveConnection(b, accountB, true)).status).toBe('not_matched');
  });
});

describe('the connections table', () => {
  const repo = (): ReturnType<typeof createConnectionRepository> =>
    createConnectionRepository(pg.db, pg.logger);

  beforeEach(async () => {
    // `retention_expires_at` has no default on purpose (D17): the deadline is
    // stamped by whoever inserts, so a config change cannot retroactively
    // extend the life of data already stored. A fixture has to stamp it too.
    await pg.db.query(
      `insert into accounts (id, retention_expires_at)
       values ('acc_aaaa', $1), ('acc_bbbb', $1), ('acc_cccc', $1)`,
      [new Date(Date.now() + 86_400_000)],
    );
  });

  it('creates the row once and reports which call did it', async () => {
    expect(await repo().save('acc_aaaa', 'acc_bbbb')).toBe(true);
    // The second call is not an error: the script guarantees one caller is told
    // `made`, and a retry of that caller's own request is ordinary.
    expect(await repo().save('acc_aaaa', 'acc_bbbb')).toBe(false);

    const { rows } = await pg.db.query<{ n: string }>('select count(*) as n from connections');
    expect(rows[0]?.n).toBe('1');
  });

  it('refuses an unsorted pair before the constraint has to', async () => {
    // The check constraint would catch it, and its message names a column
    // rather than the invariant. This is the error somebody actually wants.
    await expect(repo().save('acc_bbbb', 'acc_aaaa')).rejects.toThrow(/unsorted/);
  });

  it('refuses an account connecting to itself', async () => {
    await expect(repo().save('acc_aaaa', 'acc_aaaa')).rejects.toThrow(/unsorted/);
  });

  it('lists connections from either side of the pair', async () => {
    // The ordering is on the opaque id, so a person is on whichever side sorts
    // lower. A query that read only one column would show half the friends.
    await repo().save('acc_aaaa', 'acc_bbbb');
    await repo().save('acc_bbbb', 'acc_cccc');

    expect((await repo().list('acc_bbbb')).map((c) => c.other).sort()).toEqual(['acc_aaaa', 'acc_cccc']);
    expect((await repo().list('acc_aaaa')).map((c) => c.other)).toEqual(['acc_bbbb']);
    expect((await repo().list('acc_cccc')).map((c) => c.other)).toEqual(['acc_bbbb']);
  });

  it('removes from either side, and removal is unilateral', async () => {
    await repo().save('acc_aaaa', 'acc_bbbb');
    // Called with the arguments the *higher* side would pass, to prove the
    // caller does not have to know which column they are in.
    expect(await repo().remove('acc_bbbb', 'acc_aaaa')).toBe(true);
    expect(await repo().list('acc_aaaa')).toEqual([]);
    expect(await repo().list('acc_bbbb')).toEqual([]);
  });

  it('reports a removal that removed nothing', async () => {
    expect(await repo().remove('acc_aaaa', 'acc_cccc')).toBe(false);
  });

  it('carries no reference to the conversation, and the schema enforces it', async () => {
    // The line `010_accounts.sql` names as the one to defend in review. Asserted
    // against the live schema rather than trusted to review, because this is the
    // table most likely to grow such a column and the growth would look helpful.
    // Scoped to this context's schema. Every context migrates its own copy of
    // the schema into the same database, so an unscoped query reports the
    // columns of every suite that has run - the assertion then passes alone and
    // fails in a full run, which reads as a schema change nobody made.
    const { rows } = await pg.db.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = $1 and table_name = 'connections'`,
      [pg.schema],
    );
    const columns = rows.map((row) => row.column_name).sort();
    expect(columns).toEqual(['account_hi', 'account_lo', 'created_at']);
  });

  it('disappears with the account, so closing one leaves no dangling half', async () => {
    await repo().save('acc_aaaa', 'acc_bbbb');
    await pg.db.query(`delete from accounts where id = 'acc_aaaa'`);
    expect(await repo().list('acc_bbbb')).toEqual([]);
  });
});
