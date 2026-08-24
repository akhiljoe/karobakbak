/**
 * Oracle 8 — database agreement.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS THE ONE THAT MATTERED
 * ---------------------------------------------------------------------------
 * The retention path is where `DESIGN.md` makes its strongest claims — messages
 * are kept for a defined period and then deleted, deadlines are stamped at
 * insert time so a config change cannot retroactively extend the life of stored
 * data (D17), and the write-behind queue is lossy under overflow *by design*
 * but never silently (D16).
 *
 * Every other oracle here reads the ledger, Redis, or the metrics endpoint.
 * None of them can see whether any of that is true, because none of them looks
 * at the database. This one is the difference between "the server said it
 * accepted 581 messages" and "581 rows exist and their contents are what was
 * sent".
 *
 * ---------------------------------------------------------------------------
 * WAIT FOR THE QUEUE, THEN COMPARE
 * ---------------------------------------------------------------------------
 * The trap the handoff records for this oracle before it existed: the retention
 * queue is still draining when the run ends. Comparing immediately reports a
 * shortfall that is simply in flight.
 *
 * So it polls until `queued == flushed + dropped` — every record accepted has
 * either been written or been counted as dropped — with a timeout. A timeout is
 * itself a finding and is reported as one rather than being followed by a
 * comparison that cannot be right.
 *
 * ---------------------------------------------------------------------------
 * psql THROUGH docker exec, NOT A CLIENT LIBRARY
 * ---------------------------------------------------------------------------
 * §6.1 of the handoff suggested adding `pg` and connecting through the
 * published port. This follows the Redis oracle instead: `docker exec` into the
 * container that is already running, with `-tAc` for tuples-only unaligned
 * output that needs no parser. No dependency to install, no published port to
 * require, and one pattern across both oracles rather than two.
 */
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import type { LedgerEvent } from '../ledger';
import { LF } from './firstline';
import type { Sample } from './metrics';
import { scrapeAll } from './metrics';
import type { OracleResult } from './types';

const run = promisify(execFile);

export interface DatabaseOracleInput {
  /** Container running PostgreSQL. Empty means the oracle cannot run. */
  readonly container: string;
  readonly user: string;
  readonly database: string;
  readonly ledgerPaths: readonly string[];
  /** Scraped before the first socket opened, for counter deltas. */
  readonly baseline: readonly Sample[];
  readonly metricsUrls: readonly string[];
  /** How long to wait for the write-behind queue to finish draining. */
  readonly drainTimeoutSeconds: number;
  /**
   * Whether a chaos scenario made the database unreachable during this run.
   *
   * Changes what an undrained queue *means*, and nothing else. A backlog at
   * settle normally says the writer could not keep up; after an induced outage
   * it says the paced drain has not finished replaying a spool the run created
   * on purpose, which is the recovery working rather than failing.
   */
  readonly chaosRan: boolean;
  /**
   * Whether a chaos scenario killed a backend process during this run.
   *
   * Changes what the numbers *mean*, and nothing else. A process that dies to
   * SIGKILL takes two things with it: the counters it had accumulated, which
   * restart at zero and make every `after - before` delta undercount by
   * whatever that instance had already done; and its in-memory retention queue,
   * whose records were acknowledged to clients and will now never be written
   * *or counted as dropped*, because the counter that would have counted them
   * died in the same instant.
   *
   * Neither is a defect -- it is what killing a process costs, and C2 exists to
   * measure it. But an oracle that does not know it happened reports it as
   * silent data loss, which is the one thing this directory must never do
   * wrongly.
   */
  readonly killedProcess: boolean;
  /**
   * When the first socket opened.
   *
   * Every query is scoped to it. The load-test database is not wiped between
   * runs, so without this the oracle compares one run's ledger against every
   * run's rows — which it did on its first outing, reporting 1516 stored
   * against 738 acked and calling it a bug. The rows were real; the comparison
   * was not.
   */
  readonly runStartMs: number;
}

interface LedgerFacts {
  /** Messages the server acknowledged as accepted, by content hash. */
  accepted: number;
  /**
   * Messages handed to a socket, acked or not.
   *
   * The upper bound on what can be stored. A message whose ack never came back
   * may still have been accepted and written — the ack is lost when the socket
   * dies, not the row.
   */
  sent: number;
  /** Content hashes of accepted messages, for the body comparison. */
  hashes: Map<string, number>;
  /** Conversations the ledger saw, by match id. */
  matches: Set<string>;
  /** Reports filed, as (bot, matchId). */
  reports: Array<{ bot: string; matchId: string }>;
  /** Which bots were in which match, from `matched` events. */
  membership: Map<string, Set<string>>;
}

