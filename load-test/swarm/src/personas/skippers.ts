/**
 * The S group: the matchmaking loop, which is the product's real hot path.
 *
 * ---------------------------------------------------------------------------
 * EVERY PERSONA HERE HAS TO RESPECT ONE NUMBER
 * ---------------------------------------------------------------------------
 * `skip` refills at 0.333 tokens per second with a burst of 6. A persona that
 * skips on impulse gets six skips and then spends three seconds per skip being
 * refused, and the run reports the token bucket instead of the product.
 *
 * So these personas ask the bot how long the mirror wants them to wait. That is
 * not cheating: a real user pressing a throttled button sees the UI's cooldown,
 * and this is the same behaviour. S2 exists specifically to *find* the limiter,
 * and it does so by measuring the wait rather than by hammering into it.
 */
import type { Persona } from '../bot';
import { greet, line, readTimeMs, reply, requeue, speak } from './support';

/** How long before this bot may skip again, with a little human slack. */
function skipDelay(bot: import('../bot').Bot, minMs: number, maxMs: number): number {
  return Math.max(bot.waitFor('skip'), bot.rng.int(minMs, maxMs));
}

/** S1 — two or three messages, then next stranger. The archetypal user. */
export const grazer: Persona = {
  scenario: 'S1',
  label: 'grazer',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    const chars = [...payload.text].length;
    const turns = bot.matchMemo('turns', () => bot.rng.int(2, 4));
    if (bot.turnsSent >= turns) {
      bot.after(skipDelay(bot, 500, 3_000), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
      return;
    }
    reply(bot, chars, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 2_000);
  },
};

/**
 * S2 — skips almost immediately unless the opener is what it is looking for.
 *
 * The "looking for" test is a keyword drawn from the corpus at construction
 * time. It matches rarely on purpose: the interesting behaviour is what the
 * product does for someone who rejects nineteen partners out of twenty, which
 * is a real user type and the one the skip limiter hurts most.
 */
export const hyperSkipper: Persona = {
  scenario: 'S2',
  label: 'hyper-skipper',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    // Decide up front whether this partner will do. Waiting for the opener
    // would make the decision depend on the partner's persona rather than on
    // this bot's pickiness, and half of them never speak first.
    const interested = bot.matchMemo('interested', () => (bot.rng.chance(0.08) ? 1 : 0));
    if (interested === 1) {
      greet(bot);
      return;
    }
    bot.after(skipDelay(bot, 1_000, 3_000), () => {
      if (bot.state === 'MATCHED') bot.skip();
    });
  },

  onPartnerMessage(bot, payload) {
    if (bot.matchMemo('interested', () => 0) === 0) return;
    reply(bot, [...payload.text].length, 'questions.txt');
  },

  onError(bot, code) {
    // The limiter caught it. Back off by exactly what the mirror says is left,
    // so the run records how long a picky user actually waits.
    if (code === 'RATE_LIMITED') {
      bot.after(bot.waitFor('skip') + bot.rng.int(200, 1_200), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    }
  },

  onPartnerGone(bot) {
    requeue(bot, 200, 1_500);
  },
};

/**
 * S4 — leaves rather than skipping, and means it.
 *
 * `leave_chat` exists so a user who wants to stop is not dropped into another
 * conversation. This persona proves the distinction survives contact with the
 * server: after leaving it must sit in IDLE until it decides otherwise, and a
 * `matched` frame arriving in that window is a failure.
 */
export const leaver: Persona = {
  scenario: 'S4',
  label: 'leaver',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    const turns = bot.matchMemo('turns', () => bot.rng.int(1, 5));
    if (bot.turnsSent >= turns) {
      speak(bot, line(bot, 'farewells.txt'), readTimeMs(bot, [...payload.text].length));
      bot.after(4_000, () => {
        if (bot.state === 'MATCHED') bot.leaveChat();
        // A long idle gap, which is the whole point: nothing may re-match this
        // bot while it is deliberately doing nothing.
        requeue(bot, 20_000, 60_000);
      });
      return;
    }
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 10_000, 30_000);
  },
};

