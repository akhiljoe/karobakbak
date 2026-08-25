/**
 * A6 — the console persona view (D-AI-12).
 *
 * The claim being tested is narrow and load-bearing: with no report gating
 * access, **the audit log is the only remaining control** on reading a
 * stranger's messages. So the test that matters is the one that breaks the
 * audit insert and asserts no transcript comes back — the same shape as the
 * test `review.ts` already carries, for a stronger reason.
 */

import { PersonaConsoleService } from '../../src/admin/personas';
import type { AdminIdentity } from '../../src/admin/auth';
import { newAdminAccountId, newMessageId } from '../../src/util/ids';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: PostgresContext;
let service: PersonaConsoleService;

const identity: AdminIdentity = {
  accountId: newAdminAccountId(),
  username: '***REMOVED***',
  role: 'senior_moderator',
};

beforeAll(async () => {
  ctx = await createPostgresContext();
  service = new PersonaConsoleService(ctx.db, ctx.config);
});

afterAll(async () => {
  await ctx.close();
});

beforeEach(async () => {
  await ctx.db.query('delete from persona_conversations');
  await ctx.db.query('delete from admin_audit');
  await ctx.db.query('delete from messages');
  await ctx.db.query('delete from conversations');
});

const YEAR = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

/** A persona conversation with a transcript, ready to be read. */
async function seed(
  conversationId: string,
  options: { flagged?: boolean; withTranscript?: boolean; limits?: string[] } = {},
): Promise<void> {
  const personaSession = 's_persona';
  const humanSession = 's_human';

  if (options.withTranscript !== false) {
    await ctx.db.query(
      `insert into conversations (conversation_id, session_a, session_b, segment,
                                  started_at, retention_expires_at)
       values ($1, $2, $3, 'default', now(), $4)`,
      [conversationId, personaSession, humanSession, YEAR],
    );
    for (const [session, body] of [
      [personaSession, 'hey, what are you up to'],
      [humanSession, 'not much, you?'],
    ] as const) {
      await ctx.db.query(
        `insert into messages (message_id, conversation_id, sender_session_id,
                               server_timestamp, type, body, char_length,
                               retention_expires_at)
         values ($1, $2, $3, now(), 'text', $4, $5, $6)`,
        [newMessageId(), conversationId, session, body, body.length, YEAR],
      );
    }
  }

  await ctx.db.query(
    `insert into persona_conversations
       (conversation_id, persona_id, surface, persona_session_id, provider, model,
        replies, cost_micro_cents, limits_tripped, flagged, retention_expires_at)
     values ($1, 'nadia-nightshift', $2, $3, 'anthropic', 'claude-haiku-4-5',
             1, 830, $4, $5, $6)`,
    [
      conversationId,
      JSON.stringify({ name: 'Nadia', age: 31, gender: 'female', country: 'GB' }),
      personaSession,
      options.limits ?? [],
      options.flagged ?? false,
      YEAR,
    ],
  );
}

describe('reading a persona conversation', () => {
  it('returns the transcript and says which side was the persona', async () => {
    await seed('m_one');
    const detail = await service.open('m_one', 'quality review', identity);

    expect(detail).not.toBeNull();
    expect(detail?.personaId).toBe('nadia-nightshift');
    expect(detail?.messages).toHaveLength(2);
    expect(detail?.messages[0]?.fromPersona).toBe(true);
    expect(detail?.messages[1]?.fromPersona).toBe(false);
    expect(detail?.conversationPresent).toBe(true);
  });

  it('shows the generated surface the stranger actually saw', async () => {
    // Otherwise unrecoverable: the surface is regenerated per conversation
    // (D-AI-3) and kept nowhere else.
    await seed('m_two');
    const detail = await service.open('m_two', 'quality review', identity);
    expect(detail?.surface?.name).toBe('Nadia');
  });

  it('writes exactly one audit row, naming the action and the reader', async () => {
    await seed('m_three');
    await service.open('m_three', 'checking tone', identity);

    const audit = await ctx.db.query<{
      action: string;
      actor: string;
      subject_id: string;
      justification: string;
    }>('select action, actor, subject_id, justification from admin_audit');

    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]?.action).toBe('viewed_persona_conversation');
    expect(audit.rows[0]?.actor).toBe(identity.accountId);
    expect(audit.rows[0]?.subject_id).toBe('m_three');
    expect(audit.rows[0]?.justification).toBe('checking tone');
  });

  it('returns null for a conversation that had no persona in it', async () => {
    expect(await service.open('m_never', 'poking about', identity)).toBeNull();
  });

  it('distinguishes an expired transcript from one that never existed', async () => {
    // "This existed and was deleted on schedule" is a different fact from "this
    // never existed", and the retention promise is easier to believe when the
    // console can show the difference.
    await seed('m_expired', { withTranscript: false });
    const detail = await service.open('m_expired', 'quality review', identity);

    expect(detail).not.toBeNull();
    expect(detail?.conversationPresent).toBe(false);
    expect(detail?.messages).toEqual([]);
  });
});

