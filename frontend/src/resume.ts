/**
 * The resume token, and where it lives (§28).
 *
 * ---------------------------------------------------------------------------
 * WHY sessionStorage AND NOT localStorage
 * ---------------------------------------------------------------------------
 * This is a bearer credential: whoever holds it can reclaim the conversation it
 * belongs to. `sessionStorage` is scoped to the tab and cleared when the tab
 * closes, which is exactly the life of a conversation — the token cannot
 * outlive the thing it unlocks, and a second tab cannot pick it up.
 *
 * `localStorage` would survive the browser closing, leaving a credential on
 * disk for a conversation that ended days ago.
 *
 * ---------------------------------------------------------------------------
 * IT IS REPLACED ON EVERY CONNECTION
 * ---------------------------------------------------------------------------
 * The server rotates the token whenever one is redeemed, so the value here is
 * good for one use. Storing the new one immediately is what makes a captured
 * token worthless the moment its owner reconnects.
 */

const STORAGE_KEY = 'karobakbak.resume.v1';

export function loadResumeToken(): string | null {
  try {
    const value = window.sessionStorage.getItem(STORAGE_KEY);
    return value !== null && value.length > 0 ? value : null;
  } catch {
    // Private modes and blocked site data throw. Without a token every
    // reconnection is simply a new conversation, which is the behaviour this
    // product had before resumption existed — degraded, never broken.
    return null;
  }
}

export function saveResumeToken(token: string): void {
  try {
    if (token === '') {
      window.sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // The connection still works; it just will not survive a refresh.
  }
}

/**
 * Forget the token.
 *
 * Called when a conversation ends for a reason that is not a dropped socket —
 * leaving, being skipped, blocking. There is nothing to reclaim, and a token
 * left behind would be offered on the next connection for a session the server
 * has already released.
 */
export function clearResumeToken(): void {
  saveResumeToken('');
}
