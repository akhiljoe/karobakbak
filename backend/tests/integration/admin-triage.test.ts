/**
 * Report triage by Jev (D-AI-14), against real PostgreSQL, as the console role.
 *
 * Three properties carry the design and each has a test:
 *
 *  - The read is audited **before** any message body is selected, in the same
 *    transaction (D33) — so a broken audit insert means Jev is never asked.
 *  - Only reported conversations are read, and only open, untriaged reports.
 *  - Every Jev failure leaves the report showing the rules estimate and counts
 *    an attempt; nothing is invented.
 *
 * Run as `karobakbak_console`, because that is the role the console process
 * holds in production. The suite otherwise connects as a superuser, which
 * cannot see a missing grant — the deletion worker shipped exactly that bug.
 */

import { ReportTriage, TRIAGE_ACTOR, renderReport, rulesUrgency } from '../../src/admin/triage';
import { ReviewService, URGENCY_ORDER } from '../../src/admin/review';
import type { JevClient, JevResult } from '../../src/personas/jev';
import { REPORT_CATEGORIES } from '../../src/protocol/types';
import type { Database } from '../../src/storage/pool';
import { newMatchId, newMessageId } from '../../src/util/ids';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: PostgresContext;

const NOW = 1_700_000_000_000;

beforeAll(async () => {
  ctx = await createPostgresContext();
  await ctx.db.query(`grant usage on schema ${ctx.schema} to karobakbak_console`);
});

afterEach(async () => {
  await ctx.db.query('delete from admin_audit');
  await ctx.db.query('delete from reports');
  await ctx.db.query('delete from messages');
  await ctx.db.query('delete from conversations');
});

afterAll(async () => {
  await ctx.close();
});

/** The console role, with transactions, on one dedicated client. */
async function asConsoleRole<T>(work: (db: Database) => Promise<T>): Promise<T> {
  const client = await ctx.db.pool.connect();
  try {
    await client.query('set role karobakbak_console');
    const db: Database = {
      pool: ctx.db.pool,
      query: async <R extends Record<string, unknown>>(text: string, values?: unknown[]) => {
        const result = await client.query<R>(text, values);
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      },
      transaction: async (fn) => {
        await client.query('begin');
        try {
          const out = await fn(client);
          await client.query('commit');
          return out;
        } catch (err) {
          await client.query('rollback');
          throw err;
        }
      },
      close: async () => undefined,
    };
    return await work(db);
  } finally {
    await client.query('reset role');
    client.release();
  }
}

async function seed(
  options: { category?: string; state?: string; bodies?: Array<['reporter' | 'reported', string]> } = {},
): Promise<{ reportId: string; conversationId: string }> {
  const conversationId = newMatchId();
  const reportId = `rep_${newMatchId().slice(2)}`;
  const reporter = `s_reporter_${conversationId.slice(2, 10)}`;
  const reported = `s_reported_${conversationId.slice(2, 10)}`;
  const at = new Date(NOW);
  const expires = new Date(NOW + 30 * 24 * 60 * 60 * 1000);

  await ctx.db.query(
    `insert into conversations
       (conversation_id, session_a, session_b, segment, started_at, ended_at, end_reason,
        message_count, retention_expires_at)
     values ($1, $2, $3, 'default', $4, $4, 'skip', 2, $5)`,
    [conversationId, reported, reporter, at, expires],
  );

  const bodies = options.bodies ?? [
    ['reported', 'how old r u'],
    ['reporter', 'im 15'],
    ['reported', 'send pics'],
  ];
  for (const [index, [who, body]] of bodies.entries()) {
    await ctx.db.query(
      `insert into messages
         (message_id, conversation_id, sender_session_id, server_timestamp, type, body,
          char_length, retention_expires_at)
       values ($1, $2, $3, $4, 'text', $5, $6, $7)`,
      [
        newMessageId(),
        conversationId,
        who === 'reporter' ? reporter : reported,
        new Date(NOW + index * 1000),
        body,
        body.length,
        expires,
      ],
    );
  }

  await ctx.db.query(
    `insert into reports
       (report_id, conversation_id, reporter_session_id, reported_session_id, category, note,
        created_at, retention_expires_at, state)
     values ($1, $2, $3, $4, $5, null, $6, $7, $8)`,
    [reportId, conversationId, reporter, reported, options.category ?? 'grooming', at, expires, options.state ?? 'OPEN'],
  );

  return { reportId, conversationId };
}

