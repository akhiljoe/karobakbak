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

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, sep } from 'node:path';

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
 *
 * `migrate` was missing from this list for as long as it was missing an
 * `env_file:`, which is why the guard passed over the defect it exists to
 * catch. A short list that omits a service is indistinguishable from a
 * service that is compliant. Anything calling `loadConfig` belongs here.
 */
const OWN_SERVICES = ['backend', 'personas', 'migrate'];

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
/* 2b. Everything declared is read by something                               */
/* -------------------------------------------------------------------------- */

/*
  The mirror image of the check above, and it caught a real one.

  `PERSONA_REASONING_HEADROOM_TOKENS` was added to `Config`, documented in
  `.env.example`, delivered to the container by `env_file:` — and read by
  nothing, because the value was never threaded into the OpenAI adapter, which
  went on using its own module constant. Every check up to this point passed.
  That is F-045's exact shape occurring inside the work that fixed F-045: a
  setting that is settable, documented, delivered, and inert.

  So a field on `Config` has to be *used* somewhere outside `config.ts`. This is
  the same argument `metrics-wiring.test.ts` makes about a metric that is
  declared and never written: a declared-and-dead setting is worse than an
  absent one, because it is documented, it is believed, and it does nothing.

  Matched by field name rather than by env name, because the env name is the
  half that already has a checker — what goes missing is the wiring on the other
  side of `loadConfig`.
*/
const backendSources = readdirSync(join(root, 'backend', 'src'), {
  recursive: true,
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
  .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
  .filter((file) => !file.endsWith(`${sep}config.ts`));

const sourceText = backendSources.map((file) => readFileSync(file, 'utf8')).join('\n');

/**
 * Field names on `Config` that nothing outside `config.ts` needs to read.
 *
 * Each is here because the *name* is the product, not the value: `configWarnings`
 * reports them, `assertCoherent` checks them, or another field is derived from
 * them. Adding to this list is a claim that a setting does nothing on purpose.
 */
const DECLARED_UNREAD_ON_PURPOSE = new Set([
  'nodeEnv', // `isProduction` is what code reads
]);

const declaredFields = new Set(
  [...configSource.matchAll(/^\s+readonly ([a-zA-Z][a-zA-Z0-9]*)[?]?:/gm)].map(([, name]) => name),
);

for (const field of [...declaredFields].sort()) {
  if (DECLARED_UNREAD_ON_PURPOSE.has(field)) continue;
  // A property read (`.field`), a destructure (`{ field }`) or a key in an
  // object literal built from config — any of the three counts as wired.
  if (!new RegExp(`[.{,\\s]${field}\\b`).test(sourceText)) {
    fail(
      `Config declares "${field}" and nothing outside config.ts reads it — ` +
        'a setting that is documented, delivered and inert is the F-045 shape',
    );
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
 * (docs/product/UI-BACKLOG.md).
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
/* 4. Each deployment's env file names itself, and the laptop stays in step   */
/* -------------------------------------------------------------------------- */

/**
 * `APP_ENV_FILE` is how a container finds its own env file. A template copied
 * from another and not renamed delivers the *other* deployment's values: the
 * laptop reading `.env.prod`, which does not exist there, falls through to
 * compiled-in defaults with nothing failing.
 */
const ENV_TEMPLATES = {
  '.env.example': '.env',
  '.env.prod.example': '.env.prod',
  '.env.laptop.example': '.env.laptop',
  '.env.loadtest': '.env.loadtest',
  '.env.vps': '.env.vps',
};

const assigned = (text) => new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, n]) => n));

for (const [template, self] of Object.entries(ENV_TEMPLATES)) {
  const match = read(template).match(/^APP_ENV_FILE=(.*)$/m);
  if (!match) {
    fail(`${template} does not set APP_ENV_FILE, so its containers read .env instead`);
  } else if (match[1].trim() !== self) {
    fail(`${template} sets APP_ENV_FILE=${match[1].trim()}; it must name itself (${self})`);
  }
}

/**
 * The laptop template is a whole copy of the production one, because compose
 * takes a single `--env-file` and nothing is inherited. So a setting added to
 * production and not to the laptop is a setting the laptop silently runs on
 * its default — `AUTH_AVATARS` was exactly that between `.env.example` and
 * `.env.prod.example` on the first deployment.
 */
const LAPTOP_DIFFERS_ON_PURPOSE = new Set([
  'FRONTEND_BIND_PORT', // there is no TLS terminator on the host to bind for
]);
const prodAssigned = assigned(read('.env.prod.example'));
const laptopAssigned = assigned(read('.env.laptop.example'));
for (const name of [...prodAssigned].sort()) {
  if (LAPTOP_DIFFERS_ON_PURPOSE.has(name)) continue;
  if (!laptopAssigned.has(name)) {
    fail(`${name} is set in .env.prod.example and not in .env.laptop.example`);
  }
}

/**
 * Development and production must be different compose projects. Without a
 * name the project is the directory, `karobakbak`, for both — and on a host that
 * runs both (the laptop does) a development `up` or `down -v` then acts on the
 * live site. The base file names development, the prod overlay overrides it,
 * and the laptop overlay must not set a third value.
 */
const topLevelName = (file) => read(file).match(/^name:\s*(\S+)/m)?.[1];
const devName = topLevelName('docker-compose.yml');
const liveName = topLevelName('docker-compose.prod.yml');
const laptopName = topLevelName('docker-compose.laptop.yml');
if (devName !== 'karobakbak-dev') {
  fail(`docker-compose.yml must be named karobakbak-dev (found ${devName ?? 'no name'})`);
}
if (liveName !== 'karobakbak-live') {
  fail(`docker-compose.prod.yml must be named karobakbak-live (found ${liveName ?? 'no name'})`);
}
if (laptopName !== undefined && laptopName !== liveName) {
  fail(`docker-compose.laptop.yml names the project ${laptopName}; it must inherit ${liveName}`);
}

/* -------------------------------------------------------------------------- */

if (problems.length > 0) {
  console.error('config wiring check failed:\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    `\n${problems.length} problem(s). See docs/operations/CONFIGURATION.md for what each surface needs.`,
  );
  process.exit(1);
}

console.log(
  `config wiring OK: ${backendNames.size} backend settings documented and delivered, ` +
    `${viteNames.size} VITE_ names wired through all three places`,
);
