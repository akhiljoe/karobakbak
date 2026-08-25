/**
 * The persona schema.
 *
 * ---------------------------------------------------------------------------
 * CHARACTER AND SURFACE ARE DIFFERENT THINGS (D-AI-3)
 * ---------------------------------------------------------------------------
 * A persona is two objects with different lifetimes, and keeping them apart is
 * the whole design rather than tidiness.
 *
 * A `PersonaCharacter` is **durable**. It is who somebody is: how they talk,
 * what they find funny, what they will argue about, the stories they tell. It
 * is written once, lives in source, and is the same in every conversation.
 *
 * A `PersonaSurface` is **generated per conversation**. It is the name, age,
 * gender and country the stranger on the other side sees. It is thrown away
 * when the conversation ends and a different one is generated for the next.
 *
 * Three reasons, and only the first was asked for:
 *
 *  1. A fixed name, age and city repeated across thousands of conversations is
 *     a fingerprint. Users compare notes, and one screenshot thread identifies
 *     the whole population at once.
 *  2. It reuses the mechanism that already exists. A declared profile rides on
 *     `join_queue`, lives on the session hash, and dies with the session (D34).
 *     A surface is literally a `Profile` — no new storage, no new code path,
 *     and nothing durable held against an identity.
 *  3. One character can hold many concurrent conversations without colliding
 *     with itself.
 *
 * The consistency requirement — a persona must not change its name or age
 * mid-conversation — therefore holds **within** a conversation, which is
 * exactly the scope session memory already has.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIELDS ARE SHAPED LIKE THIS
 * ---------------------------------------------------------------------------
 * The temptation is a bag of adjectives: "friendly, funny, kind". That produces
 * personas which are interchangeable, which is the one failure mode the source
 * brief names explicitly and which `differentiation.ts` mechanically forbids.
 *
 * So the fields that carry identity are the specific ones — `opinions`,
 * `anecdotes`, `avoidTopics`, `contradiction` — and the generic ones are
 * closed enums that describe *voice* rather than personality. An enum cannot
 * make two characters distinct; only the written content can, and the
 * differentiation check counts the written content.
 */

import type { CountryCode, Gender, Profile } from '../protocol/types';

/**
 * How readily a persona engages romantically (D-AI-5).
 *
 * This is a character trait and nothing more. It does not, and must not, gate
 * any of the six limits: those sit between the model and the socket and apply
 * identically to every persona regardless of this value. A `forward` persona
 * and a `none` persona are subject to precisely the same floor.
 *
 * The distinction it *does* make is the brief's point that not every persona
 * should flirt, and that a flirtatious one should still be capable of a long
 * conversation that never goes there.
 */
export const FLIRTATION_MODES = ['none', 'responsive', 'forward'] as const;
export type FlirtationMode = (typeof FLIRTATION_MODES)[number];

/** Typical reply length. Not a token limit — a habit. */
export const RESPONSE_LENGTHS = ['short', 'medium', 'varied'] as const;
export type ResponseLength = (typeof RESPONSE_LENGTHS)[number];

/** How often the persona puts a question back. High is an interviewer, and reads as a bot. */
export const QUESTION_RATES = ['low', 'medium', 'high'] as const;
export type QuestionRate = (typeof QUESTION_RATES)[number];

export const EMOJI_USE = ['none', 'rare', 'occasional', 'frequent'] as const;
export type EmojiUse = (typeof EMOJI_USE)[number];

export const CAPITALISATION = ['lowercase', 'sentence', 'mixed'] as const;
export type Capitalisation = (typeof CAPITALISATION)[number];

/**
 * How a persona types, as distinct from what it says.
 *
 * Two characters can share every trait in this object and still be completely
 * distinct people; the reverse is not true. That asymmetry is why none of these
 * fields counts toward differentiation.
 */
export interface TextingStyle {
  readonly responseLength: ResponseLength;
  readonly questionRate: QuestionRate;
  readonly emojiUse: EmojiUse;
  readonly capitalisation: Capitalisation;
  /** Free text, e.g. "trails off with ellipses", "never uses full stops". */
  readonly habits: readonly string[];
}

/**
 * Which surfaces a character may wear.
 *
 * A character is not a demographic, but it cannot be *any* demographic either:
 * a persona whose anecdotes are about university would be incoherent presented
 * as 54. The ranges are therefore a coherence constraint on generation, not an
 * identity.
 */
export interface SurfaceConstraints {
  /** Inclusive, both ends. Never below `MIN_DECLARED_AGE`; asserted at load. */
  readonly ageRange: readonly [number, number];
  /** Non-empty. A single entry means the character always presents that way. */
  readonly genders: readonly Gender[];
  /** Non-empty. Countries whose name pools and plausibility fit the character. */
  readonly countries: readonly CountryCode[];
}

/**
 * One persona, durably.
 *
 * Everything here is written by hand and read by the prompt builder. Nothing is
 * generated, and nothing is stored per user.
 */
