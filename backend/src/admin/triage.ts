/**
 * Automated urgency triage of reported conversations, by Jev (D-AI-14).
 *
 * ---------------------------------------------------------------------------
 * WHY ONLY REPORTED CONVERSATIONS
 * ---------------------------------------------------------------------------
 * Message text between two people never leaves this server (rule 1, I8). The
 * one exception the operator chose is a conversation somebody has *reported*:
 * the reporter asked for it to be looked at, the console already reads it, and
 * the volume is tiny. Ordinary chats are never sent anywhere — nothing on the
 * message path calls into this file, and this file reads only conversations
 * joined to an open report.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES, AND WHAT IT DOES NOT
 * ---------------------------------------------------------------------------
 * For each open report not yet triaged, it reads the conversation's last
 * messages, asks Jev three questions, and writes the answers onto the report
 * row: an urgency from 0 to 3, the category Jev thinks it is, and the
 * probability a participant is under 18. That is all. It never resolves a
 * report, never bans, never notifies anybody — the operator chose shadow mode,
 * so a verdict is shown in the console and, until `JEV_TRIAGE_SORT` is turned
 * on, does not even move the report up the queue.
 *
 * ---------------------------------------------------------------------------
 * THE READ IS AUDITED LIKE A MODERATOR'S
 * ---------------------------------------------------------------------------
 * The audit row is written before the messages are selected, in the same
 * transaction (D33), with actor `system:jev-triage`. A machine reading a
 * stranger's conversation is still a read, and "a read that was not logged did
 * not happen" has no exception for automation.
 *
 * ---------------------------------------------------------------------------
 * FALLBACK
 * ---------------------------------------------------------------------------
 * When Jev cannot answer, nothing is written except a failed attempt, and the
 * report is tried again on the next pass up to `maxAttempts`. Until there is a
 * verdict the console shows a rules estimate from the reporter's own category
 * (`rulesUrgency`), labelled as such, so a report is never without an urgency
 * and never shown a machine verdict that was not made.
 */

import type { Logger } from '../logger';
import { dbErrorFields } from '../logger';
import type { JevClient, JevQuestion } from '../personas/jev';
import { REPORT_CATEGORIES } from '../protocol/types';
import type { Database } from '../storage/pool';
import { newAuditId } from '../util/ids';

/** What Jev may call a reported conversation: the reporter's categories, plus "nothing". */
export const TRIAGE_CATEGORIES = [...REPORT_CATEGORIES, 'nothing_wrong'] as const;

/** A closed set: it is a metric label. */
export type TriageOutcome = 'triaged' | 'jev_failed' | 'gone' | 'db_error';
export const TRIAGE_OUTCOMES: readonly TriageOutcome[] = ['triaged', 'jev_failed', 'gone', 'db_error'];

/** Actor and role written to `admin_audit` for every automated read. */
export const TRIAGE_ACTOR = 'system:jev-triage';
export const TRIAGE_ROLE = 'automated';

const URGENCY_LEVELS: readonly string[] = [
  'none: nothing in the conversation breaks the rules',
  'low: rude, annoying, spam or advertising, with no threat and nobody at risk',
  'high: harassment, hate, threats, scams, or sexual content the other person did not want',
  'critical: sexual content involving someone under 18, grooming, a credible threat of violence, ' +
    'or someone at risk of harming themselves',
];

const CATEGORY_CRITERIA: Readonly<Record<string, string>> = {
  harassment: 'insults, bullying or abuse aimed at the other person',
  spam: 'repeated or unwanted advertising or links',
  sexual_content: 'sexual messages or requests',
  grooming: 'an adult building trust with or sexualising someone who is or may be under 18',
  threats: 'threats of violence or harm',
  hate: 'attacks on someone for religion, caste, race, gender, sexuality or similar',
  scam: 'attempts to get money, accounts, or personal details by deception',
  other: 'something else that breaks the rules',
  nothing_wrong: 'nothing in the conversation breaks the rules',
};

const QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  urgency: {
    type: 'score',
    instructions:
      'A user reported this anonymous one-to-one chat. How urgently does a moderator need to ' +
      'look at it? Judge what REPORTED wrote. Casual swearing between people who are both ' +
      'joking is not harassment.',
    criteria: URGENCY_LEVELS,
  },
  category: {
    type: 'choice',
    instructions: 'What best describes what REPORTED did in this conversation?',
    criteria: CATEGORY_CRITERIA,
  },
  minor: {
    type: 'noul',
    instructions:
      'Does either participant say or clearly imply that they are under 18 (an age under 18, ' +
      'a school class below college, or similar)?',
  },
};

/**
 * The urgency the reporter's own category implies, used until Jev has answered.
 *
 * Deliberately coarse and deliberately the reporter's claim: it is what the
 * queue was implicitly prioritised on before, made explicit so it can sit in
 * the same column as a Jev verdict.
 */
export function rulesUrgency(category: string): number {
  switch (category) {
    case 'grooming':
      return 3;
    case 'threats':
    case 'sexual_content':
    case 'harassment':
    case 'hate':
      return 2;
    default:
      return 1;
  }
}

export interface TriageOptions {
  readonly db: Database;
  readonly jev: JevClient;
  readonly logger: Logger;
  readonly contextMessages: number;
  readonly maxAttempts: number;
  /** Days an audit row is kept; the console's own setting. */
  readonly auditRetentionDays: number;
  /** Reports per pass. A pass is serial: the console is one person's tool. */
  readonly batchSize?: number;
  readonly onOutcome?: (outcome: TriageOutcome) => void;
  readonly now?: () => number;
}

interface PendingReport {
  report_id: string;
  conversation_id: string;
  category: string;
  note: string | null;
  reporter_session_id: string;
}

const MAX_LINE_CHARS = 400;

export class ReportTriage {
  private running = false;

  constructor(private readonly options: TriageOptions) {}

