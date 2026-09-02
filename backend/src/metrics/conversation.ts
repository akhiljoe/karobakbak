/**
 * What each locally-attached session did inside its current conversation.
 *
 * The funnel's `spoke` and `conversed` steps, the time from being matched to
 * this side's first message, and how many messages this side sent before the
 * conversation ended.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS PER SESSION RATHER THAN PER CONVERSATION
 * ---------------------------------------------------------------------------
 * A conversation spans two instances. Counting *its* messages would need either
 * an `HINCRBY` on the match hash for every message — a Redis round trip added
 * to the hottest path in the system, for a metric — or a wider positional reply
 * from `endMatch`, which is shared machinery around the most race-tested code
 * here. Neither is a trade worth making for observability.
 *
 * Counting per side needs neither. Each instance sees every message its own
 * sockets send, so each tally is complete for the session it describes, and the
 * sum across instances is exact rather than approximate.
 *
 * It is also the better measurement. The sum of the two sides is the
 * conversation total, so nothing is lost — and the two sides *apart* say
 * something the total cannot: one side at zero is somebody who was ignored,
 * which a conversation-level count of five messages hides completely.
 *
 * ---------------------------------------------------------------------------
 * WHEN A TALLY IS OBSERVED
 * ---------------------------------------------------------------------------
 * Not when the conversation ends. A conversation ends once, reported by
 * whichever side won the termination race (D6), and that side is not
 * necessarily this instance — so hanging the observation off the end would
 * record one side of some conversations and neither side of others.
 *
 * Instead a tally is flushed when it is *replaced* (this session matched again)
 * or when the socket closes. Every session reaches one of those: a person who
 * skips flushes on the next match, and a person who closes the tab flushes on
 * the close. The cost is that the last conversation of a long idle session is
 * observed late, which for a histogram is not a cost at all.
 *
 * Bounded by the sockets this instance holds, the same as `searchStartedAt` in
 * `server.ts`: an entry appears on a match and is removed on the next match or
 * on close.
 */
import { CONVERSED_MESSAGE_THRESHOLD } from './registry';

/** What a tally reports. Kept as callbacks so this file writes no metric itself. */
export interface ConversationObserver {
  /** This side sent its first message, `seconds` after being matched. */
  spoke(seconds: number): void;
  /** This side reached `CONVERSED_MESSAGE_THRESHOLD` messages. */
  conversed(): void;
  /** A conversation this side was in is over; it sent `messages` of them. */
  finished(messages: number): void;
}

interface Tally {
  /** Monotonic milliseconds, for the first-message latency. */
  readonly matchedAt: number;
  sent: number;
}

/**
 * Milliseconds from a monotonic clock.
 *
 * Injected rather than read directly so a test can advance it, and monotonic
 * rather than wall-clock because a duration measured across a clock adjustment
 * is not a duration.
 */
export type MonotonicClock = () => number;

export class ConversationTally {
  private readonly open = new Map<string, Tally>();

  constructor(
    private readonly observer: ConversationObserver,
    private readonly now: MonotonicClock,
  ) {}

  /**
   * This session is now in a conversation.
   *
   * Flushes whatever it was in before. A session matching again without its
   * previous conversation having been flushed is the ordinary case — a skip —
   * not an error.
   */
  matched(sessionId: string): void {
    this.flush(sessionId);
    this.open.set(sessionId, { matchedAt: this.now(), sent: 0 });
  }

  /**
   * This session sent a message that was accepted.
   *
   * A message from a session with no open tally is not counted and is not an
   * error: it is a message accepted in a conversation that began before this
   * socket attached, which is exactly what a resumption is (§28, D42). Counting
   * it would put a first-message latency in the histogram measured from a match
   * this instance never saw.
   */
  sent(sessionId: string): void {
    const tally = this.open.get(sessionId);
    if (tally === undefined) return;

    tally.sent += 1;
    if (tally.sent === 1) {
      this.observer.spoke((this.now() - tally.matchedAt) / 1000);
    }
    // Exactly on the threshold, never above it, so a long conversation counts
    // once rather than on every message after the fifth.
    if (tally.sent === CONVERSED_MESSAGE_THRESHOLD) {
      this.observer.conversed();
    }
  }

  /** The socket is gone. Flushes anything still open. */
  closed(sessionId: string): void {
    this.flush(sessionId);
  }

  /** Open tallies, for the test that asserts nothing is retained after a close. */
  get size(): number {
    return this.open.size;
  }

  private flush(sessionId: string): void {
    const tally = this.open.get(sessionId);
    if (tally === undefined) return;
    this.open.delete(sessionId);
    // Zero is observed deliberately: "matched and never spoke" is the bounce,
    // and it is the most useful single number this file produces. Skipping it
    // would leave the histogram describing only the conversations that worked.
    this.observer.finished(tally.sent);
  }
}