const VERDICT: JevResult = {
  model: 'jev-1.13.0',
  answers: {
    urgency: { type: 'score', score: 2.9, confidence: 0.93, probabilities: {} },
    category: { type: 'choice', choice: 'grooming', confidence: 0.91, probabilities: {} },
    minor: { type: 'noul', noul: 0.97 },
  },
  usage: { inputTokens: 400, outputTokens: 10 },
};

function jev(answer: JevResult | null): JevClient & { states: string[] } {
  const states: string[] = [];
  return {
    enabled: true,
    states,
    ask: async (state) => {
      states.push(state);
      return answer;
    },
  };
}

function triage(db: Database, client: JevClient): ReportTriage {
  return new ReportTriage({
    db,
    jev: client,
    logger: ctx.logger,
    contextMessages: 40,
    maxAttempts: 3,
    auditRetentionDays: 365,
    now: () => NOW,
  });
}

async function reportRow(reportId: string): Promise<Record<string, unknown>> {
  const rows = await ctx.rows<Record<string, unknown>>(
    `select triage_urgency, triage_category, triage_confidence, triage_minor, triage_model,
            triaged_at, triage_attempts, state
       from reports where report_id = $1`,
    [reportId],
  );
  return rows[0] ?? {};
}

describe('report triage', () => {
  it('writes the verdict onto the report, as the console role', async () => {
    const { reportId } = await seed();
    const client = jev(VERDICT);

    const done = await asConsoleRole((db) => triage(db, client).runOnce());

    expect(done).toBe(1);
    const row = await reportRow(reportId);
    expect(row['triage_urgency']).toBeCloseTo(2.9);
    expect(row['triage_category']).toBe('grooming');
    expect(row['triage_confidence']).toBeCloseTo(0.91);
    expect(row['triage_minor']).toBeCloseTo(0.97);
    expect(row['triage_model']).toBe('jev-1.13.0');
    expect(row['triaged_at']).not.toBeNull();
    // Shadow mode: the report is not resolved or moved on by a verdict.
    expect(row['state']).toBe('OPEN');
  });

  it('audits the read as an automated actor, before Jev is asked', async () => {
    const { reportId, conversationId } = await seed();
    await asConsoleRole((db) => triage(db, jev(VERDICT)).runOnce());

    const audit = await ctx.rows<{ actor: string; action: string; subject_id: string; case_id: string }>(
      'select actor, action, subject_id, case_id from admin_audit',
    );
    expect(audit).toEqual([
      { actor: TRIAGE_ACTOR, action: 'automated_triage_read', subject_id: conversationId, case_id: reportId },
    ]);
  });

  it('never asks Jev when the audit row cannot be written — no logged read, no read', async () => {
    const { reportId } = await seed();
    const client = jev(VERDICT);
    await ctx.db.query(
      `create or replace function ${ctx.schema}.refuse_audit() returns trigger language plpgsql as
         $$ begin raise exception 'audit refused'; end $$`,
    );
    await ctx.db.query(
      `create trigger refuse_audit before insert on ${ctx.schema}.admin_audit
         for each row execute function ${ctx.schema}.refuse_audit()`,
    );
    try {
      await asConsoleRole((db) => triage(db, client).runOnce());
    } finally {
      await ctx.db.query(`drop trigger refuse_audit on ${ctx.schema}.admin_audit`);
    }

    expect(client.states).toHaveLength(0);
    expect((await reportRow(reportId))['triaged_at']).toBeNull();
  });

  it('sends Jev the conversation with sides named, never a session id', async () => {
    await seed();
    const client = jev(VERDICT);
    await asConsoleRole((db) => triage(db, client).runOnce());

    const state = client.states[0] ?? '';
    expect(state).toContain('REPORTED: send pics');
    expect(state).toContain('REPORTER: im 15');
    expect(state).not.toContain('s_reporter_');
    expect(state).not.toContain('s_reported_');
  });

  it('reads only open reports, and only once', async () => {
    await seed({ state: 'DISMISSED' });
    const { reportId } = await seed();
    const client = jev(VERDICT);

    await asConsoleRole((db) => triage(db, client).runOnce());
    await asConsoleRole((db) => triage(db, client).runOnce());

    expect(client.states).toHaveLength(1);
    expect((await reportRow(reportId))['triaged_at']).not.toBeNull();
  });

  it('counts an attempt when Jev fails, and gives up after the limit', async () => {
    const { reportId } = await seed();
    const client = jev(null);

    for (let i = 0; i < 5; i += 1) await asConsoleRole((db) => triage(db, client).runOnce());

    const row = await reportRow(reportId);
    expect(row['triaged_at']).toBeNull();
    expect(row['triage_attempts']).toBe(3);
    expect(client.states).toHaveLength(3);
  });

  it('does not ask Jev about a conversation with nothing left in it', async () => {
    const { reportId } = await seed({ bodies: [] });
    const client = jev(VERDICT);

    await asConsoleRole((db) => triage(db, client).runOnce());

    expect(client.states).toHaveLength(0);
    expect((await reportRow(reportId))['triage_attempts']).toBe(3);
  });
});

