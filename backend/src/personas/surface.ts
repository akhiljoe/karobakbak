/**
 * Generating the identity one conversation sees (D-AI-3).
 *
 * A surface is a `Profile` — the same shape a real user declares — so a persona
 * joins the queue through the ordinary path with nothing bolted on. It is
 * generated fresh for every conversation and never stored against anything.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS DEFENDING AGAINST
 * ---------------------------------------------------------------------------
 * A persona with a fixed name, age and city is identifiable across
 * conversations. Not by the server — by the users. Somebody posts "anyone else
 * keep getting Maya, 23, Bangalore?" and the entire population is exposed in one
 * thread, along with the fact that it was a population.
 *
 * Regenerating the surface breaks that. Two people comparing notes have a
 * character in common, which is far harder to articulate than a name, and far
 * easier to mistake for coincidence.
 *
 * The invariant it must not break is the opposite one: within a single
 * conversation the surface must never change. A persona that renames itself
 * mid-sentence is not a subtle tell. So a surface is generated once, at join,
 * and held for the life of the session — the same lifetime the declared profile
 * already has (D34).
 */

import { INTENTS, MAX_DECLARED_AGE, MIN_DECLARED_AGE } from '../protocol/types';
import type { CountryCode, Gender, Profile } from '../protocol/types';
import { poolFor } from './names';
import { Rng, randomSeed } from './rng';
import type { PersonaCharacter, PersonaSurface } from './types';

/**
 * How often a surface declares no name at all.
 *
 * Real users skip the field constantly — it is optional, the product works
 * without it, and a stranger about to talk to a stranger is not always in the
 * mood to be introduced. A population where every single member filled in the
 * name box would be a tell on its own, and a cheap one to avoid.
 *
 * The same reasoning applies, more weakly, to the other fields: see
 * `DECLINE_CHANCE`.
 */
const DEFAULT_NO_NAME_CHANCE = 0.12;

/**
 * How often each of age, gender and country is left undeclared.
 *
 * Lower than the name, because somebody who bothered to open the profile editor
 * usually completes it, and because these three are single taps rather than
 * typing. It is not zero for the same reason the name is not: uniformity is
 * what gets noticed.
 *
 * Country is drawn separately below and never declined, because the name pool
 * depends on it — a surface with a name and no country is fine, but the
 * generator still has to know where the name came from.
 */
const DEFAULT_DECLINE_CHANCE = 0.08;

export interface SurfaceOptions {
  /** Fixed seed, for tests. Production passes nothing and gets a random one. */
  readonly seed?: number;
  /**
   * How often a surface declines to give a name, and how often it declines a
   * field outright. Production passes `config.personas`; the defaults here are
   * what `config.ts` defaults to, and exist so a test can call this with a seed
   * and nothing else.
   */
  readonly noNameChance?: number;
  readonly declineChance?: number;
}

/**
 * One surface for one conversation.
 *
 * Deterministic given a seed: the same seed and the same character always
 * produce the same surface, which is what makes the distribution assertions in
 * the tests meaningful rather than flaky.
 */
/**
 * The intents a persona may declare — every value except `flirty`.
 *
 * Derived by exclusion rather than written out, so a sixth intent added later
 * is available to personas automatically and only a deliberate addition to this
 * list can keep one from them.
 *
 * `flirty` is excluded on a different ground from the one §29.9 raised about
 * users, and symmetry does not answer it. The objection there was targeting,
 * which intent removes. The objection here is **authorship**: everything a
 * persona says is the operator's own speech (D-AI-11), already outside the s.79
 * safe harbour, so declaring sexual intent on the operator's behalf to a
 * stranger of unverified age is the operator doing it, not a user.
 */
const SAFE_INTENTS = INTENTS.filter((intent) => intent !== 'flirty');

export function generateSurface(
  character: PersonaCharacter,
  options: SurfaceOptions = {},
): PersonaSurface {
  const rng = new Rng(options.seed ?? randomSeed());
  const noNameChance = options.noNameChance ?? DEFAULT_NO_NAME_CHANCE;
  const declineChance = options.declineChance ?? DEFAULT_DECLINE_CHANCE;

  // Country is chosen first and always, because the name pool depends on it.
  // Whether it is *declared* is decided afterwards.
  const country: CountryCode = rng.pick(character.surface.countries);
  const gender: Gender = rng.pick(character.surface.genders);

  const [lo, hi] = character.surface.ageRange;
  const age = rng.between(lo, hi);

  const pool = poolFor(country, gender);
  const name = rng.chance(noNameChance) ? null : rng.pick(pool);

  const profile: Profile = {
    name,
    age: rng.chance(declineChance) ? null : age,
    gender: rng.chance(declineChance) ? null : gender,
    country: rng.chance(declineChance) ? null : country,
  };

  // Declared for the fingerprint reason the rest of the surface exists for
  // (D-AI-3): a population where every real user has an intent and no persona
  // does is one you can sort by eye. Regenerated per conversation like every
  // other field, and — unlike them — never shown to the stranger (D45, §30.1),
  // so it only ever affects who the persona is put in front of.
  //
  // Never `flirty`, and that is a decision rather than an omission — see
  // `SAFE_INTENTS` above for why symmetry does not answer it here.
  const intent = rng.chance(declineChance) ? null : rng.pick([...SAFE_INTENTS]);

  // A generated age must satisfy the same rule a user's declaration does. The
  // character validator already enforces the range, so this is a second line
  // against a character edited without re-running the loader.
  if (profile.age !== null && (profile.age < MIN_DECLARED_AGE || profile.age > MAX_DECLARED_AGE)) {
    throw new Error(
      `persona ${character.id}: generated age ${profile.age} is outside the declarable range`,
    );
  }

  return { characterId: character.id, profile, intent };
}

/**
 * Every country any character can present as.
 *
 * Used at load to check the name pools cover the population, so a missing pool
 * is a startup failure rather than a rare runtime one.
 */
export function declaredCountries(characters: readonly PersonaCharacter[]): CountryCode[] {
  const seen = new Set<CountryCode>();
  for (const c of characters) {
    for (const country of c.surface.countries) seen.add(country);
  }
  return [...seen];
}
