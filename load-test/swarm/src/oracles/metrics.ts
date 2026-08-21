/**
 * Oracle 2 — metric conservation.
 *
 * The server counts what it did; the ledger counts what the clients saw. Where
 * those two disagree, one of them is wrong, and the disagreement is usually
 * more informative than either number alone.
 *
 * Three relationships are checked:
 *
 *   1. **Matches.** Every match has two participants, so the number of
 *      `matched` frames in the ledger should be twice `chat_matches_created_total`.
 *      A tolerance exists only for matches formed in the last instant of the
 *      run, where one side's frame never arrived before the drain.
 *   2. **Messages.** `received == accepted + rejected`, both counters read from
 *      the server, with the ledger's ack count standing in for `accepted`. A
 *      shortfall means messages were accepted and answered with nothing, which
 *      a client experiences as a silent failure; an excess is impossible and
 *      means the harness is miscounting.
 *   3. **Gauges return to zero.** After a drain, `chat_queue_depth` and
 *      `chat_active_matches` must reach zero. A value that stops shrinking is
 *      state that outlived every session that created it, which is exactly the
 *      leak that only appears at scale.
 *
 *      Both are cluster-wide values refreshed only by the janitor's lock
 *      holder, so they are read with `max` across instances and never summed —
 *      see `clusterGauge`.
 *
 * Metrics are per instance and are summed across the endpoints given.
 *
 * Counters are read **twice**: once before the first socket opens and once
 * after the drain, and only the difference is judged. An earlier version read
 * them once at the end, on the assumption that a run starts against a fresh
 * stack. The second run of the day disproved that — the compose stack persists
 * between runs, so the counters carried the previous run's totals and the
 * oracle reported a conservation failure that was entirely arithmetic. A load
 * harness that can only be trusted on a cold stack is a harness that will lie
 * on exactly the day somebody runs it twice.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { firstLine } from './firstline';
import type { OracleResult } from './types';
import type { LedgerStats } from './ledger';

const run = promisify(execFile);

export interface MetricsInput {
  /**
   * Either an HTTP URL, or a Docker container name.
   *
   * A container name is the useful case here and the reason this is not just
   * `fetch`. The backends are replicas of one compose service, so they cannot
   * publish a host port — two replicas cannot share one — and nginx
   * deliberately refuses to proxy `/metrics` at all, because a scrape endpoint
   * belongs on the private network and not on the internet. Reading it from
   * inside the container is therefore the only way to scrape a replica without
   * weakening either of those decisions for the sake of a test.
   */
  readonly urls: readonly string[];
  readonly stats: LedgerStats;
  /** Number of `matched` frames the ledger saw. */
  readonly matchedFrames: number;
  /**
   * Seconds to wait before the *second* scrape.
   *
   * Queue entries are repaired lazily: `tryMatch` cleans whatever it walks
   * over, and the leader-locked janitor sweeps the rest. So a non-zero queue
   * depth one second after the last socket closed is not a leak, it is a queue
   * nobody has scanned yet — and asserting zero immediately makes the oracle
   * fail for a reason the design chose on purpose.
   *
   * Two scrapes separated by a settle window tell the two apart: state that is
   * shrinking is being reclaimed, state that is unchanged has been abandoned.
   */
  readonly settleSeconds: number;
  /**
   * Counter values from before the run, so only this run's work is judged.
   * Empty means no baseline was taken and counters cannot be compared.
   */
  readonly baseline: readonly Sample[];
}

/** One sample: a metric name, its labels as written, and its value. */
export interface Sample {
  name: string;
  labels: string;
  value: number;
}

/** Minimal Prometheus text-format parser: enough for counters and gauges. */
export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const brace = line.indexOf('{');
    const space = line.lastIndexOf(' ');
    if (space === -1) continue;
    const value = Number(line.slice(space + 1));
    if (!Number.isFinite(value)) continue;
    if (brace === -1 || brace > space) {
      samples.push({ name: line.slice(0, space), labels: '', value });
    } else {
      const close = line.lastIndexOf('}', space);
      samples.push({
        name: line.slice(0, brace),
        labels: line.slice(brace + 1, close),
        value,
      });
    }
  }
  return samples;
}

function sum(samples: readonly Sample[], name: string): number {
  return samples.filter((sample) => sample.name === name).reduce((total, s) => total + s.value, 0);
}

/** A counter's growth during the run. Counters are per instance, so they add. */
function delta(after: readonly Sample[], before: readonly Sample[], name: string): number {
  return sum(after, name) - sum(before, name);
}

/**
 * A **cluster-wide** gauge, read as the maximum across instances rather than
 * the sum.
 *
 * `chat_active_matches` and `chat_queue_depth` are not per-instance numbers
 * that happen to be exported per instance. They are one Redis cardinality,
 * written by whichever instance currently holds the janitor's leader lock
 * (`server.ts:96-102`) — which means the follower's copy is frozen at whatever
 * it last held while it was leader, possibly for the whole run.
 *
 * Summing them therefore adds a live value to a stale one and reports a leak
 * that does not exist. The shipped Grafana dashboard already reads them with
 * `max(...)` for this exact reason; this is the harness agreeing with it.
 */
