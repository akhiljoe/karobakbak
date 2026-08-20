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
  DEFAULT_MESSAGE_CONTENT_TYPE,
  EMPTY_PROFILE,
  MAX_DECLARED_AGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DECLARED_AGE,
  PROTOCOL_VERSION,
  RESERVED_MEDIA_FIELDS,
  isClientEventType,
  isCountryCode,
  isGender,
  isMessageContentType,
  isReportCategory,
  type ClientEventType,
  type MessageContentType,
  type MessagePayload,
  type Profile,
  type ProtocolErrorCode,
  type ReportCategory,
  type ReportPayload,
  type TypingPayload,
} from './types';

/**
 * A frame that passed every check, narrowed by event type.
 *
 * `contentType` is separate from the command's own `type` discriminator: the
 * former is *what kind of content the message carries*, the latter is *which
 * command this is*. Today `contentType` is always `'text'`, but downstream code
 * switches on it rather than assuming, so adding a type later does not mean
 * hunting for implicit text assumptions (DESIGN.md §23).
 *
 * `message` is the one command whose `clientId` is non-nullable: it is the
 * per-match replay-protection key (I14), so a frame without one never reaches
 * a validated command at all.
 */
export type ValidatedCommand =
  | { type: 'join_queue'; clientId: string | null; profile: Profile }
  | { type: 'leave_queue'; clientId: string | null }
  | { type: 'leave_chat'; clientId: string | null }
  | { type: 'skip'; clientId: string | null }
  | { type: 'block'; clientId: string | null }
  | { type: 'ping'; clientId: string | null }
  | { type: 'typing'; clientId: string | null; active: boolean }
  | {
      type: 'report';
      clientId: string | null;
      category: ReportCategory;
      /** The reporter's own words, or null when they did not write any. */
      note: string | null;
    }
  | {
      type: 'message';
      clientId: string;
      contentType: MessageContentType;
      text: string;
    };

export type ParseResult =
  | { ok: true; command: ValidatedCommand }
  | { ok: false; code: ProtocolErrorCode; message: string };

export interface ValidationLimits {
  maxMessageLength: number;
  maxReportNoteLength: number;
}

function fail(code: ProtocolErrorCode, message: string): ParseResult {
  return { ok: false, code, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Control characters that must never appear in user text.
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

/**
 * Character-level checks shared by every field of user-authored text.
 *
 * Report notes get exactly the same treatment as message bodies: both are
 * user-generated content under invariant I8, and a note is just as capable of
 * carrying a terminal escape into a moderator's console as a message is.
 *
 * `label` is a developer-authored constant naming the field. It is never the
 * value — an error message must not carry user content back out.
 */
function checkTextCharacters(
  text: string,
  label: string,
): { ok: false; code: ProtocolErrorCode; message: string } | null {
  if (hasForbiddenControlChar(text)) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `${label} contains forbidden control characters`,
    };
  }
  if (LONE_SURROGATE.test(text)) {
    return { ok: false, code: 'VALIDATION_FAILED', message: `${label} contains invalid unicode` };
  }
  return null;
}

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
  const bad = checkTextCharacters(text, 'message');
  if (bad) return bad;
  return { ok: true, text };
}

/**
 * Validates the optional `note` field of a `report` payload.
 *
 * Absent, null and whitespace-only all normalise to `null` rather than to an
 * empty string, so the persistence layer stores "no note" one way instead of
 * three. An over-length note is `VALIDATION_FAILED`, not `MESSAGE_TOO_LONG`:
 * the message-specific code would mislead a client into retrying against the
 * message limit.
 */
export function validateReportNote(
  value: unknown,
  limits: ValidationLimits,
): { ok: true; note: string | null } | { ok: false; code: ProtocolErrorCode; message: string } {
  if (value === undefined || value === null) {
    return { ok: true, note: null };
  }
  if (typeof value !== 'string') {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'payload.note must be a string' };
  }
  if (value.length > limits.maxReportNoteLength) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: `report note exceeds ${limits.maxReportNoteLength} characters`,
    };
  }
  const note = value.trim();
  if (note.length === 0) {
    return { ok: true, note: null };
  }
  const bad = checkTextCharacters(note, 'report note');
  if (bad) return bad;
  return { ok: true, note };
}

