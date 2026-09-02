/**
 * The probe harness: what a probe is, and how a run is judged.
 *
 * ---------------------------------------------------------------------------
 * WHY SOME PROBES MEASURE RATHER THAN ASSERT
 * ---------------------------------------------------------------------------
 * Most of these have one correct answer and fail on anything else. A few do
 * not, and the difference matters more than it looks.
 *
 * `TRUST_PROXY_HOPS` is the clearest case: the right value depends entirely on
 * how many proxies are actually in front of this deployment, which the code
 * cannot know and a unit test cannot check. `upgrade.test.ts` already proves
 * `clientAddress` counts from the right correctly at every hop count — what it
 * cannot prove is that the *configured* count matches the *deployed* chain, and
 * a mismatch there hands every visitor a free choice of rate-limit bucket and a
 * way to shed their blocks with a header.
 *
 * So that probe reports what the running stack actually did, and fails only on
 * the answer that is wrong under every deployment. An `INFO` verdict here is
 * not a soft failure; it is a measurement whose interpretation belongs to
 * whoever knows the topology.
 */

export type Verdict = 'PASS' | 'FAIL' | 'INFO' | 'SKIP';

export interface Result {
  readonly verdict: Verdict;
  /** One line. What was observed, not what it means. */
  readonly detail: string;
  /** Extra lines, printed indented. */
  readonly notes?: readonly string[];
}

export interface Probe {
  readonly id: string;
  readonly name: string;
  /** What a PASS actually proves. Printed on failure so the reader knows why it matters. */
  readonly proves: string;
  run(ctx: Context): Promise<Result>;
}

export interface Context {
  /** The edge, as a browser would reach it. */
  readonly origin: string;
  /** The WebSocket endpoint on that origin. */
  readonly wsUrl: string;
  /** The moderation console, or null when it is not running. */
  readonly consoleOrigin: string | null;
}

export const pass = (detail: string, notes?: readonly string[]): Result =>
  notes ? { verdict: 'PASS', detail, notes } : { verdict: 'PASS', detail };
export const fail = (detail: string, notes?: readonly string[]): Result =>
  notes ? { verdict: 'FAIL', detail, notes } : { verdict: 'FAIL', detail };
export const info = (detail: string, notes?: readonly string[]): Result =>
  notes ? { verdict: 'INFO', detail, notes } : { verdict: 'INFO', detail };
export const skip = (detail: string): Result => ({ verdict: 'SKIP', detail });

/**
 * A synthetic address, from the RFC 2544 benchmarking range.
 *
 * The same range the swarm uses, and for the same reason: it is reserved for
 * testing, so a probe can never accidentally name a real host — and if one of
 * these ever appears in a log or a metric, that is itself the finding.
 */
export function syntheticAddress(n: number): string {
  return `198.18.${Math.floor(n / 256) % 256}.${n % 256}`;
}
