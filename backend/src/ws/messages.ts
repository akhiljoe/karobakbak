/**
 * The message pipeline (§14.1).
 *
 * Everything before this point is transport: a frame arrived, it was the right
 * size, it parsed, it validated. Everything after is delivery. This module is
 * the part in between — the part that decides a message is real, is not a
 * replay, and has somewhere to go.
 *
 * ---------------------------------------------------------------------------
 * THE ORDER IS THE CONTRACT
 * ---------------------------------------------------------------------------
 *   rate limit → resolve partner + dedupe → deliver → ack
 *
 * The rate limit comes first because it is the cheapest way to say no, and
 * because a limit applied after the work has been done is not a limit. The
 * dedupe check is inseparable from resolving the partner — they are one script,
 * so two concurrent copies of the same frame cannot both pass (§10.17, I14).
 * The ack comes last, because acknowledging before routing would be a claim we
 * have not yet earned.
 *
 * Moderation (§14.2) sits between the dedupe and the delivery, and is entered
 * by content-type dispatch rather than as a call on the text (§23.5). The
 * retention enqueue (§14.3) belongs after the ack and does not exist yet.
 *
 * ---------------------------------------------------------------------------
 * WHAT `route` MEANS
 * ---------------------------------------------------------------------------
 * `route` reports **where the partner's socket is**, not whether the frame
 * arrived: it is derived from the partner's instance id, not from the delivery
 * attempt. `message_ack` has always meant "accepted and routed" and never
 * "received" (D14) — a client that showed a delivery receipt from this field
 * would be showing something the server never promised.
 */
import type { Config } from '../config';
import type { Logger } from '../logger';
import type { RateLimitResult, ResolveRouteResult } from '../redis/store';
import type { ResolvePartnerResult } from '../redis/store';
import type { RateLimitedCommand } from '../config';
import { newMessageId } from '../util/ids';
import { nowIso } from '../util/time';
import { moderate } from '../moderation';
import { newMessageId as newRecordId } from '../util/ids';
import type { RetentionSink } from '../storage/sink';
import type { EventDispatcher } from './dispatch';
import type { MessageContentType } from '../protocol/types';

/** The part of the store this pipeline needs. */
export interface MessageStore {
  rateLimit(command: RateLimitedCommand, sessionId: string, cost?: number): Promise<RateLimitResult>;
  resolvePartner(sessionId: string, clientMsgId: string): Promise<ResolvePartnerResult>;
  resolveRoute(sessionId: string): Promise<ResolveRouteResult>;
}

export type MessageOutcome =
  | {
      kind: 'accepted';
      messageId: string;
      matchId: string;
      acceptedAt: string;
      route: 'local' | 'remote';
      /** False when policy withheld it: accepted and recorded, not handed on (D20). */
      delivered: boolean;
      /** Rule ids that fired. Never carries user text. */
      flags: readonly string[];
    }
  /** Refused outright by the hard rule set. */
  | { kind: 'withheld'; matchId: string; flags: readonly string[] }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'not_matched' }
  | { kind: 'duplicate' }
  /** The replay-protection set is full. Refused rather than delivered undeduplicated. */
  | { kind: 'dedupe_full' };

export type TypingOutcome =
  | { kind: 'sent' }
  | { kind: 'rate_limited'; retryAfterMs: number }
  | { kind: 'not_matched' }
  /** The partner's socket is gone. Advisory traffic, so this is not an error. */
  | { kind: 'no_partner' };

export class MessagePipeline {
  constructor(
    private readonly store: MessageStore,
    private readonly dispatcher: EventDispatcher,
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly retention: RetentionSink,
  ) {}

