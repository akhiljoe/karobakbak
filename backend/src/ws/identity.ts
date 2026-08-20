/**
 * Per-match display identities.
 *
 * A pair is generated when a match is formed and travels with the `matched`
 * event, so both instances show the same two identities without either one
 * having to store or derive them. They are discarded with the match.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE GENERATED, NOT DERIVED
 * ---------------------------------------------------------------------------
 * Deriving a nickname from a session id would be cheaper — any instance could
 * recompute it — but it would also make the nickname a stable function of an
 * identifier, and anything stable across matches is a correlation handle
 * (`DESIGN.md` §24.3, accounts doc §21). Generating fresh randomness per match
 * and shipping it in the event costs a few bytes and leaves nothing to
 * correlate.
 *
 * The words are deliberately bland. A nickname is shown to a stranger, so the
 * lists carry no slang, no names of people or places, nothing that reads as an
 * accusation, and nothing that could pair into an insult.
 */
import { randomInt } from 'node:crypto';

import type { Identity, Profile } from '../protocol/types';

const ADJECTIVES = [
  'Amber',
  'Autumn',
  'Brave',
  'Bright',
  'Calm',
  'Clever',
  'Copper',
  'Coral',
  'Curious',
  'Distant',
  'Eager',
  'Gentle',
  'Golden',
  'Hidden',
  'Jolly',
  'Lucky',
  'Merry',
  'Mellow',
  'Nimble',
  'Patient',
  'Polite',
  'Quiet',
  'Rapid',
  'Silver',
  'Sunny',
  'Swift',
  'Tidy',
  'Velvet',
  'Wandering',
  'Willow',
  'Winter',
  'Zesty',
] as const;

const NOUNS = [
  'Alpaca',
  'Badger',
  'Beacon',
  'Bison',
  'Comet',
  'Crane',
  'Dolphin',
  'Ember',
  'Falcon',
  'Ferret',
  'Fox',
  'Gecko',
  'Harbour',
  'Heron',
  'Ibis',
  'Kestrel',
  'Lantern',
  'Lemur',
  'Marten',
  'Meadow',
  'Otter',
  'Panda',
  'Puffin',
  'Quokka',
  'Raccoon',
  'River',
  'Sparrow',
  'Tapir',
  'Thicket',
  'Vixen',
  'Walrus',
  'Wren',
] as const;

/**
 * Accent colours, chosen to stay legible on both the light and dark themes and
 * to remain distinguishable to the most common forms of colour blindness — the
 * colour is one of the two things telling the participants apart.
 */
const COLOURS = [
  '#7C5CFF',
  '#2DD4BF',
  '#F59E0B',
  '#EC4899',
  '#3B82F6',
  '#10B981',
  '#F97316',
  '#A855F7',
] as const;

function pick<T>(values: readonly T[]): T {
  // randomInt, not Math.random: these are short-lived display values, but a
  // predictable stream is never the cheaper option when crypto randomness costs
  // nothing at this rate.
  const index = randomInt(0, values.length);
  const value = values[index];
  /* istanbul ignore next -- randomInt is bounded by the array length */
  if (value === undefined) throw new Error('identity: empty word list');
  return value;
}

function pickOther<T>(values: readonly T[], exclude: T): T {
  return pick(values.filter((value) => value !== exclude));
}

/**
 * Two identities for one match, guaranteed distinguishable.
 *
 * Distinctness is guaranteed by construction rather than by retrying until the
 * draw happens to differ: the second identity draws its adjective, noun and
 * colour from the lists with the first one's choices removed. Two participants
 * sharing a nickname or a colour would make the conversation ambiguous in
 * exactly the situation — an argument worth reporting — where reading it back
 * matters most.
 */
export function newIdentityPair(profiles?: {
  you: Profile | null;
  partner: Profile | null;
}): { you: Identity; partner: Identity } {
  const yourAdjective = pick(ADJECTIVES);
  const yourNoun = pick(NOUNS);
  const yourColour = pick(COLOURS);

  return {
    you: {
      nickname: `${yourAdjective} ${yourNoun}`,
      colour: yourColour,
      // The generated nickname stays even when a profile name exists. It is the
      // fallback a client renders when someone declared nothing, so every match
      // has a label without a client inventing a placeholder.
      profile: profiles?.you ?? null,
    },
    partner: {
      nickname: `${pickOther(ADJECTIVES, yourAdjective)} ${pickOther(NOUNS, yourNoun)}`,
      colour: pickOther(COLOURS, yourColour),
      profile: profiles?.partner ?? null,
    },
  };
}
