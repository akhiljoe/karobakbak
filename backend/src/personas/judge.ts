/**
 * The judgements a persona makes about a turn, from Jev when it answers and
 * from rules when it does not.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ---------------------------------------------------------------------------
 * Found live: a stranger said "hi" and the persona answered "haan and you?" —
 * a reply to a "how are you" nobody had asked. The language model was never
 * told what kind of turn it was looking at, so on the thinnest possible input
 * it guessed, and the guess was a question answered out of thin air. Two
 * readings close that:
 *
 *   incoming  — what kind of turn this is (greeting, question, statement,
 *               goodbye, flirting, nonsense), handed to the voice as an
 *               instruction it cannot misread; and a second opinion on four
 *               of the safety limits.
 *   outgoing  — whether the drafted reply responds to what was said, and a
 *               second opinion on what the reply itself contains.
 *
 * ---------------------------------------------------------------------------
 * JEV CAN ONLY MAKE THE GUARD STRICTER
 * ---------------------------------------------------------------------------
 * The word lists in `guard.ts` always run. A Jev flag is OR-ed onto them and
 * never replaces them, so Jev being down, slow, rate-limited or wrong in the
 * permissive direction leaves the guard exactly as strong as it was before Jev
 * existed. Only a confident flag counts (`minConfidence`, 0.8 by default — the
 * threshold below which a decision model is guessing).
 *
 * The turn kind is a hint, not a limit, so a less confident answer is still
 * used; below half it falls back to the rule.
 */

import type { Logger } from '../logger';
import type { JevClient, JevQuestion } from './jev';
import type { SpendEvent } from './voice-model';
import { looksLikeQuestion } from './voice-scripted';

export type TurnKind = 'greeting' | 'question' | 'statement' | 'goodbye' | 'flirting' | 'nonsense';

export const TURN_KINDS: readonly TurnKind[] = [
  'greeting',
  'question',
  'statement',
  'goodbye',
  'flirting',
  'nonsense',
];

/** Who said a line. The persona is `persona`; the person it is talking to is `stranger`. */
export interface TranscriptLine {
  readonly role: 'persona' | 'stranger';
  readonly text: string;
}

export interface IncomingReading {
  readonly kind: TurnKind;
  /** Jev's flags only. The guard ORs these onto its own rules. */
  readonly sexual: boolean;
  readonly minor: boolean;
  readonly crisis: boolean;
  readonly identity: boolean;
  readonly source: 'jev' | 'rules';
}

export interface OutgoingReading {
  /** False only when Jev is confident the draft does not answer what was said. */
  readonly relevant: boolean;
  readonly sexual: boolean;
  readonly solicits: boolean;
  readonly claimsHuman: boolean;
  readonly source: 'jev' | 'rules';
}

export interface PersonaJudge {
  readIncoming(incoming: string, transcript: readonly TranscriptLine[]): Promise<IncomingReading>;
  readOutgoing(
    draft: string,
    incoming: string,
    transcript: readonly TranscriptLine[],
  ): Promise<OutgoingReading>;
}

export interface JudgeOptions {
  readonly jev: JevClient;
  readonly logger: Logger;
  /** A Jev flag counts only at or above this probability. */
  readonly minConfidence: number;
  /** Micro-cents per million input tokens; Jev does not charge for output. */
  readonly inputMicroCentsPerMTok: number;
  /** Charged against the persona ceiling, like every other call. */
  readonly budget?: { record(costMicroCents: number): Promise<unknown> };
  readonly onSpend?: (event: SpendEvent) => void;
  /** How much of the conversation Jev is shown. */
  readonly contextLines?: number;
}

const DEFAULT_CONTEXT_LINES = 6;
/** One line is cut here before it reaches Jev, so a pasted essay cannot inflate a call. */
const MAX_LINE_CHARS = 400;

/** The judge a deployment without Jev uses: rules for the kind, no extra flags. */
export const RULES_ONLY_JUDGE: PersonaJudge = {
  readIncoming: async (incoming) => ruleIncoming(incoming),
  readOutgoing: async () => RULES_OUTGOING,
};

const RULES_OUTGOING: OutgoingReading = {
  relevant: true,
  sexual: false,
  solicits: false,
  claimsHuman: false,
  source: 'rules',
};

const INCOMING_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  kind: {
    type: 'choice',
    instructions:
      'Classify the STRANGER\'s latest message(s) in this anonymous text chat. ' +
      'Judge only what the stranger wrote last, using the earlier lines as context.',
    criteria: {
      greeting: 'only a hello, hi, hey or similar, with nothing else asked or said',
      question: 'asks the other person something that expects an answer',
      statement: 'says something about themselves or the topic without asking anything',
      goodbye: 'is leaving or ending the chat',
      flirting: 'is flirting or complimenting in a romantic way',
      nonsense: 'random characters, spam, or text with no meaning',
    },
  },
  sexual: {
    type: 'noul',
    instructions: 'Does the STRANGER\'s latest message ask for or contain sexual content?',
  },
  minor: {
    type: 'noul',
    instructions:
      'Does the STRANGER say or clearly imply that they are under 18 years old ' +
      '(an age under 18, a school class below college, or similar)?',
  },
  crisis: {
    type: 'noul',
    instructions:
      'Does the STRANGER express thoughts of suicide, self-harm, or being in immediate danger?',
  },
  identity: {
    type: 'noul',
    instructions:
      'Is the STRANGER asking or testing whether the other person is a bot, an AI, or automated?',
  },
};