  /**
   * Preserves I14 (a repeated client id is rejected, not delivered twice) and
   * I6 (a deleted match cannot deliver).
   */
  async send(
    sessionId: string,
    clientMsgId: string,
    contentType: MessageContentType,
    text: string,
  ): Promise<MessageOutcome> {
    const limit = await this.store.rateLimit('message', sessionId);
    if (!limit.allowed) {
      return { kind: 'rate_limited', retryAfterMs: limit.retryAfterMs };
    }

    const resolved = await this.store.resolvePartner(sessionId, clientMsgId);
    switch (resolved.status) {
      case 'not_matched':
        return { kind: 'not_matched' };
      case 'duplicate':
        return { kind: 'duplicate' };
      case 'dedupe_full':
        // The sender has been going at maximum rate long enough to fill the
        // set. Refusing keeps replay protection true; accepting would not.
        this.logger.warn('refusing a message: replay-protection set is full', {
          sessionId,
          matchId: resolved.matchId,
        });
        return { kind: 'dedupe_full' };
      case 'partner_gone':
        // The partner's session expired between their last frame and this one.
        // There is nobody to deliver to, and no conversation to be in.
        return { kind: 'not_matched' };
      case 'ok':
        break;
    }

    const messageId = newMessageId();
    const sentAt = nowIso();

    // Entered by content type, never as a direct call on the text (§23.5), so
    // no content can reach delivery without a decision having been made about
    // it. A type this build cannot judge fails closed inside `moderate`.
    const verdict = moderate({ type: contentType, text }, this.config.moderation);
    const route: 'local' | 'remote' =
      resolved.partnerInstanceId === this.config.instanceId ? 'local' : 'remote';

    if (verdict.action === 'block') {
      // The hard rule set only. The sender is told plainly rather than being
      // left to believe a delivered message vanished.
      this.logger.info('message blocked by policy', {
        sessionId,
        matchId: resolved.matchId,
        messageId,
        moderationFlags: verdict.flags,
        moderationSeverity: verdict.severity,
      });
      // Retained *before* returning, and this is the branch where it matters
      // most. A hard block is the highest-confidence, highest-severity match
      // the policy engine makes — precisely the evidence a moderator needs and
      // the record that says why the message never arrived. Returning above the
      // `persist()` below meant the most serious abuse in the system was the
      // only kind that left nothing behind: no `messages` row, no
      // `moderation_event`, nothing to attach to a report or an enforcement
      // decision. Delivery is still refused; only the record changes.
      this.persist(sessionId, resolved.matchId, messageId, sentAt, contentType, text, verdict);
      return { kind: 'withheld', matchId: resolved.matchId, flags: verdict.flags };
    }

    if (verdict.deliverable) {
      // Delivery cannot fail the send: the dedupe entry is already written, so
      // unwinding here would leave an id burnt for a message nobody has. A
      // dropped frame costs the partner one message they can no longer be
      // shown — exactly what `message_ack` refuses to promise (D14).
      await this.dispatcher.toSession(
        resolved.partnerSessionId,
        { event: 'message', matchId: resolved.matchId, messageId, contentType, text, sentAt },
        sentAt,
      );
    }

    if (verdict.flags.length > 0) {
      // Rule ids and a severity, never the text or the matched substring: this
      // line is the shape a `moderation_events` row will take, and the matched
      // fragment is the part of a message most likely to be personal (I8).
      this.logger.info('message flagged by policy', {
        sessionId,
        matchId: resolved.matchId,
        messageId,
        moderationAction: verdict.action,
        moderationFlags: verdict.flags,
        moderationSeverity: verdict.severity,
        delivered: verdict.deliverable,
      });
    }

    // After the ack decision is made, never before it (§14.1). Retention is
    // write-behind and best-effort; the conversation does not depend on it.
    this.persist(sessionId, resolved.matchId, messageId, sentAt, contentType, text, verdict);

    return {
      kind: 'accepted',
      messageId,
      matchId: resolved.matchId,
      acceptedAt: sentAt,
      route,
      // A withheld message was accepted and recorded but not handed on. The
      // sender is told through the ack rather than through an error, because
      // the frame was valid and there is nothing to retry (D20).
      delivered: verdict.deliverable,
      flags: verdict.flags,
    };
  }

  /**
   * Hand the message and its moderation signals to the retention pipeline.
   *
   * Enqueueing is synchronous and cannot fail the send: a full queue drops the
   * record, counts it and alerts, and the conversation carries on. Losing a
   * retention row is a storage incident; refusing to carry the conversation
   * would turn it into an outage (§14.3).
   */
  private persist(
    sessionId: string,
    matchId: string,
    messageId: string,
    sentAt: string,
    contentType: MessageContentType,
    text: string,
    verdict: { action: ReturnType<typeof moderate>['action']; flags: readonly string[]; severity: 'low' | 'medium' | 'high' | null },
  ): void {
    this.retention.enqueue(
      {
        kind: 'message',
        messageId,
        conversationId: matchId,
        senderSessionId: sessionId,
        serverTimestamp: sentAt,
        type: contentType,
        body: text,
        moderationAction: verdict.action,
        moderationFlags: verdict.flags,
      },
      // Both signals are the server's own: the moderation engine's output, and
      // the conversation's report state read server-side (D27).
      {
        moderationAction: verdict.action,
        conversationReported: this.retention.isConversationReported(matchId),
      },
    );

    // One row per rule that fired, so triage can ask "which rule" without
    // reading any message body.
    for (const rule of verdict.flags) {
      this.retention.enqueue({
        kind: 'moderation_event',
        eventId: newRecordId(),
        conversationId: matchId,
        messageId,
        rule,
        action: verdict.action,
        severity: verdict.severity ?? 'low',
        createdAt: sentAt,
      });
    }
  }

  /**
   * A typing indicator. Fire and forget, and deliberately not deduplicated:
   * routing it through the replay-protection path would consume one message id
   * per keystroke and let a client exhaust its own dedupe set by typing.
   */
  async typing(sessionId: string, active: boolean): Promise<TypingOutcome> {
    const limit = await this.store.rateLimit('typing', sessionId);
    if (!limit.allowed) {
      return { kind: 'rate_limited', retryAfterMs: limit.retryAfterMs };
    }

    const route = await this.store.resolveRoute(sessionId);
    if (route.status === 'not_matched') return { kind: 'not_matched' };
    if (route.status === 'partner_gone') return { kind: 'no_partner' };

    await this.dispatcher.toSession(
      route.partnerSessionId,
      { event: 'partner_typing', matchId: route.matchId, active },
      nowIso(),
    );
    return { kind: 'sent' };
  }
}
