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
 *                                                   echoed back only
 */

export const PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Event names                                                                */
/* -------------------------------------------------------------------------- */

export const CLIENT_EVENTS = ['join_queue', 'leave_queue', 'message', 'skip', 'ping'] as const;
export type ClientEventType = (typeof CLIENT_EVENTS)[number];

export const SERVER_EVENTS = [
  'connected',
  'queue_status',
  'matched',
  'message',
  'message_ack',
  'partner_skipped',
  'partner_disconnected',
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
 * outbound frame. `id` on inbound frames is an optional client correlation
 * token (<= MAX_CLIENT_ID_LENGTH chars, [A-Za-z0-9_-]) returned verbatim in
 * `message_ack.clientMsgId`.
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
/* Client -> server payloads                                                  */
/* -------------------------------------------------------------------------- */

/** Enter matchmaking. Idempotent while already SEARCHING. Changes state. */
export type JoinQueuePayload = Record<string, never>;

/** Leave matchmaking without disconnecting. Idempotent. Changes state. */
export type LeaveQueuePayload = Record<string, never>;

/** End the current match and immediately search again. Idempotent. Changes state. */
export type SkipPayload = Record<string, never>;

/** Liveness probe; also refreshes server-side session TTLs. No state change. */
export type PingPayload = Record<string, never>;

/**
 * Send one chat message to the current partner.
 * Not idempotent: re-sending delivers twice. Clients generate a fresh
 * envelope `id` per send.
 * The recipient is NEVER specified by the client; it is resolved from the
 * server's authoritative match record.
 */
export interface MessagePayload {
  text: string;
}

export interface ClientEventPayloads {
  join_queue: JoinQueuePayload;
  leave_queue: LeaveQueuePayload;
  message: MessagePayload;
  skip: SkipPayload;
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
  messagesPerSecond: number;
  burst: number;
  maxFrameBytes: number;
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
}

/** Result of join_queue / leave_queue / a no-op skip. */
export interface QueueStatusPayload {
  state: SessionState;
  /** Global number of sessions currently waiting. Coarse, cached, non-authoritative. */
  waiting: number;
}

/** A pair was formed. The partner's session id is deliberately NOT included. */
export interface MatchedPayload {
  matchId: string;
  startedAt: string;
}

/** Inbound message from the stranger. `text` is untrusted plain text. */
export interface IncomingMessagePayload {
  matchId: string;
  messageId: string;
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
 */
export interface MessageAckPayload {
  clientMsgId: string | null;
  messageId: string;
  matchId: string;
  acceptedAt: string;
  route: 'local' | 'remote';
}

export interface PartnerSkippedPayload {
  matchId: string;
}

export interface PartnerDisconnectedPayload {
  matchId: string;
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
  matched: MatchedPayload;
  message: IncomingMessagePayload;
  message_ack: MessageAckPayload;
  partner_skipped: PartnerSkippedPayload;
  partner_disconnected: PartnerDisconnectedPayload;
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
  /** Frame was JSON but not a well-formed envelope. */
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
