#!/usr/bin/env node
/**
 * Where to open the app, and which of those addresses will actually work.
 *
 * The URL is not the interesting part — the port is in `.env` and anybody can
 * read it. What this exists for is the second half: `ALLOWED_ORIGINS` is a
 * fixed list, and a LAN address that is not on it **serves the page perfectly
 * and then refuses the WebSocket upgrade with a 403**. The site loads, the
 * header renders, and pressing start does nothing. On a laptop that moves
 * between networks — or a Tailscale address that is not the one written down —
 * that happens without anything in the interface saying why.
 *
 * So every address this machine currently answers on is listed, and each one is
 * marked with whether the running configuration will accept a socket from it.
 *
 * Reads `.env` directly rather than asking Docker, so it is correct before the
 * stack is up and does not need the containers running.
 *
 * Usage:
 *   node scripts/where.mjs      # also runs at the end of `npm run up`
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A deliberately small `.env` reader: `KEY=value`, last one wins.
 *
 * Last-wins matches how Docker Compose reads the same file, and it matters
 * here — `.env` carries `ALLOWED_ORIGINS` twice, once in the documented block
 * near the top and once in the LAN-testing block at the bottom. Taking the
 * first would report a rule the server is not using.
 */
function readEnv() {
  let text;
  try {
    text = readFileSync(join(root, '.env'), 'utf8');
  } catch {
    return null;
  }

  const values = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

/** Every non-loopback IPv4 this machine currently answers on. */
function localAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      found.push({ name, address: entry.address });
    }
  }
  return found;
}

const env = readEnv();
if (env === null) {
  console.error('No .env found. Copy .env.example to .env first.');
  process.exit(1);
}

const port = env.FRONTEND_PORT ?? '8081';
const allowed = new Set(
  (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== ''),
);

const ok = '✓';
const no = '✗';

console.log('');
console.log(`  Open the app at:  http://localhost:${port}`);
console.log('');

// localhost is checked like everything else rather than assumed. It is the one
// people actually use, so a .env whose origins were all rewritten for a LAN
// test — and never rewritten back — should say so loudly.
const rows = [
  { label: 'localhost', origin: `http://localhost:${port}` },
  { label: '127.0.0.1', origin: `http://127.0.0.1:${port}` },
  ...localAddresses().map((iface) => ({
    label: `${iface.address}  (${iface.name})`,
    origin: `http://${iface.address}:${port}`,
  })),
];

let refused = 0;
for (const row of rows) {
  const permitted = allowed.has(row.origin);
  if (!permitted) refused += 1;
  console.log(`  ${permitted ? ok : no}  ${row.origin.padEnd(34)} ${row.label}`);
}

console.log('');
if (refused > 0) {
  console.log(`  ${no} = the page loads and the chat socket is refused with a 403.`);
  console.log('      Add the origin to ALLOWED_ORIGINS in .env, then: docker compose up -d');
  console.log('');
}

// The port is the whole application origin, so the sign-in redirect is built
// from it. A mismatch here is registered at the provider, not in this repo, and
// the symptom is a provider error page rather than anything logged locally.
const redirect = env.AUTH_REDIRECT_URI ?? '';
if (env.AUTH_ENABLED === 'true' && redirect !== '' && !redirect.includes(`:${port}/`)) {
  console.log(`  ${no}  AUTH_REDIRECT_URI is ${redirect}`);
  console.log(`      but the app is served on port ${port}. Sign-in will fail at the provider.`);
  console.log('');
}
