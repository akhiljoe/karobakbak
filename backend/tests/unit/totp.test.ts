/**
 * TOTP against the specifications' own published numbers.
 *
 * This file is the justification for implementing RFC 6238 here instead of
 * installing it. Every vector below is copied from the RFC, so a wrong byte in
 * the truncation, the counter arithmetic or the base32 decoder fails a test
 * rather than shipping as an authenticator that "mostly works".
 */
import {
  base32Decode,
  base32Encode,
  hotp,
  InvalidTotpSecretError,
  newTotpSecret,
  totpCounter,
  totpUri,
  TOTP_STEP_SECONDS,
  verifyTotp,
} from '../../src/admin/totp';

/** RFC 4226 and RFC 6238 both use the ASCII secret "12345678901234567890". */
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('RFC 4226 Appendix D — HOTP test vectors', () => {
  const vectors: Array<[number, string]> = [
    [0, '755224'],
    [1, '287082'],
    [2, '359152'],
    [3, '969429'],
    [4, '338314'],
    [5, '254676'],
    [6, '287922'],
    [7, '162583'],
    [8, '399871'],
    [9, '520489'],
  ];

  it.each(vectors)('counter %i produces %s', (counter, expected) => {
    expect(hotp(RFC_SECRET, counter)).toBe(expected);
  });
});

describe('RFC 6238 Appendix B — TOTP test vectors', () => {
  // The RFC prints 8-digit codes for the SHA-1 rows. The counter is the Unix
  // time divided by the 30-second step, which is what makes the large
  // timestamp meaningful: it is past 2^31 seconds and catches a 64-bit counter
  // written as two 32-bit halves.
  const vectors: Array<[number, string]> = [
    [59, '94287082'],
    [1_111_111_109, '07081804'],
    [1_111_111_111, '14050471'],
    [1_234_567_890, '89005924'],
    [2_000_000_000, '69279037'],
    [20_000_000_000, '65353130'],
  ];

  it.each(vectors)('unix time %i produces %s', (seconds, expected) => {
    const counter = Math.floor(seconds / TOTP_STEP_SECONDS);
    expect(hotp(RFC_SECRET, counter, 8)).toBe(expected);
  });

  it('derives the same counter from milliseconds', () => {
    expect(totpCounter(59_000)).toBe(1);
    expect(totpCounter(20_000_000_000_000)).toBe(666_666_666);
  });
});

describe('verification window', () => {
  const nowMs = 1_700_000_000_000;
  const counter = totpCounter(nowMs);

  it('accepts the current code and reports its counter', () => {
    const result = verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter), { nowMs });
    expect(result).toEqual({ counter });
  });

  it('accepts one step of drift either side', () => {
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter - 1), { nowMs })).toEqual({
      counter: counter - 1,
    });
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 1), { nowMs })).toEqual({
      counter: counter + 1,
    });
  });

  it('refuses two steps of drift', () => {
    // The window is what an attacker guessing codes benefits from widening.
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter - 2), { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 2), { nowMs })).toBeNull();
  });

  it('refuses a counter at or below the last one used', () => {
    // The replay defence: the caller stores the matched counter and passes it
    // back. Without this, one observed code works for a whole minute.
    const code = hotp(RFC_SECRET, counter);
    expect(verifyTotp(RFC_SECRET, code, { nowMs })).toEqual({ counter });
    expect(verifyTotp(RFC_SECRET, code, { nowMs, minCounter: counter })).toBeNull();
    // A later code still works, so the account is not locked out by its own
    // replay defence.
    expect(
      verifyTotp(RFC_SECRET, hotp(RFC_SECRET, counter + 1), { nowMs, minCounter: counter }),
    ).toEqual({ counter: counter + 1 });
  });

  it('refuses anything that is not six digits', () => {
    expect(verifyTotp(RFC_SECRET, '12345', { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '1234567', { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', { nowMs })).toBeNull();
    expect(verifyTotp(RFC_SECRET, '', { nowMs })).toBeNull();
    // A code with a plus sign parses as a number but is not six digits.
    expect(verifyTotp(RFC_SECRET, '+12345', { nowMs })).toBeNull();
  });

  it('tolerates surrounding whitespace, because people paste', () => {
    expect(verifyTotp(RFC_SECRET, ` ${hotp(RFC_SECRET, counter)} `, { nowMs })).toEqual({
      counter,
    });
  });
});

describe('base32', () => {
  it('round-trips arbitrary bytes', () => {
    for (const length of [1, 2, 3, 4, 5, 10, 20, 32]) {
      const input = Buffer.from(Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff));
      expect(base32Decode(base32Encode(input))).toEqual(input);
    }
  });

  it('matches RFC 4648 test vectors', () => {
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
    expect(base32Encode(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32Encode(Buffer.from('foo'))).toBe('MZXW6');
    expect(base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ');
    expect(base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('accepts the shapes a human retypes', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
    expect(base32Decode(secret.toLowerCase())).toEqual(base32Decode(secret));
    expect(base32Decode(`${secret}======`)).toEqual(base32Decode(secret));
    expect(base32Decode(secret.replace(/(.{4})/g, '$1 '))).toEqual(base32Decode(secret));
  });

  it('refuses an out-of-alphabet character instead of skipping it', () => {
    // Skipping would decode a mistyped secret into a different valid key, and
    // the symptom would be "my codes never work" with nothing to point at.
    expect(() => base32Decode('MZXW6YTB1')).toThrow(InvalidTotpSecretError);
    expect(() => base32Decode('MZXW6YT!')).toThrow(InvalidTotpSecretError);
    expect(() => base32Decode('')).toThrow(InvalidTotpSecretError);
  });

  it('never puts the secret in the error message', () => {
    try {
      base32Decode('SECRET!VALUE');
      throw new Error('expected a rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTotpSecretError);
      expect((err as Error).message).not.toContain('SECRET');
    }
  });
});

describe('enrolment', () => {
  it('generates a 160-bit secret', () => {
    const secret = newTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    expect(newTotpSecret()).not.toBe(secret);
  });

  it('builds a URI an authenticator app can scan', () => {
    const uri = totpUri('MZXW6YTBOI', 'moderator');
    expect(uri.startsWith('otpauth://totp/karobakbak%3Amoderator?')).toBe(true);
    const params = new URLSearchParams(uri.slice(uri.indexOf('?') + 1));
    expect(params.get('secret')).toBe('MZXW6YTBOI');
    // Both spellings of the issuer: apps disagree about which one they read.
    expect(params.get('issuer')).toBe('karobakbak');
    expect(params.get('algorithm')).toBe('SHA1');
    expect(params.get('digits')).toBe('6');
    expect(params.get('period')).toBe('30');
  });
});
