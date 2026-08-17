/**
 * Outbound frame construction.
 *
 * Every server->client frame is built here so that the server-generated fields
 * (`id`, `timestamp`, `version`) are impossible to forget or to accidentally
 * source from a client frame.
 */
import { newFrameId } from '../util/ids';
import { nowIso } from '../util/time';
import {
  PROTOCOL_VERSION,
  RETRYABLE_ERROR_CODES,
  type ErrorPayload,
  type ProtocolErrorCode,
  type ServerEnvelope,
  type ServerEventPayloads,
  type ServerEventType,
} from './types';

/** Build a fully-stamped server frame. */
export function serverFrame<T extends ServerEventType>(
  type: T,
  payload: ServerEventPayloads[T],
): ServerEnvelope<T> {
  return {
    type,
    version: PROTOCOL_VERSION,
    id: newFrameId(),
    timestamp: nowIso(),
    payload,
  };
}

/** Serialise a frame for the wire. */
export function encodeFrame(frame: ServerEnvelope): string {
  return JSON.stringify(frame);
}

/** Build and serialise in one step. */
export function encode<T extends ServerEventType>(
  type: T,
  payload: ServerEventPayloads[T],
): string {
  return encodeFrame(serverFrame(type, payload));
}

/** Whether a client may sensibly retry the operation that produced this code. */
export function isRetryable(code: ProtocolErrorCode): boolean {
  return RETRYABLE_ERROR_CODES.includes(code);
}

/**
 * Build an `error` frame.
 *
 * `message` is a short, developer-authored explanation. It must never include
 * user content, Redis state, or a stack trace — callers pass literals, and the
 * INTERNAL_ERROR path deliberately discards the underlying error text.
 */
export function errorFrame(code: ProtocolErrorCode, message: string): ServerEnvelope<'error'> {
  const payload: ErrorPayload = { code, message, retryable: isRetryable(code) };
  return serverFrame('error', payload);
}

/** Build and serialise an `error` frame. */
export function encodeError(code: ProtocolErrorCode, message: string): string {
  return encodeFrame(errorFrame(code, message));
}
