/**
 * The L group: what happens to a connection, rather than to a conversation.
 *
 * These personas are cheap to write and catch a class of bug nothing else
 * does — state that outlives the socket it belonged to. Every one of them ends
 * in a way the server did not initiate, which is the only way to find out
 * whether the server's cleanup depends on being told.
 */
import type { Persona } from '../bot';
import { greet, reply, requeue } from './support';

/**
 * L1 — closes the tab mid-conversation.
 *
 * A clean close frame, so the server learns immediately and the partner should
 * see `partner_disconnected` fast. Reconnects afterwards, because a person who
 * closes a tab usually comes back.
 */
export const tabCloser: Persona = {
  scenario: 'L1',
  label: 'tab-closer',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    bot.after(bot.rng.int(8_000, 30_000), () =>
      bot.reconnect(bot.rng.int(2_000, 15_000), 'clean'),
    );
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * L2 — rage quit: the socket is destroyed with no close frame.
 *
 * The server cannot be told, so it has to notice. That path is the heartbeat,
 * the session TTL and the janitor, and it is the one that decides how long a
 * partner stares at a conversation that has already ended.
 */
export const rageQuitter: Persona = {
  scenario: 'L2',
  label: 'rage-quitter',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    bot.after(bot.rng.int(5_000, 25_000), () => {
      // No close frame, no FIN handshake the application ever sees.
      bot.reconnect(bot.rng.int(5_000, 20_000));
    });
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * L4 — the phone went in a pocket.
 *
 * The socket stays open and nothing is sent, including pings. The bot must be
 * reaped at the session TTL: not earlier, which would kill live users, and not
 * never, which would leak a session per backgrounded tab.
 *
 * The heartbeat is suppressed by never letting the persona act, and the bot's
 * own ping timer is the thing under test — so this persona disables it.
 */
export const backgrounded: Persona = {
  scenario: 'L4',
  label: 'backgrounded',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    bot.after(bot.rng.int(5_000, 20_000), () => {
      bot.goSilent();
    });
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onError(bot, code) {
    // Expected, eventually. Coming back is what a phone does when it wakes.
    if (code === 'SESSION_GONE') bot.reconnect(bot.rng.int(1_000, 5_000));
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * L6 — connects and never joins the queue.
 *
 * Reading the page, looking at settings, deciding. A real share of any live
 * population, and it exists here to answer one question: does an idle
 * connection cost anything it should not? It must be counted in presence and
 * never appear in a queue.
 */
export const settingsBrowser: Persona = {
  scenario: 'L6',
  label: 'settings-browser',

  onConnected(bot) {
    // Fiddles with the typing indicator the way a UI does when a text box is
    // focused and abandoned, which must be harmless when there is no partner.
    const fiddle = (): void => {
      bot.typing(true);
      bot.after(bot.rng.int(800, 3_000), () => {
        bot.typing(false);
        bot.after(bot.rng.int(20_000, 90_000), fiddle);
      });
    };
    bot.after(bot.rng.int(5_000, 30_000), fiddle);
  },
};

/**
 * L9 — an unstable connection: connect, drop, reconnect, repeatedly.
 *
 * Mobile networks do this all day. The value is in the overlap: cleanup for the
 * old session and setup for the new one run at the same time, and only one of
 * them may own the bot's queue membership when it settles.
 */
export const networkFlapper: Persona = {
  scenario: 'L9',
  label: 'network-flapper',

  onConnected(bot) {
    bot.joinQueue();
    bot.after(bot.rng.int(3_000, 12_000), () => bot.reconnect(bot.rng.int(200, 2_000)));
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot, 200, 2_000);
  },
};

/**
 * L10 — comes back without its cookie.
 *
 * A cleared browser, a private window, a new device. The server must treat it
 * as a new client identity on the token dimension while the address dimension
 * still recognises it — which is exactly why there are two dimensions.
 */
export const cookieLoser: Persona = {
  scenario: 'L10',
  label: 'cookie-loser',

  onConnected(bot) {
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
    bot.after(bot.rng.int(10_000, 30_000), () => {
      bot.forgetClientToken();
      bot.reconnect(bot.rng.int(500, 3_000));
    });
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};
