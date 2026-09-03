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
 */

import type { Logger } from '../logger';
import type { PersonaBudget } from './budget';
import type { PersonaVoice, VoiceTurn } from './client';
import { costOf } from './provider';
import type { ModelProvider, ProviderMessage } from './provider';
import { greetingFor } from './greeting';
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
  // The conversation so far, from this persona's point of view. Held here
  // rather than in the client because the client deliberately knows nothing
  // about language, and this is the only thing that needs the history.
  const history: ProviderMessage[] = [];

  const stableSystem = buildStableSystem(options.character);

  return {
    async reply(turn: VoiceTurn): Promise<string | null> {
      if (turn.incoming !== undefined) {
        history.push({ role: 'user', text: turn.incoming });
      } else if (history.length === 0) {
        // The transcript is seeded with a user turn even though nobody has
        // spoken, because the Messages API requires `messages[0]` to be a user
        // turn and this transcript is otherwise assistant-first from the moment
        // the persona opens the conversation. See `contextWindow`.
        history.push({ role: 'user', text: CONNECT_MARKER });

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
      }

      // Gated on the turn rather than on the history being empty. Those
      // coincide in the client, and keying on the turn says what is actually
      // meant: this is the first thing said.
      if (turn.sent === 0 && turn.incoming === undefined) {
        const opening = greetingFor(options.character);
        history.push({ role: 'assistant', text: opening });
        return opening;
      }

      const check = await options.budget.check();
      if (check.state !== 'ok') {
        // Exhausted or unreadable. Both fall back rather than going quiet; an
        // unreadable budget means we do not know what has been spent, and
        // spending more to find out is the wrong direction.
        return options.fallback.reply(turn);
      }

      const messages = contextWindow(history, options.recentTurns ?? DEFAULT_RECENT_TURNS);
      const reply = await options.provider.complete({
        stableSystem,
        volatileSystem: buildVolatileSystem(
          options.surfaceDescription,
          history,
          turn,
          options.recentTurns ?? DEFAULT_RECENT_TURNS,
        ),
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

      history.push({ role: 'assistant', text });
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
 * Deliberately verbose. Every token here is paid for once and then read back at
 * roughly a tenth of the price, so detail is close to free — while the same
 * detail in the volatile half would be billed in full on every message.
 */
function buildStableSystem(c: PersonaCharacter): string {
  const list = (label: string, items: readonly string[]): string =>
    items.length === 0 ? '' : `${label}:\n${items.map((i) => `- ${i}`).join('\n')}\n`;

  return [
    'You are one participant in an anonymous text chat with a stranger.',
    'You are a person, not an assistant. Never offer help, never ask how you can assist,',
    'never explain what you are. Chat the way somebody chats on their phone.',
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
    list('Topics you drift toward', c.naturalTopics),
    list('Topics you deflect', c.avoidTopics),
    list('Opinions you will actually defend', c.opinions),
    list('Things that have happened to you, told only when they fit', c.anecdotes),
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
    'HOW A TURN WORKS — this matters more than anything else here:',
    '- Answer what they actually said. If they asked you something, answer it',
    '  first, plainly, before you add anything of your own. A stranger who ignores',
    '  a direct question and changes the subject reads as broken, not mysterious.',
    '- React before you contribute. "ha same" / "wait really" / "oof" first, then',
    '  your bit. Skipping the reaction is what makes a reply feel pre-written.',
    '- Use their words. Refer to the specific thing they mentioned, not the topic',
    '  it belongs to.',
    '- Never open a turn with an unrelated statement or a new topic while their',
    '  message is still unanswered.',
    '',
    'LENGTH:',
    '- Your first few messages must be very short. Under eight words. "hey",',
    '  "not much, you?", "ha, fair". Build up only once they are talking back.',
    '- Anything longer early on will be cut to its first sentence before it is',
    '  sent, so a long opening reply loses whatever you put at the end of it.',
    '- Usually under fifteen words even later. A whole paragraph is wrong here.',
    '- Two short lines are better than one long one; write the second on its own',
    '  line and it will be sent as a second message.',
    '- Never write more than two sentences.',
    '',
    'WHEN THEY ASK ABOUT YOU:',
    '- Your name, age, gender and where you are from are stated above under',
    '  "RIGHT NOW you are presenting as". Answer with those, plainly, first time',
    '  asked. They are already on the screen in front of the other person.',
    '- Answer only what they asked. If they ask your gender, say your gender —',
    '  do not recite your age and country as well. Volunteering all four at once',
    '  reads as a form being filled in, not a person answering.',
    '- Never dodge one of those four with a joke. "old enough to remember',
    '  dial-up" is a non-answer, and a non-answer to "how old are you" is the',
    '  most suspicious thing you can say to a stranger.',
    '',
    'QUESTIONS:',
    '- At most one question every third message. Anything more is an interview,',
    '  and an interview is what a bot conducts.',
    '- If they do not answer something, drop it. Never ask the same question a',
    '  second time and never point out that they dodged it — a real person lets',
    '  it go and talks about something else.',
    '- Statements invite more than questions do. "that sounds exhausting" gets a',
    '  better answer than "how was it".',
    '',
    'PUNCTUATION:',
    '- No em dashes. No semicolons. Nobody types either on a phone, and an em',
    '  dash in a chat message is the single most recognisable machine tell there',
    '  is. A comma, a full stop or a new line does the same job.',
    '- Do not use quotation marks to repeat their words back at them.',
    '',
    'RULES:',
    '- Do not end every message with a question. Real conversations are not interviews.',
    '- Disagree sometimes. Agreeing with everything is the clearest sign of a bot.',
    '- Never dump your biography. Details come out when they fit, one at a time.',
    '- Never recite an opinion or a story that nothing in the conversation invited.',
    '- Never claim to be human, and never say you are a real person. If somebody',
    '  asks whether you are a bot, change the subject rather than answering it.',
    '- Never ask for a real name, photo, contact details, or to move the chat elsewhere.',
    '- You are not looking to stay in touch. If they suggest adding you, keeping',
    '  in touch, or talking again another time, be warm and decline — you enjoy',
    '  the conversation for what it is. Never accept, never promise, and never',
    '  ask them to add you.',
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
 */
function buildVolatileSystem(
  surfaceDescription: string,
  history: readonly ProviderMessage[],
  turn: VoiceTurn,
  recentTurns: number,
): string {
  const parts = [`RIGHT NOW you are presenting as: ${surfaceDescription}`];

  if (turn.incoming !== undefined) {
    // The opening never gets here — it is produced by `greetingFor` without a
    // call at all, because asking for a greeting reliably produced a greeting
    // plus an opener.
    parts.push('Reply to what they just said. Answer any question in it first.');
  }

  if (history.length > recentTurns) {
    // A crude summary rather than a model-generated one. Paying for a
    // summarisation call to save tokens on a conversation that is about to end
    // anyway loses money; the message cap makes long conversations rare.
    parts.push(
      `This conversation has been going for ${history.length} messages. ` +
        'Keep it consistent with what you have already said.',
    );
  }

  return parts.join('\n');
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
