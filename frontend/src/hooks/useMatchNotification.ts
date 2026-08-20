/**
 * Fire the match alert when someone is looking elsewhere.
 *
 * Watches for the transition *into* a conversation rather than the state of
 * being in one, so re-renders during a chat cannot re-fire it. The alert is
 * cleared the moment the page is looked at again.
 */
import { useEffect, useRef } from 'react';

import type { ChatState } from '../state/machine';
import { playMatchChime, setTitleAlert, showMatchNotification } from '../notify';

/**
 * The title to restore to, captured once from the document itself.
 *
 * Not a constant: a hardcoded string silently *renames* the tab the first time
 * an alert clears, and the two would drift the moment `index.html` changed.
 */
const BASE_TITLE = typeof document === 'undefined' ? '' : document.title;

export function useMatchNotification(options: { state: ChatState; enabled: boolean }): void {
  const { state, enabled } = options;
  const wasChatting = useRef(false);
  const alerting = useRef(false);

  useEffect(() => {
    const chatting = state.screen === 'chatting';
    const justMatched = chatting && !wasChatting.current;
    wasChatting.current = chatting;

    if (!justMatched || !enabled) return;
    // Someone watching the screen can already see this. A sound here is noise
    // and a desktop notification is about something already on screen.
    if (!document.hidden) return;

    alerting.current = true;
    setTitleAlert(true, BASE_TITLE);
    playMatchChime();
    showMatchNotification();
  }, [state.screen, enabled]);

  // Clear the title the moment the page is looked at, and on unmount, so a
  // stale "Matched!" cannot outlive the conversation it referred to.
  useEffect(() => {
    const clear = (): void => {
      if (!alerting.current || document.hidden) return;
      alerting.current = false;
      setTitleAlert(false, BASE_TITLE);
    };
    document.addEventListener('visibilitychange', clear);
    window.addEventListener('focus', clear);
    return () => {
      document.removeEventListener('visibilitychange', clear);
      window.removeEventListener('focus', clear);
      if (alerting.current) setTitleAlert(false, BASE_TITLE);
    };
  }, []);

  // A conversation that ended while the tab was still hidden should not leave
  // the tab shouting about a match that is over.
  useEffect(() => {
    if (state.screen === 'chatting' || !alerting.current) return;
    alerting.current = false;
    setTitleAlert(false, BASE_TITLE);
  }, [state.screen]);
}
