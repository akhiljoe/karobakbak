/**
 * Oracle 9 — chaos: did the failure stay where it belonged.
 *
 * ---------------------------------------------------------------------------
 * C1 IS THE ONLY DIRECT TEST OF D16
 * ---------------------------------------------------------------------------
 * *A database outage is never a chat outage.* Everything about the write-behind
 * path exists to make that sentence true — the priority-bounded queue, the
 * circuit breaker, the outage spool, the rule that nothing on the message path
 * awaits an insert. Until this ran, it was a claim the code argued for rather
 * than one anybody had watched happen.
 *
 * The question is about a *window*, not a total: "did delivery continue while
 * the database was unreachable" cannot be answered by a scrape taken at the
 * end, because by then every counter has moved on. So the chaos schedule
 * samples at each phase boundary and this compares the growth between them.
 *
 * ---------------------------------------------------------------------------
 * WHAT WOULD COUNT AS FAILURE
 * ---------------------------------------------------------------------------
 * Delivery stopping. That is the whole of it — if `chat_messages_delivered_total`
 * flattens while PostgreSQL is paused, then a database outage *is* a chat
 * outage and the design's central reliability claim is wrong.
 *
 * The rest is corroboration, and is reported rather than judged: the breaker
 * should open, the spool should take the overflow, and after resume the writer
 * should catch up. Those are the mechanism; delivery is the promise. A run
 * where delivery continued but the breaker never opened is a run where the
 * outage was too short to notice, which is worth saying out loud rather than
 * failing on.
 */
import type { Sample } from './metrics';
import type { ChaosResult } from '../chaos';
import type { OracleResult } from './types';

function total(samples: readonly Sample[], name: string): number {
  return samples.filter((s) => s.name === name).reduce((sum, s) => sum + s.value, 0);
}

/** The highest value any instance reports, for a cluster-wide gauge. */
function peak(samples: readonly Sample[], name: string): number {
  const values = samples.filter((s) => s.name === name).map((s) => s.value);
  return values.length === 0 ? 0 : Math.max(...values);
}

function rate(from: Phase, to: Phase, name: string): number {
  const seconds = Math.max(1, (to.atMs - from.atMs) / 1000);
  return (total(to.samples, name) - total(from.samples, name)) / seconds;
}

type Phase = ChaosResult['phases'][number];

export function checkChaos(result: ChaosResult): OracleResult {
  const name = 'chaos: the failure stayed where it belonged';

  if (result.scenario === '') {
    return {
      name,
      status: 'skipped',
      summary: 'no chaos scenario requested',
      details: ['Run with --chaos c1 to pause PostgreSQL mid-run and test D16.'],
    };
  }
  if (result.skipped !== null) {
    return { name, status: 'skipped', summary: result.skipped, details: [] };
  }

  const before = result.phases.find((p) => p.name === 'before');
  const during = result.phases.find((p) => p.name === 'during');
  const after = result.phases.find((p) => p.name === 'after');
  if (!before || !during || !after) {
    return {
      name,
      status: 'fail',
      summary: 'the chaos schedule did not complete',
      details: ['Phases recorded: ' + result.phases.map((p) => p.name).join(', ')],
    };
  }

  const deliveredBefore = rate(before, during, 'chat_messages_delivered_total');
  const deliveredDuring = rate(during, after, 'chat_messages_delivered_total');
  // `before -> during` spans the outage; `during -> after` spans recovery. The
  // names are the boundaries, so the window between them is what they describe.
  const outageRate = deliveredBefore;
  const recoveryRate = deliveredDuring;

  const details: string[] = [
    `delivery during the outage: ${outageRate.toFixed(1)} msg/s`,
    `delivery after resume:      ${recoveryRate.toFixed(1)} msg/s`,
    `breaker peak state: ${peak(during.samples, 'chat_db_breaker_state')} (2 = open)`,
    `spooled during the outage: ${total(during.samples, 'chat_spool_writes_total') - total(before.samples, 'chat_spool_writes_total')}`,
    `drained after resume: ${total(after.samples, 'chat_spool_drained_total') - total(during.samples, 'chat_spool_drained_total')}`,
    `flushed after resume: ${total(after.samples, 'chat_retention_flushed_total') - total(during.samples, 'chat_retention_flushed_total')}`,
  ];

  // The promise. Everything else in this oracle is mechanism.
  if (outageRate <= 0) {
    return {
      name,
      status: 'fail',
      summary: 'delivery stopped while the database was unreachable',
      details: [
        ...details,
        'D16 says a database outage is never a chat outage. Delivery flattening',
        'during the pause means the message path waited on PostgreSQL somewhere —',
        'the one thing the write-behind queue, the breaker and the spool exist to',
        'prevent.',
      ],
    };
  }

  const breakerOpened = peak(during.samples, 'chat_db_breaker_state') >= 1;
  const caughtUp =
    total(after.samples, 'chat_retention_flushed_total') >
    total(during.samples, 'chat_retention_flushed_total');

  const observations: string[] = [];
  if (!breakerOpened) {
    observations.push(
      'The breaker never left CLOSED, so the recovery half of the claim was not ' +
        'exercised — delivery continuing is still what is being tested, but the ' +
        'spool never came into it.',
      'The outage a breaker needs before it can open is arithmetic, not luck: ' +
        'BREAKER_FAILURE_THRESHOLD consecutive failures, each costing one ' +
        'DATABASE_STATEMENT_TIMEOUT_MS, because a paused server answers nothing ' +
        'and the driver waits out its full deadline every time. At the defaults ' +
        'that is 5 x 10s, so --chaos-for must exceed 50s with room to spare ' +
        'before CLOSED means anything other than "too short to notice".',
    );
  }
  if (!caughtUp) {
    observations.push(
      'Nothing was flushed after resume. Either there was nothing owed, or the ' +
        'writer has not caught up yet and the window after the outage was too short.',
    );
  }

  return {
    name,
    status: observations.length > 0 ? 'warn' : 'pass',
    summary:
      observations.length > 0
        ? `chat survived the outage at ${outageRate.toFixed(1)} msg/s; ${observations.length} caveat(s)`
        : `chat survived the outage at ${outageRate.toFixed(1)} msg/s, breaker opened, writer caught up`,
    details: [...details, ...observations],
  };
}
