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
 * A session resume token (§28).
 *
 * 256 bits, because this one is a bearer credential: whoever holds it can
 * reclaim the conversation it belongs to. Short-lived, single-use, and stored
 * only as a hash — see `hashResumeToken`.
 */
export function newResumeToken(): string {
  return randomToken(32);
}

/**
 * Hash a resume token for storage.
 *
 * SHA-256, unsalted, and that is correct here rather than lazy: the input is
 * 256 bits of `crypto.randomBytes`, so there is no dictionary to slow an
 * attacker down over and nothing a salt would protect against. A password needs
 * a KDF because people choose passwords; this is not one.
 */
export function hashResumeToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Identifies one audit row.
 *
 * Generated here like every other id rather than left to a database default,
 * so a caller can name the row it just wrote — an audit entry nobody can cite
 * is harder to follow up than one with an id.
 */
export function newAuditId(): string {
  return `aud_${randomToken()}`;
}

/**
 * Identifies one signed-in account (§32).
 *
 * Generated here rather than taken from the identity provider's `sub`, which is
 * the obvious shortcut. Payments reference this key, and handing it to a vendor
 * means the identifier a financial record is built on is defined by a system
 * this project does not control — see `014_account_identity.sql`.
 */
export function newAccountId(): string {
  return `acc_${randomToken()}`;
}

/**
 * The bearer token a browser holds after signing in.
 *
 * 256 bits, like the resume token, and for the same reason: it is stored only
 * as an unsalted SHA-256, which is safe precisely because there is no
 * dictionary to defeat when the input is this size.
 */
export function newSessionToken(): string {
  return randomToken(32);
}

/** Identifies one operator account. Opaque, so it can appear in an audit row. */
export function newAdminAccountId(): string {
  return `adm_${randomToken()}`;
}

/**
 * The receipt string sent to the payment provider with an order.
 *
 * Random, and carrying nothing. The obvious version composes it from the
 * account id and a timestamp — which is readable, and which publishes our
 * internal identifier into a third party's dashboard, exports and support
 * tooling for every order ever placed. The receipt exists so a human can match
 * one record to another; a random string does that, and the join lives in
 * `payment_orders` where it belongs.
 */
export function newPaymentReceipt(): string {
  return `rcpt_${randomToken()}`;
}

/**
 * A console session cookie.
 *
 * 256 bits rather than the 128 used elsewhere. This value alone authorises
 * reading every retained conversation, and unlike a session id it is a bearer
 * token — whoever holds it is the moderator. The extra sixteen bytes cost
 * nothing and remove any argument about the margin.
 *
 * Only its SHA-256 is stored, so the database never holds a usable token.
 */
export function newAdminSessionToken(): string {
  return randomToken(32);
}

/**
 * Identifies one enforcement decision — a ban, a suspension, a revocation.
 *
 * Generated here rather than left to the database default because the value is
 * written to *two* places that must agree: the `enforcement` row and the Redis
 * ban key whose value is this id. A database-side default would only be known
 * after the insert returned, so the key would either be written second (a
 * window where the row exists and the ban does not) or written with a different
 * value (a refusal that cannot be traced back to its justification).
 */
export function newEnforcementId(): string {
  return `enf_${randomToken()}`;
}

/**
 * The dimensions an enforcement decision is written across. One row each, all
 * sharing a base id with the dimension folded onto the end.
 */
export const ENFORCEMENT_DIMENSIONS = ['ip', 'client'] as const;

/**
 * `enf_` plus exactly the 22 base64url characters `randomToken()` produces from
 * 16 bytes. Anchored at both ends, so nothing else is a valid base id.
 */
const ENFORCEMENT_BASE_ID = /^enf_[A-Za-z0-9_-]{22}$/;

/**
 * Turn whatever the console supplied into the exact row ids it may act on.
 *
 * Callers used to interpolate this value into `enforcement_id like $1 || '%'`,
 * which had two faults, one of them severe:
 *
 *  * `%` and `_` are wildcards in SQL `LIKE`. A console session submitting `%`
 *    matched — and revoked — every enforcement row in the table, and the audit
 *    entry recorded the wildcard rather than the sanctions it lifted.
 *  * base64url includes `_`, so even a well-formed, server-generated id was a
 *    pattern with single-character wildcards scattered through it. Two ids
 *    differing only where an underscore fell would have matched each other.
 *
 * A prefix match was never what was wanted anyway: the rows to act on are
 * known exactly, because this process generates the only ids that exist. So
 * validate the shape and return the exhaustive list, for `= any($1::text[])`.
 *
 * Accepts either form the console holds — the base id returned by `issueBan`,
 * or one of the per-dimension ids returned by the listings. A base id whose
 * random part happens to end in `_ip` is still read as a base id, because the
 * stripped candidate would be the wrong length.
 *
 * Returns null for anything that is not a well-formed id. Null is a refusal,
 * never an empty match.
 *
 * The `base` comes back beside the rows because that is what belongs in an
 * audit entry: the decision, rather than whichever of its two forms the console
 * happened to be holding.
 */
export function enforcementRowIds(
  supplied: string,
): { base: string; rowIds: string[] } | null {
  let base = supplied;
  for (const dimension of ENFORCEMENT_DIMENSIONS) {
    const suffix = `_${dimension}`;
    if (!supplied.endsWith(suffix)) continue;
    const candidate = supplied.slice(0, -suffix.length);
    if (ENFORCEMENT_BASE_ID.test(candidate)) {
      base = candidate;
      break;
    }
  }
  if (!ENFORCEMENT_BASE_ID.test(base)) return null;
  return { base, rowIds: ENFORCEMENT_DIMENSIONS.map((dimension) => `${base}_${dimension}`) };
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
