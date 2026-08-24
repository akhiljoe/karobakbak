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

function total(samples: readonly Sample[], name: string, only?: ReadonlySet<string>): number {
  return samples
    .filter((s) => s.name === name && (only === undefined || only.has(s.target)))
    .reduce((sum, s) => sum + s.value, 0);
}

/**
 * The endpoints that answered in *every* phase.
 *
 * C2 kills a backend, so its counters stop appearing rather than going to zero,
 * and a sum over "whatever answered" falls when an endpoint disappears. That
 * reads as delivery collapsing -- the exact conclusion C2 exists to test for,
 * reached by arithmetic instead of by evidence. Comparing like with like means
 * comparing the instances that were alive throughout.
 */
function survivors(phases: readonly Phase[]): Set<string> {
  const seen = phases.map((phase) => new Set(phase.samples.map((s) => s.target)));
  const [first, ...rest] = seen;
  if (first === undefined) return new Set();
  return new Set([...first].filter((target) => rest.every((s) => s.has(target))));
}

/** The highest value any instance reports, for a cluster-wide gauge. */
function peak(samples: readonly Sample[], name: string): number {
  const values = samples.filter((s) => s.name === name).map((s) => s.value);
  return values.length === 0 ? 0 : Math.max(...values);
}

function rate(from: Phase, to: Phase, name: string, only?: ReadonlySet<string>): number {
  const seconds = Math.max(1, (to.atMs - from.atMs) / 1000);
  return (total(to.samples, name, only) - total(from.samples, name, only)) / seconds;
}

type Phase = ChaosResult['phases'][number];

export function checkChaos(result: ChaosResult): OracleResult {
  const name = 'chaos: the failure stayed where it belonged';

  if (result.scenario === '') {
    return {
      name,
      status: 'skipped',
      summary: 'no chaos scenario requested',
      details: [
        'Run with --chaos c1 to pause PostgreSQL mid-run and test D16, or',
        '--chaos c2 to kill a backend and test that losing one instance is not',
        'losing the service.',
      ],
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

  if (result.scenario === 'c2') return checkKilledBackend(name, before, during, after);

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

/**
 * C2 -- what must remain true when a backend is killed outright.
 *
 * ---------------------------------------------------------------------------
 * TWO PROMISES, AND THE SECOND IS THE ONE NOTHING ELSE CAN SEE
 * ---------------------------------------------------------------------------
 * **Delivery continues on the survivors.** Losing one instance must not be
 * losing the service. Measured only across the endpoints that answered in every
 * phase, because the dead one stops reporting rather than reporting zero, and a
 * naive sum would manufacture the very collapse being tested for.
 *
 * **The population comes back.** Every socket on the victim dropped at once;
 * those clients must reconnect and be chatting again by the end. This is the
 * half the harness itself once got wrong -- 244 of 400 bots died permanently to
 * a 502 while the run went on reporting 400 -- and a run that quietly loses a
 * third of its bots passes every other oracle in this directory, because they
 * all measure agreement rather than size. It fails here or nowhere.
 *
 * Recovery is judged against the survivors' own load, not against a headcount:
 * what matters is that the cluster is carrying its traffic again, and after a
 * restart the two instances do not split it the way they did before.
 */
function checkKilledBackend(
  name: string,
  before: Phase,
  during: Phase,
  after: Phase,
): OracleResult {
  const alive = survivors([before, during, after]);

  const survivingBefore = rate(before, during, 'chat_messages_delivered_total', alive);
  const survivingAfter = rate(during, after, 'chat_messages_delivered_total', alive);

  // A per-instance gauge, so it sums. Read across every endpoint that answered
  // at the end, including the restarted one -- the question is whether the
  // cluster is carrying its clients again, not which host they landed on.
  const connectedBefore = total(before.samples, 'chat_connections_active');
  const connectedDuring = total(during.samples, 'chat_connections_active');
  const connectedAfter = total(after.samples, 'chat_connections_active');

  const details: string[] = [
    `delivery on the survivors, instance down: ${survivingBefore.toFixed(1)} msg/s`,
    `delivery on the survivors, after restart: ${survivingAfter.toFixed(1)} msg/s`,
    `connections: ${connectedBefore} before, ${connectedDuring} with the instance down, ${connectedAfter} after`,
    `instances answering in every phase: ${alive.size}`,
  ];

  if (survivingBefore <= 0) {
    return {
      name,
      status: 'fail',
      summary: 'killing one backend stopped delivery on the others',
      details: [
        ...details,
        'The surviving instances kept their sockets and their Redis state, so a',
        'flat delivery counter here is not the victim being missed -- it is the',
        'survivors having stopped work of their own. Cross-instance delivery is',
        'Pub/Sub on a per-session channel, so suspect a subscription that was not',
        'reestablished rather than a routing table, because there is no table.',
      ],
    };
  }

  // Two thirds is deliberately generous. Some loss is honest: a bot whose
  // partner was on the victim has a conversation to rebuild, and the resume
  // window is not instant. What this refuses to accept is a population that
  // came back in name only.
  const recovered = connectedAfter >= connectedBefore * 0.66;
  if (!recovered) {
    return {
      name,
      status: 'fail',
      summary: `only ${connectedAfter} of ${connectedBefore} connections came back`,
      details: [
        ...details,
        'A run that silently loses a third of its population still passes every',
        'other oracle here, because they all check agreement rather than size.',
        'Check the harness before the product, because the first C2 run failed',
        'here and the harness was the reason: a bot whose socket closed without',
        'its persona having asked was finished permanently, so killing a backend',
        'removed everyone on it for good. `reconnectOnDrop` is set for chaos runs',
        'now. If it is off, this number means nothing.',
        'After that: whether the restarted instance is accepting upgrades at all,',
        'and whether the clients gave up -- nginx answers 502 for as long as it',
        'has no upstream, and a refusal treated as terminal is trap 19.',
      ],
    };
  }

  const observations: string[] = [];
  // Whether the kill landed is a question about the *victim*, not about the
  // total. Clients reconnect to the survivor within seconds, so the population
  // barely dips -- which is the system working, and was briefly mistaken here
  // for evidence that nothing had been killed.
  const endpointsBefore = new Set(before.samples.map((sample) => sample.target)).size;
  if (alive.size > 0 && alive.size >= endpointsBefore) {
    observations.push(
      'Every endpoint answered in every phase, so nothing appears to have been ' +
        'killed. Check that --containers names a backend that is actually in ' +
        '--metrics; a kill that missed leaves this oracle measuring an ordinary run.',
    );
  }

  return {
    name,
    status: observations.length > 0 ? 'warn' : 'pass',
    summary:
      observations.length > 0
        ? `survivors carried ${survivingBefore.toFixed(1)} msg/s; ${observations.length} caveat(s)`
        : `losing an instance was not losing the service: survivors carried ` +
          `${survivingBefore.toFixed(1)} msg/s and ${connectedAfter} of ${connectedBefore} connections came back`,
    details: [...details, ...observations],
  };
}
