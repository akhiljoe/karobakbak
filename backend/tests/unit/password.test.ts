/**
 * Password hashing for the console account.
 *
 * scrypt is deliberately slow, so these tests use the real parameters but stay
 * few: a suite that hashed fifty passwords would add ten seconds to every run
 * and prove nothing the first hash did not.
 */
import { scrypt } from 'node:crypto';

import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  verifyPassword,
  WeakPasswordError,
} from '../../src/admin/password';

const GOOD = 'correct horse battery staple';

describe('hashPassword', () => {
  it('produces a self-describing hash that verifies', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored.startsWith('scrypt$32768$8$1$')).toBe(true);
    expect(await verifyPassword(GOOD, stored)).toBe(true);
  });

  it('never stores the password itself', async () => {
    const stored = await hashPassword(GOOD);
    expect(stored).not.toContain(GOOD);
    expect(stored).not.toContain('correct');
  });

  it('salts, so the same password hashes differently every time', async () => {
    // Without this, identical passwords are visibly identical in the table and
    // one cracked hash cracks every account that shares it.
    const [a, b] = await Promise.all([hashPassword(GOOD), hashPassword(GOOD)]);
    expect(a).not.toBe(b);
    expect(await verifyPassword(GOOD, a)).toBe(true);
    expect(await verifyPassword(GOOD, b)).toBe(true);
  });

  it('refuses a password too short to be worth hashing', async () => {
    await expect(hashPassword('short')).rejects.toBeInstanceOf(WeakPasswordError);
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toBeInstanceOf(
      WeakPasswordError,
    );
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH))).resolves.toBeDefined();
  });

  it('does not put the password in the rejection', async () => {
    await expect(hashPassword('hunter2')).rejects.toThrow(/at least/);
    await expect(hashPassword('hunter2')).rejects.not.toThrow(/hunter2/);
  });
});

describe('verifyPassword', () => {
  let stored: string;

  beforeAll(async () => {
    stored = await hashPassword(GOOD);
  });

  it('refuses the wrong password', async () => {
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
    expect(await verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(await verifyPassword('', stored)).toBe(false);
  });

  it('normalises unicode, so an equivalent password still works', async () => {
    // The same characters typed on a different keyboard can arrive in a
    // different normal form. Without NFKC the account is locked out by a
    // difference the person cannot see.
    const composed = await hashPassword('passwordé-long-enough');
    expect(await verifyPassword('passwordé-long-enough', composed)).toBe(true);
  });

  it('returns false for a malformed stored value rather than throwing', async () => {
    // A corrupt row should be a row nobody can log in with. Throwing would turn
    // it into a 500 that is distinguishable from a wrong password.
    for (const bad of [
      '',
      'not-a-hash',
      'scrypt$32768$8$1$onlyfiveparts',
      'bcrypt$32768$8$1$c2FsdA==$aGFzaA==',
      'scrypt$abc$8$1$c2FsdA==$aGFzaA==',
      'scrypt$32768$8$1$$aGFzaA==',
      'scrypt$0$8$1$c2FsdA==$aGFzaA==',
    ]) {
      expect(await verifyPassword(GOOD, bad)).toBe(false);
    }
  });

  it('refuses a cost this build would not have written', async () => {
    // The stored parameters decide how much memory this process allocates.
    // Honouring an arbitrary cost turns a corrupted row into a memory
    // exhaustion, so anything above the shipped parameters is refused.
    expect(await verifyPassword(GOOD, 'scrypt$1048576$8$1$c2FsdA==$aGFzaA==')).toBe(false);
    expect(await verifyPassword(GOOD, 'scrypt$32768$1024$1$c2FsdA==$aGFzaA==')).toBe(false);
    expect(await verifyPassword(GOOD, 'scrypt$32768$8$99$c2FsdA==$aGFzaA==')).toBe(false);
  });

  it('still verifies a hash written with weaker parameters', async () => {
    // Parameters travel with the hash so the cost can be raised later without
    // locking out the account that was created before the change.
    const legacy = 'scrypt$16384$8$1$';
    const salt = Buffer.from('sixteenbytesalt!');
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(GOOD, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) =>
        err ? reject(err) : resolve(key),
      );
    });
    const row = `${legacy}${salt.toString('base64')}$${derived.toString('base64')}`;
    expect(await verifyPassword(GOOD, row)).toBe(true);
  });
});
