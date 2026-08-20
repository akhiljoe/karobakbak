/**
 * The N group: people having ordinary conversations.
 *
 * This is the majority of any realistic run and the group whose latency
 * numbers are worth quoting. Everything here is a variation on one loop —
 * greet, take turns, end — with the variable being *how* a person ends and how
 * long they stay.
 */
import type { Persona } from '../bot';
import { greet, line, readTimeMs, reply, requeue, speak } from './support';

/** N1 — the ordinary talker. Greets, takes turns, says goodbye, leaves. */
export const talker: Persona = {
  scenario: 'N1',
  label: 'talker',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    const chars = [...payload.text].length;
    // A conversation has a length, drawn once per match so the population has
    // a distribution rather than a constant — and so this bot can actually
    // reach its own ending instead of redrawing the target every turn.
    const turns = bot.matchMemo('turns', () => bot.rng.int(8, 30));
    if (bot.turnsSent >= turns) {
      speak(bot, line(bot, 'farewells.txt'), readTimeMs(bot, chars));
      bot.after(readTimeMs(bot, chars) + 2_000, () => {
        if (bot.state === 'MATCHED') bot.leaveChat();
        requeue(bot, 1_000, 6_000);
      });
      return;
    }
    // Questions draw an answer; statements draw an acknowledgement. Mixing the
    // two is what keeps a conversation going instead of ping-ponging "ok".
    reply(bot, chars, bot.rng.chance(0.4) ? 'questions.txt' : 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/** N2 — one long conversation, sparse messages, relying on the heartbeat. */
export const longHauler: Persona = {
  scenario: 'N2',
  label: 'long-hauler',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    // Deliberately slower than the session TTL is long: this only survives if
    // the ping heartbeat is refreshing the session, which is the point.
    speak(bot, line(bot, 'smalltalk.txt'), bot.rng.int(20_000, 90_000));
    void payload;
  },

  onPartnerGone(bot) {
    requeue(bot, 2_000, 10_000);
  },
};

/** N3 — replies to roughly one message in three, with long gaps. */
export const lurker: Persona = {
  scenario: 'N3',
  label: 'lurker',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    // Does not greet first. Somebody else has to start.
    bot.after(bot.rng.int(10_000, 30_000), () => {
      if (bot.state === 'MATCHED' && bot.turnsReceived === 0) {
        speak(bot, line(bot, 'openers.txt'));
      }
    });
  },

  onPartnerMessage(bot, payload) {
    if (!bot.rng.chance(0.34)) return;
    speak(bot, line(bot, 'replies.txt'), readTimeMs(bot, [...payload.text].length) * 3);
  },

  onPartnerGone(bot) {
    requeue(bot, 3_000, 15_000);
  },
};

