/**
 * Run the probes against a live stack.
 *
 *   npm run probe                                    # the load stack
 *   npm run probe -- --origin http://localhost:8081  # the dev stack
 *   npm run probe -- --console http://localhost:8092
 *
 * Exit code is non-zero if any probe FAILS. `INFO` never fails a run: those
 * probes measure something whose correct value depends on the deployment, and
 * turning a measurement into a verdict is how a check gets run with `|| true`.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * It is not a scanner and does not try to be. It asks a short list of questions
 * this system's own design documents say matter — the ones a generic tool
 * cannot know to ask, because they are about `TRUST_PROXY_HOPS`, the origin
 * allowlist's exactness, and a console that can read every retained
 * conversation. Stock misconfiguration is a separate job.
 *
 * Every probe runs against a stack you control. Nothing here is pointed at
 * anything but a local deployment.
 */
import { forwardedForTrust, originExactness } from './probes/identity';
import {
  authCallbackDoesNotEcho,
  consoleRequiresAuth,
  cspShape,
  metricsNotPublic,
  securityHeaders,
} from './probes/edge';
import {
  binaryFramesRefused,
  clientCannotNameASubject,
  inventedResumeTokenRefused,
  strikesDisconnect,
} from './probes/protocol';
import type { Context, Probe, Verdict } from './probe';

const PROBES: readonly Probe[] = [
  securityHeaders,
  cspShape,
  metricsNotPublic,
  authCallbackDoesNotEcho,
  consoleRequiresAuth,
  originExactness,
  binaryFramesRefused,
  strikesDisconnect,
  clientCannotNameASubject,
  inventedResumeTokenRefused,
  // Last: it opens 120 sockets and leaves the per-IP registry to drain, so
  // running it before the others would make their connections look like part
  // of a burst.
  forwardedForTrust,
];

function flag(name: string, fallback: string | null): string | null {
  const i = process.argv.indexOf(name);
  return i === -1 || i === process.argv.length - 1 ? fallback : (process.argv[i + 1] as string);
}

async function main(): Promise<void> {
  const origin = flag('--origin', 'http://localhost:8090') as string;
  const context: Context = {
    origin,
    wsUrl: `${origin.replace(/^http/, 'ws')}/ws`,
    consoleOrigin: flag('--console', null),
  };

  console.log(`security probes against ${context.origin}\n`);

  const counts: Record<Verdict, number> = { PASS: 0, FAIL: 0, INFO: 0, SKIP: 0 };
  const failures: string[] = [];

  for (const probe of PROBES) {
    let result;
    try {
      result = await probe.run(context);
    } catch (err) {
      result = {
        verdict: 'FAIL' as const,
        detail: `probe threw: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    counts[result.verdict] += 1;
    console.log(`[${result.verdict.padEnd(4)}] ${probe.id}  ${probe.name}`);
    console.log(`        ${result.detail}`);
    for (const note of result.notes ?? []) console.log(`        · ${note}`);
    if (result.verdict === 'FAIL') {
      // Printed on failure only: a reader who has just been told something is
      // wrong needs to know why it matters, and a reader of a green run does not.
      console.log(`        why it matters: ${probe.proves}`);
      failures.push(`${probe.id} ${probe.name}`);
    }
    console.log('');
  }

  console.log('-'.repeat(72));
  console.log(
    `${counts.PASS} passed, ${counts.FAIL} failed, ${counts.INFO} measured, ${counts.SKIP} skipped`,
  );
  if (failures.length > 0) {
    console.log('\nFAILED:');
    for (const f of failures) console.log(`  ${f}`);
  }
  console.log('-'.repeat(72));

  process.exit(counts.FAIL > 0 ? 1 : 0);
}

void main();
