/**
 * The read side of the moderation console (I11).
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ---------------------------------------------------------------------------
 * I11: no application path returns retained message content without an
 * authenticated, role-checked, purpose-scoped request that writes an
 * `admin_audit` row. Every word of that is load-bearing here:
 *
 *   authenticated — the caller arrives with an identity resolved by the guard;
 *   purpose-scoped — a report id is the scope. There is no "list every
 *     conversation" path, and a conversation is only reachable *through* a
 *     report that names it;
 *   audited — the audit row is written **first**, in the same transaction as
 *     the read, and a failure to write it fails the request. An audit log that
 *     is written after the content is returned records what was read only when
 *     nothing went wrong, which is the opposite of what evidence means.
 *
 * ---------------------------------------------------------------------------
 * WHY THE QUEUE CARRIES NO TEXT
 * ---------------------------------------------------------------------------
 * `listOpenReports` deliberately does not select `reports.note`. The note is
 * the reporter's own words — user content, protected exactly like a message
 * body (I8) — so a queue that included it would be a page of user content
 * rendered on every visit to the console, and auditing it would mean an audit
 * row per page load, which drowns the log that matters.
 *
 * So the queue answers "what needs attention and in what order" from
 * structural facts only: category, age, message count, which automated rules
 * fired. Opening a case is the moment content is disclosed, and that moment is
 * the one that gets a row.
 */
import type { Config } from '../config';
import type { Logger } from '../logger';
import { dbErrorFields } from '../logger';
import type { Database } from '../storage/pool';
import { newAuditId } from '../util/ids';
import type { AdminIdentity } from './auth';

/** Longest justification accepted. Same bound as a report note. */
export const MAX_JUSTIFICATION_LENGTH = 500;

/** Shortest justification accepted, so "x" is not a reason. */
export const MIN_JUSTIFICATION_LENGTH = 8;

export type ReportState = 'OPEN' | 'TRIAGED' | 'ACTIONED' | 'DISMISSED';

/** One row of the queue. Structural facts only — no user text of any kind. */
export interface QueueEntry {
  readonly reportId: string;
  readonly conversationId: string;
  readonly category: string;
  readonly state: ReportState;
  readonly createdAt: string;
  readonly messageCount: number;
  /** Rule ids the automated pipeline recorded against this conversation. */
  readonly flags: readonly string[];
  /** Whether any message in it was withheld from delivery. */
  readonly hasWithheldMessage: boolean;
}

/** One message in a replayed conversation. */
export interface ReplayMessage {
  readonly messageId: string;
  readonly at: string;
  /**
   * Which side spoke, relative to the report — not a session id.
   *
   * A session id is ephemeral and identifies nobody, but it is still an
   * identifier a moderator has no use for, and showing it invites treating it
   * as a handle for a person. The two roles in a report are what the decision
   * is actually about.
   */
  readonly side: 'reported' | 'reporter' | 'unknown';
  readonly body: string;
  readonly moderationAction: string;
  readonly flags: readonly string[];
}

export interface ReportDetail {
  readonly reportId: string;
  readonly conversationId: string;
  readonly category: string;
  readonly state: ReportState;
  readonly createdAt: string;
  /** The reporter's own words. User content (I8). */
  readonly note: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endReason: string | null;
  readonly messages: readonly ReplayMessage[];
  /** The two identity hashes of the reported party, for issuing a sanction. */
  readonly reportedKeys: { readonly ipHash: string | null; readonly clientHash: string | null };
}

export class JustificationRequiredError extends Error {
  constructor(reason: string) {
    super(`justification ${reason}`);
    this.name = 'JustificationRequiredError';
  }
}

/**
 * Validate a justification without ever putting it in an error message.
 *
 * The value is free text typed while reading a conversation, so the most
 * natural thing for it to contain is a quote from one — which is why it is on
 * the logger's denylist and why nothing here interpolates it.
 */
