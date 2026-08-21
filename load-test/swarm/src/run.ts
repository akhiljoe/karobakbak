/**
 * The orchestrator: builds the population, runs it, then judges the result.
 *
 *   npm run swarm -- --bots 5000 --duration 300 --profile realistic
 *   npm run swarm -- --bots 2 --duration 300 --profile tiny      # S9
 *   npm run swarm -- --seed 42 --bots 500 --duration 60
 *
 * ---------------------------------------------------------------------------
 * A RUN IS A VERDICT, NOT A GRAPH
 * ---------------------------------------------------------------------------
 * Every number this prints is secondary to one thing: did the oracles pass. A
 * load test that only reports percentiles cannot fail for the reasons that
 * matter to this product — a message delivered twice, a queue entry that
 * outlived its session, a message body in a log line. Those are pass/fail, and
 * the process exits non-zero when one of them fails.
 */
import { fork, type ChildProcess } from 'node:child_process';
import { cpus } from 'node:os';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BotSpec } from './bot';
import { loadCorpus, type Corpus } from './corpus';
import { declaredProfile } from './declared';
import { syntheticAddress } from './identity';
import { expandMix, isProfileName, personaFor, PROFILES, type ProfileName } from './personas';
import { botRng, createRng } from './rng';
import type { WorkerCommand, WorkerMessage } from './worker';
import { runOracles, scrapeAll } from './oracles';
import { printReport } from './report';

