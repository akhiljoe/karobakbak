/**
 * A canonical form for *cross-message* comparison — a proposal, not shipped
 * behaviour.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER'S NORMALISATION VIEW IS NOT ENOUGH FOR THIS
 * ---------------------------------------------------------------------------
 * `moderationView` is built for a different job: it prepares one message for
 * one pass of the rule engine. It folds invisible characters and confusables,
 * rewrites "(at)" to "@", and joins words across dots — all aimed at stopping a
 * single message from evading a single regex. It deliberately does **not**
 * lowercase, because case carries signal some rules need (a base58 address is
 * case-sensitive), and it does not fold leetspeak digits, because "4" really is
 * a "4" most of the time and an over-eager fold would cost the rules precision.
 *
 * Those are the right decisions for what it does. They also mean it is close to
 * useless for grouping a campaign: "hey wanna see something cool" and "H3y
 * w4nna s33 s0mething c00l" have different normalised views, so a query that
 * groups by that view catches a copy-paste spammer and misses a mutating one —
 * which a run of the adversarial profile demonstrates rather than assumes.
 *
 * This function is what a serial-spam detector would need instead: aggressive,
 * lossy, and unusable for anything a human reads. It lives in the harness
 * precisely because it is a proposal. Measuring how much better it does is the
 * point; shipping it is a separate decision with its own false-positive budget.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT COSTS
 * ---------------------------------------------------------------------------
 * Everything it folds is signal somebody could have meant. "cool" and "c00l"
 * become the same string, and so do "hi there!" and "HI THERE". That is
 * acceptable for asking "did this sender say this same thing to forty
 * strangers" and unacceptable for asking "is this one message abusive" — which
 * is exactly why the two canonical forms should stay separate rather than one
 * being made to serve both.
 */
import { moderationView } from '../../../backend/src/moderation/normalise';

/** Leetspeak substitutions, folded back to the letter they stand in for. */
const LEET: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  $: 's',
};

export function campaignView(text: string): string {
  // Start from the server's own view, so everything it already folds — zero
  // width characters, Cyrillic confusables, spaced-out dots — is folded here
  // too, and this function only adds to it.
  const base = moderationView(text).toLowerCase();

  let folded = '';
  for (const character of base) {
    folded += LEET[character] ?? character;
  }

  // Punctuation and repeated whitespace carry no campaign signal, and varying
  // them is the next-cheapest evasion after character substitution.
  return folded
    .replace(/[^a-z0-9\s]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
