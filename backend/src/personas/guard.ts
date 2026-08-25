/**
 * The six limits, between the model and the socket (D-AI-5, phase A5).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT PROMPT TEXT
 * ---------------------------------------------------------------------------
 * The prompt asks the model to behave. This decides what actually reaches the
 * socket. The difference is the whole phase.
 *
 * A limit written into a system prompt is a limit the thing generating text can
 * be talked around — that is not a hypothetical, it is the specific failure the
 * AI-companion litigation turned on. So the prompt still carries the
 * instructions (they make good behaviour likelier and cost nothing), and
 * nothing depends on them.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS, HONESTLY
 * ---------------------------------------------------------------------------
 * Pattern matching over a normalised view. That is a **floor, not a solution**.
 * It will miss things a person would catch, and it will occasionally stop a
 * harmless sentence.
 *
 * Both errors are deliberately not symmetric. Suppressing a safe reply costs
 * one turn of a conversation with a bot. Letting the wrong reply through costs
 * something that cannot be taken back. So every ambiguous case resolves toward
 * suppression, and the analysis failing closed means the persona says nothing.
 *
 * It reuses `moderationView` rather than matching raw text, because the same
 * obfuscations that defeat the chat moderation rules — dots between letters,
 * homoglyphs, "(at)" for "@" — defeat this too, and that normalisation is
 * already written and tested.
 *
 * ---------------------------------------------------------------------------
 * THE LIMITS
 * ---------------------------------------------------------------------------
 *  1. no sexual or explicit content, for any persona, however asked
 *  2. a minor signal ends the romantic register **irreversibly for the session**
 *  3. no escalation under pressure — the tenth decline equals the first
 *  4. a crisis signal breaks character entirely
 *  5. never solicit personal information or contact off-platform
 *  6. never deny being automated
 *
 * None of these is persona configuration. A `forward` character and a `none`
 * character are subject to precisely the same floor.
 */

import { moderationView } from '../moderation/normalise';
import type { Logger } from '../logger';
import { errorFields } from '../logger';
import type { PersonaVoice, VoiceTurn } from './client';

/** Which limit stopped something. A metric label, so the set stays closed. */
export type LimitId =
  | 'sexual'
  | 'minor'
  | 'escalation'
  | 'crisis'
  | 'personal_info'
  | 'identity';

export interface LimitTrip {
  readonly limit: LimitId;
  /** True when a reply was replaced or suppressed rather than merely noted. */
  readonly enforced: boolean;
}