/** N4 — emoji, CJK, RTL, combining marks. Proves the text path is byte-exact. */
export const polyglot: Persona = {
  scenario: 'N4',
  label: 'polyglot',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    speak(bot, line(bot, 'unicode.txt'), bot.rng.int(300, 2_000));
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'unicode.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * N5 — the length boundary.
 *
 * Sends one message at exactly the published limit, and — **once per bot, not
 * once per match** — one character over.
 *
 * That distinction was learnt from a run. `MESSAGE_TOO_LONG` counts as a
 * protocol strike (`connection.ts:216`, deliberately: "a client that cannot
 * construct a valid frame is either broken or probing"), and the default
 * `INVALID_MESSAGE_STRIKES` is 10. A persona that tries one over-length message
 * in every conversation is therefore not a verbose user at all — it is a
 * protocol-abuse persona wearing a disguise, and after ten matches the server
 * closes it with `TOO_MANY_INVALID_MESSAGES` and 4003. The server is right; the
 * persona was wrong.
 *
 * So the over-length probe happens once, and the rest of this bot's life is
 * spent sending legal messages at exactly the limit — which is the behaviour
 * the scenario is actually about. The strike behaviour belongs to P-group work.
 *
 * The padding never ends in whitespace: the server trims before storing and
 * delivering, so a message ending in a space would arrive shorter than it was
 * sent and the pair oracle would report a delivery bug that is really a padding
 * bug here.
 */
export const verbose: Persona = {
  scenario: 'N5',
  label: 'verbose',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    const max = bot.limits?.maxMessageLength ?? 500;
    // Built from a corpus line so the body is still recognisable text, padded
    // with a repeated phrase rather than one character — a run of 500 identical
    // characters is not what a long message looks like.
    const base = line(bot, 'smalltalk.txt');
    const filler = ' and then some more of the same thing again';
    const grow = (target: number): string => {
      let text = base;
      while ([...text].length < target) text += filler;
      const cut = [...text].slice(0, target);
      // Never end on whitespace: the server trims, and the message the partner
      // receives would then differ from the one this bot hashed.
      const last = cut.length - 1;
      if (cut[last] === undefined || cut[last]?.trim() === '') cut[last] = 'x';
      return cut.join('');
    };

    bot.after(bot.rng.int(500, 2_000), () => {
      if (bot.state !== 'MATCHED') return;
      bot.say(grow(max));

      // `probedOverLength` is deliberately on the bot rather than the match:
      // once per lifetime, so this persona cannot accumulate strikes.
      if (!bot.flag('probedOverLength')) {
        bot.after(1_500, () => {
          if (bot.state !== 'MATCHED') return;
          bot.setFlag('probedOverLength');
          // Expected: MESSAGE_TOO_LONG, and the socket stays open. A client
          // that types too much is not an abuser.
          bot.say(grow(max + 1));
        });
      }

      bot.after(6_000, () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
    });
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/** N6 — both sides answering within 100–500 ms, for a long stretch. */
export const rapidTurnTaker: Persona = {
  scenario: 'N6',
  label: 'rapid-turn-taker',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    speak(bot, line(bot, 'openers.txt'), bot.rng.int(50, 200));
  },

  onPartnerMessage(bot) {
    const turns = bot.matchMemo('turns', () => bot.rng.int(20, 50));
    if (bot.turnsSent >= turns) {
      bot.after(bot.rng.int(200, 600), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
      return;
    }
    // No typing indicator and no think time: the whole point is to compress
    // both sides' sends into the same window and see whether ordering holds.
    bot.after(bot.rng.int(100, 500), () => {
      if (bot.state === 'MATCHED') bot.say(line(bot, 'replies.txt'));
    });
  },

  onPartnerGone(bot) {
    requeue(bot, 300, 1_500);
  },
};

/** N7 — talks at a partner who is barely there. */
export const chatterbox: Persona = {
  scenario: 'N7',
  label: 'chatterbox',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    const target = bot.matchMemo('target', () => bot.rng.int(20, 50));
    const step = (): void => {
      if (bot.state !== 'MATCHED') return;
      if (bot.turnsSent >= target) {
        bot.skip();
        return;
      }
      // Paced under the message bucket deliberately: this persona is about
      // asymmetry, not about flooding. A6 is the one that floods.
      speak(bot, line(bot, 'smalltalk.txt'), bot.rng.int(600, 2_000));
      bot.after(bot.rng.int(2_500, 5_000), step);
    };
    step();
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/** N8 — reaches a natural end and closes it properly from its own side. */
export const finisher: Persona = {
  scenario: 'N8',
  label: 'finisher',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    const chars = [...payload.text].length;
    if (bot.turnsSent >= 6) {
      speak(bot, line(bot, 'farewells.txt'), readTimeMs(bot, chars));
      // Leaves rather than skipping: this persona is a statement about wanting
      // to stop, and it must land in IDLE and stay there for a while.
      bot.after(readTimeMs(bot, chars) + 3_000, () => {
        if (bot.state === 'MATCHED') bot.leaveChat();
        requeue(bot, 10_000, 30_000);
      });
      return;
    }
    reply(bot, chars, 'smalltalk.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 5_000, 20_000);
  },
};

/**
 * N10 — fifty to a hundred conversations back to back.
 *
 * The persona that finds state leakage. Nothing it does is unusual; the point
 * is the count, and the oracle is that conversation forty behaves exactly like
 * conversation one.
 */
export const regular: Persona = {
  scenario: 'N10',
  label: 'regular',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    const chars = [...payload.text].length;
    if (bot.turnsSent >= 3) {
      bot.after(readTimeMs(bot, chars), () => {
        if (bot.state === 'MATCHED') bot.skip();
      });
      return;
    }
    reply(bot, chars, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 500, 2_500);
  },
};
