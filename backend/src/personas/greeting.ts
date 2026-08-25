/**
 * How a persona says hello.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OPENING IS NOT GENERATED
 * ---------------------------------------------------------------------------
 * It was, and the instruction was explicit — *greeting only, two or three
 * words, no question, no topic*. What came back was:
 *
 *   hey
 *   night shift or daytime for you?
 *
 * A model asked for a greeting produces a greeting and then, being a model,
 * something else. That second line is an opener fired at somebody who has not
 * spoken yet, which is the precise behaviour that removing `starters` was meant
 * to end; it simply moved from the character sheet into the generation.
 *
 * So the greeting stopped being a request and became a fact. Three things
 * follow from that, all of them good: it cannot ramble, it cannot contradict
 * the character, and it costs nothing — every conversation now begins without
 * a model call at all, which at the fill rates in D-AI-7 is a meaningful
 * fraction of the bill.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STILL THE CHARACTER'S
 * ---------------------------------------------------------------------------
 * The *word* is drawn at random, but how it is typed is the character's:
 * someone whose `capitalisation` is `lowercase` writes "hey", someone who
 * `sentence`-cases writes "Hey". Someone who uses emoji often may get one.
 *
 * That is the whole of the personality budget for a first message, and it is
 * the right amount. Nobody's character comes through in "hi" — it comes through
 * in what they say once the other person has answered, which is where the model
 * takes over.
 */

import type { Capitalisation, PersonaCharacter } from './types';

/**
 * Greetings, and nothing that is not a greeting.
 *
 * Every entry has to survive being the only thing a stranger has seen. No
 * questions, no observations, no openers — a question here is an interview
 * starting before hello has landed.
 */
const GREETINGS: readonly string[] = [
  'hey',
  'hi',
  'hey there',
  'yo',
  'hello',
  'hii',
  'heyy',
  'hey :)',
];

/** Added, occasionally, for a character that actually types like this. */
const WARM_SUFFIXES: readonly string[] = [' :)', ' 🙂'];

export interface GreetingOptions {
  /** Injected in tests. Production passes nothing. */
  readonly random?: () => number;
}

/**
 * One greeting, in this character's typing style.
 *
 * Deliberately has no access to the conversation, because there is no
 * conversation yet — this is the first thing said, and anything that reads as
 * a response to something is wrong by construction.
 */
export function greetingFor(
  character: PersonaCharacter,
  options: GreetingOptions = {},
): string {
  const random = options.random ?? Math.random;

  const base = GREETINGS[Math.floor(random() * GREETINGS.length)] ?? 'hey';
  const styled = applyCapitalisation(base, character.style.capitalisation);

  // Only for a character that uses them, and only sometimes. An emoji on every
  // single opening is as mechanical as never using one.
  if (character.style.emojiUse === 'frequent' && !hasSuffix(styled) && random() < 0.4) {
    const suffix = WARM_SUFFIXES[Math.floor(random() * WARM_SUFFIXES.length)] ?? '';
    return `${styled}${suffix}`;
  }

  return styled;
}

/** Whether the greeting already carries decoration, so none is added twice. */
function hasSuffix(text: string): boolean {
  return text.includes(':)') || /\p{Extended_Pictographic}/u.test(text);
}

/**
 * Match the character's shift key.
 *
 * `mixed` is left as written: a character who is inconsistent about the shift
 * key is inconsistent, and forcing either case would make it consistent.
 */
function applyCapitalisation(text: string, style: Capitalisation): string {
  switch (style) {
    case 'sentence':
      return text.charAt(0).toUpperCase() + text.slice(1);
    case 'lowercase':
      return text.toLowerCase();
    default:
      return text;
  }
}
