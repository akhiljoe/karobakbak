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
  /**
   * The backend C2 kills. One of them, never all: the claim is that the
   * *survivors* carry on, which needs a survivor.
   */
  readonly backendContainer: string;
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

/** Whether a container is running, so a killed backend can be brought back. */
async function isRunning(container: string): Promise<boolean> {
  try {
    const { stdout } = await run('docker', [
      'inspect', '--format', '{{.State.Running}}', container,
    ]);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Undo anything this module may have done. Safe to call at any time, and called
 * more than once on purpose.
 *
 * Both halves matter for the same reason: a paused database or a killed backend
 * outlives the process that did it, so a crashed run would leave the stack
 * wedged and fail the *next* run for a reason that has nothing to do with it.
 */
export async function undoChaos(options: ChaosOptions): Promise<void> {
  if (options.postgresContainer !== '' && (await isPaused(options.postgresContainer))) {
    await docker(['unpause', options.postgresContainer]).catch(() => undefined);
  }
  if (options.backendContainer !== '' && !(await isRunning(options.backendContainer))) {
    await docker(['start', options.backendContainer]).catch(() => undefined);
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
  if (options.scenario !== 'c1' && options.scenario !== 'c2') {
    return { ...EMPTY, scenario: options.scenario, skipped: `unknown chaos scenario ${options.scenario}` };
  }
  if (options.metricsUrls.length === 0) {
    return {
      ...EMPTY,
      scenario: options.scenario,
      skipped: `${options.scenario} needs --metrics: its claims are about rates during the fault`,
    };
  }

  const phases: Phase[] = [];
  const sample = async (name: string): Promise<void> => {
    phases.push({ name, atMs: Date.now(), samples: await scrapeAll(options.metricsUrls) });
  };

  if (options.scenario === 'c2') return runKillBackend(options, phases, sample);

  if (options.postgresContainer === '') {
    return { ...EMPTY, scenario: 'c1', skipped: 'C1 needs --postgres' };
  }

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

/**
 * C2 -- kill one of two backends.
 *
 * ---------------------------------------------------------------------------
 * A DIFFERENT CLAIM FROM C1
 * ---------------------------------------------------------------------------
 * C1 takes away a dependency and asks whether chat notices. C2 takes away *part
 * of the chat service itself* and asks whether the rest carries on -- which is
 * by far the more likely event. A backend dies on every deploy, every host
 * replacement, every OOM.
 *
 * Three things are tested at once, and each is currently only argued for:
 *
 *  * **Routing does not go stale.** Cross-instance delivery is Pub/Sub on a
 *    per-session channel, so the channel name *is* the routing key and there is
 *    no table left pointing at a dead instance. Half the sessions changing host
 *    at once is the condition that would expose it if that were untrue.
 *  * **Sessions resume rather than end** (section 28, D42). Every socket on the
 *    victim drops together, which is the resume window at its worst: not one
 *    client on a bad network, but hundreds arriving at the survivor at once.
 *  * **The population comes back.** This is the half the harness itself used to
 *    get wrong. A refused upgrade was terminal, a restart answers 502 for as
 *    long as nginx has no upstream, and 244 of 400 bots once died permanently
 *    while the run went on reporting 400 -- a shrunken population that passed
 *    every other oracle. Trap 19.
 *
 * ---------------------------------------------------------------------------
 * KILL, NOT STOP
 * ---------------------------------------------------------------------------
 * `docker kill` sends SIGKILL: no graceful drain, no `server_shutdown` frame,
 * no chance to hand seats back. That is the point -- a clean shutdown is C3 and
 * a different claim. This is the ugly case, where the process is simply gone
 * and every recovery has to come from TTLs, the janitor and the clients.
 *
 * The container is started again rather than left dead, because the second half
 * of the claim is recovery: the bots return and the instance takes traffic.
 */
async function runKillBackend(
  options: ChaosOptions,
  phases: Phase[],
  sample: (name: string) => Promise<void>,
): Promise<ChaosResult> {
  if (options.backendContainer === '') {
    return {
      ...EMPTY,
      scenario: 'c2',
      skipped: 'C2 needs --containers to know which backend to kill',
    };
  }
  if (options.metricsUrls.length < 2) {
    // With one endpoint there is no survivor to measure, and "delivery stopped"
    // would be indistinguishable from "the instance being scraped died".
    return {
      ...EMPTY,
      scenario: 'c2',
      skipped: 'C2 needs at least two --metrics endpoints: the claim is about the survivors',
    };
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, options.atSeconds * 1000));
    await sample('before');

    console.log(`swarm: chaos C2 -- killing ${options.backendContainer} for ${options.forSeconds}s`);
    await docker(['kill', options.backendContainer]);

    await new Promise((resolve) => setTimeout(resolve, options.forSeconds * 1000));
    await sample('during');

    await docker(['start', options.backendContainer]);
    console.log('swarm: chaos C2 -- restarted');

    // Long enough for the bots that lost sockets to finish backing off and come
    // back, which is the half of the claim nothing else here can see.
    await new Promise((resolve) => setTimeout(resolve, Math.max(45, options.forSeconds) * 1000));
    await sample('after');

    return { scenario: 'c2', phases, skipped: null };
  } finally {
    await undoChaos(options);
  }
}
