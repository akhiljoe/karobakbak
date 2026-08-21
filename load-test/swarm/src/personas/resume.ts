/**
 * The L personas that reclaim a session (§28, D42).
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED UNDER THEM
 * ---------------------------------------------------------------------------
 * A dropped socket used to end the conversation. It no longer does: the session
 * is marked detached, the seat is held for `RESUME_GRACE_SECONDS`, the partner
 * is told `partner_reconnecting` rather than `partner_disconnected`, and a
 * browser that comes back with a valid token lands in the same conversation
 * with the transcript intact.
 *
 * That is one behaviour with four ways to be wrong, and each of these personas
 * is one of them:
 *
 *   L3   the window is honoured — a quick drop and return keeps the conversation
 *   L13  the *partner's* half — being held, then released, then told
 *   L14  the window has closed — a stale token must open a fresh session, never
 *        an error, and never somebody else's conversation
 *   L15  the token is a bearer credential — one that has already been redeemed
 *        must buy nothing, because rotation is the whole defence
 *
 * ---------------------------------------------------------------------------
 * THE ONE THING TO GET RIGHT WHEN EDITING THESE
 * ---------------------------------------------------------------------------
 * `reconnect(ms, mode, { resume: true })` is a *page refresh*; `reconnect(ms)`
 * with no options is a *new tab*, because the token lives in `sessionStorage`
 * and dies with the tab. A persona that resumes when it meant to start fresh
 * still passes every oracle and quietly stops testing what it was written for.
 */
import type { Persona } from '../bot';
import { greet, reply, requeue, resumeTalking } from './support';

/**
 * L3 — the refresh.
 *
 * Drops mid-conversation and comes back inside the grace window with its token.
 * The conversation must still be there: `connected.resumed` carries the match,
 * the partner was told `partner_returned`, and both sides carry on with the
 * same `matchId` — which is what makes the pair oracle's prefix comparison span
 * the gap instead of ending at it.
 *
 * The drop is *hard*. A clean close and a dropped connection take different
 * paths through `closeSession`, and it is the dropped one that people actually
 * produce.
 */
export const refresher: Persona = {
  scenario: 'L3',
  label: 'refresher',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    // Well inside the window: this persona is about the window working, not
    // about its edge. L14 owns the edge.
    bot.after(bot.rng.int(6_000, 20_000), () => {
      if (bot.state !== 'MATCHED' || !bot.canResume()) return;
      const away = Math.min(
        bot.rng.int(1_000, 6_000),
        Math.max(1_000, bot.resumeGraceSeconds * 1_000 - 4_000),
      );
      bot.reconnect(away, 'hard', { resume: true });
    });
  },

  onResumed(bot) {
    // Back, and the conversation is still here. Say something: a person who
    // watched a reconnect spinner does.
    resumeTalking(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerAway() {
    // Nothing to do but wait, which is the point. The composer is disabled on
    // the real client for exactly this reason (D43) and `speak` enforces it.
  },

  onPartnerBack(bot) {
    resumeTalking(bot);
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * L13 — talks through the partner's absence, and must not be heard.
 *
 * The other half of L3. This bot never drops; its partner does. What it is
 * really testing is the claim in D43: messages sent while a partner is away are
 * **not** buffered, because buffering them would mean writing message text to a
 * Redis key, which invariant I8 forbids.
 *
 * So it deliberately tries. Once per absence, ignoring `speak`'s guard, it
 * sends into the gap — and the oracle's job is to confirm the partner never
 * receives it while the conversation still survives. A run where that message
 * arrives after the partner returns is a buffering bug, and this is the only
 * thing in the harness that would notice.
 */
export const gapTalker: Persona = {
  scenario: 'L13',
  label: 'gap-talker',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerAway(bot) {
    // Once per absence and once per lifetime is not the same thing here: the
    // send is a perfectly ordinary message that costs one token from the
    // message bucket, so there is no strike risk and no reason to ration it
    // beyond not flooding the gap.
    bot.after(bot.rng.int(700, 2_500), () => {
      if (!bot.partnerAway || bot.state !== 'MATCHED') return;
      // `sayRegardless` bypasses the local bucket mirror only. The point is to
      // bypass `speak`'s away-guard, which every other persona wants.
      bot.sayRegardless(bot.rng.pickOne(bot.corpus.lines('questions.txt')));
    });
  },

  onPartnerBack(bot) {
    resumeTalking(bot);
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * L14 — comes back too late.
 *
 * Drops and waits out the grace window before presenting its token. The seat is
 * gone by then, so the resume must fail *softly*: a fresh session, a new id, no
 * error frame, no refused upgrade. A stale token is the single most common
 * thing a real client will present — every phone that was asleep for a minute —
 * and turning it into an error page would be the worst possible reading of it.
 *
 * The partner's side of this is the other half of the check: their conversation
 * must have been ended by the janitor when the window closed, not left hanging.
 */
export const lateReturner: Persona = {
  scenario: 'L14',
  label: 'late-returner',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    bot.after(bot.rng.int(5_000, 15_000), () => {
      if (bot.state !== 'MATCHED' || !bot.canResume()) return;
      // Past the window with margin, so a slow janitor pass cannot make this
      // accidentally succeed and turn the scenario into L3.
      bot.reconnect(bot.resumeGraceSeconds * 1_000 + bot.rng.int(4_000, 9_000), 'hard', {
        resume: true,
      });
    });
  },

  onResumed(bot) {
    // Possible if the grace window were reconfigured mid-run. Recorded by the
    // bot either way; behaving sanely beats asserting here, because the ledger
    // is where a scenario that stopped testing itself should be visible.
    resumeTalking(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * L15 — presents a token that has already been spent.
 *
 * A resume token is a bearer credential, and the defence is rotation: it is
 * replaced on every successful redemption, so a captured one works once and
 * only until its owner reconnects. That is a claim with exactly one way to
 * test it — keep the old value, let it be redeemed and rotated away, then offer
 * it again.
 *
 * The right answer is a *fresh session*: no error frame, no refused upgrade,
 * and above all not a seat in the conversation the live token now owns. A
 * replay that succeeded would mean a captured token is a permanent key to
 * somebody else's chat.
 *
 * Modelled as a sequence on one socket rather than two parallel ones. Every bot
 * in this harness is one socket, and a second would need its own connection
 * accounting to keep from reading as a leak to every oracle that counts
 * sessions — while testing the same refusal.
 */
export const tokenReplayer: Persona = {
  scenario: 'L15',
  label: 'token-replayer',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    if (bot.flag('replay-scheduled')) return;
    bot.after(bot.rng.int(8_000, 25_000), () => {
      if (bot.state !== 'MATCHED' || !bot.canResume()) return;
      bot.setFlag('replay-scheduled');
      // Capture, then redeem. The redemption rotates the credential, so what
      // was captured is dead from this moment.
      bot.stashResumeToken();
      bot.reconnect(bot.rng.int(800, 2_500), 'hard', { resume: true });
    });
  },

  onResumed(bot) {
    resumeTalking(bot);
    if (bot.flag('replayed') || !bot.hasStashedToken()) return;
    bot.setFlag('replayed');
    bot.after(bot.rng.int(2_000, 5_000), () => {
      // The spent token. A fresh session is the only acceptable outcome, and
      // the ledger records it as `resume_expired`.
      bot.reconnect(bot.rng.int(300, 1_500), 'hard', { resume: 'stashed' });
    });
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerAway() {
    // Waits, like everyone else.
  },

  onPartnerBack(bot) {
    resumeTalking(bot);
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};
