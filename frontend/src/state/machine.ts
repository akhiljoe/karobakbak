/**
 * The client-side UI state machine.
 *
 * A pure reducer, deliberately: every interesting decision this client makes is
 * "a frame arrived, what should the screen say now", and that is exactly the
 * kind of thing worth testing without a browser, a socket or a render.
 *
 * ---------------------------------------------------------------------------
 * THE SERVER IS THE AUTHORITY, INCLUDING OVER THIS
 * ---------------------------------------------------------------------------
 * This state is a *mirror*, not a source. It never decides that it is matched,
 * or that a message was delivered, or how many people are online — it reflects
 * what the server said. Where the two could disagree, the server wins and the
 * client re-reads on its next action.
 *
 * Two consequences worth naming, because both are easy to get wrong:
 *
 *  * A message is shown as **sent**, never as read or delivered. `message_ack`
 *    means the server accepted and routed it (D14), and a client that rendered
 *    a delivery receipt would be inventing a guarantee the protocol refuses to
 *    make.
 *  * Presence counts are shown as approximate, because the frame says they are.
 */
import type {
  ConnectedPayload,
  ErrorPayload,
  Identity,
  IncomingMessagePayload,
  MatchedPayload,
  MessageAckPayload,
  MessageContentType,
  PartnerTypingPayload,
  PresencePayload,
  QueueStatusPayload,
  ServerFeatures,
  ServerLimits,
} from '../protocol/types';
import { clearResumeToken, saveResumeToken } from '../resume';

/** What the screen is showing. Mirrors the server's session state (§5). */
export type Screen = 'connecting' | 'idle' | 'searching' | 'chatting' | 'ended' | 'disconnected';

/** How far a message this user sent has got. Never "read" (D14). */
export type OutgoingStatus = 'sending' | 'sent' | 'withheld' | 'failed';

export interface ChatMessage {
  /** Local key. For our own messages this is the envelope id we generated. */
  readonly id: string;
  readonly from: 'you' | 'partner';
  readonly type: MessageContentType | string;
  readonly text: string;
  readonly at: string;
  readonly status?: OutgoingStatus;
}

/** Why the last conversation ended, for the notice on the ended screen. */
export type EndReason = 'you_skipped' | 'partner_left' | 'you_blocked' | 'server_shutdown';

export interface ChatState {
  readonly screen: Screen;
  readonly sessionId: string | null;
  readonly limits: ServerLimits | null;
  readonly features: ServerFeatures;
  readonly matchId: string | null;
  /** When the server said this match began. Display only; it drives the timer. */
  readonly matchStartedAt: string | null;
  readonly you: Identity | null;
  readonly partner: Identity | null;
  readonly messages: readonly ChatMessage[];
  readonly partnerTyping: boolean;
  readonly waiting: number;
  readonly presence: { online: number; conversations: number } | null;
  readonly endReason: EndReason | null;
  /** A short, developer-authored line to show. Never raw server internals. */
  readonly notice: string | null;
  /**
   * When the server last refused a command for rate limiting.
   *
   * Only auto-search reads it, to lengthen its countdown rather than retrying
   * into the same refusal. The server knows the exact wait and does not send
   * it — adding that to the error payload is a protocol change worth making if
   * a second caller ever needs it, and guessing is fine for one.
   */
  readonly rateLimitedAt: number | null;
  /** Seconds a dropped socket keeps its seat, as the server reported it. */
  readonly resumeGraceSeconds: number;
  /**
   * When the stranger's seat is given up, if their socket has dropped (§28).
   *
   * Null while they are present. Drives the "reconnecting" notice and the
   * countdown, and disables the composer — messages sent now reach nobody and
   * are deliberately not buffered, because holding message text in a Redis key
   * is what invariant I8 forbids.
   */
  readonly partnerAway: string | null;
  readonly reportSent: boolean;
  /**
   * The user asked to go home and the server has not confirmed it yet.
   *
   * Leaving a conversation is two commands — `skip` ends the match, then
   * `leave_queue` stops the search it starts. Between them the server sends a
   * perfectly correct `queue_status: SEARCHING`, which is the echo of our own
   * skip rather than news. Without this flag the screen would bounce through
   * the searching layout on the way to the landing one.
   */
  readonly leaving: boolean;
}

