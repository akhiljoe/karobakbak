/**
 * Turning records into rows.
 *
 * ---------------------------------------------------------------------------
 * RETENTION DEADLINES ARE STAMPED HERE, AT INSERT TIME (D17, I9)
 * ---------------------------------------------------------------------------
 * `retention_expires_at` is computed from configuration **at the moment the row
 * is written**, never from a database default and never recomputed at deletion
 * time. That is what makes a later configuration change unable to retroactively
 * extend the life of data already stored: shortening the policy affects new
 * rows, and reaching the old ones is a deliberate, explicit operation rather
 * than a side effect of editing an environment variable.
 *
 * ---------------------------------------------------------------------------
 * EVERY VALUE IS A BOUND PARAMETER
 * ---------------------------------------------------------------------------
 * Message bodies and report notes are attacker-controlled text. Nothing here
 * interpolates a value into SQL; the batch builders generate placeholders and
 * hand the values to the driver. A `pg` error is never logged as an object,
 * because the driver echoes parameters — and the parameters here are the
 * conversation (§8, I8).
 */
import type { PoolClient } from 'pg';

import type { Config } from '../config';
import type { Database } from './pool';
import type {
  AdminAuditRecord,
  BlockRecord,
  ConversationEndedRecord,
  ConversationStartedRecord,
  EnforcementRecord,
  MessageRecord,
  ModerationEventRecord,
  QueuedRecord,
  ReportRecord,
  RetentionRecord,
} from './records';

/**
 * Anything that can run a parameterised statement: the pool, or a client
 * already inside a transaction. Structural rather than a union of the two
 * concrete types, whose overload sets do not agree.
 */
export interface SqlExecutor {
  query(text: string, values?: unknown[]): Promise<unknown>;
}

type Executor = SqlExecutor;

function expiryFrom(nowMs: number, days: number): Date {
  return new Date(nowMs + days * 24 * 60 * 60 * 1000);
}

/**
 * Build `($1,$2,...),($3,$4,...)` for a multi-row insert.
 *
 * One statement per batch rather than one per row: the write-behind path exists
 * to keep database work off the chat path, and a hundred round trips would
 * spend the latency it was built to avoid.
 */
function placeholders(rowCount: number, columns: number): string {
  const rows: string[] = [];
  for (let row = 0; row < rowCount; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(`$${row * columns + column + 1}`);
    }
    rows.push(`(${cells.join(',')})`);
  }
  return rows.join(',');
}

export class Repositories {
  constructor(private readonly config: Config) {}

  /**
   * Write one batch of mixed records.
   *
   * Grouped by kind and inserted one statement per table, inside a single
   * transaction: a batch either lands or does not, so a retry after a failure
   * cannot half-apply. Conversations are inserted before anything that
   * references them.
   */
  async writeBatch(db: Database, entries: readonly QueuedRecord[], nowMs = Date.now()): Promise<void> {
    if (entries.length === 0) return;
    const byKind = groupByKind(entries.map((entry) => entry.record));

    await db.transaction(async (client) => {
      // Order matters: `messages` and `reports` carry foreign keys into
      // `conversations`.
      await this.insertConversations(client, byKind.conversation_started, nowMs);
      await this.updateConversations(client, byKind.conversation_ended);
      await this.insertMessages(client, byKind.message, nowMs);
      await this.insertReports(client, byKind.report, nowMs);
      await this.insertBlocks(client, byKind.block);
      await this.insertModerationEvents(client, byKind.moderation_event, nowMs);
      await this.insertEnforcement(client, byKind.enforcement, nowMs);
      await this.insertAdminAudit(client, byKind.admin_audit, nowMs);
    });
  }

