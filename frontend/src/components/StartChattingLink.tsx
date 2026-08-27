/**
 * "Start chatting", from anywhere that is not the chat itself.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST A LINK TO `/`
 * ---------------------------------------------------------------------------
 * It was, and the result was a button that did not do what it said: pressing it
 * on About or Terms landed you on the home screen looking at a second, identical
 * "Start chatting" button. Two presses to do the thing the first press named.
 *
 * The reason is structural. `App` owns the WebSocket and is mounted on exactly
 * one route (see `Root.tsx`), so a document page *cannot* start a conversation
 * — it has no socket and no state machine. All it can do is say that starting
 * one is what the visitor asked for, and let `App` act on it when it mounts.
 *
 * ---------------------------------------------------------------------------
 * THE INTENT IS IN MEMORY, NOT IN THE URL
 * ---------------------------------------------------------------------------
 * `/?start=1` would have been simpler and is the obvious first idea. It is
 * rejected because a URL that starts a conversation is a URL somebody can
 * share, bookmark or have restored by their browser — and this product is one
 * where being dropped into a conversation you did not just ask for is the exact
 * wrong behaviour. A module-level flag cannot escape the tab or outlive the
 * navigation that set it.
 *
 * The cost is that a middle-click or ctrl-click opens `/` with no intent, and
 * the visitor gets the landing screen. That is the correct fallback: they asked
 * for a new tab, not for a conversation to already be under way in it.
 *
 * ---------------------------------------------------------------------------
 * STILL A REAL ANCHOR
 * ---------------------------------------------------------------------------
 * `RouteLink` renders `<a href="/">` and the href stays honest: `/` really is
 * where this goes. A crawler follows it, a modified click opens a tab, and the
 * status bar shows the destination — none of which a `<button>` can do.
 */
import type { ReactNode } from 'react';

import { requestChat } from '../intent';
import { RouteLink } from '../router';

interface StartChattingLinkProps {
  readonly className?: string;
  readonly style?: React.CSSProperties;
  /** Defaults to "Start chatting"; the age gate words its own button. */
  readonly children?: ReactNode;
}

export function StartChattingLink({
  className,
  style,
  children = 'Start chatting',
}: StartChattingLinkProps): JSX.Element {
  return (
    <RouteLink
      to="/"
      onClick={(event) => {
        /*
         * Only a plain click means "start now".
         *
         * `RouteLink` leaves modified clicks entirely alone so the browser can
         * open a tab, and this must agree with it — setting the flag on a
         * ctrl-click would arm the *current* tab to start a conversation the
         * next time it happened to navigate home.
         */
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        requestChat();
      }}
      {...(className === undefined ? {} : { className })}
      {...(style === undefined ? {} : { style })}
    >
      {children}
    </RouteLink>
  );
}
