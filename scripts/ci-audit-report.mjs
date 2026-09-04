#!/usr/bin/env node
/*
  Reads one `npm audit --json` report, prints it, and decides whether it gates.

  ---------------------------------------------------------------------------
  WHY THIS IS A FILE AND NOT A `node -e` IN THE WORKFLOW
  ---------------------------------------------------------------------------
  It was a `node -e '...'` inside a shell step, and on 2026-09-04 a *comment*
  broke the build. The script was wrapped in single quotes; a comment inside it
  said "CI's network"; the apostrophe closed the shell string, and every
  JavaScript template literal after it became shell command substitution:

      syntax error near unexpected token `` `::error::${pkg}: npm audit ...` ``

  That is the same trap this repository already records twice — a backtick in
  Lua ending the TypeScript template literal that holds it, and a backtick in a
  Python docstring being run by the shell. The rule is the one already written
  down: nothing that is syntax in the *host* language may appear in a string
  the host is parsing. A prose comment is exactly where nobody looks for that.

  A file has no host. It is also runnable locally, which is how the two paths
  below were tested before shipping rather than after.

  Usage: node scripts/ci-audit-report.mjs <label> <path-to-audit-json>
         node scripts/ci-audit-report.mjs --usable <path-to-audit-json>
  Exit:  0 clean, 1 gated or could-not-run.

  `--usable` answers only "is this a report at all", and exists because the
  retry loop cannot decide on npm's exit code: a non-zero exit means either
  "advisories exist" or "the call failed", and only the file tells them apart.
  Retrying a tree that genuinely has advisories would burn three attempts and
  then fail for the wrong reason. It is the same question as the check below,
  asked without the verdict, so the two cannot drift apart.
*/
import fs from 'node:fs';

const [label, reportPath] = process.argv.slice(2);

if (label === '--usable') {
  try {
    const probe = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    process.exit(probe.metadata?.vulnerabilities === undefined ? 1 : 0);
  } catch {
    process.exit(1);
  }
}

if (!label || !reportPath) {
  console.log('usage: ci-audit-report.mjs <label> <path-to-audit-json>');
  process.exit(2);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch {
  /*
    Unparseable output is a failed audit, not an empty one. npm writes nothing
    at all when it cannot reach the registry on some paths, and an empty file
    parsed leniently would be the quietest possible way to check nothing.
  */
  console.log(`::error::${label}: npm audit produced no readable report, so nothing was checked`);
  process.exit(1);
}

const totals = report.metadata?.vulnerabilities;

if (totals === undefined) {
  /*
    An audit that could not run must not read as an audit that found nothing.
    When the registry call fails npm writes an *error* object here — statusCode,
    error, and no metadata — and an earlier version of this defaulted that to
    an empty object and passed. That is the failure this repository keeps
    finding elsewhere: a check that reports success because it never ran.

    This fails the build rather than warning. The objection to failing is that
    npmjs.com availability should not block a merge; that objection is answered
    by Dependabot security updates, which run server-side, on a schedule, and
    do not care whether this runner could reach the registry. So a red build
    here means go and look, not you are blind until this clears.
  */
  console.log(`::error::${label}: npm audit could not run after three attempts, so nothing was checked`);
  console.log(JSON.stringify(report.error ?? report).slice(0, 400));
  process.exit(1);
}

console.log(`${label}:`, JSON.stringify(totals));
for (const [name, via] of Object.entries(report.vulnerabilities ?? {})) {
  console.log(`  ${String(via.severity).padEnd(8)} ${name}`);
}

const gated = (totals.high ?? 0) + (totals.critical ?? 0);
if (gated > 0) {
  console.log(`::error::${label} has ${gated} high or critical advisory(ies)`);
  process.exit(1);
}
process.exit(0);
