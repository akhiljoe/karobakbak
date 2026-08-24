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
 * A line describing the search, given how many others are waiting.
 *
 * `waiting` counts everyone in the queue including this user, which is why one
 * person waiting is "you are the only one" rather than "1 person is waiting".
 */
export function searchingDetail(waiting: number): string {
  if (waiting > 1) return `${waiting.toLocaleString()} people are looking right now.`;
  return 'You are first in the queue. This usually takes a moment.';
}
