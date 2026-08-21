/**
 * The M group: what users do about the A group.
 *
 * ---------------------------------------------------------------------------
 * THESE ARE THE ONLY LIVE ENFORCEMENT SIGNAL THIS PRODUCT HAS
 * ---------------------------------------------------------------------------
 * No detector compares a message to what the same sender said in another
 * conversation, so for a serial spammer the entire live response is: somebody
 * reports them, or somebody blocks them. Both are *one user's* action with
 * *one user's* effect — a block protects the blocker and nobody else.
 *
 * That makes this group a measurement instrument as much as a workload. The
 * numbers it produces are how long it took a spammer to accumulate its first
 * block, how many strangers it reached in the meantime, and how many it reached
 * afterwards. Those three numbers are the honest answer to "can we identify
 * them", and the spam oracle computes all three from what these bots do here.
 *
 * ---------------------------------------------------------------------------
 * BLOCKS ARE RARE, AND THAT IS ENFORCED
 * ---------------------------------------------------------------------------
 * `block` refills at 0.00556/s with a burst of 3 — twenty per hour. A persona
 * that blocks freely gets three blocks and then spends the run being refused,
 * so anything here that blocks in bulk (M4, and A13 in the other file) does it
 * deliberately and past the local mirror, and everything else spends its three
 * carefully.
 */
import type { Persona } from '../bot';
import { greet, line, looksAbusive, readTimeMs, reply, requeue, speak } from './support';

/**
 * M1 — reports, then keeps talking.
 *
 * `report` deliberately does not end the match (`DESIGN.md` §5): a user may
 * report and carry on. This persona is the proof that they can — and that
 * `report_ack` carries no verdict, no enforcement detail and nothing about the
 * reported user, which is what stops reporting becoming a probe for another
 * user's state.
 */
