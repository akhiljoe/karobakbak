/**
 * Shared behaviour for personas that hold a conversation.
 *
 * ---------------------------------------------------------------------------
 * WHY THINK TIME IS MODELLED AND NOT JUST RANDOMISED
 * ---------------------------------------------------------------------------
 * A bot that replies instantly produces a load shape no real population
 * produces: every message arrives in a burst right after the partner's, so the
 * server sees synchronised spikes and the latency numbers describe a machine
 * talking to itself.
 *
 * People read, then think, then type, and each of those scales with the length
 * of what they are answering. The model here is crude — reading at roughly
 * 25 characters per second, typing at roughly 6 — but crude and shaped beats
 * precise and flat, because it spreads sends across the interval the way real
 * traffic does.
 *
 * The typing indicator is sent around the typing phase specifically, rather
 * than fired per simulated keystroke: per-keystroke would trip the 4/s typing
 * bucket, which is exactly the mistake a naive client makes and not the one
 * this harness is here to make.
 */
import { moderationView } from '../../../../backend/src/moderation/normalise';
import { RULES } from '../../../../backend/src/moderation/rules';
import type { Bot } from '../bot';
import type { CorpusFile } from '../corpus';

/** Milliseconds to read `chars` characters and decide to answer. */
export function readTimeMs(bot: Bot, chars: number): number {
  return Math.round(bot.rng.float(250, 900) + (chars / 25) * 1000);
}

/** Milliseconds to type `chars` characters. */
export function typeTimeMs(bot: Bot, chars: number): number {
  return Math.round(bot.rng.float(200, 600) + (chars / 6) * 1000);
}

/** One line, drawn from this bot's own stream. */
export function line(bot: Bot, file: CorpusFile): string {
  return bot.rng.pickOne(bot.corpus.lines(file));
}

/**
 * Say something the way a person does: show typing, pause for as long as it
 * would take to type it, send, stop typing.
 *
 * Returns the timer so a persona can cancel it — a partner who skips while
 * this bot is "typing" must not produce a send into a match that has ended.
 */
export function speak(bot: Bot, text: string, extraDelayMs = 0): void {
  const delay = extraDelayMs + typeTimeMs(bot, text.length);
  // Long messages get an indicator; a three-character "ok" does not, because
  // nobody sees an indicator that lasts 400 ms and it wastes a token.
  if (delay > 900) bot.typing(true);
  bot.after(delay, () => {
    if (bot.state !== 'MATCHED') return;
    if (delay > 900) bot.typing(false);
    bot.say(text);
  });
}

/** Answer whatever just arrived, after a plausible pause. */
export function reply(bot: Bot, incomingChars: number, file: CorpusFile): void {
  const text = line(bot, file);
  speak(bot, text, readTimeMs(bot, incomingChars));
}

/**
 * Open a conversation.
 *
 * Both sides usually greet at once, which is what real strangers do and what
 * produces the simultaneous-send pressure R8 is about. A small random delay
 * keeps it from being a synchronised thundering greet across the whole swarm.
 */
export function greet(bot: Bot): void {
  speak(bot, line(bot, 'openers.txt'), bot.rng.int(200, 2_500));
}

/**
 * Re-enter the queue after a conversation ended, pacing for the join bucket.
 *
 * A persona that calls `joinQueue` the instant a match ends will be refused by
 * the local mirror and stall silently. Asking the bot how long to wait keeps
 * the population moving and keeps `RATE_LIMITED` meaning something.
 */
export function requeue(bot: Bot, minPauseMs = 400, maxPauseMs = 2_500): void {
  const pause = Math.max(bot.waitFor('join_queue'), bot.rng.int(minPauseMs, maxPauseMs));
  bot.after(pause, () => {
    if (bot.state === 'IDLE') bot.joinQueue();
  });
}

/**
 * Would a reasonable person report this?
 *
 * The M personas need a trigger, and a bot cannot judge tone. Two stand-ins are
 * used, and both are deliberate approximations rather than pretending to be
 * comprehension:
 *
 *   1. **The line is in the hostile or spam corpus.** This is knowledge a real
 *      user does not have, and it is a cheat — but a faithful one: it fires
 *      exactly when a human would have a reason to report, and it fires for no
 *      other traffic, which is what keeps the report signal clean enough to
 *      measure. A fuzzier trigger would mostly measure its own false positives.
 *   2. **The message fires a moderation rule.** A link or a phone number from a
 *      stranger is a reason people actually report, and this half needs no
 *      inside knowledge at all — the client could compute it.
 *
 * The consequence worth stating: reports in this run are *better targeted than
 * real ones would be*. Any conclusion of the form "reports caught the spammer
 * in N conversations" is therefore an optimistic bound, and the report says so.
 */
export function looksAbusive(bot: Bot, text: string): boolean {
  const view = moderationView(text);
  if (RULES.some((rule) => rule.test(view, { detectContact: true, denyList: [] }))) return true;
  return abusiveViews(bot.corpus).has(view);
}

/**
 * The abusive corpora as the moderation view sees them, built once per corpus.
 *
 * Comparing normalised views rather than raw strings matters for A2 and A11: a
 * campaign line with digits swapped for letters is not string-equal to anything
 * in `spam.txt`, so a raw comparison would mean the reporters never react to
 * the mutating spammer — and the run would then conclude that mutation defeats
 * the *human* signal as well as the automated one. It does not. People read
 * straight through leetspeak, and this is the closest cheap approximation of
 * that. It also happens to be exactly what the offline detector does, which
 * keeps the two halves of the measurement consistent.
 */
const VIEW_CACHE = new WeakMap<object, Set<string>>();

function abusiveViews(corpus: Bot['corpus']): Set<string> {
  const cached = VIEW_CACHE.get(corpus);
  if (cached) return cached;

  const views = new Set<string>();
  for (const file of ['hostile.txt', 'spam.txt', 'denylist.txt'] as const) {
    for (const entry of corpus.lines(file)) views.add(moderationView(entry));
  }
  VIEW_CACHE.set(corpus, views);
  return views;
}