/**
 * Validate the optional self-declared profile on a `join_queue` payload.
 *
 * Absent, null, and every-field-declined all normalise to the same empty
 * profile, so downstream code has one shape for "told us nothing" instead of
 * three. There is no partial update: a join without a field clears it, which is
 * what stops a client believing it removed something the server still shows.
 *
 * The four fields need different kinds of care:
 *
 *  * `name` is free text a stranger reads, so it gets exactly the treatment a
 *    message body gets — length before trim, then the shared control-character
 *    and lone-surrogate checks. Moderation is a *separate* pass at the edge
 *    (a name is a fine place to advertise a Telegram handle); this is only the
 *    character-level gate.
 *  * `country` must be a code from the fixed list. Anything else is refused
 *    rather than dropped, because silently ignoring an unknown code would let a
 *    client believe it had set a country it had not.
 *  * `age` is refused below `MIN_DECLARED_AGE` with its own code, so the client
 *    can say what the service is and the server can record the declaration as a
 *    safety signal rather than inferring it from a generic failure.
 *  * `gender` is a value from a closed list, for the same reason as `country`:
 *    a free-text identity field would need moderating like a message body.
 */
export function validateProfile(
  value: unknown,
): { ok: true; profile: Profile } | { ok: false; code: ProtocolErrorCode; message: string } {
  if (value === undefined || value === null) return { ok: true, profile: EMPTY_PROFILE };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'VALIDATION_FAILED', message: 'payload.profile must be an object' };
  }
  const raw = value as { name?: unknown; country?: unknown; age?: unknown; gender?: unknown };

  let name: string | null = null;
  if (raw.name !== undefined && raw.name !== null) {
    if (typeof raw.name !== 'string') {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'profile.name must be a string' };
    }
    if (raw.name.length > MAX_DISPLAY_NAME_LENGTH) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `profile.name exceeds ${MAX_DISPLAY_NAME_LENGTH} characters`,
      };
    }
    const trimmed = raw.name.trim();
    if (trimmed.length > 0) {
      const bad = checkTextCharacters(trimmed, 'profile name');
      if (bad) return bad;
      name = trimmed;
    }
  }

  let country: string | null = null;
  if (raw.country !== undefined && raw.country !== null && raw.country !== '') {
    if (!isCountryCode(raw.country)) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'profile.country must be an ISO 3166-1 alpha-2 code',
      };
    }
    country = raw.country;
  }

  let age: number | null = null;
  if (raw.age !== undefined && raw.age !== null) {
    if (typeof raw.age !== 'number' || !Number.isInteger(raw.age)) {
      return { ok: false, code: 'VALIDATION_FAILED', message: 'profile.age must be a whole number' };
    }
    if (raw.age < MIN_DECLARED_AGE) {
      return {
        ok: false,
        code: 'AGE_BELOW_MINIMUM',
        message: `this service is for ${MIN_DECLARED_AGE} and over`,
      };
    }
    if (raw.age > MAX_DECLARED_AGE) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: `profile.age must be at most ${MAX_DECLARED_AGE}`,
      };
    }
    age = raw.age;
  }

  let gender: string | null = null;
  if (raw.gender !== undefined && raw.gender !== null && raw.gender !== '') {
    if (!isGender(raw.gender)) {
      return {
        ok: false,
        code: 'VALIDATION_FAILED',
        message: 'profile.gender is not one of the accepted values',
      };
    }
    gender = raw.gender;
  }

  return { ok: true, profile: { name, country, age, gender } };
}

/**
 * Validate the content-type discriminator on a `message` payload.
 *
 * Two distinct controls, both required because `type` is client-supplied and
 * therefore a spoofing surface (DESIGN.md §23.6):
 *
 *  1. **Only implemented types are accepted.** A client naming a content type
 *     this server does not implement — including a plausible future one like
 *     `image` — is rejected, not coerced to text. Coercing would mean a client
 *     could believe it sent an image while the partner received a text frame.
 *  2. **Reserved media fields are rejected, not ignored.** A payload carrying
 *     `mediaId`, `attachment`, `url` and friends is refused outright, so a
 *     fabricated media reference cannot be smuggled past a server that has no
 *     concept of media, and so a client is never told "accepted" for content
 *     that was silently discarded.
 */
