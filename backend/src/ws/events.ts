/**
 * Cross-instance session events (`DESIGN.md` §11).
 *
 * One channel per live session, `chat:ev:session:{sid}`. The channel name is
 * the routing key, so there is no routing table to invalidate (D8).
 *
 * ---------------------------------------------------------------------------
 * WHY THE PAYLOAD IS VALIDATED ON ARRIVAL
 * ---------------------------------------------------------------------------
 * These payloads are published by our own instances, so this is not a trust
 * boundary in the way a client frame is. It is still parsed defensively,
 * because the sender may be a *different version* of this code mid-deploy, and
 * because a malformed event must degrade into "no UI update" rather than into a
 * thrown exception on the receiving socket's message path.
 *
 * A dropped event is acceptable by design: every event here reports state that
 * is already committed in Redis, so the worst case is one stale label that the
 * client's next action corrects.
 */
import type { Identity, MessageContentType, Profile, ServerEnvelope } from '../protocol/types';
import { serverFrame } from '../protocol/envelope';

/** Envelope version for the internal bus. Independent of the wire protocol version. */
export const SESSION_EVENT_VERSION = 1;

export type SessionEvent =
  | { event: 'matched'; matchId: string; startedAt: string; you: Identity; partner: Identity }
  | {
      event: 'message';
      matchId: string;
      messageId: string;
      contentType: MessageContentType;
      text: string;
      sentAt: string;
    }
  | { event: 'partner_typing'; matchId: string; active: boolean }
  | { event: 'partner_skipped'; matchId: string }
  /** Their socket dropped and the seat is held until `until` (§28). */
  | { event: 'partner_reconnecting'; matchId: string; until: string }
  /** They came back inside the window; the conversation continues. */
  | { event: 'partner_returned'; matchId: string }
  | { event: 'partner_disconnected'; matchId: string }
  /** The session was reaped server-side; the socket should be closed, not updated. */
  | { event: 'session_evicted'; matchId: string; reason: 'reaped' | 'shutdown' };

export type SessionEventName = SessionEvent['event'];

/** The wire form: `{ v, event, matchId, at, data }`. */
interface WireEvent {
  v: number;
  event: string;
  matchId: string;
  at: string;
  data: Record<string, unknown>;
}

export function encodeSessionEvent(event: SessionEvent, at: string): string {
  const { event: name, matchId, ...data } = event;
  const wire: WireEvent = { v: SESSION_EVENT_VERSION, event: name, matchId, at, data };
  return JSON.stringify(wire);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIdentity(value: unknown): value is Identity {
  return (
    isPlainObject(value) && typeof value.nickname === 'string' && typeof value.colour === 'string'
  );
}

/**
 * Read a profile out of a published event.
 *
 * Tolerant on purpose: an instance running an older build publishes a `matched`
 * event with no `profile` key at all, and during a rolling deploy that must
 * degrade to "declared nothing" rather than dropping the whole event and losing
 * the match. Each field is checked individually for the same reason.
 */
function readProfile(value: unknown): Profile | null {
  if (!isPlainObject(value)) return null;
  return {
    name: typeof value.name === 'string' ? value.name : null,
    country: typeof value.country === 'string' ? value.country : null,
    age: typeof value.age === 'number' ? value.age : null,
    gender: typeof value.gender === 'string' ? value.gender : null,
  };
}

/**
 * Parse a published payload. Returns null for anything unrecognised — including
 * an event name a newer instance introduced, which is precisely the case that
 * must not throw during a rolling deploy.
 */
export function decodeSessionEvent(payload: string): SessionEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.v !== SESSION_EVENT_VERSION) return null;
  if (typeof parsed.event !== 'string' || typeof parsed.matchId !== 'string') return null;

  const data = isPlainObject(parsed.data) ? parsed.data : {};
  const matchId = parsed.matchId;

  switch (parsed.event) {
    case 'matched':
      if (typeof data.startedAt !== 'string') return null;
      if (!isIdentity(data.you) || !isIdentity(data.partner)) return null;
      return {
        event: 'matched',
        matchId,
        startedAt: data.startedAt,
        you: {
          nickname: data.you.nickname,
          colour: data.you.colour,
          profile: readProfile(data.you.profile),
        },
        partner: {
          nickname: data.partner.nickname,
          colour: data.partner.colour,
          profile: readProfile(data.partner.profile),
        },
      };
    case 'message':
      if (typeof data.messageId !== 'string' || typeof data.text !== 'string') return null;
      if (typeof data.sentAt !== 'string' || data.contentType !== 'text') return null;
      return {
        event: 'message',
        matchId,
        messageId: data.messageId,
        contentType: 'text',
        text: data.text,
        sentAt: data.sentAt,
      };
    case 'partner_typing':
      if (typeof data.active !== 'boolean') return null;
      return { event: 'partner_typing', matchId, active: data.active };
    case 'partner_skipped':
      return { event: 'partner_skipped', matchId };
    case 'partner_reconnecting':
      if (typeof data.until !== 'string') return null;
      return { event: 'partner_reconnecting', matchId, until: data.until };
    case 'partner_returned':
      return { event: 'partner_returned', matchId };
    case 'partner_disconnected':
      return { event: 'partner_disconnected', matchId };
    case 'session_evicted':
      if (data.reason !== 'reaped' && data.reason !== 'shutdown') return null;
      return { event: 'session_evicted', matchId, reason: data.reason };
    default:
      return null;
  }
}

/**
 * Turn an event into the frame its recipient should receive.
 *
 * `session_evicted` has no frame: the socket is closed rather than told
 * anything, because there is no session left for a client to act on.
 */
export function toClientFrame(event: SessionEvent): ServerEnvelope | null {
  switch (event.event) {
    case 'matched':
      return serverFrame('matched', {
        matchId: event.matchId,
        startedAt: event.startedAt,
        you: event.you,
        partner: event.partner,
      });
    case 'message':
      return serverFrame('message', {
        matchId: event.matchId,
        messageId: event.messageId,
        type: event.contentType,
        text: event.text,
        sentAt: event.sentAt,
        from: 'partner',
      });
    case 'partner_typing':
      return serverFrame('partner_typing', { matchId: event.matchId, active: event.active });
    case 'partner_skipped':
      return serverFrame('partner_skipped', { matchId: event.matchId });
    case 'partner_reconnecting':
      return serverFrame('partner_reconnecting', { matchId: event.matchId, until: event.until });
    case 'partner_returned':
      // A real frame, not an inference. Without it the partner's countdown runs
      // to zero while the stranger is already back and typing, and the
      // interface says they left when they did not.
      return serverFrame('partner_returned', { matchId: event.matchId });
    case 'partner_disconnected':
      return serverFrame('partner_disconnected', { matchId: event.matchId });
    case 'session_evicted':
      return null;
    default: {
      // Compile-time exhaustiveness only. The thrown value is a constant: one
      // arm of this union carries message text, and an interpolated error
      // message is a log line waiting to happen (I8).
      const exhaustive: never = event;
      void exhaustive;
      throw new Error('unhandled session event');
    }
  }
}
