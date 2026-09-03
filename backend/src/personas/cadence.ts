/**
 * How a persona *delivers* text, as distinct from what it says.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A FILE AND NOT A CONSTANT
 * ---------------------------------------------------------------------------
 * The first version of the persona client generated a reply, waited a delay
 * derived from its length, and sent the whole thing as one frame with no
 * typing indicator. It reads exactly as it is built: text appears in one piece,
 * fully formed, from someone who was never seen writing it. Every real client
 * on this server sends `typing` while composing and sends short bursts, so a
 * participant who does neither is distinguishable from a person without
 * reading a single word they wrote.
 *
 * So delivery gets its own module, with three separate intervals that a person
 * actually spends:
 *
 *   reading   — looking at what the stranger said, before anything else
 *   typing    — visible, with `typing: true` on the wire the whole time
 *   the gap   — between two consecutive bubbles of one thought
 *
 * The numbers are not a model of human behaviour and do not need to be. The
 * failure being fixed is a message that arrives whole and instantly; anything
 * in these ranges, paired with a typing indicator, is not that.
 *
 * ---------------------------------------------------------------------------
 * WHY BUBBLES
 * ---------------------------------------------------------------------------
 * People send "wait" and then "actually no" as two messages. A model returns
 * one paragraph. Splitting on sentence boundaries and sending the pieces with
 * a typing indicator between them is the difference between a chat and a
 * dictated statement, and it costs nothing — the text was already generated.
 *
 * Bounded at three, because a persona that sends five bubbles to one line is
 * its own kind of tell, and every bubble is a frame against the server's
 * message rate limit.
 */

/**
 * Every number that decides how a persona reads, types and pauses.
 *
 * One object rather than a dozen module constants, because they are one
 * decision: the intervals only make sense against each other, and a deployment
 * moving one of them wants to see the rest. `config.personas.cadence` supplies
 * them in production; `DEFAULT_CADENCE` is what this project ships and what a
 * test gets by default.
 */
export interface CadenceTuning {
  /** No bubble longer than this if it can be split at a boundary. */
  readonly softBubbleChars: number;
  /** Below this, a reply is one thought and stays one message. */
  readonly keepWholeBelow: number;
  /** More than this and it stops reading as a burst and starts reading as a bot. */
  readonly maxBubbles: number;
  /** Milliseconds per character of *incoming* text, i.e. reading speed. */
  readonly readMsPerChar: number;
  readonly readFloorMs: number;
  readonly readCeilingMs: number;
  /**
   * Milliseconds per character of *outgoing* text, i.e. thumb speed.
   *
   * Deliberately faster than real phone typing (~300ms/char at 40wpm). A
   * literal rate would leave a stranger watching "typing…" for eighteen seconds
   * over one sentence, which is accurate and unusable. Fast-but-visible.
   */
  readonly typeMsPerChar: number;
  readonly typeFloorMs: number;
  readonly typeCeilingMs: number;
  readonly gapFloorMs: number;
  readonly gapSpreadMs: number;
  /** Hesitation before the thumbs start moving. Not proportional to anything. */
  readonly thinkFloorMs: number;
  readonly thinkSpreadMs: number;
  /**
   * How many of a persona's own turns count as "the beginning".
   *
   * Three: the greeting, and the two exchanges after it. That is the span in
   * which a real conversation is still deciding whether it is a conversation.
   */
  readonly openingTurns: number;
  /** The most words an opening reply may carry, however many it was given. */
  readonly openingMaxWords: number;
}

/** What this project ships. The defaults in `config.ts` are these numbers. */
export const DEFAULT_CADENCE: CadenceTuning = Object.freeze({
  softBubbleChars: 90,
  keepWholeBelow: 60,
  maxBubbles: 3,
  readMsPerChar: 22,
  readFloorMs: 400,
  readCeilingMs: 4000,
  typeMsPerChar: 90,
  typeFloorMs: 700,
  typeCeilingMs: 6000,
  gapFloorMs: 500,
  gapSpreadMs: 900,
  thinkFloorMs: 300,
  thinkSpreadMs: 1200,
  openingTurns: 3,
  openingMaxWords: 12,
});

export interface Cadence {
  /** Time spent looking at what the stranger said, before typing starts. */
  readingPauseMs(incoming: string | undefined): number;
  /** Time spent visibly typing one bubble. */
  typingPauseMs(text: string): number;
  /** Time between the end of one bubble and the start of the next. */
  bubbleGapMs(): number;
}

/**
 * The production cadence.
 *
 * `random` is injected so a test can pin every interval; nothing here reads the
 * clock, so the client's injected scheduler stays the only source of time.
 */
export function humanCadence(
  random: () => number = Math.random,
  tuning: CadenceTuning = DEFAULT_CADENCE,
): Cadence {
  const jitter = (floor: number, spread: number): number =>
    Math.round(floor + random() * spread);

  return {
    readingPauseMs(incoming: string | undefined): number {
      const think = jitter(tuning.thinkFloorMs, tuning.thinkSpreadMs);
      if (incoming === undefined || incoming === '') return think;
      const read = incoming.length * tuning.readMsPerChar;
      return Math.min(tuning.readCeilingMs, Math.max(tuning.readFloorMs, read)) + think;
    },

    typingPauseMs(text: string): number {
      const typed = text.length * tuning.typeMsPerChar;
      const base = Math.min(tuning.typeCeilingMs, Math.max(tuning.typeFloorMs, typed));
      // +-15%, so two bubbles of equal length are not two equal pauses.
      return Math.round(base * (0.85 + random() * 0.3));
    },

    bubbleGapMs(): number {
      return jitter(tuning.gapFloorMs, tuning.gapSpreadMs);
    },
  };
}

