/**
 * Seeded pseudo-randomness.
 *
 * Every scheduling decision in the swarm — think time, which corpus line, how
 * many turns before a skip, which bot is a spammer — comes from here and from
 * nothing else. `Math.random()` is not used anywhere in this package.
 *
 * The reason is not purity. A load test that finds a race and cannot reproduce
 * it has found nothing: the fix cannot be verified, and the next run is a
 * different experiment. A run is identified by one integer seed, and every bot
 * derives its own stream from that seed plus its index, so bot 4172 behaves
 * identically whether the run had 5,000 bots or 500.
 */

/** A deterministic stream. Cheap, non-cryptographic, and that is the point. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max], inclusive. */
  int(min: number, max: number): number;
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  /** One element, or `undefined` for an empty array. */
  pick<T>(items: readonly T[]): T | undefined;
  /** One element of a non-empty array. Throws on empty, so a caller cannot silently degrade. */
  pickOne<T>(items: readonly T[]): T;
  /** A new independent stream, so adding a call site does not shift another one. */
  fork(label: string): Rng;
}

/**
 * mulberry32: 32 bits of state, good enough distribution for scheduling, and
 * short enough to be obviously correct.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, used to turn a label into a stream offset. */
export function hashLabel(label: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);

  const rng: Rng = {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    float: (min, max) => min + next() * (max - min),
    chance: (p) => next() < p,
    pick: (items) => (items.length === 0 ? undefined : items[Math.floor(next() * items.length)]),
    pickOne: (items) => {
      if (items.length === 0) throw new Error('pickOne on an empty array');
      const value = items[Math.floor(next() * items.length)];
      // `noUncheckedIndexedAccess` is on; the length check above makes this
      // unreachable, and an explicit throw beats a non-null assertion.
      if (value === undefined) throw new Error('pickOne produced undefined');
      return value;
    },
    fork: (label) => createRng((seed ^ hashLabel(label)) >>> 0),
  };

  return rng;
}

/** The stream for one bot. Stable for a given (run seed, bot index) pair. */
export function botRng(runSeed: number, botIndex: number): Rng {
  return createRng((Math.imul(runSeed ^ 0x9e3779b9, botIndex + 1) ^ (botIndex << 7)) >>> 0);
}