describe('the console queue', () => {
  it('shows the rules estimate, labelled as rules, until Jev has answered', async () => {
    await seed({ category: 'spam' });
    const review = new ReviewService(ctx.db, ctx.config, ctx.logger);

    const [entry] = await review.listOpenReports();
    expect(entry?.triage).toEqual({
      urgency: 1,
      source: 'rules',
      category: null,
      confidence: null,
      minor: null,
    });
  });

  it('shows the Jev verdict once there is one', async () => {
    await seed();
    await asConsoleRole((db) => triage(db, jev(VERDICT)).runOnce());
    const review = new ReviewService(ctx.db, ctx.config, ctx.logger);

    const [entry] = await review.listOpenReports();
    expect(entry?.triage.source).toBe('jev');
    expect(entry?.triage.category).toBe('grooming');
  });

  it('stays oldest-first in shadow mode, and orders by urgency when sorting is on', async () => {
    const low = await seed({ category: 'spam' });
    const high = await seed({ category: 'grooming' });
    await ctx.db.query('update reports set created_at = $2 where report_id = $1', [low.reportId, new Date(NOW - 60_000)]);

    const shadow = new ReviewService(ctx.db, ctx.config, ctx.logger);
    expect((await shadow.listOpenReports()).map((r) => r.reportId)).toEqual([low.reportId, high.reportId]);

    const sorting = new ReviewService(
      ctx.db,
      { ...ctx.config, jev: { ...ctx.config.jev, triage: { ...ctx.config.jev.triage, sort: true } } },
      ctx.logger,
    );
    expect((await sorting.listOpenReports()).map((r) => r.reportId)).toEqual([high.reportId, low.reportId]);
  });
});

describe('the rules estimate', () => {
  it('is the same in TypeScript and in the sort SQL, for every category', () => {
    // Written twice — once to label a report, once to order the queue — so a
    // test holds them together rather than trusting both edits to happen.
    for (const category of REPORT_CATEGORIES) {
      const branch = new RegExp(`when '${category}' then (\\d)`).exec(URGENCY_ORDER);
      const sql = branch === null ? 1 : Number(branch[1]);
      expect({ category, urgency: sql }).toEqual({ category, urgency: rulesUrgency(category) });
    }
  });

  it('renders a note when the reporter wrote one', () => {
    const state = renderReport(
      { category: 'harassment', note: 'kept insulting me', reporter_session_id: 's_a' },
      [{ sender_session_id: 's_b', body: 'idiot' }],
    );
    expect(state).toContain('Reporter\'s note: kept insulting me');
    expect(state).toContain('REPORTED: idiot');
  });
});
