/**
 * Per-person settings, stored in this browser.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT CONFIGURATION
 * ---------------------------------------------------------------------------
 * `config.ts` answers "how is this deployment built". This answers "what does
 * the person at this keyboard want", which is a different question with a
 * different lifetime and a different owner. Conflating them gives you either a
 * setting nobody can change or a deployment flag that mysteriously differs per
 * visitor.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAY AND MAY NOT LIVE HERE
 * ---------------------------------------------------------------------------
 * Presentation preferences only. **No conversation state, no message content,
 * no identifiers.** The product is anonymous and conversations are not carried
 * around; a store that quietly accumulated "who you last spoke to" would undo
 * that, and `localStorage` survives long after the socket does.
 *
 * It is also not a security boundary. Anything here is readable and writable by
 * the person it belongs to, so nothing may depend on it being honest — the
 * server is the authority for everything that matters, and this only decides
 * what the interface shows.
 *
 * Every access is guarded: `localStorage` throws in private modes and when a
 * browser blocks site data, and a preference failing to load must never be the
 * reason a conversation cannot happen.
 */

const STORAGE_KEY = 'karobakbak.preferences.v1';

export interface Preferences {
  /**
   * Offer a conversation prompt at the start of a match.
   *
   * **Off by default**, deliberately. A suggested opener is help for people who
   * want it and clutter for everyone else, and the honest default for something
   * that appears uninvited at the top of a new conversation is "not unless
   * asked for". It is discoverable in settings rather than absent.
   */
  readonly icebreakers: boolean;
  /**
   * Look for the next stranger automatically when this one leaves.
   *
   * **Off by default**, on the same reasoning as `icebreakers` and for a
   * sharper reason: auto-advancing puts somebody into a conversation with a
   * new stranger without them asking. That is the mechanic that turns a chat
   * product into an endless feed, and the moment where a person decides to
   * stop is worth preserving unless they have said otherwise.
   *
   * Only ever applies when the *partner* left. Blocking somebody and then
   * being dropped into a fresh conversation three seconds later contradicts
   * what blocking meant, which is why `block` lands in IDLE rather than back
   * in the queue.
   */
  readonly autoSearch: boolean;
  /**
   * Alert me when I match and I am looking at another tab.
   *
   * **On by default**, unlike the other two, because it exists to prevent a
   * loss rather than to add something. Finding a stranger takes long enough
   * that people tab away, and coming back to a conversation the stranger
   * already abandoned reads as a broken product. Every channel is gated on the
   * tab being hidden, so somebody watching the screen is never interrupted.
   */
  readonly notifyOnMatch: boolean;
}

export const DEFAULT_PREFERENCES: Preferences = {
  icebreakers: false,
  autoSearch: false,
  notifyOnMatch: true,
};

/**
 * Read the stored preferences, falling back to the defaults for anything
 * missing, malformed, or of the wrong type.
 *
 * Deliberately forgiving: a stored value written by an older build, or edited
 * by hand, must degrade to the default rather than break the page.
 */
export function loadPreferences(storage: Storage | undefined = safeStorage()): Preferences {
  if (!storage) return DEFAULT_PREFERENCES;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (raw === null) return DEFAULT_PREFERENCES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_PREFERENCES;

  const stored = parsed as Partial<Record<keyof Preferences, unknown>>;
  return {
    icebreakers:
      typeof stored.icebreakers === 'boolean'
        ? stored.icebreakers
        : DEFAULT_PREFERENCES.icebreakers,
    autoSearch:
      typeof stored.autoSearch === 'boolean'
        ? stored.autoSearch
        : DEFAULT_PREFERENCES.autoSearch,
    notifyOnMatch:
      typeof stored.notifyOnMatch === 'boolean'
        ? stored.notifyOnMatch
        : DEFAULT_PREFERENCES.notifyOnMatch,
  };
}

/**
 * Persist preferences. Silently does nothing when storage is unavailable —
 * the setting still applies for this page, it simply will not be remembered.
 */
export function savePreferences(
  preferences: Preferences,
  storage: Storage | undefined = safeStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Full, blocked, or in a private window. Not worth interrupting anyone for.
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
