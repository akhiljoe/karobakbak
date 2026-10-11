/**
 * The retention path against a real PostgreSQL: migrations, repositories,
 * retention deadlines, and the write-behind pipeline end to end.
 */
/**
 * Ids come from the real generators, never from `randomUUID`.
 *
 * Fabricated ids are how the schema came to declare `uuid` columns that no id
 * this system produces could satisfy: the tests agreed with the schema and both
 * disagreed with the application. A test that invents its own id format is
 * testing a system nobody runs.
 */
import { newMatchId, newMessageId } from '../../src/util/ids';

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
    conversationId: newMatchId(),
    sessionA: 's_a',
    sessionB: 's_b',
    segment: 'default',
    startedAt: new Date().toISOString(),
    profileA: null,
    profileB: null,
    ...overrides,
  };
}

function message(conversationId: string, overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    kind: 'message',
    messageId: newMessageId(),
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
    reportId: newMessageId(),
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
      'account_credentials',
      'accounts',
      'admin_accounts',
      'admin_audit',
      'admin_sessions',
      'blocks',
      'connection_labels',
      'connections',
      'conversations',
      'enforcement',
      'legal_holds',
      'messages',
      'moderation_events',
      'persona_control',
      'persona_conversations',
      'persona_spend',
      'reports',
      'schema_migrations',
    ]);
  });

  it('indexes the columns the console and the ban reload read by', async () => {
    // Three queries used to scan a whole table each (F-035): the triage queue
    // aggregating flags per report, `openReport` resolving a report's blocks,
    // and the five-minute `reapplyActiveBans` pass. Nothing fails without
    // these — the answers stay correct and only the cost moves — so a later
    // schema change could drop one and no test would notice until a moderator
    // was waiting on a screen that used to be quick.
    const indexes = await ctx.rows<{ indexname: string; indexdef: string }>(
      `select indexname, indexdef from pg_indexes where schemaname = $1`,
      [ctx.schema],
    );
    const byName = new Map(indexes.map((row) => [row.indexname, row.indexdef]));

    expect(byName.has('blocks_conversation_idx')).toBe(true);
    expect(byName.has('moderation_events_conversation_idx')).toBe(true);

    // Partial, and that is the half worth asserting. Without the predicate the
    // index still answers the query and grows with every sanction ever issued,
    // including the revoked ones the pass exists to skip — which is the same
    // slow creep the index was added to remove.
    expect(byName.get('enforcement_active_idx')).toMatch(/where \(revoked_at is null\)/i);
  });

  it('keeps operator credentials out of the chat role', async () => {
    // The chat backend has no reason to read a password hash or a TOTP secret,
    // and a grant here would let a compromised chat process mint itself an
    // operator session and then read every conversation through the audited
    // path — writing plausible audit rows on the way (I11).
    const grants = await ctx.rows<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type from information_schema.role_table_grants
        where grantee = 'karobakbak_app'
          and table_name in ('admin_accounts', 'admin_sessions')`,
    );
    expect(grants).toEqual([]);
  });

  it('leaves the audit log append-only for both roles', async () => {
    // Enforced by the grant rather than by convention: an audit log the writer
    // can rewrite is not evidence of anything.
    const grants = await ctx.rows<{ grantee: string; privilege_type: string }>(
      `select grantee, privilege_type from information_schema.role_table_grants
        where table_name = 'admin_audit'
          and grantee in ('karobakbak_app', 'karobakbak_console')`,
    );
    const privileges = new Set(grants.map((row) => row.privilege_type));
    expect(privileges.has('SELECT')).toBe(true);
    expect(privileges.has('INSERT')).toBe(true);
    expect(privileges.has('UPDATE')).toBe(false);
    expect(privileges.has('DELETE')).toBe(false);
  });

  it('lets only the chat role expire audit rows, and only through the function', async () => {
    // 018_audit_expiry.sql: the deletion worker runs as the chat role, which
    // has no delete on admin_audit (the test above). Expiry goes through a
    // SECURITY DEFINER function instead: callable by the chat role and nobody
    // else, and pinned to this schema so a temporary table cannot stand in for
    // the real one.
    const fn = `${ctx.schema}.expire_admin_audit(integer)`;
    const rows = await ctx.rows<{ app: boolean; console: boolean; public_can: boolean }>(
      `select has_function_privilege('karobakbak_app', $1, 'EXECUTE') as app,
              has_function_privilege('karobakbak_console', $1, 'EXECUTE') as console,
              exists (select 1 from aclexplode((select proacl from pg_proc where oid = $1::regprocedure))
                       where grantee = 0 and privilege_type = 'EXECUTE') as public_can`,
      [fn],
    );
    expect(rows[0]).toEqual({ app: true, console: false, public_can: false });

    const shape = await ctx.rows<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select prosecdef, proconfig from pg_proc where oid = $1::regprocedure`,
      [fn],
    );
    expect(shape[0]?.prosecdef).toBe(true);
    expect(shape[0]?.proconfig).toEqual([`search_path=${ctx.schema}, pg_temp`]);
  });

  it('denies the console the ability to delete retained content', async () => {
    // A console that could delete a conversation could destroy the evidence in
    // the case it was opened for. Deletion belongs to the retention worker,
    // driven by deadlines stamped at insert time (D17).
    const grants = await ctx.rows<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'karobakbak_console'
          and table_name in ('conversations', 'messages')`,
    );
    const privileges = new Set(grants.map((row) => row.privilege_type));
    expect(privileges).toEqual(new Set(['SELECT']));
  });

  it('denies the chat role any way to raise its own spend ceiling (D-AI-7)', async () => {
    // Column-level grants: the persona process must add to the counter, which
    // is the whole mechanism, and must not touch the limit. A process that can
    // raise its own ceiling does not have one.
    const grants = await ctx.rows<{ privilege_type: string; column_name: string | null }>(
      `select privilege_type, column_name
         from information_schema.column_privileges
        where grantee = 'karobakbak_app'
          and table_name = 'persona_spend'
          and privilege_type = 'UPDATE'`,
    );
    const updatable = new Set(grants.map((row) => row.column_name));
    expect(updatable.has('spent_micro_cents')).toBe(true);
    expect(updatable.has('limit_micro_cents')).toBe(false);
  });

  it('lets the chat role update only the account columns a user changes about themselves', async () => {
    // `status` and `risk_state` are moderation decisions (010_accounts.sql) and
    // must stay out of the chat role's reach. The list is exact, so a new grant
    // has to be added here on purpose rather than slipping in with a migration.
    const grants = await ctx.rows<{ column_name: string }>(
      `select column_name
         from information_schema.column_privileges
        where grantee = 'karobakbak_app'
          and table_schema = '${ctx.schema}'
          and table_name = 'accounts'
          and privilege_type = 'UPDATE'`,
    );
    expect(grants.map((row) => row.column_name).sort()).toEqual([
      'external_id',
      'last_active_at',
      'last_seen_at',
      'retention_expires_at',
      'share_presence',
    ]);
  });

  it('keeps spend non-negative and the ceiling positive', async () => {
    await expect(
      ctx.db.query(
        `insert into persona_spend (period, spent_micro_cents, limit_micro_cents)
         values ('2020-01-01', -1, 100)`,
      ),
    ).rejects.toThrow(/persona_spend_non_negative/);

    await expect(
      ctx.db.query(
        `insert into persona_spend (period, spent_micro_cents, limit_micro_cents)
         values ('2020-02-01', 0, 0)`,
      ),
    ).rejects.toThrow(/persona_spend_limit_positive/);
  });

  it('denies the chat role any way to switch personas on (D-AI-9)', async () => {
    // The switch governs a feature that spends money per message. A compromised
    // chat process must not be able to enable it, so the chat role reads and
    // never writes — the mirror image of why the console role can write it: a
    // flip is a moderation action and belongs with the other audited ones.
    const grants = await ctx.rows<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'karobakbak_app'
          and table_name = 'persona_control'`,
    );
    const privileges = new Set(grants.map((row) => row.privilege_type));
    expect(privileges).toEqual(new Set(['SELECT']));
  });

  it('lets the console flip a persona switch but never delete one', async () => {
    // A deleted row is a switch that reverts to "enabled" with no record that
    // it was ever turned off. Revoking is `enabled = true` with a name against
    // it, which is a different and auditable thing.
    const grants = await ctx.rows<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
        where grantee = 'karobakbak_console'
          and table_name = 'persona_control'`,
    );
    const privileges = new Set(grants.map((row) => row.privilege_type));
    expect(privileges.has('SELECT')).toBe(true);
    expect(privileges.has('INSERT')).toBe(true);
    expect(privileges.has('UPDATE')).toBe(true);
    expect(privileges.has('DELETE')).toBe(false);
  });

  it('ships personas disabled, so a migration cannot start spending money', async () => {
    // Turning personas on is a deliberate act with a name attached. If this row
    // shipped enabled, the first deploy that ran the migration would begin
    // paying a model provider with nothing in the audit trail to show who
    // decided that.
    const rows = await ctx.rows<{ enabled: boolean; updated_by: string }>(
      `select enabled, updated_by from persona_control where scope = 'global'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(false);
    expect(rows[0]?.updated_by).toBe('system');
  });

  it('refuses a persona switch row that names an unknown scope or mode', async () => {
    await expect(
      ctx.db.query(
        `insert into persona_control (scope, subject, enabled, updated_by)
         values ('nonsense', 'x', true, 'test')`,
      ),
    ).rejects.toThrow(/persona_control_scope_known/);

    await expect(
      ctx.db.query(
        `insert into persona_control (scope, subject, enabled, mode, updated_by)
         values ('character', 'x', true, 'maybe', 'test')`,
      ),
    ).rejects.toThrow(/persona_control_mode_known/);

    // A global row with a subject would let two "global" switches exist, and
    // whichever was read last would win.
    await expect(
      ctx.db.query(
        `insert into persona_control (scope, subject, enabled, updated_by)
         values ('global', 'oops', true, 'test')`,
      ),
    ).rejects.toThrow(/persona_control_global_has_no_subject/);
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
        [newMessageId(), started.conversationId],
      ),
    ).rejects.toThrow();
  });

  it('constrains moderation actions and severities', async () => {
    await expect(
      ctx.db.query(
        `insert into moderation_events (event_id, rule, action, severity, created_at, retention_expires_at)
         values ($1, 'url', 'delete', 'high', now(), now())`,
        [newMessageId()],
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
        blockId: newMessageId(),
        blockerKey: 'a'.repeat(32),
        blockedKey: 'b'.repeat(32),
        dimension: 'ip',
      blockerAccountId: null,
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
