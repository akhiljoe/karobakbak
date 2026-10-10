#!/usr/bin/env node
/**
 * Deploy one commit to the live stack on the laptop.
 *
 *   node ops/laptop/deploy.mjs --live-dir <path> --ref main
 *   node ops/laptop/deploy.mjs --live-dir <path> --ref previous      # roll back
 *   node ops/laptop/deploy.mjs --live-dir <path> --ref live-2026-10-11-0930
 *
 * Run by `.github/workflows/deploy.yml` on the self-hosted runner, which is the
 * only intended caller. docs/operations/DEPLOY.md is the runbook.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE CHECKOUT
 * ---------------------------------------------------------------------------
 * Production runs from its own clone (`--live-dir`), never from the working
 * copy development happens in. A deploy moves that clone's HEAD; doing that to
 * the directory somebody is editing would switch their code underneath them,
 * and the bind mounts (Prometheus rules, Alertmanager, Grafana) would follow
 * whatever branch they happened to have checked out.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT REFUSES
 * ---------------------------------------------------------------------------
 *   * a live checkout with edited tracked files — a deploy would discard them
 *   * a commit CI has not passed (`verify.yml`, on that exact SHA)
 *   * a directory that is not the live stack (no docker-compose.laptop.yml or
 *     no .env.laptop)
 *
 * It does **not** roll back a migration. Going back to an earlier commit leaves
 * the schema where it is, which is safe only because every migration here is
 * additive (`add column if not exists`, new tables). It says so when the range
 * crosses one rather than pretending otherwise.
 *
 * ---------------------------------------------------------------------------
 * THE TOKEN
 * ---------------------------------------------------------------------------
 * `GITHUB_TOKEN` comes from the workflow and lives for the job. It reaches git
 * through `GIT_CONFIG_*` environment variables, not argv, so it is never in a
 * process listing, and nothing here prints it.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const COMPOSE_FILES = ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.laptop.yml'];
const PROJECT = 'karobakbak-live';
/** Profiles are started only if their container already exists: a deploy keeps the stack's shape. */
const OPTIONAL_SERVICES = { admin: 'admin', personas: 'personas' };
const HEALTH_TIMEOUT_MS = 240_000;

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) fail(`bad argument near ${key ?? '(end)'}`);
    out[key.slice(2)] = value;
  }
  return out;
}

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

function step(title) {
  console.log(`\n=== ${title}`);
}

function run(cmd, argv, options = {}) {
  return execFileSync(cmd, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options }).trim();
}

/** Streams output; returns the exit code. */
function stream(cmd, argv, options = {}) {
  const result = spawnSync(cmd, argv, { stdio: 'inherit', ...options });
  return result.status ?? 1;
}

/** git with the job token supplied as an extra header, out of argv. */
function gitEnv(token) {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

async function api(path, token, init = {}, allow = []) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers ?? {}),
    },
  });
  if (allow.includes(response.status)) return { status: response.status };
  if (!response.ok) fail(`GitHub API ${init.method ?? 'GET'} ${path.split('?')[0]} answered ${response.status}`);
  return response.json();
}

/** One key from .env.laptop, without reading any other value into a variable. */
function envValue(liveDir, key) {
  for (const raw of readFileSync(join(liveDir, '.env.laptop'), 'utf8').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith(`${key}=`)) return line.slice(key.length + 1).trim();
  }
  return null;
}

function containerExists(name) {
  return run('docker', ['ps', '-a', '--filter', `name=^${name}$`, '--format', '{{.Names}}']) === name;
}

function health(name) {
  try {
    return run('docker', ['inspect', name, '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}']);
  } catch {
    return 'missing';
  }
}

