/**
 * The G group: what a stranger says about themselves (§26, phase 14).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A GROUP AND NOT A FLAG ON THE N PERSONAS
 * ---------------------------------------------------------------------------
 * Every bot in the swarm now declares a profile — `join_queue` carries one and
 * `bot.joinQueue()` sends it without a persona asking. That covers the happy
 * path everywhere, which is right: a field that only one scenario exercises is
 * a field whose interaction with everything else is untested.
 *
 * What it does *not* cover is the two refusals and the churn, and those need
 * bots that misbehave on purpose:
 *
 *   G1  declares nothing, ever — the control group, and the most common real
 *       profile there is
 *   G2  declares an age below the floor, once, and must be refused
 *   G3  declares a name the moderation rules must refuse (D35)
 *   G4  re-declares something different on every join — the "a join carries the
 *       whole profile, a missing field is deleted" rule
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THESE PERSONAS ARE BUILT AROUND
 * ---------------------------------------------------------------------------
 * The two refusals arrive by different routes and only one of them is free:
 *
 *   * **age** is refused inside `parseClientFrame`, so it is a **protocol
 *     strike**. `INVALID_MESSAGE_STRIKES` is 10, and a bot that probed it once
 *     per conversation would be disconnected with 4003 partway through the run
 *     — the server behaving exactly right, recorded as a mysterious close. So
 *     G2 probes **once per lifetime**, the same discipline N5 needs for
 *     over-length messages.
 *   * **name** is refused in `server.ts` after the frame has parsed, so it is
 *     not a strike and G3 can afford to repeat it.
 *
 * Either refusal leaves the bot un-queued. The bot rolls its optimistic
 * `SEARCHING` back to `IDLE` on both codes for exactly this reason; without
 * that, a refused bot sits out the run looking connected and healthy.
 */
import type { Persona } from '../bot';
import { NOTHING_DECLARED, REFUSABLE_NAMES, declaredProfile, underageProfile } from '../declared';
import { greet, reply, requeue } from './support';

/**
 * G1 — declines to say anything.
 *
 * The control group. Both sides of a match must render perfectly with a null
 * profile on one or both of them, falling back to the server-generated
 * nickname, and nothing downstream — the identity builder, the console, the
 * retention rows — may need a profile to exist.
 */
export const anonymous: Persona = {
  scenario: 'G1',
  label: 'anonymous',

  onConnected(bot) {
    bot.declared = NOTHING_DECLARED;
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * G2 — declares an age below the floor, once.
 *
 * Must be refused with `AGE_BELOW_MINIMUM`, and the refusal must be *specific*:
 * a generic `VALIDATION_FAILED` would leave the client unable to say what the
 * service is, and would leave the server unable to count the declaration as the
 * minor-safety signal it is.
 *
 * Nothing about the refused age may be stored. What the swarm can check from
 * outside is the next best thing: the same bot joins again with an acceptable
 * age and is matched normally, carrying the second declaration and no trace of
 * the first.
 */
export const underageDeclarer: Persona = {
  scenario: 'G2',
  label: 'underage-declarer',

  onConnected(bot) {
    // Once per lifetime. See the strike note at the top of this file.
    if (bot.flag('age-probed')) {
      bot.joinQueue();
      return;
    }
    bot.setFlag('age-probed');
    bot.joinQueue(underageProfile(bot.rng, bot.corpus));
  },

  onError(bot, code) {
    if (code !== 'AGE_BELOW_MINIMUM') return;
    // Refused, as it should be. A real client shows what the service is and
    // lets the person correct it; this one corrects it.
    bot.after(bot.rng.int(600, 2_500), () => {
      if (bot.state === 'IDLE') bot.joinQueue();
    });
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * G3 — puts a contact handle in its display name.
 *
 * The advert that a name field invites. A message carrying a Telegram handle is
 * flagged and delivered (D20) because it is one utterance a moderator can weigh
 * later; a *name* carrying one is refused (D35), because it is a label shown to
 * everyone this person will ever meet and there is nothing to weigh.
 *
 * Repeated deliberately: this refusal is not a protocol strike, and a bot that
 * keeps trying is what a bot advertising a channel actually does. Every attempt
 * must be refused, and the run's `chat_profiles_refused_total{reason=
 * "name_moderation"}` must account for all of them.
 */
export const nameAdvertiser: Persona = {
  scenario: 'G3',
  label: 'name-advertiser',
  labels: ['abusive'],

  onConnected(bot) {
    bot.joinQueue({
      ...declaredProfile(bot.rng, bot.corpus),
      name: bot.rng.pickOne([...REFUSABLE_NAMES]),
    });
  },

  onError(bot, code) {
    if (code !== 'VALIDATION_FAILED') return;
    if (bot.flag('gave-up')) return;
    // Tries a few times, then settles for a name that is allowed — which is the
    // behaviour worth measuring, because it is the one that says the refusal
    // actually changed anything.
    //
    // Counted with lifetime flags rather than `matchMemo`: the memo is cleared
    // at every match boundary, and a bot being refused never reaches one, so a
    // memo counter here would sit at one forever and retry without end.
    const attempt = bot.flag('name-try-2') ? 3 : bot.flag('name-try-1') ? 2 : 1;
    bot.setFlag(`name-try-${attempt}`);
    bot.after(bot.rng.int(1_500, 5_000), () => {
      if (bot.state !== 'IDLE') return;
      if (attempt >= 3) {
        bot.setFlag('gave-up');
        bot.joinQueue();
        return;
      }
      bot.joinQueue({
        ...declaredProfile(bot.rng, bot.corpus),
        name: bot.rng.pickOne([...REFUSABLE_NAMES]),
      });
    });
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    requeue(bot);
  },
};

/**
 * G4 — a different declaration on every join.
 *
 * There is no partial update: a join carries the whole profile, and a field it
 * omits is deleted rather than kept. That is the rule that stops a client
 * believing it removed something the server still shows, and this persona is
 * what makes it observable — each of its conversations sees a different
 * declaration, and the previous one must not survive anywhere in it.
 *
 * Every declaration is valid. Churn is the scenario; refusal belongs to G2 and
 * G3, and mixing them would make an unexpected refusal here indistinguishable
 * from the intended one.
 */
export const profileChurner: Persona = {
  scenario: 'G4',
  label: 'profile-churner',

  onConnected(bot) {
    bot.declared = declaredProfile(bot.rng, bot.corpus);
    bot.joinQueue();
  },

  onMatched(bot) {
    greet(bot);
  },

  onPartnerMessage(bot, payload) {
    reply(bot, [...payload.text].length, 'replies.txt');
  },

  onPartnerGone(bot) {
    // A new declaration for the next stranger, including the possibility of
    // declaring nothing at all — which is the case that proves a field is
    // deleted rather than remembered.
    bot.declared = bot.rng.chance(0.2)
      ? NOTHING_DECLARED
      : declaredProfile(bot.rng, bot.corpus);
    requeue(bot);
  },
};
