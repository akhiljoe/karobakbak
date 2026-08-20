import { createHash } from 'node:crypto';

import { SCRIPTS, ScriptArityError, ScriptRunner, type ScriptName } from '../../src/redis/scripts';

const names = Object.keys(SCRIPTS) as ScriptName[];

describe('script registry', () => {
  it('covers every transition the design names', () => {
    expect(names.sort()).toEqual(
      [
        'blockPartner',
        'closeSession',
        'connAcquire',
        'connRateLimit',
        'connRelease',
        'createSession',
        'endMatch',
        'heartbeat',
        'instanceBeacon',
        'janitorInstances',
        'janitorMatches',
        'janitorQueue',
        'janitorSessions',
        'joinQueue',
        'leaveQueue',
        'rateLimit',
        'resolvePartner',
        'resolveRoute',
        'resumeSession',
        'tryMatch',
      ].sort(),
    );
  });

  it('computes each SHA from the exact source it would EVAL', () => {
    // The fallback path depends on this: if the cached SHA is not the SHA of
    // the source we would send, EVALSHA hits a script nobody can reload.
    for (const script of Object.values(SCRIPTS)) {
      expect(script.sha).toBe(createHash('sha1').update(script.source).digest('hex'));
      expect(script.sha).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('gives every script the shared prelude', () => {
    for (const script of Object.values(SCRIPTS)) {
      expect(script.source).toContain('local P = ARGV[1]');
      expect(script.source).toContain('local function nowMs()');
    }
  });

  it('reads the clock from Redis, never from an argument', () => {
    // Fairness compares enqueuedAt values written by different instances, and
    // buckets are refilled from a timestamp another instance wrote. Sourcing
    // either from a caller's wall clock makes both depend on NTP skew.
    expect(SCRIPTS.tryMatch.source).toContain("redis.call('TIME')");
    for (const script of Object.values(SCRIPTS)) {
      expect(script.source).not.toMatch(/tonumber\(ARGV\[\d+\]\)\s*--\s*now/);
    }
  });

  it('never publishes from inside a script', () => {
    // A script's effects are replicated; a PUBLISH inside one would be replayed
    // on a replica that has no subscribers, and the janitor's notifications
    // would silently depend on topology.
    for (const script of Object.values(SCRIPTS)) {
      expect(script.source).not.toContain("'PUBLISH'");
    }
  });
});

describe('arity assertions', () => {
  const runner = new ScriptRunner({} as never);

  it('rejects a call with the wrong number of KEYS before it reaches Redis', async () => {
    await expect(runner.run('tryMatch', ['a'], new Array(9).fill('x'))).rejects.toBeInstanceOf(
      ScriptArityError,
    );
  });

  it('rejects a call with the wrong number of ARGV', async () => {
    await expect(runner.run('endMatch', ['a'], ['prefix'])).rejects.toBeInstanceOf(
      ScriptArityError,
    );
  });

  it('names the script and both counts, so the fix is obvious', async () => {
    await expect(runner.run('joinQueue', [], [])).rejects.toThrow(
      /joinQueue: expected 4 KEYS, got 0/,
    );
  });

  it('declares an arity for every script', () => {
    for (const script of Object.values(SCRIPTS)) {
      expect(script.keys).toBeGreaterThanOrEqual(1);
      // ARGV[1] is always the prefix.
      expect(script.argv).toBeGreaterThanOrEqual(1);
    }
  });
});
