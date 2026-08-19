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
 */
export const FILTERS_ENABLED = false;
