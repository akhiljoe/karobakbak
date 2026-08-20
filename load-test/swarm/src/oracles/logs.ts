/**
 * Oracle 5 — the leak check.
 *
 * ---------------------------------------------------------------------------
 * THE ONLY END-TO-END TEST OF INVARIANT I8 THAT EXISTS
 * ---------------------------------------------------------------------------
 * This repository's first rule is that message content never leaves the trusted
 * boundary: not a log line, not a metric label, not an error message
 * (CLAUDE.md #1, `DESIGN.md` I8). `src/logger.ts` enforces it with a recursive
 * field-name denylist that throws outside production.
 *
 * A denylist checks *field names*. It cannot catch a body interpolated into a
 * string, concatenated into an error message, or emitted by a library that
 * never heard of it. Nothing else in the test suite checks the actual output.
 *
 * The swarm can, because it knows exactly what was said: the corpus is a fixed
 * set of strings, every one of them was typed by a bot into a real
 * conversation, and none of them may appear in a backend log line. That turns
 * an unfalsifiable rule into a grep.
 *
 * Short lines are excluded — "ok" would match inside a base64url session id and
 * make the oracle a coin flip — and the probes are searched as fixed strings,
 * never as patterns.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadCorpus, leakProbes } from '../corpus';
import { firstLine, LF } from './firstline';
import type { OracleResult } from './types';

const run = promisify(execFile);

export interface LogOracleInput {
  /** Docker container names to read. Empty means the oracle cannot run. */
  readonly containers: readonly string[];
  readonly corpusDir: string;
  /** Only lines produced during the run are read. */
  readonly since: number;
}

export async function checkLogsForLeaks(input: LogOracleInput): Promise<OracleResult> {
  if (input.containers.length === 0) {
    return {
      name: 'log leak (invariant I8)',
      status: 'skipped',
      summary: 'no containers given; pass --containers to enable the strongest safety check',
      details: [
        'example: --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2',
      ],
    };
  }

  const { corpus } = loadCorpus(input.corpusDir);
  const probes = leakProbes(corpus);
  if (probes.length === 0) {
    return {
      name: 'log leak (invariant I8)',
      status: 'skipped',
      summary: 'no corpus line long enough to be a safe probe',
      details: [],
    };
  }

  const sinceIso = new Date(input.since - 5_000).toISOString();
  const hits: string[] = [];
  const details: string[] = [];
  let scannedBytes = 0;
  let lineCount = 0;

  for (const container of input.containers) {
    let output: string;
    try {
      const result = await run('docker', ['logs', '--since', sinceIso, container], {
        maxBuffer: 512 * 1024 * 1024,
      });
      // Backend logs go to stdout; stderr carries container-level noise. Both
      // are searched, because a leak in either is a leak.
      output = `${result.stdout}\n${result.stderr}`;
    } catch (error) {
      details.push(`could not read logs for ${container}: ${firstLine(error)}`);
      continue;
    }

    const lines = output.split(LF).filter((entry) => entry.trim().length > 0);
    scannedBytes += output.length;
    lineCount += lines.length;
    details.push(`${container}: ${lines.length} log line(s), ${output.length} bytes scanned`);
    for (const probe of probes) {
      if (output.includes(probe)) {
        // The probe itself is NOT printed. It is a message body, and printing
        // it into a test report would be the same class of mistake the oracle
        // exists to catch. Its identity is enough to find it.
        hits.push(`${container}: a corpus line of ${probe.length} characters appears in the logs`);
      }
    }
  }

  const couldNotRead = details.some((line) => line.startsWith('could not read logs'));

  // ---------------------------------------------------------------------
  // COVERAGE IS PART OF THE RESULT
  // ---------------------------------------------------------------------
  // A first version of this failed the run whenever the logs were small,
  // reasoning that an oracle which searched nothing has not passed. Running it
  // showed the reasoning was aimed at the wrong thing: this backend emits
  // roughly five lines for a two-hundred-bot run even at LOG_LEVEL=debug,
  // because it deliberately logs nothing per message. Small logs are the
  // system behaving well, not the check being broken.
  //
  // So the only genuine abstention is having read no log at all. Everything
  // else passes — and states its own coverage, because "no message content in
  // five lines" and "no message content in nine megabytes" are both true and
  // are not the same evidence. The number is printed so nobody has to guess
  // which one they got.
  const scannedLines = lineCount;
  // Zero *lines*, not zero bytes: `docker logs` returns a stray newline for an
  // empty window, and a one-byte read is nothing read.
  const nothingRead = scannedLines === 0;
  const status = hits.length > 0 ? 'fail' : couldNotRead || nothingRead ? 'skipped' : 'pass';

  if (!nothingRead && scannedLines < 50) {
    details.push(
      `coverage note: only ${scannedLines} log line(s) existed to search — this backend logs nothing per message,`,
    );
    details.push(
      'so a pass here means "no leak on the paths that did log", not "no leak anywhere"',
    );
  }

  return {
    name: 'log leak (invariant I8)',
    status,
    summary:
      hits.length > 0
        ? `${hits.length} message body/bodies found in backend logs`
        : couldNotRead
          ? 'logs could not be read for at least one container'
          : nothingRead
            ? 'no log output was read at all'
            : `${probes.length} probes over ${scannedLines} log line(s), no message content found`,
    details: [...details, ...hits.slice(0, 20)],
  };
}
