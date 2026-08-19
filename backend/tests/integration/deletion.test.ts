/**
 * Retention enforcement (§15, I9, I10): expiry deletes, holds protect, and the
 * cascade cannot defeat a hold.
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
import { DeletionWorker, type DeletionLock } from '../../src/storage/deletion';
import { LegalHolds } from '../../src/storage/holds';
import { BackupMonitor } from '../../src/storage/backup';
import { createNullLogger } from '../../src/logger';
import type { QueuedRecord } from '../../src/storage/records';

let ctx: PostgresContext;
let holds: LegalHolds;

/** A lock that is always free, unless a test says otherwise. */
class FakeLock implements DeletionLock {
  granted = true;
  calls = 0;

  async acquireDeletionLock(): Promise<boolean> {
    this.calls += 1;
    return this.granted;
  }
}

function worker(lock: DeletionLock, overrides: Record<string, string> = {}): DeletionWorker {
  const config =
    Object.keys(overrides).length === 0
      ? ctx.config
      : { ...ctx.config, deletion: { ...ctx.config.deletion, ...toDeletion(overrides) } };
  return new DeletionWorker(config, createNullLogger(), ctx.db, lock);
}

function toDeletion(overrides: Record<string, string>): { batch?: number } {
  return overrides.batch === undefined ? {} : { batch: Number(overrides.batch) };
}

/** Insert a conversation with an explicit expiry, plus messages sharing it. */
async function seed(options: {
  expired: boolean;
  messages?: number;
  messageExpired?: boolean;
}): Promise<{ conversationId: string; messageIds: string[] }> {
  const conversationId = newMatchId();
  const expiry = options.expired ? "now() - interval '1 day'" : "now() + interval '30 days'";
  await ctx.db.query(
    `insert into conversations
       (conversation_id, session_a, session_b, segment, started_at, retention_expires_at)
     values ($1, 's_a', 's_b', 'default', now(), ${expiry})`,
    [conversationId],
  );

  const messageIds: string[] = [];
  const messageExpiry =
    (options.messageExpired ?? options.expired)
      ? "now() - interval '1 day'"
      : "now() + interval '30 days'";
  for (let i = 0; i < (options.messages ?? 0); i += 1) {
    const messageId = newMessageId();
    messageIds.push(messageId);
    await ctx.db.query(
      `insert into messages
         (message_id, conversation_id, sender_session_id, server_timestamp, type, body,
          char_length, retention_expires_at)
       values ($1, $2, 's_a', now(), 'text', 'hello', 5, ${messageExpiry})`,
      [messageId, conversationId],
    );
  }
  return { conversationId, messageIds };
}

