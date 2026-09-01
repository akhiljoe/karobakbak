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
 * Deriving a nickname from a session id would make it a stable *function of an
 * identifier*: anybody holding the id could recompute the name, and the two
 * would be interchangeable for ever. Generated randomness is not that, even
 * when it is kept — which is what makes the scope below a choice rather than a
 * violation.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STABLE, AND FOR HOW LONG
 * ---------------------------------------------------------------------------
 * The **nickname** is drawn once per session and reused by every match that
 * session has. The **colour** is still drawn per match.
 *
 * This reverses the original rule that nothing may be stable across matches
 * (`DESIGN.md` §24.3, accounts doc §21) and it is worth being exact about what
 * was traded. The threat §24.3 names is a handle somebody can accumulate
 * against a person over time; a session dies with the tab, so what a stranger
 * can accumulate is bounded by one visit rather than being open-ended. What is
 * genuinely given up is smaller and sharper: two people matched twice in the
 * same visit can now tell it is the same person, and two strangers who both
 * met somebody during one of their sessions could compare notes and know it.
 * Neither survives the tab closing.
 *
 * What it buys is that a stranger stays recognisable for the length of a visit
 * — in Recent, and across a skip that pairs the same two people again — which
 * a name redrawn every match made impossible for anybody who declared nothing.
 *
 * The colour deliberately did not follow. Nickname plus colour is a markedly
 * more distinctive handle than either alone, and the colour's job is contrast
 * *inside* one conversation, which per-match drawing does better.
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
 * One nickname, for one session.
 *
 * Drawn when the session is created and written to its hash, so every match it
 * has reuses it. Exported for the caller that does the writing; the pairing
 * below takes what it finds rather than drawing its own.
 */
export function newNickname(): string {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

/**
 * Two identities for one match, guaranteed distinguishable.
 *
 * Distinctness still has to hold: two participants sharing a nickname or a
 * colour makes the conversation ambiguous in exactly the situation — an
 * argument worth reporting — where reading it back matters most.
 *
 * The colour keeps its by-construction guarantee, drawn here with the other
 * side's removed from the list. The nickname cannot, because both sides now
 * arrive with one already chosen and neither knew about the other. A collision
 * is rare (it needs the same adjective *and* the same noun) and is resolved by
 * redrawing **the arriving side** — the caller passes the session that just
 * matched as `you`, so the person who was already waiting keeps the name they
 * have been using, and the one whose arrival caused the clash is the one who
 * changes. The redraw is for this match only and is never written back: it
 * settles one conversation, so persisting it would let any stranger change
 * somebody's name for every other conversation by colliding with it.
 *
 * A missing nickname is drawn fresh. That is the pre-session-scope behaviour
 * and it is the right fallback for a hash that expired between the match and
 * this read — degraded, not wrong.
 */
export function newIdentityPair(
  profiles?: {
    you: Profile | null;
    partner: Profile | null;
  },
  nicknames?: {
    you: string | null;
    partner: string | null;
  },
): { you: Identity; partner: Identity } {
  const partnerNickname = nicknames?.partner ?? newNickname();
  const yourNickname = distinctFrom(nicknames?.you ?? newNickname(), partnerNickname);
  const yourColour = pick(COLOURS);

  return {
    you: {
      nickname: yourNickname,
      colour: yourColour,
      // The generated nickname stays even when a profile name exists. It is the
      // fallback a client renders when someone declared nothing, so every match
      // has a label without a client inventing a placeholder.
      profile: profiles?.you ?? null,
    },
    partner: {
      nickname: partnerNickname,
      colour: pickOther(COLOURS, yourColour),
      profile: profiles?.partner ?? null,
    },
  };
}

/**
 * A nickname that is not the one the other side is using.
 *
 * Redraws both words against the taken name rather than nudging one of them,
 * so the result cannot be read as a variant of it — "Gentle Otter" answered by
 * "Gentle Panda" looks like a relationship between the two people, which is
 * exactly the thing a nickname must not imply.
 */
function distinctFrom(nickname: string, taken: string): string {
  if (nickname !== taken) return nickname;
  const [takenAdjective, takenNoun] = taken.split(' ');
  return `${pickOther(ADJECTIVES, takenAdjective ?? '')} ${pickOther(NOUNS, takenNoun ?? '')}`;
}
