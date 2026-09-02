/**
 * Comparing a run against what this profile did last time it was healthy.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `runs/` holds well over a hundred directories and every one of them is an
 * anecdote. The oracles judge a run against its own internal consistency —
 * every message that was acked was delivered, every conversation has two sides —
 * and they are very good at that. What none of them can see is the run *before*
 * this one.
 *
 * So a change that halves throughput, or doubles the time to find somebody, or
 * quietly stops a persona group producing events, passes every oracle. The
 * verdict says PASS and the product is worse. `docs/OBSERVABILITY-AND-TESTING.md`
 * §2.5 names this as the last gap in the load work: 130 run directories, no
 * baseline, no comparison, and nothing that would notice.
 *
 * ---------------------------------------------------------------------------
 * A BASELINE IS RECORDED DELIBERATELY, NEVER LEARNED
 * ---------------------------------------------------------------------------
 * The obvious design updates the baseline automatically from each green run.
 * That is a ratchet in the wrong direction: a regression that lands in small
 * enough steps is absorbed one run at a time and the file ends up describing
 * whatever the system currently does, which is the one thing a baseline must
 * not be.
 *
 * `--record-baseline` writes it, a human decides when, and the file carries the
 * commit it was taken at so a comparison can say what changed since.
 *
 * ---------------------------------------------------------------------------
 * TOLERANCES ARE WIDE, AND THAT IS NOT LAZINESS
 * ---------------------------------------------------------------------------
 * Time to match depends on who else is waiting, not on server speed. Throughput
 * on a laptop depends on what else the laptop is doing. A tight bound here
 * produces a check that fails on a busy afternoon, and a check that fails for
 * reasons nobody controls is a check that gets run with `|| true` inside a
 * month.
 *
 * These are set to catch a *step change* — something twice as slow, or a third
 * of the conversations gone — not a drift. Drift is what the dashboards are for.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The numbers a baseline holds. Everything else in a report is descriptive. */
export interface BaselineMetrics {
  /**
   * Conversations per bot **per minute**, so a baseline survives being run at
   * another size *and* another duration.
   *
   * Per-bot alone was not enough, and running it said so: a baseline recorded
   * over 60 seconds read a healthy 30-second run as a 0.5x regression, because
   * half the wall clock is half the conversations. A baseline that only holds
   * at one duration is one nobody can use — the first thing anybody does is
   * shorten the run.
   */
  readonly conversationsPerBotPerMinute: number;
  /** Messages per bot per minute, same reason. */
  readonly messagesPerBotPerMinute: number;
  /** Share of bots that got a socket. Below 1 means the population was incomplete. */
  readonly connectedShare: number;
  readonly ackLatencyP95Ms: number;
  readonly matchLatencyP95Ms: number;
  readonly lagP99Ms: number;
}

export interface Baseline extends BaselineMetrics {
  readonly profile: string;
  readonly recordedAt: string;
  /** The commit it was taken at, so a comparison can say what changed since. */
  readonly commit: string;
  readonly bots: number;
  readonly durationSeconds: number;
  /** Free text. Why this run was considered a good one to freeze. */
  readonly note: string;
}

/**
 * How far each number may move before it is a finding.
 *
 * Ratios rather than absolutes so a baseline recorded at 400 bots means
 * something at 4,000. Latencies may double; volumes may fall by a third.
 */
const TOLERANCE = {
  conversationsPerBotPerMinute: { min: 0.66, max: Number.POSITIVE_INFINITY },
  messagesPerBotPerMinute: { min: 0.66, max: Number.POSITIVE_INFINITY },
  connectedShare: { min: 0.95, max: Number.POSITIVE_INFINITY },
  ackLatencyP95Ms: { min: 0, max: 2.0 },
  matchLatencyP95Ms: { min: 0, max: 3.0 },
  lagP99Ms: { min: 0, max: 2.0 },
} as const;

/** Which direction is bad, for the message. */
const WORSE_WHEN_HIGHER: Record<keyof BaselineMetrics, boolean> = {
  conversationsPerBotPerMinute: false,
  messagesPerBotPerMinute: false,
  connectedShare: false,
  ackLatencyP95Ms: true,
  matchLatencyP95Ms: true,
  lagP99Ms: true,
};

export function baselinePath(profile: string): string {
  return join(__dirname, '..', 'baselines', `${profile}.json`);
}

export function readBaseline(profile: string): Baseline | null {
  const path = baselinePath(profile);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as Baseline;
}

export function writeBaseline(baseline: Baseline): string {
  const path = baselinePath(baseline.profile);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf8');
  return path;
}

export interface Regression {
  readonly metric: keyof BaselineMetrics;
  readonly baseline: number;
  readonly observed: number;
  readonly ratio: number;
  readonly allowed: string;
}

export interface Comparison {
  readonly baseline: Baseline;
  readonly regressions: readonly Regression[];
  /** Everything compared, for the report, including what stayed inside tolerance. */
  readonly all: readonly Regression[];
}

/**
 * Compare, and say what moved.
 *
 * A baseline value of zero is skipped rather than treated as a division by
 * zero: a profile that produced no matches last time cannot say anything about
 * whether this run's matching got worse.
 */
export function compare(baseline: Baseline, observed: BaselineMetrics): Comparison {
  const all: Regression[] = [];
  const regressions: Regression[] = [];

  for (const key of Object.keys(TOLERANCE) as Array<keyof BaselineMetrics>) {
    const before = baseline[key];
    const after = observed[key];
    if (!Number.isFinite(before) || before === 0) continue;

    const ratio = after / before;
    const { min, max } = TOLERANCE[key];
    const allowed = WORSE_WHEN_HIGHER[key]
      ? `up to ${max}x`
      : `no less than ${Math.round(min * 100)}%`;

    const entry: Regression = { metric: key, baseline: before, observed: after, ratio, allowed };
    all.push(entry);
    if (ratio < min || ratio > max) regressions.push(entry);
  }

  return { baseline, regressions, all };
}

/** Lines for the report. Verdict first, as everything here does. */
export function describe(comparison: Comparison): string[] {
  const lines: string[] = [];
  const { baseline, regressions, all } = comparison;

  lines.push(
    regressions.length === 0
      ? `  [PASS] against the ${baseline.profile} baseline of ${baseline.recordedAt.slice(0, 10)}`
      : `  [FAIL] ${regressions.length} metric(s) moved past tolerance since ${baseline.recordedAt.slice(0, 10)}`,
  );
  lines.push(`         baseline taken at ${baseline.commit} (${baseline.bots} bots, ${baseline.durationSeconds}s)`);
  if (baseline.note) lines.push(`         "${baseline.note}"`);

  for (const entry of all) {
    const bad = regressions.includes(entry);
    lines.push(
      `         ${bad ? '!' : ' '} ${entry.metric.padEnd(20)} ` +
        `${entry.baseline.toFixed(2)} -> ${entry.observed.toFixed(2)} ` +
        `(${entry.ratio.toFixed(2)}x, allowed ${entry.allowed})`,
    );
  }

  if (regressions.length > 0) {
    lines.push(
      '         A baseline is recorded deliberately, never learned: if this run is the',
      '         new normal, re-record it with --record-baseline and say why in the note.',
    );
  }
  return lines;
}
