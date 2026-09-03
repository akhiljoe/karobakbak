/**
 * The presentation layer's view of `ChatState`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ---------------------------------------------------------------------------
 * `state/machine.ts` mirrors the *protocol*: its `Screen` is a faithful
 * reflection of what the server said the session is doing. The components
 * describe a *layout*: a header, a conversation pane, an input row. Those are
 * not the same vocabulary, and collapsing them would mean either the reducer
 * growing fields that exist only because a component wanted them, or the
 * components reaching into protocol concepts they should not know about.
 *
 * So the mapping lives here, in pure functions, and stays testable without a
 * render. Nothing in this file makes a decision — it only re-describes one the
 * server already made.
 */
import type { Identity } from '../protocol/types';
import type { ChatState, Screen } from '../state/machine';
import type { CapacityState } from '../capacity';

/** What the connection pill and the reconnect banner show. */
export type ConnectionView = 'connecting' | 'connected' | 'reconnecting';

/** Which of the four layouts is on screen. */
export type PhaseView = 'idle' | 'searching' | 'chatting' | 'ended';

/**
 * How the socket is doing, as a person would describe it.
 *
 * `disconnected` becomes `reconnecting` rather than a state of its own,
 * because the client always retries (`useChat` reconnects with backoff). A
 * label saying "offline" while a reconnect is in flight would be describing
 * the socket rather than the situation.
 */
export function connectionOf(screen: Screen): ConnectionView {
  switch (screen) {
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'reconnecting';
    default:
      return 'connected';
  }
}

/**
 * Which layout to show.
 *
 * Takes the state rather than the screen, because a dropped socket is not by
 * itself an answer to "what is this person looking at". Under §28 the server
 * holds the seat for `RESUME_GRACE_SECONDS` and the reducer deliberately keeps
 * `matchId` and the transcript through a `socket_closed` — but this function
 * read the screen alone, mapped `disconnected` to `idle`, and sent the user to
 * the landing page. Mid-conversation, on any blip, the transcript vanished and
 * was replaced by a headline offering to find them somebody new.
 *
 * Three things followed from that, all of them invisible because the layout
 * they lived in never rendered: `ReconnectBanner` could not display at all,
 * `ConnectionStatus` was pinned to "connected", and the countdown built for
 * §28 never ran. The one signal a user got was a toast. Meanwhile the screen
 * said the opposite of what the server was doing — and the obvious response to
 * a landing page is to close the tab, which takes the `sessionStorage` resume
 * token with it and destroys the conversation the server was holding.
 *
 * So: a session that still holds a match is in a conversation, whatever its
 * socket is doing. `connecting` and `disconnected` *without* a match still fall
 * back to the landing layout, where there is genuinely nothing to show.
 */
export function phaseOf(state: ChatState): PhaseView {
  if (state.screen === 'disconnected' && state.matchId !== null) return 'chatting';

  switch (state.screen) {
    case 'searching':
      return 'searching';
    case 'chatting':
      return 'chatting';
    case 'ended':
      return 'ended';
    case 'idle':
    case 'connecting':
    case 'disconnected':
      return 'idle';
  }
}

/**
 * The single character an avatar shows.
 *
 * Derived from the nickname the **server** generated, never from a session id
 * or anything else stable across matches (§24.3). Uses `Array.from` so an
 * astral-plane first character is not split into half a surrogate pair.
 */
export function glyphFor(identity: Identity | null): string {
  if (!identity) return '?';
  const first = Array.from(identity.nickname.trim())[0];
  return first ? first.toUpperCase() : '?';
}

/** The accent colour for an identity, with a neutral fallback before a match. */
export function colourFor(identity: Identity | null): string {
  return identity?.colour ?? '#8a7d68';
}

/**
 * Whether the composer should be live.
 *
 * Deliberately stricter than "are we chatting": the server's `features` gate
 * is not consulted here because sending a message is not an optional feature,
 * but the match must exist. `canSend` in the reducer is the authority; this
 * only adds the connection check, since a socket that is away cannot deliver.
 */
export function composerDisabled(state: ChatState): boolean {
  if (state.screen !== 'chatting' || state.matchId === null) return true;
  // The stranger's socket has dropped and their seat is held (§28). A message
  // sent now reaches nobody and is deliberately not buffered — holding message
  // text in a Redis key is what invariant I8 forbids — so the composer says so
  // by being unavailable rather than accepting something that goes nowhere.
  return state.partnerAway !== null;
}

