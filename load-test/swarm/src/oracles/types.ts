/**
 * What an oracle produces.
 *
 * Three states, not two. `skipped` matters as much as the other two: an oracle
 * that could not run because nobody passed it a metrics endpoint has *not*
 * passed, and a report that showed it green would be lying about what was
 * checked. A skipped oracle is printed as loudly as a failed one and does not
 * fail the run.
 */
export type OracleStatus = 'pass' | 'fail' | 'warn' | 'skipped';

export interface OracleResult {
  readonly name: string;
  readonly status: OracleStatus;
  /** One line, printed next to the status. */
  readonly summary: string;
  /** Everything else worth reading. Never message content. */
  readonly details: readonly string[];
}
