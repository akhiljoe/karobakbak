/**
 * Putting an identity under a ban before the run starts.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HARNESS ISSUES THE BAN ITSELF
 * ---------------------------------------------------------------------------
 * Nothing in this product bans automatically. The only issuing path is a
 * moderator in the console, behind a password and a TOTP code, and driving that
 * from a load test would be testing the console's login rather than the thing
 * under test — which is whether the *upgrade path* honours enforcement when
 * several hundred sockets are opening at once.
 *
 * So the effect is applied directly, the same way `applyBan` does: a Redis key
 * named for the subject hash, holding an enforcement id. The upgrade path reads
 * exactly that key and nothing else, so this reproduces a real ban from the
 * point of view of the code being exercised. The database row a real ban also
 * writes is deliberately skipped — it is the record, not the effect, and
 * `admin-enforce.test.ts` already covers the two agreeing.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HASH IS COMPUTED HERE
 * ---------------------------------------------------------------------------
 * The server keys bans on a salted hash of the address, never the address. To
 * ban a bot the harness has to produce the same hash the server would, which
 * means knowing the salt — `IP_HASH_SALT` from `.env.loadtest`, which is a
 * throwaway value for a throwaway stack.
 *
 * That coupling is worth naming: if `hashIp` ever changes shape, this stops
 * banning anything and the scenario passes for the wrong reason. The oracle
 * guards against exactly that by requiring the refusals it expects, rather than
 * only checking that nobody else was refused.
 *
 * ---------------------------------------------------------------------------
 * REDIS-CLI, NOT A CLIENT LIBRARY
 * ---------------------------------------------------------------------------
 * Same as the Redis oracle: `docker exec` into the container that is already
 * there, so this needs no dependency and no published port.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Matches `hashIp` in `backend/src/util/ids.ts`. Both must agree exactly. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(salt).update('|').update(ip).digest('hex').slice(0, 32);
}

/**
 * The salt the running stack is actually using.
 *
 * Read out of the backend container rather than out of this process's
 * environment, because the two drifting is the failure mode that makes this
 * scenario pass while testing nothing: a harness hashing with the wrong salt
 * bans nobody, everybody connects, and a run that checked only for unexpected
 * refusals would look clean.
 *
 * Asking the server what it is using removes that class of mistake entirely.
 * `process.env` is honoured first so a run can still override it deliberately.
 */
export async function readSalt(backendContainer: string): Promise<string> {
  const fromEnv = process.env.IP_HASH_SALT ?? '';
  if (fromEnv !== '') return fromEnv;
  if (backendContainer === '') return '';
  try {
    const { stdout } = await run('docker', [
      'exec', backendContainer, 'printenv', 'IP_HASH_SALT',
    ]);
    return stdout.trim();
  } catch {
    // `printenv` exits non-zero when the variable is unset, which is a real
    // answer: the stack is running on the configuration default.
    return '';
  }
}

export interface BanRequest {
  /** Container running Redis. Empty means enforcement cannot be applied. */
  readonly container: string;
  readonly keyPrefix: string;
  readonly salt: string;
  /** Synthetic addresses to ban, one per bot. */
  readonly addresses: readonly string[];
  readonly ttlSeconds: number;
}

export interface BanResult {
  readonly applied: number;
  /** Why nothing was applied, when nothing was. */
  readonly skipped: string | null;
}

/**
 * Ban every address given, and confirm each key landed.
 *
 * Confirmation matters more than it looks. A ban that silently failed to apply
 * would make this scenario pass — the banned bots would connect, and an oracle
 * looking only for "no unexpected refusals" would see a clean run. So each
 * write is read back, and a mismatch is reported to the caller rather than
 * left for the oracle to interpret as a server bug.
 */
export async function applyBans(request: BanRequest): Promise<BanResult> {
  if (request.container === '') {
    return { applied: 0, skipped: 'no redis container configured' };
  }
  if (request.salt === '') {
    return { applied: 0, skipped: 'IP_HASH_SALT is not set for this run' };
  }
  if (request.addresses.length === 0) {
    return { applied: 0, skipped: null };
  }

  let applied = 0;
  for (const [index, address] of request.addresses.entries()) {
    const key = `${request.keyPrefix}:ban:${hashIp(address, request.salt)}`;
    // The value is the enforcement id a real ban would carry. Shaped like one
    // so a log line about a refusal reads the same as it would in production.
    const enforcementId = `enf_swarm${String(index).padStart(4, '0')}_ip`;
    await run('docker', [
      'exec', request.container,
      'redis-cli', 'SET', key, enforcementId, 'EX', String(request.ttlSeconds),
    ]);

    const { stdout } = await run('docker', ['exec', request.container, 'redis-cli', 'GET', key]);
    if (stdout.trim() === enforcementId) applied += 1;
  }

  return {
    applied,
    skipped: applied === request.addresses.length ? null : 'some ban keys did not land',
  };
}

/** Remove them again, so a stopped run does not poison the next one. */
export async function clearBans(request: BanRequest): Promise<void> {
  if (request.container === '' || request.salt === '') return;
  for (const address of request.addresses) {
    const key = `${request.keyPrefix}:ban:${hashIp(address, request.salt)}`;
    await run('docker', [
      'exec', request.container, 'redis-cli', 'DEL', key,
    ]).catch(() => undefined);
  }
}
