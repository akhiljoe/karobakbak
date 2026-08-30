/**
 * Webhook signature verification.
 *
 * Separate from `gateway.ts` and importing no vendor SDK, for two reasons. It
 * is the security boundary of the whole payment path — everything downstream
 * treats the body as authentic — so it wants a unit test that runs without a
 * network, a key or a mock. And keeping it out of the adapter means the one
 * file that pulls in `razorpay` is only reached when an order is actually being
 * created, never on the inbound path.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export type SignatureVerdict = 'valid' | 'invalid' | 'malformed' | 'unconfigured';

/**
 * Whether `body` was signed with `secret`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE RAW BYTES AND NOT A PARSED OBJECT
 * ---------------------------------------------------------------------------
 * The signature covers the exact bytes Razorpay sent. Parsing to JSON and
 * re-serialising produces a different byte string — key order, whitespace,
 * unicode escaping — and the comparison would fail for correct requests and,
 * worse, could be made to succeed for a body that parses to something other
 * than what was signed. The caller keeps the `Buffer` and parses only after
 * this returns `valid`.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT `===`
 * ---------------------------------------------------------------------------
 * A byte-by-byte comparison that returns early leaks, through timing, how much
 * of a guessed signature was right — which turns forging one from infeasible
 * into a few thousand requests. `timingSafeEqual` throws on a length mismatch,
 * so the lengths are checked first and a wrong-length signature is rejected as
 * malformed rather than compared. That leaks only the length of a hex-encoded
 * SHA-256, which is a constant.
 */
export function verifyWebhookSignature(
  body: Buffer,
  presented: unknown,
  secret: string,
): SignatureVerdict {
  // An unset secret must never verify. The alternative — a development
  // fallback string — means a deployment that forgot the variable accepts
  // webhooks signed with a value that is public in this repository, and the
  // symptom is not an error but a stranger granting themselves premium.
  if (secret === '') return 'unconfigured';

  if (typeof presented !== 'string' || presented === '') return 'malformed';
  // Hex only, and exactly the width of a SHA-256. Anything else cannot be a
  // signature we would have produced, and rejecting it here keeps a hostile
  // header out of `Buffer.from`.
  if (!/^[0-9a-f]{64}$/i.test(presented)) return 'malformed';

  const expected = createHmac('sha256', secret).update(body).digest();
  const supplied = Buffer.from(presented, 'hex');
  if (supplied.length !== expected.length) return 'malformed';

  return timingSafeEqual(expected, supplied) ? 'valid' : 'invalid';
}
