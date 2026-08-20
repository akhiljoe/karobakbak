/**
 * Password verification for the moderation console.
 *
 * ---------------------------------------------------------------------------
 * WHY THE STANDARD LIBRARY AND NOT A DEPENDENCY
 * ---------------------------------------------------------------------------
 * The obvious choice is argon2 or bcrypt from npm. This uses `crypto.scrypt`,
 * which ships with Node, for two reasons that both matter more than the
 * marginal difference in memory-hardness between scrypt and argon2id.
 *
 * The backend has four runtime dependencies. Whatever hashes the console's
 * password sits directly on the authentication path, so adding a package there
 * widens the supply-chain surface at the single most sensitive point in the
 * system. And the usual argon2 binding is a native module, which means a
 * compiler in the Alpine image and a rebuild every time Node moves.
 *
 * scrypt is not a compromise choice: it is memory-hard, it is RFC 7914, and it
 * is the reason a GPU cluster cannot brute-force this cheaply. Nothing here
 * invents cryptography — the KDF is the platform's, and the only decisions are
 * parameters and encoding.
 *
 * ---------------------------------------------------------------------------
 * PARAMETERS
 * ---------------------------------------------------------------------------
 * N = 2^15, r = 8, p = 1 costs about 33 MB and ~100ms per verification on a
 * small VM. That is deliberately slow: this path runs once per login, by one
 * operator, so the cost is invisible to a human and expensive to an attacker
 * with a stolen database.
 *
 * Note the explicit `maxmem`. Node's default ceiling is 32 MB, which is just
 * under what these parameters need — the call fails with a memory error rather
 * than a wrong answer, but it fails, so the ceiling is raised here.
 */
import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * `promisify` resolves to the first of `scrypt`'s overloads, which has no
 * options parameter — so the promisified function is re-typed here rather than
 * every call site reaching for a cast.
 */
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

const SCHEME = 'scrypt';
const COST = 32_768;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 32;
const SALT_BYTES = 16;
/** 128 * N * r is the working set; leave headroom so a bump does not break it. */
const MAX_MEMORY = 128 * COST * BLOCK_SIZE * 2;

/**
 * The lowest length worth enforcing on an operator account.
 *
 * Deliberately long rather than "complex". A console account is held by one
 * person who can use a password manager; there is no user-experience argument
 * for accepting a short password here, and composition rules (a digit, a
 * symbol) measurably push people towards predictable substitutions instead.
 */
export const MIN_PASSWORD_LENGTH = 12;

export class WeakPasswordError extends Error {
  constructor() {
    // No interpolation of the password, obviously, and no echo of its length
    // either: an error string is the most likely thing to end up in a log.
    super(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    this.name = 'WeakPasswordError';
  }
}

/**
 * Hash a password into a self-describing string:
 *
 *   scrypt$32768$8$1$<salt base64>$<hash base64>
 *
 * The parameters travel with the hash so raising the cost later does not
 * invalidate existing rows — an old hash still verifies with the parameters it
 * was created under, and can be re-hashed on the next successful login.
 */
export async function hashPassword(password: string): Promise<string> {
  if ([...password].length < MIN_PASSWORD_LENGTH) throw new WeakPasswordError();
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, KEY_BYTES, {
    N: COST,
    r: BLOCK_SIZE,
    p: PARALLELISM,
    maxmem: MAX_MEMORY,
  });
  return [
    SCHEME,
    COST,
    BLOCK_SIZE,
    PARALLELISM,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verify a password against a stored hash.
 *
 * Returns false for a malformed stored value rather than throwing. A row that
 * cannot be parsed is a row nobody can log in with, which is the safe outcome;
 * throwing would turn a corrupt record into a 500 that distinguishes it from a
 * wrong password.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6) return false;
  const [scheme, costRaw, blockRaw, parallelRaw, saltRaw, hashRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (scheme !== SCHEME) return false;

  const cost = Number(costRaw);
  const blockSize = Number(blockRaw);
  const parallelism = Number(parallelRaw);
  if (!isPositiveInteger(cost) || !isPositiveInteger(blockSize) || !isPositiveInteger(parallelism)) {
    return false;
  }
  // A stored row is not attacker-controlled today, but it is the input that
  // decides how much memory this process is about to allocate. Refuse a cost
  // this build would not itself have written rather than honouring it.
  if (cost > COST || blockSize > BLOCK_SIZE * 4 || parallelism > 16) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltRaw, 'base64');
    expected = Buffer.from(hashRaw, 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, expected.length, {
    N: cost,
    r: blockSize,
    p: parallelism,
    maxmem: MAX_MEMORY,
  });

  // Lengths are equal by construction — `expected.length` was the key length —
  // but timingSafeEqual throws on a mismatch, so the guard stays.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
