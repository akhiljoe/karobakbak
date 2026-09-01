/**
 * The strangers you met in this tab, in this session, and nowhere else.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ENTIRELY CLIENT-SIDE, AND WHY THAT IS NOT LAZINESS
 * ---------------------------------------------------------------------------
 * The obvious implementation stores a list of past conversations against the
 * signed-in account. It is refused, and the reason is written into the privacy
 * policy as a load-bearing sentence:
 *
 *   "nothing written during a chat records which account, if any, was signed in
 *    at the time"
 *
 * That is what lets signing in leave the anonymity of chatting untouched, and
 * it is why an account holder asking about a conversation is in exactly the
 * same position as anybody else. A server-side history is precisely the link
 * that sentence denies, so building one would make a published claim false —
 * and `minor-safety-policy.md` §6 rests on the related clause that there is no
 * way to request a specific past partner.
 *
 * None of that is in the way here, because none of this reaches the server. The
 * list is assembled from frames this client already received and displayed, it
 * lives in `sessionStorage`, and it dies with the tab.
 *
 * ---------------------------------------------------------------------------
 * WHY `sessionStorage` AND NOT `localStorage`
 * ---------------------------------------------------------------------------
 * "Gone when the session ends" is the requirement, and `sessionStorage` is the
 * only storage that means it: it is scoped to the tab and cleared when the tab
 * closes, without anything having to remember to delete it. `localStorage`
 * would survive, quietly accumulating a record of who somebody talked to on a
 * shared machine — the exact durable trail the rest of the product avoids.
 *
 * It is written through rather than kept only in memory so that a reload, which
 * drops the socket and starts a new session, does not lose the list mid-use.
 * The resume token already lives there for the same reason.
 *
 * ---------------------------------------------------------------------------
 * WHAT AN ENTRY MAY CONTAIN
 * ---------------------------------------------------------------------------
 * Only what was already on screen: when, the colour and nickname the server
 * generated for that conversation, and the country the stranger declared. No
 * message content — that is rule 1, and it applies to browser storage as much
 * as to a log line. No session id, no match id: they identify a conversation on
 * the server, and keeping them here would be the beginning of the reconnect
 * feature this deliberately does not implement.
 */

/** One past stranger, as this tab saw them. */
export interface HistoryEntry {
  /** Milliseconds since the epoch, from this client's clock. */
  readonly at: number;
  /** The server-generated nickname for that conversation. Not a name. */
  readonly nickname: string;
  /** The accent colour that conversation used, so the row looks familiar. */
  readonly colour: string;
  /** ISO country code the stranger declared, or null. Declared, never verified. */
  readonly country: string | null;
  /**
   * Token for asking whether they are here now, or null.
   *
   * Given by the server at match time, and only when that person was signed in
   * *and* had chosen to share presence — so somebody who opted out is never
   * remembered by the people they meet. It expires server-side; nothing here
   * needs to forget it.
   *
   * It is not an identity. It resolves to one account, answers one question,
   * and differs for every viewer, so two people cannot compare tokens and
   * discover they met the same person.
   */
  readonly presence: string | null;
}

const KEY = 'kbb_recent';

/**
 * How many to keep.
 *
 * Fifteen is enough to cover a run of quick skips and short enough that the
 * list stays scannable. It is a cap on a session, not a retention period —
 * there is no retention period, because there is nothing durable to retain.
 */
export const HISTORY_LIMIT = 15;

/**
 * Ask which of the remembered people are online.
 *
 * Answers an empty set for every failure. Everybody reads as offline, which is
 * the safe direction — showing somebody as here when they are not invites a
 * message into a silence.
 */
export async function onlineFrom(entries: readonly HistoryEntry[]): Promise<Set<string>> {
  const tokens = entries
    .map((entry) => entry.presence)
    .filter((token): token is string => token !== null);
  if (tokens.length === 0) return new Set();

  try {
    const response = await fetch('/auth/presence/lookup', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ tokens }),
      cache: 'no-store',
    });
    if (!response.ok) return new Set();
    const body: unknown = await response.json();
    const online = (body as { online?: unknown }).online;
    if (!Array.isArray(online)) return new Set();
    return new Set(online.filter((t): t is string => typeof t === 'string'));
  } catch {
    return new Set();
  }
}

/** What happened when we asked somebody to talk again. */
export type AskResult = 'asked' | 'away' | 'failed';

/**
 * Ask a past partner to talk again.
 *
 * Both of you have to be online. That is the design rather than a limitation to
 * apologise for: the request travels down a socket that already exists, so
 * there is no inbox, no polling and no push service — and nothing is stored
 * about somebody who never answered.
 */
export async function askToReconnect(token: string): Promise<AskResult> {
  try {
    const response = await fetch('/auth/reconnect/ask', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token, from: 'me' }),
    });
    if (!response.ok) return 'failed';
    const body: unknown = await response.json();
    return (body as { asked?: unknown }).asked === true ? 'asked' : 'away';
  } catch {
    return 'failed';
  }
}

/** Accept a request. Declining calls nothing — a refusal is never disclosed. */
export async function acceptReconnect(offer: string): Promise<boolean> {
  try {
    const response = await fetch('/auth/reconnect/accept', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ offer }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Read the list, newest first.
 *
 * Every failure answers empty. `sessionStorage` throws rather than returning
 * null in a private window and under some enterprise policies, and a history
 * panel is the last thing that should be allowed to take down a page.
 */
export function readHistory(): HistoryEntry[] {
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validated per entry rather than trusted. This is storage another script
    // on the origin could have written, and a malformed row would otherwise
    // render as `undefined` in the panel.
    return parsed.filter(isEntry).slice(0, HISTORY_LIMIT);
  } catch {
    return [];
  }
}

/** Prepend one, drop the oldest beyond the cap, and answer the new list. */
export function recordHistory(entry: HistoryEntry): HistoryEntry[] {
  const next = [entry, ...readHistory()].slice(0, HISTORY_LIMIT);
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Full, or storage refused. The list in memory is still correct for this
    // render; only its survival across a reload is lost.
  }
  return next;
}

/** Forget everything. Offered because somebody may want it gone now. */
export function clearHistory(): HistoryEntry[] {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // Nothing to do: the caller replaces its state either way.
  }
  return [];
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<HistoryEntry>;
  return (
    typeof row.at === 'number' &&
    typeof row.nickname === 'string' &&
    typeof row.colour === 'string' &&
    (row.country === null || typeof row.country === 'string')
  );
}

/**
 * The flag for an ISO 3166-1 alpha-2 code, as regional indicator characters.
 *
 * Computed rather than shipped as an image set: a flag sprite would be assets
 * to serve and a list to maintain, and the emoji is one line. Windows renders
 * these as letter pairs rather than flags, which is a platform choice and not
 * something to work around by loading images from anywhere.
 *
 * Anything that is not two ASCII letters answers empty, because the country on
 * an entry is declared by a stranger and validated as a code, not as a country.
 */
export function flagOf(code: string | null): string {
  if (code === null || !/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    base + (upper.charCodeAt(0) - 65),
    base + (upper.charCodeAt(1) - 65),
  );
}