/**
 * Below how many people online the counter is not shown at all.
 *
 * A live count is social proof, and social proof of an empty room is worse
 * than no social proof: "1 online" tells a visitor to leave, more plainly than
 * showing nothing does. Above the threshold the same number is the most
 * persuasive thing on the page.
 *
 * The alternative that was considered and rejected was synthesising a
 * flattering number. D21 forbids it — "fabricated counts are a trust bug that
 * is impossible to walk back" — and the wire format is built to make it hard,
 * with `approximate: true` sent as a literal so the UI cannot present a count
 * as exact. Hiding a true number says nothing false; printing a false one
 * cannot be undone once somebody notices.
 */
export const PRESENCE_MIN_TO_SHOW = 100;

/** What the header and the landing screen need to know about presence. */
export interface PresenceCounts {
  readonly online: number;
  readonly conversations: number;
}

/**
 * Whether the presence counter is worth showing.
 *
 * Strictly above the threshold, not at it, so the first number anybody ever
 * sees is comfortably past the point where it reads as a busy room.
 *
 * Takes the threshold as an argument rather than reading the constant, so a
 * test can state its own and a deployment could later lower it without this
 * function changing.
 */
export function showPresence(
  presence: PresenceCounts | null,
  minimum: number = PRESENCE_MIN_TO_SHOW,
): boolean {
  if (presence === null) return false;
  if (!Number.isFinite(presence.online)) return false;
  return presence.online > minimum;
}

/**
 * A line describing the search, given how many others are waiting.
 *
 * `waiting` counts everyone in the queue including this user, which is why one
 * person waiting is "you are the only one" rather than "1 person is waiting".
 */
export function searchingDetail(waiting: number): string {
  if (waiting > 1) return `${waiting.toLocaleString()} people are looking right now.`;
  return 'You are first in the queue. This usually takes a moment.';
}

/**
 * What to say while the socket is away.
 *
 * ---------------------------------------------------------------------------
 * THREE FAILURES THAT LOOK IDENTICAL TO A BROWSER
 * ---------------------------------------------------------------------------
 * A refused handshake, a dead backend and a dropped wifi all arrive as a close
 * with code 1006 and nothing else. The capacity probe is the only thing that
 * separates them, and this is where its answer becomes words.
 *
 * **Never "full", and never a number.** The same reasoning as `showPresence`
 * below the threshold (D21): "busier than usual" is true whatever the load is,
 * where "full" invites the question of how full and turns a wait into a verdict.
 * The person is not being turned away — the client is still retrying on its own
 * backoff — so the copy describes a wait, not a door.
 *
 * `unknown` keeps the ordinary reconnecting line, which is the honest answer
 * when the probe could not get through either: from here it is indistinguishable
 * from the network being gone, and that line already says so.
 */
export function connectionNotice(
  connection: ConnectionView,
  capacity: CapacityState,
): string | null {
  if (connection === 'connected') return null;
  if (connection === 'connecting' && capacity === 'unknown') return 'Connecting…';

  switch (capacity) {
    case 'busy':
      return 'It is busier than usual. Holding your place and trying again…';
    case 'unavailable':
      return 'We cannot reach the chat service right now. Trying again…';
    default:
      return connection === 'connecting'
        ? 'Connecting…'
        : 'Connection lost. Reconnecting — your conversation is held for a moment.';
  }
}

/**
 * The line under the Start button while the socket will not open.
 *
 * Separate copy from `connectionNotice` on purpose, and not drift: that one is
 * a banner over a conversation that is being held, this one is a landing page
 * where nothing is at stake but the person has been watching a button say
 * "Connecting…" with no idea why. So it says what to do about it — which is
 * nothing, and specifically not refreshing, because a refresh drops the queued
 * retry and starts the backoff again.
 *
 * `ok` and `unknown` return null. Both mean the probe learned nothing worth
 * repeating: `unknown` because it could not get through either, and `ok`
 * because the service would have taken the connection, which makes this a
 * local network problem the page cannot describe better than the button does.
 */
export function capacityLine(capacity: CapacityState): string | null {
  switch (capacity) {
    case 'busy':
      return 'It is busier than usual right now. We will get you in as soon as a spot opens — no need to refresh.';
    case 'unavailable':
      return 'We cannot reach the chat service right now. Still trying — no need to refresh.';
    default:
      return null;
  }
}
