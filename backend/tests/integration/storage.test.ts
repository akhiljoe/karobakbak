/**
 * The retention path against a real PostgreSQL: migrations, repositories,
 * retention deadlines, and the write-behind pipeline end to end.
 */
import { randomUUID } from 'node:crypto';

import { createPostgresContext, type PostgresContext } from '../helpers/postgres';
import { loadMigrations, migrate } from '../../src/storage/migrate';
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
  await ctx.close();
});

afterEach(async () => {
  await ctx.db.query(
    'truncate conversations, messages, reports, blocks, moderation_events, admin_audit, enforcement cascade',
  );
});

function conversation(overrides: Partial<ConversationStartedRecord> = {}): ConversationStartedRecord {
  return {
    kind: 'conversation_started',
    conversationId: randomUUID(),
    sessionA: 's_a',
    sessionB: 's_b',
    segment: 'default',
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

function message(conversationId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    kind: 'message',
    messageId: randomUUID(),
    conversationId,
    senderSessionId: 's_a',
    serverTimestamp: new Date().toISOString(),
    type: 'text',
    body: 'hello there',
    moderationAction: 'allow',
    moderationFlags: [],
    ...overrides,
  };
}

function report(conversationId: string, overrides: Partial<ReportRecord> = {}): ReportRecord {
  return {
    kind: 'report',
    reportId: randomUUID(),
    conversationId,
    reporterSessionId: 's_a',
    reportedSessionId: 's_b',
    category: 'harassment',
    note: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('migrations', () => {
  it('are applied once and are safe to re-run', async () => {
    const applied = await ctx.rows<{ name: string }>('select name from schema_migrations order by name');
    expect(applied.map((row) => row.name)).toEqual(loadMigrations().map((m) => m.name));

    // Re-running must be a no-op: a deploy that retries a migration step is
    // ordinary, and a failure there blocks the release.
    const result = await migrate(ctx.db, ctx.logger);
    expect(result.applied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
  });

  it('creates every table the design names', async () => {
    const tables = await ctx.rows<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = $1`,
      [ctx.schema],
    );
    expect(tables.map((row) => row.table_name).sort()).toEqual([
      'admin_audit',
      'blocks',
      'conversations',
      'enforcement',
      'messages',
      'moderation_events',
      'reports',
      'schema_migrations',
    ]);
  });

  it('constrains the content type to what the application implements (§23.3)', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    // A bug or a direct database write must not introduce a type the code
    // cannot render or moderate.
    await expect(
      ctx.db.query(
        `insert into messages (message_id, conversation_id, sender_session_id, server_timestamp,
                               type, body, char_length, retention_expires_at)
         values ($1, $2, 's_a', now(), 'image', 'x', 1, now())`,
        [randomUUID(), started.conversationId],
      ),
    ).rejects.toThrow();
  });

  it('constrains moderation actions and severities', async () => {
    await expect(
      ctx.db.query(
        `insert into moderation_events (event_id, rule, action, severity, created_at, retention_expires_at)
         values ($1, 'url', 'delete', 'high', now(), now())`,
        [randomUUID()],
      ),
    ).rejects.toThrow();
  });
});

describe('repositories', () => {
  it('writes a conversation and its messages', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    await ctx.repositories.insertMessages(
      ctx.db,
      [message(started.conversationId), message(started.conversationId)],
      Date.now(),
    );

    expect(await ctx.count('conversations')).toBe(1);
    expect(await ctx.count('messages')).toBe(2);
  });

  it('stores the body as plaintext and its length beside it', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    await ctx.repositories.insertMessages(
      ctx.db,
      [message(started.conversationId, { body: 'héllo 👋' })],
      Date.now(),
    );

    const rows = await ctx.rows<{ body: string; char_length: number }>(
      'select body, char_length from messages',
    );
    expect(rows[0]?.body).toBe('héllo 👋');
    // Counted in code points, so telemetry never needs to read the body.
    expect(rows[0]?.char_length).toBe(7);
  });

  it('stamps the retention deadline at insert time, from configuration (D17)', async () => {
    const started = conversation();
    const now = Date.now();
    await ctx.repositories.insertConversations(ctx.db, [started], now);

    const rows = await ctx.rows<{ retention_expires_at: Date }>(
      'select retention_expires_at from conversations',
    );
    const expected = now + ctx.config.retention.days.conversation * 24 * 3600 * 1000;
    // Within a second: the deadline comes from the application clock and the
    // configured period, never from a database default that a later config
    // change could reinterpret.
    expect(Math.abs(rows[0]!.retention_expires_at.getTime() - expected)).toBeLessThan(1000);
  });

  it('is idempotent on a replayed batch', async () => {
    const started = conversation();
    const msg = message(started.conversationId);
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    await ctx.repositories.insertMessages(ctx.db, [msg], Date.now());
    // A batch retried after an ambiguous failure must not double-write.
    await ctx.repositories.insertMessages(ctx.db, [msg], Date.now());
    expect(await ctx.count('messages')).toBe(1);
  });

  it('closes a conversation once, keeping the first reason', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    await ctx.repositories.updateConversations(ctx.db, [
      {
        kind: 'conversation_ended',
        conversationId: started.conversationId,
        endedAt: new Date().toISOString(),
        endReason: 'skip',
      },
    ]);
    await ctx.repositories.updateConversations(ctx.db, [
      {
        kind: 'conversation_ended',
        conversationId: started.conversationId,
        endedAt: new Date().toISOString(),
        endReason: 'disconnect',
      },
    ]);

    const rows = await ctx.rows<{ end_reason: string }>('select end_reason from conversations');
    // The winner of the termination race wrote it (D6); a later arrival must
    // not rewrite history.
    expect(rows[0]?.end_reason).toBe('skip');
  });

  it('extends the conversation and its messages when a report arrives', async () => {
    const started = conversation();
    const now = Date.now();
    await ctx.repositories.insertConversations(ctx.db, [started], now);
    await ctx.repositories.insertMessages(ctx.db, [message(started.conversationId)], now);
    await ctx.repositories.insertReports(ctx.db, [report(started.conversationId)], now);

    const conversationExpiry = (
      await ctx.rows<{ retention_expires_at: Date }>('select retention_expires_at from conversations')
    )[0]!.retention_expires_at.getTime();
    const messageExpiry = (
      await ctx.rows<{ retention_expires_at: Date }>('select retention_expires_at from messages')
    )[0]!.retention_expires_at.getTime();

    const reportedDeadline = now + ctx.config.retention.days.reported * 24 * 3600 * 1000;
    expect(Math.abs(conversationExpiry - reportedDeadline)).toBeLessThan(1000);
    expect(Math.abs(messageExpiry - reportedDeadline)).toBeLessThan(1000);
  });

  it('never shortens a deadline another report already extended', async () => {
    const started = conversation();
    const now = Date.now();
    await ctx.repositories.insertConversations(ctx.db, [started], now);
    await ctx.repositories.insertReports(ctx.db, [report(started.conversationId)], now);
    // A second report a day later must not pull the deadline back in.
    await ctx.repositories.insertReports(
      ctx.db,
      [report(started.conversationId)],
      now - 24 * 3600 * 1000,
    );

    const expiry = (
      await ctx.rows<{ retention_expires_at: Date }>('select retention_expires_at from conversations')
    )[0]!.retention_expires_at.getTime();
    expect(expiry).toBeGreaterThanOrEqual(now + ctx.config.retention.days.reported * 24 * 3600 * 1000 - 1000);
  });

  it('stores a report note as ordinary text and a block as hashes only', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    await ctx.repositories.insertReports(
      ctx.db,
      [report(started.conversationId, { note: "they wouldn't stop" })],
      Date.now(),
    );
    await ctx.repositories.insertBlocks(ctx.db, [
      {
        kind: 'block',
        blockId: randomUUID(),
        blockerKey: 'a'.repeat(32),
        blockedKey: 'b'.repeat(32),
        dimension: 'ip',
        conversationId: started.conversationId,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ]);

    expect((await ctx.rows<{ note: string }>('select note from reports'))[0]?.note).toBe(
      "they wouldn't stop",
    );
    const blocks = await ctx.rows<{ blocker_key: string }>('select blocker_key from blocks');
    // Salted hashes only: no addresses, no user agents, no fingerprints.
    expect(blocks[0]?.blocker_key).toMatch(/^[a-f0-9]{32}$/);
  });

  it('stores moderation flags as rule ids, never as excerpts', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    await ctx.repositories.insertMessages(
      ctx.db,
      [
        message(started.conversationId, {
          body: 'reach me at CANARY@example.com',
          moderationAction: 'flag',
          moderationFlags: ['email', 'contact_solicitation'],
        }),
      ],
      Date.now(),
    );

    const rows = await ctx.rows<{ moderation_flags: string[] }>(
      'select moderation_flags from messages',
    );
    expect(rows[0]?.moderation_flags).toEqual(['email', 'contact_solicitation']);
    expect(JSON.stringify(rows[0]?.moderation_flags)).not.toContain('CANARY');
  });

  it('treats a message body as data, never as SQL', async () => {
    const started = conversation();
    await ctx.repositories.insertConversations(ctx.db, [started], Date.now());
    const hostile = "'); drop table messages; --";
    await ctx.repositories.insertMessages(
      ctx.db,
      [message(started.conversationId, { body: hostile })],
      Date.now(),
    );

    expect((await ctx.rows<{ body: string }>('select body from messages'))[0]?.body).toBe(hostile);
    expect(await ctx.count('messages')).toBe(1);
  });

  it('writes a mixed batch in one transaction', async () => {
    const started = conversation();
    const writer = ctx.writer();
    writer.enqueue(started);
    writer.enqueue(message(started.conversationId));
    writer.enqueue(report(started.conversationId));
    await writer.flush();

    // Conversations are inserted before the rows that reference them, so the
    // foreign keys hold without the caller sequencing anything.
    expect(await ctx.count('conversations')).toBe(1);
    expect(await ctx.count('messages')).toBe(1);
    expect(await ctx.count('reports')).toBe(1);
  });
});
