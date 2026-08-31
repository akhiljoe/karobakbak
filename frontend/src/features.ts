/**
 * Build-time flags for product surface that exists in the design but not yet
 * on the server.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE ARE CONSTANTS AND NOT ENVIRONMENT VARIABLES
 * ---------------------------------------------------------------------------
 * Turning either of these on is a **product and legal decision**, not a
 * deployment one. `DESIGN.md` §24 defers anonymous accounts until the
 * minor-safety and age-assurance work is done, because persistent identity
 * plus mutual connections raises grooming risk rather than lowering it. Queue
 * filters are deferred until segmentation is actually implemented behind them
 * (R6, D23) — the backend has the `chat:queue:{segment}` seam but only
 * `default` exists, so nothing could act on a filter today.
 *
 * An environment variable would let either be switched on by a deploy, with no
 * code review and no record of who decided. A constant means turning it on is
 * a commit.
 *
 * Note the asymmetry, which is deliberate:
 *
 *  * `ACCOUNTS` hides the surface completely. A sign-in button that does
 *    nothing is worse than no button.
 *  * `FILTERS` shows the surface, disabled and labelled, because "we know you
 *    want this" is honest and a hidden feature teaches the user nothing.
 *
 * Neither flag is checked anywhere except at the render boundary, so nothing
 * behind them can be reached by other means.
 */

/** Anonymous accounts, profiles and premium entitlements (`DESIGN.md` §24). */
export const ACCOUNTS_ENABLED = false;

/**
 * Matching filters. The modal renders read-only while this is false, so the
 * roadmap is visible without the controls promising anything.
 *
 * The dimensions are **gender, country and vibe**, in the order the server
 * weights them (§29.8). Language was on the earlier list and was never built.
 *
 * Only two of the three are declared. Country is resolved from the connection
 * at the upgrade and whatever a client sends is discarded, so it is the one
 * dimension that cannot be misdeclared without a VPN.
 *
 * Gender was excluded first and then included. The argument against it stands
 * on the record: filtering a self-declared field is nearer to targeting than to
 * preference, and D37 was written about exactly that. D44 answers it by never
 * filtering — a preference that finds nobody takes an ordinary partner on the
 * same pass, so no seat is ever held for anyone.
 *
 * What follows is a constraint on the copy rather than on the feature: nothing
 * anywhere may suggest a preference has checked anything, because none of them
 * has, and nothing may promise a match rather than a higher chance of one.
 *
 * `flirty` is in the vibe list and preferring on it is a separate decision from
 * this flag (§29.9). It declares an intent rather than a tone, and the server
 * would be pairing people on that intent with no age assurance anywhere.
 */
export const FILTERS_ENABLED = false;


/**
 * Whether subscriptions can actually be bought.
 *
 * Separate from `ACCOUNTS_ENABLED` because the two arrive in that order:
 * accounts can exist before Razorpay is wired up, and in that window the
 * premium page and the sign-in form say so rather than showing a button that
 * opens nothing.
 *
 * Turning this on means a payment processor is live, which makes two published
 * claims false and needs them fixed in the same change: the Terms say "there is
 * no payment provider, because nothing is for sale", and the Privacy page says
 * the site makes no third-party requests from the browser — a payment SDK is a
 * third-party script, and the Content Security Policy blocks it until widened.
 */
export const PAYMENTS_ENABLED = false;

/**
 * Whether the filter surface appears at all.
 *
 * Both halves, and each one refuses for its own reason:
 *
 *  * `FILTERS_ENABLED` — the backend has the `chat:queue:{segment}` seam and
 *    only `default` exists (R6, D23). With this false there is nothing for a
 *    filter to act on, so a control that set one would be decoration.
 *  * `PAYMENTS_ENABLED` — filtering is the paid tier. Shipping it while nothing
 *    can be bought gives the premium feature away, and then takes it back when
 *    payments arrive, which is the worst order to do those two things in.
 *
 * Derived rather than a third flag anyone can set, so the two can never
 * disagree about whether a control should exist.
 *
 * It governs the chat header's filter button and the modal behind it. While it
 * is false neither is rendered — the read-only "Part of Premium" state inside
 * `FiltersModal` is kept but unreachable, because the decision was that the
 * chat surface should not carry a locked control at all. Premium is described
 * on its own page, which is where somebody goes to find out what it costs.
 */
export const FILTERS_AVAILABLE = FILTERS_ENABLED && PAYMENTS_ENABLED;
