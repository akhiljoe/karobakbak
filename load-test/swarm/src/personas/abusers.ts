/**
 * The A group: spam and abuse, with ground truth declared before the run.
 *
 * ---------------------------------------------------------------------------
 * TWO KINDS OF ADVERSARY, AND ONLY ONE OF THEM IS VISIBLE TODAY
 * ---------------------------------------------------------------------------
 * A3, A4, A5 and A7 are **payload** adversaries: what they say is detectable
 * inside a single message, which is exactly what `RULES` looks at. They will
 * flag, and the run can prove they flagged.
 *
 * A1, A2, A8, A9, A10 and A11 are **pattern** adversaries: every individual
 * message they send is unremarkable. "hey wanna see something cool" trips no
 * rule, exceeds no bucket and reads like an opener — the four hundredth
 * identical copy is the abuse, and nothing in the pipeline compares a message
 * to what the same sender said in a different conversation.
 *
 * That is a deliberate scope boundary, not an oversight. But it means these
 * bots exist to *measure the gap*, not to be caught: the oracle reports what an
 * offline query would have found, how long the live signals (reports, blocks)
 * took to accumulate, and how many more strangers the spammer reached in the
 * meantime.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE PERSONAS BYPASS THE LOCAL BUCKET MIRROR
 * ---------------------------------------------------------------------------
 * Every other persona asks the mirror before acting, so it is never throttled
 * by accident. These ones pass `{ force: true }` where the point *is* the
 * limit: A6 must exceed the message rate, A12 must exhaust the report bucket.
 * A `RATE_LIMITED` reply is then the measurement rather than a harness bug.
 */
import type { Bot, Persona } from '../bot';
import { greet, line, requeue, speak } from './support';

/** How long before this bot may skip again, with a little slack. */
function skipDelay(bot: Bot, minMs: number, maxMs: number): number {
  return Math.max(bot.waitFor('skip'), bot.rng.int(minMs, maxMs));
}

/**
 * The campaign line for one bot: chosen once from its own stream, then never
 * again. A campaign is a fixed string by definition — a spammer that picks a
 * new line per conversation is A11, not A1.
 */
function campaign(bot: Bot): string {
  const lines = bot.corpus.lines('spam.txt');
  const index = bot.spec.index % lines.length;
  return lines[index] ?? lines[0] ?? 'hey';
}

/**
 * A1 — copy-paste spammer.
 *
 * One line, every match, then straight out. The archetype, and the one the
 * offline detection query must find or admit it cannot.
 */