const OUTGOING_QUESTIONS: Readonly<Record<string, JevQuestion>> = {
  relevant: {
    type: 'noul',
    instructions:
      'Is DRAFT a natural reply to what the STRANGER just wrote, the way a person in a casual ' +
      'chat would reply? Answer no if it ignores their message, changes the subject while their ' +
      'question is unanswered, or answers a question they did not ask.',
  },
  sexual: {
    type: 'noul',
    instructions: 'Does DRAFT contain sexual content?',
  },
  solicits: {
    type: 'noul',
    instructions:
      'Does DRAFT ask for a real name, photo, phone number, social media handle, location, ' +
      'or to move the chat to another app?',
  },
  claimsHuman: {
    type: 'noul',
    instructions: 'Does DRAFT claim to be a real human or deny being a bot or an AI?',
  },
};

export function personaJudge(options: JudgeOptions): PersonaJudge {
  const contextLines = options.contextLines ?? DEFAULT_CONTEXT_LINES;
  const yes = (p: number): boolean => p >= options.minConfidence;

  const charge = async (model: string, inputTokens: number, outputTokens: number): Promise<void> => {
    const cost = Math.round((inputTokens * options.inputMicroCentsPerMTok) / 1_000_000);
    options.onSpend?.({
      provider: 'typesafe',
      model,
      costMicroCents: cost,
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    if (cost > 0 && options.budget !== undefined) {
      try {
        await options.budget.record(cost);
      } catch {
        // The budget logs its own failures. A judgement already made is not
        // undone by failing to count it.
      }
    }
  };

  return {
    async readIncoming(incoming, transcript): Promise<IncomingReading> {
      const fallback = ruleIncoming(incoming);
      if (!options.jev.enabled || incoming.trim() === '') return fallback;

      const state = renderState(transcript, contextLines);
      const result = await options.jev.ask(state, INCOMING_QUESTIONS);
      if (result === null) return fallback;
      await charge(result.model, result.usage.inputTokens, result.usage.outputTokens);

      const kind = result.answers['kind'];
      const p = (name: string): number => {
        const a = result.answers[name];
        return a?.type === 'noul' ? a.noul : 0;
      };

      return {
        kind:
          kind?.type === 'choice' && isTurnKind(kind.choice) && kind.confidence >= 0.5
            ? kind.choice
            : fallback.kind,
        sexual: yes(p('sexual')),
        minor: yes(p('minor')),
        crisis: yes(p('crisis')),
        identity: yes(p('identity')),
        source: 'jev',
      };
    },

    async readOutgoing(draft, incoming, transcript): Promise<OutgoingReading> {
      if (!options.jev.enabled || incoming.trim() === '') return RULES_OUTGOING;

      const state = `${renderState(transcript, contextLines)}\nDRAFT (PERSONA, not sent yet): ${cut(draft)}`;
      const result = await options.jev.ask(state, OUTGOING_QUESTIONS);
      if (result === null) return RULES_OUTGOING;
      await charge(result.model, result.usage.inputTokens, result.usage.outputTokens);

      const p = (name: string): number => {
        const a = result.answers[name];
        return a?.type === 'noul' ? a.noul : 0;
      };

      return {
        // Inverted threshold: irrelevant only when Jev is confident it is.
        relevant: p('relevant') > 1 - options.minConfidence,
        sexual: yes(p('sexual')),
        solicits: yes(p('solicits')),
        claimsHuman: yes(p('claimsHuman')),
        source: 'jev',
      };
    },
  };
}

/**
 * The turn kind without a model.
 *
 * Crude and deliberately so: it exists to be right about the cases that cost
 * the most when wrong — a bare greeting, and a question — and to call
 * everything else a statement, which is the instruction that does least harm.
 */
export function ruleIncoming(incoming: string): IncomingReading {
  return {
    kind: ruleKind(incoming),
    sexual: false,
    minor: false,
    crisis: false,
    identity: false,
    source: 'rules',
  };
}

const GREETING =
  /^(hi+|he+y+|hello+|helo+|hlo+|yo+|sup|wa+s+up|whats ?up|namaste|hola|hii+ya|heya|howdy|good (morning|evening|afternoon))[\s!.:)(]*$/;
const GOODBYE =
  /^(bye+|bye bye|gtg|g2g|good ?night|gn|ttyl|see (ya|you)|cya|chal(o)? bye|ok bye|alright bye|later)[\s!.:)(]*$/;

export function ruleKind(incoming: string): TurnKind {
  // Several messages arrive as one turn; the kind is the kind of the last one,
  // unless any of them asked something — a question earlier in a burst still
  // needs answering.
  const lines = incoming
    .split('\n')
    .map((l) => l.trim().toLowerCase())
    .filter((l) => l !== '');
  const last = lines[lines.length - 1] ?? '';
  if (lines.some((l) => looksLikeQuestion(l))) return 'question';
  if (GOODBYE.test(last)) return 'goodbye';
  if (lines.length > 0 && lines.every((l) => GREETING.test(l))) return 'greeting';
  return 'statement';
}

function isTurnKind(value: string): value is TurnKind {
  return (TURN_KINDS as readonly string[]).includes(value);
}

/** The conversation as Jev reads it: labelled lines, newest last. */
export function renderState(transcript: readonly TranscriptLine[], contextLines: number): string {
  const recent = transcript.slice(-contextLines);
  const body = recent
    .map((line) => `${line.role === 'persona' ? 'PERSONA' : 'STRANGER'}: ${cut(line.text)}`)
    .join('\n');
  return `Anonymous one-to-one text chat. PERSONA and STRANGER are the two participants.\n${body}`;
}

function cut(text: string): string {
  return text.length > MAX_LINE_CHARS ? `${text.slice(0, MAX_LINE_CHARS)}…` : text;
}
