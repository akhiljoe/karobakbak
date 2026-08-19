/**
 * karobakbak wire protocol — SINGLE SOURCE OF TRUTH.
 *
 * This file is duplicated byte-for-byte into frontend/src/protocol/types.ts.
 * `node scripts/verify-protocol.mjs` fails the build if the copies drift.
 * Do not import anything here: the file must be valid in both a Node and a
 * browser/Vite build with no shared tooling.
 *
 * Trust model
 * -----------
 * The server is authoritative for ALL identity and state. Nothing in a
 * client->server frame is trusted as identity, authorisation or ordering:
 *   - session id, user id, partner id, match id  -> resolved server-side
 *   - timestamps                                 -> ignored, server restamps
 *   - `id`                                       -> opaque correlation token,
 *                                                   echoed back and used only
 *                                                   as a per-match dedupe key
 */

export const PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Event names                                                                */
/* -------------------------------------------------------------------------- */

export const CLIENT_EVENTS = [
  'join_queue',
  'leave_queue',
  'leave_chat',
  'message',
  'typing',
  'skip',
  'report',
  'block',
  'ping',
] as const;
export type ClientEventType = (typeof CLIENT_EVENTS)[number];

export const SERVER_EVENTS = [
  'connected',
  'queue_status',
  'presence',
  'matched',
  'message',
  'message_ack',
  'partner_typing',
  'partner_skipped',
  'partner_disconnected',
  'report_ack',
  'error',
  'pong',
  'server_shutdown',
] as const;
export type ServerEventType = (typeof SERVER_EVENTS)[number];

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every frame in either direction uses this envelope.
 *
 *   { "type": "message", "version": 1, "id": "c_ab12",
 *     "timestamp": "2026-08-18T09:12:03.114Z", "payload": { "text": "hi" } }
 *
 * `timestamp` on inbound frames is ignored; the server stamps its own on every
 * outbound frame.
 *
 * `id` on inbound frames is a client correlation token (<= MAX_CLIENT_ID_LENGTH
 * chars, [A-Za-z0-9_-]) returned verbatim in `message_ack.clientMsgId`. It is
 * **required on `message`** and optional on every other event: it doubles as
 * the per-match replay-protection key (DESIGN.md R4/D24), so a `message`
 * without one cannot be deduplicated and is rejected with `BAD_ENVELOPE`.
 *
 * It is still never an identity or an authorisation token. The dedupe set is
 * scoped to one match, so a client that guesses another client's id can only
 * collide inside its own conversation.
 */
export interface Envelope<TType extends string = string, TPayload = unknown> {
  type: TType;
  version: number;
  id?: string;
  timestamp?: string;
  payload: TPayload;
}

export const MAX_CLIENT_ID_LENGTH = 64;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/* -------------------------------------------------------------------------- */
/* Session states (server-authoritative, mirrored to the client)              */
/* -------------------------------------------------------------------------- */

