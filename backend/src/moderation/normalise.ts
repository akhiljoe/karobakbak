/**
 * The moderation view (§14.2).
 *
 * Two representations exist deliberately:
 *
 *  * **The user's text** — trimmed, otherwise untouched. It is what gets
 *    delivered and what gets retained, and mutating text that is later read
 *    back as evidence corrupts the evidence.
 *  * **The moderation view** — this file. A derived, throwaway string used
 *    only to evaluate rules against. Never delivered, never stored, never
 *    logged.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ALLOWED TO BE AGGRESSIVE
 * ---------------------------------------------------------------------------
 * The view mangles text in ways that would be unacceptable if anyone saw it:
 * it joins words across dots, rewrites "(at)" to "@", and folds Cyrillic
 * letters onto Latin ones. That is safe here for two reasons. It is discarded
 * the moment the rules have run, and a rule match **flags** rather than blocks
 * by default (D20) — so the cost of an over-eager fold is a signal a human may
 * later look at, not a message somebody could not send.
 *
 * The view deliberately does **not** lowercase. Case carries signal that some
 * rules need — a base58 crypto address is case-sensitive — and rules that do
 * not care can ask for case-insensitivity themselves.
 */

/**
 * Characters that are invisible but change how a string is read, matched or
 * rendered: zero-width joiners, bidirectional overrides, the byte-order mark.
 * They are the cheapest way to break a naive substring rule, so they are
 * removed before any rule runs.
 *
 * Written as escapes, never as literal bytes — a source file containing raw
 * control characters stops being text to git and grep.
 */
const INVISIBLE = new RegExp(
  '[' +
    '\\u00AD' + // soft hyphen
    '\\u180E' + // Mongolian vowel separator
    '\\u200B-\\u200F' + // zero-width space/joiners, LTR/RTL marks
    '\\u202A-\\u202E' + // bidirectional embedding and overrides
    '\\u2060-\\u2064' + // word joiner, invisible operators
    '\\u206A-\\u206F' + // deprecated formatting
    '\\uFEFF' + // byte-order mark
    ']',
  'g',
);

/**
 * Homoglyphs that survive NFKC.
 *
 * NFKC already folds fullwidth and most compatibility forms; what it will not
 * do is decide that Cyrillic "а" and Latin "a" are the same letter, because
 * they are not. For matching a URL or a deny-listed word they may as well be.
 * The list is deliberately short: only characters whose Latin lookalike is
 * unambiguous.
 */
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  а: 'a', б: 'b', в: 'b', г: 'r', е: 'e', ё: 'e', з: '3', и: 'u', к: 'k',
  м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's',
  і: 'i', ј: 'j', ԁ: 'd', ѡ: 'w', А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M',
  Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', У: 'Y', Х: 'X',
  // Greek
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't',
  υ: 'u', χ: 'x', Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K',
  Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X',
  // Punctuation that stands in for a dot or a slash
  '․': '.', '。': '.', '｡': '.', '·': '.', '∕': '/', '⁄': '/',
};

/** Escaped, so a table entry can never be read as regex syntax. */
const CONFUSABLE_PATTERN = new RegExp(
  `[${Object.keys(CONFUSABLES)
    .map((char) => char.replace(/[.*+?^${}()|[\]\\\-]/g, '\\$&'))
    .join('')}]`,
  'g',
);

/**
 * Written-out separators, as used to smuggle an address past a substring rule:
 * `example (dot) com`, `me [at] example.com`, `example dot com`.
 */
const WRITTEN_DOT = /\s*[([{<]\s*(?:dot|punto|punkt)\s*[)\]}>]\s*|\s+dot\s+/gi;
const WRITTEN_AT = /\s*[([{<]\s*(?:at|arroba)\s*[)\]}>]\s*|\s+at\s+sign\s+/gi;

/** Spaces used to break up a domain: `example . com`, `t . me`. */
const SPACED_DOT = /\s*\.\s*/g;

/**
 * Build the moderation view of a message.
 *
 * Order matters: normalise first so the confusable table only has to know
 * about characters NFKC leaves alone, strip invisibles before anything tries
 * to match across them, and collapse whitespace last so the earlier rewrites
 * do not leave doubled spaces behind.
 */
export function moderationView(text: string): string {
  let view = text.normalize('NFKC');
  view = view.replace(INVISIBLE, '');
  view = view.replace(CONFUSABLE_PATTERN, (char) => CONFUSABLES[char] ?? char);
  view = view.replace(WRITTEN_DOT, '.');
  view = view.replace(WRITTEN_AT, '@');
  view = view.replace(SPACED_DOT, '.');
  view = view.replace(/\s+/g, ' ');
  return view.trim();
}
