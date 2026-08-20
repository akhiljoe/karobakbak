/**
 * Time-based one-time passwords (RFC 6238), built on RFC 4226 HOTP.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * This is not invented cryptography. TOTP is HMAC-SHA1 over a counter derived
 * from the clock, plus a truncation rule the RFC spells out byte by byte. The
 * HMAC comes from `node:crypto`; what lives here is the counter arithmetic,
 * the truncation, and base32 encoding for the enrolment URI.
 *
 * The reason that is safe to write rather than install: both RFCs publish test
 * vectors, so correctness is *demonstrated against the specification's own
 * numbers* rather than assumed. `tests/unit/totp.test.ts` runs the full RFC
 * 4226 Appendix D and RFC 6238 Appendix B tables. If a byte of this is wrong,
 * those fail.
 *
 * SHA-1 is correct here and is not a weakness. HMAC-SHA1 is unbroken — the
 * collision attacks on SHA-1 do not apply to HMAC — and every authenticator
 * app implements SHA-1 TOTP. Choosing SHA-256 would lock out a fraction of
 * apps for no security gain on a 6-digit code that lives for 30 seconds.
 *
 * ---------------------------------------------------------------------------
 * REPLAY
 * ---------------------------------------------------------------------------
 * A code stays valid for a whole step, and this module accepts a small window
 * either side of now for clock drift — so the same code is legitimately
 * accepted more than once within a minute unless something remembers it. That
 * something is not here: `verifyTotp` returns *which* counter matched, and the
 * caller persists it and refuses any counter less than or equal to the last
 * one used. Replay defence needs storage, and storage belongs to the caller.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** RFC 4648 base32, uppercase, no padding — what authenticator apps expect. */
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 6238 §4: 30 seconds is the near-universal step and what apps assume. */
export const TOTP_STEP_SECONDS = 30;

/** Six digits, as every authenticator app displays. */
export const TOTP_DIGITS = 6;

/**
 * How many steps either side of now are accepted.
 *
 * One step — thirty seconds — absorbs ordinary clock drift and the seconds a
 * person spends typing. Widening it multiplies the number of codes valid at
 * any instant, which is exactly the quantity a brute-force attempt benefits
 * from, so it stays at one.
 */
export const TOTP_WINDOW_STEPS = 1;

/** 160 bits, matching the HMAC-SHA1 block, as RFC 4226 §4 recommends. */
const SECRET_BYTES = 20;

export interface TotpVerification {
  /** The counter that matched, for the caller's replay check. */
  counter: number;
}

/** A fresh shared secret, base32 encoded for an authenticator app. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

/**
 * The `otpauth://` URI an authenticator app scans.
 *
 * `issuer` appears twice — as a label prefix and as a parameter — because apps
 * disagree about which one they read, and an account that shows up as a bare
 * username in a list of thirty is one nobody can identify later.
 */
export function totpUri(secret: string, account: string, issuer = 'karobakbak'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * RFC 4226 HOTP: HMAC-SHA1, then dynamic truncation.
 *
 * The counter is written as a 64-bit big-endian integer. `writeBigUInt64BE`
 * rather than two 32-bit halves: the halving is where hand-rolled
 * implementations usually go wrong, and it only shows up after 2^31 steps —
 * about the year 3990, or immediately in a test with a large timestamp. RFC
 * 6238's own vectors include one (20000000000) for exactly this reason.
 */
export function hotp(secret: string, counter: number, digits = TOTP_DIGITS): string {
  const key = base32Decode(secret);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', key).update(message).digest();

  // Dynamic truncation, RFC 4226 §5.4. The low nibble of the last byte picks
  // the offset; the high bit of the selected word is masked off so the result
  // is positive on platforms with signed 32-bit arithmetic.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The counter for a moment in time. */
export function totpCounter(nowMs: number): number {
  return Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Verify a submitted code.
 *
 * Returns the matching counter so the caller can reject a replay, or null if
 * no counter in the window produced this code.
 *
 * `minCounter` lets the caller refuse a code at or below the last one it
 * accepted without this module needing to know where that was stored.
 */
export function verifyTotp(
  secret: string,
  code: string,
  options: { nowMs?: number; minCounter?: number; digits?: number } = {},
): TotpVerification | null {
  const digits = options.digits ?? TOTP_DIGITS;
  const submitted = code.trim();
  // Length is checked before any HMAC so a pathological input costs nothing,
  // and because a non-digit string can never match a generated code anyway.
  if (submitted.length !== digits || !/^[0-9]+$/.test(submitted)) return null;

  const centre = totpCounter(options.nowMs ?? Date.now());
  const floor = options.minCounter ?? Number.NEGATIVE_INFINITY;

  for (let drift = -TOTP_WINDOW_STEPS; drift <= TOTP_WINDOW_STEPS; drift += 1) {
    const counter = centre + drift;
    if (counter < 0 || counter <= floor) continue;
    // Constant-time compare. The codes being compared are short and one side
    // is public, so this is close to ceremony — but a timing oracle on a
    // 6-digit space is a real reduction in work, and the cost is nothing.
    if (equalConstantTime(hotp(secret, counter, digits), submitted)) return { counter };
  }
  return null;
}

function equalConstantTime(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/* -------------------------------------------------------------------------- */
/* base32                                                                     */
/* -------------------------------------------------------------------------- */

export class InvalidTotpSecretError extends Error {
  constructor() {
    // Never echoes the secret. This error is the one most likely to be caught
    // and logged by a caller in a hurry.
    super('TOTP secret is not valid base32');
    this.name = 'InvalidTotpSecretError';
  }
}

export function base32Encode(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

/**
 * Decode base32, tolerantly on shape and strictly on content.
 *
 * Padding and spaces are stripped and lower case is accepted, because those
 * are how a secret arrives when a human retypes one. An out-of-alphabet
 * character is refused rather than skipped: silently ignoring it would decode
 * a mistyped secret into a *different valid key*, and the failure would show
 * up as "my authenticator codes never work" with nothing to point at.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  if (cleaned.length === 0) throw new InvalidTotpSecretError();

  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new InvalidTotpSecretError();
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}
