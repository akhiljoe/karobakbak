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
 *  * `ACCOUNTS` hides the surface completely when off. A sign-in button that
 *    does nothing is worse than no button — which is why turning it on means
 *    the server side has to be configured in the same change.
 *  * `FILTERS` shows the surface, disabled and labelled, because "we know you
 *    want this" is honest and a hidden feature teaches the user nothing.
 *
 * Neither flag is checked anywhere except at the render boundary, so nothing
 * behind them can be reached by other means.
 */

/**
 * Sign-in, saved connections and recent history (`DESIGN.md` §31, §32, D48).
 *
 * ON, and the reasoning changed rather than being overruled. The deferral was
 * written against §24's *anonymous accounts with premium entitlements*, where
 * the account was the thing being sold. §31 rebuilt it as the opposite: signing
 * in is **free**, it is OIDC against a hosted provider so no credential is ever
 * held here, and what it gates is saved connections and recent history —
 * things a person opts into one at a time about somebody they already met.
 *
 * The minor-safety position is unchanged and is not answered by this flag. The
 * age gate remains the whole of that enforcement (`minor-safety-policy.md` §3),
 * there is still no age assurance anywhere, and an account does not add any:
 * the provider tells us a subject identifier and nothing about who it belongs
 * to. What it does not do is create a durable profile of a stranger — the
 * server keeps no profile between sessions (D34), and `connections` carries no
 * `conversation_id` and no `created_by` for exactly that reason.
 *
 * Turning it on requires the backend's `AUTH_ENABLED` and a configured
 * provider. With this true and the server unconfigured the four routes are
 * never registered and the header offers a button into a 404 — the failure the
 * asymmetry below exists to avoid, so the two ship together.
 */
export const ACCOUNTS_ENABLED = true;

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
 * `flirty` no longer has anything to do with this flag. It moved to `INTENTS`
 * (D45, §30.4), which is symmetric, free and always on — so preferring on it is
 * not a thing that can be done at all: an intent says what *you* are here for
 * and scores only against somebody who said the same. That is what answered
 * §29.9, and it means this flag now gates exactly two dimensions, gender and
 * country, both of them paid and both of them asymmetric.
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

/**
 * Which sign-in the button should describe.
 *
 * `google` when the backend sets `AUTH_IDENTITY_PROVIDER=Google`, which makes
 * Cognito redirect straight past its own login form to Google. `hosted` when it
 * is empty and the provider renders its own page with whatever it offers.
 *
 * A constant rather than a `VITE_` variable for the reason the flags above give:
 * a build arg would have to be threaded through the Dockerfile and compose, and
 * it bakes into the bundle anyway, so it is a commit either way.
 *
 * A mismatch is cosmetic and nothing else — the button would name Google and
 * the provider would show its own form. Nothing about the protocol, the
 * credential or what is stored depends on this; it exists so the button
 * describes what actually happens next.
 */
export const SIGNIN_PROVIDER: 'google' | 'hosted' = 'google';