export const copyPasteSpammer: Persona = {
  scenario: 'A1',
  label: 'copy-paste-spammer',
  labels: ['spammer', 'campaign-exact'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(bot.rng.int(300, 1_200), () => {
      if (bot.state !== 'MATCHED') return;
      bot.say(campaign(bot));
      // Gone before the partner can answer. Reach is the whole strategy: the
      // limiter on `skip` is what actually bounds this bot, not moderation.
      bot.after(skipDelay(bot, 400, 1_500), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onError(bot, code) {
    if (code === 'RATE_LIMITED') {
      bot.after(bot.waitFor('skip') + bot.rng.int(100, 600), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    }
  },

  onPartnerGone(bot) {
    requeue(bot, 200, 1_200);
  },
};

/**
 * Mutate a campaign line the way an evader does: character substitutions,
 * spacing, and a zero-width character.
 *
 * Deliberately the cheap tricks rather than clever ones. `moderationView`
 * exists to fold exactly these away, so this persona measures whether it does —
 * and every mutation must leave the line readable, because a spammer whose
 * message nobody can read has not gained anything.
 */
function mutate(bot: Bot, text: string): string {
  const zeroWidth = String.fromCharCode(0x200b);
  const substitutions: Record<string, string> = {
    a: '4',
    e: '3',
    i: '1',
    o: '0',
    s: '5',
  };

  return [...text]
    .map((character) => {
      const lower = character.toLowerCase();
      if (bot.rng.chance(0.25) && substitutions[lower] !== undefined) {
        return substitutions[lower] ?? character;
      }
      if (character === ' ' && bot.rng.chance(0.15)) return `  `;
      if (bot.rng.chance(0.04)) return `${character}${zeroWidth}`;
      if (bot.rng.chance(0.08)) return character.toUpperCase();
      return character;
    })
    .join('');
}

/**
 * A2 — the same campaign, mutated per send.
 *
 * The exact-hash query cannot see this bot at all. The normalised-view query
 * should see it exactly as clearly as it sees A1, and the difference between
 * those two numbers is the headline the run exists to produce.
 */
export const mutatingSpammer: Persona = {
  scenario: 'A2',
  label: 'mutating-spammer',
  labels: ['spammer', 'campaign-mutated'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(bot.rng.int(300, 1_200), () => {
      if (bot.state !== 'MATCHED') return;
      bot.say(mutate(bot, campaign(bot)));
      bot.after(skipDelay(bot, 400, 1_500), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 200, 1_200);
  },
};

/**
 * A3 — link dropper.
 *
 * A payload adversary: every line fires `url` or `invite_link`, the corpus lint
 * guarantees it, and the message is still delivered because the default policy
 * flags rather than withholds (D20). The oracle checks the flags moved.
 */
export const linkDropper: Persona = {
  scenario: 'A3',
  label: 'link-dropper',
  // Not labelled `spammer`: the recall number is about *pattern* adversaries,
  // the ones no single-message rule can see. A link dropper is caught by the
  // `url` rule on the first message it sends, so counting it as a miss for the
  // cross-conversation query measured the wrong detector against the wrong bot.
  labels: ['abusive', 'payload-flagged'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    // Opens like a person, then drops the link. A bot that leads with a URL is
    // easy; the realistic one earns a reply first.
    greet(bot);
    bot.after(bot.rng.int(3_000, 8_000), () => {
      if (bot.state !== 'MATCHED') return;
      bot.say(line(bot, 'links.txt'));
      bot.after(skipDelay(bot, 1_000, 4_000), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/** A4 — contact harvester. Emails, phone numbers, handles, solicitations. */
export const contactHarvester: Persona = {
  scenario: 'A4',
  label: 'contact-harvester',
  labels: ['abusive', 'payload-flagged'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot) {
    if (bot.turnsSent >= 3) {
      bot.after(skipDelay(bot, 500, 2_000), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
      return;
    }
    speak(bot, line(bot, 'contact.txt'), bot.rng.int(1_200, 4_000));
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/**
 * A5 — deny-list hitter.
 *
 * The only persona whose outcome depends on deployment configuration:
 * `MODERATION_DENY_LIST` supplies the terms and `MODERATION_HARD_BLOCK_RULES`
 * decides whether a match is withheld or merely flagged. `.env.loadtest`
 * configures both, so a load run exercises the withhold path — the one where
 * the sender is acked with `delivered: false` and the partner sees nothing.
 *
 * On a stack without the deny list configured this bot is harmless gibberish,
 * and the oracle says so rather than counting a missed detection.
 */
export const denyListHitter: Persona = {
  scenario: 'A5',
  label: 'deny-list-hitter',
  labels: ['abusive', 'payload-blocked'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(bot.rng.int(500, 2_500), () => {
      if (bot.state !== 'MATCHED') return;
      bot.say(line(bot, 'denylist.txt'));
      bot.after(skipDelay(bot, 2_000, 6_000), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/**
 * A6 — flooder.
 *
 * Sends past the message bucket on purpose. Two things must hold: the server
 * refuses the excess with `RATE_LIMITED` rather than dropping the socket, and
 * the partner's stream has no *gaps* — a refused message was never delivered,
 * so the pair oracle should still reconcile exactly.
 */
export const flooder: Persona = {
  scenario: 'A6',
  label: 'flooder',
  labels: ['abusive', 'rate-abuse'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    const burst = (): void => {
      if (bot.state !== 'MATCHED') return;
      // Twenty in a tick against a bucket of 5/s with a burst of 10.
      for (let i = 0; i < 20; i += 1) bot.sayRegardless(line(bot, 'smalltalk.txt'));
      bot.after(bot.rng.int(4_000, 9_000), burst);
    };
    bot.after(bot.rng.int(500, 2_000), burst);
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/** A7 — harasser. Gives the M group something real to report. */
export const harasser: Persona = {
  scenario: 'A7',
  label: 'harasser',
  labels: ['abusive', 'hostile'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot) {
    // Does not stop when the conversation turns. That is what makes it worth
    // reporting rather than merely unpleasant.
    speak(bot, line(bot, 'hostile.txt'), bot.rng.int(800, 3_000));
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 3_000);
  },
};

/**
 * A8 — slow spammer.
 *
 * Sits just under 5 messages per second, indefinitely, and is therefore never
 * rate limited. It exists to make one point precisely: rate limiting is not
 * spam detection. A bot can send the same campaign to everyone it meets, all
 * day, entirely inside every limit the server enforces.
 */
export const slowSpammer: Persona = {
  scenario: 'A8',
  label: 'slow-spammer',
  labels: ['spammer', 'campaign-exact', 'rate-compliant'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    const step = (): void => {
      if (bot.state !== 'MATCHED') return;
      bot.say(campaign(bot));
      // ~4/s: under the 5/s bucket with room to spare, so the limiter never
      // fires and the only signal left is behavioural.
      bot.after(250, step);
    };
    bot.after(bot.rng.int(300, 1_500), step);
    bot.after(bot.rng.int(10_000, 25_000), () => {
      if (bot.state === 'MATCHED') bot.skip();
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 1_500);
  },
};

/**
 * A9 — burst and wait.
 *
 * Ten messages, pause for the bucket to refill, repeat. Tests whether burst
 * capacity can be converted into sustained throughput: it cannot, because a
 * token bucket's long-run rate is its refill rate no matter how the sends are
 * shaped — but a leak in the bucket accounting would show up here as a
 * sustained rate above `perSecond`.
 */
export const burstAndWait: Persona = {
  scenario: 'A9',
  label: 'burst-and-wait',
  labels: ['abusive', 'rate-abuse'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    const cycle = (): void => {
      if (bot.state !== 'MATCHED') return;
      for (let i = 0; i < 10; i += 1) bot.sayRegardless(line(bot, 'smalltalk.txt'));
      // Exactly the refill time for a burst of 10 at 5/s, plus a margin.
      bot.after(2_200, cycle);
    };
    bot.after(bot.rng.int(500, 2_000), cycle);
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};

/**
 * A10 — multi-match spammer.
 *
 * Same campaign, as many partners as the skip limiter allows, for the whole
 * run. Where A1 sends once and leaves, this one is optimised purely for reach,
 * and it is the bot whose conversation count the oracle reports as "how many
 * strangers did the system let one spammer reach".
 */
export const multiMatchSpammer: Persona = {
  scenario: 'A10',
  label: 'multi-match-spammer',
  labels: ['spammer', 'campaign-exact', 'high-reach'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.say(campaign(bot));
    // Straight back out at the fastest rate the limiter permits, and no faster:
    // being throttled would reduce reach, which is what this bot optimises.
    bot.after(Math.max(bot.waitFor('skip'), 200), () => {
      if (bot.state === 'MATCHED') bot.skip();
    });
  },

  onError(bot, code) {
    if (code === 'RATE_LIMITED') {
      bot.after(bot.waitFor('skip') + 200, () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    }
  },

  onPartnerGone(bot) {
    requeue(bot, 100, 600);
  },
};

/**
 * A11 — template rotator.
 *
 * Several semantically identical openers rather than one string. Defeats exact
 * hashing without any character tricks at all, which makes it the more
 * realistic evasion of the two — and the harder one, because `moderationView`
 * folds character mutations but not synonyms.
 *
 * The honest expectation is that this bot is caught by *neither* query. It is
 * in the roster so the report has to say so.
 */
export const templateRotator: Persona = {
  scenario: 'A11',
  label: 'template-rotator',
  labels: ['spammer', 'campaign-templated'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    // A small fixed set per bot, cycled — not the whole corpus, which would
    // make it indistinguishable from an ordinary talker by construction.
    const lines = bot.corpus.lines('spam.txt');
    const base = bot.spec.index % lines.length;
    const template = lines[(base + bot.matchMemo('rotation', () => bot.rng.int(0, 2))) % lines.length];
    bot.after(bot.rng.int(300, 1_500), () => {
      if (bot.state !== 'MATCHED' || template === undefined) return;
      bot.say(template);
      bot.after(skipDelay(bot, 400, 1_500), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 200, 1_200);
  },
};

/**
 * A12 — report spammer.
 *
 * Reports every partner regardless of what they said, forcing past the local
 * mirror so the server's own limiter answers. Two things are being measured:
 * that `RATE_LIMITED` arrives after the burst of 3, and that the database write
 * volume is bounded by the limiter rather than by this bot's enthusiasm.
 *
 * It also poisons the report signal on purpose. If reports are ever used as an
 * enforcement input, this is the bot that shows what a malicious reporter can
 * do to an innocent partner.
 */
export const reportSpammer: Persona = {
  scenario: 'A12',
  label: 'report-spammer',
  labels: ['abusive', 'report-abuse'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(bot.rng.int(500, 2_000), () => {
      if (bot.state !== 'MATCHED') return;
      bot.report('harassment', undefined, { force: true });
      bot.after(skipDelay(bot, 1_000, 3_000), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_000);
  },
};

/**
 * A13 — block and skip attacker.
 *
 * Fires both teardown paths at the same partner, as fast as both limiters
 * allow. `block` ends the match and lands in IDLE; `skip` ends it and
 * re-queues. Issuing both against one match is the race R10 describes, and the
 * requirement is that exactly one teardown happens and the block is recorded
 * regardless of which won.
 *
 * It also shrinks its own matchable pool with every block, which is the M4
 * effect arrived at from a different direction.
 */
export const blockSkipAttacker: Persona = {
  scenario: 'A13',
  label: 'block-skip-attacker',
  labels: ['abusive', 'teardown-abuse'],

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    bot.after(bot.rng.int(200, 900), () => {
      if (bot.state !== 'MATCHED') return;
      // Same tick, both paths, deliberately racing.
      bot.block({ force: true });
      bot.skip({ force: true });
      // `block` lands in IDLE and `skip` re-queues; whichever the server
      // honoured, this makes sure the bot is searching again either way.
      bot.after(bot.rng.int(800, 2_500), () => {
        if (bot.state === 'IDLE') bot.joinQueue();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 200, 1_200);
  },
};