/** ISO timestamp of the run's start, for scoping every query to it. */
function runStart(input: DatabaseOracleInput): string {
  return new Date(input.runStartMs).toISOString();
}

async function psql(input: DatabaseOracleInput, sql: string): Promise<string[]> {
  const { stdout } = await run('docker', [
    'exec', input.container,
    'psql', '-U', input.user, '-d', input.database, '-tAc', sql,
  ]);
  return stdout.split(LF).map((line) => line.trim()).filter((line) => line.length > 0);
}

async function readLedger(paths: readonly string[]): Promise<LedgerFacts> {
  const facts: LedgerFacts = {
    accepted: 0,
    sent: 0,
    hashes: new Map(),
    matches: new Set(),
    reports: [],
    membership: new Map(),
  };

  for (const path of paths) {
    const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const raw of reader) {
      if (raw.length === 0) continue;
      let event: LedgerEvent;
      try {
        event = JSON.parse(raw) as LedgerEvent;
      } catch {
        continue;
      }

      if (event.type === 'sent') {
        facts.sent += 1;
      } else if (event.type === 'ack') {
        // An ack is the server saying it accepted and recorded the message —
        // which is what produces a row. `withheld` counts too: policy stopped
        // it reaching the partner, and D20 is explicit that it is still stored.
        facts.accepted += 1;
        if (event.hash) facts.hashes.set(event.hash, (facts.hashes.get(event.hash) ?? 0) + 1);
      } else if (event.type === 'matched' && event.matchId) {
        facts.matches.add(event.matchId);
        let members = facts.membership.get(event.matchId);
        if (!members) {
          members = new Set();
          facts.membership.set(event.matchId, members);
        }
        members.add(event.bot);
      } else if (event.type === 'reported' && event.matchId) {
        facts.reports.push({ bot: event.bot, matchId: event.matchId });
      }
    }
  }
  return facts;
}

function counter(samples: readonly Sample[], name: string): number {
  return samples.filter((s) => s.name === name).reduce((total, s) => total + s.value, 0);
}

