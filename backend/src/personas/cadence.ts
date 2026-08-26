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

/** No bubble longer than this if it can be split at a boundary. */
const SOFT_BUBBLE_CHARS = 90;

/** Below this, a reply is one thought and stays one message. */
const KEEP_WHOLE_BELOW = 60;

/** More than this and it stops reading as a burst and starts reading as a bot. */
const MAX_BUBBLES = 3;

/** Milliseconds per character of *incoming* text, i.e. reading speed. */
const READ_MS_PER_CHAR = 22;
const READ_FLOOR_MS = 400;
const READ_CEILING_MS = 4000;

/**
 * Milliseconds per character of *outgoing* text, i.e. thumb speed.
 *
 * Deliberately faster than real phone typing (~300ms/char at 40wpm). A literal
 * rate would leave a stranger watching "typing…" for eighteen seconds over one
 * sentence, which is accurate and unusable. This is fast-but-visible.
 */
const TYPE_MS_PER_CHAR = 90;
const TYPE_FLOOR_MS = 700;
const TYPE_CEILING_MS = 6000;

const GAP_FLOOR_MS = 500;
const GAP_SPREAD_MS = 900;

/** Hesitation before the thumbs start moving. Not proportional to anything. */
const THINK_FLOOR_MS = 300;
const THINK_SPREAD_MS = 1200;

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
export function humanCadence(random: () => number = Math.random): Cadence {
  const jitter = (floor: number, spread: number): number =>
    Math.round(floor + random() * spread);

  return {
    readingPauseMs(incoming: string | undefined): number {
      const think = jitter(THINK_FLOOR_MS, THINK_SPREAD_MS);
      if (incoming === undefined || incoming === '') return think;
      const read = incoming.length * READ_MS_PER_CHAR;
      return Math.min(READ_CEILING_MS, Math.max(READ_FLOOR_MS, read)) + think;
    },

    typingPauseMs(text: string): number {
      const typed = text.length * TYPE_MS_PER_CHAR;
      const base = Math.min(TYPE_CEILING_MS, Math.max(TYPE_FLOOR_MS, typed));
      // +-15%, so two bubbles of equal length are not two equal pauses.
      return Math.round(base * (0.85 + random() * 0.3));
    },

    bubbleGapMs(): number {
      return jitter(GAP_FLOOR_MS, GAP_SPREAD_MS);
    },
  };
}

/**
 * How many of a persona's own turns count as "the beginning".
 *
 * Three: the greeting, and the two exchanges after it. That is the span in
 * which a real conversation is still deciding whether it is a conversation.
 */
const OPENING_TURNS = 3;

/** The most words an opening reply may carry, however many it was given. */
const OPENING_MAX_WORDS = 12;

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
export function openingBrevity(text: string, sent: number): string {
  if (sent >= OPENING_TURNS) return text;

  const trimmed = text.trim();
  if (trimmed === '') return trimmed;

  // First line first: a reply the model laid out over two lines has already
  // said which thought comes first.
  const firstLine = trimmed.split(/\n+/)[0]?.trim() ?? trimmed;

  const sentence = firstLine.match(/^[^.!?]*[.!?]*/)?.[0]?.trim() ?? firstLine;
  const kept = sentence === '' ? firstLine : sentence;

  const words = kept.split(/\s+/);
  if (words.length <= OPENING_MAX_WORDS) return kept;
  return words.slice(0, OPENING_MAX_WORDS).join(' ');
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
export function splitIntoBubbles(text: string, maxLength?: number): string[] {
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
      : trimmed.length <= KEEP_WHOLE_BELOW
        ? [trimmed]
        : group(sentences(trimmed));

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

  return capped.slice(0, MAX_BUBBLES);
}

/**
 * Break one line into sentence-ish units.
 *
 * Terminal punctuation only, kept attached to the sentence it ends. Newlines
 * are handled by the caller, which treats them as decisions rather than as
 * punctuation.
 */
function sentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]*\s*/g);
  if (parts === null) return [text];

  const out: string[] = [];
  for (const part of parts) {
    const piece = part.trim();
    if (piece !== '') out.push(piece);
  }
  return out.length === 0 ? [text] : out;
}

/** Pack sentences into bubbles, starting a new one past the soft limit. */
function group(parts: readonly string[]): string[] {
  const out: string[] = [];
  let current = '';

  for (const part of parts) {
    if (current === '') {
      current = part;
      continue;
    }
    if (current.length + 1 + part.length <= SOFT_BUBBLE_CHARS) {
      current = `${current} ${part}`;
      continue;
    }
    out.push(current);
    current = part;
  }

  if (current !== '') out.push(current);
  return out.length === 0 ? [...parts] : out;
}