/**
 * S5 — joins and leaves the queue repeatedly.
 *
 * A user opening the app, changing their mind, and changing it back. Trips the
 * join limiter quickly, which is expected; what must not happen is a queue
 * entry surviving a `leave_queue`, because the next scan would match somebody
 * to a session that is not searching.
 */
export const queueFlapper: Persona = {
  scenario: 'S5',
  label: 'queue-flapper',

  onConnected(bot) {
    const cycle = (): void => {
      if (bot.state === 'MATCHED') return;
      bot.joinQueue();
      bot.after(bot.rng.int(400, 2_500), () => {
        if (bot.state === 'SEARCHING') bot.leaveQueue();
        bot.after(bot.rng.int(1_000, 4_000), cycle);
      });
    };
    cycle();
  },

  onMatched(bot) {
    // Matched despite the flapping. Behave for a moment, then go back to it.
    greet(bot);
    bot.after(bot.rng.int(5_000, 15_000), () => {
      if (bot.state === 'MATCHED') bot.leaveChat();
    });
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 1_000, 4_000);
  },
};

/**
 * S7 — skip and rejoin in the same breath.
 *
 * `skip` already re-queues, so this persona additionally fires `join_queue`
 * immediately after, which is what a client with an over-eager retry does. The
 * server must treat the second join as idempotent rather than producing a
 * second queue entry, and no frame from the old match may arrive afterwards.
 */
export const instantRejoiner: Persona = {
  scenario: 'S7',
  label: 'instant-rejoiner',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(skipDelay(bot, 300, 1_500), () => {
      if (bot.state !== 'MATCHED') return;
      bot.skip();
      // Deliberately redundant: skip re-queues already. Rule 4 says a repeat
      // queue join must converge rather than duplicate.
      bot.joinQueue();
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 100, 800);
  },
};

/**
 * S6 — joins once and waits through several match cycles happening around it.
 *
 * The property is narrow and easy to break: a queue entry belonging to a live
 * searcher must not be **collateral damage of somebody else's garbage
 * collection**. `tryMatch` cleans stale entries out of every sample it draws,
 * and a cleanup that was slightly too eager would remove people who are simply
 * waiting — invisibly, because the symptom is somebody never being matched
 * rather than an error.
 *
 * So this bot does the least interesting thing in the catalogue: it joins, and
 * then does nothing at all until somebody matches it. Every other bot in the
 * run churns past it.
 */
export const queueSurvivor: Persona = {
  scenario: 'S6',
  label: 'queue-survivor',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    // Having finally been matched, it behaves and then goes back to waiting —
    // which is the same test again, from a queue that is now busier.
    bot.after(bot.rng.int(2_000, 6_000), () => {
      bot.leaveChat();
      bot.after(bot.rng.int(500, 2_000), () => bot.joinQueue());
    });
  },
};

/**
 * N9 — the late joiner.
 *
 * Arrives when the population is already matched up and paired off, which is
 * the worst moment to be looking: the queue is nearly empty, and the only
 * candidates are people mid-skip. The question is fairness — an arrival that
 * missed the rush must still be matched rather than starved behind a churning
 * population that keeps re-pairing with itself.
 *
 * The delay is deliberately longer than the ramp, so this bot is genuinely
 * late rather than merely last.
 */
export const lateJoiner: Persona = {
  scenario: 'N9',
  label: 'late-joiner',

  onConnected(bot) {
    bot.after(bot.rng.int(45_000, 90_000), () => bot.joinQueue());
  },

  onMatched(bot) {
    bot.after(bot.rng.int(3_000, 9_000), () => {
      bot.leaveChat();
      bot.after(bot.rng.int(20_000, 40_000), () => bot.joinQueue());
    });
  },
};