/**
 * Cut an early reply down to the size a stranger actually opens with.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT LEFT TO THE PROMPT
 * ---------------------------------------------------------------------------
 * The prompt already says "usually under fifteen words" and "never more than
 * two sentences". The second message of a live conversation was:
 *
 *   wait, that's it? i'm 29, nonbinary, us. bought three keyboards i can't
 *   justify and at least two games i'll never finish. you?
 *
 * Thirty-five words, three sentences, an entire declared profile and two
 * anecdotes — to somebody who had so far said "hi" and "m". Every instruction
 * it broke was already written down, which is the whole argument for putting
 * limits between the model and the socket rather than inside the prompt: an
 * instruction is a request, and this is not.
 *
 * It keeps the **first sentence**, never a truncation mid-clause, because a
 * bubble that stops in the middle of a thought reads as a bug rather than as
 * brevity. If that one sentence is still long it is cut at a word boundary.
 *
 * Late in a conversation this does nothing. Somebody twenty messages deep has
 * earned the right to a longer answer, and by then the other person has decided
 * they are talking to a person.
 */
export function openingBrevity(
  text: string,
  sent: number,
  tuning: CadenceTuning = DEFAULT_CADENCE,
): string {
  if (sent >= tuning.openingTurns) return text;

  const trimmed = text.trim();
  if (trimmed === '') return trimmed;

  // First line first: a reply the model laid out over two lines has already
  // said which thought comes first.
  const firstLine = trimmed.split(/\n+/)[0]?.trim() ?? trimmed;

  const sentence = firstSentence(firstLine);
  const kept = sentence === '' ? firstLine : sentence;

  const words = kept.split(/\s+/);
  if (words.length <= tuning.openingMaxWords) return kept;
  return words.slice(0, tuning.openingMaxWords).join(' ');
}

/**
 * A sentence ends at `.`, `!` or `?` **followed by whitespace or the end of the
 * string** — never at one sitting inside a word.
 *
 * Written after an integration test caught the naive version cutting
 * "have a look at http://example.com" down to "have a look at http://example."
 * — the dot in the domain looked exactly like a full stop. Decimals and
 * abbreviations break the same way, and the persona would have been sending
 * truncated URLs to real people.
 *
 * The lookahead is what distinguishes a terminator from a separator. The second
 * alternative is the fallback: a line with no sentence break at all is one
 * sentence, not zero.
 */
const SENTENCE = /.*?[.!?](?=\s|$)\s*|.+$/g;

/** The first sentence of a line, or the whole line when it has no break. */
function firstSentence(line: string): string {
  const match = /^.*?[.!?](?=\s|$)/.exec(line);
  return match?.[0]?.trim() ?? line;
}

/**
 * Split one generated reply into the messages a person would actually send.
 *
 * Splits only at sentence boundaries and newlines — never mid-word and never
 * mid-sentence, because a bubble that ends in the middle of a clause reads as
 * a truncation bug rather than as someone hitting send early.
 *
 * `maxLength` is the server's own message cap. A single sentence longer than
 * that is hard-cut, because the alternative is a frame the server refuses and
 * a model call already paid for.
 */
export function splitIntoBubbles(
  text: string,
  maxLength?: number,
  tuning: CadenceTuning = DEFAULT_CADENCE,
): string[] {
  const trimmed = text.trim();
  if (trimmed === '') return [];

  // A newline is a break the writer already chose, so it wins over every
  // heuristic below it — including the short-reply rule. Two lines are two
  // messages however short they are; that is what writing them on two lines
  // meant.
  const lines = trimmed
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');

  const pieces =
    lines.length > 1
      ? lines
      : trimmed.length <= tuning.keepWholeBelow
        ? [trimmed]
        : group(sentences(trimmed), tuning);

  const capped: string[] = [];
  for (const piece of pieces) {
    if (maxLength === undefined || piece.length <= maxLength) {
      capped.push(piece);
      continue;
    }
    for (let i = 0; i < piece.length; i += maxLength) {
      capped.push(piece.slice(i, i + maxLength));
    }
  }

  return capped.slice(0, tuning.maxBubbles);
}

/**
 * Break one line into sentence-ish units.
 *
 * Terminal punctuation only, kept attached to the sentence it ends. Newlines
 * are handled by the caller, which treats them as decisions rather than as
 * punctuation.
 */
function sentences(text: string): string[] {
  const parts = text.match(SENTENCE);
  if (parts === null) return [text];

  const out: string[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (piece !== '') out.push(piece);
  }
  return out.length === 0 ? [text] : out;
}

/** Pack sentences into bubbles, starting a new one past the soft limit. */
function group(parts: readonly string[], tuning: CadenceTuning): string[] {
  const out: string[] = [];
  let current = '';

  for (const part of parts) {
    if (current === '') {
      current = part;
      continue;
    }
    if (current.length + 1 + part.length <= tuning.softBubbleChars) {
      current = `${current} ${part}`;
      continue;
    }
    out.push(current);
    current = part;
  }

  if (current !== '') out.push(current);
  return out.length === 0 ? [...parts] : out;
}
