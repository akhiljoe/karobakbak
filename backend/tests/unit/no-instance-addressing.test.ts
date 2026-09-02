/**
 * C4 — a network partition between backends, with Redis up.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SOURCE CHECK AND NOT A CHAOS RUN
 * ---------------------------------------------------------------------------
 * The catalogued scenario is "partition the backends from each other and see
 * what breaks". Running it would prove nothing, because **there is no channel
 * between them to partition**: every cross-instance notification goes through
 * Redis Pub/Sub on a per-session channel, and the channel name *is* the routing
 * key, so no instance ever holds another instance's address.
 *
 * That is a design property (§10.1, D14) rather than an observation, and the
 * useful test is therefore the one that keeps it true. A run would pass today
 * and would also pass on the day somebody added a direct call between
 * instances, right up until the partition it was written for.
 *
 * So: assert the absence. If this ever fails, C4 stops being a no-op and has to
 * be run for real.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, found);
    else if (extname(entry.name) === '.ts') found.push(full);
  }
  return found;
}

/**
 * The outbound HTTP this process is allowed to make, and to whom.
 *
 * Both are the identity provider: fetching its signing keys, and exchanging an
 * authorization code. Neither is another instance of this service, and both
 * live behind the one seam that is allowed to know a vendor exists.
 */
const ALLOWED_FETCH_FILES = new Set(['oidc.ts']);

describe('no backend ever addresses another backend', () => {
  it('makes no outbound HTTP request outside the identity provider seam', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC)) {
      const name = file.split(/[\\/]/).pop() as string;
      if (ALLOWED_FETCH_FILES.has(name)) continue;

      const source = readFileSync(file, 'utf8');
      // Comments describe the design at length and mention these words; the
      // check is for a call, so it looks for the call shape.
      for (const line of source.split('\n')) {
        const code = line.split('//')[0] ?? '';
        if (/\bfetch\s*\(/.test(code) || /\baxios\b/.test(code)) {
          offenders.push(`${name}: ${code.trim().slice(0, 80)}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  /**
   * The positive half: cross-instance delivery goes through a channel named
   * after the *session*, not after an instance.
   *
   * This is what makes a routing table impossible to have and therefore
   * impossible to have go stale — the property §10.1 is actually claiming.
   */
  it('routes cross-instance events by session channel rather than by instance', () => {
    const subscriber = readFileSync(join(SRC, 'ws', 'subscriber.ts'), 'utf8');
    expect(subscriber).toContain('sessionChannel');

    const keys = readFileSync(join(SRC, 'redis', 'keys.ts'), 'utf8');
    expect(keys).toContain('sessionChannel');

    // And no key builder is named after an instance, which is what a routing
    // table would need.
    expect(keys).not.toMatch(/instanceChannel|channelForInstance/);
  });
});
