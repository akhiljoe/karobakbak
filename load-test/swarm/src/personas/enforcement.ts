/**
 * A group — enforcement at the door.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `PHASES.md` names this as the sharpest gap in the swarm: **no scenario
 * reconnects a banned identity.** The upgrade-path refusal has integration
 * coverage and has never been seen under load, and the worry it records is
 * specific — "a ban misfiring at the edge would present as a capacity problem
 * in a run rather than as a safety bug".
 *
 * That is two failures, not one, and this persona exists to separate them:
 *
 *  * **Under-enforcement.** A banned identity connects anyway. A safety
 *    failure, and the obvious one.
 *  * **Over-enforcement.** The ban catches somebody else too. Every bot in a
 *    run shares a host, so a ban keyed on the wrong thing — the generator's
 *    real address rather than the claimed one, a hash of the wrong hop —
 *    refuses the whole population. A run that loses most of its bots to 403s
 *    reads as capacity pressure, and a smaller population quietly passes every
 *    other oracle. That is the failure PHASES was worried about, and it is the
 *    one nothing here could previously see.
 *
 * ---------------------------------------------------------------------------
 * BANNED BEFORE THE RUN, NOT DURING IT
 * ---------------------------------------------------------------------------
 * The ban is applied by the orchestrator before any socket opens, so there is
 * no timing coordination between a persona and a moderator action that does
 * not exist in this harness — nothing issues bans automatically, and driving
 * the console's TOTP login from a load test would be testing the console
 * rather than the edge.
 *
 * The consequence is that this bot never connects at all. Its whole
 * contribution is one refusal, and the oracle reads that plus the absence of
 * refusals anywhere else.
 *
 * ---------------------------------------------------------------------------
 * IT DOES NOT HAMMER, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 * `bot.onRefused` treats 403 as terminal and stops. That rule is trap 19 in the
 * handoff — it was written because a refused upgrade used to kill a bot
 * permanently and a backend restart once removed 244 of 400 bots from a run —
 * and the resolution was that a refusal meaning "you are not welcome" is
 * terminal while a transient one retries. A banned client that kept hammering
 * would be the bug.
 *
 * So this persona confirms that a banned identity is refused, and does not
 * confirm that it is refused *repeatedly*. Testing the second needs a bounded
 * exception to that rule, and it is catalogued rather than smuggled in here.
 */
import type { Persona } from '../bot';
import { greet, reply } from './support';

/**
 * A14 — an identity under an active ban.
 *
 * Behaves like an ordinary talker in every respect. That is the point: nothing
 * about its conduct during the run is what gets it refused, so a failure is
 * unambiguously about enforcement rather than about anything it did.
 */
export const bannedReturner: Persona = {
  scenario: 'A14',
  label: 'banned-returner',
  labels: ['banned'],

  onConnected(bot) {
    // Reached only if the ban did not hold. The bot behaves normally so that a
    // failure produces a *conversation* in the ledger — visible evidence of
    // what a banned identity was able to do, rather than a bare counter.
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerAway() {
    // Waits. Nothing sent now is delivered and nothing is buffered (D43).
  },
};