export interface PersonaCharacter {
  /** Stable, kebab-case, unique. Used as a metric label — keep the set small. */
  readonly id: string;
  /** One line, for a human reading the console. Never sent to a model. */
  readonly summary: string;

  /**
   * Four to six specific traits.
   *
   * "Sarcastic" is acceptable; "nice" is not. The differentiation check counts
   * overlap here, so a character built from common adjectives will fail it.
   */
  readonly traits: readonly string[];
  /**
   * The internal tension, in one sentence.
   *
   * The brief requires every persona to contain a contradiction, and it is
   * right: people are not consistent, and a persona that is reads as a
   * questionnaire. Examples of the shape: confident socially but insecure about
   * dating; sarcastic but secretly sentimental.
   */
  readonly contradiction: string;
  readonly strengths: readonly string[];
  readonly flaws: readonly string[];
  readonly quirks: readonly string[];

  readonly interests: readonly string[];
  readonly dislikes: readonly string[];
  /** Subjects this persona steers toward without being asked. */
  readonly naturalTopics: readonly string[];
  /** Subjects it deflects. Not safety limits — preferences, like anyone's. */
  readonly avoidTopics: readonly string[];

  /**
   * Harmless positions the persona will actually defend.
   *
   * These exist so a conversation can contain disagreement. A persona that
   * agrees with everything is the single most recognisable tell there is, and
   * agreement is what a model does by default.
   */
  readonly opinions: readonly string[];
  /**
   * Small stories, told when relevant and never dumped.
   *
   * Ordinary and slightly unflattering works better than interesting. Nobody
   * believes a stranger whose every anecdote has a punchline.
   */
  readonly anecdotes: readonly string[];

  /*
   * There is deliberately no `starters` field.
   *
   * There was one — six written-in-voice openers per character — and it was a
   * mistake that survived because it looked like craft. A persona opened by
   * firing one of them at a stranger who had not spoken yet:
   *
   *   them:  hi
   *   it:    i just did something embarrassing and i need to tell someone
   *
   * Every one of them was specific, in voice, and unmistakably machine-written,
   * because people do not open a conversation with a prepared line. They say
   * hello and wait. Whatever the character would have led with is still here in
   * `opinions`, `anecdotes` and `naturalTopics`, and it now arrives where a
   * person would actually raise it — some way into a conversation that is
   * already running.
   */

  readonly style: TextingStyle;
  readonly flirtation: FlirtationMode;
  readonly surface: SurfaceConstraints;
}

/**
 * The identity one conversation sees.
 *
 * `profile` is the exact `Profile` shape the protocol already carries, so a
 * persona joins the queue through the ordinary declared-profile path with
 * nothing bolted on (D-AI-6).
 */
export interface PersonaSurface {
  readonly characterId: string;
  readonly profile: Profile;
}

/**
 * Structural validation of a hand-written character.
 *
 * Deliberately not a schema library. These are source files reviewed by a
 * human, and the failure this guards against is an omission — an empty
 * `opinions` array producing a persona that agrees with everything — rather
 * than malformed input from a stranger. Throwing at load is the right severity:
 * a broken character must not reach a user, and there is no partial mode worth
 * running in.
 */
export function assertValidCharacter(c: PersonaCharacter, minAge: number, maxAge: number): void {
  const fail = (why: string): never => {
    throw new Error(`persona ${c.id}: ${why}`);
  };

  if (!/^[a-z][a-z0-9-]{1,30}$/.test(c.id)) fail('id must be kebab-case, 2-31 chars');
  if (c.summary.trim().length === 0) fail('summary is empty');
  if (c.contradiction.trim().length === 0) fail('contradiction is empty');

  // Each minimum is the point below which the field stops doing its job.
  const minimums: ReadonlyArray<readonly [keyof PersonaCharacter, number]> = [
    ['traits', 4],
    ['strengths', 1],
    ['flaws', 1],
    ['quirks', 1],
    ['interests', 3],
    ['dislikes', 1],
    ['naturalTopics', 2],
    ['opinions', 3],
    ['anecdotes', 3],
  ];
  for (const [field, min] of minimums) {
    const value = c[field];
    if (!Array.isArray(value) || value.length < min) {
      fail(`${String(field)} needs at least ${min} entries, has ${Array.isArray(value) ? value.length : 0}`);
    }
    for (const entry of value as readonly unknown[]) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        fail(`${String(field)} contains an empty entry`);
      }
    }
  }

  const [lo, hi] = c.surface.ageRange;
  if (!Number.isInteger(lo) || !Number.isInteger(hi)) fail('ageRange must be integers');
  if (lo > hi) fail(`ageRange is inverted (${lo}..${hi})`);
  if (lo < minAge) fail(`ageRange starts below the declared-age floor (${lo} < ${minAge})`);
  if (hi > maxAge) fail(`ageRange ends above the declared-age ceiling (${hi} > ${maxAge})`);
  if (c.surface.genders.length === 0) fail('surface.genders is empty');
  if (c.surface.countries.length === 0) fail('surface.countries is empty');
}