function clusterGauge(samples: readonly Sample[], name: string): number {
  const values = samples.filter((sample) => sample.name === name).map((sample) => sample.value);
  return values.length === 0 ? 0 : Math.max(...values);
}

/**
 * Scrape every target and parse the result, ignoring the ones that fail.
 *
 * Used for the baseline before a run as well as inside the oracle, so both
 * readings are taken exactly the same way.
 */
export async function scrapeAll(targets: readonly string[]): Promise<Sample[]> {
  const samples: Sample[] = [];
  for (const target of targets) {
    try {
      const text = target.startsWith('http')
        ? await scrapeHttp(target)
        : await scrapeContainer(target);
      samples.push(...parsePrometheus(text));
    } catch {
      // A baseline that could not be read is reported by its absence: the
      // oracle says so rather than silently treating zero as the start value.
    }
  }
  return samples;
}

async function scrapeHttp(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/**
 * Scrape a backend replica from inside its own container.
 *
 * `wget` is what the image already uses for its healthcheck, so nothing new is
 * installed to make a test possible — a dependency added for a test is a
 * dependency shipped to production.
 */
async function scrapeContainer(container: string): Promise<string> {
  const result = await run(
    'docker',
    ['exec', container, 'wget', '-q', '-O', '-', 'http://127.0.0.1:8080/metrics'],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return result.stdout;
}

export async function checkMetrics(input: MetricsInput): Promise<OracleResult> {
  if (input.urls.length === 0) {
    return {
      name: 'metric conservation',
      status: 'skipped',
      summary: 'no metrics endpoints given; pass --metrics to enable',
      details: [
        'nginx does not proxy /metrics by design, and replicas cannot publish a host port,',
        'so pass container names and they are scraped from inside:',
        '  --metrics karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2',
      ],
    };
  }

  const samples: Sample[] = [];
  const details: string[] = [];
  let unreachable = 0;

  for (const target of input.urls) {
    try {
      const text = target.startsWith('http')
        ? await scrapeHttp(target)
        : await scrapeContainer(target);
      samples.push(...parsePrometheus(text));
      details.push(`scraped ${target}`);
    } catch (error) {
      unreachable += 1;
      details.push(
        `could not scrape ${target}: ${firstLine(error)}`,
      );
    }
  }

  if (samples.length === 0) {
    return {
      name: 'metric conservation',
      status: 'skipped',
      summary: 'no metrics endpoint could be scraped',
      details,
    };
  }

  const failures: string[] = [];
  const warnings: string[] = [];

  if (input.baseline.length === 0) {
    warnings.push(
      'no baseline scrape: counters include work from earlier runs against this stack, so only the gauges are judged',
    );
  }

  const matchesCreated = delta(samples, input.baseline, 'chat_matches_created_total');
  const expectedFrames = matchesCreated * 2;
  const frameGap = Math.abs(expectedFrames - input.matchedFrames);
  // One percent, or ten frames, whichever is larger: a drain that lands between
  // a match being created and both sides being told is ordinary.
  const frameTolerance = Math.max(10, Math.round(expectedFrames * 0.01));
  details.push(
    `matches created ${matchesCreated}, ledger matched frames ${input.matchedFrames} (expected ~${expectedFrames})`,
  );
  if (input.baseline.length > 0 && frameGap > frameTolerance) {
    failures.push(
      `matched frames differ from matches created by ${frameGap}, beyond a tolerance of ${frameTolerance}`,
    );
  }

  // ---------------------------------------------------------------------
  // THE MESSAGE IDENTITY, WHICH TOOK THREE TRIES TO STATE CORRECTLY
  // ---------------------------------------------------------------------
  // `chat_messages_received_total` increments for every `message` command
  // before the pipeline runs — including ones the pipeline then refuses, since
  // `message` checks its own bucket inside the pipeline rather than at the
  // edge (`server.ts:382-400`). Every refusal, rate limiting included, lands in
  // `chat_messages_rejected_total` with a reason label.
  //
  // So the law is entirely server-side:
  //
  //     received == accepted + rejected
  //
  // and the ledger's ack count is the client-observed value of `accepted`.
  //
  // Earlier attempts derived `rejected` by counting error codes in the ledger,
  // which quietly over-counted: `RATE_LIMITED` is also returned for `skip`,
  // `block`, `report` and `join_queue`, and those have nothing to do with the
  // message counter. Reading the server's own rejection counter avoids having
  // to classify a client-side error code by which command provoked it.
  const received = delta(samples, input.baseline, 'chat_messages_received_total');
  const rejected = delta(samples, input.baseline, 'chat_messages_rejected_total');
  const expectedAcks = received - rejected;
  const accounted = input.stats.messagesAcked;
  details.push(
    `messages: ${received} received - ${rejected} rejected = ${expectedAcks} accepted; ledger holds ${accounted} acks`,
  );
  const ackGap = expectedAcks - accounted;
  // A message accepted in the last instant of the run can have its ack still in
  // flight when the socket closes, so a small shortfall is ordinary. An excess
  // is not: the ledger cannot hold acks the server never sent.
  if (input.baseline.length > 0 && ackGap < 0) {
    failures.push(`ledger holds ${-ackGap} more acks than the server accepted messages`);
  }
  if (input.baseline.length > 0 && ackGap > Math.max(10, Math.round(received * 0.01))) {
    warnings.push(
      `${ackGap} accepted messages have no ack in the ledger — expected only for sockets that closed mid-flight`,
    );
  }

  const queueDepth = clusterGauge(samples, 'chat_queue_depth');
  const activeMatches = clusterGauge(samples, 'chat_active_matches');
  details.push(`immediately after drain: queue depth ${queueDepth}, active matches ${activeMatches}`);

  if (queueDepth !== 0 || activeMatches !== 0) {
    details.push(`waiting ${input.settleSeconds}s for lazy cleanup, then scraping again`);
    await new Promise((done) => setTimeout(done, input.settleSeconds * 1_000));

    const second: Sample[] = [];
    for (const target of input.urls) {
      try {
        const text = target.startsWith('http')
          ? await scrapeHttp(target)
          : await scrapeContainer(target);
        second.push(...parsePrometheus(text));
      } catch {
        // The first scrape already succeeded; a failure now is a transient the
        // settle wait can absorb, and the first numbers still stand.
      }
    }

    if (second.length === 0) {
      warnings.push('second scrape failed; cannot tell reclaimable state from a leak');
    } else {
      const queueAfter = clusterGauge(second, 'chat_queue_depth');
      const matchesAfter = clusterGauge(second, 'chat_active_matches');
      details.push(`after ${input.settleSeconds}s: queue depth ${queueAfter}, active matches ${matchesAfter}`);

      // Unchanged is the signal. Shrinking is cleanup doing its job, and it is
      // reported rather than judged: how fast is a tuning question, not a
      // correctness one.
      if (queueAfter > 0 && queueAfter >= queueDepth) {
        // A warning, not a failure, and the wording matters. `max` across
        // instances returns the *stale* value whenever the follower's frozen
        // gauge is the larger one, so a stuck reading here cannot distinguish
        // an abandoned queue entry from an instance that last held the janitor
        // lock a while ago. The Redis residue oracle asks the authority
        // directly and owns the verdict; this only points at it.
        warnings.push(
          `queue depth reads ${queueAfter} and did not move in ${input.settleSeconds}s — see the redis residue oracle, which reads the queue itself`,
        );
      } else if (queueAfter > 0) {
        warnings.push(`queue depth still draining: ${queueDepth} to ${queueAfter}`);
      }

      if (matchesAfter > 0 && matchesAfter >= activeMatches) {
        warnings.push(
          `${matchesAfter} matches unchanged across the settle window; they should expire at the match TTL, which is longer than this wait`,
        );
      } else if (matchesAfter > 0) {
        warnings.push(`active matches still expiring: ${activeMatches} to ${matchesAfter}`);
      }
    }
  }

  const dropped = delta(samples, input.baseline, 'chat_retention_dropped_total');
  const queued = delta(samples, input.baseline, 'chat_retention_queued_total');
  const flushed = delta(samples, input.baseline, 'chat_retention_flushed_total');
  details.push(`retention: queued ${queued}, flushed ${flushed}, dropped ${dropped}`);
  // A handful of records can legitimately be flushed without having been
  // queued *within the window*: the counters are diffed against a baseline
  // taken before the first socket opened, so anything already in the queue at
  // that moment is flushed inside the run and queued outside it. The identity
  // is exact over the process lifetime and only approximate over a slice of it,
  // and the slack is bounded by the queue's depth rather than by the run's
  // size — which is why this is a small constant and not a percentage.
  const inFlightSlack = 64;
  if (queued > 0 && flushed + dropped > queued + inFlightSlack) {
    failures.push(`retention flushed+dropped (${flushed + dropped}) exceeds queued (${queued})`);
  }

  const rateLimited = delta(samples, input.baseline, 'chat_rate_limited_total');
  if (rateLimited > 0) details.push(`commands refused by a token bucket: ${rateLimited}`);

  return {
    name: 'metric conservation',
    status: failures.length > 0 ? 'fail' : unreachable > 0 || warnings.length > 0 ? 'warn' : 'pass',
    summary:
      failures.length > 0
        ? `${failures.length} conservation failure(s)`
        : warnings.length > 0
          ? `counters agree; ${warnings.length} thing(s) worth reading`
          : 'counters and gauges agree with the ledger',
    details: [...details, ...warnings, ...failures],
  };
}
