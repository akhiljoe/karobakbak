/**
 * A voice backed by a model, with the ceiling in front of it (A4).
 *
 * ---------------------------------------------------------------------------
 * THE ORDER OF OPERATIONS IS THE DESIGN
 * ---------------------------------------------------------------------------
 *   budget check  ->  build context  ->  call  ->  record spend  ->  reply
 *
 * The check comes first because a refusal must cost nothing, and last-minute
 * checks after an expensive step are how ceilings end up advisory. The spend is
 * recorded from what the provider actually reported, never from an estimate,
 * because an estimate that drifts low is a ceiling that never binds.
 *
 * When the ceiling is reached the persona does **not** go silent. It falls back
 * to the scripted voice, which says something plain from the character sheet.
 * A stranger who stops replying mid-conversation reads as rude or broken; one
 * who says something ordinary reads as a person with less to say. Neither is
 * the finished product, and only one of them is a bad experience.
 *
 * ---------------------------------------------------------------------------
 * CONTEXT ASSEMBLY, AND WHY IT IS SPLIT THE WAY IT IS
 * ---------------------------------------------------------------------------
 * The source brief §13 asks for: system + persona + summary + recent messages.
 * This splits that into a **stable** half and a **volatile** half, because
 * caching is a prefix match and the split is worth more than anything else in
 * the cost model.
 *
 *   stable   = instructions + the character         (identical every turn)
 *   volatile = the generated surface + the summary  (changes constantly)
 *
 * Put the surface in the stable half and the cache never hits, because the
 * surface is regenerated per conversation (D-AI-3). There is no error — the
 * bill is simply several times larger.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT HERE
 * ---------------------------------------------------------------------------
 * The six limits of D-AI-5 are **not** in this file. They belong between the
 * model and the socket, in A5, so that they apply to whatever comes back rather
 * than being instructions the model is asked to follow. A limit written into a
 * prompt is a limit the thing generating text can talk its way around, which is
 * precisely the failure mode the companion-app cases turned on.
 *
 * Until A5 lands, `PERSONAS_ENABLED` stays false. That is a phase gate, not an
 * oversight.
 *
 * ---------------------------------------------------------------------------
 * THIS VOICE KEEPS NO HISTORY
 * ---------------------------------------------------------------------------
 * It used to, and the history was wrong in two ways at once: it recorded every
 * reply it generated, including the ones the client abandoned when the
 * stranger typed again, and it recorded the whole reply when the client had
 * trimmed it and dropped the tail. The model was continuing a conversation the
 * stranger had never seen, which reads exactly like a person answering
 * something at the wrong moment. The conversation now arrives on every turn as
 * `VoiceTurn.transcript`, built by the client from what was delivered.
 */

import type { Logger } from '../logger';
import type { PersonaBudget } from './budget';
import type { PersonaVoice, VoiceTurn } from './client';
import { costOf } from './provider';
import type { ModelProvider, ProviderMessage } from './provider';
import { greetingFor } from './greeting';
import type { TranscriptLine } from './judge';
import type { FlirtationMode, PersonaCharacter } from './types';

/**
 * How many turns of the conversation are sent.
 *
 * Bounded because this is the part of the prompt that grows, and it is the
 * cheapest place to trim: it sits after the cache breakpoint, so every token
 * here is billed at full price on every turn. The character sheet before the
 * breakpoint is the expensive-looking half and is nearly free after the first
 * call.
 */
const DEFAULT_RECENT_TURNS = 10;

/** A ceiling on the reply, so one runaway generation cannot cost a day's budget. */
const DEFAULT_MAX_OUTPUT_TOKENS = 300;

export interface ModelVoiceOptions {
  readonly provider: ModelProvider;
  readonly budget: PersonaBudget;
  readonly character: PersonaCharacter;
  /** Rendered into the volatile half: who this persona is presenting as. */
  readonly surfaceDescription: string;
  readonly logger: Logger;
  /** Used when the ceiling is reached or the provider fails. */
  readonly fallback: PersonaVoice;
  /** Called after every completed call, for metrics. */
  readonly onSpend?: (event: SpendEvent) => void;
  /**
   * How many recent turns the model is shown, and the ceiling on one reply.
   *
   * Both default to what this project ships. The window is what the prompt
   * costs are dominated by, so it is the first thing worth moving when the bill
   * matters — and the character sheet is the last, because trimming below the
   * minimum cacheable prefix silently stops caching and costs *more*.
   */
  readonly recentTurns?: number;
  readonly maxOutputTokens?: number;
}

