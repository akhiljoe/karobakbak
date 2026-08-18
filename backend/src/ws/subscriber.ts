/**
 * The receiving half of cross-instance delivery (§11).
 *
 * One subscription per live session, on `chat:ev:session:{sid}`. The channel
 * name is the routing key, so resolving an inbound event is
 * `channel → sessionId → local socket` with no table in between and nothing
 * that can go stale (D8).
 *
 * ---------------------------------------------------------------------------
 * SUBSCRIBE BEFORE THE SESSION EXISTS
 * ---------------------------------------------------------------------------
 * The subscription is taken out *before* the session row is created, so there
 * is no window in which a session is matchable but its instance is not
 * listening. Getting that order wrong loses the `matched` event of exactly the
 * users who were quickest, which is the hardest kind of bug to reproduce.
 */
import type { Redis } from 'ioredis';

import type { Logger } from '../logger';
import { encodeFrame } from '../protocol/envelope';
import { CLOSE_CODES } from '../protocol/types';
import type { RedisKeys } from '../redis/keys';
import { decodeSessionEvent, toClientFrame } from './events';
import type { ConnectionRegistry } from './registry';

export class SessionSubscriber {
  constructor(
    private readonly subscriber: Redis,
    private readonly keys: RedisKeys,
    private readonly registry: ConnectionRegistry,
    private readonly logger: Logger,
  ) {
    this.subscriber.on('message', (channel: string, payload: string) => {
      this.deliver(channel, payload);
    });
  }

  /** Listen for one session's events. Call before creating the session row. */
  async subscribe(sessionId: string): Promise<void> {
    await this.subscriber.subscribe(this.keys.sessionChannel(sessionId));
  }

  /**
   * Stop listening. Failures are swallowed: the socket is already gone, the
   * subscription costs one Redis channel until the connection drops anyway,
   * and throwing here would break a close handler that must always complete.
   */
  async unsubscribe(sessionId: string): Promise<void> {
    try {
      await this.subscriber.unsubscribe(this.keys.sessionChannel(sessionId));
    } catch (err) {
      this.logger.debug('unsubscribe failed', {
        sessionId,
        errName: err instanceof Error ? err.name : 'unknown',
      });
    }
  }

  private deliver(channel: string, payload: string): void {
    const sessionId = this.keys.sessionIdFromChannel(channel);
    if (sessionId === null) return;

    const connection = this.registry.get(sessionId);
    // Not an error: the socket can close between a publish and its arrival.
    // Every event reports state already committed in Redis, so the worst case
    // is one update nobody needed (§11).
    if (!connection || !connection.isOpen) return;

    const event = decodeSessionEvent(payload);
    if (event === null) {
      // A newer instance's event during a rolling deploy, or a corrupt payload.
      // Dropped rather than thrown on: this runs on a shared connection whose
      // listener must survive anything published to it.
      this.logger.warn('dropped an unrecognised session event', { sessionId });
      return;
    }

    if (event.event === 'session_evicted') {
      // There is no session left to tell anything to. The socket is closed so
      // the client reconnects into a fresh one — there is no resumption (D7).
      connection.close(
        event.reason === 'shutdown' ? CLOSE_CODES.GOING_AWAY : CLOSE_CODES.SESSION_GONE,
        event.reason,
      );
      return;
    }

    const frame = toClientFrame(event);
    if (frame !== null) connection.send(encodeFrame(frame));
  }
}
