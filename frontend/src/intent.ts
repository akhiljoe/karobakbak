/**
 * One bit of state that has to survive a route change and nothing more.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT IS FOR
 * ---------------------------------------------------------------------------
 * `App` owns the WebSocket and is mounted only on `/`. A "Start chatting"
 * button on About or Terms therefore cannot start anything itself — it can only
 * record that starting is what the visitor asked for, so that `App` can act on
 * it the moment it exists.
 *
 * ---------------------------------------------------------------------------
 * WHY A MODULE VARIABLE AND NOT STORAGE, A URL OR A CONTEXT
 * ---------------------------------------------------------------------------
 * `sessionStorage` and a query parameter both outlive the navigation: a
 * restored tab or a shared link would arrive already asking for a conversation,
 * which is precisely the thing an anonymous chat product must not do. A React
 * context would work and would mean threading a provider around a router whose
 * whole point is that it has no such machinery.
 *
 * A module variable is scoped to the tab, dies with it, and cannot be
 * serialised anywhere by accident. It is deliberately not exported directly —
 * reading it clears it, so a stale request cannot fire twice.
 *
 * ---------------------------------------------------------------------------
 * IT IS A REQUEST, NOT A COMMAND
 * ---------------------------------------------------------------------------
 * Consuming it does not start a conversation; it runs the same `startSearch`
 * the landing button runs, which still opens the age gate when the
 * acknowledgement is missing. Nothing here bypasses that gate, and nothing
 * here may ever be allowed to.
 */

let requested = false;

/** Record that the visitor pressed "Start chatting" on some other page. */
export function requestChat(): void {
  requested = true;
}

/**
 * Whether a conversation was asked for, clearing the request as it answers.
 *
 * Clearing on read is what stops a single press arming every later return to
 * the home screen in the same tab.
 */
export function consumeChatRequest(): boolean {
  const wanted = requested;
  requested = false;
  return wanted;
}
