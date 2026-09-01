/**
 * karobakbak wire protocol — SINGLE SOURCE OF TRUTH.
 *
 * This file is duplicated byte-for-byte into frontend/src/protocol/types.ts.
 * `node scripts/verify-protocol.mjs` fails the build if the copies drift.
 * Do not import anything here: the file must be valid in both a Node and a
 * browser/Vite build with no shared tooling.
 *
 * Trust model
 * -----------
 * The server is authoritative for ALL identity and state. Nothing in a
 * client->server frame is trusted as identity, authorisation or ordering:
 *   - session id, user id, partner id, match id  -> resolved server-side
 *   - timestamps                                 -> ignored, server restamps
 *   - `id`                                       -> opaque correlation token,
 *                                                   echoed back and used only
 *                                                   as a per-match dedupe key
 */

export const PROTOCOL_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* Event names                                                                */
/* -------------------------------------------------------------------------- */

export const CLIENT_EVENTS = [
  'join_queue',
  'leave_queue',
  'leave_chat',
  'message',
  'typing',
  'react',
  'save_connection',
  'skip',
  'report',
  'block',
  'ping',
] as const;
export type ClientEventType = (typeof CLIENT_EVENTS)[number];

export const SERVER_EVENTS = [
  'connected',
  'queue_status',
  'presence',
  'matched',
  'message',
  'message_ack',
  'partner_typing',
  'partner_reacted',
  'connection_state',
  'connection_request',
  'connection_made',
  'partner_skipped',
  'partner_reconnecting',
  'partner_returned',
  'partner_disconnected',
  'report_ack',
  'error',
  'pong',
  'server_shutdown',
] as const;
export type ServerEventType = (typeof SERVER_EVENTS)[number];

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Every frame in either direction uses this envelope.
 *
 *   { "type": "message", "version": 1, "id": "c_ab12",
 *     "timestamp": "2026-08-18T09:12:03.114Z", "payload": { "text": "hi" } }
 *
 * `timestamp` on inbound frames is ignored; the server stamps its own on every
 * outbound frame.
 *
 * `id` on inbound frames is a client correlation token (<= MAX_CLIENT_ID_LENGTH
 * chars, [A-Za-z0-9_-]) returned verbatim in `message_ack.clientMsgId`. It is
 * **required on `message`** and optional on every other event: it doubles as
 * the per-match replay-protection key (DESIGN.md R4/D24), so a `message`
 * without one cannot be deduplicated and is rejected with `BAD_ENVELOPE`.
 *
 * It is still never an identity or an authorisation token. The dedupe set is
 * scoped to one match, so a client that guesses another client's id can only
 * collide inside its own conversation.
 */
export interface Envelope<TType extends string = string, TPayload = unknown> {
  type: TType;
  version: number;
  id?: string;
  timestamp?: string;
  payload: TPayload;
}

/**
 * How a returning browser presents its resume token (§28).
 *
 * A WebSocket subprotocol, because it is the only value a browser can attach to
 * a handshake — `new WebSocket(url, protocols)` — and unlike a query string it
 * does not end up in an access log. Namespaced so an unrelated subprotocol can
 * never be read as one.
 */
export const RESUME_PROTOCOL_PREFIX = 'kbb.resume.';

/**
 * Offered alongside a resume token, and the one the server selects.
 *
 * A WebSocket server must echo a protocol the client offered, so selecting the
 * resume entry would put the token in the *response* headers as well as the
 * request. Offering this plain marker beside it gives the server something
 * harmless to agree on.
 */
export const BASE_PROTOCOL = 'kbb.v1';

export const MAX_CLIENT_ID_LENGTH = 64;
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/* -------------------------------------------------------------------------- */
/* Session states (server-authoritative, mirrored to the client)              */
/* -------------------------------------------------------------------------- */

