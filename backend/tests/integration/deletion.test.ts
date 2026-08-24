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

function toDeletion(overrides: Record<string, string>): {
  batch?: number;
  intervalMs?: number;
} {
  const result: { batch?: number; intervalMs?: number } = {};
  if (overrides.batch !== undefined) result.batch = Number(overrides.batch);
  if (overrides.intervalMs !== undefined) result.intervalMs = Number(overrides.intervalMs);
  return result;
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

  /**
   * The scheduled path drains; it does not nibble.
   *
   * `start()` used to schedule a single `runPass()` per interval and throw away
   * the `more` flag that pass computed. One pass deletes at most
   * `DELETION_BATCH` rows *per table*, so with the shipped defaults — 500 rows,
   * one pass an hour — this worker could never remove more than 500 rows per
   * table per hour however much had expired. Any real volume outruns that and
   * the backlog grows for ever, while every signal stays green: the pass
   * succeeded, so `chat_deletion_failures_total` never moves and
   * `chat_retention_deleted_total` climbs steadily.
   */
  it('drains a backlog larger than one batch in a single run', async () => {
    for (let i = 0; i < 7; i += 1) await seed({ expired: true, messages: 2 });
    const batched = worker(new FakeLock(), { batch: '2' });

    await batched.runUntilDrained();

    // Nothing expired is left, from a single run at a batch size that could
    // only take two conversations per pass. This is the property under test.
    expect(await ctx.count('conversations')).toBe(0);
    expect(await ctx.count('messages')).toBe(0);
    expect(batched.totals.conversations).toBe(7);

    // `totals.messages` is a floor, not a census, and deliberately asserted as
    // one. `messages.conversation_id` is `on delete cascade`, so once a
    // conversation goes its remaining messages go with it — removed by
    // PostgreSQL, counted against the *conversation* statement, and invisible
    // to `rowCount` on the message statement. Here that is 8 counted of 14
    // actually deleted. The same undercount reaches
    // `chat_retention_deleted_total{table="messages"}` on the dashboard.
    expect(batched.totals.messages).toBeGreaterThanOrEqual(2);
    expect(batched.totals.messages).toBeLessThanOrEqual(14);
  });

  it('drains on its own schedule, rather than one batch per interval', async () => {
    // The test above calls `runUntilDrained` directly, which the suite already
    // did before this fix existed — so on its own it proves nothing about the
    // defect. The defect was in `start()`: it scheduled a single `runPass()`
    // per interval and discarded the `more` flag that pass computed, capping
    // this worker at one batch per table per interval however much had
    // expired. This is the test that goes through the scheduler.
    for (let i = 0; i < 7; i += 1) await seed({ expired: true, messages: 2 });
    const scheduled = worker(new FakeLock(), { batch: '2', intervalMs: '1000' });

    try {
      scheduled.start();
      // One tick, plus room for the drain. Under the old scheduling exactly two
      // conversations would be gone by now and five would remain.
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      scheduled.stop();
    }

    expect(await ctx.count('conversations')).toBe(0);
    expect(await ctx.count('messages')).toBe(0);
  }, 10_000);

  it('stops draining on a failed pass instead of retrying into a broken database', async () => {
    // `more` and a failure mean opposite things to a draining caller. The
    // error path used to report `more: true`, which would have retried a
    // database that is refusing every statement up to `maxPasses` times per
    // run — adding load to the thing that is already unwell.
    let calls = 0;
    const failing = new DeletionWorker(
      ctx.config,
      createNullLogger(),
      {
        ...ctx.db,
        query: async () => {
          calls += 1;
          throw new Error('connection terminated');
        },
      },
      new FakeLock(),
    );

    await failing.runUntilDrained();

    expect(failing.failures).toBe(1);
    // One pass attempted, not a hundred.
    expect(calls).toBe(1);
  });

  /**
   * The number that proves expiry is enforced rather than attempted.
   *
   * `chat_retention_deleted_total` cannot answer it: a worker falling behind
   * still deletes steadily, so throughput looks identical whether the backlog
   * is empty or growing without bound. This is zero when the worker is keeping
   * up, whatever the volume, batch size or interval — which is why the alert
   * watches it and not the counter.
   */
  describe('the retention backlog', () => {
    it('counts what is past its deadline and still stored', async () => {
      for (let i = 0; i < 3; i += 1) await seed({ expired: true, messages: 2 });
      const worker_ = worker(new FakeLock());

      await worker_.sampleBacklog();

      expect(worker_.lastBacklog).toMatchObject({ conversations: 3, messages: 6 });
    });

    it('is zero once the worker has caught up', async () => {
      await seed({ expired: true, messages: 2 });
      const worker_ = worker(new FakeLock());
      await worker_.runUntilDrained();

      expect(worker_.lastBacklog).toMatchObject({ conversations: 0, messages: 0 });
    });

    it('does not count rows a hold is deliberately keeping', async () => {
      // A hold suspends deletion on purpose. Counting held rows as a backlog
      // would alert on the system working exactly as designed, which is how an
      // operator learns to ignore the alert that matters.
      const { conversationId } = await seed({ expired: true, messages: 2 });
      await holds.place({
        subjectType: 'conversation',
        subjectId: conversationId,
        caseId: 'CASE-BACKLOG',
        owner: 'trust-and-safety',
        justification: 'ongoing investigation',
      });

      const worker_ = worker(new FakeLock());
      await worker_.runUntilDrained();

      expect(await ctx.count('messages')).toBe(2);
      expect(worker_.lastBacklog).toMatchObject({ conversations: 0, messages: 0 });
    });

    it('keeps its last good answer when the database is unavailable', async () => {
      const broken = new DeletionWorker(
        ctx.config,
        createNullLogger(),
        { ...ctx.db, query: async () => { throw new Error('connection terminated'); } },
        new FakeLock(),
      );

      await broken.sampleBacklog();

      // Never read anything, so it publishes nothing. A zero from a failed read
      // is the most reassuring thing this process could wrongly claim.
      expect(broken.lastBacklog).toBeNull();
    });
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
  it('suspends deletion of a held conversation, and of everything in it', async () => {
    // This test used to assert one thing — that the conversation row survived —
    // and passed on runs where the entire transcript had been deleted. The
    // child queries filtered on their own `legal_hold` alone and never read
    // the parent's, so a hold placed on a conversation preserved the row it
    // names and none of the evidence it was placed for.
    const { conversationId, messageIds } = await seed({ expired: true, messages: 2 });
    await ctx.db.query(
      `insert into reports (report_id, conversation_id, reporter_session_id, reported_session_id,
                            category, created_at, retention_expires_at)
       values ($1, $2, 's_a', 's_b', 'harassment', now(), now() - interval '1 day')`,
      [newMessageId(), conversationId],
    );
    await ctx.db.query(
      `insert into moderation_events (event_id, conversation_id, message_id, rule, action,
                                      severity, created_at, retention_expires_at)
       values ($1, $2, $3, 'url', 'flag', 'medium', now(), now() - interval '1 day')`,
      [newMessageId(), conversationId, messageIds[0]!],
    );

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
    // The point of the hold.
    expect(await ctx.count('messages')).toBe(2);
    expect(await ctx.count('reports')).toBe(1);
    expect(await ctx.count('moderation_events')).toBe(1);
  });

  it('protects a held message moderation events, which have no hold of their own', async () => {
    // A moderation event is never a hold subject and has no `legal_hold`
    // column. It is the explanation of why a message was flagged, so it is
    // held by whatever holds the thing it describes.
    const { messageIds } = await seed({ expired: false, messages: 2, messageExpired: true });
    await ctx.db.query(
      `insert into moderation_events (event_id, conversation_id, message_id, rule, action,
                                      severity, created_at, retention_expires_at)
       values ($1, null, $2, 'email', 'flag', 'high', now(), now() - interval '1 day')`,
      [newMessageId(), messageIds[0]!],
    );
    await holds.place({
      subjectType: 'message',
      subjectId: messageIds[0]!,
      caseId: 'CASE-3',
      owner: 'trust-and-safety',
      justification: 'evidence',
    });

    await worker(new FakeLock()).runUntilDrained();

    expect(await ctx.count('messages')).toBe(1);
    expect(await ctx.count('moderation_events')).toBe(1);
  });

  it('collects a moderation event whose parents are not held', async () => {
    // Containment must not become "never delete a moderation event". An event
    // with no held parent, and one with no parent at all, both expire normally.
    const { conversationId, messageIds } = await seed({ expired: true, messages: 1 });
    await ctx.db.query(
      `insert into moderation_events (event_id, conversation_id, message_id, rule, action,
                                      severity, created_at, retention_expires_at)
       values ($1, $2, $3, 'url', 'flag', 'low', now(), now() - interval '1 day')`,
      [newMessageId(), conversationId, messageIds[0]!],
    );
    await ctx.db.query(
      `insert into moderation_events (event_id, conversation_id, message_id, rule, action,
                                      severity, created_at, retention_expires_at)
       values ($1, null, null, 'crypto_address', 'block', 'high', now(), now() - interval '1 day')`,
      [newMessageId()],
    );

    await worker(new FakeLock()).runUntilDrained();
    expect(await ctx.count('moderation_events')).toBe(0);
  });

  it('lets everything expire again once the conversation hold is released', async () => {
    const { conversationId } = await seed({ expired: true, messages: 2 });
    const placed = await holds.place({
      subjectType: 'conversation',
      subjectId: conversationId,
      caseId: 'CASE-4',
      owner: 'trust-and-safety',
      justification: 'ongoing investigation',
    });
    await worker(new FakeLock()).runUntilDrained();
    expect(await ctx.count('messages')).toBe(2);

    // One flag on one row, so release needs no bookkeeping about which
    // children were held on the parent's behalf — the reason containment is
    // read at deletion time rather than cascaded onto children.
    await holds.release(placed.holdId, 'trust-and-safety', 'case closed');
    await worker(new FakeLock()).runUntilDrained();

    expect(await ctx.count('conversations')).toBe(0);
    expect(await ctx.count('messages')).toBe(0);
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
          profileA: null,
          profileB: null,
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
          profileA: null,
          profileB: null,
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
