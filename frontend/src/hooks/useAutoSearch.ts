/**
 * Look for the next stranger automatically, when the last one left.
 *
 * ---------------------------------------------------------------------------
 * WHICH ENDINGS QUALIFY, AND WHY THE OTHERS DO NOT
 * ---------------------------------------------------------------------------
 * Only `partner_left`. The rest are deliberate exclusions, not oversights:
 *
 *   `you_blocked`      — blocking says "not this, and not again". Dropping the
 *                        blocker into a fresh conversation three seconds later
 *                        contradicts what they just did, which is the same
 *                        reasoning that already makes `block` land in IDLE
 *                        rather than back in the queue.
 *   `you_skipped`      — the server re-queues a skip itself, so the screen
 *                        never reaches `ended` and there is nothing to advance.
 *   `server_shutdown`  — the client is reconnecting; joining a queue on a
 *                        socket that is going away achieves nothing.
 *   leaving on purpose — `user_left` goes to `idle`, and a person who chose to
 *                        stop is the last person who should be re-matched.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COUNTDOWN IS NOT ALWAYS THREE SECONDS
 * ---------------------------------------------------------------------------
 * `join_queue` is rate limited: burst 5, refilling one token per five seconds.
 * A three-second auto-advance is faster than that refill, so a run of
 * abandonments would exhaust the bucket and the next join would be refused.
 *
 * Raising the limit was the wrong fix — a cheaper way to cycle through
 * strangers is precisely what a spammer wants. So the countdown starts at three
 * seconds, and after a refusal it waits longer instead of retrying into the
 * same refusal. The user sees a longer countdown rather than an error, and the
 * limiter keeps meaning what it says.
 *
 * Skipping does not spend a token, so the ordinary rhythm of "skip, skip, skip"
 * never touches this at all.
 */
import { useEffect, useRef, useState } from 'react';

import type { ChatState } from '../state/machine';

/** The nominal pause: long enough to read "the stranger left", short enough to feel automatic. */
export const AUTO_SEARCH_DELAY_MS = 3000;

/**
 * How long to wait after the server refused a join.
 *
 * Comfortably above the token refill so the retry is not refused again. Not
 * read from server config on purpose: the client does not know the bucket, and
 * a number copied from the backend here would rot silently the day someone
 * tunes it. Being slightly too patient costs one countdown; being too eager
 * costs the feature.
 */
const BACKOFF_MS = 6000;

export interface AutoSearchApi {
  /** Seconds left, or null when no countdown is running. */
  readonly secondsLeft: number | null;
  /** Stop the countdown. The user stays on the ended screen. */
  cancel(): void;
}

export function useAutoSearch(options: {
  state: ChatState;
  enabled: boolean;
  onSearch: () => void;
}): AutoSearchApi {
  const { state, enabled, onSearch } = options;
  const [deadline, setDeadline] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  // Held in a ref so the effect below does not restart every time the parent
  // re-renders with a new closure — that would reset the countdown forever.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;

  const qualifies = state.screen === 'ended' && state.endReason === 'partner_left';

  // Start, extend, or abandon the countdown as the situation changes.
  useEffect(() => {
    if (!enabled || !qualifies) {
      setDeadline(null);
      return;
    }
    // A refusal in the last few seconds means the bucket is empty; wait longer
    // rather than asking again immediately and being refused again.
    const refusedRecently =
      state.rateLimitedAt !== null && Date.now() - state.rateLimitedAt < BACKOFF_MS;
    setDeadline(Date.now() + (refusedRecently ? BACKOFF_MS : AUTO_SEARCH_DELAY_MS));
  }, [enabled, qualifies, state.rateLimitedAt]);

  // Tick the visible number, and fire once it reaches zero.
  useEffect(() => {
    if (deadline === null) {
      setSecondsLeft(null);
      return;
    }
    const tick = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        setDeadline(null);
        setSecondsLeft(null);
        searchRef.current();
        return;
      }
      setSecondsLeft(Math.ceil(remaining / 1000));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadline]);

  return {
    secondsLeft,
    cancel: () => setDeadline(null),
  };
}
