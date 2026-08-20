/**
 * What the retention pipeline carries, and how its priority is decided.
 *
 * ---------------------------------------------------------------------------
 * PRIORITY IS ASSIGNED HERE AND NOWHERE ELSE (D27)
 * ---------------------------------------------------------------------------
 * Every class is derived from a signal the **server** produced: the fact that
 * the server generated a safety record at all, the moderation engine's own
 * output, or the conversation's report state read server-side. No client input
 * contributes, directly or indirectly. There is no field a client can set, no
 * header it can send and no message property it can choose that raises its own
 * durability priority.
 *
 * The one place this could go wrong is P1, which is derived from moderation
 * output — and moderation output *is* a function of what the client wrote. That
 * is exactly why the per-session quota inside each class exists (D26): a user
 * who deliberately trips a mild rule promotes their own traffic into P1, and
 * the quota bounds how much of that class they can take from everyone else.
 */
import type { RetentionPriority } from '../config';
import type { ModerationAction } from '../moderation';
import type { Profile } from '../protocol/types';

export interface ConversationStartedRecord {
  readonly kind: 'conversation_started';
  readonly conversationId: string;
  readonly sessionA: string;
  readonly sessionB: string;
  readonly segment: string;
  readonly startedAt: string;
  /**
   * What each side declared about themselves, or null.
   *
   * Stamped at match time rather than read later: the declaration lives on the
   * session, and the session is gone by the time anyone investigates. Unverified
   * claims, never identity (see migration 006).
   */
  readonly profileA: Profile | null;
  readonly profileB: Profile | null;
}

export interface ConversationEndedRecord {
  readonly kind: 'conversation_ended';
  readonly conversationId: string;
  readonly endedAt: string;
  readonly endReason: 'skip' | 'block' | 'disconnect' | 'reap' | 'shutdown';
}

export interface MessageRecord {
  readonly kind: 'message';
  readonly messageId: string;
  readonly conversationId: string;
  readonly senderSessionId: string;
  readonly serverTimestamp: string;
  readonly type: 'text';
  /** Plaintext application data (D15). Never logged, never a metric label (I8). */
  readonly body: string;
  readonly moderationAction: ModerationAction;
  /** Rule ids only. Never excerpts. */
  readonly moderationFlags: readonly string[];
}

export interface ReportRecord {
  readonly kind: 'report';
  readonly reportId: string;
  readonly conversationId: string;
  readonly reporterSessionId: string;
  readonly reportedSessionId: string;
  readonly category: string;
  /** The reporter's own words. Same protection class as a message body (I8). */
  readonly note: string | null;
  readonly createdAt: string;
}

export interface BlockRecord {
  readonly kind: 'block';
  readonly blockId: string;
  readonly blockerKey: string;
  readonly blockedKey: string;
  readonly dimension: 'ip' | 'client';
  readonly conversationId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ModerationEventRecord {
  readonly kind: 'moderation_event';
  readonly eventId: string;
  readonly conversationId: string | null;
  readonly messageId: string | null;
  readonly rule: string;
  readonly action: ModerationAction;
  readonly severity: 'low' | 'medium' | 'high';
  readonly createdAt: string;
}

export interface EnforcementRecord {
  readonly kind: 'enforcement';
  readonly enforcementId: string;
  readonly subjectKey: string;
  readonly action: 'warn' | 'ratelimit' | 'quarantine' | 'suspend' | 'ban';
  readonly reason: string;
  readonly source: 'automated' | 'moderator';
  readonly createdAt: string;
  readonly expiresAt: string | null;
}

export interface AdminAuditRecord {
  readonly kind: 'admin_audit';
  readonly auditId: string;
  readonly actor: string;
  readonly role: string;
  readonly action: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly caseId: string | null;
  readonly justification: string;
  readonly createdAt: string;
}

export type RetentionRecord =
  | ConversationStartedRecord
  | ConversationEndedRecord
  | MessageRecord
  | ReportRecord
  | BlockRecord
  | ModerationEventRecord
  | EnforcementRecord
  | AdminAuditRecord;

export type RecordKind = RetentionRecord['kind'];

/** A record on its way to the database, with everything the queue needs. */
export interface QueuedRecord {
  readonly record: RetentionRecord;
  readonly priority: RetentionPriority;
  /**
   * Whose quota this counts against. A conversation-level record uses one of
   * its participants; the point is a bound per actor, not perfect attribution.
   */
  readonly sessionId: string;
  readonly enqueuedAtMs: number;
  /**
   * How many times this record has been deferred waiting for a parent row that
   * another instance had not written yet (`isMissingParentError`). Absent means
   * zero. Bounded by `RETENTION_MISSING_PARENT_RETRIES`, so a genuinely orphaned
   * record is dropped and counted rather than retried forever.
   */
  readonly parentWaits?: number;
}

/** Signals available when a message is enqueued. All server-side. */
export interface MessagePriorityContext {
  readonly moderationAction: ModerationAction;
  /**
   * Whether the conversation already had an open report **at enqueue time**.
   * Read server-side, and never re-evaluated: a message enqueued before its
   * conversation was reported keeps its original priority (D27). Retroactive
   * promotion would mean scanning and rewriting queued entries, and would
   * duplicate what the report row already references.
   */
  readonly conversationReported: boolean;
}

/**
 * The class a record belongs to.
 *
 * Safety records are P0 because the server generated them at all — that is the
 * whole signal. Messages fall through the moderation and report signals to P3.
 */
export function priorityFor(
  record: RetentionRecord,
  context?: MessagePriorityContext,
): RetentionPriority {
  switch (record.kind) {
    case 'report':
    case 'block':
    case 'moderation_event':
    case 'enforcement':
    case 'admin_audit':
    case 'conversation_started':
    case 'conversation_ended':
      return 'p0';
    case 'message': {
      const action = context?.moderationAction ?? record.moderationAction;
      if (action !== 'allow') return 'p1';
      if (context?.conversationReported === true) return 'p2';
      return 'p3';
    }
    default: {
      // A new record kind must be given a class deliberately. Defaulting to P0
      // would let ordinary traffic into the safety budget; defaulting to P3
      // would silently make a safety record droppable. Neither is a decision
      // to make by accident, so the fallback is the lowest class and the
      // exhaustiveness check makes it a compile error first.
      const exhaustive: never = record;
      void exhaustive;
      return 'p3';
    }
  }
}

/** Which session's quota a record counts against. */
export function quotaSessionFor(record: RetentionRecord): string {
  switch (record.kind) {
    case 'message':
      return record.senderSessionId;
    case 'report':
      return record.reporterSessionId;
    case 'conversation_started':
      return record.sessionA;
    case 'conversation_ended':
      return record.conversationId;
    case 'block':
      return record.blockerKey;
    case 'moderation_event':
      return record.messageId ?? record.conversationId ?? record.eventId;
    case 'enforcement':
      return record.subjectKey;
    case 'admin_audit':
      return record.actor;
    default: {
      const exhaustive: never = record;
      void exhaustive;
      return 'unknown';
    }
  }
}