export function normaliseJustification(raw: unknown): string {
  if (typeof raw !== 'string') throw new JustificationRequiredError('is required');
  const trimmed = raw.trim();
  if (trimmed.length < MIN_JUSTIFICATION_LENGTH) {
    throw new JustificationRequiredError(`must be at least ${MIN_JUSTIFICATION_LENGTH} characters`);
  }
  if (trimmed.length > MAX_JUSTIFICATION_LENGTH) {
    throw new JustificationRequiredError(`must be at most ${MAX_JUSTIFICATION_LENGTH} characters`);
  }
  return trimmed;
}

export class ReviewService {
  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  /**
   * The triage queue: open reports, oldest first.
   *
   * Oldest first rather than newest: a queue worked from the top in arrival
   * order cannot starve an old report, and the oldest open report is the one
   * whose conversation is closest to its retention deadline — after which the
   * evidence is gone and the case cannot be decided at all.
   *
   * No audit row: nothing here is user content.
   */
  async listOpenReports(limit = 50): Promise<readonly QueueEntry[]> {
    const capped = Math.min(Math.max(Math.floor(limit), 1), 200);
    const { rows } = await this.db.query<{
      report_id: string;
      conversation_id: string;
      category: string;
      state: ReportState;
      created_at: Date;
      message_count: number;
      flags: string[] | null;
      withheld: string;
    }>(
      `select r.report_id, r.conversation_id, r.category, r.state, r.created_at,
              c.message_count,
              coalesce(
                (select array_agg(distinct e.rule)
                   from moderation_events e
                  where e.conversation_id = r.conversation_id),
                '{}'
              ) as flags,
              (select count(*) from messages m
                where m.conversation_id = r.conversation_id
                  and m.moderation_action in ('withhold', 'block')) as withheld
         from reports r
         join conversations c on c.conversation_id = r.conversation_id
        where r.state = 'OPEN'
        order by r.created_at asc
        limit $1`,
      [capped],
    );

    return rows.map((row) => ({
      reportId: row.report_id,
      conversationId: row.conversation_id,
      category: row.category,
      state: row.state,
      createdAt: row.created_at.toISOString(),
      messageCount: row.message_count,
      flags: row.flags ?? [],
      hasWithheldMessage: Number(row.withheld) > 0,
    }));
  }

  /**
   * Open one report and replay its conversation.
   *
   * The audit row and the content read happen in **one transaction**, audit
   * first. If the insert fails the transaction rolls back and the caller gets
   * an error rather than content: the guarantee is not "we usually log reads",
   * it is "a read that was not logged did not happen".
   *
   * Returns null when the report does not exist or its conversation has
   * already been deleted by the retention worker — the second case is normal,
   * not an error, and is why the queue is worked oldest-first.
   */
  async openReport(
    reportId: string,
    justification: string,
    identity: AdminIdentity,
    nowMs = Date.now(),
  ): Promise<ReportDetail | null> {
    try {
      return await this.db.transaction(async (client) => {
        const reportResult = await client.query(
          `select r.report_id, r.conversation_id, r.category, r.state, r.created_at, r.note,
                  r.reporter_session_id, r.reported_session_id,
                  c.started_at, c.ended_at, c.end_reason
             from reports r
             join conversations c on c.conversation_id = r.conversation_id
            where r.report_id = $1`,
          [reportId],
        );
        const report = reportResult.rows[0] as
          | {
              report_id: string;
              conversation_id: string;
              category: string;
              state: ReportState;
              created_at: Date;
              note: string | null;
              reporter_session_id: string;
              reported_session_id: string;
              started_at: Date;
              ended_at: Date | null;
              end_reason: string | null;
            }
          | undefined;
        if (report === undefined) return null;

        // Written before a single message body is selected. The ordering is
        // the whole control: an audit row written afterwards would be missing
        // for exactly the reads that failed halfway, which are the ones worth
        // knowing about.
        await this.writeAudit(client, {
          action: 'viewed_conversation',
          subjectType: 'conversation',
          subjectId: report.conversation_id,
          caseId: report.report_id,
          justification,
          identity,
          nowMs,
        });

        const messagesResult = await client.query(
          `select message_id, sender_session_id, server_timestamp, body,
                  moderation_action, moderation_flags
             from messages
            where conversation_id = $1
            order by server_timestamp asc, message_id asc`,
          [report.conversation_id],
        );

        const messages: ReplayMessage[] = (
          messagesResult.rows as Array<{
            message_id: string;
            sender_session_id: string;
            server_timestamp: Date;
            body: string;
            moderation_action: string;
            moderation_flags: string[] | null;
          }>
        ).map((row) => ({
          messageId: row.message_id,
          at: row.server_timestamp.toISOString(),
          side:
            row.sender_session_id === report.reported_session_id
              ? 'reported'
              : row.sender_session_id === report.reporter_session_id
                ? 'reporter'
                : 'unknown',
          body: row.body,
          moderationAction: row.moderation_action,
          flags: row.moderation_flags ?? [],
        }));

        // The hashes a sanction would be issued against, read from the block
        // rows the reported party's own session produced. Absent when nobody
        // blocked them and their session had already expired — in which case a
        // ban has nothing to attach to, and the console must say so rather
        // than offer a button that writes nothing.
        const keysResult = await client.query(
          `select dimension, blocked_key
             from blocks
            where conversation_id = $1`,
          [report.conversation_id],
        );
        const keys = keysResult.rows as Array<{ dimension: string; blocked_key: string }>;

        return {
          reportId: report.report_id,
          conversationId: report.conversation_id,
          category: report.category,
          state: report.state,
          createdAt: report.created_at.toISOString(),
          note: report.note,
          startedAt: report.started_at.toISOString(),
          endedAt: report.ended_at?.toISOString() ?? null,
          endReason: report.end_reason,
          messages,
          reportedKeys: {
            ipHash: keys.find((row) => row.dimension === 'ip')?.blocked_key ?? null,
            clientHash: keys.find((row) => row.dimension === 'client')?.blocked_key ?? null,
          },
        };
      });
    } catch (err) {
      this.logger.error('console could not open a report', dbErrorFields(err));
      throw err;
    }
  }

