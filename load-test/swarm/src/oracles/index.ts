/**
 * Running the oracles and collecting their verdicts.
 *
 * Six of the seven run. Database agreement is the one that does not, and it is
 * listed as explicitly *not run* rather than quietly omitted — an oracle nobody
 * can see is missing is worse than one that says so.
 *
 * Profile agreement (oracle 6) is folded into the ledger pass rather than given
 * its own read of the files: it needs the same events, and a second pass over
 * a five-thousand-bot ledger to re-derive them would cost minutes for nothing.
 */
import type { BotSpec } from '../bot';
import { analyseLedger, type LedgerStats } from './ledger';
import { checkLogsForLeaks } from './logs';
import { runEnforcementOracle } from './enforcement';
import { checkDatabaseAgreement } from './database';
import { checkChaos } from './chaos';
import type { ChaosResult } from '../chaos';
import { checkMetrics, type Sample } from './metrics';
import { checkRedisResidue } from './redis';
import { checkSpamDetection, type SpamSummary } from './spam';
import type { OracleResult } from './types';

export type { OracleResult, OracleStatus } from './types';
export { percentile } from './ledger';
export { scrapeAll } from './metrics';
export type { SpamSummary } from './spam';

export interface OracleInput {
  readonly ledgerPaths: readonly string[];
  readonly roster: readonly BotSpec[];
  readonly metricsUrls: readonly string[];
  readonly logContainers: readonly string[];
  readonly corpusDir: string;
  readonly runWindow: { from: number; to: number };
  /** Seconds to wait before the metrics oracle re-scrapes; see MetricsInput. */
  readonly settleSeconds: number;
  /** Counter values taken before the first socket opened. */
  readonly metricsBaseline: readonly Sample[];
  /** Container running Redis, for the residue oracle. Empty disables it. */
  readonly redisContainer: string;
  readonly keyPrefix: string;
  readonly segment: string;
  /** Bots the orchestrator banned before the run, by ledger id. */
  readonly bannedBots: readonly string[];
  readonly bansApplied: number;
  /** Why bans were not applied, when they were not. */
  readonly bansSkipped: string | null;
  /** Container running PostgreSQL, for the database oracle. Empty disables it. */
  readonly postgresContainer: string;
  readonly postgresUser: string;
  readonly postgresDatabase: string;
  /** How long to wait for the write-behind queue to finish draining. */
  readonly drainTimeoutSeconds: number;
  /** What the chaos schedule observed, if one ran. */
  readonly chaos: ChaosResult;
}

export interface OracleRunResult {
  readonly stats: LedgerStats;
  readonly matchedFrames: number;
  readonly oracles: readonly OracleResult[];
  /** Null when the profile contained no labelled spammers. */
  readonly spam: SpamSummary | null;
}

export async function runOracles(input: OracleInput): Promise<OracleRunResult> {
  const { stats, oracle: pairing, profiles } = await analyseLedger(input.ledgerPaths);
  const matchedFrames = stats.matchLatency.length;

  const metrics = await checkMetrics({
    urls: input.metricsUrls,
    stats,
    matchedFrames,
    settleSeconds: input.settleSeconds,
    baseline: input.metricsBaseline,
  });

  const spam = await checkSpamDetection({
    ledgerPaths: input.ledgerPaths,
    roster: input.roster,
    // The same threshold as the SQL in the scenarios document, so the harness
    // and the query somebody runs by hand cannot disagree about what counts as
    // a campaign.
    campaignThreshold: 5,
  });

  const logs = await checkLogsForLeaks({
    containers: input.logContainers,
    corpusDir: input.corpusDir,
    since: input.runWindow.from,
  });

  // After the metrics oracle, deliberately: that one waits out the settle
  // window, so by the time this runs the janitor has had two passes and a queue
  // entry still pointing at a dead session is genuinely abandoned.
  const redis = await checkRedisResidue({
    container: input.redisContainer,
    keyPrefix: input.keyPrefix,
    segment: input.segment,
  });

  const enforcement = await runEnforcementOracle({
    ledgerPaths: input.ledgerPaths,
    bannedBots: input.bannedBots,
    bansApplied: input.bansApplied,
    skipped: input.bansSkipped,
  });

  const database = await checkDatabaseAgreement({
    container: input.postgresContainer,
    user: input.postgresUser,
    database: input.postgresDatabase,
    ledgerPaths: input.ledgerPaths,
    baseline: input.metricsBaseline,
    metricsUrls: input.metricsUrls,
    drainTimeoutSeconds: input.drainTimeoutSeconds,
    runStartMs: input.runWindow.from,
    chaosRan: input.chaos.scenario !== '' && input.chaos.skipped === null,
  });


  return {
    stats,
    matchedFrames,
    spam: spam.summary.labelledSpammers > 0 ? spam.summary : null,
    oracles: [pairing, profiles, metrics, redis, spam.oracle, logs, enforcement, database, checkChaos(input.chaos)],
  };
}
