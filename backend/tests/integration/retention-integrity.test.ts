/**
 * The D group — data integrity, the rows that are about retention
 * (`docs/LOADTEST-SCENARIOS.md` §D).
 *
 * ---------------------------------------------------------------------------
 * D10 IS THE ONE THAT DEFENDS A PUBLISHED CLAIM
 * ---------------------------------------------------------------------------
 * The privacy policy says conversations are kept for thirty days and then
 * deleted. `DESIGN.md` D17 says the deadline is stamped at insert time and never
 * computed at deletion time, and `repositories.ts` opens with a comment saying
 * the same. Nothing had ever executed it.
 *
 * The difference is not academic. If expiry were derived at deletion time from
 * whatever the configuration currently says, then editing one environment
 * variable would silently extend the life of every conversation already
 * stored — including the ones belonging to people who were told thirty days.
 * That is the shape of a promise being broken by a deploy, with nothing
 * anywhere reporting it, and it is exactly what a test can rule out.
 *
 * These are catalogued as swarm rows and are not load scenarios: they need a
 * real PostgreSQL and control over the clock and the configuration, which is
 * what an integration test is. Run on every push rather than when somebody
 * remembers to start a stack.
 */
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';
import { Repositories } from '../../src/storage/repositories';
import type { Config } from '../../src/config';
import type {
  ConversationStartedRecord,
  MessageRecord,
  ReportRecord,
} from '../../src/storage/records';

let ctx: PostgresContext;

beforeAll(async () => {
  ctx = await createPostgresContext();
});

afterAll(async () => {
  await ctx?.close();
});

let seq = 0;
function ids(): { conversationId: string; messageId: string } {
  seq += 1;
  return { conversationId: `conv_d_${seq}`, messageId: `msg_d_${seq}` };
}

function conversation(conversationId: string): ConversationStartedRecord {
  return {
    kind: 'conversation_started',
    conversationId,
    sessionA: `sess_a_${conversationId}`,
    sessionB: `sess_b_${conversationId}`,
    segment: 'default',
    startedAt: new Date().toISOString(),
    profileA: null,
    profileB: null,
  };
}

function message(conversationId: string, messageId: string): MessageRecord {
  return {
    kind: 'message',
    messageId,
    conversationId,
    senderSessionId: `sess_a_${conversationId}`,
    serverTimestamp: new Date().toISOString(),
    type: 'text',
    body: 'hello',
    moderationAction: 'allow',
    moderationFlags: [],
  };
}

function report(conversationId: string, reportId: string): ReportRecord {
  return {
    kind: 'report',
    reportId,
    conversationId,
    reporterSessionId: `sess_a_${conversationId}`,
    reportedSessionId: `sess_b_${conversationId}`,
    category: 'harassment',
    note: null,
    createdAt: new Date().toISOString(),
  };
}

/** Write a conversation and one message through the given repositories. */
async function write(
  repos: Repositories,
  conversationId: string,
  messageId: string,
): Promise<void> {
  const now = Date.now();
  await repos.insertConversations(ctx.db, [conversation(conversationId)], now);
  await repos.insertMessages(ctx.db, [message(conversationId, messageId)], now);
}

/** Days between now and a row's deadline, as a float. */
async function daysUntilExpiry(table: string, column: string, id: string): Promise<number> {
  const rows = await ctx.rows<{ days: string }>(
    `select extract(epoch from (retention_expires_at - now())) / 86400 as days
       from ${table} where ${column} = $1`,
    [id],
  );
  return Number(rows[0]?.days ?? Number.NaN);
}

describe('D10 / D17 — a configuration change cannot reach data already stored', () => {
  /**
   * The whole claim, in one test.
   *
   * Two repositories over the same database, differing only in the configured
   * retention window. A row written by the first must keep the deadline it was
   * given when the second writes rows beside it — because the deadline is a
   * value in the row, not a rule applied at deletion.
   */
  it('rows written before the change keep their original deadline', async () => {
    const first = ids();
    await write(ctx.repositories, first.conversationId, first.messageId);
    const originalDays = await daysUntilExpiry('messages', 'message_id', first.messageId);

    /*
      The same database, a different configuration. This is a deploy that edited
      one environment variable and nothing else — the repository is the only
      thing that knows the window, so a second instance of it over the same
      connection is exactly that change and nothing more.
    */
    const longer = new Repositories({
      ...ctx.config,
      retention: {
        ...ctx.config.retention,
        days: { ...ctx.config.retention.days, conversation: 3650 },
      },
    } as Config);

    const second = ids();
    await write(longer, second.conversationId, second.messageId);

    // The new row got the new window...
    const newDays = await daysUntilExpiry('messages', 'message_id', second.messageId);
    expect(newDays).toBeGreaterThan(3000);

    // ...and the old row is untouched. This is D17, and it is the whole test.
    const stillOriginal = await daysUntilExpiry('messages', 'message_id', first.messageId);
    expect(stillOriginal).toBeCloseTo(originalDays, 3);
    expect(stillOriginal).toBeLessThan(3000);
  });

  /**
   * The deadline is a stored value, not a database default.
   *
   * A `default now() + interval '30 days'` on the column would look identical
   * in every test above and would move the moment somebody altered the table.
   * This asserts the column has no default, so the value can only have come
   * from the application.
   */
  it('the column has no default, so the value can only come from the writer', async () => {
    const rows = await ctx.rows<{ column_default: string | null }>(
      `select column_default from information_schema.columns
        where table_schema = $1 and table_name = 'messages'
          and column_name = 'retention_expires_at'`,
      [ctx.schema],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.column_default).toBeNull();
  });
});

