/**
 * The end of a run.
 *
 * Verdicts first, numbers second. The ordering is the argument: a run's job is
 * to answer "is this correct", and the percentiles are context for that answer
 * rather than the answer itself.
 *
 * Latency figures are withheld when the harness's own event loop was lagging.
 * A generator that stalled for 300 ms cannot distinguish its own delay from the
 * server's, and printing the number anyway is how a harness artefact becomes a
 * bug report.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { percentile, type OracleRunResult } from './oracles';

/** Above this, the load generator was part of what the run measured. */
const LAG_THRESHOLD_MS = 100;

export interface ReportInput {
  readonly runId: string;
  readonly runDir: string;
  readonly options: {
    readonly bots: number;
    readonly profile: string;
    readonly seed: number;
    readonly durationSeconds: number;
    readonly url: string;
  };
  readonly lag: { p99: number; max: number };
  readonly result: OracleRunResult;
}

const MARK: Record<string, string> = {
  pass: 'PASS',
  fail: 'FAIL',
  warn: 'WARN',
  skipped: 'SKIP',
};

function top(counts: Map<string, number>, limit = 6): string[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => `    ${key}: ${count}`);
}

export function printReport(input: ReportInput): void {
  const { stats } = input.result;
  const lines: string[] = [];

  lines.push('');
  lines.push('='.repeat(72));
  lines.push(`swarm run ${input.runId}`);
  lines.push(
    `${input.options.bots} bots, profile ${input.options.profile}, ` +
      `${input.options.durationSeconds}s, seed ${input.options.seed}`,
  );
  lines.push(`reproduce: npm run swarm -- --seed ${input.options.seed} ` +
    `--bots ${input.options.bots} --profile ${input.options.profile} ` +
    `--duration ${input.options.durationSeconds} --url ${input.options.url}`);
  lines.push('='.repeat(72));

  lines.push('');
  lines.push('ORACLES');
  for (const oracle of input.result.oracles) {
    lines.push(`  [${MARK[oracle.status] ?? '????'}] ${oracle.name}: ${oracle.summary}`);
    for (const detail of oracle.details) lines.push(`         ${detail}`);
  }

  lines.push('');
  lines.push('POPULATION');
  lines.push(`  bots that connected:      ${stats.bots}`);
  lines.push(`  conversations:            ${stats.matches}`);
  lines.push(`  messages sent:            ${stats.messagesSent}`);
  lines.push(`  messages acknowledged:    ${stats.messagesAcked}`);
  lines.push(`  messages received:        ${stats.messagesReceived}`);
  lines.push(`  messages withheld:        ${stats.messagesWithheld}`);
  if (stats.routes.size > 0) {
    lines.push('  delivery route:');
    lines.push(...top(stats.routes));
  }

  lines.push('');
  lines.push('LATENCY');
  if (input.lag.p99 > LAG_THRESHOLD_MS) {
    lines.push(
      `  withheld: the load generator's own event loop lagged ${input.lag.p99.toFixed(0)}ms at p99 ` +
        `(max ${input.lag.max.toFixed(0)}ms).`,
    );
    lines.push('  Numbers from this run would be partly the harness. Use more workers or fewer bots.');
  } else {
    lines.push(`  harness event-loop lag p99: ${input.lag.p99.toFixed(1)}ms`);
    lines.push(
      `  message ack:   p50 ${percentile(stats.ackLatency, 50)}ms   ` +
        `p95 ${percentile(stats.ackLatency, 95)}ms   p99 ${percentile(stats.ackLatency, 99)}ms`,
    );
    lines.push(
      `  time to match: p50 ${percentile(stats.matchLatency, 50)}ms   ` +
        `p95 ${percentile(stats.matchLatency, 95)}ms   p99 ${percentile(stats.matchLatency, 99)}ms`,
    );
    lines.push('  (match latency depends on who else is waiting, not on server speed)');
  }

  if (stats.errorsByCode.size > 0) {
    lines.push('');
    lines.push('PROTOCOL ERRORS  (several of these are the server working correctly)');
    lines.push(...top(stats.errorsByCode, 12));
  }
  if (stats.connectRefusals.size > 0) {
    lines.push('');
    lines.push('UPGRADES REFUSED  (429 is a per-IP control doing its job)');
    lines.push(...top(stats.connectRefusals));
  }
  if (stats.harnessErrors > 0) {
    lines.push('');
    lines.push(`HARNESS ERRORS: ${stats.harnessErrors} — the generator misbehaved, read before trusting the run`);
  }

  const failed = input.result.oracles.filter((oracle) => oracle.status === 'fail');
  const skipped = input.result.oracles.filter((oracle) => oracle.status === 'skipped');
  lines.push('');
  lines.push('-'.repeat(72));
  lines.push(
    failed.length > 0
      ? `VERDICT: FAIL — ${failed.map((oracle) => oracle.name).join(', ')}`
      : `VERDICT: PASS${skipped.length > 0 ? ` (${skipped.length} oracle(s) did not run)` : ''}`,
  );
  lines.push('-'.repeat(72));
  lines.push('');

  const text = lines.join('\n');
  console.log(text);

  writeFileSync(join(input.runDir, 'report.txt'), `${text}\n`, 'utf8');
  writeFileSync(
    join(input.runDir, 'report.json'),
    `${JSON.stringify(
      {
        runId: input.runId,
        options: input.options,
        lag: input.lag,
        oracles: input.result.oracles,
        stats: {
          ...stats,
          errorsByCode: Object.fromEntries(stats.errorsByCode),
          connectRefusals: Object.fromEntries(stats.connectRefusals),
          routes: Object.fromEntries(stats.routes),
          // Samples are large and are already summarised above.
          ackLatency: undefined,
          matchLatency: undefined,
          ackLatencyP95: percentile(stats.ackLatency, 95),
          matchLatencyP95: percentile(stats.matchLatency, 95),
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}
