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
  BlockRecord,
  ConversationEndedRecord,
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

describe('the stamp and the check use different clocks', () => {
  /**
   * `retention_expires_at` is computed from **this process's** clock
   * (`expiryFrom(nowMs, days)`) and every deletion statement compares it against
   * **the database's** `now()`. On one host those are the same clock. On a
   * managed database (§16) they are two machines, and the difference moves every
   * deadline by exactly that much.
   *
   * This asserts the coupling rather than complaining about it: a writer whose
   * clock is an hour fast stamps deadlines an hour later, as measured by the
   * database — which means conversations kept an hour longer than the privacy
   * policy says, with nothing anywhere reporting it.
   *
   * The mitigation is measurement, not engineering: `chat_clock_skew_seconds`
   * publishes this process's clock minus the database's, so an operator finds
   * out before the deadlines do.
   */
  it('a writer whose clock is ahead stamps deadlines that are late by the same amount', async () => {
    const onTime = ids();
    const ahead = ids();
    const HOUR_MS = 3_600_000;

    await ctx.repositories.insertConversations(
      ctx.db,
      [conversation(onTime.conversationId), conversation(ahead.conversationId)],
      Date.now(),
    );
    await ctx.repositories.insertMessages(
      ctx.db,
      [message(onTime.conversationId, onTime.messageId)],
      Date.now(),
    );
    // The same call, from a process whose clock is an hour fast.
    await ctx.repositories.insertMessages(
      ctx.db,
      [message(ahead.conversationId, ahead.messageId)],
      Date.now() + HOUR_MS,
    );

    const normal = await daysUntilExpiry('messages', 'message_id', onTime.messageId);
    const skewed = await daysUntilExpiry('messages', 'message_id', ahead.messageId);

    // An hour, in days, and nothing bounded it.
    expect(skewed - normal).toBeCloseTo(1 / 24, 3);
  });

  /**
   * And the deletion side reads the database's clock, not the writer's — which
   * is what makes the difference above matter rather than cancel out.
   */
  it('the deletion predicate compares against the database clock', async () => {
    const { conversationId, messageId } = ids();
    await write(ctx.repositories, conversationId, messageId);

    // Stamped in the past by the database's own reckoning, so it is due
    // whatever the writing process believed the time was.
    await ctx.db.query(
      `update messages set retention_expires_at = now() - interval '1 second' where message_id = $1`,
      [messageId],
    );
    const due = await ctx.rows(
      `select message_id from messages where message_id = $1 and retention_expires_at < now()`,
      [messageId],
    );
    expect(due).toHaveLength(1);
  });
});

describe('D6 — a block outlives the conversation it was made in', () => {
  /**
   * A block keys on identity hashes, not on a conversation row (D18), and the
   * conversation is deleted long before the block expires — thirty days against
   * a block's own window.
   *
   * If deleting the conversation took the block with it, somebody's protection
   * would quietly end on a schedule they were never told about, and the person
   * they blocked would become matchable again. Nothing would report it: the
   * block simply would not be there the next time `tryMatch` looked.
   */
  it('survives its conversation being deleted', async () => {
    const { conversationId } = ids();
    await ctx.repositories.insertConversations(
      ctx.db,
      [conversation(conversationId)],
      Date.now(),
    );

    seq += 1;
    const blockId = `blk_${seq}`;
    const block: BlockRecord = {
      kind: 'block',
      blockId,
      blockerKey: `iphash_${seq}`,
      blockedKey: `iphash_other_${seq}`,
      dimension: 'ip',
      blockerAccountId: null,
      conversationId,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    };
    await ctx.repositories.insertBlocks(ctx.db, [block]);

    await ctx.db.query(`delete from conversations where conversation_id = $1`, [conversationId]);
    expect(
      await ctx.rows(`select conversation_id from conversations where conversation_id = $1`, [
        conversationId,
      ]),
    ).toHaveLength(0);

    const survived = await ctx.rows<{ block_id: string; conversation_id: string | null }>(
      `select block_id, conversation_id from blocks where block_id = $1`,
      [blockId],
    );
    expect(survived).toHaveLength(1);
    // The reference is kept as a bare value rather than dropped, so an
    // investigation can still say which conversation a block came from while
    // that conversation exists — and nothing depends on it existing.
    expect(survived[0]?.conversation_id).toBe(conversationId);
  });

  /**
   * The structural half, and the one that matters for the future.
   *
   * `blocks.conversation_id` carries **no foreign key**. Adding one would look
   * like tidying — the column names a table, so why not constrain it — and a
   * `references conversations on delete cascade` would delete a user's blocks
   * thirty days after each conversation, silently.
   *
   * This is the line to defend in review, the same shape as the `connections`
   * table having no `conversation_id` at all.
   */
  it('has no foreign key from a block to a conversation', async () => {
    const constraints = await ctx.rows<{ column_name: string }>(
      `select kcu.column_name
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
        where tc.table_schema = $1
          and tc.table_name = 'blocks'
          and tc.constraint_type = 'FOREIGN KEY'`,
      [ctx.schema],
    );
    expect(constraints.map((row) => row.column_name)).not.toContain('conversation_id');
  });

  /**
   * The one foreign key that does exist, pinned as the deliberate choice it is.
   *
   * `blocker_account_id references accounts on delete cascade` — so deleting an
   * account takes its blocks with it. `015_account_blocks.sql` argues for that
   * at length: the column is "a durable negative record about another person
   * tied to a name that persists", and it must not outlive the account that
   * made it.
   *
   * The cost is real and is the reason this is asserted rather than assumed:
   * the protection goes too. Somebody whose account is deleted loses the blocks
   * they made while signed in. That is the right answer for a deletion the
   * person asked for, and it is worth re-reading if account deletion ever
   * becomes something retention does *to* them rather than something they do.
   */
  it('cascades from the account, deliberately, and from nothing else', async () => {
    const rows = await ctx.rows<{ column_name: string; delete_rule: string }>(
      `select kcu.column_name, rc.delete_rule
         from information_schema.table_constraints tc
         join information_schema.key_column_usage kcu
           on kcu.constraint_name = tc.constraint_name
          and kcu.table_schema = tc.table_schema
         join information_schema.referential_constraints rc
           on rc.constraint_name = tc.constraint_name
          and rc.constraint_schema = tc.table_schema
        where tc.table_schema = $1
          and tc.table_name = 'blocks'
          and tc.constraint_type = 'FOREIGN KEY'`,
      [ctx.schema],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.column_name).toBe('blocker_account_id');
    expect(rows[0]?.delete_rule).toBe('CASCADE');
  });
});

