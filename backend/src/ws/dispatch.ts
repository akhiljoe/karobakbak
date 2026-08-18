/**
 * Delivering a session event to whichever instance owns the socket.
 *
 * Local first (D9): if the recipient's socket is attached to this process the
 * event becomes a frame immediately, with no Redis hop. Otherwise it is
 * published to the recipient's channel and the instance subscribed to that
 * channel — by definition the one holding the socket — turns it into a frame.
 *
 * ---------------------------------------------------------------------------
 * DROPPING IS A DESIGNED OUTCOME
 * ---------------------------------------------------------------------------
 * Redis Pub/Sub is a transient bus, not a durable log. A publish with no
 * subscriber is lost, and that is correct here: every event reports state
 * already committed in Redis, so a lost notification costs at most one stale UI
 * label, and the client's next action re-reads authoritative state. Streams
 * would buy durability at the price of trimming policy, consumer-group
 * lifecycle and per-session cursors — unjustified for notifications about
 * ephemeral state (§11).
 *
 * The `route` a delivery took is returned rather than logged here, so the
 * caller can label a metric with it. Both paths are exercised in production and
 * the label is how that stays true.
 */
import { encodeFrame } from '../protocol/envelope';
import type { Logger } from '../logger';
import { encodeSessionEvent, toClientFrame, type SessionEvent } from './events';
import type { ConnectionRegistry } from './registry';

export type DeliveryRoute = 'local' | 'remote' | 'dropped';

/** The part of the Redis store this module needs. */
export interface EventPublisher {
  publishToSession(sessionId: string, payload: string): Promise<number>;
}

export class EventDispatcher {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger,
  ) {}

  /**
   * Send one event to one session.
   *
   * Never throws: a delivery failure must not fail the transition that produced
   * the event, which has already been committed to Redis. A `matched` that
   * cannot be delivered still leaves a real match that the client will discover
   * on its next action.
   */
  async toSession(sessionId: string, event: SessionEvent, at: string): Promise<DeliveryRoute> {
    const local = this.registry.get(sessionId);
    if (local && local.isOpen) {
      return this.deliverLocally(sessionId, event, local.send.bind(local));
    }

    try {
      const receivers = await this.publisher.publishToSession(
        sessionId,
        encodeSessionEvent(event, at),
      );
      return receivers > 0 ? 'remote' : 'dropped';
    } catch (err) {
      // The event is gone, and that is survivable; the transition is not
      // rolled back. Logged with the event NAME only — a `message` event
      // carries user text, and this is a log line (I8).
      this.logger.warn('failed to publish a session event', {
        sessionId,
        sessionEvent: event.event,
        errName: err instanceof Error ? err.name : 'unknown',
      });
      return 'dropped';
    }
  }

  private deliverLocally(
    sessionId: string,
    event: SessionEvent,
    send: (frame: string) => boolean,
  ): DeliveryRoute {
    const frame = toClientFrame(event);
    if (frame === null) {
      // `session_evicted` has no client frame: the socket gets closed by the
      // caller instead of being told about a session that no longer exists.
      return 'local';
    }
    const sent = send(encodeFrame(frame));
    if (!sent) {
      this.logger.warn('local socket refused a session event', {
        sessionId,
        sessionEvent: event.event,
      });
      return 'dropped';
    }
    return 'local';
  }
}
