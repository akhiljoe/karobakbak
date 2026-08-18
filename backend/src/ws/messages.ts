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
 * Moderation (§14.2) belongs between the dedupe and the delivery, and the
 * retention enqueue (§14.3) after the ack. Neither exists yet; both slot into
 * this sequence without moving anything already here.
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
      delivered: boolean;
    }
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

    // Delivery cannot fail the send: the dedupe entry is already written, so
    // unwinding here would leave an id burnt for a message nobody has. A
    // dropped frame costs the partner one message they can no longer be shown
    // — which is exactly what `message_ack` refuses to promise (D14).
    await this.dispatcher.toSession(
      resolved.partnerSessionId,
      { event: 'message', matchId: resolved.matchId, messageId, contentType, text, sentAt },
      sentAt,
    );

    return {
      kind: 'accepted',
      messageId,
      matchId: resolved.matchId,
      acceptedAt: sentAt,
      route: resolved.partnerInstanceId === this.config.instanceId ? 'local' : 'remote',
      // Always true until the moderation policy exists; a withheld message
      // will report false here rather than as an error (D20).
      delivered: true,
    };
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