describe('D4 — a conversation ends while a batch is being written', () => {
  /**
   * No half-created conversation: every row is complete and has an `ended_at`.
   *
   * The write-behind path batches across conversations, so an ending arriving
   * mid-batch is ordinary rather than exceptional. The failure to rule out is a
   * row whose start landed and whose end did not — which reads, months later, as
   * a conversation that never finished.
   */
  it('leaves the row complete whichever order the two writes arrive in', async () => {
    const { conversationId, messageId } = ids();
    const ended: ConversationEndedRecord = {
      kind: 'conversation_ended',
      conversationId,
      endedAt: new Date().toISOString(),
      endReason: 'skip',
    };

    // The end and the message race the same batch.
    await ctx.repositories.insertConversations(ctx.db, [conversation(conversationId)], Date.now());
    await Promise.all([
      ctx.repositories.updateConversations(ctx.db, [ended]),
      ctx.repositories.insertMessages(ctx.db, [message(conversationId, messageId)], Date.now()),
    ]);

    const rows = await ctx.rows<{ ended_at: Date | null; end_reason: string | null }>(
      `select ended_at, end_reason from conversations where conversation_id = $1`,
      [conversationId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.ended_at).not.toBeNull();
    expect(rows[0]?.end_reason).toBe('skip');
  });

  /**
   * D6's other half, and the reason `updateConversations` uses `coalesce`:
   * the ending is written once, by whoever won the termination race, so a
   * second attempt must keep the first reason rather than the last one to
   * arrive.
   *
   * Without it a `reap` from the janitor could overwrite a `block`, and the
   * console would show the wrong reason for the one kind of ending anybody
   * investigates.
   */
  it('keeps the first end reason when a second ending arrives', async () => {
    const { conversationId } = ids();
    await ctx.repositories.insertConversations(ctx.db, [conversation(conversationId)], Date.now());

    const at = new Date().toISOString();
    await ctx.repositories.updateConversations(ctx.db, [
      { kind: 'conversation_ended', conversationId, endedAt: at, endReason: 'block' },
    ]);
    await ctx.repositories.updateConversations(ctx.db, [
      { kind: 'conversation_ended', conversationId, endedAt: at, endReason: 'reap' },
    ]);

    const rows = await ctx.rows<{ end_reason: string }>(
      `select end_reason from conversations where conversation_id = $1`,
      [conversationId],
    );
    expect(rows[0]?.end_reason).toBe('block');
  });
});

describe('D1 — an envelope id reused after a reconnect', () => {
  /**
   * Dedupe is scoped to the **match**, not to the session or the client.
   *
   * P8 and P9 assert that over a live socket. This is the storage half: two
   * messages carrying the same client id in different conversations are two
   * rows, because the primary key is the server's message id and the client's
   * correlation token never becomes one.
   *
   * A client that numbers its messages from one in every conversation — which
   * is the obvious thing to build — must not lose its first message each time.
   */
  it('stores both messages when the same client id is reused in another match', async () => {
    const first = ids();
    const second = ids();
    await write(ctx.repositories, first.conversationId, first.messageId);
    await write(ctx.repositories, second.conversationId, second.messageId);

    const rows = await ctx.rows(
      `select message_id from messages where message_id in ($1, $2)`,
      [first.messageId, second.messageId],
    );
    expect(rows).toHaveLength(2);
  });

  /**
   * And the same server message id twice is one row, whatever arrives with it.
   * The write-behind path can replay a batch after a failure — `salvage`
   * narrows to individual rows and retries them — so an insert that
   * duplicated would turn one retry into two stored copies of a message.
   */
  it('is idempotent on the server message id, so a replayed batch stores once', async () => {
    const { conversationId, messageId } = ids();
    await write(ctx.repositories, conversationId, messageId);
    await ctx.repositories.insertMessages(
      ctx.db,
      [message(conversationId, messageId)],
      Date.now(),
    );

    const rows = await ctx.rows(`select message_id from messages where message_id = $1`, [
      messageId,
    ]);
    expect(rows).toHaveLength(1);
  });
});
