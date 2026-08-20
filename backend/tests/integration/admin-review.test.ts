/**
 * The console read side, and the invariant it exists to keep (I11).
 *
 * The load-bearing test in this file is `openReport` under a failing audit
 * insert. Everything else here checks that the right data comes back; that one
 * checks the guarantee — that a read which could not be logged does not return
 * content.
 */
import {
  JustificationRequiredError,
  MAX_JUSTIFICATION_LENGTH,
  normaliseJustification,
  ReviewService,
} from '../../src/admin/review';
import type { AdminIdentity } from '../../src/admin/auth';
import type { Database } from '../../src/storage/pool';
import { newAdminAccountId, newMatchId, newMessageId } from '../../src/util/ids';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: PostgresContext;
let review: ReviewService;

const NOW = 1_700_000_000_000;
const REASON = 'reviewing a reported conversation';

const MODERATOR: AdminIdentity = {
  accountId: newAdminAccountId(),
  username: 'moderator',
  role: 'moderator',
};

interface Fixture {
  reportId: string;
  conversationId: string;
  reporterSession: string;
  reportedSession: string;
}

/** A conversation, its messages, and a report naming one side. */
async function seedReport(
  options: { note?: string | null; createdAtMs?: number; withheld?: boolean } = {},
): Promise<Fixture> {
  const conversationId = newMatchId();
  const reportId = `rep_${newMatchId().slice(2)}`;
  const reporterSession = `s_reporter_${conversationId.slice(2, 10)}`;
  const reportedSession = `s_reported_${conversationId.slice(2, 10)}`;
  const createdAt = new Date(options.createdAtMs ?? NOW);
  const expires = new Date((options.createdAtMs ?? NOW) + 30 * 24 * 60 * 60 * 1000);

  await ctx.db.query(
    `insert into conversations
       (conversation_id, session_a, session_b, segment, started_at, ended_at, end_reason,
        message_count, retention_expires_at)
     values ($1, $2, $3, 'default', $4, $5, 'block', 3, $6)`,
    [conversationId, reportedSession, reporterSession, createdAt, createdAt, expires],
  );

  const bodies: Array<[string, string, string]> = [
    [reportedSession, 'buy my product at spam.example', options.withheld === true ? 'withhold' : 'flag'],
    [reporterSession, 'please stop', 'allow'],
    [reportedSession, 'buy my product at spam.example', 'flag'],
  ];
  for (const [index, [sender, body, action]] of bodies.entries()) {
    await ctx.db.query(
      `insert into messages
         (message_id, conversation_id, sender_session_id, server_timestamp, type, body,
          char_length, moderation_action, moderation_flags, retention_expires_at)
       values ($1, $2, $3, $4, 'text', $5, $6, $7, $8, $9)`,
      [
        newMessageId(),
        conversationId,
        sender,
        new Date(createdAt.getTime() + index * 1000),
        body,
        body.length,
        action,
        JSON.stringify(action === 'allow' ? [] : ['url']),
        expires,
      ],
    );
  }

  await ctx.db.query(
    `insert into moderation_events
       (event_id, conversation_id, rule, action, severity, created_at, retention_expires_at)
     values ($1, $2, 'url', 'flag', 'low', $3, $4)`,
    [`evt_${newMatchId().slice(2)}`, conversationId, createdAt, expires],
  );

  await ctx.db.query(
    `insert into reports
       (report_id, conversation_id, reporter_session_id, reported_session_id, category, note,
        created_at, retention_expires_at)
     values ($1, $2, $3, $4, 'spam', $5, $6, $7)`,
    [
      reportId,
      conversationId,
      reporterSession,
      reportedSession,
      options.note === undefined ? 'they kept sending links' : options.note,
      createdAt,
      expires,
    ],
  );

  await ctx.db.query(
    `insert into blocks (block_id, blocker_key, blocked_key, dimension, conversation_id,
                         created_at, expires_at)
     values ($1, 'blocker-hash', 'reported-ip-hash', 'ip', $2, $3, $4),
            ($5, 'blocker-hash', 'reported-client-hash', 'client', $2, $3, $4)`,
    [`blk_${newMatchId().slice(2)}`, conversationId, createdAt, expires, `blk_${newMatchId().slice(2)}`],
  );

  return { reportId, conversationId, reporterSession, reportedSession };
}

