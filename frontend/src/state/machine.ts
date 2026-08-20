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

    case 'connected':
      return {
        ...state,
        screen: 'idle',
        sessionId: action.payload.sessionId,
        limits: action.payload.limits,
        // Whatever the server says it can do — not what this build assumes.
        features: action.payload.features ?? NO_FEATURES,
        notice: null,
      };

    case 'socket_closed':
      // There is no session resumption (D7): reconnecting starts a new session,
      // so the old conversation is gone rather than resumable.
      return {
        ...clearedConversation(state),
        screen: 'disconnected',
        sessionId: null,
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

    case 'partner_left':
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
