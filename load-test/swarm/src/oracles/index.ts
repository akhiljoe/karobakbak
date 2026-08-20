/**
 * Running the oracles and collecting their verdicts.
 *
 * Stage one implements three of the five in `docs/LOADTEST-SCENARIOS.md` §7:
 * pair reconstruction, metric conservation and the log leak check. The Redis
 * residue and database agreement oracles need clients this package does not
 * yet depend on, and they are listed here as explicitly *not run* rather than
 * quietly omitted — an oracle nobody can see is missing is worse than one that
 * says so.
 */
import type { BotSpec } from '../bot';
import { analyseLedger, type LedgerStats } from './ledger';
import { checkLogsForLeaks } from './logs';
import { checkMetrics, type Sample } from './metrics';
import type { OracleResult } from './types';

export type { OracleResult, OracleStatus } from './types';
export { percentile } from './ledger';
export { scrapeAll } from './metrics';

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
}

export interface OracleRunResult {
  readonly stats: LedgerStats;
  readonly matchedFrames: number;
  readonly oracles: readonly OracleResult[];
}

export async function runOracles(input: OracleInput): Promise<OracleRunResult> {
  const { stats, oracle: pairing } = await analyseLedger(input.ledgerPaths);
  const matchedFrames = stats.matchLatency.length;

  const metrics = await checkMetrics({
    urls: input.metricsUrls,
    stats,
    matchedFrames,
    settleSeconds: input.settleSeconds,
    baseline: input.metricsBaseline,
  });

  const logs = await checkLogsForLeaks({
    containers: input.logContainers,
    corpusDir: input.corpusDir,
    since: input.runWindow.from,
  });

  const notImplemented: OracleResult[] = [
    {
      name: 'redis residue',
      status: 'skipped',
      summary: 'not implemented in stage one',
      details: [
        'checks queue sets are empty and no session or match hash outlived its TTL',
        'needs a Redis client in this package',
      ],
    },
    {
      name: 'database agreement',
      status: 'skipped',
      summary: 'not implemented in stage one',
      details: [
        'checks stored rows equal accepted messages minus counted retention drops,',
        'that every conversation has ended_at, and that retention deadlines were',
        'stamped at insert time (D17)',
        'needs a PostgreSQL client in this package',
      ],
    },
  ];

  return {
    stats,
    matchedFrames,
    oracles: [pairing, metrics, logs, ...notImplemented],
  };
}