beforeAll(async () => {
  ctx = await createPostgresContext();
  holds = new LegalHolds(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

afterEach(async () => {
  await ctx.db.query(
    'truncate conversations, messages, reports, moderation_events, enforcement, admin_audit, legal_holds cascade',
  );
});

describe('expiry is enforced (I10)', () => {
  it('deletes a conversation past its deadline, with its messages', async () => {
    const { conversationId } = await seed({ expired: true, messages: 3 });
    await worker(new FakeLock()).runUntilDrained();

    expect(await ctx.count('conversations')).toBe(0);
    expect(await ctx.count('messages')).toBe(0);
    void conversationId;
  });

  it('leaves data that is still within retention', async () => {
    await seed({ expired: false, messages: 2 });
    const deleted = await worker(new FakeLock()).runUntilDrained();

    expect(deleted.conversations).toBe(0);
    expect(await ctx.count('messages')).toBe(2);
  });

  it('deletes a message whose own deadline passed inside a live conversation', async () => {
    await seed({ expired: false, messages: 2, messageExpired: true });
    await worker(new FakeLock()).runUntilDrained();

    // The message deadline is its own, and a conversation still in retention
    // does not extend it.
    expect(await ctx.count('messages')).toBe(0);
    expect(await ctx.count('conversations')).toBe(1);
  });

  it('deletes expired reports, moderation events, enforcement and audit rows', async () => {
    const { conversationId } = await seed({ expired: false });
    await ctx.db.query(
      `insert into reports (report_id, conversation_id, reporter_session_id, reported_session_id,
                            category, created_at, retention_expires_at)
       values ($1, $2, 's_a', 's_b', 'spam', now(), now() - interval '1 day')`,
      [newMessageId(), conversationId],
    );
    await ctx.db.query(
      `insert into moderation_events (event_id, rule, action, severity, created_at, retention_expires_at)
       values ($1, 'url', 'flag', 'medium', now(), now() - interval '1 day')`,
      [newMessageId()],
    );
    await ctx.db.query(
      `insert into enforcement (enforcement_id, subject_key, action, reason, source, created_at, retention_expires_at)
       values ($1, 'abc', 'warn', 'spam', 'automated', now(), now() - interval '1 day')`,
      [newMessageId()],
    );
    await ctx.db.query(
      `insert into admin_audit (audit_id, actor, role, action, subject_type, subject_id,
                                justification, created_at, retention_expires_at)
       values ($1, 'op', 'operator', 'viewed', 'conversation', $2, 'case work', now(),
               now() - interval '1 day')`,
      [newMessageId(), conversationId],
    );

    const deleted = await worker(new FakeLock()).runUntilDrained();
    expect(deleted).toMatchObject({
      reports: 1,
      moderationEvents: 1,
      enforcement: 1,
      adminAudit: 1,
    });
    // The audit log expires on its own, much longer period. An append-only log
    // that is never trimmed is just an unbounded one.
    expect(await ctx.count('admin_audit')).toBe(0);
  });

  it('works in batches and reports that more remains', async () => {
    for (let i = 0; i < 5; i += 1) await seed({ expired: true });
    const batched = worker(new FakeLock(), { batch: '2' });

    const first = await batched.runPass();
    expect(first.deleted.conversations).toBe(2);
    expect(first.more).toBe(true);

    await batched.runUntilDrained();
    expect(await ctx.count('conversations')).toBe(0);
  });

  it('counts what it deleted, cumulatively', async () => {
    await seed({ expired: true, messages: 2 });
    const instance = worker(new FakeLock());
    await instance.runUntilDrained();
    expect(instance.totals.messages).toBe(2);
    expect(instance.totals.conversations).toBe(1);
    expect(instance.failures).toBe(0);
    expect(instance.lastSuccessMs).not.toBeNull();
  });

  it('does nothing when another instance holds the lock', async () => {
    await seed({ expired: true, messages: 1 });
    const lock = new FakeLock();
    lock.granted = false;

    const result = await worker(lock).runPass();
    expect(result.ran).toBe(false);
    // Several instances deleting the same batches would be harmless but would
    // multiply load on a database doing deliberately unhurried work.
    expect(await ctx.count('conversations')).toBe(1);
  });

  it('records a failure and alerts rather than throwing', async () => {
    const failing = new DeletionWorker(
      ctx.config,
      createNullLogger(),
      {
        ...ctx.db,
        query: async () => {
          throw new Error('connection terminated');
        },
      },
      new FakeLock(),
    );

    // I10: a failed pass raises an alert. It never takes down a process that
    // is otherwise serving chat.
    await expect(failing.runPass()).resolves.toMatchObject({ ran: true });
    expect(failing.failures).toBe(1);
  });
});

describe('legal holds protect data (§15)', () => {
  it('suspends deletion of a held conversation', async () => {
    const { conversationId } = await seed({ expired: true, messages: 2 });
    const placed = await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-1',
      owner: 'trust-and-safety',
      justification: 'ongoing investigation',
    });
    expect(placed.applied).toBe(true);

    await worker(new FakeLock()).runUntilDrained();
    expect(await ctx.count('conversations')).toBe(1);
  });

  it('protects a held message from its parent expiring underneath it', async () => {
    const { conversationId, messageIds } = await seed({ expired: true, messages: 3 });
    await holds.place({
      subjectType: 'message',
      subjectId: messageIds[0]!,
      caseId: 'CASE-2',
      owner: 'trust-and-safety',
      justification: 'evidence',
    });

    await worker(new FakeLock()).runUntilDrained();

    // The cascade would have taken the held message with its conversation.
    // That is exactly the failure a hold exists to prevent.
    expect(await ctx.count('messages')).toBe(1);
    expect(await ctx.count('conversations')).toBe(1);
    const rows = await ctx.rows<{ message_id: string }>('select message_id from messages');
    expect(rows[0]?.message_id).toBe(messageIds[0]);
    void conversationId;
  });

  it('protects a conversation while a held report references it', async () => {
    const { conversationId } = await seed({ expired: true });
    const reportId = newMessageId();
    await ctx.db.query(
      `insert into reports (report_id, conversation_id, reporter_session_id, reported_session_id,
                            category, created_at, retention_expires_at)
       values ($1, $2, 's_a', 's_b', 'threats', now(), now() - interval '1 day')`,
      [reportId, conversationId],
    );
    await holds.place({
      subjectType: 'report',
      subjectId: reportId,
      caseId: 'CASE-3',
      owner: 'legal',
      justification: 'preservation request',
    });

    await worker(new FakeLock()).runUntilDrained();
    expect(await ctx.count('reports')).toBe(1);
    expect(await ctx.count('conversations')).toBe(1);
  });

  it('records who placed it, under what case, and why', async () => {
    const { conversationId } = await seed({ expired: false });
    await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-4',
      owner: 'alice@example.test',
      justification: 'court order 12345',
    });

    const rows = await ctx.rows<{ owner: string; case_id: string; justification: string }>(
      'select owner, case_id, justification from legal_holds',
    );
    // A hold nobody can attribute is how "retain everything forever" starts.
    expect(rows[0]).toMatchObject({
      owner: 'alice@example.test',
      case_id: 'CASE-4',
      justification: 'court order 12345',
    });

    const audit = await ctx.rows<{ action: string; justification: string }>(
      'select action, justification from admin_audit',
    );
    expect(audit[0]).toMatchObject({ action: 'placed_legal_hold', justification: 'court order 12345' });
  });

  it('restores the normal expiry when released', async () => {
    const { conversationId } = await seed({ expired: true });
    const placed = await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-5',
      owner: 'legal',
      justification: 'hold',
    });
    await worker(new FakeLock()).runUntilDrained();
    expect(await ctx.count('conversations')).toBe(1);

    expect(await holds.release(placed.holdId, 'legal', 'case closed')).toBe(true);
    await worker(new FakeLock()).runUntilDrained();

    // There is no "retain forever because someone might ask" path: releasing
    // puts the data back on its ordinary deadline.
    expect(await ctx.count('conversations')).toBe(0);
  });

  it('keeps the released hold row, because the record outlives the hold', async () => {
    const { conversationId } = await seed({ expired: false });
    const placed = await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-6',
      owner: 'legal',
      justification: 'hold',
    });
    await holds.release(placed.holdId, 'auditor', 'no longer required');

    const rows = await ctx.rows<{ released_by: string; released_at: Date }>(
      'select released_by, released_at from legal_holds',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.released_by).toBe('auditor');
    expect(rows[0]?.released_at).not.toBeNull();
  });

  it('keeps the flag while any other hold is still open', async () => {
    const { conversationId } = await seed({ expired: true });
    const first = await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-7a',
      owner: 'legal',
      justification: 'one',
    });
    await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-7b',
      owner: 'trust-and-safety',
      justification: 'two',
    });

    await holds.release(first.holdId, 'legal', 'case closed');
    await worker(new FakeLock()).runUntilDrained();

    // Two cases can hold the same conversation; releasing one must not free
    // data the other still needs.
    expect(await ctx.count('conversations')).toBe(1);
    expect(await holds.active('conversation', conversationId)).toBe(1);
  });

  it('holds nothing when the subject does not exist', async () => {
    const result = await holds.place({
      subjectType: 'conversation',
      subjectId: newMatchId(),
      caseId: 'CASE-8',
      owner: 'legal',
      justification: 'typo in the id',
    });
    // A hold row that suspends nothing would mislead whoever reviews the case.
    expect(result.applied).toBe(false);
    expect(await ctx.count('legal_holds')).toBe(0);
  });

  it('refuses to release a hold twice', async () => {
    const { conversationId } = await seed({ expired: false });
    const placed = await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-9',
      owner: 'legal',
      justification: 'hold',
    });
    expect(await holds.release(placed.holdId, 'legal', 'done')).toBe(true);
    expect(await holds.release(placed.holdId, 'legal', 'done again')).toBe(false);
  });
});