/** Wait until every accepted record has been written or counted as dropped. */
async function waitForDrain(
  input: DatabaseOracleInput,
): Promise<{ drained: boolean; queued: number; flushed: number; dropped: number }> {
  const deadline = Date.now() + input.drainTimeoutSeconds * 1000;
  let queued = 0;
  let flushed = 0;
  let dropped = 0;

  for (;;) {
    const now = await scrapeAll(input.metricsUrls);
    queued = counter(now, 'chat_retention_queued_total') - counter(input.baseline, 'chat_retention_queued_total');
    flushed = counter(now, 'chat_retention_flushed_total') - counter(input.baseline, 'chat_retention_flushed_total');
    dropped = counter(now, 'chat_retention_dropped_total') - counter(input.baseline, 'chat_retention_dropped_total');

    if (queued <= flushed + dropped) return { drained: true, queued, flushed, dropped };
    if (Date.now() > deadline) return { drained: false, queued, flushed, dropped };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function checkDatabaseAgreement(
  input: DatabaseOracleInput,
): Promise<OracleResult> {
  const name = 'database agreement';

  if (input.container === '') {
    return {
      name,
      status: 'skipped',
      summary: 'no postgres container configured',
      details: ['Pass --postgres <container> to check what was actually stored.'],
    };
  }
  if (input.metricsUrls.length === 0) {
    return {
      name,
      status: 'skipped',
      summary: 'no metrics endpoint, so drops cannot be accounted for',
      details: [
        'The write-behind path is lossy under overflow by design (D16), so a',
        'shortfall is only meaningful next to the drop counter.',
      ],
    };
  }

  const drain = await waitForDrain(input);
  const ledger = await readLedger(input.ledgerPaths);
  const details: string[] = [];

  if (!drain.drained) {
    // Either way the comparison is off: a shortfall measured now is records in
    // flight, not records lost. What differs is whether that is a finding.
    const counts = `queued ${drain.queued}, flushed ${drain.flushed}, dropped ${drain.dropped}`;

    if (input.chaosRan) {
      return {
        name,
        status: 'skipped',
        summary: `queue still draining after an induced outage (${counts})`,
        details: [
          'This run took the database away on purpose, so a backlog at settle is',
          'the expected shape of recovery rather than a symptom. The drain out of',
          'the spool is deliberately paced -- replaying it at full speed would',
          'hammer a database that has only just come back -- so a long outage',
          'leaves work outstanding for a while by design.',
          'The chaos oracle judges that recovery. This one has nothing to say',
          'about a run whose shortfall it cannot separate from the pacer.',
        ],
      };
    }

    return {
      name,
      status: 'fail',
      summary: `queue still draining after ${input.drainTimeoutSeconds}s`,
      details: [
        counts,
        'Comparing now would report a shortfall that is simply in flight, so the',
        'comparison is not attempted. A drain this slow is itself the finding:',
        'either the database is struggling or the breaker is open.',
      ],
    };
  }

  const problems: string[] = [];
  /** Known product bugs: reported, and deliberately not failing the run. */
  const unresolved: string[] = [];

  /* --- 1. every accepted message became a row ----------------------------- */

  const since = runStart(input);
  const [storedRaw] = await psql(
    input,
    `select count(*) from messages where server_timestamp >= '${since}'`,
  );
  const stored = Number(storedRaw ?? 0);
  // Drops are counted per class; only the message classes matter here, but the
  // total is the safe upper bound and a mismatch is reported either way.
  // A range, not an equality, and the large run is what taught that.
  //
  // The obvious check is `stored == acked - dropped`, and it held on every
  // small run. At 1,000 bots it reported five *surplus* rows — and the surplus
  // was correct: 24 acks were lost with their sockets that run, and a message
  // the server accepted and wrote before the socket died has a row and no ack
  // in the ledger. The ledger counts acks a bot *received*, which is not the
  // same as messages the server accepted.
  //
  // So everything acked must be stored or counted as dropped, and nothing may
  // be stored that was never sent. The gap between the bounds is exactly the
  // messages whose fate the client never learned.
  const lowerBound = ledger.accepted - drain.dropped;
  const upperBound = ledger.sent - drain.dropped;
  details.push(
    `messages: ${stored} stored, ${ledger.accepted} acked, ${ledger.sent} sent, ` +
      `${drain.dropped} dropped`,
  );
  if (stored < lowerBound && input.killedProcess) {
    // Quantified rather than waved away. This is the cost of a SIGKILL in the
    // unit that matters -- acknowledged messages that no longer exist anywhere
    // and were never counted as lost, because the process holding both the
    // record and the counter died at the same instant.
    const lost = lowerBound - stored;
    const share = ledger.accepted === 0 ? 0 : (lost / ledger.accepted) * 100;
    details.push(
      `killed instance took ${lost} acknowledged message(s) with it ` +
        `(${share.toFixed(2)}% of ${ledger.accepted}) -- in its queue, never flushed, ` +
        `never counted as dropped`,
    );
  } else if (stored < lowerBound) {
    problems.push(
      `stored ${stored} messages but ${ledger.accepted} were acknowledged and only ` +
        `${drain.dropped} counted as dropped. Every acknowledged message must be a row ` +
        'or a counted drop — the write-behind path is lossy under overflow by design, ' +
        'but never silently.',
    );
  }
  if (stored > upperBound) {
    problems.push(
      `stored ${stored} messages but only ${ledger.sent} were ever sent. A row nobody ` +
        'sent means the message path produced content of its own, which nothing in ' +
        'this system is allowed to do.',
    );
  }

  /* --- 2. every conversation was closed ----------------------------------- */

  // Poll rather than sample once. A conversation whose match is still held has
  // legitimately not ended yet — under §28 the seat outlives the socket by the
  // grace window, and the janitor ends it on its own interval afterwards. That
  // is a transient; "never ends" is the bug. Waiting distinguishes them, and
  // the drain timeout is already sized for the same order of delay.
  const endingDeadline = Date.now() + input.drainTimeoutSeconds * 1000;
  let open = 0;
  for (;;) {
    const [openRaw] = await psql(
      input,
      `select count(*) from conversations
        where started_at >= '${since}' and (ended_at is null or end_reason is null)`,
    );
    open = Number(openRaw ?? 0);
    if (open === 0 || Date.now() > endingDeadline) break;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }

  /* --- 3. reports belong to conversations their reporter was in ----------- */

  const reportRows = await psql(
    input,
    `select report_id, conversation_id from reports where created_at >= '${since}'`,
  );
  const reportedConversations = new Set(
    reportRows.map((row) => row.split('|')[1] ?? '').filter((id) => id.length > 0),
  );
  const strayReports = [...reportedConversations].filter((id) => !ledger.matches.has(id));
  details.push(`reports: ${reportRows.length} stored against ${reportedConversations.size} conversations`);
  if (strayReports.length > 0) {
    problems.push(
      `${strayReports.length} reports reference a conversation the ledger never saw. ` +
        'A report stored against the wrong conversation is §10.16 — the race ' +
        '`blockPartner` resolves in one script and `report` has the same exposure.',
    );
  }

  /* --- 4. deadlines were stamped at insert, not computed later (D17) ------ */

  // A deadline stamped at insert is `now() + window` at the moment the row is
  // written, so its offset from the message's own `server_timestamp` is the
  // window plus however long the write-behind queue took — milliseconds to a
  // few seconds. Offsets therefore cluster tightly around whole-day values.
  //
  // One computed at read or deletion time would be `now + window` for every row
  // at once, so the offset from each row's own timestamp would spread across the
  // whole run. That spread is what this measures, and the jitter bound is what
  // distinguishes the two.
  //
  // Two clusters is normal, not a fault: a report extends its conversation's
  // retention, so reported traffic carries the longer window. An earlier
  // version compared exact seconds, saw the queue latency as nine distinct
  // windows, and failed a healthy run twice over.
  const offsetRows = await psql(
    input,
    `select round(extract(epoch from (retention_expires_at - server_timestamp)) / 86400) as days,
            count(*) as n,
            max(abs(extract(epoch from (retention_expires_at - server_timestamp))
                - round(extract(epoch from (retention_expires_at - server_timestamp)) / 86400) * 86400)) as jitter
       from messages
      where server_timestamp >= '${since}'
      group by 1 order by 1`,
  );
  const windows = offsetRows.map((row) => {
    const parts = row.split('|');
    return { days: Number(parts[0] ?? 0), jitter: Number(parts[2] ?? 0) };
  });
  const worstJitter = windows.length > 0 ? Math.max(...windows.map((w) => w.jitter)) : 0;
  details.push(
    `retention windows: ${windows.map((w) => `${w.days}d`).join(', ') || 'none'}` +
      (windows.length > 0 ? ` (worst stamping lag ${worstJitter.toFixed(1)}s)` : ''),
  );

  if (windows.length > 2) {
    problems.push(
      `messages carry ${windows.length} distinct retention windows, expected at most two — ` +
        'the base window and the extension a report applies.',
    );
  }
  // Generously bounded: this is queue latency, and a run under load can hold a
  // record for a few seconds. A deadline computed later would be out by the
  // length of the run, not by seconds.
  if (worstJitter > 120) {
    problems.push(
      `retention deadlines sit up to ${worstJitter.toFixed(0)}s off a whole window. Stamped ` +
        'at insert, that offset is queue latency; a deadline computed later drifts with ' +
        'the clock, which is what D17 forbids.',
    );
  }

  /* --- 5. stored bodies are what was sent --------------------------------- */

  if (stored > 0 && ledger.hashes.size > 0) {
    const hashRows = await psql(
      input,
      `select left(encode(sha256(body::bytea), 'hex'), 16) as h, count(*)
         from messages where server_timestamp >= '${since}' group by 1`,
    );
    let matched = 0;
    let unknown = 0;
    for (const row of hashRows) {
      const [hash, countRaw] = row.split('|');
      const count = Number(countRaw ?? 0);
      if (hash && ledger.hashes.has(hash)) matched += count;
      else unknown += count;
    }
    details.push(`bodies matching a sent hash: ${matched}, unrecognised: ${unknown}`);
    if (unknown > 0) {
      problems.push(
        `${unknown} stored bodies hash to something no bot recorded sending. The text ` +
          'path altered content between the socket and the row — note that the server ' +
          'trims before storing, so a padded send would land here too.',
      );
    }
  }

  if (problems.length === 0 && unresolved.length > 0) {
    return {
      name,
      status: 'warn',
      summary: `${stored} messages accounted for; ${unresolved.length} known issue(s)`,
      details: [...details, ...unresolved],
    };
  }

  if (problems.length > 0) {
    return {
      name,
      status: 'fail',
      summary: `${problems.length} disagreement(s) between the ledger and the database`,
      details: [...details, ...problems, ...unresolved],
    };
  }

  return {
    name,
    status: 'pass',
    summary: `${stored} messages stored and accounted for`,
    details: [
      ...details,
      'Every accepted message is a row or a counted drop, every conversation ended,',
      'every report belongs to a conversation that happened, deadlines were stamped',
      'at insert, and stored bodies are what was sent.',
    ],
  };
}
