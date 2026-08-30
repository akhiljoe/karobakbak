import { createHmac } from 'node:crypto';

import { verifyWebhookSignature } from '../../src/payments/signature';

const SECRET = 'whsec_test_value';

function sign(body: Buffer | string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifyWebhookSignature', () => {
  it('accepts a signature over the exact bytes received', () => {
    const body = Buffer.from('{"event":"payment.captured"}', 'utf8');
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe('valid');
  });

  it('refuses a body that was signed with a different secret', () => {
    const body = Buffer.from('{"event":"payment.captured"}', 'utf8');
    expect(verifyWebhookSignature(body, sign(body, 'someone_elses_secret'), SECRET)).toBe('invalid');
  });

  it('refuses a body that changed after it was signed', () => {
    const original = Buffer.from('{"amount":9900}', 'utf8');
    const tampered = Buffer.from('{"amount":100}', 'utf8');
    expect(verifyWebhookSignature(tampered, sign(original), SECRET)).toBe('invalid');
  });

  /**
   * The reason the caller keeps the raw Buffer instead of re-serialising a
   * parsed object. These two bodies parse to the same value and have different
   * bytes, so a verifier working from the parsed form would accept a signature
   * that does not cover what it verified.
   */
  it('is sensitive to bytes that JSON.parse would treat as identical', () => {
    const signed = Buffer.from('{"a":1,"b":2}', 'utf8');
    const reserialised = Buffer.from('{"b":2,"a":1}', 'utf8');
    expect(JSON.parse(signed.toString())).toEqual(JSON.parse(reserialised.toString()));
    expect(verifyWebhookSignature(reserialised, sign(signed), SECRET)).toBe('invalid');
  });

  /**
   * The control that stops a forgotten environment variable becoming an open
   * door. The rejected prototype defaulted the secret to a literal published in
   * the repository, which would verify anything an attacker signed with it.
   */
  it('never verifies when no secret is configured, even against a correct HMAC', () => {
    const body = Buffer.from('{"event":"payment.captured"}', 'utf8');
    expect(verifyWebhookSignature(body, sign(body, ''), '')).toBe('unconfigured');
  });

  it('rejects signatures that are not hex-encoded SHA-256, without comparing them', () => {
    const body = Buffer.from('{}', 'utf8');
    expect(verifyWebhookSignature(body, '', SECRET)).toBe('malformed');
    expect(verifyWebhookSignature(body, 'not-hex', SECRET)).toBe('malformed');
    // Right alphabet, wrong width.
    expect(verifyWebhookSignature(body, 'abcdef', SECRET)).toBe('malformed');
    // Right width, wrong alphabet.
    expect(verifyWebhookSignature(body, 'z'.repeat(64), SECRET)).toBe('malformed');
    expect(verifyWebhookSignature(body, undefined, SECRET)).toBe('malformed');
    expect(verifyWebhookSignature(body, 12345, SECRET)).toBe('malformed');
  });

  it('accepts either case of hex, which is what an intermediary may normalise to', () => {
    const body = Buffer.from('{"event":"refund.processed"}', 'utf8');
    expect(verifyWebhookSignature(body, sign(body).toUpperCase(), SECRET)).toBe('valid');
  });

  it('verifies an empty body rather than treating it as a special case', () => {
    const body = Buffer.alloc(0);
    expect(verifyWebhookSignature(body, sign(body), SECRET)).toBe('valid');
    expect(verifyWebhookSignature(body, sign(Buffer.from('x')), SECRET)).toBe('invalid');
  });
});
