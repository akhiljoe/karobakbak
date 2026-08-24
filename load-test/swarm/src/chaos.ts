/**
 * Breaking things on purpose, on a schedule.
 *
 * ---------------------------------------------------------------------------
 * WHY A SCHEDULE AND NOT A PERSONA
 * ---------------------------------------------------------------------------
 * Every other thing this harness does is a bot behaving badly. Chaos is not
 * that: it is the *environment* failing while the population carries on
 * normally, and the population must not know it happened. So it lives beside
 * the run rather than inside it — a list of `{ atSeconds, action }` executed
 * through the Docker CLI, which is the same pattern the oracles already use for
 * `redis-cli` and `psql`.
 *
 * ---------------------------------------------------------------------------
 * THE SAMPLES ARE THE POINT, NOT THE ACTION
 * ---------------------------------------------------------------------------
 * Pausing a container is trivial. Knowing whether it mattered is not, and it
 * cannot be reconstructed afterwards from a single scrape: "did delivery
 * continue *during* the outage" is a question about a window, and by the time
 * the run ends every counter has moved on.
 *
 * So this scrapes at each phase boundary — before, during, after — and hands
 * the samples to an oracle. A counter's growth between two boundaries is the
 * rate during that phase, which is the only form in which D16's claim can
 * actually be checked.
 *
 * ---------------------------------------------------------------------------
 * ALWAYS UNDOES ITSELF
 * ---------------------------------------------------------------------------
 * A paused container outlives the process that paused it. A crashed or killed
 * run that left PostgreSQL paused would leave the whole stack wedged, and the
 * next run would fail for a reason that has nothing to do with it — the same
 * class of trap as trap 23, where a killed orchestrator left its worker holding
 * sockets. The undo runs from a `finally`, and again on the way out.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { scrapeAll, type Sample } from './oracles/metrics';

const run = promisify(execFile);

/** One measurement of every counter, taken at a phase boundary. */
export interface Phase {
  /** `before`, `during`, `after`. */
  readonly name: string;
  readonly atMs: number;
  readonly samples: readonly Sample[];
}

export interface ChaosResult {
  /** The scenario that ran, or empty when none was asked for. */
  readonly scenario: string;
  readonly phases: readonly Phase[];
  /** Set when the scenario could not run. The oracle reports this, not a pass. */
  readonly skipped: string | null;
}

export interface ChaosOptions {
  /** Scenario id, lowercased. Empty means no chaos. */
  readonly scenario: string;
  readonly postgresContainer: string;
  readonly metricsUrls: readonly string[];
  /** Seconds into the run before the fault is introduced. */
  readonly atSeconds: number;
  /** How long the fault lasts. */
  readonly forSeconds: number;
}

const EMPTY: ChaosResult = { scenario: '', phases: [], skipped: null };

async function docker(args: readonly string[]): Promise<void> {
  await run('docker', [...args]);
}

/** Whether a container is currently paused, so the undo can be unconditional. */
async function isPaused(container: string): Promise<boolean> {
  try {
    const { stdout } = await run('docker', [
      'inspect', '--format', '{{.State.Paused}}', container,
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Resume anything this module may have paused. Safe to call at any time. */
export async function undoChaos(options: ChaosOptions): Promise<void> {
  if (options.postgresContainer === '') return;
  if (await isPaused(options.postgresContainer)) {
    await docker(['unpause', options.postgresContainer]).catch(() => undefined);
  }
}

/**
 * C1 — pause PostgreSQL mid-run.
 *
 * The cheapest chaos condition and the highest value, because it is the only
 * direct test of D16: *a database outage is never a chat outage*. Everything
 * about the write-behind path — the bounded queue, the circuit breaker, the
 * outage spool — exists to make that true, and until now it was a claim the
 * code argued for rather than one a run had demonstrated.
 *
 * `pause` rather than `stop`, deliberately. A stopped container refuses
 * connections immediately, which the driver reports as a fast error; a paused
 * one accepts them and never answers, which is the far nastier failure and the
 * one that actually tests timeouts.
 */
export async function runChaos(options: ChaosOptions): Promise<ChaosResult> {
  if (options.scenario === '') return EMPTY;
  if (options.scenario !== 'c1') {
    return { ...EMPTY, scenario: options.scenario, skipped: `unknown chaos scenario ${options.scenario}` };
  }
  if (options.postgresContainer === '') {
    return { ...EMPTY, scenario: 'c1', skipped: 'C1 needs --postgres' };
  }
  if (options.metricsUrls.length === 0) {
    return {
      ...EMPTY,
      scenario: 'c1',
      skipped: 'C1 needs --metrics: its whole claim is about rates during the outage',
    };
  }

  const phases: Phase[] = [];
  const sample = async (name: string): Promise<void> => {
    phases.push({ name, atMs: Date.now(), samples: await scrapeAll(options.metricsUrls) });
  };

  try {
    await new Promise((resolve) => setTimeout(resolve, options.atSeconds * 1000));
    await sample('before');

    console.log(`swarm: chaos C1 — pausing ${options.postgresContainer} for ${options.forSeconds}s`);
    await docker(['pause', options.postgresContainer]);

    // Sampled at the *end* of the outage rather than the start, so the growth
    // between `before` and `during` is exactly the traffic that flowed while
    // the database was unreachable.
    await new Promise((resolve) => setTimeout(resolve, options.forSeconds * 1000));
    await sample('during');

    await docker(['unpause', options.postgresContainer]);
    console.log('swarm: chaos C1 — resumed');

    // Long enough for the breaker's cooldown to let a probe through and the
    // spool to start replaying, which is the half of the claim about recovery.
    await new Promise((resolve) => setTimeout(resolve, Math.max(20, options.forSeconds) * 1000));
    await sample('after');

    return { scenario: 'c1', phases, skipped: null };
  } finally {
    // Whatever went wrong above, the container does not stay paused.
    await undoChaos(options);
  }
}