function validateContentType(
  payload: Record<string, unknown>,
):
  | { ok: true; contentType: MessageContentType }
  | { ok: false; code: ProtocolErrorCode; message: string } {
  for (const field of RESERVED_MEDIA_FIELDS) {
    if (payload[field] !== undefined) {
      return {
        ok: false,
        code: 'UNSUPPORTED_CONTENT_TYPE',
        message: `payload.${field} is reserved for future media support and is not accepted`,
      };
    }
  }

  const raw = payload.type;
  if (raw === undefined || raw === null) {
    return { ok: true, contentType: DEFAULT_MESSAGE_CONTENT_TYPE };
  }
  if (!isMessageContentType(raw)) {
    // The reason is deliberately generic: it does not enumerate which types
    // might exist later, and it never echoes the client-supplied value.
    return {
      ok: false,
      code: 'UNSUPPORTED_CONTENT_TYPE',
      message: 'unsupported message content type',
    };
  }
  return { ok: true, contentType: raw };
}

/**
 * Parse a raw inbound frame.
 *
 * @param raw      frame contents as received from `ws`
 * @param isBinary whether the frame was a binary frame (binary is rejected:
 *                 this protocol is JSON text only, and is never a media
 *                 transport — see DESIGN.md §23.2)
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

  // `id` is a correlation token. It is echoed back and, on `message`, used as
  // the per-match dedupe key; it is never used as identity, so it only has to
  // be short and safely printable.
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
    case 'join_queue': {
      const profile = validateProfile((payload as { profile?: unknown }).profile);
      if (!profile.ok) return fail(profile.code, profile.message);
      return { ok: true, command: { type, clientId, profile: profile.profile } };
    }
    case 'leave_queue':
    case 'leave_chat':
    case 'skip':
    case 'block':
    case 'ping':
      return { ok: true, command: { type, clientId } };
    case 'typing': {
      const active = (payload as Partial<TypingPayload>).active;
      // Strict boolean, not truthiness: accepting "false" or 0 here would make
      // a client's stop-typing frame mean whatever the coercion rules decided.
      if (typeof active !== 'boolean') {
        return fail('VALIDATION_FAILED', 'payload.active must be a boolean');
      }
      return { ok: true, command: { type: 'typing', clientId, active } };
    }
    case 'report': {
      const category = (payload as Partial<ReportPayload>).category;
      if (!isReportCategory(category)) {
        // The value is not echoed: a report category is a closed enum and the
        // client already knows the list from the protocol.
        return fail('VALIDATION_FAILED', 'payload.category is not a known report category');
      }
      const note = validateReportNote((payload as Partial<ReportPayload>).note, limits);
      if (!note.ok) {
        return fail(note.code, note.message);
      }
      return { ok: true, command: { type: 'report', clientId, category, note: note.note } };
    }
    case 'message': {
      // The envelope id is required here and nowhere else: it is the replay
      // protection key (I14, D24). Checked before the payload so a client that
      // forgot it is told the structural problem rather than a content one.
      if (clientId === null) {
        return fail('BAD_ENVELOPE', 'message requires an envelope id');
      }
      const contentType = validateContentType(payload);
      if (!contentType.ok) {
        return fail(contentType.code, contentType.message);
      }
      const result = validateMessageText((payload as Partial<MessagePayload>).text, limits);
      if (!result.ok) {
        return fail(result.code, result.message);
      }
      return {
        ok: true,
        command: {
          type: 'message',
          clientId,
          contentType: contentType.contentType,
          text: result.text,
        },
      };
    }
    default: {
      // Exhaustiveness guard: adding a client event without handling it here
      // becomes a compile error.
      const exhaustive: never = type;
      return fail('UNKNOWN_EVENT', `unhandled event ${String(exhaustive)}`);
    }
  }
}
