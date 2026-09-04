#!/usr/bin/env node
/*
  Shell-parses every `run:` block in every GitHub Actions workflow.

  ---------------------------------------------------------------------------
  WHY
  ---------------------------------------------------------------------------
  On 2026-09-04 a *comment* broke CI. An audit step embedded a JavaScript
  program inside single quotes; a comment in that program said "CI's network";
  the apostrophe closed the shell string, and every template literal after it
  became command substitution. The job died with

      syntax error near unexpected token `` `::error::${pkg}: npm audit ...` ``

  which names a line that is not the problem, in a language that is not the one
  at fault. It is the trap this repository already records twice — a backtick
  in Lua ending the TypeScript template literal holding it, a backtick in a
  Python docstring being run by the shell — and it cost a push each time,
  because a workflow is only ever parsed by pushing it.

  This asks the same question locally, in a tenth of a second. `bash -n` reads
  a script and reports syntax errors without executing anything, which is
  exactly the check the runner performs before running the step.

  It cannot catch a step that is syntactically valid and behaviourally wrong.
  Nothing here can. It catches the class that has actually happened twice.
*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = '.github/workflows';
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  : [];

if (files.length === 0) {
  console.error('verify-workflows: no workflow files found — has .github/workflows moved?');
  process.exit(1);
}

/*
  A line-based extractor rather than a YAML dependency. The root package has no
  dependencies on purpose, and the shapes below are the only ones this
  repository uses. Anything else is refused rather than skipped: a `run:` this
  cannot read is a `run:` this is not checking, and silently not checking is
  the failure mode the whole file exists to prevent.
*/
function extractRunBlocks(text, file) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^(\s*)(?:- )?run:(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length + (line.includes('- run:') ? 2 : 0);
    const rest = m[2].trim();

    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      const body = [];
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const l = lines[j];
        if (l.trim() === '') { body.push(''); continue; }
        const lead = l.length - l.trimStart().length;
        if (lead <= indent) break;
        body.push(l);
      }
      const min = Math.min(
        ...body.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length),
      );
      blocks.push({ file, line: i + 1, script: body.map((l) => l.slice(min)).join('\n') });
      i = j - 1;
    } else if (rest.length > 0) {
      blocks.push({ file, line: i + 1, script: rest });
    } else {
      console.error(`verify-workflows: ${file}:${i + 1} — a run: form this script cannot read`);
      process.exit(1);
    }
  }
  return blocks;
}

let blocks = [];
for (const f of files) {
  blocks = blocks.concat(extractRunBlocks(fs.readFileSync(path.join(dir, f), 'utf8'), f));
}

/*
  A guard on the guard. An extractor that quietly matches nothing would pass
  every workflow ever written, which is the shape of F-045 and of the config
  check that had to be given the same assertion.
*/
if (blocks.length < 5) {
  console.error(`verify-workflows: only ${blocks.length} run blocks found across ${files.length} workflow(s) — the extractor is probably broken`);
  process.exit(1);
}

const tmp = path.join(process.env.RUNNER_TEMP || process.env.TMPDIR || '.', '.verify-workflows.sh');
let failed = 0;

for (const b of blocks) {
  fs.writeFileSync(tmp, b.script, 'utf8');
  try {
    execFileSync('bash', ['-n', tmp], { stdio: 'pipe' });
  } catch (err) {
    // split/join rather than a regex: the temp path is a literal, and building
    // a regex out of a Windows path means escaping separators for no gain.
    const detail = String(err.stderr || err.message).split(tmp).join(`${b.file}:${b.line}`);
    console.error(`verify-workflows: shell syntax error in ${b.file} (run: at line ${b.line})`);
    console.error(detail.trim());
    failed += 1;
  }
}
fs.rmSync(tmp, { force: true });

if (failed > 0) {
  console.error(`\n${failed} of ${blocks.length} run block(s) would fail to parse on the runner.`);
  process.exit(1);
}
console.log(`verify-workflows: ${blocks.length} run block(s) in ${files.length} workflow(s) parse cleanly`);
