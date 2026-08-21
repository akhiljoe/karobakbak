/**
 * What a bot says about itself (`DESIGN.md` §26, phase 14).
 *
 * ---------------------------------------------------------------------------
 * WHY THE HARNESS DECLARES PROFILES AT ALL
 * ---------------------------------------------------------------------------
 * `join_queue` carries an optional profile now, and the field is not inert: a
 * declared name goes through `checkTextCharacters` and then through the *whole*
 * moderation rule set, where any flag refuses the join outright (D35). It rides
 * on the session hash, it is read beside `tryMatch` on both sides of every
 * match, and it is written into the identity the partner is shown.
 *
 * A swarm that never declares one therefore leaves the widest new code path in
 * the product with no traffic: the validation, the extra Redis field, the
 * second read per match, and the refusal path.
 *
 * ---------------------------------------------------------------------------
 * EVERY VALUE HERE IS A CLAIM
 * ---------------------------------------------------------------------------
 * The same rule the product is built on applies to the harness: nothing here is
 * verified and nothing here is an attribute of anybody. `age` in particular is
 * a number a scripted stranger typed, exactly as it is in production, and it is
 * not age assurance in either place.
 *
 * ---------------------------------------------------------------------------
 * THE PART THAT IS DELIBERATELY SEEDED
 * ---------------------------------------------------------------------------
 * A bot's profile comes from its own seeded stream, so bot 4172 declares the
 * same thing in every run with the same seed — which is what makes "the console
 * showed the wrong country for this conversation" a reproducible statement
 * rather than an anecdote.
 */
import {
  COUNTRY_CODES,
  GENDERS,
  MAX_DECLARED_AGE,
  MIN_DECLARED_AGE,
  type Profile,
} from '../../../backend/src/protocol/types';
import { contentHash } from './ledger';
import type { Corpus } from './corpus';
import type { Rng } from './rng';

/**
 * A head of common countries plus the full list behind it.
 *
 * Uniform over 249 codes would put as many bots in Antarctica as in India, and
 * the country is one of the two fields a moderator reads first — a run whose
 * console screenshots are all Bouvet Island tells nobody anything. The tail is
 * still reachable, so no code is untested.
 */
const COMMON_COUNTRIES = [
  'IN', 'US', 'GB', 'BR', 'ID', 'PK', 'NG', 'BD', 'PH', 'MX',
  'DE', 'FR', 'TR', 'EG', 'VN', 'IR', 'TH', 'ES', 'IT', 'CA',
] as const;

/** Probability that a bot declares each field, drawn independently. */
const DECLARE = {
  /** Highest: the name is the field the UI asks for first and shows everywhere. */
  name: 0.62,
  country: 0.48,
  age: 0.41,
  gender: 0.44,
} as const;

/**
 * Build one bot's declared profile.
 *
 * Fields are drawn independently, so the population contains every combination
 * including the empty one — "told us nothing" is the single most common real
 * profile and it has to be the most common here too.
 */
export function declaredProfile(rng: Rng, corpus: Corpus): Profile {
  // Draws from the stream it is given rather than forking one. Forking here
  // looked tidier and was wrong: `fork(label)` is derived from the seed and the
  // label alone, so every call would return the *same* profile — which is fine
  // for a bot that declares once and silently deletes the scenario for a bot
  // that re-declares between conversations. The caller decides which stream
  // this comes out of.
  return {
    name: rng.chance(DECLARE.name) ? rng.pickOne(corpus.lines('names.txt')) : null,
    country: rng.chance(DECLARE.country) ? pickCountry(rng) : null,
    age: rng.chance(DECLARE.age) ? pickAge(rng) : null,
    gender: rng.chance(DECLARE.gender) ? rng.pickOne([...GENDERS]) : null,
  };
}

/** An empty declaration. The server normalises absent, null and all-declined to this. */
export const NOTHING_DECLARED: Profile = { name: null, country: null, age: null, gender: null };

function pickCountry(rng: Rng): string {
  if (rng.chance(0.75)) return rng.pickOne([...COMMON_COUNTRIES]);
  return rng.pickOne([...COUNTRY_CODES]);
}

/**
 * An age, skewed young the way this product's population is, and never outside
 * the accepted band — a bot that means to be refused asks for that explicitly
 * through `underageProfile`, so an ordinary bot cannot produce a refusal by
 * accident and spend the run out of the queue.
 */
function pickAge(rng: Rng): number {
  const skewed = MIN_DECLARED_AGE + Math.floor(Math.abs(rng.float(-1, 1)) * 22);
  return Math.min(MAX_DECLARED_AGE, Math.max(MIN_DECLARED_AGE, skewed));
}

/**
 * A declaration the server must refuse with `AGE_BELOW_MINIMUM`.
 *
 * **Once per bot lifetime, never per match.** The refusal happens inside
 * `parseClientFrame`, which means it is a *protocol strike* — the same trap N5
 * pays for with over-length messages — and `INVALID_MESSAGE_STRIKES` is 10. A
 * persona that probed this every conversation would be disconnected with 4003
 * after ten of them, and the run would record a server fault where the server
 * did exactly the right thing.
 */
export function underageProfile(rng: Rng, corpus: Corpus): Profile {
  return {
    name: rng.pickOne(corpus.lines('names.txt')),
    country: pickCountry(rng),
    age: rng.int(11, MIN_DECLARED_AGE - 1),
    gender: rng.pickOne([...GENDERS]),
  };
}

/**
 * A name the moderation rules must refuse (D35).
 *
 * Built rather than drawn from a corpus file: `contact.txt` lines are sentences
 * far past `MAX_DISPLAY_NAME_LENGTH`, and a name that failed on *length* would
 * look identical from the outside while testing nothing about moderation. Each
 * of these is under the limit, is valid text, and fires exactly one rule.
 *
 * Unlike the age probe this one is refused in `server.ts`, after the frame has
 * parsed, so it is **not** a protocol strike. The difference is worth knowing
 * before writing a persona around either.
 */
export const REFUSABLE_NAMES: readonly string[] = [
  '@dmme_now',
  'kik me here',
  'snap: joinme',
  'add my telegram',
  'kbb-chat.com',
];

/**
 * A stable identity for a declared profile, for the ledger.
 *
 * A hash, for the same reason message bodies are hashed: a declared name is
 * user content, the harness has no business writing it to a file somebody will
 * paste into an issue, and the oracle only needs to prove that what one side
 * declared is what the other side was shown.
 */
export function profileHash(profile: Profile | null): string {
  // `null` and "every field declined" must hash to the same value. The server
  // collapses one into the other — `profileFromFields` returns null when all
  // four fields are empty, so a bot that declared nothing sends an object and
  // is shown a null — and a hash that told them apart reported every anonymous
  // bot as a profile the server had failed to echo. The first run of this
  // oracle failed on exactly that, six times out of fifty-eight.
  const value = profile ?? NOTHING_DECLARED;
  return contentHash(
    JSON.stringify([value.name ?? '', value.country ?? '', value.age ?? 0, value.gender ?? '']),
  );
}

/** True when nothing at all was declared. */
export function isEmptyProfile(profile: Profile): boolean {
  return (
    profile.name === null &&
    profile.country === null &&
    profile.age === null &&
    profile.gender === null
  );
}