/**
 * Until `connected` arrives nothing is enabled. Advertising a control the
 * server has not confirmed is how a client ends up sending a command that is
 * refused, then having to explain the refusal.
 */
const NO_FEATURES: ServerFeatures = {
  typing: false,
  presence: false,
  report: false,
  block: false,
};

export const initialState: ChatState = {
  screen: 'connecting',
  sessionId: null,
  limits: null,
  features: NO_FEATURES,
  matchId: null,
  matchStartedAt: null,
  you: null,
  partner: null,
  messages: [],
  partnerTyping: false,
  waiting: 0,
  presence: null,
  endReason: null,
  notice: null,
  rateLimitedAt: null,
  resumeGraceSeconds: 0,
  partnerAway: null,
  reportSent: false,
  leaving: false,
};

export type Action =
  | { type: 'socket_open' }
  | { type: 'socket_closed'; code: number }
  | { type: 'connected'; payload: ConnectedPayload }
  | { type: 'queue_status'; payload: QueueStatusPayload }
  | { type: 'presence'; payload: PresencePayload }
  | { type: 'matched'; payload: MatchedPayload }
  | { type: 'message'; payload: IncomingMessagePayload }
  | { type: 'message_ack'; payload: MessageAckPayload }
  | { type: 'partner_typing'; payload: PartnerTypingPayload }
  | { type: 'partner_reconnecting'; matchId: string; until: string }
  | { type: 'partner_returned'; matchId: string }
  | { type: 'partner_left'; matchId: string }
  | { type: 'report_ack' }
  | { type: 'server_error'; payload: ErrorPayload }
  | { type: 'server_shutdown' }
  /* local intents, applied optimistically where the server cannot contradict them */
  | { type: 'send_pending'; id: string; text: string; at: string }
  | { type: 'user_searching' }
  | { type: 'user_skipped' }
  | { type: 'user_left' }
  | { type: 'user_blocked' }
  | { type: 'dismiss_notice' };

/** A conversation's worth of state, cleared whenever one ends. */
function clearedConversation(state: ChatState): ChatState {
  return {
    ...state,
    matchId: null,
    matchStartedAt: null,
    you: null,
    partner: null,
    messages: [],
    partnerTyping: false,
    reportSent: false,
  };
}

