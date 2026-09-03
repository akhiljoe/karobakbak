#!/usr/bin/env node
/**
 * Verify that a setting which can be set is a setting that arrives.
 *
 * WHY THIS EXISTS
 * `docker compose --env-file X` populates `${VAR}` substitutions in the YAML
 * and puts **nothing** into a container. A service receives a variable only
 * from an explicit `environment:` entry or an `env_file:` directive — and for
 * most of this project's life there was no `env_file:` anywhere, so 108
 * settings that `config.ts` reads, and that `.env.example` documented as
 * supported, reached no process at all (F-045). They were settable, they were
 * documented, and they were inert. Nothing failed: an undeclared variable is
 * not an error, and the process starts cleanly on its compiled-in default.
 *
 * That is the same shape as `SPOOL_BACKEND=redis` accepted and ignored
 * (F-006), and as `HEARTBEAT_INTERVAL_MS` set in `.env.vps` while the backend
 * ran at 20000. Every one of them was found by accident, late, while
 * investigating something else. So the property is asserted here rather than
 * left to discipline.
 *
 * WHAT IT CHECKS
 *   1. Every service running this repository's code carries an `env_file:`,
 *      which is what makes the whole file reach the process.
 *   2. Every name `config.ts` reads is documented in `.env.example`.
 *   3. Every `VITE_` name the frontend reads exists in all three places it has
 *      to: the compose `build.args`, a Dockerfile `ARG`, and a Dockerfile `ENV`.
 *
 * THE TRAP IT HAS TO AVOID
 * Ten rate-limit buckets are built by `rateLimit(env, 'MESSAGE', …)`, so
 * `MESSAGE_RATE_PER_SEC` never appears as a literal anywhere in `config.ts`. A
 * checker that greps for literal names reports all twenty as undocumented, and
 * gets deleted the first time somebody trusts it. The extractor below knows
 * about the composed names, and `EXPECTED_COMPOSED` asserts that it still
 * finds them — a guard on the guard, because a silently-empty extractor passes
 * every other assertion in this file.
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const problems = [];
const fail = (message) => problems.push(message);

/* -------------------------------------------------------------------------- */
/* What the backend reads                                                     */
/* -------------------------------------------------------------------------- */

const configSource = read('backend', 'src', 'config.ts');