interface Options {
  url: string;
  origin: string;
  bots: number;
  durationSeconds: number;
  profile: ProfileName;
  seed: number;
  workers: number;
  rampSeconds: number;
  outDir: string;
  /** Seconds the metrics oracle waits before its second scrape. */
  settleSeconds: number;
  /** Backend `/metrics` endpoints, comma separated. Empty disables that oracle. */
  metricsUrls: string[];
  /** Docker container names whose logs the leak oracle reads. Empty disables it. */
  logContainers: string[];
  /** Container running Redis, for the residue oracle. */
  redisContainer: string;
  /** Must match REDIS_KEY_PREFIX and the matchmaking segment on the target. */
  keyPrefix: string;
  segment: string;
  /**
   * A person took part in this run, at the same stack, through a browser.
   *
   * Purely a statement for the report. It changes no behaviour, and it exists
   * because a human in the population is invisible to the ledger and shows up
   * only as its consequences: conversations with one side missing, partners who
   * were never matched from this harness's point of view, messages counted by
   * the server that no bot sent. Without a line saying so, the next person to
   * read the report has to guess whether those numbers mean a bug.
   */
  human: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const next = argv[i + 1];
    flags.set(arg.slice(2), next !== undefined && !next.startsWith('--') ? next : 'true');
  }

  const num = (name: string, fallback: number): number => {
    const raw = flags.get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} is not a number`);
    return value;
  };

  const profileRaw = flags.get('profile') ?? 'realistic';
  if (!isProfileName(profileRaw)) {
    throw new Error(`unknown profile ${profileRaw}; one of ${Object.keys(PROFILES).join(', ')}`);
  }

  const list = (name: string, fallback: string): string[] =>
    (flags.get(name) ?? fallback)
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

  const bots = Math.max(1, Math.floor(num('bots', 500)));

  return {
    url: flags.get('url') ?? 'ws://localhost:8090/ws',
    origin: flags.get('origin') ?? 'http://localhost:8090',
    bots,
    durationSeconds: Math.max(10, Math.floor(num('duration', 120))),
    profile: profileRaw,
    // A run without an explicit seed still records the one it used, so any
    // result can be reproduced from the report alone.
    seed: Math.floor(num('seed', Date.now() % 2_147_483_647)),
    workers: Math.max(1, Math.floor(num('workers', Math.min(cpus().length, Math.ceil(bots / 1_000))))),
    rampSeconds: Math.max(1, Math.floor(num('ramp', Math.min(60, Math.ceil(bots / 100))))),
    outDir: flags.get('out') ?? resolve(__dirname, '..', 'runs'),
    // Two janitor passes, not one. Both cluster gauges are refreshed only by
    // the lock holder on its 15s interval (JANITOR_INTERVAL_MS), so a 20s wait
    // could contain a single pass and make "still shrinking" indistinguishable
    // from "not yet measured". Still shorter than the match TTL on purpose:
    // matches are expected to be mid-expiry here, and the oracle says so rather
    // than pretending they should all be gone.
    settleSeconds: Math.max(5, Math.floor(num('settle', 40))),
    metricsUrls: list('metrics', ''),
    logContainers: list('containers', ''),
    redisContainer: flags.get('redis') ?? '',
    keyPrefix: flags.get('key-prefix') ?? 'chat',
    segment: flags.get('segment') ?? 'default',
    human: flags.get('human') === 'true',
  };
}

/**
 * Build the roster.
 *
 * Bot index determines the synthetic address, and the shuffle inside
 * `expandMix` determines which persona each index gets. Both come from the run
 * seed, so the same seed produces the same person at the same address every
 * time — which is what makes "this blocked party came back" reproducible.
 */
function buildRoster(options: Options, corpus: Corpus): BotSpec[] {
  const rng = createRng(options.seed).fork('roster');
  const scenarios = expandMix(PROFILES[options.profile], options.bots, rng);
  const width = String(options.bots).length;

  return scenarios.map((scenario, index) => ({
    index,
    id: `b${String(index).padStart(width, '0')}`,
    scenario,
    address: syntheticAddress(index),
    // The answer key, written before the run rather than inferred from it.
    // Anything a persona does not claim is `benign`, stated rather than
    // assumed — "everything unlabelled is innocent" is the assumption that
    // turns a false positive into a silent one.
    labels: personaFor(scenario).labels ?? ['benign'],
    // Drawn from a *forked* stream rather than the bot's own, so adding or
    // removing a profile field cannot shift every think-time and corpus draw
    // that bot makes for the rest of the run — which would make two runs with
    // the same seed incomparable for a reason that has nothing to do with what
    // changed.
    profile: declaredProfile(botRng(options.seed, index).fork('declared'), corpus),
  }));
}

/**
 * Split the roster across workers.
 *
 * Contiguous blocks rather than round-robin: personas that must meet each other
 * are allocated adjacent indices by the roster builder, and a contiguous split
 * keeps them in one process where a future scenario can coordinate them
 * directly.
 */
function shard<T>(items: readonly T[], parts: number): T[][] {
  const shards: T[][] = Array.from({ length: parts }, () => []);
  const per = Math.ceil(items.length / parts);
  items.forEach((item, index) => {
    const target = shards[Math.min(parts - 1, Math.floor(index / per))];
    target?.push(item);
  });
  return shards;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const corpusDir = resolve(__dirname, '..', 'corpus');

  // The lint runs here, before a single socket is opened. A benign corpus line
  // that trips a moderation rule would silently corrupt every flag count in
  // the report, and finding that out after a five-minute run is expensive.
  const { corpus, findings } = loadCorpus(corpusDir);
  if (findings.length > 0) {
    console.error('corpus lint failed:');
    for (const finding of findings) {
      console.error(
        finding.expectation === 'benign'
          ? `  ${finding.file}:${finding.line} fires ${finding.flags.join(',')} but must fire nothing`
          : `  ${finding.file}:${finding.line} fires nothing but must fire a rule`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.profile}-${options.seed}`;
  const runDir = join(options.outDir, runId);
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });

  // Counters before anything connects. The stack survives between runs, so
  // reading them only at the end would attribute the previous run's work to
  // this one — which is exactly the false failure this line prevents.
  const metricsBaseline = await scrapeAll(options.metricsUrls);
  if (options.metricsUrls.length > 0) {
    console.log(`swarm: metrics baseline from ${metricsBaseline.length} samples`);
  }

  const roster = buildRoster(options, corpus);
  const shards = shard(roster, options.workers);
  const startedAt = Date.now();

  console.log(
    `swarm: ${options.bots} bots, profile ${options.profile}, seed ${options.seed}, ` +
      `${options.workers} worker(s), ${options.rampSeconds}s ramp, ${options.durationSeconds}s run`,
  );
  console.log(`swarm: target ${options.url}`);
  if (options.human) {
    console.log('swarm: a person is in this run; one-sided conversations include theirs');
  }
  console.log(`swarm: run directory ${runDir}`);

  const workerPath = join(__dirname, 'worker.ts');
  const children: ChildProcess[] = [];
  const ledgerPaths: string[] = [];
  const lag: { p99: number; max: number }[] = [];

  const done = shards.map(
    (specs, index) =>
      new Promise<void>((resolveDone, rejectDone) => {
        const child = fork(workerPath, [], {
          // tsx is what runs this file, and the child needs the same loader.
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        });
        children.push(child);

        const ledgerPath = join(runDir, `ledger-${index}.ndjson`);
        ledgerPaths.push(ledgerPath);

        child.on('message', (message: WorkerMessage) => {
          if (message.type === 'ready') {
            const command: WorkerCommand = {
              type: 'start',
              url: options.url,
              origin: options.origin,
              seed: options.seed,
              corpusDir,
              ledgerPath,
              specs,
              rampMs: options.rampSeconds * 1_000,
            };
            child.send(command);
          } else if (message.type === 'progress') {
            const elapsed = Math.round((Date.now() - startedAt) / 1000);
            console.log(
              `  [${elapsed}s] worker ${index}: ${message.connected} connected, ` +
                `${message.matched} in a conversation, lag p99 ${message.lagP99.toFixed(1)}ms`,
            );
          } else if (message.type === 'done') {
            lag.push({ p99: message.lagP99, max: message.lagMax });
          }
        });

        // A worker that dies takes its sockets with it, and the orchestrator
        // must not die alongside it: the ledger it already wrote is evidence,
        // and the run's other workers are still producing more.
        child.on('error', (error) => {
          console.error(`  worker ${index} error: ${error.message}`);
        });

        child.on('exit', (code, signal) => {
          if (code === 0) {
            resolveDone();
            return;
          }
          rejectDone(
            new Error(
              `worker ${index} exited with ${code === null ? `signal ${signal}` : `code ${code}`}`,
            ),
          );
        });
      }),
  );

  const stopAfter = (options.rampSeconds + options.durationSeconds) * 1_000;
  setTimeout(() => {
    console.log('swarm: draining');
    const stop: WorkerCommand = { type: 'stop' };
    for (const [index, child] of children.entries()) {
      // `connected` is not decoration: a worker that already exited has a
      // closed channel, and sending into it throws ERR_IPC_CHANNEL_CLOSED from
      // a timer callback — which kills the orchestrator during the drain and
      // destroys the report for every worker that was still healthy.
      if (child.connected) {
        child.send(stop);
      } else {
        console.error(`  worker ${index} was already gone at drain; its ledger may be short`);
      }
    }
  }, stopAfter).unref();

  // A worker that dies still fails the run — half a population produces oracle
  // results that describe the harness rather than the server — but every other
  // worker is allowed to finish and flush first, so the report explains what
  // happened instead of vanishing with the exception.
  const outcomes = await Promise.allSettled(done);
  const lost = outcomes.filter((outcome) => outcome.status === 'rejected');
  for (const failure of lost) {
    if (failure.status === 'rejected') {
      console.error(
        `swarm: ${failure.reason instanceof Error ? failure.reason.message : 'a worker failed'}`,
      );
    }
  }

  const worstLagP99 = lag.reduce((worst, entry) => Math.max(worst, entry.p99), 0);
  const worstLagMax = lag.reduce((worst, entry) => Math.max(worst, entry.max), 0);

  const result = await runOracles({
    ledgerPaths,
    roster,
    metricsUrls: options.metricsUrls,
    logContainers: options.logContainers,
    corpusDir,
    runWindow: { from: startedAt, to: Date.now() },
    settleSeconds: options.settleSeconds,
    metricsBaseline,
    redisContainer: options.redisContainer,
    keyPrefix: options.keyPrefix,
    segment: options.segment,
  });

  printReport({
    runId,
    runDir,
    options: {
      bots: options.bots,
      profile: options.profile,
      seed: options.seed,
      durationSeconds: options.durationSeconds,
      url: options.url,
    },
    lag: { p99: worstLagP99, max: worstLagMax },
    result,
    lostWorkers: lost.length,
    human: options.human,
  });

  const oraclesPassed = result.oracles.every((oracle) => oracle.status !== 'fail');
  if (lost.length > 0) {
    console.error(
      `swarm: ${lost.length} worker(s) did not finish cleanly — the population was incomplete, so treat every number above as a lower bound`,
    );
  }
  process.exitCode = oraclesPassed && lost.length === 0 ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(`swarm failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
});
