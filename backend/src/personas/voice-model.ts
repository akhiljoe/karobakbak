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
import type { PersonaCharacter } from './types';

/**
 * How many turns of the conversation are sent.
 *
 * Bounded because this is the part of the prompt that grows, and it is the
 * cheapest place to trim: it sits after the cache breakpoint, so every token
 * here is billed at full price on every turn. The character sheet before the
 * breakpoint is the expensive-looking half and is nearly free after the first
 * call.
 */
const RECENT_TURNS = 10;

/** A ceiling on the reply, so one runaway generation cannot cost a day's budget. */
const MAX_OUTPUT_TOKENS = 300;

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
      }

      const check = await options.budget.check();
      if (check.state !== 'ok') {
        // Exhausted or unreadable. Both fall back rather than going quiet; an
        // unreadable budget means we do not know what has been spent, and
        // spending more to find out is the wrong direction.
        return options.fallback.reply(turn);
      }

      const messages = contextWindow(history, turn);
      const reply = await options.provider.complete({
        stableSystem,
        volatileSystem: buildVolatileSystem(options.surfaceDescription, history),
        messages,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
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
    'HOW YOU TYPE:',
    `- Message length: ${c.style.responseLength}`,
    `- You ask questions: ${c.style.questionRate}`,
    `- Emoji: ${c.style.emojiUse}`,
    `- Capitalisation: ${c.style.capitalisation}`,
    ...c.style.habits.map((h) => `- ${h}`),
    '',
    'RULES:',
    '- One message at a time. Short. This is a chat, not an essay.',
    '- Do not end every message with a question. Real conversations are not interviews.',
    '- Disagree sometimes. Agreeing with everything is the clearest sign of a bot.',
    '- Never dump your biography. Details come out when they fit.',
    '- Never claim to be human, and never say you are a real person. If somebody',
    '  asks whether you are a bot, change the subject rather than answering it.',
    '- Never ask for a real name, photo, contact details, or to move the chat elsewhere.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

/**
 * The half that changes, sent after the cache breakpoint.
 *
 * Kept short on purpose: everything here is billed at full price on every
 * single turn, unlike the character sheet above.
 */
function buildVolatileSystem(surfaceDescription: string, history: readonly ProviderMessage[]): string {
  const parts = [`RIGHT NOW you are presenting as: ${surfaceDescription}`];

  if (history.length > RECENT_TURNS) {
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

/** The last N turns, plus the opening instruction when there is no history. */
function contextWindow(
  history: readonly ProviderMessage[],
  turn: VoiceTurn,
): readonly ProviderMessage[] {
  const recent = history.slice(-RECENT_TURNS);
  if (recent.length > 0) return recent;

  // Opening the conversation. The API needs a user turn to answer, and this one
  // is an instruction rather than something the stranger said.
  return [
    {
      role: 'user',
      text:
        `You have just been connected to a stranger. Say the first thing, in your own voice. ` +
        `One short message. For flavour, something you might open with: "${
          turn.character.starters[0] ?? 'hey'
        }" — but say it your way, not word for word.`,
    },
  ];
}

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
