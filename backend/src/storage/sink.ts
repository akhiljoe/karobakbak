/**
 * The seam between the chat path and the retention pipeline.
 *
 * The chat path depends on this interface, not on `RetentionWriter`. Two
 * reasons, both practical: the lifecycle and the message pipeline can be tested
 * without a database, and the dependency is narrow enough that nothing on the
 * chat path can accidentally reach a method that blocks. There is no `flush`
 * here, no `await`, and no way to ask whether a record was written — because
 * the answer would tempt somebody to wait for it (D16).
 */
import type { MessagePriorityContext, RetentionRecord } from './records';
import type { EnqueueResult } from './retention';

export interface RetentionSink {
  /**
   * Accept a record for eventual persistence. Synchronous, non-blocking, and
   * never throws.
   *
   * A `false` result means the record was refused. For a P0 record the caller
   * **must** fail the client operation that produced it: acknowledging a report
   * the system could not record would be a lie to a user asking for help
   * (§14.3).
   */
  enqueue(record: RetentionRecord, context?: MessagePriorityContext): EnqueueResult;

  /**
   * Whether this conversation already has an open report.
   *
   * Read server-side and used only to assign priority (P2). It is deliberately
   * a cheap in-memory answer rather than a database round trip: this is on the
   * message path, and the priority of a retention row is never worth a query
   * that chat would wait for. A conversation reported after a message was
   * enqueued leaves that message at its original priority, which is exactly
   * what D27 requires — no retroactive promotion.
   */
  isConversationReported(conversationId: string): boolean;
}

/** Accepts everything and keeps nothing. Used when retention is disabled. */
export class NullRetentionSink implements RetentionSink {
  enqueue(): EnqueueResult {
    return { accepted: true };
  }

  isConversationReported(): boolean {
    return false;
  }
}