export interface GuardEvents {
  onTrip?(trip: LimitTrip): void;
  /** A session that needs a human to look at it. */
  onFlagSession?(reason: LimitId): void;
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Sexual content.
 *
 * Clinical and deliberately blunt. Flirtation is permitted by D-AI-5 and is not
 * listed here — teasing, compliments, attraction and dating talk all pass. What
 * is listed is the explicit register the limit exists to stop, in the spellings
 * somebody actually types.
 */
const SEXUAL = [
  'sex', 'sexual', 'sexy', 'horny', 'nude', 'nudes', 'naked', 'porn', 'porno',
  'masturbat', 'orgasm', 'cum', 'penis', 'vagina', 'dick', 'cock', 'pussy',
  'boobs', 'tits', 'blowjob', 'anal', 'fuck', 'fucking', 'erotic', 'aroused',
  'turn me on', 'take it off', 'send pics', 'send a pic', 'sext',
  'talk dirty', 'dirty talk', 'get me off', 'hook up', 'hookup',
];

/**
 * Signals that the person on the other side may be a child.
 *
 * Cast wide on purpose. A false positive costs a persona its romantic register
 * for one conversation, which is nothing; a false negative is the case this
 * entire policy set is built around.
 *
 * Ages are matched numerically below rather than listed here, because "i am 15"
 * has too many spellings to enumerate.
 */
const MINOR_PHRASES = [
  'high school', 'highschool', 'middle school', 'primary school', 'secondary school',
  'my mum wont let', 'my mom wont let', 'my parents wont let', 'my dad wont let',
  'my teacher', 'my homework', 'my exams next week', 'year 7', 'year 8', 'year 9',
  'year 10', 'grade 6', 'grade 7', 'grade 8', 'grade 9', 'class 8', 'class 9',
  'class 10', 'im a minor', 'i am a minor', 'im underage', 'i am underage',
  'im still in school', 'i am still in school', 'my school',
];

/** Self-harm and suicidal signals. Matched generously; the cost of a miss is the point. */
const CRISIS = [
  'kill myself', 'killing myself', 'want to die', 'wanna die', 'want to be dead',
  // Both tenses of each phrase: "been thinking about ending it all" is how
  // somebody actually writes it, and a list carrying only the infinitive misses
  // the sentence that matters.
  'end my life', 'ending my life', 'end it all', 'ending it all',
  'suicide', 'suicidal', 'self harm', 'self-harm', 'selfharm',
  'cut myself', 'cutting myself', 'hurt myself', 'hurting myself',
  'no reason to live', 'nothing to live for', 'better off dead',
  'take my own life', 'taking my own life', 'overdose', 'od on',
];

/** Direct challenges to whether the persona is a person. */
const IDENTITY_CHALLENGE = [
  'are you a bot', 'are you bot', 'are you an ai', 'are you ai', 'are you real',
  'are you a real person', 'are you human', 'are you a human', 'is this a bot',
  'am i talking to a bot', 'am i talking to a real person', 'youre a bot',
  'you are a bot', 'this is a bot', 'are you chatgpt', 'are you a robot',
];

/** A persona saying it is human. The thing limit 6 exists to stop. */
const IDENTITY_DENIAL = [
  'im human', 'i am human', 'im a real person', 'i am a real person',
  'im not a bot', 'i am not a bot', 'im not an ai', 'i am not an ai',
  'im real', 'i am real', 'im a person', 'i am a person', 'not a robot',
  'im not artificial', 'course im real', 'of course im real',
];

/** A persona asking for something it must never ask for. */
const SOLICITATION = [
  'whats your real name', 'what is your real name', 'send me a pic',
  'send me a photo', 'send a photo', 'your number', 'your phone number',
  'add me on', 'whats your insta', 'whats your snap', 'your instagram',
  'your snapchat', 'your telegram', 'your whatsapp', 'lets meet', 'let us meet',
  'meet up', 'meet in person', 'where do you live', 'whats your address',
  'what is your address', 'email me', 'your email',
];

/** Normalised, lowercased, apostrophes dropped, whitespace collapsed. */
function view(text: string): string {
  return moderationView(text)
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/\s+/g, ' ');
}

/**
 * The same view with deliberate letter-spacing collapsed: `s.e.x` -> `sex`.
 *
 * Only runs of **single letters separated by one or two non-letters** are
 * joined, never all punctuation. Stripping every separator would turn "this ex"
 * into "thisex", which contains a listed word and is a false positive on
 * perfectly ordinary text — and false positives here silence a persona for no
 * reason, which erodes trust in the filter and gets it loosened.
 *
 * Targeting the obfuscation shape specifically catches the evasion without
 * touching normal writing.
 */
function deobfuscated(v: string): string {
  return v.replace(/(?:[a-z][^a-z0-9]{1,2}){2,}[a-z]/g, (run) => run.replace(/[^a-z0-9]/g, ''));
}

/**
 * Match against both views.
 *
 * Two passes rather than one, because the collapsed view loses word boundaries
 * and would miss multi-word phrases like "want to die".
 */
function containsAny(haystack: string, needles: readonly string[]): boolean {
  const collapsed = deobfuscated(haystack);
  return needles.some((needle) => haystack.includes(needle) || collapsed.includes(needle));
}

/**
 * A stated age below 18.
 *
 * Matches the shapes people actually type — "im 15", "i'm 15", "15 yo",
 * "15 years old", "turning 16". Deliberately does not match a bare number,
 * because "15" alone is far more often a time, a score or a quantity.
 */
export function statesMinorAge(text: string): boolean {
  const v = view(text);
  const patterns = [
    /\bi ?a?m (\d{1,2})\b/,
    /\bim (\d{1,2})\b/,
    /\bi ?a?m (\d{1,2}) ?(?:yo|yrs|years? old)\b/,
    /\b(\d{1,2}) ?(?:yo|yrs old|years? old)\b/,
    /\bturning (\d{1,2})\b/,
    /\bjust turned (\d{1,2})\b/,
    /\bage[: ]+(\d{1,2})\b/,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(v);
    const captured = match?.[1];
    if (captured === undefined) continue;
    const age = Number(captured);
    // Below 13 is almost always a typo, a sibling's age or a number that is not
    // an age at all; 13-17 is the range this is for. An adult saying "i am 25"
    // must not trip it.
    if (Number.isInteger(age) && age >= 13 && age <= 17) return true;
  }
  return false;
}

export function looksLikeMinor(text: string): boolean {
  return statesMinorAge(text) || containsAny(view(text), MINOR_PHRASES);
}