async function auditRows(): Promise<
  Array<{
    action: string;
    actor: string;
    role: string;
    subject_id: string;
    case_id: string | null;
    justification: string;
    retention_expires_at: Date;
  }>
> {
  return ctx.rows(
    `select action, actor, role, subject_id, case_id, justification, retention_expires_at
       from admin_audit order by created_at asc, action asc`,
  );
}

beforeAll(async () => {
  ctx = await createPostgresContext();
  review = new ReviewService(ctx.db, ctx.config, ctx.logger);
});

afterEach(async () => {
  await ctx.db.query('delete from admin_audit');
  await ctx.db.query('delete from blocks');
  await ctx.db.query('delete from moderation_events');
  await ctx.db.query('delete from reports');
  await ctx.db.query('delete from messages');
  await ctx.db.query('delete from conversations');
});

afterAll(async () => {
  await ctx.close();
});

describe('the queue', () => {
  it('carries no user text at all', async () => {
    // The note is the reporter's own words (I8). A queue that included it
    // would render user content on every visit to the console, and auditing
    // that would mean a row per page load — drowning the log that matters.
    await seedReport({ note: 'CANARY-REPORTER-NOTE' });
    const [entry] = await review.listOpenReports();

    expect(JSON.stringify(entry)).not.toContain('CANARY-REPORTER-NOTE');
    expect(JSON.stringify(entry)).not.toContain('spam.example');
    expect(Object.keys(entry!).sort()).toEqual([
      'category',
      'conversationId',
      'createdAt',
      'flags',
      'hasWithheldMessage',
      'messageCount',
      'reportId',
      'state',
    ]);
  });

  it('reports the structural facts a triage decision needs', async () => {
    await seedReport({ withheld: true });
    const [entry] = await review.listOpenReports();
    expect(entry!.category).toBe('spam');
    expect(entry!.messageCount).toBe(3);
    expect(entry!.flags).toEqual(['url']);
    expect(entry!.hasWithheldMessage).toBe(true);
  });

  it('writes no audit row, because it discloses nothing', async () => {
    await seedReport();
    await review.listOpenReports();
    expect(await auditRows()).toEqual([]);
  });

  it('returns the oldest report first', async () => {
    // Oldest first cannot starve a report, and the oldest open one is closest
    // to its retention deadline — after which the evidence is gone and the
    // case cannot be decided at all.
    const older = await seedReport({ createdAtMs: NOW - 86_400_000 });
    const newer = await seedReport({ createdAtMs: NOW });
    const entries = await review.listOpenReports();
    expect(entries.map((entry) => entry.reportId)).toEqual([older.reportId, newer.reportId]);
  });

  it('drops a report once it has been resolved', async () => {
    const fixture = await seedReport();
    await review.resolveReport(fixture.reportId, 'DISMISSED', 'no action', REASON, MODERATOR, NOW);
    expect(await review.listOpenReports()).toEqual([]);
  });
});