export const reporter: Persona = {
  scenario: 'M1',
  label: 'reporter',
  labels: ['benign', 'reports'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    const chars = [...payload.text].length;

    if (looksAbusive(bot, payload.text) && !bot.flag(`reported:${bot.matchId ?? ''}`)) {
      bot.setFlag(`reported:${bot.matchId ?? ''}`);
      // A short pause first: a report is a decision, not a reflex, and firing
      // it in the same millisecond as the message arrives would make every
      // report in the run race its own conversation's teardown.
      bot.after(bot.rng.int(800, 3_000), () => {
        if (bot.state !== 'MATCHED') return;
        bot.report(bot.rng.chance(0.5) ? 'harassment' : 'spam');
      });
      // Deliberately keeps talking afterwards.
      reply(bot, chars, 'replies.txt');
      return;
    }

    if (bot.turnsSent >= bot.matchMemo('turns', () => bot.rng.int(4, 12))) {
      bot.after(readTimeMs(bot, chars), () => {
        if (bot.state === 'MATCHED') bot.leaveChat();
        requeue(bot, 1_000, 5_000);
      });
      return;
    }
    reply(bot, chars, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * M2 — blocks on the first bad message and leaves.
 *
 * The critical assertion is on the *other* side: the blocked party receives
 * `partner_skipped`, exactly as for an ordinary skip (security §32). Being told
 * you were blocked is a signal a harasser can use to find out which of their
 * targets pushed back.
 */
export const blocker: Persona = {
  scenario: 'M2',
  label: 'blocker',
  labels: ['benign', 'blocks'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    if (looksAbusive(bot, payload.text)) {
      bot.after(bot.rng.int(500, 2_500), () => {
        if (bot.state !== 'MATCHED') return;
        bot.block();
        // A block lands in IDLE rather than back in the queue (§5): a user who
        // says stop is not asking for the next stranger. The pause before
        // re-queueing is what that decision looks like from outside.
        requeue(bot, 5_000, 20_000);
      });
      return;
    }
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * M3 — grudge holder.
 *
 * Blocks the first partner that misbehaves, then stays in the population for
 * the rest of the run. This bot cannot target anyone deliberately — it is never
 * told who its partner is, which is the design — so the assertion is made
 * afterwards from the ledger: the blocker and the blocked never share another
 * `matchId`, across reconnects on either side.
 *
 * That is D18 in one sentence. Blocks key on salted hashes of address and
 * client token, both dimensions, both directions, so a new session id changes
 * nothing.
 */
export const grudgeHolder: Persona = {
  scenario: 'M3',
  label: 'grudge-holder',
  labels: ['benign', 'blocks', 'grudge'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    if (looksAbusive(bot, payload.text) && !bot.flag('hasBlocked')) {
      bot.setFlag('hasBlocked');
      bot.after(bot.rng.int(400, 1_500), () => {
        if (bot.state === 'MATCHED') bot.block();
        requeue(bot, 1_000, 4_000);
      });
      return;
    }
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 3_000);
  },
};

/**
 * M4 — mass blocker.
 *
 * Blocks every partner until the limiter refuses, then keeps searching. Two
 * questions, and the second matters more:
 *
 *   1. Can a user shrink their own matchable pool to nothing? They can, and
 *      `tryMatch`'s `blockedSkipped` counter is where it shows.
 *   2. Does one user doing that cost *anyone else* anything? It must not.
 *      Blocked candidates are skipped, never removed from the queue — they stay
 *      matchable for everybody else — so other bots' match latency must be flat
 *      while this one's climbs.
 */
export const massBlocker: Persona = {
  scenario: 'M4',
  label: 'mass-blocker',
  labels: ['benign', 'blocks', 'pool-shrinking'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(bot.rng.int(500, 2_000), () => {
      if (bot.state !== 'MATCHED') return;
      // Past the mirror on purpose: finding the limiter is the scenario.
      bot.block({ force: true });
      requeue(bot, 500, 2_500);
    });
  },

  onError(bot, code) {
    if (code === 'RATE_LIMITED' && bot.state === 'MATCHED') {
      // Refused by the block bucket. Leave instead, so the bot keeps moving
      // through partners rather than sitting in a match it does not want.
      bot.after(bot.rng.int(300, 1_200), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    }
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 2_000);
  },
};

/**
 * M5 — report race.
 *
 * Files a report and ends the match in the same tick, so the report lands while
 * the conversation is being torn down. `blockPartner` resolves the partner and
 * records the block inside one Lua script for exactly this reason (§10.16);
 * `report` resolves its route the same way and has the same exposure.
 *
 * The requirement is binary: the report is stored against the conversation it
 * was filed in, or it is refused cleanly. Never stored against the wrong one,
 * never accepted and then lost.
 */
export const reportRacer: Persona = {
  scenario: 'M5',
  label: 'report-racer',
  labels: ['benign', 'reports', 'race'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    speak(bot, line(bot, 'openers.txt'), bot.rng.int(200, 900));
  },

  onPartnerMessage(bot) {
    if (bot.flag(`raced:${bot.matchId ?? ''}`)) return;
    bot.setFlag(`raced:${bot.matchId ?? ''}`);
    // Same tick, deliberately: report first, teardown immediately after, with
    // no await between them.
    bot.report('other');
    bot.skip();
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 2_000);
  },
};

/**
 * M6 — block race.
 *
 * Blocks the instant the match forms, before either side has said anything, so
 * the block races the match notification itself. The other half of the race —
 * the blocked party reconnecting underneath it — comes from the L personas
 * already in the population rather than from coordination here, because a bot
 * cannot know who its partner is.
 *
 * What must hold: the blocked party's *new* session cannot match this bot
 * again. A session id is per-connection, and a block keyed on session id would
 * expire the moment the blocked user reconnected — which is precisely why it is
 * not keyed that way (D18).
 */
export const blockRacer: Persona = {
  scenario: 'M6',
  label: 'block-racer',
  labels: ['benign', 'blocks', 'race'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    // No delay at all. Everything else in the harness waits for something.
    bot.block({ force: true });
    requeue(bot, 400, 2_000);
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 1_500);
  },
};

/**
 * M7 — mutual blocker.
 *
 * Blocks every partner after one exchange. When two of these meet, both sides
 * block the same match, which is the scenario: a block is stored in one
 * direction only, and `isBlocked` checks both directions, so one record already
 * suffices. Two must not double-count, error, or resurrect the pair.
 */
export const mutualBlocker: Persona = {
  scenario: 'M7',
  label: 'mutual-blocker',
  labels: ['benign', 'blocks'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    speak(bot, line(bot, 'openers.txt'), bot.rng.int(200, 1_200));
  },

  onPartnerMessage(bot) {
    if (bot.flag(`blocked:${bot.matchId ?? ''}`)) return;
    bot.setFlag(`blocked:${bot.matchId ?? ''}`);
    bot.after(bot.rng.int(100, 500), () => {
      if (bot.state === 'MATCHED') bot.block({ force: true });
      requeue(bot, 500, 2_500);
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 2_000);
  },
};

/**
 * M8 — reports, then disappears.
 *
 * The report must outlive the session that filed it and keep pointing at the
 * original conversation. A report is evidence about a conversation, not a
 * property of a connection, and the reporter closing their laptop cannot be
 * what decides whether it survives.
 */
export const reporterReconnect: Persona = {
  scenario: 'M8',
  label: 'reporter-reconnect',
  labels: ['benign', 'reports'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot) {
    if (bot.flag(`filed:${bot.matchId ?? ''}`)) return;
    bot.setFlag(`filed:${bot.matchId ?? ''}`);
    bot.report('spam');
    // Gone immediately afterwards, without a close frame: the harshest version
    // of "the reporter is no longer around".
    bot.after(bot.rng.int(50, 400), () => bot.reconnect(bot.rng.int(1_000, 5_000)));
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/**
 * M9 — repeated reporter.
 *
 * Files three reports against the same partner in the same conversation.
 *
 * The protocol is explicit that `report` is **not** idempotent — "each frame
 * files a report" — so this tests documented behaviour rather than an assumed
 * one. The run states the resulting count rather than asserting a number: how
 * many duplicate reports one user may file about one conversation is a product
 * decision, and this is the scenario that makes the current answer visible.
 */
export const repeatedReporter: Persona = {
  scenario: 'M9',
  label: 'repeated-reporter',
  labels: ['benign', 'reports'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot) {
    if (bot.flag(`spammed:${bot.matchId ?? ''}`)) return;
    bot.setFlag(`spammed:${bot.matchId ?? ''}`);
    for (let i = 0; i < 3; i += 1) {
      bot.after(i * 400, () => {
        if (bot.state === 'MATCHED') bot.report('other', undefined, { force: true });
      });
    }
    bot.after(4_000, () => {
      if (bot.state === 'MATCHED') bot.skip();
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/**
 * M10 — blocks the partner who has already left (D38).
 *
 * The case that used to record nothing at all. Someone says something vile and
 * skips; the person on the other end reaches for Block and the server answers
 * `NOT_MATCHED`, because the match is gone. The user has done what the product
 * told them to do and the system has kept no trace of it.
 *
 * `chat:last_partner:{sid}` now holds the departed partner's hashes for
 * `BLOCK_LATE_WINDOW_SECONDS`, so the block lands. What this persona checks
 * from outside is the shape of that landing:
 *
 *   * it is **confirmed**, not refused — `queue_status` in IDLE, same as a live
 *     block, so the ledger's durability check counts it;
 *   * it ends nothing and notifies nobody. There is no partner to tell, and a
 *     `partner_skipped` for a match that ended minutes ago would reach whoever
 *     holds that session id now;
 *   * the record is **spent**. A second block inside the same window must not
 *     land again — otherwise one departure would let a bot burn its whole
 *     hourly budget on the same person.
 *
 * The second attempt is what makes the last point observable, and it is why
 * this persona blocks twice on purpose.
 */
export const lateBlocker: Persona = {
  scenario: 'M10',
  label: 'late-blocker',
  labels: ['benign', 'blocks'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    // The partner is already gone — that is the whole scenario. A short pause
    // first, because this is a person reacting to a conversation ending, not a
    // client racing the teardown; M6 owns the race.
    bot.after(bot.rng.int(1_200, 4_000), () => {
      if (bot.state === 'MATCHED') return;
      bot.block();
      // Again, into the window that has now been spent. The expected answer is
      // a refusal, and a refusal here is the correct behaviour rather than a
      // fault — the ledger records which one arrived.
      bot.after(bot.rng.int(800, 2_000), () => bot.block({ force: true }));
      // Blocking does not advance to the next stranger (D39), so the re-queue
      // is deliberate and unhurried, exactly as it is for M2.
      requeue(bot, 4_000, 15_000);
    });
  },
};