export const SESSION_STATES = ['IDLE', 'SEARCHING', 'MATCHED'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/* -------------------------------------------------------------------------- */
/* Message content type                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Content types this server implements. **Today this list is exactly `text`.**
 *
 * The discriminator exists so that a future content type can be added without
 * a protocol version bump and a dual-stack compatibility period on both ends.
 * It is the one media-related seam that is genuinely expensive to retrofit,
 * because the wire format is versioned and browsers cache old clients.
 *
 * It is NOT an announcement that other types are coming, and it is NOT a
 * capability list: a client sending anything other than `text` is rejected with
 * `UNSUPPORTED_CONTENT_TYPE`. See DESIGN.md §23.
 *
 * When a second type is implemented, it is added here AND announced through
 * `connected.features` so clients never have to hardcode what the server
 * accepts.
 */
export const MESSAGE_CONTENT_TYPES = ['text'] as const;
export type MessageContentType = (typeof MESSAGE_CONTENT_TYPES)[number];

/** The content type assumed when a client omits `payload.type`. */
export const DEFAULT_MESSAGE_CONTENT_TYPE: MessageContentType = 'text';

/**
 * Payload field names reserved for future media support.
 *
 * A frame containing any of these is **rejected**, not ignored. Silently
 * dropping an unknown field is how a client comes to believe it successfully
 * sent an attachment that the server never stored or delivered. Rejecting also
 * means a client cannot smuggle a fabricated media reference past a server that
 * has no concept of media (DESIGN.md §23.6).
 */
export const RESERVED_MEDIA_FIELDS = [
  'mediaId',
  'media',
  'attachment',
  'attachments',
  'blob',
  'file',
  'url',
] as const;

export function isMessageContentType(value: unknown): value is MessageContentType {
  return typeof value === 'string' && (MESSAGE_CONTENT_TYPES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Report categories                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The fixed reason set a reporter picks from (DESIGN.md §6.2, security §31,
 * UI §26).
 *
 * A closed enum rather than free text is deliberate: the category is the one
 * part of a report that is safe to put on a metric label or a triage queue,
 * because it carries no user-authored content. The reporter's own words go in
 * `note`, which is treated exactly like a message body (invariant I8).
 */
export const REPORT_CATEGORIES = [
  'harassment',
  'spam',
  'sexual_content',
  'grooming',
  'threats',
  'hate',
  'scam',
  'other',
] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export function isReportCategory(value: unknown): value is ReportCategory {
  return typeof value === 'string' && (REPORT_CATEGORIES as readonly string[]).includes(value);
}

/* -------------------------------------------------------------------------- */
/* Temporary identities                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A throwaway display identity, generated by the server per match.
 *
 * It exists so the UI can show something friendlier than "Stranger" and give
 * the two sides distinguishable accents (UI §20). It is **not** an account, is
 * not stable across matches, and carries no session id — an identity that
 * persisted across matches would be a deanonymisation primitive. Both sides'
 * identities are generated when the pair is formed and discarded when the
 * match ends.
 */
export interface Identity {
  /**
   * Server-generated display name. Never user-supplied.
   *
   * Still present when the user has set their own name: this is the fallback a
   * client shows when `profile.name` is null, and it is what keeps every match
   * displaying *something* without a client having to invent a placeholder.
   */
  nickname: string;
  /** CSS colour for the identity accent, e.g. "#7C5CFF". */
  colour: string;
  /**
   * What this side chose to tell strangers about themselves, or null.
   *
   * Entirely optional and entirely unverified — see `Profile`.
   */
  profile: Profile | null;
}

/* -------------------------------------------------------------------------- */
/* Self-declared profile (phase 14)                                           */
/* -------------------------------------------------------------------------- */

/**
 * Details a user volunteers so a conversation can start faster than
 * "asl" — a name to be called, a country, an age.
 *
 * ---------------------------------------------------------------------------
 * EVERY FIELD IS A CLAIM, NOT A FACT
 * ---------------------------------------------------------------------------
 * Nothing here is verified and nothing here can be. It is typed by an anonymous
 * stranger who may be lying, and both the UI and the moderation console must
 * present it as "what they said about themselves", never as an attribute of the
 * person. In particular `age` is **not age assurance** (security §24) and must
 * never be described as such anywhere in this system.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SHAPES ARE CONSTRAINED
 * ---------------------------------------------------------------------------
 * `country` is a code from a fixed list rather than free text, and `age` is a
 * bounded integer, because a free-text "location" field is somewhere to type a
 * street address or a phone number and a free-text age is somewhere to type a
 * sentence. Only `name` is free text, and it is the one field that therefore
 * goes through the same validation and moderation as a message body.
 *
 * The profile is sent by the client on `join_queue` and lives for the life of
 * the session. The server stores nothing between sessions: remembering it is
 * the browser's job (UI-side), so a returning user re-declares rather than
 * being recognised. A profile the *server* kept against a durable identifier
 * would be the cross-chat correlator `DESIGN.md` §24.3 forbids.
 */
export interface Profile {
  /** What they want to be called. User content, moderated (I8). */
  name: string | null;
  /** ISO 3166-1 alpha-2, from `COUNTRY_CODES`. */
  country: string | null;
  /** Self-declared, integer, `MIN_DECLARED_AGE`..`MAX_DECLARED_AGE`. */
  age: number | null;
  /** Self-declared, from `GENDERS`. */
  gender: string | null;
}

/** An empty profile — every field declined. */
export const EMPTY_PROFILE: Profile = {
  name: null,
  country: null,
  age: null,
  gender: null,
};

/**
 * The gender values a user may declare.
 *
 * A closed list rather than free text, for the same reason `country` is a code:
 * a free-text identity field is somewhere to write a sentence, a slur or a
 * contact handle, and it would need moderating like a message body. Omitting
 * the field *is* "prefer not to say", so there is no option for it — an
 * explicit "prefer not to say" would be a fourth way of saying nothing.
 *
 * **Declared, and now read by matchmaking as a preference** (D44, §29) — this
 * paragraph used to say the opposite and was true until phase 18.
 *
 * It is a *preference* and never a filter: `tryMatch` takes a candidate who
 * matches if one is in view and an ordinary candidate on the same pass if none
 * is, so no seat is ever held. What that does not change is what the value is.
 * It is still a claim typed by an anonymous stranger and verified by nothing,
 * exactly as `age` is not age assurance (§26.4, D36), and D37's warning stands
 * unmitigated: the day a preference can be bought, declaring a scarce value
 * acquires cash value. Nothing here may be described to a user as more than
 * "a higher chance".
 */
export const GENDERS = ['female', 'male', 'nonbinary', 'other'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * What a searcher would like their next partner to be (D44, §29).
 *
 * A **preference**, never a filter: if nobody in view matches, the search takes
 * an ordinary partner on the same pass rather than waiting. Every field is
 * optional and an absent one is simply not scored.
 *
 * Carried on `join_queue` and stored on the session, exactly like the profile
 * and for the same reason (D34): a preference the server kept against a durable
 * identifier would be a cross-session record of what somebody looks for, which
 * §24.3 forbids as firmly as it forbids keeping the profile. It dies with the
 * session and the browser re-sends it.
 *
 * A join carries the **whole** preference. A field the client stops sending is
 * cleared, because there is no partial update — the same rule the profile
 * follows.
 */
export interface MatchPreferences {
  /** Values from `GENDERS`. */
  genders: string[];
  /** Codes from `COUNTRY_CODES`. */
  countries: string[];
}

/** No preference at all, which is what every free session sends. */
export const EMPTY_PREFERENCES: MatchPreferences = { genders: [], countries: [] };

/**
 * How many values one dimension may carry.
 *
 * Bounded because the list becomes a comma-joined string on a Redis hash and is
 * substring-searched once per candidate per attempt. Four is already every
 * gender, so this only binds on country — where asking for fifty is not a
 * preference, it is an absence of one expressed at length.
 */
export const MAX_PREFERENCE_VALUES = 8;

/**
 * What a searcher is here for (D45, §30).
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A PROFILE FIELD, AND THE SEPARATION IS THE FEATURE
 * ---------------------------------------------------------------------------
 * `Profile` is defined as the thing sent to the other side. Intent is declared
 * by the same client on the same frame and is deliberately **not** a member of
 * it, so there is no `matched` payload, no console column and no persona
 * surface that can carry it by accident. `readProfiles` reads a fixed field
 * list and `intent` is not in it — that read is the whole path from the session
 * hash to a partner's screen, so a value outside the list cannot reach one.
 *
 * The honest limit, which the UI copy must not overstate away: not *shown* is
 * not *unknowable*. Two people paired on `venting` are likelier than chance to
 * share it, so the claim is that the value is never displayed, never that a
 * partner cannot guess it.
 *
 * ---------------------------------------------------------------------------
 * SYMMETRIC, AND THEREFORE FREE
 * ---------------------------------------------------------------------------
 * Unlike gender and country, intent is not a preference *list*: there is one
 * selector and the score rewards a candidate who chose the **same** value.
 * Wanting to be matched on it is wanting the same thing as the person you are
 * matched with, so there is nothing for a second control to express.
 *
 * That symmetry is why it ships to everybody rather than behind
 * `FILTERS_ENABLED`. The premium dimensions are asymmetric — one party gets
 * what they asked for and the other is selected — which is what makes them
 * worth charging for and what makes D37's warning apply to them. Intent has no
 * selected party, so it carries neither property.
 *
 * It is scored at 1, below country at 2 and gender at 4, and it **does not
 * trigger the wide sample** (§30.2). Escalation is the expensive half of D44
 * and it stays paid for: a free dimension that widened every search would put
 * `PREFERENCE_WIDE_SAMPLE` reads on the hot path for the whole population.
 * Intent is scored in whatever sample is drawn and never asks for a bigger one.
 *
 * ---------------------------------------------------------------------------
 * `flirty` IS IN THE LIST, AND SYMMETRY IS WHY IT CAN BE
 * ---------------------------------------------------------------------------
 * §29.9 refused to make `flirty` a matching signal without its own decision.
 * This is that decision, and the reasoning that unlocks it is the shape change
 * rather than a change of appetite.
 *
 * §29.9 was written against D44, where the third dimension was a preference
 * *list*: a user said which values they wanted in a **stranger**, so `flirty`
 * meant "find me somebody flirty" and pointed outward at people who had not
 * asked for it. That is a targeting tool, and it is what the section objected
 * to.
 *
 * Intent is symmetric. `flirty` here means "I am here to flirt" and scores only
 * against a candidate who said the same thing. It cannot be pointed at anybody:
 *
 *     old (D44)   flirty-seeker -> anyone            targeting
 *     now (D45)   flirty        <-> flirty only      routing
 *
 * Routing also works in the direction nobody asks for. Pairing flirty with
 * flirty is what keeps it away from somebody who chose `venting`, and an
 * unwanted opener is the most common complaint about this category of product.
 * The pool has no mechanism for that today, and this is it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES NOT FIX, STATED PLAINLY
 * ---------------------------------------------------------------------------
 * There is **no age assurance anywhere in this system**. The age gate is the
 * whole of the minor-safety enforcement (`minor-safety-policy.md` §3), `age` is
 * a claim anyone can type (§26.4, D36), and symmetry does nothing about either.
 * A minor who passed the gate by lying can select this value and be paired with
 * an adult who selected it.
 *
 * That is the residual risk and it is not mitigated here. It is unchanged by
 * this decision in the sense that the gate is the control either way — but it
 * is the reason this value stays reviewable rather than settled, and the reason
 * personas are excluded from it below.
 *
 * It also reaches the s.79 safe-harbour argument and the payment processor's
 * and ad networks' terms on dating and adult content. Those are documents to
 * update, not reasons the code cannot carry the value.
 *
 * ---------------------------------------------------------------------------
 * The list is closed for the reason `GENDERS` is: a free-text mood field is
 * somewhere to write a sentence, a slur or a contact handle, and it would then
 * need moderating like a message body. Declining *is* "no intent", so there is
 * no option for it.
 *
 * `flirty` is never declared by a persona (`SAFE_INTENTS` in
 * `personas/surface.ts`). Everything a persona says is the operator's own
 * speech (D-AI-11), already outside the s.79 safe harbour, and declaring sexual
 * intent on the operator's behalf to a stranger of unverified age is the one
 * piece of realism not worth having. That exclusion is not softened by
 * symmetry: the objection there was never targeting, it was authorship.
 *
 * `venting` is the one value that is not obviously symmetric — two people who
 * both want to be heard is not two people listening. It ships because the
 * alternative pairing is worse (somebody wanting to vent matched with somebody
 * wanting jokes), and because a preference can only ever improve on the random
 * partner it replaces. Worth revisiting against §30.4's numbers rather than
 * assuming either way.
 */
export const INTENTS = ['chat', 'deep', 'funny', 'venting', 'flirty'] as const;
export type Intent = (typeof INTENTS)[number];

export function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

export function isGender(value: unknown): value is Gender {
  return typeof value === 'string' && (GENDERS as readonly string[]).includes(value);
}

/**
 * The lowest age this service accepts as a declaration.
 *
 * A lower number submitted here is refused with `AGE_BELOW_MINIMUM` and is not
 * stored as a profile value, because publishing a self-declared minor's age to
 * random strangers is the targeting primitive that security §23 lists
 * "repeated attempts to establish age" as a *grooming signal* for.
 *
 * This is a floor on what may be *declared*. It is not an age gate, and it does
 * not make the service safe for or closed to minors — that is the minor-safety
 * policy and age-assurance work which security §24 requires legal counsel to
 * settle before public launch, and which is not this.
 */
export const MIN_DECLARED_AGE = 18;

/** Upper bound, so the field holds an age rather than an arbitrary number. */
export const MAX_DECLARED_AGE = 99;

/** Longest display name. Short enough to sit in a chat header on a phone. */
export const MAX_DISPLAY_NAME_LENGTH = 24;

/**
 * ISO 3166-1 alpha-2 codes.
 *
 * The code is the value that travels and the value anything ever matches on;
 * `COUNTRY_NAMES` below is only how it is spelled for a human. A code is stable
 * when an English name changes, is exact to filter on, and is the same three
 * bytes in every language.
 *
 * The list is the full standard rather than a curated subset: any shorter list
 * is a set of arbitrary exclusions that someone will eventually read as a
 * statement.
 */
export const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
] as const;

export type CountryCode = (typeof COUNTRY_CODES)[number];

export function isCountryCode(value: unknown): value is CountryCode {
  return typeof value === 'string' && (COUNTRY_CODES as readonly string[]).includes(value);
}

/**
 * English display names, keyed by code.
 *
 * The code is what travels and what anything ever matches on; this is only how
 * it is spelled for a human. Both the chat client and the moderation console
 * render country names, so the map ships with the protocol rather than being
 * duplicated in two packages that would drift.
 *
 * Short names, not the formal ISO long forms — "South Korea" rather than
 * "Korea, Republic of" — because this appears in a chat header next to a first
 * name, not in a customs declaration.
 */
export const COUNTRY_NAMES: Record<CountryCode, string> = {
  AD: 'Andorra', AE: 'United Arab Emirates', AF: 'Afghanistan', AG: 'Antigua and Barbuda',
  AI: 'Anguilla', AL: 'Albania', AM: 'Armenia', AO: 'Angola', AQ: 'Antarctica', AR: 'Argentina',
  AS: 'American Samoa', AT: 'Austria', AU: 'Australia', AW: 'Aruba', AX: 'Åland Islands',
  AZ: 'Azerbaijan', BA: 'Bosnia and Herzegovina', BB: 'Barbados', BD: 'Bangladesh', BE: 'Belgium',
  BF: 'Burkina Faso', BG: 'Bulgaria', BH: 'Bahrain', BI: 'Burundi', BJ: 'Benin',
  BL: 'Saint Barthélemy', BM: 'Bermuda', BN: 'Brunei', BO: 'Bolivia', BQ: 'Caribbean Netherlands',
  BR: 'Brazil', BS: 'Bahamas', BT: 'Bhutan', BV: 'Bouvet Island', BW: 'Botswana', BY: 'Belarus',
  BZ: 'Belize', CA: 'Canada', CC: 'Cocos (Keeling) Islands', CD: 'DR Congo',
  CF: 'Central African Republic', CG: 'Republic of the Congo', CH: 'Switzerland',
  CI: "Côte d'Ivoire", CK: 'Cook Islands', CL: 'Chile', CM: 'Cameroon', CN: 'China',
  CO: 'Colombia', CR: 'Costa Rica', CU: 'Cuba', CV: 'Cape Verde', CW: 'Curaçao',
  CX: 'Christmas Island', CY: 'Cyprus', CZ: 'Czechia', DE: 'Germany', DJ: 'Djibouti',
  DK: 'Denmark', DM: 'Dominica', DO: 'Dominican Republic', DZ: 'Algeria', EC: 'Ecuador',
  EE: 'Estonia', EG: 'Egypt', EH: 'Western Sahara', ER: 'Eritrea', ES: 'Spain', ET: 'Ethiopia',
  FI: 'Finland', FJ: 'Fiji', FK: 'Falkland Islands', FM: 'Micronesia', FO: 'Faroe Islands',
  FR: 'France', GA: 'Gabon', GB: 'United Kingdom', GD: 'Grenada', GE: 'Georgia',
  GF: 'French Guiana', GG: 'Guernsey', GH: 'Ghana', GI: 'Gibraltar', GL: 'Greenland',
  GM: 'Gambia', GN: 'Guinea', GP: 'Guadeloupe', GQ: 'Equatorial Guinea', GR: 'Greece',
  GS: 'South Georgia and the South Sandwich Islands', GT: 'Guatemala', GU: 'Guam',
  GW: 'Guinea-Bissau', GY: 'Guyana', HK: 'Hong Kong', HM: 'Heard and McDonald Islands',
  HN: 'Honduras', HR: 'Croatia', HT: 'Haiti', HU: 'Hungary', ID: 'Indonesia', IE: 'Ireland',
  IL: 'Israel', IM: 'Isle of Man', IN: 'India', IO: 'British Indian Ocean Territory', IQ: 'Iraq',
  IR: 'Iran', IS: 'Iceland', IT: 'Italy', JE: 'Jersey', JM: 'Jamaica', JO: 'Jordan', JP: 'Japan',
  KE: 'Kenya', KG: 'Kyrgyzstan', KH: 'Cambodia', KI: 'Kiribati', KM: 'Comoros',
  KN: 'Saint Kitts and Nevis', KP: 'North Korea', KR: 'South Korea', KW: 'Kuwait',
  KY: 'Cayman Islands', KZ: 'Kazakhstan', LA: 'Laos', LB: 'Lebanon', LC: 'Saint Lucia',
  LI: 'Liechtenstein', LK: 'Sri Lanka', LR: 'Liberia', LS: 'Lesotho', LT: 'Lithuania',
  LU: 'Luxembourg', LV: 'Latvia', LY: 'Libya', MA: 'Morocco', MC: 'Monaco', MD: 'Moldova',
  ME: 'Montenegro', MF: 'Saint Martin', MG: 'Madagascar', MH: 'Marshall Islands',
  MK: 'North Macedonia', ML: 'Mali', MM: 'Myanmar', MN: 'Mongolia', MO: 'Macao',
  MP: 'Northern Mariana Islands', MQ: 'Martinique', MR: 'Mauritania', MS: 'Montserrat',
  MT: 'Malta', MU: 'Mauritius', MV: 'Maldives', MW: 'Malawi', MX: 'Mexico', MY: 'Malaysia',
  MZ: 'Mozambique', NA: 'Namibia', NC: 'New Caledonia', NE: 'Niger', NF: 'Norfolk Island',
  NG: 'Nigeria', NI: 'Nicaragua', NL: 'Netherlands', NO: 'Norway', NP: 'Nepal', NR: 'Nauru',
  NU: 'Niue', NZ: 'New Zealand', OM: 'Oman', PA: 'Panama', PE: 'Peru', PF: 'French Polynesia',
  PG: 'Papua New Guinea', PH: 'Philippines', PK: 'Pakistan', PL: 'Poland',
  PM: 'Saint Pierre and Miquelon', PN: 'Pitcairn Islands', PR: 'Puerto Rico', PS: 'Palestine',
  PT: 'Portugal', PW: 'Palau', PY: 'Paraguay', QA: 'Qatar', RE: 'Réunion', RO: 'Romania',
  RS: 'Serbia', RU: 'Russia', RW: 'Rwanda', SA: 'Saudi Arabia', SB: 'Solomon Islands',
  SC: 'Seychelles', SD: 'Sudan', SE: 'Sweden', SG: 'Singapore', SH: 'Saint Helena',
  SI: 'Slovenia', SJ: 'Svalbard and Jan Mayen', SK: 'Slovakia', SL: 'Sierra Leone',
  SM: 'San Marino', SN: 'Senegal', SO: 'Somalia', SR: 'Suriname', SS: 'South Sudan',
  ST: 'São Tomé and Príncipe', SV: 'El Salvador', SX: 'Sint Maarten', SY: 'Syria',
  SZ: 'Eswatini', TC: 'Turks and Caicos Islands', TD: 'Chad', TF: 'French Southern Territories',
  TG: 'Togo', TH: 'Thailand', TJ: 'Tajikistan', TK: 'Tokelau', TL: 'Timor-Leste',
  TM: 'Turkmenistan', TN: 'Tunisia', TO: 'Tonga', TR: 'Türkiye', TT: 'Trinidad and Tobago',
  TV: 'Tuvalu', TW: 'Taiwan', TZ: 'Tanzania', UA: 'Ukraine', UG: 'Uganda',
  UM: 'U.S. Minor Outlying Islands', US: 'United States', UY: 'Uruguay', UZ: 'Uzbekistan',
  VA: 'Vatican City', VC: 'Saint Vincent and the Grenadines', VE: 'Venezuela',
  VG: 'British Virgin Islands', VI: 'U.S. Virgin Islands', VN: 'Vietnam', VU: 'Vanuatu',
  WF: 'Wallis and Futuna', WS: 'Samoa', YE: 'Yemen', YT: 'Mayotte', ZA: 'South Africa',
  ZM: 'Zambia', ZW: 'Zimbabwe',
};

/** The display name for a code, or the code itself if it is somehow unknown. */
export function countryName(code: string | null): string | null {
  if (code === null) return null;
  return (COUNTRY_NAMES as Record<string, string>)[code] ?? code;
}

/* -------------------------------------------------------------------------- */
/* Client -> server payloads                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Enter matchmaking. Idempotent while already SEARCHING. Changes state.
 *
 * `profile` is optional and re-sent on every join, because the server keeps
 * nothing between sessions. Omitting it clears any profile the session had:
 * there is no partial update, so a client cannot end up displaying a stale
 * field it thought it had removed.
 */
export interface JoinQueuePayload {
  profile?: Profile;
  /**
   * What a searcher is looking for, and what they are here for.
   *
   * Both ride the join beside the profile and both are session-scoped (D34):
   * the browser re-sends them every time, the server keeps neither between
   * sessions, and a field the client stops sending is cleared rather than
   * remembered. A join carries the whole of each — there is no partial update.
   *
   * `intent` is a single value from `INTENTS` and is never shown to a partner.
   */
  preference?: MatchPreferences;
  intent?: string | null;
}

/** Leave matchmaking without disconnecting. Idempotent. Changes state. */
export type LeaveQueuePayload = Record<string, never>;

/**
 * End the current match and return to IDLE, without searching again.
 *
 * The difference from `skip` is the whole point. `skip` re-enters the queue, so
 * a user who wanted to stop is dropped straight into another conversation —
 * which is the same reasoning that already makes `block` land in IDLE rather
 * than back in the queue. Leaving is a statement about wanting to stop, and the
 * protocol has to be able to express it, or a client has to fake it with
 * `skip` + `leave_queue` and lose the race whenever the skip re-matches first.
 *
 * Idempotent: leaving when not matched is "ensure I am idle", never an error.
 * Changes state.
 */
export type LeaveChatPayload = Record<string, never>;

/**
 * Save this stranger, so the two of you can talk again later (§31, D47).
 *
 * ---------------------------------------------------------------------------
 * MUTUAL CONSENT, AND THE LEAK IT IS BUILT TO AVOID
 * ---------------------------------------------------------------------------
 * A connection still exists only when both sides have agreed, and
 * `connection_made` is still the frame that says so, sent to both at the same
 * moment. What changed is that asking is now **announced** to the person being
 * asked (`connection_request`), where it used to be silent until reciprocated.
 *
 * D47 originally refused that, and the reasoning is kept here because it is
 * what the reversal cost: telling A that B asked hands A a fact that B chose to
 * disclose only on condition of reciprocity. Somebody who declines now knows
 * that this particular stranger wanted to connect, which they previously did
 * not.
 *
 * It was overruled deliberately, on the ground that a silent request is
 * indistinguishable from a broken button: the asker sees nothing happen, and
 * the person who might have said yes is never given the chance. Both sides are
 * present in a live conversation, which is the setting that makes the ask
 * ordinary rather than a disclosure about somebody who is not there.
 *
 * The bound that remains: a request is announced, a **refusal never is**.
 * Ignoring produces no frame at all, so declining stays private and the asker
 * learns only what silence tells them.
 *
 * The residual inference is unchanged: a conversation that ends with no
 * `connection_made` tells a saver that the other side did not agree. That is
 * inherent to mutual consent — every system of this shape has it — and it is
 * bounded to "they did not", never to when or why.
 *
 * `active` is a toggle so a mis-tap is recoverable while the conversation is
 * still running. It does **not** undo a connection that has already been made:
 * once both sides agreed, the relationship exists and removing it is an action
 * on the friend list, taken by one person, with the other not told.
 *
 * Requires an account. Without one the command is refused rather than queued —
 * there is nothing to attach a connection to, and a silent no-op would show a
 * saved state that could never become a connection.
 *
 * Idempotent. Changes state.
 */
export interface SaveConnectionPayload {
  /** False withdraws it, while the conversation is still running. */
  active: boolean;
}

/**
 * Your own save state, echoed back.
 *
 * Deliberately carries nothing about the partner. It is the acknowledgement of
 * *your* command, so the UI can show a pressed button without inventing local
 * state that the server might disagree with.
 */
export interface ConnectionStatePayload {
  matchId: string;
  saved: boolean;
}

/**
 * Both sides saved. Sent to both, at the same moment, and never otherwise.
 *
 * This is the only frame in the protocol that reveals anything about the
 * partner's decision, and it can only be emitted when that decision was to
 * agree — so there is no state in which it discloses a refusal.
 */
/**
 * Somebody in this conversation has asked to connect.
 *
 * Sent once, to the other side only, when a save arrives and that side has not
 * saved. It names nothing about the asker beyond the conversation both are
 * already in — the recipient can already see who they are talking to.
 *
 * There is deliberately no frame for the opposite direction. Declining sends
 * nothing, so a refusal is never disclosed; see the note on `save_connection`.
 */
export interface ConnectionRequestPayload {
  readonly matchId: string;
}

export interface ConnectionMadePayload {
  matchId: string;
}

/** End the current match and immediately search again. Idempotent. Changes state. */
export type SkipPayload = Record<string, never>;

/**
 * End the current match and refuse future matches with this partner.
 * Idempotent. Changes state (MATCHED -> IDLE).
 *
 * The blocked party is never told they were blocked: they receive
 * `partner_skipped`, exactly as for an ordinary skip (security §32).
 */
export type BlockPayload = Record<string, never>;

/** Liveness probe; also refreshes server-side session TTLs. No state change. */
export type PingPayload = Record<string, never>;

/**
 * Send one chat message to the current partner.
 *
 * Idempotent within the dedupe window: the envelope `id` is required, and an
 * id already accepted for this match is rejected with `DUPLICATE_MESSAGE`
 * rather than delivered twice (I14). A client retrying a send after a dropped
 * connection resends the same frame.
 *
 * The recipient is NEVER specified by the client; it is resolved from the
 * server's authoritative match record.
 */
export interface MessagePayload {
  /**
   * Content type. Optional; defaults to `text`.
   *
   * Only `text` is accepted today — any other value, including a future type
   * this server does not yet implement, is rejected with
   * `UNSUPPORTED_CONTENT_TYPE`. A client cannot use this field to opt into
   * behaviour the server has not shipped.
   */
  type?: MessageContentType;
  /** The message body. Required for `text`, which is the only current type. */
  text: string;
}

/**
 * Typing indicator. Fire-and-forget: there is no acknowledgement, and the
 * partner may never see it if their socket is slow or their session ended.
 *
 * `active` is an explicit boolean rather than a repeated "still typing" pulse,
 * so stopping is an event in its own right instead of the absence of one.
 */
export interface TypingPayload {
  active: boolean;
}

/**
 * Report the current partner.
 *
 * Does not end the match: a user may report and keep talking, or report and
 * then block (DESIGN.md §5). Not idempotent — each frame files a report.
 *
 * `note` is the reporter's own words. It is user-generated content and carries
 * exactly the protection class of a message body: never logged, never a metric
 * label, never leaves the trusted boundary (I8).
 */
export interface ReportPayload {
  category: ReportCategory;
  note?: string;
}

export interface ClientEventPayloads {
  join_queue: JoinQueuePayload;
  leave_queue: LeaveQueuePayload;
  leave_chat: LeaveChatPayload;
  message: MessagePayload;
  typing: TypingPayload;
  react: ReactPayload;
  save_connection: SaveConnectionPayload;
  skip: SkipPayload;
  report: ReportPayload;
  block: BlockPayload;
  ping: PingPayload;
}

export type ClientEnvelope<T extends ClientEventType = ClientEventType> = Envelope<
  T,
  ClientEventPayloads[T]
>;

/* -------------------------------------------------------------------------- */
/* Server -> client payloads                                                  */
/* -------------------------------------------------------------------------- */

/** Limits the server actually enforces, so the UI can pre-validate. */
export interface ServerLimits {
  maxMessageLength: number;
  maxReportNoteLength: number;
  messagesPerSecond: number;
  burst: number;
  /** Sustained `typing` frames per second, so the UI throttles instead of being limited. */
  typingPerSecond: number;
  maxFrameBytes: number;
}

/**
 * Which optional behaviours this server has enabled.
 *
 * The UI hides the controls it is told about rather than shipping one build
 * per configuration, and never has to infer a capability from a rejection.
 */
export interface ServerFeatures {
  typing: boolean;
  presence: boolean;
  report: boolean;
  block: boolean;
}

/**
 * First frame after a successful upgrade.
 * `sessionId` is the client's OWN server-generated id, sent for log
 * correlation only. It grants no capability: there is no session resumption,
 * and no inbound frame is authorised by it.
 */
export interface ConnectedPayload {
  sessionId: string;
  protocolVersion: number;
  serverTime: string;
  limits: ServerLimits;
  features: ServerFeatures;
  /**
   * A single-use credential for reclaiming *this* session after a dropped
   * socket or a page refresh (§28).
   *
   * Rotated on every successful resume, so a captured token works once and only
   * until its owner reconnects. Belongs in `sessionStorage`, not
   * `localStorage`: it should die with the tab, exactly as a conversation does.
   *
   * Empty when resumption is disabled, in which case a reconnect is a new
   * session exactly as it was before (D7).
   */
  resumeToken: string;
  /**
   * How long a dropped socket keeps its seat, in seconds. 0 means resumption is
   * off. Sent so the client can count down honestly rather than hardcoding a
   * number that would drift from the server's.
   */
  resumeGraceSeconds: number;
  /**
   * Present when this connection resumed a conversation that was already in
   * progress. The client restores the chat from it rather than showing a
   * landing screen and losing the transcript.
   */
  resumed?: MatchedPayload;
}

/** Result of join_queue / leave_queue / a no-op skip. */
export interface QueueStatusPayload {
  state: SessionState;
  /** Global number of sessions currently waiting. Coarse, cached, non-authoritative. */
  waiting: number;
}

/**
 * Live activity counts, pushed on connect and periodically after that.
 *
 * Both numbers are real Redis cardinalities, cached for an interval and
 * therefore lagging (D21). `approximate` is the literal `true` on the wire so
 * the UI is structurally unable to present them as exact: fabricated or
 * precise-looking social proof is a trust bug that cannot be walked back
 * (UI §5.1).
 */
export interface PresencePayload {
  online: number;
  conversations: number;
  approximate: true;
}

/**
 * A pair was formed. The partner's session id is deliberately NOT included.
 *
 * `you` and `partner` are throwaway per-match display identities (see
 * `Identity`); they are server-generated and mean nothing outside this match.
 */
export interface MatchedPayload {
  matchId: string;
  startedAt: string;
  you: Identity;
  partner: Identity;
}

/**
 * Inbound message from the stranger. `text` is untrusted plain text.
 *
 * `type` is always present on outbound frames, even though it is optional
 * inbound, so a client renderer can dispatch on it unconditionally rather than
 * defaulting. That is what keeps the frontend from being written as
 * "if text then render text" (DESIGN.md §23.4).
 */
export interface IncomingMessagePayload {
  matchId: string;
  messageId: string;
  type: MessageContentType;
  text: string;
  sentAt: string;
  from: 'partner';
}

/**
 * What became of a message the server accepted.
 *
 * This replaced a boolean named `delivered`, which reported the *moderation
 * verdict* and nothing else — it was true whenever policy allowed the message
 * on, regardless of whether anybody received it. That was defensible under D7,
 * where a partner without a socket meant the conversation had ended and the
 * sender was told so. Under §28 the seat is held for a grace window, so
 * "matched, partner has no socket" is a normal state lasting tens of seconds,
 * and every message sent into it was acked `delivered: true` and reached
 * nobody. A field called `delivered` saying so is the protocol misleading the
 * client, and the client rendered it as "sent".
 *
 * None of these is a read receipt, and `routed` is deliberately not called
 * `delivered`: it means the message was handed to whatever owns the partner's
 * socket, which for `route: "remote"` is Redis Pub/Sub.
 */
export type MessageAckStatus =
  /** Handed on towards the partner. The best this protocol promises (D14). */
  | 'routed'
  /**
   * Accepted and recorded, and withheld from the partner by policy (D20).
   *
   * Reported here rather than as an error because the frame was valid and
   * there is nothing to retry. The sender is told, because an ack
   * indistinguishable from delivery teaches users that "sent" means nothing.
   */
  | 'withheld'
  /**
   * Accepted and recorded, and nobody was there to receive it.
   *
   * The partner's socket was gone at the moment it was routed. Nothing is
   * buffered (D43), so this message will not arrive later — saying so is the
   * whole point, because the alternative is a "sent" tick for a message that
   * went nowhere.
   */
  | 'undelivered';

export interface MessageAckPayload {
  clientMsgId: string | null;
  messageId: string;
  matchId: string;
  acceptedAt: string;
  route: 'local' | 'remote';
  status: MessageAckStatus;
}

/**
 * The reactions a message may carry.
 *
 * A closed list for the same reason `GENDERS` and `INTENTS` are closed: an open
 * set — an arbitrary emoji, or free text — is a content field arriving through
 * a path built to carry none, and it would need moderating like a message body.
 *
 * Five, and the list is the whole vocabulary: a client may send nothing else
 * and a client may receive nothing else. Adding a sixth is a change here and
 * nowhere else on the server, which is what the closed set buys.
 *
 * Named by meaning rather than by glyph — `laugh`, not an emoji — so the wire
 * value survives a client rendering it differently, a console reading it years
 * later, and a platform where the character does not exist. The picture is the
 * frontend's business.
 */
export const REACTIONS = ['like', 'heart', 'laugh', 'wow', 'sad'] as const;
export type Reaction = (typeof REACTIONS)[number];

export function isReaction(value: unknown): value is Reaction {
  return typeof value === 'string' && (REACTIONS as readonly string[]).includes(value);
}

/**
 * React to one message. Fire-and-forget, exactly like `typing`.
 *
 * ---------------------------------------------------------------------------
 * EPHEMERAL, AND THEREFORE NOT RECALLABLE
 * ---------------------------------------------------------------------------
 * A reaction is delivered or it is not. It is never written to PostgreSQL, never
 * part of a retained transcript, and never seen by a moderator — which is what
 * keeps a feature this small from adding a record type, a moderation surface
 * and a console view.
 *
 * `active` mirrors `typing`, and for the same reason: stopping is an event in
 * its own right rather than the absence of one.
 *
 * An earlier version refused to carry it, on the argument that a delivered
 * reaction has already been seen so withdrawing it describes something that did
 * not happen. That is an argument against claiming the partner *un-saw* it, and
 * it is not what removing one means. A reaction is current state — "I have a
 * heart on this message" — and `active: false` says that is no longer true,
 * which is both honest and deliverable.
 *
 * `messageId` is **echoed, not resolved.** The server routes by session (rule 3)
 * and does not check that the id names a message in this conversation: doing so
 * would mean a lookup on an advisory path, and the receiving client either
 * matches it against a message it holds or ignores it. An id naming nothing is
 * inert.
 */
export interface ReactPayload {
  messageId: string;
  reaction: string;
  /** False removes it. Explicit, so removal is never inferred from silence. */
  active: boolean;
}

/** The partner reacted to one of the messages on screen. Advisory only. */
export interface PartnerReactedPayload {
  matchId: string;
  messageId: string;
  reaction: string;
  active: boolean;
}

/** The partner started or stopped typing. Advisory only. */
export interface PartnerTypingPayload {
  matchId: string;
  active: boolean;
}

/**
 * The stranger's socket dropped and their seat is being held (§28).
 *
 * Distinct from `partner_disconnected`, which means they are gone for good. The
 * difference matters: told "they left", a person moves on; told "they are
 * reconnecting", they wait — and most of the time the conversation resumes.
 *
 * Messages sent during this window are **not** delivered and not buffered.
 * Buffering them would mean writing message text to a Redis key, which is
 * exactly what invariant I8 forbids, so the client disables the composer
 * instead of pretending it is going through.
 */
export interface PartnerReconnectingPayload {
  matchId: string;
  /** When the seat is given up, ISO 8601, for an honest countdown. */
  until: string;
}

/** They made it back inside the window; the conversation carries on. */
export interface PartnerReturnedPayload {
  matchId: string;
}

export interface PartnerSkippedPayload {
  matchId: string;
}

export interface PartnerDisconnectedPayload {
  matchId: string;
}

/**
 * A report was recorded.
 *
 * Deliberately empty of moderation detail: no verdict, no indication of what
 * happens next, nothing about the reported user (security §31). Telling a
 * reporter what enforcement followed would leak another user's state and would
 * turn reporting into a probe for it.
 */
export interface ReportAckPayload {
  reportId: string;
  acceptedAt: string;
}

/** Never contains Redis state, stack traces, internal ids or message text. */
export interface ErrorPayload {
  code: ProtocolErrorCode;
  message: string;
  /** true when the same operation may succeed if retried later. */
  retryable: boolean;
}

export interface PongPayload {
  serverTime: string;
}

export interface ServerShutdownPayload {
  reason: 'shutdown';
}

export interface ServerEventPayloads {
  connected: ConnectedPayload;
  queue_status: QueueStatusPayload;
  presence: PresencePayload;
  matched: MatchedPayload;
  message: IncomingMessagePayload;
  message_ack: MessageAckPayload;
  partner_typing: PartnerTypingPayload;
  partner_reacted: PartnerReactedPayload;
  connection_state: ConnectionStatePayload;
  connection_request: ConnectionRequestPayload;
  connection_made: ConnectionMadePayload;
  partner_skipped: PartnerSkippedPayload;
  partner_reconnecting: PartnerReconnectingPayload;
  partner_returned: PartnerReturnedPayload;
  partner_disconnected: PartnerDisconnectedPayload;
  report_ack: ReportAckPayload;
  error: ErrorPayload;
  pong: PongPayload;
  server_shutdown: ServerShutdownPayload;
}

export type ServerEnvelope<T extends ServerEventType = ServerEventType> = Envelope<
  T,
  ServerEventPayloads[T]
>;

/** Discriminated union of every server frame, for exhaustive client handling. */
export type AnyServerEnvelope = {
  [K in ServerEventType]: Envelope<K, ServerEventPayloads[K]>;
}[ServerEventType];

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export const PROTOCOL_ERROR_CODES = [
  /** Frame was not valid JSON. */
  'BAD_JSON',
  /** Frame was JSON but not a well-formed envelope, or a `message` carried no `id`. */
  'BAD_ENVELOPE',
  /** `version` is not PROTOCOL_VERSION. */
  'UNSUPPORTED_VERSION',
  /** `type` is not a known client event. */
  'UNKNOWN_EVENT',
  /** Payload failed per-event validation. */
  'VALIDATION_FAILED',
  /** Message text was empty or whitespace only. */
  'EMPTY_MESSAGE',
  /** Message text exceeded maxMessageLength. */
  'MESSAGE_TOO_LONG',
  /**
   * `payload.type` names a content type this server does not implement, or the
   * payload carried a reserved media field. Not retryable: the client must not
   * resend the same frame hoping the server changes its mind.
   */
  'UNSUPPORTED_CONTENT_TYPE',
  /**
   * The envelope `id` was already accepted for this match (I14). The first copy
   * was delivered; this one was not. Not retryable — retrying is what produced
   * it, and a genuinely new message needs a new id.
   */
  'DUPLICATE_MESSAGE',
  /**
   * Moderation policy refused to deliver this message. Reserved for the hard
   * rule set: the default policy delivers and flags (D20), and a message that
   * was recorded but withheld is reported as `message_ack` with
   * `delivered: false` rather than as an error.
   */
  'MESSAGE_WITHHELD',
  /**
   * A declared age below `MIN_DECLARED_AGE`.
   *
   * Its own code rather than `VALIDATION_FAILED` so the client can say what the
   * service actually is instead of "invalid input", and so the server can
   * record the declaration as a minor-safety signal without inferring it from a
   * generic failure. The join is refused; nothing about the age is stored as a
   * profile value.
   */
  'AGE_BELOW_MINIMUM',
  /**
   * A declared name that moderation refused.
   *
   * Its own code for the same reason as `AGE_BELOW_MINIMUM`: the client can
   * say which field was refused and that changing it will work, where
   * `VALIDATION_FAILED` — which every malformed frame in the protocol also
   * produces — would leave the user staring at "invalid input" for a name that
   * is perfectly well-formed and simply not allowed.
   *
   * A name is refused where a message would be flagged and delivered (D20 vs
   * D35), because a name is a label shown to everyone this person meets rather
   * than one utterance in context. The join does not happen; nothing about the
   * name is stored.
   */
  'NAME_REFUSED',
  /** Token bucket exhausted. */
  'RATE_LIMITED',
  /** Operation requires an active match and there is none. */
  'NOT_MATCHED',
  /**
   * `save_connection` from a session with no account (§31).
   *
   * Refused rather than accepted-and-ignored, because a saved state that can
   * never become a connection is worse than a refusal: the user believes they
   * have done the thing, and the absence of a connection afterwards reads as
   * the other person declining.
   */
  'ACCOUNT_REQUIRED',
  /** join_queue while already MATCHED. */
  'ALREADY_MATCHED',
  /** Server-side session no longer exists (TTL, reaped, or Redis restarted). */
  'SESSION_GONE',
  /** Instance is draining; retry against a new connection. */
  'SERVER_SHUTTING_DOWN',
  /** Too many malformed frames on one connection. */
  'TOO_MANY_INVALID_MESSAGES',
  /** Unexpected server-side failure. Details are logged, never sent. */
  'INTERNAL_ERROR',
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];

/** Whether a client may sensibly retry the same operation. */
export const RETRYABLE_ERROR_CODES: readonly ProtocolErrorCode[] = [
  'RATE_LIMITED',
  'SERVER_SHUTTING_DOWN',
  'INTERNAL_ERROR',
];

/* -------------------------------------------------------------------------- */
/* Close codes                                                                */
/* -------------------------------------------------------------------------- */

export const CLOSE_CODES = {
  NORMAL: 1000,
  /** Instance is shutting down. Client should reconnect. */
  GOING_AWAY: 1001,
  /** Frame exceeded maxFrameBytes. */
  MESSAGE_TOO_BIG: 1009,
  INTERNAL_ERROR: 1011,
  /** Outbound buffer exceeded the slow-consumer threshold. */
  TRY_AGAIN_LATER: 1013,
  /** Session vanished server-side; reconnect for a fresh one. */
  SESSION_GONE: 4001,
  /** Abuse controls tripped (connection rate, repeated limit violations). */
  POLICY_VIOLATION: 4002,
  /** Too many malformed protocol frames. */
  PROTOCOL_ABUSE: 4003,
} as const;

export type CloseCode = (typeof CLOSE_CODES)[keyof typeof CLOSE_CODES];

/* -------------------------------------------------------------------------- */
/* Type guards usable from either side                                        */
/* -------------------------------------------------------------------------- */

export function isClientEventType(value: unknown): value is ClientEventType {
  return typeof value === 'string' && (CLIENT_EVENTS as readonly string[]).includes(value);
}

export function isServerEventType(value: unknown): value is ServerEventType {
  return typeof value === 'string' && (SERVER_EVENTS as readonly string[]).includes(value);
}

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && (PROTOCOL_ERROR_CODES as readonly string[]).includes(value);
}