describe('opening a report', () => {
  it('returns the transcript in order, labelled by side', async () => {
    const fixture = await seedReport();
    const detail = await review.openReport(fixture.reportId, REASON, MODERATOR, NOW);
    if (detail === null) throw new Error('expected a report');

    expect(detail.messages.map((message) => message.side)).toEqual([
      'reported',
      'reporter',
      'reported',
    ]);
    expect(detail.messages[0]!.body).toBe('buy my product at spam.example');
    expect(detail.messages[1]!.body).toBe('please stop');
    expect(detail.note).toBe('they kept sending links');
    expect(detail.endReason).toBe('block');
  });

  it('never exposes a session id', async () => {
    // Ephemeral and identifying nobody, but showing it invites treating it as
    // a handle for a person. The two roles are what the decision is about.
    const fixture = await seedReport();
    const detail = await review.openReport(fixture.reportId, REASON, MODERATOR, NOW);
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain(fixture.reportedSession);
    expect(serialised).not.toContain(fixture.reporterSession);
  });

  it('surfaces the hashes a sanction would attach to', async () => {
    const fixture = await seedReport();
    const detail = await review.openReport(fixture.reportId, REASON, MODERATOR, NOW);
    expect(detail!.reportedKeys).toEqual({
      ipHash: 'reported-ip-hash',
      clientHash: 'reported-client-hash',
    });
  });

  it('writes exactly one audit row, naming the actor, the case and the reason', async () => {
    const fixture = await seedReport();
    await review.openReport(fixture.reportId, REASON, MODERATOR, NOW);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'viewed_conversation',
      actor: MODERATOR.accountId,
      role: 'moderator',
      subject_id: fixture.conversationId,
      case_id: fixture.reportId,
      justification: REASON,
    });
  });

  it('stamps the audit deadline at insert time (D17)', async () => {
    const fixture = await seedReport();
    await review.openReport(fixture.reportId, REASON, MODERATOR, NOW);
    const [row] = await auditRows();
    const expected = NOW + ctx.config.retention.days.adminAudit * 24 * 60 * 60 * 1000;
    expect(row!.retention_expires_at.getTime()).toBe(expected);
  });

  it('returns null and writes nothing for a report that does not exist', async () => {
    // Nothing was disclosed, so there is nothing to log. An audit row here
    // would record a read that never happened.
    expect(await review.openReport('rep_missing', REASON, MODERATOR, NOW)).toBeNull();
    expect(await auditRows()).toEqual([]);
  });

  it('returns no content when the audit row cannot be written', async () => {
    // The guarantee is not "we usually log reads" — it is "a read that was not
    // logged did not happen". The audit insert is made to fail; the whole
    // transaction must roll back and the caller must get an error, not a
    // transcript.
    const fixture = await seedReport();
    const failing: Database = {
      ...ctx.db,
      transaction: (work) =>
        ctx.db.transaction(async (client) => {
          const guarded = {
            ...client,
            query: (async (text: string, values?: unknown[]) => {
              if (typeof text === 'string' && text.includes('insert into admin_audit')) {
                throw new Error('audit unavailable');
              }
              return (client.query as (t: string, v?: unknown[]) => Promise<unknown>)(text, values);
            }) as typeof client.query,
          };
          return work(guarded as typeof client);
        }),
    };

    const guardedReview = new ReviewService(failing, ctx.config, ctx.logger);
    await expect(
      guardedReview.openReport(fixture.reportId, REASON, MODERATOR, NOW),
    ).rejects.toThrow();
    expect(await auditRows()).toEqual([]);
  });
});

describe('resolving a report', () => {
  it('records a verdict and audits it', async () => {
    const fixture = await seedReport();
    const applied = await review.resolveReport(
      fixture.reportId,
      'ACTIONED',
      'banned the sender',
      REASON,
      MODERATOR,
      NOW,
    );
    expect(applied).toBe(true);

    const [row] = await ctx.rows<{ state: string; resolution: string }>(
      'select state, resolution from reports where report_id = $1',
      [fixture.reportId],
    );
    expect(row).toEqual({ state: 'ACTIONED', resolution: 'banned the sender' });

    const audit = await auditRows();
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('actioned_report');
  });

  it('refuses a second verdict instead of overwriting the first', async () => {
    // Two moderators reaching the same report is ordinary. The second must not
    // silently replace a decision somebody already made.
    const fixture = await seedReport();
    expect(
      await review.resolveReport(fixture.reportId, 'DISMISSED', 'no action', REASON, MODERATOR, NOW),
    ).toBe(true);
    expect(
      await review.resolveReport(fixture.reportId, 'ACTIONED', 'banned', REASON, MODERATOR, NOW),
    ).toBe(false);

    const [row] = await ctx.rows<{ state: string }>(
      'select state from reports where report_id = $1',
      [fixture.reportId],
    );
    expect(row!.state).toBe('DISMISSED');
    // And no audit row for the verdict that did not land.
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('justification', () => {
  it('requires a reason of substance', () => {
    expect(() => normaliseJustification(undefined)).toThrow(JustificationRequiredError);
    expect(() => normaliseJustification('')).toThrow(JustificationRequiredError);
    expect(() => normaliseJustification('  x  ')).toThrow(JustificationRequiredError);
    expect(() => normaliseJustification('a'.repeat(MAX_JUSTIFICATION_LENGTH + 1))).toThrow(
      JustificationRequiredError,
    );
    expect(normaliseJustification('  reviewing a spam report  ')).toBe('reviewing a spam report');
  });

  it('never echoes the text it rejected', () => {
    // Free text typed while reading a conversation: the most natural thing for
    // it to contain is a quote from one (I8).
    try {
      normaliseJustification('CANARY');
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(JustificationRequiredError);
      expect((err as Error).message).not.toContain('CANARY');
    }
  });
});