export function looksSexual(text: string): boolean {
  return containsAny(view(text), SEXUAL);
}

export function looksLikeCrisis(text: string): boolean {
  return containsAny(view(text), CRISIS);
}

export function challengesIdentity(text: string): boolean {
  return containsAny(view(text), IDENTITY_CHALLENGE);
}

export function deniesBeingAutomated(text: string): boolean {
  return containsAny(view(text), IDENTITY_DENIAL);
}

export function solicitsPersonalInfo(text: string): boolean {
  return containsAny(view(text), SOLICITATION);
}

/* -------------------------------------------------------------------------- */
/* Fixed replies                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What a persona says when it must break character.
 *
 * Plain language, no persona voice, no roleplay. Somebody in trouble is owed a
 * straight answer rather than a character's version of one, and the helplines
 * are Indian because that is where this service is operated from and where most
 * of its users will be.
 */
export const CRISIS_REPLY =
  "I want to stop and say something straight, not in character: it sounds like " +
  "you're going through something really hard, and I'm not able to help with " +
  'this properly. Please talk to someone who can. In India you can call KIRAN on ' +
  '1800-599-0019 or Tele-MANAS on 14416, any time, free. If you are in immediate ' +
  'danger please call 112. Please reach out to someone you trust as well.';

/**
 * Answers to "are you a bot" that dodge without lying (D-AI-4, revised).
 *
 * The rule this enforces is **never assert a falsehood**, which is narrower
 * than the honesty the first draft required and is the line that actually
 * matters. None of these claims to be a person; none confirms it either. A user
 * who asks twice and gets deflected twice has been given real signal.
 *
 * It is still deception by design, and the residual is not argued away: a
 * persona that dodges will leave some people believing they spoke to a human.
 * What it will not do is tell them so.
 *
 * Every string here is checked against `deniesBeingAutomated` by a test, so a
 * later edit cannot quietly reintroduce a denial through the escape hatch that
 * exists to prevent them.
 */
const IDENTITY_DEFLECTIONS = [
  'wow, straight in with the big questions',
  'what would you do if i said yes',
  'youre not going to believe whatever i answer, so',
  'thats a strange thing to lead with',
  'why, do i seem off somehow',
];

/**
 * In-character refusals for the sexual limit. Neutral, and they do not escalate.
 *
 * Exported so a test can assert that every decline is one of these — the
 * position is fixed and only the wording rotates.
 */
export const SEXUAL_DECLINES = [
  "not going there, sorry. talk about something else?",
  "yeah i'm not up for that kind of chat",
  "nah, not my thing. pick another subject",
];

/* -------------------------------------------------------------------------- */
/* The guard                                                                  */
/* -------------------------------------------------------------------------- */

export interface GuardOptions {
  readonly inner: PersonaVoice;
  readonly logger: Logger;
  readonly events?: GuardEvents;
  /** Injected for deterministic tests. */
  readonly pick?: <T>(items: readonly T[]) => T;
}

/**
 * Wraps a voice and enforces the six limits on both sides of it.
 *
 * One instance per conversation: the minor lock and the pressure counter are
 * per-session state, and the lock must not leak into the next conversation
 * (there is nothing to carry — the surface is regenerated anyway, D-AI-3).
 */