describe('report-triggered extension survives a deletion pass', () => {
  it('keeps a reported conversation past the ordinary deadline', async () => {
    const conversationId = newMatchId();
    const now = Date.now();
    await ctx.repositories.insertConversations(
      ctx.db,
      [
        {
          kind: 'conversation_started',
          conversationId,
          sessionA: 's_a',
          sessionB: 's_b',
          segment: 'default',
          startedAt: new Date().toISOString(),
        },
      ],
      // Stamped as if written a month ago, so the ordinary deadline has passed.
      now - ctx.config.retention.days.conversation * 24 * 3600 * 1000 - 1000,
    );
    await ctx.repositories.insertReports(
      ctx.db,
      [
        {
          kind: 'report',
          reportId: newMessageId(),
          conversationId,
          reporterSessionId: 's_a',
          reportedSessionId: 's_b',
          category: 'threats',
          note: null,
          createdAt: new Date().toISOString(),
        },
      ],
      now,
    );

    await worker(new FakeLock()).runUntilDrained();
    // The report extended it to the reported period, and the worker honours
    // the stamp rather than recomputing anything (D17).
    expect(await ctx.count('conversations')).toBe(1);
  });
});

describe('§10.19 — the deletion worker racing a report', () => {
  /** A conversation whose ordinary deadline has already passed. */
  async function expiredConversation(): Promise<string> {
    const conversationId = newMatchId();
    await ctx.repositories.insertConversations(
      ctx.db,
      [
        {
          kind: 'conversation_started',
          conversationId,
          sessionA: 's_a',
          sessionB: 's_b',
          segment: 'default',
          startedAt: new Date().toISOString(),
        },
      ],
      Date.now() - ctx.config.retention.days.conversation * 24 * 3600 * 1000 - 1000,
    );
    return conversationId;
  }

  function reportFor(conversationId: string): QueuedRecord {
    return {
      priority: 'p0',
      sessionId: 's_a',
      enqueuedAtMs: Date.now(),
      record: {
        kind: 'report',
        reportId: newMessageId(),
        conversationId,
        reporterSessionId: 's_a',
        reportedSessionId: 's_b',
        category: 'threats',
        note: null,
        createdAt: new Date().toISOString(),
      },
    };
  }

  it('never leaves a report stored against a conversation the pass removed', async () => {
    for (let round = 0; round < 10; round += 1) {
      const conversationId = await expiredConversation();

      // The two orderings §10.19 argues about, fired at each other rather than
      // reasoned about. The report's extension is in the same transaction as
      // its insert, so there is no instant where the report is committed and
      // the conversation is still selectable for deletion.
      const [written] = await Promise.allSettled([
        ctx.repositories.writeBatch(ctx.db, [reportFor(conversationId)]),
        worker(new FakeLock()).runUntilDrained(),
      ]);

      const conversations = await ctx.count('conversations');
      const reports = await ctx.count('reports');

      if (written.status === 'rejected') {
        // The pass committed first: the insert lost its foreign key. That is a
        // rejection, not an outage — the conversation is gone and nothing
        // references it.
        expect(conversations).toBe(0);
        expect(reports).toBe(0);
      } else {
        // The report committed, so the conversation it references must still
        // be here, and re-protected rather than merely lucky.
        expect(reports).toBe(1);
        expect(conversations).toBe(1);
        const { rows } = await ctx.db.query<{ expired: boolean }>(
          'select retention_expires_at < now() as expired from conversations where conversation_id = $1',
          [conversationId],
        );
        expect(rows[0]?.expired).toBe(false);
      }

      await ctx.db.query('truncate conversations, messages, reports cascade');
    }
  });

  it('rejects a report for a conversation the pass already collected', async () => {
    const conversationId = await expiredConversation();
    expect((await worker(new FakeLock()).runUntilDrained()).conversations).toBe(1);

    // The other ordering, forced rather than waited for. The foreign key
    // refuses the report: a rejection proves the database is available, so the
    // pipeline discards the record instead of opening the breaker (§14.5).
    await expect(ctx.repositories.writeBatch(ctx.db, [reportFor(conversationId)])).rejects.toMatchObject(
      { code: '23503' },
    );
    expect(await ctx.count('reports')).toBe(0);
    expect(await ctx.count('conversations')).toBe(0);
  });

  it('re-protects before the next pass, not eventually', async () => {
    const conversationId = await expiredConversation();

    // Pass one is prevented from running by the lock, standing in for another
    // instance holding it — the conversation is past its deadline and simply
    // waiting to be collected.
    const held = new FakeLock();
    held.granted = false;
    expect(await worker(held).runPass()).toMatchObject({ ran: false });

    await ctx.repositories.writeBatch(ctx.db, [reportFor(conversationId)]);

    // The very next pass, with the lock free, must already see the extension.
    const deleted = await worker(new FakeLock()).runUntilDrained();
    expect(deleted.conversations).toBe(0);
    expect(await ctx.count('conversations')).toBe(1);
    expect(await ctx.count('reports')).toBe(1);
  });

  it('is idempotent: repeated passes over the same protected row change nothing', async () => {
    const conversationId = await expiredConversation();
    await ctx.repositories.writeBatch(ctx.db, [reportFor(conversationId)]);

    for (let pass = 0; pass < 3; pass += 1) {
      await worker(new FakeLock()).runUntilDrained();
    }
    expect(await ctx.count('conversations')).toBe(1);
    expect(await ctx.count('reports')).toBe(1);
  });
});

describe('backup monitoring (§8.1)', () => {
  it('reports unknown before anything has been observed', () => {
    const monitor = new BackupMonitor(ctx.config);
    // Absence of news is not good news: a process that has never been told
    // about a backup has no evidence any exist.
    expect(monitor.status().health).toBe('unknown');
  });

  it('reports ok inside the window and stale outside it', () => {
    const monitor = new BackupMonitor(ctx.config);
    const now = Date.now();
    monitor.recordSuccess(now);
    expect(monitor.status(now + 1000).health).toBe('ok');
    expect(monitor.status(now + (ctx.config.backup.maxAgeSeconds + 60) * 1000).health).toBe('stale');
  });

  it('counts failures separately from staleness', () => {
    const monitor = new BackupMonitor(ctx.config);
    monitor.recordSuccess();
    monitor.recordFailure();
    const status = monitor.status();
    // A backup that failed once but succeeded recently is not stale; both
    // numbers matter and neither replaces the other.
    expect(status.health).toBe('ok');
    expect(status.failures).toBe(1);
  });
});
