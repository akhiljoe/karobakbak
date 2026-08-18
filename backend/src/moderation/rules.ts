/**
 * The local rule set (D19).
 *
 * Deterministic patterns, no classifier, no network call. Local rules catch the
 * high-volume, low-sophistication abuse that makes up most of it; they are weak
 * against anything novel or deliberately obfuscated, and that is accepted —
 * they produce **signals for a human**, not verdicts (D20). An external
 * classifier is deferred until abuse volume justifies the spend (cost §20–21).
 *
 * ---------------------------------------------------------------------------
 * A RULE RESULT NEVER CARRIES USER TEXT
 * ---------------------------------------------------------------------------
 * A rule reports its id and its severity. It does **not** report what it
 * matched. That is not an oversight: rule results travel into log lines, metric
 * labels and `moderation_events` rows, and the matched substring is the part of
 * a message most likely to be personal — an address, a phone number, a name.
 * Invariant I8 covers message text wherever it goes, and the cheapest way to
 * keep that true here is for the excerpt never to exist.
 */

export type Severity = 'low' | 'medium' | 'high';

export interface Rule {
  readonly id: string;
  readonly severity: Severity;
  /** True when the rule fires. Runs against the moderation view, never the original. */
  test(view: string, options: RuleOptions): boolean;
}

export interface RuleOptions {
  /** Contact-exchange detection, as a group (`MODERATION_DETECT_CONTACT`). */
  readonly detectContact: boolean;
  /** Case-insensitive terms an operator has banned outright. */
  readonly denyList: readonly string[];
}

/**
 * Top-level domains the URL rule recognises.
 *
 * An allowlist, not a generic `\.[a-z]{2,}` pattern: the moderation view joins
 * words across dots, so a generic pattern turns "ok.thanks" into a URL match
 * and floods the flag queue with sentences. Weak coverage of obscure TLDs is
 * the accepted cost (D19).
 */
const TLDS = [
  'com', 'net', 'org', 'io', 'co', 'me', 'gg', 'tv', 'app', 'dev', 'xyz',
  'info', 'biz', 'live', 'link', 'site', 'online', 'shop', 'store', 'club',
  'ru', 'cn', 'uk', 'de', 'fr', 'nl', 'in', 'br', 'jp', 'us', 'eu', 'to',
  'ly', 'be', 'cc', 'ws', 'im', 'chat', 'onion',
].join('|');

const EXPLICIT_URL = /(?:https?|ftp|ws{1,2}):\/\/\S+/i;
const BARE_DOMAIN = new RegExp(`\\b[a-z0-9][a-z0-9-]{0,61}\\.(?:${TLDS})\\b`, 'i');
const IP_LITERAL = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/;
const WWW_PREFIX = /\bwww\.[a-z0-9-]+/i;

const EMAIL = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})+/i;

/**
 * Seven or more digits with optional separators.
 *
 * Each repetition consumes at least one digit, so this cannot backtrack
 * catastrophically on a hostile input — which matters, because every rule here
 * runs on attacker-supplied text on the hot path.
 */
const PHONE = /(?:\+?\d[\s().-]{0,2}){7,}/;

const SOCIAL_HANDLE = /(?:^|[\s(])@[a-z0-9._]{3,30}\b/i;
const SOCIAL_PLATFORM =
  /\b(?:snap(?:chat)?|insta(?:gram)?|telegram|whats\s?app|discord|kik|skype|signal|tiktok|reddit|onlyfans)\b/i;

const INVITE_LINK =
  /\b(?:discord\.gg|discordapp\.com\/invite|t\.me|wa\.me|chat\.whatsapp\.com|join\.skype\.com|invite\.gg)\b/i;

/**
 * Crypto addresses. The moderation view preserves case precisely so base58 can
 * still be told apart from a long ordinary word.
 */
const CRYPTO_ADDRESS =
  /\b(?:bc1[a-z0-9]{25,62}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|0x[a-fA-F0-9]{40}|[LM][a-km-zA-HJ-NP-Z1-9]{26,33})\b/;

/**
 * Off-platform contact solicitation.
 *
 * The standalone abbreviations are their own alternatives: "hmu" already means
 * "hit me up" and is not followed by anything. Apostrophes are matched as a
 * class because NFKC leaves a typographic apostrophe alone, and a phone
 * keyboard produces one by default.
 */
const CONTACT_SOLICITATION = new RegExp(
  [
    "\\bhmu\\b",
    "\\bhit\\s+me\\s+up\\b",
    "\\b(?:d\\.?m|p\\.?m|text|call|add|snap|msg|message)\\s+me\\b",
    "\\badd\\s+me\\s+on\\b",
    "\\bmy\\s+(?:snap|insta|discord|telegram|number|handle|profile)\\b",
    "\\blet['\u2019]?s\\s+(?:talk|chat|move)\\s+(?:on|to)\\b",
  ].join('|'),
  'i',
);

/** Escape a deny-list term so an operator cannot accidentally write a regex. */
function escapeTerm(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const RULES: readonly Rule[] = [
  {
    id: 'url',
    severity: 'medium',
    test: (view, options) =>
      options.detectContact &&
      (EXPLICIT_URL.test(view) ||
        WWW_PREFIX.test(view) ||
        BARE_DOMAIN.test(view) ||
        IP_LITERAL.test(view)),
  },
  {
    id: 'email',
    severity: 'high',
    test: (view, options) => options.detectContact && EMAIL.test(view),
  },
  {
    id: 'phone',
    severity: 'high',
    test: (view, options) => options.detectContact && PHONE.test(view),
  },
  {
    id: 'social_handle',
    severity: 'medium',
    test: (view, options) =>
      options.detectContact && (SOCIAL_HANDLE.test(view) || SOCIAL_PLATFORM.test(view)),
  },
  {
    id: 'invite_link',
    severity: 'high',
    test: (view, options) => options.detectContact && INVITE_LINK.test(view),
  },
  {
    id: 'crypto_address',
    severity: 'high',
    test: (view, options) => options.detectContact && CRYPTO_ADDRESS.test(view),
  },
  {
    id: 'contact_solicitation',
    severity: 'low',
    test: (view, options) => options.detectContact && CONTACT_SOLICITATION.test(view),
  },
  {
    id: 'deny_list',
    severity: 'high',
    test: (view, options) => {
      if (options.denyList.length === 0) return false;
      // Built per call from configuration rather than cached: the list is
      // short, and a cached pattern is a second place for it to be wrong.
      const pattern = new RegExp(
        `(?:^|\\W)(?:${options.denyList.map(escapeTerm).join('|')})(?:\\W|$)`,
        'i',
      );
      return pattern.test(view);
    },
  },
];

/** Every rule id, for validating `MODERATION_HARD_BLOCK_RULES` at startup. */
export const RULE_IDS: readonly string[] = RULES.map((rule) => rule.id);

export const SEVERITY_ORDER: Record<Severity, number> = { low: 1, medium: 2, high: 3 };