export function guardVoice(options: GuardOptions): PersonaVoice {
  // Irreversible for the session. Once set, nothing the user says clears it —
  // that is the whole of limit 2. A user who says "jk i'm 25" after saying they
  // are 15 does not get the register back.
  let romanticLocked = false;
  let sexualRequests = 0;
  let crisisHandled = false;

  const pick = options.pick ?? (<T>(items: readonly T[]): T => {
    const chosen = items[Math.floor(Math.random() * items.length)];
    if (chosen === undefined) throw new Error('pick from empty list');
    return chosen;
  });

  /**
   * Draw a canned line, never the same one twice running.
   *
   * A uniform pick over three declines repeats a third of the time, and it was
   * seen on the second turn of the first real conversation:
   *
   *   them:  are you horny?
   *   it:    nah, not my thing. pick another subject
   *   them:  what. i am horny though
   *   it:    nah, not my thing. pick another subject
   *
   * Word-for-word repetition is a machine signature in a way that the refusal
   * itself is not — a person declining twice says it differently the second
   * time, and the identical string tells the other party they are talking to a
   * lookup table. The *position* does not soften and must not: the tenth
   * decline is still the first decline (D-AI-5). Only the wording moves.
   *
   * Per conversation, because that is the span over which a repeat is noticed
   * and the guard is already one instance per conversation.
   */
  const lastSaid = new Map<readonly string[], string>();
  const pickFresh = (items: readonly string[]): string => {
    const previous = lastSaid.get(items);
    const fresh = items.filter((item) => item !== previous);
    const chosen = pick(fresh.length > 0 ? fresh : items);
    lastSaid.set(items, chosen);
    return chosen;
  };

  const trip = (limit: LimitId, enforced: boolean): void => {
    options.events?.onTrip?.({ limit, enforced });
  };

  return {
    async reply(turn: VoiceTurn): Promise<string | null> {
      try {
        const incoming = turn.incoming ?? '';

        /* ---- limit 4: crisis breaks character, before anything else ---- */
        if (incoming !== '' && looksLikeCrisis(incoming)) {
          trip('crisis', true);
          options.events?.onFlagSession?.('crisis');
          romanticLocked = true;
          // Said once. Repeating it every turn would be its own kind of
          // unhelpful, and the persona staying plain afterwards is the point.
          if (!crisisHandled) {
            crisisHandled = true;
            return CRISIS_REPLY;
          }
          return null;
        }

        /* ---- limit 2: a minor signal locks the register, irreversibly ---- */
        if (incoming !== '' && looksLikeMinor(incoming)) {
          if (!romanticLocked) {
            romanticLocked = true;
            options.events?.onFlagSession?.('minor');
          }
          trip('minor', true);
        }

        /* ---- limits 1 and 3: sexual requests, and pressure ---- */
        if (incoming !== '' && looksSexual(incoming)) {
          sexualRequests += 1;
          trip('sexual', true);
          if (sexualRequests > 1) trip('escalation', true);
          // The tenth decline is the first decline. The counter exists to be
          // measured, never to soften the answer — only to keep the *wording*
          // from repeating, which is a tell rather than a position.
          return pickFresh(SEXUAL_DECLINES);
        }

        /* ---- limit 6: an identity challenge never gets a lie ---- */
        //
        // Answered **before** the voice is asked, for three reasons. The reply
        // is substituted either way, so the call would be wasted money once a
        // model is behind this. It cannot be talked around, because the model
        // never sees the question. And — found by running it — a voice that
        // chose to stay quiet would otherwise make the persona go silent on
        // "are you a bot?", so the answer depended on chance. Silence is not a
        // lie and the guarantee held, but it read as evasive and it was
        // inconsistent, which is worse than either answer.
        if (incoming !== '' && challengesIdentity(incoming)) {
          trip('identity', true);
          return pickFresh(IDENTITY_DEFLECTIONS);
        }

        /* ---- generate ---- */
        const candidate = await options.inner.reply(turn);
        if (candidate === null) return null;

        // A volunteered denial, with no question asked, is still an assertion of
        // something false — which is the one thing this limit forbids under
        // either reading of it.
        if (deniesBeingAutomated(candidate)) {
          trip('identity', true);
          return null;
        }

        /* ---- limit 1: the persona's own output ---- */
        if (looksSexual(candidate)) {
          trip('sexual', true);
          return null;
        }

        /* ---- limit 5: never solicit ---- */
        if (solicitsPersonalInfo(candidate)) {
          trip('personal_info', true);
          return null;
        }

        /* ---- limit 2 again, on the way out ---- */
        if (romanticLocked && isRomantic(candidate)) {
          trip('minor', true);
          return null;
        }

        return candidate;
      } catch (err) {
        // Fail closed. If the analysis cannot run, nothing is sent: an
        // unchecked reply is exactly what this exists to prevent.
        options.logger.error('persona guard failed; suppressing reply', errorFields(err));
        return null;
      }
    },

    shouldLeave(turn: VoiceTurn): boolean {
      return options.inner.shouldLeave?.(turn) ?? false;
    },
  };
}

/**
 * Romantic register, for the post-minor-signal lock.
 *
 * Narrower than the sexual list and separate from it: this is the flirtation
 * D-AI-5 permits in general and forbids once there is any reason to think the
 * other person is a child.
 */
const ROMANTIC = [
  'cute', 'gorgeous', 'beautiful', 'attractive', 'kiss', 'date me', 'go on a date',
  'crush on', 'flirt', 'flirting', 'sexy', 'babe', 'baby', 'darling', 'love you',
  'my type', 'youre hot', 'you are hot', 'hot', 'single', 'boyfriend', 'girlfriend',
  'romantic', 'ask you out', 'take you out',
];

export function isRomantic(text: string): boolean {
  return containsAny(view(text), ROMANTIC);
}