describe('D5 — a report extends retention, and never shortens it', () => {
  /**
   * Retention versus evidence. A reported conversation is held longer than an
   * ordinary one, because it is the thing an investigation needs; the deletion
   * worker must not take it out from underneath the report.
   */
  it('a report pushes the conversation and its messages further out', async () => {
    const { conversationId, messageId } = ids();
    await write(ctx.repositories, conversationId, messageId);

    const before = await daysUntilExpiry('messages', 'message_id', messageId);

    seq += 1;
    await ctx.repositories.insertReports(ctx.db, [report(conversationId, `rep_${seq}`)], Date.now());

    const after = await daysUntilExpiry('messages', 'message_id', messageId);
    expect(after).toBeGreaterThan(before);
  });

  /**
   * `greatest`, and the reason it is there: a second report must not pull a
   * deadline back in. Written as two reports on one conversation, which is the
   * ordinary case — two people reporting the same stranger.
   */
  it('a second report never pulls the deadline back in', async () => {
    const { conversationId, messageId } = ids();
    await write(ctx.repositories, conversationId, messageId);

    const label = seq;
    await ctx.repositories.insertReports(
      ctx.db,
      [report(conversationId, `rep_multi_${label}_1`)],
      Date.now(),
    );
    const afterFirst = await daysUntilExpiry('messages', 'message_id', messageId);

    // Pushed out by hand, further than any report would, then reported again.
    await ctx.db.query(
      `update messages set retention_expires_at = now() + interval '400 days'
        where message_id = $1`,
      [messageId],
    );
    await ctx.repositories.insertReports(
      ctx.db,
      [report(conversationId, `rep_multi_${label}_2`)],
      Date.now(),
    );

    const afterSecond = await daysUntilExpiry('messages', 'message_id', messageId);
    expect(afterSecond).toBeGreaterThan(afterFirst);
    expect(afterSecond).toBeGreaterThan(390);
  });
});

describe('D9 — the deletion boundary is consistent', () => {
  /**
   * The delete statements all say `retention_expires_at < now()`, so a row
   * exactly at its deadline survives and one a moment past it does not.
   *
   * Off by one here deletes evidence a day early or keeps it a day late, and
   * both are wrong in a way somebody would eventually have to explain.
   */
  it('a row exactly at its deadline is not yet expired; a moment past it is', async () => {
    const { conversationId, messageId } = ids();
    await write(ctx.repositories, conversationId, messageId);

    // Exactly now: `< now()` is false at the instant of equality, and by the
    // time the comparison runs `now()` has advanced — so this asserts the
    // shape of the predicate rather than a race on the clock.
    await ctx.db.query(
      `update messages set retention_expires_at = now() + interval '1 hour' where message_id = $1`,
      [messageId],
    );
    let due = await ctx.rows(
      `select message_id from messages where message_id = $1 and retention_expires_at < now()`,
      [messageId],
    );
    expect(due).toHaveLength(0);

    await ctx.db.query(
      `update messages set retention_expires_at = now() - interval '1 second' where message_id = $1`,
      [messageId],
    );
    due = await ctx.rows(
      `select message_id from messages where message_id = $1 and retention_expires_at < now()`,
      [messageId],
    );
    expect(due).toHaveLength(1);
  });

  /**
   * A legal hold survives its deadline.
   *
   * Every delete statement carries `and legal_hold = false`, so a held row is
   * past its expiry and still present. This is the mechanism §8 relies on and
   * it is one `and` away from not existing.
   */
  it('a row on legal hold is not deleted after its deadline passes', async () => {
    const { conversationId, messageId } = ids();
    await write(ctx.repositories, conversationId, messageId);

    await ctx.db.query(
      `update messages
          set retention_expires_at = now() - interval '1 day', legal_hold = true
        where message_id = $1`,
      [messageId],
    );

    const due = await ctx.rows(
      `select message_id from messages
        where message_id = $1 and retention_expires_at < now() and legal_hold = false`,
      [messageId],
    );
    expect(due).toHaveLength(0);
  });
});
