/**
 * Oracle 3 — Redis residue.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS EVEN THOUGH THE METRICS ORACLE LOOKS AT THE SAME NUMBERS
 * ---------------------------------------------------------------------------
 * `chat_queue_depth` and `chat_active_matches` are cluster-wide values written
 * only by whichever backend holds the janitor's leader lock. The follower's
 * copy is frozen at whatever it last held, possibly for the whole run — so
 * summing them invents leaks, and taking the maximum reports the *stale* value
 * whenever the follower's frozen number is the larger one. Neither aggregation
 * can tell "one entry is stuck in the queue" from "one instance last looked a
 * while ago".
 *
 * Redis can. It is the authority the gauges are derived from, so asking it
 * directly turns an ambiguous signal into a fact.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS AS A LEAK, WHICH IS NARROWER THAN IT LOOKS
 * ---------------------------------------------------------------------------
 * Queue entries are repaired lazily — `tryMatch` cleans whatever it walks over,
 * and the janitor sweeps the rest on a 15-second interval. So a queue member is
 * not evidence of anything on its own. What *is* evidence is a queue member
 * whose session hash no longer exists: the session is gone, the entry cannot
 * ever be matched, and nothing will look at it again unless somebody happens to
 * scan past it. That is an abandoned entry, and after a settle window covering
 * two janitor passes it is a leak.
 *
 * Match and session keys carry TTLs of their own, so they are counted and
 * reported rather than judged: their expiry is Redis's job and the run is
 * usually shorter than the TTL.
 *
 * `redis-cli` runs inside the container, the same way the metrics oracle
 * scrapes, so this needs no client library and no published port.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstLine, LF } from './firstline';
import type { OracleResult } from './types';

const run = promisify(execFile);

export interface RedisOracleInput {
  /** Container running Redis. Empty means the oracle cannot run. */
  readonly container: string;
  readonly keyPrefix: string;
  readonly segment: string;
}

async function cli(container: string, args: readonly string[]): Promise<string> {
  const result = await run('docker', ['exec', container, 'redis-cli', ...args], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout.trim();
}

/**
 * Count keys matching a pattern, and for the queue, find members whose session
 * is gone — all in one server-side script.
 *
 * Order is load-bearing: the reply is read positionally by the destructuring
 * below, so a new count goes on the **end** and gets a name there too.
 *
 * `KEYS` is O(N) and would be wrong on a production instance. It is right here:
 * this is a disposable load-test stack, the alternative is thousands of round
 * trips, and the repository already uses exactly this pattern in
 * `npm run unblock`.
 */
const RESIDUE_SCRIPT = [
  "local prefix = ARGV[1]",
  "local segment = ARGV[2]",
  "local queueKey = prefix .. ':queue:' .. segment",
  "local members = redis.call('SMEMBERS', queueKey)",
  "local orphans = 0",
  "for i = 1, #members do",
  "  if redis.call('EXISTS', prefix .. ':session:' .. members[i]) == 0 then",
  "    orphans = orphans + 1",
  "  end",
  "end",
  "local matches = #redis.call('KEYS', prefix .. ':match:*')",
  "local sessions = #redis.call('KEYS', prefix .. ':session:*')",
  "local userMatches = #redis.call('KEYS', prefix .. ':user_match:*')",
  "local blocks = #redis.call('KEYS', prefix .. ':blocks:*')",
  "local resumes = #redis.call('KEYS', prefix .. ':resume:*')",
  "local lastPartners = #redis.call('KEYS', prefix .. ':last_partner:*')",
  "return { #members, orphans, matches, sessions, userMatches, blocks, resumes, lastPartners }",
].join(LF);

export async function checkRedisResidue(input: RedisOracleInput): Promise<OracleResult> {
  if (input.container.length === 0) {
    return {
      name: 'redis residue',
      status: 'skipped',
      summary: 'no Redis container given; pass --redis to enable',
      needsConfiguration: true,
      details: ['example: --redis karobakbak-loadtest-redis-1'],
    };
  }

  let raw: string;
  try {
    raw = await cli(input.container, ['EVAL', RESIDUE_SCRIPT, '0', input.keyPrefix, input.segment]);
  } catch (error) {
    return {
      name: 'redis residue',
      status: 'skipped',
      summary: `could not query Redis: ${firstLine(error)}`,
      details: [],
    };
  }

  const numbers = raw
    .split(LF)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value));

  const [
    queued = 0,
    orphans = 0,
    matches = 0,
    sessions = 0,
    userMatches = 0,
    blocks = 0,
    resumes = 0,
    lastPartners = 0,
  ] = numbers;

  const details = [
    `queue members: ${queued}, of which ${orphans} have no session`,
    `match keys: ${matches}`,
    `session keys: ${sessions}`,
    `user_match keys: ${userMatches}`,
    `block sets: ${blocks} (these are meant to outlive the run — BLOCK_TTL_SECONDS is 30 days)`,
    // Both are short-lived by construction and both are counted rather than
    // asserted on: they are *supposed* to be non-zero while their windows run.
    // What would be worth noticing is a count that does not fall between runs,
    // which is why the number is printed rather than hidden behind a pass.
    `resume tokens held: ${resumes} (RESUME_GRACE_SECONDS, one per live session)`,
    `late-block records: ${lastPartners} (BLOCK_LATE_WINDOW_SECONDS, spent when used)`,
  ];

  // Blocks surviving between runs is correct behaviour with a real cost here.
  // A bot's synthetic address is derived from its index, so bot 41 is the same
  // person in every run against this stack, and the blocks an adversarial run
  // records still apply to the next one. Left alone across many runs the
  // population slowly poisons itself: pairs stop being matchable for reasons
  // that belong to a run somebody else did yesterday.
  if (blocks > 0) {
    details.push(
      `blocks persist across runs and bot addresses are deterministic — clear them with \`npm run unblock\` before a run whose matching should start clean`,
    );
  }

  const failures: string[] = [];
  if (orphans > 0) {
    failures.push(
      `${orphans} queue member(s) point at a session that no longer exists, after a settle window covering two janitor passes`,
    );
  }
  // A session key without a live socket is not a leak while its TTL runs; a
  // user_match without a match is, because that is the mapping matchmaking
  // consults to decide whether somebody is already paired.
  if (userMatches > matches * 2) {
    failures.push(
      `${userMatches} user_match keys against ${matches} matches — each match should account for at most two`,
    );
  }

  return {
    name: 'redis residue',
    status: failures.length > 0 ? 'fail' : 'pass',
    summary:
      failures.length > 0
        ? failures.join('; ')
        : `no abandoned state: ${queued} queue member(s), ${matches} match key(s) still inside their TTL`,
    details: [...details, ...failures],
  };
}
