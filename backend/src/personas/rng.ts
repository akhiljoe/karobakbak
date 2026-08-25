/**
 * A small seeded generator, for surfaces.
 *
 * ---------------------------------------------------------------------------
 * WHY NOT `crypto.randomBytes`
 * ---------------------------------------------------------------------------
 * `util/ids.ts` exists and is the right answer everywhere an identifier becomes
 * a Redis key or a token, because those must be unguessable. A surface is
 * neither: it is a display name and an age shown to one stranger for the length
 * of one conversation, and it authorises nothing.
 *
 * What a surface *does* need is to be reproducible in a test. "Generate a
 * thousand surfaces and assert none repeats a name and an age together" is only
 * a meaningful assertion if the run can be repeated, and a differentiation
 * check that fails once every few hundred CI runs is worse than no check —
 * it teaches people to re-run the build.
 *
 * So this is deterministic given a seed, and the seed is random in production.
 * Nothing here should ever be used for anything a person could gain by
 * predicting.
 */

/**
 * xorshift128, chosen because it is ten lines and has no state to get wrong.
 *
 * The distribution is far better than a linear congruential generator's low
 * bits, which matters because `pick()` takes a modulus of it.
 */
export class Rng {
  private a: number;
  private b: number;
  private c: number;
  private d: number;

  constructor(seed: number) {
    // splitmix32, to spread a small integer seed across all four words. Seeding
    // the state directly from a counter gives visibly correlated first draws.
    let s = seed >>> 0;
    const next = (): number => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return (z ^ (z >>> 15)) >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    // A zero state is absorbing; splitmix makes it vanishingly unlikely, and
    // this makes it impossible.
    if ((this.a | this.b | this.c | this.d) === 0) this.a = 0x9e3779b9;
  }

  /** Uniform 32-bit unsigned. */
  next(): number {
    let t = this.b << 9;
    this.c ^= this.a;
    this.d ^= this.b;
    this.b ^= this.c;
    this.a ^= this.d;
    this.c ^= t;
    t = this.d;
    this.d = (t << 11) | (t >>> 21);
    return (Math.imul(this.b, 5) >>> 0) % 4294967296;
  }

  /** Uniform in `[0, bound)`. `bound` must be a positive integer. */
  below(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0) {
      throw new Error('Rng.below needs a positive integer bound');
    }
    return this.next() % bound;
  }

  /** Uniform integer in `[lo, hi]`, both ends inclusive. */
  between(lo: number, hi: number): number {
    if (lo > hi) throw new Error(`Rng.between called with an inverted range (${lo}..${hi})`);
    return lo + this.below(hi - lo + 1);
  }

  /**
   * One element of a non-empty list.
   *
   * Returns `T` rather than `T | undefined`: `noUncheckedIndexedAccess` is on,
   * and making every call site handle an impossible undefined would be noise.
   * The emptiness check is what makes that safe.
   */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty list');
    const chosen = items[this.below(items.length)];
    if (chosen === undefined) throw new Error('Rng.pick indexed out of range');
    return chosen;
  }

  /** True with probability `p`, clamped to `[0, 1]`. */
  chance(p: number): boolean {
    if (p <= 0) return false;
    if (p >= 1) return true;
    return this.next() / 4294967296 < p;
  }
}

/** A seed with no relationship to anything else in the process. */
export function randomSeed(): number {
  return (Math.random() * 0x100000000) >>> 0;
}
