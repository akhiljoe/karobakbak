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

import { MAX_DECLARED_AGE, MIN_DECLARED_AGE } from '../protocol/types';
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
const NO_NAME_CHANCE = 0.12;

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
const DECLINE_CHANCE = 0.08;

export interface SurfaceOptions {
  /** Fixed seed, for tests. Production passes nothing and gets a random one. */
  readonly seed?: number;
}

/**
 * One surface for one conversation.
 *
 * Deterministic given a seed: the same seed and the same character always
 * produce the same surface, which is what makes the distribution assertions in
 * the tests meaningful rather than flaky.
 */
export function generateSurface(
  character: PersonaCharacter,
  options: SurfaceOptions = {},
): PersonaSurface {
  const rng = new Rng(options.seed ?? randomSeed());

  // Country is chosen first and always, because the name pool depends on it.
  // Whether it is *declared* is decided afterwards.
  const country: CountryCode = rng.pick(character.surface.countries);
  const gender: Gender = rng.pick(character.surface.genders);

  const [lo, hi] = character.surface.ageRange;
  const age = rng.between(lo, hi);

  const pool = poolFor(country, gender);
  const name = rng.chance(NO_NAME_CHANCE) ? null : rng.pick(pool);

  const profile: Profile = {
    name,
    age: rng.chance(DECLINE_CHANCE) ? null : age,
    gender: rng.chance(DECLINE_CHANCE) ? null : gender,
    country: rng.chance(DECLINE_CHANCE) ? null : country,
  };

  // A generated age must satisfy the same rule a user's declaration does. The
  // character validator already enforces the range, so this is a second line
  // against a character edited without re-running the loader.
  if (profile.age !== null && (profile.age < MIN_DECLARED_AGE || profile.age > MAX_DECLARED_AGE)) {
    throw new Error(
      `persona ${character.id}: generated age ${profile.age} is outside the declarable range`,
    );
  }

  return { characterId: character.id, profile };
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
