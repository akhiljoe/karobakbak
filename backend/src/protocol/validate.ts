/**
 * Inbound frame parsing and validation.
 *
 * Everything a client sends is untrusted. This module turns a raw WebSocket
 * frame into either a narrow, fully-validated command or a protocol error
 * code. It never throws on bad input, never echoes user content back in an
 * error message, and never reads identity fields from the frame.
 */
import {
  CLIENT_ID_PATTERN,
  PROTOCOL_VERSION,
  isClientEventType,
  type ClientEventType,
  type MessagePayload,
  type ProtocolErrorCode,
} from './types';

/** A frame that passed every check, narrowed by event type. */
export type ValidatedCommand =
  | { type: 'join_queue'; clientId: string | null }
  | { type: 'leave_queue'; clientId: string | null }
  | { type: 'skip'; clientId: string | null }
  | { type: 'ping'; clientId: string | null }
  | { type: 'message'; clientId: string | null; text: string };

export type ParseResult =
  | { ok: true; command: ValidatedCommand }
  | { ok: false; code: ProtocolErrorCode; message: string };

export interface ValidationLimits {
  maxMessageLength: number;
}

function fail(code: ProtocolErrorCode, message: string): ParseResult {
  return { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Control characters that must never appear in chat text.
 * Newline (0x0A) and tab (0x09) are allowed; carriage return (0x0D) is allowed
 * because Windows clients send CRLF in multi-line input. Everything else in the
 * C0 range, plus DEL and the C1 range, is rejected — those bytes carry no
 * meaning in a text chat and are a classic terminal/log-injection vector.
 */
function hasForbiddenControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x09 || code === 0x0a || code === 0x0d) continue; // tab, LF, CR
    if (code <= 0x1f) return true; // remaining C0 controls
    if (code >= 0x7f && code <= 0x9f) return true; // DEL + C1 controls
  }
  return false;
}

/**
 * A lone surrogate is not valid Unicode. It survives JSON.parse but breaks
 * downstream UTF-8 encoding (it becomes U+FFFD), so reject it at the edge
 * rather than silently mutating a user's text.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Validates the `text` field of a `message` payload. */
export function validateMessageText(
  value: unknown,
  limits: ValidationLimits,
): { ok: true; text: string } | { ok: false; code: ProtocolErrorCode; message: string } {
  if (typeof value !== 'string') {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'payload.text must be a string' };
  }
  // Length is checked BEFORE trimming so a multi-megabyte whitespace payload is
  // rejected as oversized rather than as empty.
  if (value.length > limits.maxMessageLength) {
    return {
      ok: false,
      code: 'MESSAGE_TOO_LONG',
      message: `message exceeds ${limits.maxMessageLength} characters`,
    };
  }
  const text = value.trim();
  if (text.length === 0) {
    return { ok: false, code: 'EMPTY_MESSAGE', message: 'message is empty' };
  }
  if (hasForbiddenControlChar(text)) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'message contains forbidden control characters',
    };
  }
  if (LONE_SURROGATE.test(text)) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'message contains invalid unicode' };
  }
  return { ok: true, text };
}

/**
 * Parse a raw inbound frame.
 *
 * @param raw      frame contents as received from `ws`
 * @param isBinary whether the frame was a binary frame (binary is rejected:
 *                 this protocol is JSON text only)
 */
export function parseClientFrame(
  raw: string | Buffer,
  isBinary: boolean,
  limits: ValidationLimits,
): ParseResult {
  if (isBinary) {
    return fail('BAD_ENVELOPE', 'binary frames are not supported');
  }

  const text = typeof raw === 'string' ? raw : raw.toString('utf8');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail('BAD_JSON', 'frame is not valid JSON');
  }

  if (!isPlainObject(parsed)) {
    return fail('BAD_ENVELOPE', 'frame must be a JSON object');
  }

  if (parsed.version !== PROTOCOL_VERSION) {
    return fail('UNSUPPORTED_VERSION', `protocol version must be ${PROTOCOL_VERSION}`);
  }

  if (!isClientEventType(parsed.type)) {
    return fail('UNKNOWN_EVENT', 'unknown event type');
  }
  const type: ClientEventType = parsed.type;

  // `id` is an opaque correlation token. It is echoed back and never used as
  // identity, so it only has to be short and safely printable.
  let clientId: string | null = null;
  if (parsed.id !== undefined && parsed.id !== null) {
    if (typeof parsed.id !== 'string' || !CLIENT_ID_PATTERN.test(parsed.id)) {
      return fail('BAD_ENVELOPE', 'id must be 1-64 characters of [A-Za-z0-9_-]');
    }
    clientId = parsed.id;
  }

  // `timestamp` is deliberately not validated or read: the server restamps
  // every outbound frame and never trusts client clocks.

  const rawPayload = parsed.payload;
  if (rawPayload !== undefined && !isPlainObject(rawPayload)) {
    return fail('BAD_ENVELOPE', 'payload must be an object');
  }
  const payload: Record<string, unknown> = rawPayload ?? {};

  switch (type) {
    case 'join_queue':
    case 'leave_queue':
    case 'skip':
    case 'ping':
      return { ok: true, command: { type, clientId } };
    case 'message': {
      const result = validateMessageText((payload as Partial<MessagePayload>).text, limits);
      if (!result.ok) {
        return fail(result.code, result.message);
      }
      return { ok: true, command: { type: 'message', clientId, text: result.text } };
    }
    default: {
      // Exhaustiveness guard: adding a client event without handling it here
      // becomes a compile error.
      const exhaustive: never = type;
      return fail('UNKNOWN_EVENT', `unhandled event ${String(exhaustive)}`);
    }
  }
}
