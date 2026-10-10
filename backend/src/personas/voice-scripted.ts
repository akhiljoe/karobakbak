/**
 * A voice that speaks from the character sheet, with no model behind it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL, GIVEN A4 REPLACES IT
 * ---------------------------------------------------------------------------
 * It is not a placeholder. It is the thing that lets every part of A2 and A3 be
 * built and tested without spending a rupee or depending on a vendor:
 *
 *  - the socket handling, the reply pauses, the rate-limit mirror
 *  - the fill policy in A3, which needs personas that actually hold
 *    conversations in order to measure whether it ever pre-empts a human
 *  - the control plane, which must be provable *before* the first model call
 *
 * A model integration that arrives before any of that is a model integration
 * whose failures are indistinguishable from the plumbing's.
 *
 * It also stays useful after A4, as the fallback when the budget ceiling is hit
 * or a provider is down: a persona that says something plain is better than one
 * that goes silent mid-conversation, and far better than one that fails loudly
 * at somebody who thinks they are talking to a person.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY DOES NOT ATTEMPT
 * ---------------------------------------------------------------------------
 * It does not simulate conversation. Nobody should mistake it for the finished
 * product, and the honest framing matters: this is scaffolding that speaks, not
 * a cheap version of A4.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT LEARNED FROM BEING SEEN
 * ---------------------------------------------------------------------------
 * The first version opened with a prepared line from the character sheet and
 * then recited an opinion or an anecdote per turn, drawn at random. Read as a
 * transcript it is unmistakable:
 *
 *   them:  hi
 *   it:    i just did something embarrassing and i need to tell someone
 *   it:    do you bake. i bake badly. its a whole thing
 *   them:  where are you from?
 *   it:    every houseplant death is the plants fault, not mine
 *
 * Nothing there is a reply. Rotating the material stopped it repeating itself
 * and did nothing about the fact that it was never answering anybody, and the
 * cost of that landed on real people, because a provider outage or an exhausted
 * budget routes a live conversation straight here.
 *
 * So it now does the two things it *can* do without understanding language:
 * it greets first and it acknowledges before it contributes. A short "hm, no
 * idea" to a question is not a good answer, but it is an answer, and it is a
 * great deal closer to a person than a fact about houseplants. Character
 * material is still where every substantive line comes from, and it now arrives
 * as a follow-on rather than as an interruption.
 */

import type { PersonaVoice, VoiceTurn } from './client';
import { greetingFor } from './greeting';
import { Rng, randomSeed } from './rng';
import type { PersonaCharacter } from './types';

export interface ScriptedVoiceOptions {
  /** Fixed seed, for tests. Production passes nothing. */
  readonly seed?: number;
  /**
   * How many messages before the persona leaves.
   *
   * Capped rather than open-ended for two reasons that point the same way: it
   * bounds cost once A4 is behind this seam (D-AI-7), and a stranger who never
   * tires is a tell. Real conversations here end.
   */
  readonly maxMessages?: number;
}

const DEFAULT_MAX_MESSAGES = 12;

/** Said when they asked something this voice has no way of answering. */
const DEFLECTIONS = [
  'hm. honestly not sure',
  'no idea tbh',
  'good question',
  'depends on the day',
  'ha. not sure how to answer that',
  'you first',
];

/** Said when they said something that was not a question. */
const ACKNOWLEDGEMENTS = [
  'ha',
  'yeah fair',
  'oh really',
  'makes sense',
  'true',
  'hm',
  'thats fair',
  'right',
];

/**
 * Whether they asked something.
 *
 * Crude on purpose: a question mark, or one of the words a question usually
 * opens with. Over-matching costs an acknowledgement that reads slightly off;
 * under-matching costs a question ignored, which is the failure this voice was
 * built to stop making.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (t === '') return false;
  if (t.includes('?')) return true;
  return /^(what|where|when|who|why|how|which|do|does|did|are|is|can|could|would|will|have|has)\b/.test(t);
}

export function scriptedVoice(
  character: PersonaCharacter,
  options: ScriptedVoiceOptions = {},
): PersonaVoice {
  const rng = new Rng(options.seed ?? randomSeed());
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;

  // Drawn once so the persona does not repeat itself inside one conversation,
  // which is the most obvious failure of a scripted speaker.
  const opinions = shuffle(rng, character.opinions);
  const anecdotes = shuffle(rng, character.anecdotes);
  const topics = shuffle(rng, character.naturalTopics);

  let opinionsUsed = 0;
  let anecdotesUsed = 0;
  let topicsUsed = 0;

  return {
    reply(turn: VoiceTurn): string | null {
      // Hello first, every time, and the same greeting the model-backed voice
      // opens with — the opening is not a thing either voice generates.
      if (turn.sent === 0) return greetingFor(character);

      const incoming = turn.incoming ?? '';

      // A direct question gets an answer-shaped line. It is a weak answer, and
      // it is still the difference between a stranger and a broadcast.
      const opener = looksLikeQuestion(incoming)
        ? rng.pick(DEFLECTIONS)
        : rng.pick(ACKNOWLEDGEMENTS);

      // Say nothing sometimes. A speaker that answers every single message is
      // more obviously mechanical than one that occasionally lets a line pass —
      // but never in place of answering a question.
      if (!looksLikeQuestion(incoming) && rng.chance(0.15)) return null;

      // Early on, the acknowledgement is the whole reply. Following "hi" with a
      // fully formed opinion is what made this voice read as a broadcast.
      if (turn.sent < 2) return opener;

      // From here material may follow, on its own line, so the client sends it
      // as a second message the way a person adds a thought after sending one.
      const follow = nextLine();
      if (follow === null) return opener;
      return `${opener}\n${follow}`;
    },

    shouldLeave(turn: VoiceTurn): boolean {
      return turn.sent >= maxMessages;
    },
  };

  /**
   * The next unused line of the character's own material, or null.
   *
   * Rotated in a per-conversation order so the same persona met twice does not
   * recite the same list, and never repeated inside one conversation — which is
   * what gets noticed first once the lines are at least on topic.
   */
  function nextLine(): string | null {
    const choice = rng.below(3);

    if (choice === 0 && opinionsUsed < opinions.length) {
      const line = opinions[opinionsUsed];
      opinionsUsed += 1;
      if (line !== undefined) return line;
    }

    if (choice === 1 && anecdotesUsed < anecdotes.length) {
      const line = anecdotes[anecdotesUsed];
      anecdotesUsed += 1;
      if (line !== undefined) return line;
    }

    if (topicsUsed < topics.length) {
      const topic = topics[topicsUsed];
      topicsUsed += 1;
      if (topic !== undefined) return `what about ${topic}`;
    }

    return null;
  }
}

/** Fisher-Yates, seeded, so a conversation's order is reproducible in a test. */
function shuffle<T>(rng: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = rng.below(i + 1);
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}
