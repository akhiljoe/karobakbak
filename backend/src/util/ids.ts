/**
 * Identifier generation.
 *
 * Every id that appears in a Redis key, a Pub/Sub channel name or a protocol
 * frame is generated here, from `crypto.randomBytes`. No client-supplied string
 * ever becomes part of a Redis key, which removes key-injection as a class of
 * bug. base64url output is safe in Redis keys, channel names and JSON.
 */
import { createHash, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

/** 128 bits of entropy, base64url encoded (22 chars, no padding). */
function randomToken(bytes = 16): string {
  return randomBytes(bytes).toString('base64url');
}

/** Identifies one logical anonymous session (1:1 with a WebSocket connection). */
export function newSessionId(): string {
  return `s_${randomToken()}`;
}

/** Identifies one conversation between exactly two sessions. */
export function newMatchId(): string {
  return `m_${randomToken()}`;
}

/**
 * Identifies one chat message. Server-generated: a client cannot choose or
 * collide message ids.
 */
export function newMessageId(): string {
  return `msg_${randomToken(12)}`;
}

/**
 * Identifies one outbound frame. Purely for client-side log correlation and
 * duplicate detection; carries no authority.
 */
export function newFrameId(): string {
  return `f_${randomToken(9)}`;
}

/**
 * The browser's block token.
 *
 * Server-generated, opaque, and carried in an HttpOnly cookie. It is a block
 * dimension and nothing else: it authorises no operation, is never read as
 * identity, and is deliberately cheap to rotate (D18, R14).
 */
export function newClientToken(): string {
  return randomToken();
}

/**
 * Identifies this backend process. Stable for the process lifetime and used
 * for the Redis liveness beacon that lets other instances detect a crash.
 *
 * The result becomes part of a Redis key (`chat:instance:{iid}`), so it is
 * reduced to key-safe characters here rather than at every key build. A
 * hostname routinely carries dots, and an operator-supplied `INSTANCE_ID` can
 * carry anything at all.
 */
export function newInstanceId(configured?: string): string {
  const raw = configured?.trim() || `i_${hostname()}-${process.pid}-${randomToken(4)}`;
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 128);
  return cleaned.length > 0 ? cleaned : `i_${randomToken(4)}`;
}

/**
 * Hash a client IP for use as a rate-limit key.
 *
 * Raw IPs are never stored in Redis and never logged: they are personal data
 * and this service is anonymous by design. A salted SHA-256 truncated to 128
 * bits keeps per-IP counting accurate while making the key non-reversible
 * without the salt.
 */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(salt).update('|').update(ip).digest('hex').slice(0, 32);
}