async function waitHealthy(names) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  for (;;) {
    const states = names.map((n) => [n, health(n)]);
    const bad = states.filter(([, s]) => s !== 'healthy' && s !== 'running');
    if (bad.length === 0) return states;
    // A container that stopped or never came up will not recover by waiting.
    const dead = bad.filter(([, s]) => s === 'exited' || s === 'dead' || s === 'missing');
    if (dead.length > 0) fail(`stopped: ${dead.map(([n, s]) => `${n}=${s}`).join(', ')}`);
    if (Date.now() > deadline) fail(`not healthy after ${HEALTH_TIMEOUT_MS / 1000}s: ${bad.map(([n, s]) => `${n}=${s}`).join(', ')}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

function stamp(now = new Date()) {
  // IST, because that is the operator's clock and the tag is read by a person.
  const ist = new Date(now.getTime() + 330 * 60_000);
  const p = (n) => String(n).padStart(2, '0');
  return `live-${ist.getUTCFullYear()}-${p(ist.getUTCMonth() + 1)}-${p(ist.getUTCDate())}-${p(ist.getUTCHours())}${p(ist.getUTCMinutes())}`;
}

async function main() {
  const a = args();
  const liveDir = a['live-dir'] ?? fail('--live-dir is required');
  const ref = (a.ref ?? 'main').trim();
  const token = process.env.GITHUB_TOKEN ?? fail('GITHUB_TOKEN is not set');
  const repo = process.env.GITHUB_REPOSITORY ?? fail('GITHUB_REPOSITORY is not set');
  if (!/^[A-Za-z0-9._\/-]+$/.test(ref)) fail('ref may contain only letters, digits and ._/-');

  step('Checking the live checkout');
  for (const file of [...COMPOSE_FILES, '.env.laptop']) {
    if (!existsSync(join(liveDir, file))) fail(`${liveDir} has no ${file}; it is not the live checkout`);
  }
  const git = (argv, env) => run('git', ['-C', liveDir, ...argv], env ? { env } : {});
  if (git(['status', '--porcelain', '--untracked-files=no']) !== '') {
    fail('the live checkout has edited tracked files; a deploy would discard them. Commit them in development instead.');
  }
  const previous = git(['rev-parse', 'HEAD']);
  console.log(`live is at ${previous.slice(0, 7)}`);

  step(`Fetching ${ref}`);
  if (stream('git', ['-C', liveDir, 'fetch', '--quiet', '--tags', '--force', 'origin', '+refs/heads/*:refs/remotes/origin/*'], { env: gitEnv(token) }) !== 0) {
    fail('git fetch failed');
  }

  let target;
  if (ref === 'previous') {
    // The newest live-* tag that is not what is running now.
    const tags = git(['tag', '--list', 'live-*', '--sort=-refname']).split('\n').filter(Boolean);
    const earlier = tags.find((t) => git(['rev-list', '-n', '1', t]) !== previous);
    if (earlier === undefined) fail('no earlier live-* tag to roll back to');
    target = git(['rev-list', '-n', '1', earlier]);
    console.log(`rolling back to ${earlier}`);
  } else {
    const candidates = [`refs/remotes/origin/${ref}`, `refs/tags/${ref}`, ref];
    target = null;
    for (const c of candidates) {
      try {
        target = git(['rev-parse', '--verify', '--quiet', `${c}^{commit}`]);
        break;
      } catch {
        // try the next spelling
      }
    }
    if (target === null) fail(`cannot resolve ${ref}`);
  }
  console.log(`target is ${target.slice(0, 7)}: ${git(['log', '-1', '--format=%s', target])}`);

  step('Checking CI passed for this exact commit');
  const runs = await api(
    `/repos/${repo}/actions/workflows/verify.yml/runs?head_sha=${target}&status=success&per_page=1`,
    token,
  );
  if ((runs.total_count ?? 0) === 0) fail(`verify.yml has not passed for ${target.slice(0, 7)}. Wait for CI, or fix it.`);
  console.log('verify.yml passed');

  if (target === previous) {
    console.log('\nAlready live. Rebuilding anyway, which changes nothing that is current.');
  }

  const migrations = git(['diff', '--name-only', previous, target, '--', 'backend/src/storage/migrations']);
  const forward = (() => {
    try {
      run('git', ['-C', liveDir, 'merge-base', '--is-ancestor', previous, target]);
      return true;
    } catch {
      return false;
    }
  })();
  if (migrations !== '') {
    console.log(`\nmigrations in this range:\n${migrations}`);
    if (!forward) {
      console.log(
        '::warning::Going back across a migration does not undo it. The schema stays as it is; ' +
          'that is safe for additive migrations, which every one here is.',
      );
    }
  }

  step('Switching the live checkout');
  git(['checkout', '--quiet', '--detach', target]);

  step('Building and starting (migrations run first, by depends_on)');
  const profiles = Object.entries(OPTIONAL_SERVICES)
    .filter(([, service]) => containerExists(`${PROJECT}-${service}-1`))
    .flatMap(([profile]) => ['--profile', profile]);
  const compose = ['compose', '--env-file', '.env.laptop', ...COMPOSE_FILES.flatMap((f) => ['-f', f]), ...profiles];
  if (stream('docker', [...compose, 'up', '-d', '--build'], { cwd: liveDir }) !== 0) {
    fail(`docker compose up failed. Live checkout is now at ${target.slice(0, 7)}; deploy "previous" to go back.`);
  }

  step('Waiting for health');
  const watched = ['backend', 'frontend', 'redis', 'postgres', 'cloudflared']
    .concat(profiles.filter((p) => p !== '--profile'))
    .map((s) => `${PROJECT}-${s}-1`);
  for (const [name, state] of await waitHealthy(watched)) console.log(`${name}: ${state}`);

  step('Checking the public site through the tunnel');
  const origin = (envValue(liveDir, 'ALLOWED_ORIGINS') ?? '').split(',')[0]?.trim();
  if (!origin?.startsWith('https://')) fail('ALLOWED_ORIGINS in .env.laptop names no https origin to check');
  let ok = false;
  for (let i = 0; i < 12 && !ok; i += 1) {
    try {
      const [page, session] = await Promise.all([fetch(`${origin}/`), fetch(`${origin}/auth/session`)]);
      ok = page.ok && session.ok && typeof (await session.json()).signedIn === 'boolean';
    } catch {
      ok = false;
    }
    if (!ok) await new Promise((r) => setTimeout(r, 5000));
  }
  if (!ok) fail(`${origin} is not answering correctly. Deploy "previous" to go back.`);
  console.log(`${origin} answers`);

  step('Tagging the release');
  // Two deploys in one minute would collide; the second gets a suffix.
  let tag = stamp();
  for (let n = 2; ; n += 1) {
    const created = await api(
      `/repos/${repo}/git/refs`,
      token,
      { method: 'POST', body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: target }) },
      [422],
    );
    if (created.status !== 422) break;
    if (n > 9) fail('could not create a release tag');
    tag = `${stamp()}-${n}`;
  }
  git(['tag', '--force', tag, target]);
  console.log(tag);

  const logDir = join(process.env.LOCALAPPDATA ?? liveDir, 'karobakbak-live');
  mkdirSync(logDir, { recursive: true });
  appendFileSync(
    join(logDir, 'deploys.log'),
    `${new Date().toISOString()} ${tag} ${previous.slice(0, 7)} -> ${target.slice(0, 7)} (${ref})\n`,
  );

  console.log(`\nLive: ${tag} (${target.slice(0, 7)}), was ${previous.slice(0, 7)}.`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Deployed ${tag}\n\n\`${previous.slice(0, 7)}\` → \`${target.slice(0, 7)}\` (${ref})\n\n` +
        (migrations === '' ? 'No migrations.\n' : `Migrations:\n\n\`\`\`\n${migrations}\n\`\`\`\n`),
    );
  }
}

await main();