export function reduce(state: ChatState, action: Action): ChatState {
  switch (action.type) {
    case 'socket_open':
      return { ...state, screen: 'connecting', notice: null };

    case 'connected': {
      // Store the replacement immediately. The server rotates on every
      // redemption, so keeping the old one would offer a spent credential on
      // the next reconnection and lose a conversation that could have resumed.
      saveResumeToken(action.payload.resumeToken ?? '');

      const base = {
        ...state,
        sessionId: action.payload.sessionId,
        limits: action.payload.limits,
        // Whatever the server says it can do — not what this build assumes.
        features: action.payload.features ?? NO_FEATURES,
        resumeGraceSeconds: action.payload.resumeGraceSeconds ?? 0,
        notice: null,
      };

      // A conversation came back with the connection (§28). Restored here
      // rather than by waiting for a second frame, so the interface never
      // flashes a landing screen over a conversation that never ended.
      const resumed = action.payload.resumed;
      if (resumed) {
        return {
          ...base,
          screen: 'chatting',
          matchId: resumed.matchId,
          matchStartedAt: resumed.startedAt,
          you: resumed.you,
          partner: resumed.partner,
          partnerAway: null,
          endReason: null,
        };
      }

      // Nothing came back, so whatever was on screen is over. Cleared here
      // rather than on `socket_closed`, because this is the first moment the
      // server has actually said so — and a stale conversation left behind
      // would render a transcript nobody is on the other end of.
      return { ...clearedConversation(base), screen: 'idle', partnerAway: null };
    }

    case 'socket_closed':
      // The conversation is **kept on screen** while the socket comes back
      // (§28, reversing D7). Clearing it here was right when a blip ended the
      // conversation; now the seat is held for a grace window, and wiping the
      // transcript would throw away something the server is still holding —
      // and would be visibly wrong the moment the resume succeeds.
      //
      // A resume that fails lands on `connected` with no `resumed` payload,
      // which moves to the landing screen. That is where an ending belongs:
      // after the server has said so, not on the guess that it will.
      return {
        ...state,
        screen: 'disconnected',
        sessionId: null,
        partnerTyping: false,
        notice: 'Connection lost. Reconnecting…',
      };

    case 'queue_status': {
      const searching = action.payload.state === 'SEARCHING';
      // While a leave is in flight, a SEARCHING status is our own skip coming
      // back. The IDLE that follows it is the confirmation, and clears the flag.
      if (state.leaving && searching) return { ...state, waiting: action.payload.waiting };
      return {
        ...state,
        screen: searching ? 'searching' : 'idle',
        waiting: action.payload.waiting,
        leaving: false,
        // A queue_status is the end of whatever came before it.
        ...(searching ? {} : { matchId: null }),
      };
    }

    case 'presence':
      return {
        ...state,
        presence: { online: action.payload.online, conversations: action.payload.conversations },
      };

    case 'matched':
      return {
        ...clearedConversation(state),
        screen: 'chatting',
        matchId: action.payload.matchId,
        matchStartedAt: action.payload.startedAt,
        you: action.payload.you,
        partner: action.payload.partner,
        endReason: null,
        notice: null,
      };

    case 'message': {
      // A frame for a conversation this client has already left is dropped
      // rather than rendered: the server is authoritative about which match is
      // current, and a late frame from the previous one is not news.
      if (action.payload.matchId !== state.matchId) return state;
      return {
        ...state,
        partnerTyping: false,
        messages: [
          ...state.messages,
          {
            id: action.payload.messageId,
            from: 'partner',
            type: action.payload.type,
            text: action.payload.text,
            at: action.payload.sentAt,
          },
        ],
      };
    }

    case 'send_pending':
      return {
        ...state,
        messages: [
          ...state.messages,
          { id: action.id, from: 'you', type: 'text', text: action.text, at: action.at, status: 'sending' },
        ],
      };

    case 'message_ack': {
      const id = action.payload.clientMsgId;
      if (id === null) return state;
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.id === id
            ? {
                ...message,
                // "sent", never "read": the ack means accepted and routed (D14).
                // `delivered: false` means policy withheld it, and the sender is
                // told plainly rather than left believing it arrived.
                status: action.payload.delivered ? 'sent' : 'withheld',
              }
            : message,
        ),
      };
    }

    case 'partner_typing':
      if (action.payload.matchId !== state.matchId) return state;
      return { ...state, partnerTyping: action.payload.active };

    case 'partner_reconnecting':
      if (state.matchId !== null && action.matchId !== state.matchId) return state;
      // Not an ending. Told "they left" a person moves on; told "reconnecting"
      // they wait, and most of the time the conversation comes back.
      return { ...state, partnerAway: action.until, partnerTyping: false };

    case 'partner_returned':
      if (state.matchId !== null && action.matchId !== state.matchId) return state;
      return { ...state, partnerAway: null };

    case 'partner_left':
      // The token is **not** cleared here, and that is the whole point.
      //
      // It is a *session* credential, not a conversation one: the session
      // survives a stranger leaving, goes back to the queue, and matches
      // somebody else. Clearing it here meant that after the first partner left
      // — the ordinary way a conversation ends here — the tab held nothing, so
      // the next dropped socket could not resume and destroyed a live
      // conversation the server was still holding a seat for. The stranger on
      // the other side then waited out the entire grace window for somebody who
      // could never come back.
      //
      // The clear also used to run above this guard, so a late frame for an
      // already-finished match discarded the token for the conversation the
      // user was in *now*.
      if (state.matchId !== null && action.matchId !== state.matchId) return state;
      return {
        ...clearedConversation(state),
        screen: 'ended',
        // A block is indistinguishable from a skip here, because the server
        // sends the same event for both (security §32). The client must not
        // invent a distinction it was deliberately not given.
        endReason: 'partner_left',
        notice: 'The stranger left.',
      };

    case 'user_searching':
      return { ...state, screen: 'searching', leaving: false, endReason: null, notice: null };

    case 'user_skipped':
      return {
        ...clearedConversation(state),
        screen: 'searching',
        leaving: false,
        endReason: 'you_skipped',
        notice: null,
      };

    case 'user_left':
      // Optimistic, and safe: the server cannot refuse this. `skip` is
      // idempotent and `leave_queue` converges, so the worst case is that the
      // confirming queue_status says what this already says.
      return {
        ...clearedConversation(state),
        screen: 'idle',
        leaving: true,
        endReason: null,
        notice: null,
      };

    case 'user_blocked':
      return {
        ...clearedConversation(state),
        screen: 'ended',
        endReason: 'you_blocked',
        notice: 'Blocked. You will not be matched with them again.',
      };

    case 'report_ack':
      // No verdict, no indication of what happens next — the ack carries none,
      // and promising more than it says would be a promise nobody kept.
      return { ...state, reportSent: true, notice: 'Report sent. Thank you.' };

    case 'server_error':
      return applyError(state, action.payload);

    case 'server_shutdown':
      return {
        ...clearedConversation(state),
        screen: 'disconnected',
        endReason: 'server_shutdown',
        notice: 'The server is restarting. Reconnecting…',
      };

    case 'dismiss_notice':
      return { ...state, notice: null };

    default: {
      const exhaustive: never = action;
      void exhaustive;
      return state;
    }
  }
}