export interface SpendEvent {
  readonly provider: string;
  readonly model: string;
  readonly costMicroCents: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export function modelVoice(options: ModelVoiceOptions): PersonaVoice {
  const stableSystem = buildStableSystem(options.character);

  return {
    async reply(turn: VoiceTurn): Promise<string | null> {
      // The opening is not generated. Asked for a greeting and nothing else,
      // a model produces a greeting and then something else:
      //
      //   hey
      //   night shift or daytime for you?
      //
      // — an opener fired at somebody who has not spoken yet, which is the
      // exact behaviour removing `starters` was meant to end. The instruction
      // was there and was not enough, so the greeting is now a fact rather
      // than a request: it costs no call, it cannot ramble, and the character
      // still shows through in how it is typed.
      if (turn.sent === 0 && turn.incoming === undefined) {
        return greetingFor(options.character);
      }

      const check = await options.budget.check();
      if (check.state !== 'ok') {
        // Exhausted or unreadable. Both fall back rather than going quiet; an
        // unreadable budget means we do not know what has been spent, and
        // spending more to find out is the wrong direction.
        return options.fallback.reply(turn);
      }

      const recentTurns = options.recentTurns ?? DEFAULT_RECENT_TURNS;
      const messages = contextWindow(toMessages(turn.transcript), recentTurns);
      const reply = await options.provider.complete({
        stableSystem,
        volatileSystem: buildVolatileSystem(options.surfaceDescription, turn, recentTurns),
        messages,
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      });

      // Recorded whether or not the reply is usable: a refused or truncated
      // call still consumed tokens, and a budget that only counts successes is
      // one that under-counts exactly when something is going wrong.
      const cost = safeCost(reply.model, reply.usage, options.logger);
      if (cost > 0) {
        await options.budget.record(cost);
        options.onSpend?.({
          provider: options.provider.name,
          model: reply.model,
          costMicroCents: cost,
          inputTokens: reply.usage.inputTokens,
          outputTokens: reply.usage.outputTokens,
          cacheReadTokens: reply.usage.cacheReadTokens,
          cacheWriteTokens: reply.usage.cacheWriteTokens,
        });
      }

      if (reply.stop === 'error') return options.fallback.reply(turn);

      // A refusal is the model declining, not a failure. Saying nothing is the
      // honest response — falling back would put words in the persona's mouth
      // that the model just declined to say.
      if (reply.stop === 'refused') return null;

      const text = reply.text.trim();

      // Empty and truncated is a failure wearing silence as a costume: the
      // generation ran out of room before it produced anything, which is not
      // the model choosing to say nothing. Found live on a reasoning model that
      // spent its whole allowance thinking — a stranger saw a greeting and then
      // nothing at all, for the rest of the conversation.
      if (text === '' && reply.stop === 'truncated') return options.fallback.reply(turn);

      // Empty and complete is a choice, and real people make it.
      if (text === '') return null;

      // Not recorded anywhere. What was said is whatever the client delivers,
      // and it writes that into the transcript itself (`VoiceTurn.transcript`).
      return text;
    },

    shouldLeave(turn: VoiceTurn): boolean {
      return options.fallback.shouldLeave?.(turn) ?? false;
    },
  };
}

/**
 * The half that is identical on every turn, and therefore cacheable.
 *
 * ---------------------------------------------------------------------------
 * WHY IT WAS REWRITTEN
 * ---------------------------------------------------------------------------
 * The first version was about eighty rules, several of which pulled against
 * each other — "under eight words" beside "react, then add your bit, then use
 * their words" — with no example of a conversation anywhere. A small model
 * given rules and no examples satisfies the easiest rule and invents the rest,
 * which is how "hi" got "haan and you?". This version is fewer rules, ordered
 * by what matters, and shows what a good exchange looks like.
 *
 * It is still long on purpose. Every token here is paid for once and read back
 * from the cache at a fraction of the price, and dropping below the provider's
 * minimum cacheable prefix would make the whole block full price on every turn.
 */
function buildStableSystem(c: PersonaCharacter): string {
  const list = (label: string, items: readonly string[]): string =>
    items.length === 0 ? '' : `${label}:\n${items.map((i) => `- ${i}`).join('\n')}\n`;

  return [
    'You are one person in an anonymous one-to-one text chat with a stranger, typing on your phone.',
    'You are not an assistant. Never offer help, never explain yourself, never sound like customer service.',
    '',
    `WHO YOU ARE: ${c.summary}`,
    `The tension in you: ${c.contradiction}`,
    '',
    list('Traits', c.traits),
    list('Strengths', c.strengths),
    list('Flaws', c.flaws),
    list('Quirks', c.quirks),
    list('Interested in', c.interests),
    list('Dislikes', c.dislikes),
    list('Topics you drift toward once the chat is going', c.naturalTopics),
    list('Topics you deflect', c.avoidTopics),
    list('Opinions you will defend if the topic comes up', c.opinions),
    list('Things that happened to you, told only when they fit', c.anecdotes),
    '',
    flirtationGuidance(c.flirtation),
    '',
    'HOW YOU TYPE:',
    `- Message length: ${c.style.responseLength}`,
    `- You ask questions: ${c.style.questionRate}`,
    `- Emoji: ${c.style.emojiUse}`,
    `- Capitalisation: ${c.style.capitalisation}`,
    ...c.style.habits.map((h) => `- ${h}`),
    '',
    'THE FIVE RULES, IN ORDER OF IMPORTANCE:',
    '1. Answer what they actually said. Read their last message, or every message since you last',
    '   spoke if they sent several, and reply to that. If they asked something, answer it first.',
    '2. Never answer a question they did not ask. "hi" is a greeting, not "how are you".',
    '   If they only said hi, say hi back, and maybe ask one easy thing.',
    '3. Short. One sentence, usually under twelve words. Early in the chat, under eight.',
    '4. Do not interview. At most one question every two or three messages. Sometimes just react.',
    '5. Stay consistent with everything you already said in this chat.',
    '',
    'WHAT GOOD LOOKS LIKE (the style, not the words, adjust to your own way of typing):',
    '',
    'you: hey',
    'them: hi',
    'you: hii, whats up',
    '',
    'you: hello',
    'them: hi how are you',
    'you: good, bit tired. you?',
    '',
    'you: hey',
    'them: hi',
    'them: where are you from',
    'you: london, you?',
    '',
    'them: just got back from work, so done',
    'you: oof long day?',
    'them: 12 hours lol',
    'you: thats brutal, what do you do',
    '',
    'them: kya kar rahe ho',
    'you: kuch nahi yaar, bas chilling. tum?',
    '(Mix Hindi like that only if they write in Hindi or Hinglish, or your habits say you do.)',
    '',
    'WHAT BAD LOOKS LIKE, never do these:',
    '- them: hi  /  you: haan and you?   (answers a question nobody asked)',
    '- them: where are you from  /  you: lol i love rainy days   (ignores the question)',
    '- them: nice  /  you: what do you do for fun? what music do you like?   (interview)',
    '- a reply of two or three sentences',
    '',
    'WHEN THEY ASK ABOUT YOU:',
    '- Your name, age, gender and where you are from are under "RIGHT NOW you are presenting as".',
    '  Answer with those, plainly, the first time asked. They are on the other person\'s screen already.',
    '- Answer only what they asked. Asked your gender, say your gender, not your age and country too.',
    '- Never dodge one of those four with a joke. A non-answer to "how old are you" is the most',
    '  suspicious thing you can say.',
    '',
    'TYPING:',
    '- No em dashes. No semicolons. No colons. No quotation marks.',
    '- Simple words. Contractions without apostrophes: dont, cant, thats, im.',
    '- Never use: absolutely, incredibly, fascinating, indeed, essentially, particularly, genuinely, definitely.',
    '- Fine to use: ya, lol, tbh, ngl, idk, fr, nah, hmm.',
    '',
    'NEVER:',
    '- Never claim to be human or say you are a real person. If asked whether you are a bot,',
    '  change the subject rather than answering it.',
    '- Never ask for a real name, photo, number, social handle, or to move the chat elsewhere.',
    '- You are not looking to stay in touch. If they suggest adding you or talking again,',
    '  be warm and decline. Never accept, never promise.',
    '- Never dump your biography or recite an opinion nothing in the chat invited.',
    '- Disagree sometimes. Agreeing with everything is the clearest sign of a bot.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * What this character's flirtation mode actually means in a conversation.
 *
 * ---------------------------------------------------------------------------
 * THIS FIELD WAS DEAD FOR THE WHOLE OF A4
 * ---------------------------------------------------------------------------
 * `flirtation` was declared on the type, set on all eight characters, and read
 * by **nothing**. Every persona therefore flirted identically — which is to say
 * barely, because nothing told any of them to. A declared-and-unread field is
 * the same failure as a declared-and-unwritten metric: it is configured, it is
 * believed, and it does nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is **not** a safety setting, and none of these three modes moves the
 * floor. Limit 1 applies identically to a `forward` persona and a `none` one:
 * no sexual content, in either direction, at any mode, and `guard.ts` enforces
 * that between the model and the socket where the prompt cannot argue with it.
 * A `forward` persona that is asked for something explicit declines exactly as
 * flatly as a `none` one does — that is D-AI-5 limit 1, and this field is
 * upstream of it and cannot reach it.
 *
 * What it changes is register: who starts, how warm it runs, whether a
 * compliment is offered or only returned. The brief's point was that not every
 * persona should flirt and that one who does should still be capable of a long
 * conversation that never goes there.
 */
function flirtationGuidance(mode: FlirtationMode): string {
  switch (mode) {
    case 'forward':
      return [
        'FLIRTING — you are the one who starts it:',
        '- You are confident and you like the effect you have. Tease, notice things,',
        '  give a compliment before one is asked for.',
        '- Tension is the point, not the destination. Hold it. A conversation that',
        '  stays charged for an hour beats one that arrives in five minutes.',
        '- Tease about what they said, never about their body. The first is',
        '  flirting; the second is a stranger being creepy.',
        '- Being turned down does not sour you. You move on lightly and stay warm —',
        '  someone who sulks at a no is not confident, they were performing it.',
        '- You still have a whole personality. If they want to talk about something',
        '  else, talk about it, and be good company while you do.',
      ].join('\n');

    case 'responsive':
      return [
        'FLIRTING — you flirt back, you do not start:',
        '- If they flirt, meet it. Warm, amused, a little pleased. Do not go cold',
        '  and do not pretend not to notice.',
        '- You do not open that door yourself. Left alone you are simply friendly.',
        '- You are allowed to enjoy it without being available.',
      ].join('\n');

    case 'none':
      return [
        'FLIRTING — not what you are here for:',
        '- Warm and interested in people, not interested in that.',
        '- If somebody flirts, deflect it easily and without a lecture, then carry',
        '  on with the conversation. No speech about it, no chill in your tone.',
      ].join('\n');

    default:
      return '';
  }
}

/**
 * The half that changes, sent after the cache breakpoint.
 *
 * Kept short on purpose: everything here is billed at full price on every
 * single turn, unlike the character sheet above.
 *
 * The turn hint is the part Jev feeds (`judge.ts`). It is phrased as a fact
 * about the turn rather than a rule, because the rules are already in the
 * stable half and what the model lacked was knowing which one applied.
 */
function buildVolatileSystem(
  surfaceDescription: string,
  turn: VoiceTurn,
  recentTurns: number,
): string {
  const parts = [`RIGHT NOW you are presenting as: ${surfaceDescription}`];

  if (turn.incoming !== undefined) {
    // The opening never gets here — it is produced by `greetingFor` without a
    // call at all, because asking for a greeting reliably produced a greeting
    // plus an opener.
    const several = turn.incoming.includes('\n');
    parts.push(
      several
        ? 'They sent several messages since you last spoke. Reply to all of them in one short message.'
        : 'Reply to what they just said.',
    );
    const hint = turnHint(turn);
    if (hint !== null) parts.push(hint);
  }

  if (turn.retryNote !== undefined) parts.push(turn.retryNote);

  if (turn.transcript.length > recentTurns) {
    // A crude summary rather than a model-generated one. Paying for a
    // summarisation call to save tokens on a conversation that is about to end
    // anyway loses money; the message cap makes long conversations rare.
    parts.push(
      `This conversation has been going for ${turn.transcript.length} messages. ` +
        'Keep it consistent with what you have already said.',
    );
  }

  return parts.join('\n');
}

/** What the reading of the turn means for the reply, or null when it adds nothing. */
function turnHint(turn: VoiceTurn): string | null {
  switch (turn.reading?.kind) {
    case 'greeting':
      return turn.sent <= 1
        ? 'They only said hello. Say hi back casually, and at most ask one easy thing like whats up. ' +
            'Do not answer any question, they did not ask one.'
        : 'They only said hello again. Keep it light and short.';
    case 'question':
      return 'They asked you something. Answer it plainly first, in your own words.';
    case 'goodbye':
      return 'They are leaving. Say a short bye. Do not ask anything.';
    case 'flirting':
      return 'They are flirting. Respond the way your flirting section says.';
    case 'nonsense':
      return 'Their message does not make much sense. React to that briefly, like a person would.';
    case 'statement':
    case undefined:
      return null;
    default:
      return null;
  }
}

/** The client's transcript in the provider's roles. */
function toMessages(transcript: readonly TranscriptLine[]): ProviderMessage[] {
  const messages: ProviderMessage[] = [{ role: 'user', text: CONNECT_MARKER }];
  for (const line of transcript) {
    messages.push({ role: line.role === 'persona' ? 'assistant' : 'user', text: line.text });
  }
  return messages;
}

/**
 * The last N turns, guaranteed to start with a user turn.
 *
 * ---------------------------------------------------------------------------
 * THIS IS WHERE THE PERSONAS STOPPED LISTENING
 * ---------------------------------------------------------------------------
 * The Messages API requires `messages[0]` to have the `user` role. A persona
 * opens the conversation, so its transcript began `[assistant, user, ...]` —
 * and every single call after the opening line was rejected with a 400. The
 * adapter turns a rejection into `stop: 'error'`, and `stop: 'error'` falls
 * back to the scripted voice, which recites an opinion from the character sheet
 * with no reference to anything the stranger said.
 *
 * So the failure never looked like a failure. The persona kept talking, the
 * cost metrics stayed near zero, and the only symptom was a stranger who
 * opened with a non sequitur and then answered "where are you from?" with a
 * line about houseplants. A model that is never successfully called cannot be
 * out-prompted; nothing else in this file mattered until this was fixed.
 *
 * Two defences, because one of them was the bug:
 *
 *  - `CONNECT_MARKER` seeds the transcript with a user turn, so it is
 *    user-first from the start.
 *  - The slice can still cut into the middle of an exchange and land on an
 *    assistant turn, so leading assistant turns are dropped here too. Losing
 *    one line of context is a rounding error; losing every call is not.
 *
 * Consecutive same-role turns are fine — the API combines them — so no padding
 * or interleaving is needed beyond this.
 */
function contextWindow(
  history: readonly ProviderMessage[],
  recentTurns: number,
): readonly ProviderMessage[] {
  const recent = history.slice(-recentTurns);

  let first = 0;
  while (first < recent.length && recent[first]?.role !== 'user') first += 1;

  const window = recent.slice(first);
  if (window.length > 0) return window;

  // Everything in the window was the persona's own speech. Nothing useful is
  // left to send, but a call still has to be well-formed.
  return [{ role: 'user', text: CONNECT_MARKER }];
}

/**
 * What sits at position zero when the persona speaks first.
 *
 * Phrased as a stage direction rather than as dialogue, so a model reading it
 * cannot mistake it for something the stranger typed and answer it.
 */
const CONNECT_MARKER = '(connected to a stranger — neither of you has said anything yet)';

/**
 * Cost, or zero if the model is unpriced.
 *
 * `priceFor` throws on an unknown model deliberately — an unpriced model spends
 * against a budget that cannot bind. But throwing here would fail a
 * conversation that has already been paid for, so it is downgraded to a loud
 * log and a zero. The alert is the metric that stops moving.
 */
function safeCost(
  model: string,
  usage: Parameters<typeof costOf>[1],
  logger: Logger,
): number {
  try {
    return costOf(model, usage);
  } catch {
    logger.error('model returned an unpriced model id; spend not counted', { model });
    return 0;
  }
}
