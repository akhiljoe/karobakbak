/**
 * Make the phone's back button leave the conversation, not the site.
 *
 * ---------------------------------------------------------------------------
 * THE BUG
 * ---------------------------------------------------------------------------
 * This is a single page that never navigates, so it creates no history entries.
 * Pressing Back on a phone therefore did the only thing left: left the site.
 * People read that as the app crashing — a blank screen where a conversation
 * had been.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DOES NOT DO
 * ---------------------------------------------------------------------------
 * It does not trap Back. Exactly one entry is pushed, when a conversation
 * starts, and it is consumed when the conversation ends. On the landing screen
 * Back leaves the site, which is what a person pressing Back on a landing
 * screen means — a page that cannot be left is a page people learn to close
 * instead.
 */
import { useEffect, useRef } from 'react';

export function useBackButton(options: { active: boolean; onBack: () => void }): void {
  const { active, onBack } = options;
  // Held in refs so the listener is registered once. Re-registering on every
  // render would drop events that arrive mid-render, and re-running the push
  // effect would stack entries.
  const backRef = useRef(onBack);
  backRef.current = onBack;

  const pushed = useRef(false);
  /** Set while we unwind our own entry, so the resulting popstate is ignored. */
  const unwinding = useRef(false);

  useEffect(() => {
    const onPop = (): void => {
      if (unwinding.current) {
        // Our own `history.back()`, cleaning up after an in-app exit. The entry
        // is already gone; reacting would call onBack a second time.
        unwinding.current = false;
        return;
      }
      if (!pushed.current) return;
      pushed.current = false;
      backRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  useEffect(() => {
    if (active && !pushed.current) {
      pushed.current = true;
      // No URL change: the address bar should not imply a conversation is a
      // place that can be returned to. It cannot — there is no session
      // resumption, and a shared link would lead nowhere.
      window.history.pushState({ karobakbakChat: true }, '');
      return;
    }
    if (!active && pushed.current) {
      // The conversation ended some other way — the in-app back arrow, a skip,
      // the partner leaving. Consume the entry we added, or the next Back press
      // is a dead one that appears to do nothing.
      pushed.current = false;
      unwinding.current = true;
      window.history.back();
    }
  }, [active]);
}