export const SESSION_STATES = ['IDLE', 'SEARCHING', 'MATCHED'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/* -------------------------------------------------------------------------- */
/* Message content type                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Content types this server implements. **Today this list is exactly `text`.**
 *
 * The discriminator exists so that a future content type can be added without
 * a protocol version bump and a dual-stack compatibility period on both ends.
 * It is the one media-related seam that is genuinely expensive to retrofit,
 * because the wire format is versioned and browsers cache old clients.
 *
 * It is NOT an announcement that other types are coming, and it is NOT a
 * capability list: a client sending anything other than `text` is rejected with
 * `UNSUPPORTED_CONTENT_TYPE`. See DESIGN.md §23.
 *
 * When a second type is implemented, it is added here AND announced through
 * `connected.features` so clients never have to hardcode what the server
 * accepts.
 */
export const MESSAGE_CONTENT_TYPES = ['text'] as const;
export type MessageContentType = (typeof MESSAGE_CONTENT_TYPES)[number];

/** The content type assumed when a client omits `payload.type`. */
export const DEFAULT_MESSAGE_CONTENT_TYPE: MessageContentType = 'text';

/**
 * Payload field names reserved for future media support.
 *
 * A frame containing any of these is **rejected**, not ignored. Silently
 * dropping an unknown field is how a client comes to believe it successfully
 * sent an attachment that the server never stored or delivered. Rejecting also
 * means a client cannot smuggle a fabricated media reference past a server that
 * has no concept of media (DESIGN.md §23.6).
 */
export const RESERVED_MEDIA_FIELDS = [
  'mediaId',
  'media',
  'attachment',
  'attachments',
  'blob',
  'file',
  'url',
] as const;

export function isMessageContentType(value: unknown): value is MessageContentType {
  return typeof value === 'string' && (MESSAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Report categories                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The fixed reason set a reporter picks from (DESIGN.md §6.2, security §31,
 * UI §26).
 *
 * A closed enum rather than free text is deliberate: the category is the one
 * part of a report that is safe to put on a metric label or a triage queue,
 * because it carries no user-authored content. The reporter's own words go in
 * `note`, which is treated exactly like a message body (invariant I8).
 */
export const REPORT_CATEGORIES = [
  'harassment',
  'spam',
  'sexual_content',
  'grooming',
  'threats',
  'hate',
  'scam',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === 'string' && (REPORT_CATEGORIES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Temporary identities                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A throwaway display identity, generated by the server per match.
 *
 * It exists so the UI can show something friendlier than "Stranger" and give
 * the two sides distinguishable accents (UI §20). It is **not** an account, is
 * not stable across matches, and carries no session id — an identity that
 * persisted across matches would be a deanonymisation primitive. Both sides'
 * identities are generated when the pair is formed and discarded when the
 * match ends.
 */
export interface Identity {
  /** Server-generated display name. Never user-supplied. */
  nickname: string;
  /** CSS colour for the identity accent, e.g. "#7C5CFF". */
  colour: string;
}

/* -------------------------------------------------------------------------- */
/* Client -> server payloads                                                  */
/* -------------------------------------------------------------------------- */

/** Enter matchmaking. Idempotent while already SEARCHING. Changes state. */
export type JoinQueuePayload = Record<string, never>;

/** Leave matchmaking without disconnecting. Idempotent. Changes state. */
export type LeaveQueuePayload = Record<string, never>;

/**
 * End the current match and return to IDLE, without searching again.
 *
 * The difference from `skip` is the whole point. `skip` re-enters the queue, so
 * a user who wanted to stop is dropped straight into another conversation —
 * which is the same reasoning that already makes `block` land in IDLE rather
 * than back in the queue. Leaving is a statement about wanting to stop, and the
 * protocol has to be able to express it, or a client has to fake it with
 * `skip` + `leave_queue` and lose the race whenever the skip re-matches first.
 *
 * Idempotent: leaving when not matched is "ensure I am idle", never an error.
 * Changes state.
 */
export type LeaveChatPayload = Record<string, never>;

/** End the current match and immediately search again. Idempotent. Changes state. */
export type SkipPayload = Record<string, never>;

/**
 * End the current match and refuse future matches with this partner.
 * Idempotent. Changes state (MATCHED -> IDLE).
 *
 * The blocked party is never told they were blocked: they receive
 * `partner_skipped`, exactly as for an ordinary skip (security §32).
 */
export type BlockPayload = Record<string, never>;

/** Liveness probe; also refreshes server-side session TTLs. No state change. */
export type PingPayload = Record<string, never>;

/**
 * Send one chat message to the current partner.
 *
 * Idempotent within the dedupe window: the envelope `id` is required, and an
 * id already accepted for this match is rejected with `DUPLICATE_MESSAGE`
 * rather than delivered twice (I14). A client retrying a send after a dropped
 * connection resends the same frame.
 *
 * The recipient is NEVER specified by the client; it is resolved from the
 * server's authoritative match record.
 */
export interface MessagePayload {
  /**
   * Content type. Optional; defaults to `text`.
   *
   * Only `text` is accepted today — any other value, including a future type
   * this server does not yet implement, is rejected with
   * `UNSUPPORTED_CONTENT_TYPE`. A client cannot use this field to opt into
   * behaviour the server has not shipped.
   */
  type?: MessageContentType;
  /** The message body. Required for `text`, which is the only current type. */
  text: string;
}

/**
 * Typing indicator. Fire-and-forget: there is no acknowledgement, and the
 * partner may never see it if their socket is slow or their session ended.
 *
 * `active` is an explicit boolean rather than a repeated "still typing" pulse,
 * so stopping is an event in its own right instead of the absence of one.
 */
export interface TypingPayload {
  active: boolean;
}

/**
 * Report the current partner.
 *
 * Does not end the match: a user may report and keep talking, or report and
 * then block (DESIGN.md §5). Not idempotent — each frame files a report.
 *
 * `note` is the reporter's own words. It is user-generated content and carries
 * exactly the protection class of a message body: never logged, never a metric
 * label, never leaves the trusted boundary (I8).
 */
export interface ReportPayload {
  category: ReportCategory;
  note?: string;
}

export interface ClientEventPayloads {
  join_queue: JoinQueuePayload;
  leave_queue: LeaveQueuePayload;
  leave_chat: LeaveChatPayload;
  message: MessagePayload;
  typing: TypingPayload;
  skip: SkipPayload;
  report: ReportPayload;
  block: BlockPayload;
  ping: PingPayload;
}

export type ClientEnvelope<T extends ClientEventType = ClientEventType> = Envelope<
  T,
  ClientEventPayloads[T]
>;

/* -------------------------------------------------------------------------- */
/* Server -> client payloads                                                  */
/* -------------------------------------------------------------------------- */

/** Limits the server actually enforces, so the UI can pre-validate. */
export interface ServerLimits {
  maxMessageLength: number;
  maxReportNoteLength: number;
  messagesPerSecond: number;
  burst: number;
  /** Sustained `typing` frames per second, so the UI throttles instead of being limited. */
  typingPerSecond: number;
  maxFrameBytes: number;
}

/**
 * Which optional behaviours this server has enabled.
 *
 * The UI hides the controls it is told about rather than shipping one build
 * per configuration, and never has to infer a capability from a rejection.
 */
export interface ServerFeatures {
  typing: boolean;
  presence: boolean;
  report: boolean;
  block: boolean;
}

/**
 * First frame after a successful upgrade.
 * `sessionId` is the client's OWN server-generated id, sent for log
 * correlation only. It grants no capability: there is no session resumption,
 * and no inbound frame is authorised by it.
 */
export interface ConnectedPayload {
  sessionId: string;
  protocolVersion: number;
  serverTime: string;
  limits: ServerLimits;
  features: ServerFeatures;
}

/** Result of join_queue / leave_queue / a no-op skip. */
export interface QueueStatusPayload {
  state: SessionState;
  /** Global number of sessions currently waiting. Coarse, cached, non-authoritative. */
  waiting: number;
}

/**
 * Live activity counts, pushed on connect and periodically after that.
 *
 * Both numbers are real Redis cardinalities, cached for an interval and
 * therefore lagging (D21). `approximate` is the literal `true` on the wire so
 * the UI is structurally unable to present them as exact: fabricated or
 * precise-looking social proof is a trust bug that cannot be walked back
 * (UI §5.1).
 */
export interface PresencePayload {
  online: number;
  conversations: number;
  approximate: true;
}

/**
 * A pair was formed. The partner's session id is deliberately NOT included.
 *
 * `you` and `partner` are throwaway per-match display identities (see
 * `Identity`); they are server-generated and mean nothing outside this match.
 */
export interface MatchedPayload {
  matchId: string;
  startedAt: string;
  you: Identity;
  partner: Identity;
}

/**
 * Inbound message from the stranger. `text` is untrusted plain text.
 *
 * `type` is always present on outbound frames, even though it is optional
 * inbound, so a client renderer can dispatch on it unconditionally rather than
 * defaulting. That is what keeps the frontend from being written as
 * "if text then render text" (DESIGN.md §23.4).
 */
export interface IncomingMessagePayload {
  matchId: string;
  messageId: string;
  type: MessageContentType;
  text: string;
  sentAt: string;
  from: 'partner';
}

/**
 * The server accepted a message and routed it to the partner's socket owner.
 *
 * This is NOT an end-to-end delivery receipt: `route: "remote"` means the
 * message was handed to Redis Pub/Sub for the instance owning the partner's
 * socket. Clients must show "sent", never "read".
 *
 * `delivered: false` means the message was accepted and recorded but withheld
 * from the partner by moderation policy (D20). The sender is told, because an
 * ack indistinguishable from delivery teaches users that "sent" means nothing.
 * It is reported here rather than as an error because the frame was valid and
 * there is nothing to retry.
 */
export interface MessageAckPayload {
  clientMsgId: string | null;
  messageId: string;
  matchId: string;
  acceptedAt: string;
  route: 'local' | 'remote';
  delivered: boolean;
}

/** The partner started or stopped typing. Advisory only. */
export interface PartnerTypingPayload {
  matchId: string;
  active: boolean;
}

export interface PartnerSkippedPayload {
  matchId: string;
}

export interface PartnerDisconnectedPayload {
  matchId: string;
}

/**
 * A report was recorded.
 *
 * Deliberately empty of moderation detail: no verdict, no indication of what
 * happens next, nothing about the reported user (security §31). Telling a
 * reporter what enforcement followed would leak another user's state and would
 * turn reporting into a probe for it.
 */
export interface ReportAckPayload {
  reportId: string;
  acceptedAt: string;
}

/** Never contains Redis state, stack traces, internal ids or message text. */
export interface ErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  /** true when the same operation may succeed if retried later. */
  retryable: boolean;
}

export interface PongPayload {
  serverTime: string;
}

export interface ServerShutdownPayload {
  reason: 'shutdown';
}

export interface ServerEventPayloads {
  connected: ConnectedPayload;
  queue_status: QueueStatusPayload;
  presence: PresencePayload;
  matched: MatchedPayload;
  message: IncomingMessagePayload;
  message_ack: MessageAckPayload;
  partner_typing: PartnerTypingPayload;
  partner_skipped: PartnerSkippedPayload;
  partner_disconnected: PartnerDisconnectedPayload;
  report_ack: ReportAckPayload;
  error: ErrorPayload;
  pong: PongPayload;
  server_shutdown: ServerShutdownPayload;
}

export type ServerEnvelope<T extends ServerEventType = ServerEventType> = Envelope<
  T,
  ServerEventPayloads[T]
>;

/** Discriminated union of every server frame, for exhaustive client handling. */
export type AnyServerEnvelope = {
  [K in ServerEventType]: Envelope<K, ServerEventPayloads[K]>;
}[ServerEventType];

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export const PROTOCOL_ERROR_CODES = [
  /** Frame was not valid JSON. */
  'BAD_JSON',
  /** Frame was JSON but not a well-formed envelope, or a `message` carried no `id`. */
  'BAD_ENVELOPE',
  /** `version` is not PROTOCOL_VERSION. */
  'UNSUPPORTED_VERSION',
  /** `type` is not a known client event. */
  'UNKNOWN_EVENT',
  /** Payload failed per-event validation. */
  'VALIDATION_FAILED',
  /** Message text was empty or whitespace only. */
  'EMPTY_MESSAGE',
  /** Message text exceeded maxMessageLength. */
  'MESSAGE_TOO_LONG',
  /**
   * `payload.type` names a content type this server does not implement, or the
   * payload carried a reserved media field. Not retryable: the client must not
   * resend the same frame hoping the server changes its mind.
   */
  'UNSUPPORTED_CONTENT_TYPE',
  /**
   * The envelope `id` was already accepted for this match (I14). The first copy
   * was delivered; this one was not. Not retryable — retrying is what produced
   * it, and a genuinely new message needs a new id.
   */
  'DUPLICATE_MESSAGE',
  /**
   * Moderation policy refused to deliver this message. Reserved for the hard
   * rule set: the default policy delivers and flags (D20), and a message that
   * was recorded but withheld is reported as `message_ack` with
   * `delivered: false` rather than as an error.
   */
  'MESSAGE_WITHHELD',
  /** Token bucket exhausted. */
  'RATE_LIMITED',
  /** Operation requires an active match and there is none. */
  'NOT_MATCHED',
  /** join_queue while already MATCHED. */
  'ALREADY_MATCHED',
  /** Server-side session no longer exists (TTL, reaped, or Redis restarted). */
  'SESSION_GONE',
  /** Instance is draining; retry against a new connection. */
  'SERVER_SHUTTING_DOWN',
  /** Too many malformed frames on one connection. */
  'TOO_MANY_INVALID_MESSAGES',
  /** Unexpected server-side failure. Details are logged, never sent. */
  'INTERNAL_ERROR',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** Whether a client may sensibly retry the same operation. */
export const RETRYABLE_ERROR_CODES: readonly ProtocolErrorCode[] = [
  'RATE_LIMITED',
  'SERVER_SHUTTING_DOWN',
  'INTERNAL_ERROR',
];

/* -------------------------------------------------------------------------- */
/* Close codes                                                                */
/* -------------------------------------------------------------------------- */

export const CLOSE_CODES = {
  NORMAL: 1000,
  /** Instance is shutting down. Client should reconnect. */
  GOING_AWAY: 1001,
  /** Frame exceeded maxFrameBytes. */
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  /** Outbound buffer exceeded the slow-consumer threshold. */
  TRY_AGAIN_LATER: 1013,
  /** Session vanished server-side; reconnect for a fresh one. */
  SESSION_GONE: 4001,
  /** Abuse controls tripped (connection rate, repeated limit violations). */
  POLICY_VIOLATION: 4002,
  /** Too many malformed protocol frames. */
  PROTOCOL_ABUSE: 4003,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/* -------------------------------------------------------------------------- */
/* Type guards usable from either side                                        */
/* -------------------------------------------------------------------------- */

export function isClientEventType(value: unknown): value is ClientEventType {
  return typeof value === 'string' && (CLIENT_EVENTS as readonly string[]).includes(value);
}

export function isServerEventType(value: unknown): value is ServerEventType {
  return typeof value === 'string' && (SERVER_EVENTS as readonly string[]).includes(value);
}

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}
