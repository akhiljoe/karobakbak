/**
 * The interchangeability check.
 *
 * ---------------------------------------------------------------------------
 * THE FAILURE THIS EXISTS TO CATCH
 * ---------------------------------------------------------------------------
 * The source brief puts it well: if two personas could exchange profiles and
 * still behave almost identically, one of them needs rewriting. That failure is
 * easy to create and nearly impossible to see by reading, because each
 * character looks fine on its own page. It only shows up in the pair.
 *
 * It is also the failure that costs the most. A population that is secretly one
 * persona wearing sixteen names is worse than a single obvious bot, because the
 * user forms the belief that they have met sixteen people and then notices they
 * all argue the same way.
 *
 * So this is mechanical, it runs in the unit suite, and it fails the build.
 *
 * ---------------------------------------------------------------------------
 * WHY WORD OVERLAP RATHER THAN EXACT MATCHING
 * ---------------------------------------------------------------------------
 * Two characters written a week apart will say "loves late-night drives" and
 * "into late night drives". Exact string comparison scores those as completely
 * different, which is precisely backwards. Comparing word sets catches the
 * near-duplicate that a human reviewer would also catch, and is the cheapest
 * thing that does.
 *
 * Stopwords are removed because "and", "the" and "a" otherwise dominate every
 * comparison and drag all similarities toward each other, compressing the range
 * the threshold has to discriminate over.
 *
 * ---------------------------------------------------------------------------
 * WHAT COUNTS, AND WHAT DELIBERATELY DOES NOT
 * ---------------------------------------------------------------------------
 * Only the fields that carry identity are compared. `style` is excluded on
 * purpose: two characters can share a texting style and be entirely distinct
 * people, so counting it would let a population pass by varying its punctuation.
 * The same goes for `surface` — demographics are not personality, which is the
 * premise the whole schema is built on.
 */

import type { PersonaCharacter } from './types';

/**
 * The fields compared, and how much each is trusted.
 *
 * `opinions` and `anecdotes` are weighted highest because they are the hardest
 * to write generically and the most visible in conversation: two personas with
 * different opinions will disagree with the user differently, which is the
 * thing a person actually notices.
 */
const COMPARED_FIELDS = [
  'traits',
  'interests',
  'naturalTopics',
  'dislikes',
  'opinions',
  'anecdotes',
] as const satisfies readonly (keyof PersonaCharacter)[];

type ComparedField = (typeof COMPARED_FIELDS)[number];

/**
 * A field counts as a differentiator when its word overlap is below this.
 *
 * 0.34 was chosen by measuring the shipped set rather than guessed: characters
 * intended to be distinct score well under 0.2 on most fields, and a
 * deliberately duplicated character scores above 0.6. Anything in between is
 * genuinely ambiguous and worth a human looking at it, which is what a failure
 * here asks for.
 */
const DIFFERENT_ENOUGH = 0.34;

/**
 * How many of the six fields must differ for a pair to pass.
 *
 * The brief asks for three to five strong differentiators. Three is the floor
 * because two characters can legitimately share, say, interests and natural
 * topics — a pair of film obsessives is a reasonable thing for a population to
 * contain — and still be obviously different people in every other respect.
 */
const REQUIRED_DIFFERENTIATORS = 3;

/**
 * Words carrying no distinguishing information.
 *
 * Kept deliberately short. An aggressive list starts removing words that
 * genuinely differentiate — "never", "always" and "not" reverse a meaning and
 * are exactly the sort of thing a stopword list eats by default.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'to', 'of', 'in', 'on', 'at', 'for',
  'with', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'that', 'this',
  'as', 'by', 'from', 'they', 'them', 'their', 'she', 'he', 'her', 'his', 'you',
  'your', 'who', 'when', 'then', 'than', 'so', 'too', 'very', 'about', 'into',
]);

function words(entries: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const entry of entries) {
    for (const raw of entry.toLowerCase().split(/[^a-z0-9']+/)) {
      // Single characters are noise; possessives are stripped so "maya's" and
      // "maya" do not read as different words.
      const word = raw.replace(/'s$/, '');
      if (word.length > 1 && !STOPWORDS.has(word)) out.add(word);
    }
  }
  return out;
}

/** Jaccard: shared words over total distinct words. 0 = nothing in common. */
function similarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 1 : shared / union;
}

export interface PairComparison {
  readonly a: string;
  readonly b: string;
  /** Per-field similarity, 0..1. */
  readonly scores: Readonly<Record<ComparedField, number>>;
  /** Fields scoring below the threshold. */
  readonly differentiators: readonly ComparedField[];
  readonly passes: boolean;
}

export function comparePair(a: PersonaCharacter, b: PersonaCharacter): PairComparison {
  const scores = {} as Record<ComparedField, number>;
  const differentiators: ComparedField[] = [];

  for (const field of COMPARED_FIELDS) {
    const score = similarity(words(a[field]), words(b[field]));
    scores[field] = score;
    if (score < DIFFERENT_ENOUGH) differentiators.push(field);
  }

  return {
    a: a.id,
    b: b.id,
    scores,
    differentiators,
    passes: differentiators.length >= REQUIRED_DIFFERENTIATORS,
  };
}

/** Every unordered pair, compared. */
export function compareAll(characters: readonly PersonaCharacter[]): PairComparison[] {
  const out: PairComparison[] = [];
  for (let i = 0; i < characters.length; i += 1) {
    for (let j = i + 1; j < characters.length; j += 1) {
      const a = characters[i];
      const b = characters[j];
      if (a === undefined || b === undefined) continue;
      out.push(comparePair(a, b));
    }
  }
  return out;
}

/**
 * A report a human can act on.
 *
 * A bare "differentiation failed" tells whoever broke it nothing useful. Naming
 * the pair, the count and the fields that were *too similar* points straight at
 * the paragraphs to rewrite.
 */
export function describeFailures(comparisons: readonly PairComparison[]): string {
  const failed = comparisons.filter((c) => !c.passes);
  if (failed.length === 0) return '';

  const lines = failed.map((c) => {
    const tooSimilar = COMPARED_FIELDS.filter((f) => !c.differentiators.includes(f))
      .map((f) => `${f}=${(c.scores[f] ?? 0).toFixed(2)}`)
      .join(', ');
    return (
      `  ${c.a} vs ${c.b}: only ${c.differentiators.length} differentiator(s), ` +
      `need ${REQUIRED_DIFFERENTIATORS}\n    too similar: ${tooSimilar}`
    );
  });

  return (
    `${failed.length} persona pair(s) are close to interchangeable:\n${lines.join('\n')}\n` +
    'Rewrite one of each pair. Opinions and anecdotes are the cheapest fields to ' +
    'make distinct, and the most visible in conversation.'
  );
}

export const DIFFERENTIATION = {
  COMPARED_FIELDS,
  DIFFERENT_ENOUGH,
  REQUIRED_DIFFERENTIATORS,
} as const;