  /**
   * Record a verdict on a report.
   *
   * `TRIAGED` is not offered: a human who looked at a conversation reached a
   * conclusion, and a state that means "seen, decided nothing" is where a
   * queue goes to accumulate. Either it warranted action or it did not.
   */
  async resolveReport(
    reportId: string,
    outcome: 'ACTIONED' | 'DISMISSED',
    resolution: string,
    justification: string,
    identity: AdminIdentity,
    nowMs = Date.now(),
  ): Promise<boolean> {
    return this.db.transaction(async (client) => {
      const updated = await client.query(
        `update reports set state = $2, resolution = $3
          where report_id = $1 and state = 'OPEN'`,
        [reportId, outcome, resolution],
      );
      // Idempotent by state rather than by hope: a second verdict on a report
      // somebody else already closed changes nothing and says so, instead of
      // silently overwriting the first decision.
      if (updated.rowCount === 0) return false;

      await this.writeAudit(client, {
        action: outcome === 'ACTIONED' ? 'actioned_report' : 'dismissed_report',
        subjectType: 'report',
        subjectId: reportId,
        caseId: reportId,
        justification,
        identity,
        nowMs,
      });
      return true;
    });
  }

  /**
   * Append one audit row.
   *
   * Takes the executor rather than using `this.db` so it always runs inside
   * the caller's transaction. A helper that opened its own connection would
   * commit the audit row independently of the read it is supposed to describe,
   * which is the failure this design is built to avoid.
   */
  private async writeAudit(
    client: { query(text: string, values?: unknown[]): Promise<unknown> },
    entry: {
      action: string;
      subjectType: string;
      subjectId: string;
      caseId: string | null;
      justification: string;
      identity: AdminIdentity;
      nowMs: number;
    },
  ): Promise<void> {
    await client.query(
      `insert into admin_audit
         (audit_id, actor, role, action, subject_type, subject_id, case_id,
          justification, created_at, retention_expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        newAuditId(),
        entry.identity.accountId,
        entry.identity.role,
        entry.action,
        entry.subjectType,
        entry.subjectId,
        entry.caseId,
        entry.justification,
        new Date(entry.nowMs),
        // Stamped at insert time, like every other retention deadline (D17),
        // so changing the setting never retroactively extends or shortens the
        // life of a record already written.
        new Date(entry.nowMs + this.config.retention.days.adminAudit * 24 * 60 * 60 * 1000),
      ],
    );
  }
}