/** Names read directly: `int(env, 'NAME', …)`, `str(env, 'NAME', …)`, and friends. */
const DIRECT = /\b(?:int|str|bool|num|list|path|segment|spoolBackend|moderationAction|knownRules|logLevel|dollars)\(\s*(?:env,\s*)?'([A-Z][A-Z0-9_]*)'/g;

/**
 * Names built from a prefix. `rateLimit(env, 'MESSAGE', …)` reads
 * `MESSAGE_RATE_PER_SEC` and `MESSAGE_BURST`, neither of which is a literal
 * anywhere in the file.
 */
const COMPOSED = /\brateLimit\(\s*env,\s*'([A-Z][A-Z0-9_]*)'/g;
const COMPOSED_SUFFIXES = ['_RATE_PER_SEC', '_BURST'];

/** Names read straight off the object: `env.INSTANCE_ID`, `env['X']`. */
const PROPERTY = /\benv(?:\.([A-Z][A-Z0-9_]*)|\[\s*'([A-Z][A-Z0-9_]*)'\s*\])/g;

function namesReadByConfig() {
  const names = new Set();
  for (const [, name] of configSource.matchAll(DIRECT)) names.add(name);
  for (const [, prefix] of configSource.matchAll(COMPOSED)) {
    for (const suffix of COMPOSED_SUFFIXES) names.add(`${prefix}${suffix}`);
  }
  for (const [, dotted, indexed] of configSource.matchAll(PROPERTY)) {
    names.add(dotted ?? indexed);
  }
  return names;
}

const backendNames = namesReadByConfig();

/**
 * The guard on the guard.
 *
 * These four are the shapes the extractor has to handle. If a refactor changes
 * how `config.ts` reads its environment, this fails loudly here rather than
 * silently reducing every other check below to nothing.
 */
const EXPECTED_COMPOSED = [
  'MESSAGE_RATE_PER_SEC', // built from a prefix, never a literal
  'MESSAGE_BURST', //        the other half of the same call
  'MAX_CONNECTIONS', //      an ordinary int()
  'INSTANCE_ID', //          read as a property of `env`
];
for (const name of EXPECTED_COMPOSED) {
  if (!backendNames.has(name)) {
    fail(
      `the extractor did not find ${name}, so it is no longer reading config.ts correctly — ` +
        'every other check in this script is meaningless until that is fixed',
    );
  }
}
if (backendNames.size < 100) {
  fail(`only ${backendNames.size} settings extracted from config.ts; that is too few to be right`);
}

/* -------------------------------------------------------------------------- */
/* 1. The services running this code must read an env file                    */
/* -------------------------------------------------------------------------- */

const compose = read('docker-compose.yml');

/**
 * Services built from this repository's source. A third-party image
 * (Grafana, Postgres, the exporters) reads its own names and is not in scope:
 * it never sees `config.ts` and has no default to silently fall back to.
 */
const OWN_SERVICES = ['backend', 'personas'];

for (const service of OWN_SERVICES) {
  const start = compose.indexOf(`\n  ${service}:\n`);
  if (start === -1) {
    fail(`docker-compose.yml has no ${service} service; this check needs updating`);
    continue;
  }
  const next = compose.slice(start + 1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const block = next === -1 ? compose.slice(start) : compose.slice(start, start + 1 + next);
  if (!/^\s{4}env_file:/m.test(block)) {
    fail(
      `docker-compose.yml service "${service}" has no env_file:, so it receives only the names ` +
        'enumerated under environment: and every other setting is inert (F-045)',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 2. Everything readable is documented                                       */
/* -------------------------------------------------------------------------- */

const example = read('.env.example');
const documented = new Set(
  [...example.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)=/gm)].map(([, name]) => name),
);

/**
 * Names that are deliberately not in `.env.example`.
 *
 * `INSTANCE_ID` is written by compose per replica and must not be pinned by an
 * env file: two instances sharing an id is a matchmaking bug that looks like a
 * routing bug.
 */
const UNDOCUMENTED_ON_PURPOSE = new Set(['INSTANCE_ID', 'NODE_ENV', 'APP_ENV_FILE']);

for (const name of [...backendNames].sort()) {
  if (UNDOCUMENTED_ON_PURPOSE.has(name)) continue;
  if (!documented.has(name)) {
    fail(`${name} is read by config.ts and is not documented in .env.example`);
  }
}

/* -------------------------------------------------------------------------- */
/* 3. The frontend's three places                                             */
/* -------------------------------------------------------------------------- */

/**
 * A `VITE_` value is inlined at build time, so it has to appear in the compose
 * `build.args`, as a Dockerfile `ARG`, and as the `ENV` that hands the ARG to
 * the build. Drop any one of the three and the bundle ships the default with
 * nothing to show for it — which is the frontend's version of F-045, and the
 * reason `VITE_CONTACT_EMAIL` and `VITE_SUPPORT_URL` once reached nothing
 * (docs/UI-BACKLOG.md).
 */
const frontendConfig = read('frontend', 'src', 'config.ts');
const dockerfile = read('frontend', 'Dockerfile');
const viteNames = new Set(
  [...frontendConfig.matchAll(/env\.(VITE_[A-Z][A-Z0-9_]*)/g)].map(([, name]) => name),
);

if (viteNames.size === 0) {
  fail('no VITE_ names found in frontend/src/config.ts; the extractor is broken');
}

for (const name of [...viteNames].sort()) {
  if (!new RegExp(`^\\s+${name}:`, 'm').test(compose)) {
    fail(`${name} is read by the frontend and is not passed in docker-compose.yml build.args`);
  }
  if (!new RegExp(`^ARG ${name}=`, 'm').test(dockerfile)) {
    fail(`${name} is read by the frontend and has no ARG in frontend/Dockerfile`);
  }
  if (!new RegExp(`^ENV ${name}=`, 'm').test(dockerfile)) {
    fail(
      `${name} has an ARG but no ENV in frontend/Dockerfile, so the build never sees it — ` +
        'an ARG alone is not visible to vite',
    );
  }
}

/* -------------------------------------------------------------------------- */

if (problems.length > 0) {
  console.error('config wiring check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${problems.length} problem(s). See docs/CONFIGURATION.md for what each surface needs.`,
  );
  process.exit(1);
}

console.log(
  `config wiring OK: ${backendNames.size} backend settings documented and delivered, ` +
    `${viteNames.size} VITE_ names wired through all three places`,
);
