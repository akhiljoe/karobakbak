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
  /**
   * Workers that did not finish cleanly.
   *
   * The verdict has to account for this. A run that lost a worker has a
   * truncated ledger, and every oracle then reads a smaller, self-consistent
   * population that passes happily — which is how a crashed run printed PASS
   * on eleven conversations out of an intended thousand.
   */
  readonly lostWorkers: number;
  /**
   * A person was in the population, through a browser, at the same stack.
   *
   * Printed rather than acted on. A human is invisible to the ledger and shows
   * up only as its consequences — a conversation with one side missing, server
   * counters ahead of what the bots sent — and those look exactly like a lost
   * worker to anybody reading the report cold.
   */
  readonly human?: boolean;
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
  if (input.human === true) {
    lines.push(
      'a person took part in this run: conversations with one side missing, and server',
    );
    lines.push(
      'counters running ahead of the ledger, include theirs. Not capacity numbers.',
    );
  }
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
  lines.push(`  withheld, sender acked:   ${stats.messagesWithheld}`);
  lines.push(`  refused, MESSAGE_WITHHELD:${stats.messagesBlocked}`);
  if (stats.routes.size > 0) {
    lines.push('  delivery route:');
    lines.push(...top(stats.routes));
  }

  if (stats.resumesOffered > 0 || stats.partnersHeld > 0) {
    lines.push('');
    lines.push('RESUMPTION  (a dropped socket no longer ends a conversation — D42)');
    lines.push(`  resume tokens presented:  ${stats.resumesOffered}`);
    lines.push(`  conversations reclaimed:  ${stats.resumesSucceeded}`);
    lines.push(`  fell back to a new session:${stats.resumesExpired}`);
    lines.push(`  partners held, then told:  ${stats.partnersHeld}`);
    lines.push(`  partners who came back:    ${stats.partnersReturned}`);
    lines.push(`  acks lost with the socket: ${stats.acksLost}`);
    if (stats.resumesOffered > 0) {
      const kept = Math.round((stats.resumesSucceeded / stats.resumesOffered) * 100);
      lines.push(
        `  ${kept}% of reconnections kept their conversation. A low figure is not a fault —`,
      );
      lines.push(
        '  it is the grace window being shorter than the reconnections people make.',
      );
    }
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

  const spam = input.result.spam;
  if (spam) {
    lines.push('');
    lines.push('SAFETY  (the answer to "would we identify the bots")');
    lines.push(`  labelled spammers planted:      ${spam.labelledSpammers}`);
    lines.push(`  caught by a live control:       ${spam.caughtLive}`);
    if (spam.caughtLive === 0) {
      lines.push('                                  nothing compares a message to what the same');
      lines.push('                                  sender said in another conversation');
    }
    lines.push(
      `  offline query, exact content:   ${spam.detectedExact}/${spam.labelledSpammers}` +
        `   (${spam.falsePositivesExact} false positive(s))`,
    );
    lines.push(
      `  offline query, normalised view: ${spam.detectedNormalised}/${spam.labelledSpammers}` +
        `   (${spam.falsePositivesNormalised} false positive(s))`,
    );
    lines.push(
      `  a campaign canonical form:      ${spam.detectedCampaign}/${spam.labelledSpammers}` +
        `   (${spam.falsePositivesCampaign} false positive(s))  <- would need building`,
    );
    if (spam.falsePositivesNormalised > 0) {
      lines.push('  the false positives are the point, not a fault: they are what a campaign');
      lines.push('  detector would cost in wrongly-accused ordinary users, and they rise with');
      lines.push('  run length because a person with a finite vocabulary eventually repeats.');
    }
    lines.push(`  strangers reached per spammer:  median ${spam.medianReach}, worst ${spam.maxReach}`);
    if (spam.medianTimeToSanction === null) {
      lines.push('  time to first block or report:  never, for any of them');
    } else {
      lines.push(
        `  time to first block or report:  ${spam.medianTimeToSanction.toFixed(1)}s median, ` +
          `for ${spam.sanctionedSpammers} of ${spam.labelledSpammers}`,
      );
      lines.push(
        `  strangers reached after that:   ${spam.reachAfterSanction} — a block protects the blocker, nobody else`,
      );
    }
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
  if (input.lostWorkers > 0) {
    lines.push(
      `VERDICT: FAIL — ${input.lostWorkers} worker(s) died; the population was incomplete`,
    );
    lines.push('Every number above describes only the bots that survived. Re-run before reading it.');
  } else {
    lines.push(
      failed.length > 0
        ? `VERDICT: FAIL — ${failed.map((oracle) => oracle.name).join(', ')}`
        : `VERDICT: PASS${skipped.length > 0 ? ` (${skipped.length} oracle(s) did not run)` : ''}`,
    );

    /*
      Name the oracles that skipped for want of a flag, not the ones the run
      never asked for.

      "PASS (2 oracle(s) did not run)" reads as a complete run with a footnote,
      and it is not: `database agreement` is the only check that looks at
      PostgreSQL at all, and it skipped out of every documented invocation for
      months because `--postgres` was missing from the command in the README.
      A pass that never opened the database is a different, much weaker claim
      than a pass that did, and the summary line was not saying so.

      `--chaos` and an absent A14 group are deliberate omissions and stay quiet.
      What is listed here is configuration that was probably forgotten.
    */
    const forgotten = skipped.filter((oracle) => oracle.needsConfiguration === true);
    if (forgotten.length > 0) {
      lines.push(
        `  ...but ${forgotten.length} of those needed a flag this run did not pass: ` +
          `${forgotten.map((oracle) => oracle.name).join(', ')}.`,
      );
      lines.push('  A pass that skipped them is a weaker claim than a pass that did not.');
    }
  }
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
        lostWorkers: input.lostWorkers,
        oracles: input.result.oracles,
        spam: input.result.spam,
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