/**
 * Turn a protocol error into something a person can act on.
 *
 * The server's `message` field is developer-authored and deliberately terse;
 * it is not shown as-is. Codes the user can do nothing about produce a general
 * line rather than a technical one — telling somebody their frame failed
 * validation helps nobody.
 */
function applyError(state: ChatState, error: ErrorPayload): ChatState {
  switch (error.code) {
    case 'RATE_LIMITED':
      return { ...state, notice: 'Slow down a moment.', rateLimitedAt: Date.now() };
    case 'MESSAGE_TOO_LONG':
      return { ...state, notice: 'That message is too long.' };
    case 'EMPTY_MESSAGE':
      return state;
    case 'MESSAGE_WITHHELD':
      return { ...state, notice: 'That message was not delivered.' };
    case 'DUPLICATE_MESSAGE':
      // The first copy was delivered. Nothing went wrong from the user's side.
      return state;
    case 'NOT_MATCHED':
      return {
        ...clearedConversation(state),
        screen: state.screen === 'searching' ? 'searching' : 'idle',
        notice: 'That conversation has ended.',
      };
    case 'SESSION_GONE':
      // Here, and only here, the token is genuinely spent: the server has said
      // the session it belongs to no longer exists, so offering it on the next
      // connection would be presenting a credential for something that is gone.
      // Every other ending — a partner leaving, a skip, a block — ends a
      // *conversation* and leaves the session alive and resumable.
      clearResumeToken();
      return {
        ...clearedConversation(state),
        screen: 'disconnected',
        sessionId: null,
        notice: 'Your session expired. Reconnecting…',
      };
    case 'ALREADY_MATCHED':
      return state;
    case 'SERVER_SHUTTING_DOWN':
      return { ...state, notice: 'The server is restarting. Reconnecting…' };
    default:
      return { ...state, notice: 'Something went wrong. Please try again.' };
  }
}

/** Whether the composer should accept input. */
export function canSend(state: ChatState): boolean {
  return state.screen === 'chatting' && state.matchId !== null;
}