describe('a read that was not logged did not happen (D33)', () => {
  it('returns no transcript when the audit row cannot be written', async () => {
    // The whole guarantee. With no report gating access, this audit trail is
    // the only remaining control on reading a stranger's messages, so the
    // ordering — audit first, same transaction — matters more here than
    // anywhere else in the system.
    await seed('m_audit_fails');

    // Break the audit table for this transaction only.
    await ctx.db.query(
      `alter table admin_audit add constraint tmp_block_persona_reads
         check (action <> 'viewed_persona_conversation')`,
    );

    try {
      await expect(
        service.open('m_audit_fails', 'quality review', identity),
      ).rejects.toThrow();

      // And nothing was recorded either, so there is no half-state.
      const audit = await ctx.db.query<{ count: string }>(
        `select count(*)::text as count from admin_audit`,
      );
      expect(audit.rows[0]?.count).toBe('0');
    } finally {
      await ctx.db.query(
        'alter table admin_audit drop constraint tmp_block_persona_reads',
      );
    }
  });
});

describe('the list', () => {
  it('puts flagged conversations first', async () => {
    await seed('m_plain');
    await seed('m_flagged', { flagged: true, limits: ['minor'] });

    const rows = await service.list();
    expect(rows[0]?.conversationId).toBe('m_flagged');
    expect(rows[0]?.limitsTripped).toEqual(['minor']);
  });

  it('can show only the flagged ones', async () => {
    await seed('m_plain');
    await seed('m_flagged', { flagged: true, limits: ['crisis'] });

    const rows = await service.list(50, true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversationId).toBe('m_flagged');
  });

  it('writes no audit row, because it returns no user content', async () => {
    // Auditing a list rendered on every visit to the console would bury the
    // reads that matter in noise, which makes the trail worse rather than
    // better. Nothing here is anything a stranger typed.
    await seed('m_plain');
    await service.list();

    const audit = await ctx.db.query<{ count: string }>(
      'select count(*)::text as count from admin_audit',
    );
    expect(audit.rows[0]?.count).toBe('0');
  });

  it('caps the page size however large a caller asks for', async () => {
    const rows = await service.list(100000);
    expect(rows.length).toBeLessThanOrEqual(200);
  });
});

describe('the overview beside the kill switch', () => {
  it('reports spend against the ceiling and the flagged backlog', async () => {
    // The decision to turn personas off is usually made *because* of a number.
    // Putting the number and the switch in different places is how the switch
    // gets found late.
    await ctx.db.query(
      `insert into persona_spend (period, spent_micro_cents, limit_micro_cents)
       values (date_trunc('month', now())::date, 4200, 200000000)
       on conflict (period) do update set spent_micro_cents = 4200`,
    );
    await seed('m_flagged', { flagged: true, limits: ['crisis'] });

    const overview = await service.overview();
    expect(overview.spentMicroCents).toBe(4200);
    expect(overview.limitMicroCents).toBe(200000000);
    expect(overview.flaggedOpen).toBe(1);
    expect(overview.conversationsToday).toBe(1);
  });
});
