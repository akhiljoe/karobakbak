/**
 * The age acknowledgement, stored in this browser.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, SAID PRECISELY
 * ---------------------------------------------------------------------------
 * A record that somebody was shown a statement and pressed a button. It is
 * **not age assurance**, it does not verify anything, and nothing downstream
 * may read it as evidence that a user is an adult. `DESIGN.md` §26.4 says a
 * declared age is not age assurance; this is weaker still, because it is not
 * even a declared number.
 *
 * It exists because there is a difference between a service that states its age
 * requirement before a conversation begins and one that does not, and that
 * difference is the whole of the enforcement today
 * (`docs/policies/minor-safety-policy.md` §3).
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS VERSIONED RATHER THAN DATED
 * ---------------------------------------------------------------------------
 * The obvious design is to re-ask after some interval. That is theatre: the
 * same person presses the same button, and the second press is no more truthful
 * than the first. It costs every returning user an interruption and buys
 * nothing.
 *
 * What *does* mean something is re-asking when the thing being agreed to
 * changes. So the stored record carries the version of the copy that was shown,
 * and a user is asked again only when that no longer matches — which tracks
 * *what was agreed to* rather than how long ago. Bump `AGE_GATE_VERSION`
 * whenever the wording materially changes: a different age, a different
 * statement about what is kept.
 *
 * ---------------------------------------------------------------------------
 * WHY IT NEVER LEAVES THE BROWSER
 * ---------------------------------------------------------------------------
 * A server-side record of "this person accepted" would be a durable per-user
 * row in a product whose design forbids exactly that (§24.3, D34) — the
 * beginnings of the cross-chat correlator. So it lives here, beside the profile
 * and the preferences, and dies with the browser's site data.
 *
 * The cost is honest and worth stating: **this demonstrates nothing to anybody
 * else.** A local flag is trivially removed and proves nothing about what any
 * particular user saw. Whether that matters legally is the one open question in
 * `docs/policies/age-gate.md`, and it is the only requirement in this area that
 * would force a server-side change. It is not assumed either way here.
 */

const STORAGE_KEY = 'karobakbak.agegate.v1';

/**
 * The version of the wording in `AgeGate.tsx`.
 *
 * Bump this when the statement changes in a way a user should see again. Do not
 * bump it for typography, layout or a reworded button — the point is to re-ask
 * when the *commitment* changed, and a version that moves for cosmetic reasons
 * trains people to dismiss it.
 */
export const AGE_GATE_VERSION = 1;

/**
 * Whether this browser has acknowledged the current wording.
 *
 * Storage being unavailable returns `false`, which shows the gate. That is the
 * correct direction to fail: a private window or blocked site data means the
 * acknowledgement cannot be remembered, and asking again is a small cost while
 * silently skipping it would remove the only control there is.
 */
export function hasAcknowledgedAge(storage: Storage | undefined = safeStorage()): boolean {
  if (!storage) return false;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return false;
  }
  if (raw === null) return false;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null) return false;

  const stored = parsed as { version?: unknown };
  // Strictly equal, not `>=`. A record written by a *newer* build than this one
  // — a rolled-back deployment, a stale tab — agreed to wording this build
  // cannot show, so it is not an acknowledgement of what is on screen now.
  return stored.version === AGE_GATE_VERSION;
}

/**
 * Record that the current wording was acknowledged.
 *
 * Silently does nothing when storage is unavailable. The gate still lets the
 * person through for this page — refusing to proceed because a preference could
 * not be saved would be punishing them for their browser settings — they will
 * simply be asked again next time.
 */
export function acknowledgeAge(storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: AGE_GATE_VERSION }));
  } catch {
    // Full, blocked, or a private window. Not worth interrupting anyone for.
  }
}

/** Forget the acknowledgement. Exists for tests and for a settings control. */
export function clearAgeAcknowledgement(storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do, and nothing depends on it having worked.
  }
}

/** `localStorage`, or nothing at all if touching it throws. */
function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