  async insertConversations(
    db: Executor,
    records: readonly ConversationStartedRecord[],
    nowMs: number,
  ): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.conversationId,
        record.sessionA,
        record.sessionB,
        record.segment,
        record.startedAt,
        expiryFrom(nowMs, this.config.retention.days.conversation),
        // Serialised here rather than by the driver so a null declaration is a
        // SQL null instead of the JSON string "null", which reads as a declared
        // value in every query someone writes later.
        record.profileA === null ? null : JSON.stringify(record.profileA),
        record.profileB === null ? null : JSON.stringify(record.profileB),
      );
    }
    await db.query(
      `insert into conversations
         (conversation_id, session_a, session_b, segment, started_at, retention_expires_at,
          profile_a, profile_b)
       values ${placeholders(records.length, 8)}
       on conflict (conversation_id) do nothing`,
      values,
    );
  }

  /**
   * Close a conversation.
   *
   * `end_reason` is written once, by whoever won the termination race (D6), so
   * a second attempt must not overwrite the first — a `coalesce` keeps the
   * original reason rather than the reason of whatever arrived last.
   */
  async updateConversations(db: Executor, records: readonly ConversationEndedRecord[]): Promise<void> {
    for (const record of records) {
      await db.query(
        `update conversations
            set ended_at = coalesce(ended_at, $2),
                end_reason = coalesce(end_reason, $3)
          where conversation_id = $1`,
        [record.conversationId, record.endedAt, record.endReason],
      );
    }
  }

  async insertMessages(db: Executor, records: readonly MessageRecord[], nowMs: number): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.messageId,
        record.conversationId,
        record.senderSessionId,
        record.serverTimestamp,
        record.type,
        record.body,
        // Stored so telemetry, cost modelling and abuse heuristics never need
        // to read the body.
        [...record.body].length,
        record.moderationAction,
        JSON.stringify(record.moderationFlags),
        expiryFrom(nowMs, this.config.retention.days.conversation),
      );
    }
    await db.query(
      `insert into messages
         (message_id, conversation_id, sender_session_id, server_timestamp, type, body,
          char_length, moderation_action, moderation_flags, retention_expires_at)
       values ${placeholders(records.length, 10)}
       on conflict (message_id) do nothing`,
      values,
    );
  }

  /**
   * Insert a report and extend what it references.
   *
   * The extension happens in the same transaction as the insert, which is what
   * makes the deletion worker safe to run concurrently: a conversation being
   * reported is either not yet selected for deletion or already re-protected
   * (§10.19).
   */
  async insertReports(db: Executor, records: readonly ReportRecord[], nowMs: number): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.reportId,
        record.conversationId,
        record.reporterSessionId,
        record.reportedSessionId,
        record.category,
        record.note,
        record.createdAt,
        expiryFrom(nowMs, this.config.retention.days.report),
      );
    }
    await db.query(
      `insert into reports
         (report_id, conversation_id, reporter_session_id, reported_session_id,
          category, note, created_at, retention_expires_at)
       values ${placeholders(records.length, 8)}
       on conflict (report_id) do nothing`,
      values,
    );

    const reportedExpiry = expiryFrom(nowMs, this.config.retention.days.reported);
    const conversationIds = [...new Set(records.map((record) => record.conversationId))];
    // `greatest` so a report never *shortens* a deadline another report already
    // extended.
    await db.query(
      `update conversations
          set retention_expires_at = greatest(retention_expires_at, $2)
        where conversation_id = any($1::text[])`,
      [conversationIds, reportedExpiry],
    );
    await db.query(
      `update messages
          set retention_expires_at = greatest(retention_expires_at, $2)
        where conversation_id = any($1::text[])`,
      [conversationIds, reportedExpiry],
    );
  }

  async insertBlocks(db: Executor, records: readonly BlockRecord[]): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.blockId,
        record.blockerKey,
        record.blockedKey,
        record.dimension,
        record.blockerAccountId,
        record.conversationId,
        record.createdAt,
        record.expiresAt,
      );
    }
    await db.query(
      `insert into blocks
         (block_id, blocker_key, blocked_key, dimension, blocker_account_id,
          conversation_id, created_at, expires_at)
       values ${placeholders(records.length, 8)}
       on conflict (block_id) do nothing`,
      values,
    );
  }

  async insertModerationEvents(
    db: Executor,
    records: readonly ModerationEventRecord[],
    nowMs: number,
  ): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.eventId,
        record.conversationId,
        record.messageId,
        record.rule,
        record.action,
        record.severity,
        record.createdAt,
        expiryFrom(nowMs, this.config.retention.days.moderationEvent),
      );
    }
    await db.query(
      `insert into moderation_events
         (event_id, conversation_id, message_id, rule, action, severity,
          created_at, retention_expires_at)
       values ${placeholders(records.length, 8)}
       on conflict (event_id) do nothing`,
      values,
    );
  }

  async insertEnforcement(
    db: Executor,
    records: readonly EnforcementRecord[],
    nowMs: number,
  ): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.enforcementId,
        record.subjectKey,
        record.action,
        record.reason,
        record.source,
        record.createdAt,
        record.expiresAt,
        expiryFrom(nowMs, this.config.retention.days.enforcement),
      );
    }
    await db.query(
      `insert into enforcement
         (enforcement_id, subject_key, action, reason, source, created_at,
          expires_at, retention_expires_at)
       values ${placeholders(records.length, 8)}
       on conflict (enforcement_id) do nothing`,
      values,
    );
  }

  async insertAdminAudit(
    db: Executor,
    records: readonly AdminAuditRecord[],
    nowMs: number,
  ): Promise<void> {
    if (records.length === 0) return;
    const values: unknown[] = [];
    for (const record of records) {
      values.push(
        record.auditId,
        record.actor,
        record.role,
        record.action,
        record.subjectType,
        record.subjectId,
        record.caseId,
        record.justification,
        record.createdAt,
        expiryFrom(nowMs, this.config.retention.days.adminAudit),
      );
    }
    await db.query(
      `insert into admin_audit
         (audit_id, actor, role, action, subject_type, subject_id, case_id,
          justification, created_at, retention_expires_at)
       values ${placeholders(records.length, 10)}
       on conflict (audit_id) do nothing`,
      values,
    );
  }
}

interface GroupedRecords {
  conversation_started: ConversationStartedRecord[];
  conversation_ended: ConversationEndedRecord[];
  message: MessageRecord[];
  report: ReportRecord[];
  block: BlockRecord[];
  moderation_event: ModerationEventRecord[];
  enforcement: EnforcementRecord[];
  admin_audit: AdminAuditRecord[];
}

function groupByKind(records: readonly RetentionRecord[]): GroupedRecords {
  const grouped: GroupedRecords = {
    conversation_started: [],
    conversation_ended: [],
    message: [],
    report: [],
    block: [],
    moderation_event: [],
    enforcement: [],
    admin_audit: [],
  };
  for (const record of records) {
    switch (record.kind) {
      case 'conversation_started':
        grouped.conversation_started.push(record);
        break;
      case 'conversation_ended':
        grouped.conversation_ended.push(record);
        break;
      case 'message':
        grouped.message.push(record);
        break;
      case 'report':
        grouped.report.push(record);
        break;
      case 'block':
        grouped.block.push(record);
        break;
      case 'moderation_event':
        grouped.moderation_event.push(record);
        break;
      case 'enforcement':
        grouped.enforcement.push(record);
        break;
      case 'admin_audit':
        grouped.admin_audit.push(record);
        break;
      default: {
        const exhaustive: never = record;
        void exhaustive;
      }
    }
  }
  return grouped;
}
