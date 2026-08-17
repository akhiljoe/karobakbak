#!/usr/bin/env node
/**
 * The WebSocket protocol contract lives in a single file that is duplicated,
 * byte for byte, into both packages:
 *
 *   backend/src/protocol/types.ts   (source of truth)
 *   frontend/src/protocol/types.ts  (copy)
 *
 * Duplication keeps each package independently installable and Dockerisable
 * (each Docker build context is its own directory) without introducing a
 * workspace/build-orchestration layer. This script is what makes the
 * duplication safe: it fails the build the moment the two files drift.
 *
 * Usage:
 *   node scripts/verify-protocol.mjs          # check, exit 1 on drift
 *   node scripts/verify-protocol.mjs --fix    # copy backend -> frontend
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = join(root, 'backend', 'src', 'protocol', 'types.ts');
const COPY = join(root, 'frontend', 'src', 'protocol', 'types.ts');

const rel = (p) => relative(root, p).split('\\').join('/');

function read(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`protocol check: cannot read ${rel(path)} — ${err.message}`);
    process.exit(1);
  }
}

const source = read(SOURCE);

if (process.argv.includes('--fix')) {
  writeFileSync(COPY, source);
  console.log(`protocol check: copied ${rel(SOURCE)} -> ${rel(COPY)}`);
  process.exit(0);
}

const copy = read(COPY);

if (source === copy) {
  console.log(`protocol check: OK — ${rel(SOURCE)} === ${rel(COPY)}`);
  process.exit(0);
}

const a = source.split('\n');
const b = copy.split('\n');
const diffs = [];
for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 10; i += 1) {
  if (a[i] !== b[i]) {
    diffs.push(`  line ${i + 1}:\n    backend : ${JSON.stringify(a[i] ?? '<eof>')}\n    frontend: ${JSON.stringify(b[i] ?? '<eof>')}`);
  }
}

console.error('protocol check: FAILED — backend and frontend protocol definitions have drifted.');
console.error(diffs.join('\n'));
console.error('\nRun `node scripts/verify-protocol.mjs --fix` to sync frontend from backend.');
process.exit(1);