  /**
   * Triage whatever is waiting. Returns how many reports got a verdict.
   *
   * Re-entrant calls return 0 rather than overlapping: a slow Jev must not let
   * two passes read the same conversation twice and write two audit rows.
   */
  async runOnce(): Promise<number> {
    if (!this.options.jev.enabled || this.running) return 0;
    this.running = true;
    try {
      const pending = await this.pending();
      let triaged = 0;
      for (const report of pending) {
        if (await this.triage(report)) triaged += 1;
      }
      return triaged;
    } catch (err) {
      this.options.logger.error('report triage pass failed', dbErrorFields(err));
      this.options.onOutcome?.('db_error');
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async pending(): Promise<PendingReport[]> {
    const { rows } = await this.options.db.query<Record<string, unknown>>(
      `select report_id, conversation_id, category, note, reporter_session_id
         from reports
        where state = 'OPEN' and triaged_at is null and triage_attempts < $1
        order by created_at asc
        limit $2`,
      [this.options.maxAttempts, this.options.batchSize ?? 10],
    );
    return rows as unknown as PendingReport[];
  }

  private async triage(report: PendingReport): Promise<boolean> {
    const now = this.options.now ?? Date.now;

    let transcript: Array<{ sender_session_id: string; body: string }>;
    try {
      transcript = await this.options.db.transaction(async (client) => {
        // Before a single body is selected, in the same transaction (D33).
        await client.query(
          `insert into admin_audit
             (audit_id, actor, role, action, subject_type, subject_id, case_id,
              justification, created_at, retention_expires_at)
           values ($1, $2, $3, 'automated_triage_read', 'conversation', $4, $5, $6, $7, $8)`,
          [
            newAuditId(),
            TRIAGE_ACTOR,
            TRIAGE_ROLE,
            report.conversation_id,
            report.report_id,
            'automated urgency triage of a reported conversation (D-AI-14)',
            new Date(now()),
            new Date(now() + this.options.auditRetentionDays * 24 * 60 * 60 * 1000),
          ],
        );
        const result = await client.query(
          `select sender_session_id, body
             from (select sender_session_id, body, server_timestamp, message_id
                     from messages
                    where conversation_id = $1
                    order by server_timestamp desc, message_id desc
                    limit $2) recent
            order by server_timestamp asc, message_id asc`,
          [report.conversation_id, this.options.contextMessages],
        );
        return result.rows as Array<{ sender_session_id: string; body: string }>;
      });
    } catch (err) {
      this.options.logger.error('report triage read failed', dbErrorFields(err));
      this.options.onOutcome?.('db_error');
      return false;
    }

    if (transcript.length === 0) {
      // Already deleted by retention, or nothing was said. There is nothing to
      // judge, and asking Jev about an empty conversation would invent a verdict.
      await this.markAttempt(report.report_id, true);
      this.options.onOutcome?.('gone');
      return false;
    }

    const state = renderReport(report, transcript);
    const result = await this.options.jev.ask(state, QUESTIONS);
    const urgency = result?.answers['urgency'];
    const category = result?.answers['category'];
    const minor = result?.answers['minor'];

    if (
      result === null ||
      urgency?.type !== 'score' ||
      category?.type !== 'choice' ||
      minor?.type !== 'noul'
    ) {
      await this.markAttempt(report.report_id, false);
      this.options.onOutcome?.('jev_failed');
      return false;
    }

    try {
      await this.options.db.query(
        `update reports
            set triage_urgency = $2, triage_category = $3, triage_confidence = $4,
                triage_minor = $5, triage_model = $6, triaged_at = $7
          where report_id = $1 and triaged_at is null`,
        [
          report.report_id,
          clamp(urgency.score, 0, 3),
          isTriageCategory(category.choice) ? category.choice : 'other',
          Math.min(urgency.confidence, category.confidence),
          minor.noul,
          result.model,
          new Date(now()),
        ],
      );
    } catch (err) {
      this.options.logger.error('report triage write failed', dbErrorFields(err));
      this.options.onOutcome?.('db_error');
      return false;
    }

    this.options.onOutcome?.('triaged');
    return true;
  }

  /** One failed attempt; `exhausted` spends them all, for a conversation with nothing in it. */
  private async markAttempt(reportId: string, exhausted: boolean): Promise<void> {
    try {
      await this.options.db.query(
        `update reports
            set triage_attempts = case when $2 then $3 else triage_attempts + 1 end
          where report_id = $1`,
        [reportId, exhausted, this.options.maxAttempts],
      );
    } catch (err) {
      this.options.logger.error('report triage attempt not recorded', dbErrorFields(err));
    }
  }
}

/**
 * The reported conversation as Jev reads it.
 *
 * Sides are named by their part in the report, not by session id: Jev needs to
 * know who is accused, and a session id is an identifier that has no business
 * leaving the server.
 */
export function renderReport(
  report: Pick<PendingReport, 'category' | 'note' | 'reporter_session_id'>,
  transcript: ReadonlyArray<{ sender_session_id: string; body: string }>,
): string {
  const lines = transcript.map((m) => {
    const who = m.sender_session_id === report.reporter_session_id ? 'REPORTER' : 'REPORTED';
    return `${who}: ${cut(m.body)}`;
  });
  const note = report.note === null || report.note.trim() === '' ? '' : `\nReporter's note: ${cut(report.note)}`;
  return (
    'An anonymous one-to-one text chat between two strangers. REPORTER filed a report ' +
    `against REPORTED, choosing the category "${report.category}".${note}\n` +
    `Conversation, oldest first:\n${lines.join('\n')}`
  );
}

function cut(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isTriageCategory(value: string): boolean {
  return (TRIAGE_CATEGORIES as readonly string[]).includes(value);
}
