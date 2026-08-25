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
 * It does not simulate conversation. It opens with one of the character's own
 * starters, offers opinions and anecdotes as the conversation goes on, and
 * leaves before it can repeat itself. Nobody should mistake it for the finished
 * product, and the honest framing matters: this is scaffolding that speaks, not
 * a cheap version of A4.
 *
 * Everything it says comes from the character sheet, so it is at least
 * *consistent* with the persona a model will later play — which makes the A3
 * measurements about the fill policy rather than about the text.
 */

import type { PersonaVoice, VoiceTurn } from './client';
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
      if (turn.sent === 0) return rng.pick(character.starters);

      // Say nothing sometimes. A speaker that answers every single message is
      // more obviously mechanical than one that occasionally lets a line pass.
      if (rng.chance(0.12)) return null;

      // Rotate through the character's own material, in an order that varies
      // per conversation. When it runs out, fall back to a topic rather than
      // repeating — repetition inside one conversation is what gets noticed.
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
    },

    shouldLeave(turn: VoiceTurn): boolean {
      return turn.sent >= maxMessages;
    },
  };
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
