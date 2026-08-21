/**
 * One worker process: a few thousand sockets and the bots behind them.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE PROCESS AT ALL
 * ---------------------------------------------------------------------------
 * A single Node process will hold five thousand WebSockets quite happily, and
 * will also spend so long in its own event loop that every latency it reports
 * is partly its own scheduling delay. The first "regression" a single-process
 * harness finds is always itself.
 *
 * So the population is split across processes, and each one watches its own
 * event-loop lag. A worker whose lag exceeds the threshold says so, and the
 * report refuses to publish latency percentiles from that run — a run that
 * measured the load generator is not a failed run, but it is not a capacity
 * number either.
 *
 * Bots that must meet each other are pinned to one worker by the orchestrator,
 * not by anything here: this process takes a list of bot specs and runs them.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Bot, type BotSpec } from './bot';
import { loadCorpus } from './corpus';
import { Ledger } from './ledger';
import { personaFor } from './personas';
import { botRng } from './rng';

export interface WorkerStart {
  readonly type: 'start';
  readonly url: string;
  readonly origin: string;
  readonly seed: number;
  readonly corpusDir: string;
  readonly ledgerPath: string;
  readonly specs: readonly BotSpec[];
  /** Milliseconds over which this worker's bots connect, spreading the herd. */
  readonly rampMs: number;
}

export interface WorkerStop {
  readonly type: 'stop';
}

export type WorkerCommand = WorkerStart | WorkerStop;

export interface WorkerReady {
  readonly type: 'ready';
}

export interface WorkerProgress {
  readonly type: 'progress';
  readonly connected: number;
  readonly matched: number;
  readonly finished: number;
  /** Event-loop lag, 99th percentile, in milliseconds. */
  readonly lagP99: number;
}

export interface WorkerDone {
  readonly type: 'done';
  readonly ledgerPath: string;
  readonly lagP99: number;
  readonly lagMax: number;
}

export type WorkerMessage = WorkerReady | WorkerProgress | WorkerDone;

function send(message: WorkerMessage): void {
  process.send?.(message);
}

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();

let ledger: Ledger | null = null;
const bots: Bot[] = [];
let finished = 0;
let progressTimer: NodeJS.Timeout | null = null;

async function start(command: WorkerStart): Promise<void> {
  const { corpus, findings } = loadCorpus(command.corpusDir);
  if (findings.length > 0) {
    // The orchestrator lints too, and refuses to start. Reaching here means the
    // corpus changed underneath a running fleet, which is worth failing on.
    throw new Error(`corpus lint failed with ${findings.length} finding(s)`);
  }

  ledger = new Ledger(command.ledgerPath);
  const activeLedger = ledger;

  for (const spec of command.specs) {
    const bot = new Bot(spec, {
      url: command.url,
      origin: command.origin,
      rng: botRng(command.seed, spec.index),
      corpus,
      ledger: activeLedger,
      persona: personaFor(spec.scenario),
      onFinished: () => {
        finished += 1;
      },
    });
    bots.push(bot);
  }

  // Connections are spread across the ramp window rather than opened at once.
  // Opening five thousand sockets in one tick measures the connection limiter
  // and the kernel's accept queue, which is scenario L7's job and nobody
  // else's.
  const step = command.specs.length > 0 ? command.rampMs / command.specs.length : 0;
  bots.forEach((bot, index) => {
    setTimeout(() => bot.connect(), Math.round(step * index));
  });

  progressTimer = setInterval(() => {
    send({
      type: 'progress',
      // Live sockets, not "has ever had a session". `sessionId` outlives the
      // socket it was issued for, so counting it reported 400 connected through
      // a backend restart that had killed 244 of them — the number that would
      // have made the loss obvious was the one being printed wrong.
      connected: bots.filter((bot) => bot.isConnected()).length,
      matched: bots.filter((bot) => bot.state === 'MATCHED').length,
      finished,
      lagP99: lag.percentile(99) / 1e6,
    });
  }, 5_000);
  progressTimer.unref();
}

async function stop(): Promise<void> {
  if (progressTimer) clearInterval(progressTimer);
  for (const bot of bots) bot.stop();

  // Give close frames a moment to land, so the run's own teardown does not
  // look like a fleet of rage quits and pollute the lifecycle oracles.
  await new Promise((resolve) => setTimeout(resolve, 1_500));

  await ledger?.close();
  send({
    type: 'done',
    ledgerPath: ledger?.file ?? '',
    lagP99: lag.percentile(99) / 1e6,
    lagMax: lag.max / 1e6,
  });
}

process.on('message', (message: WorkerCommand) => {
  if (message.type === 'start') {
    void start(message).catch((error: unknown) => {
      console.error(`worker start failed: ${error instanceof Error ? error.message : 'unknown'}`);
      process.exit(1);
    });
  } else if (message.type === 'stop') {
    void stop().then(() => process.exit(0));
  }
});

send({ type: 'ready' });
