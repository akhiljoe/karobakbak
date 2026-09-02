#!/usr/bin/env node
/**
 * Reads back what was actually shipped to Loki and fails if it should not have
 * been there.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A DETECTOR AND NOT A REDACTOR
 * ---------------------------------------------------------------------------
 * The obvious design is a redaction stage in the shipper that scrubs anything
 * address-shaped on the way past. That was rejected, and the reasoning is the
 * same one behind every guard in this repository: a redactor makes a leak
 * invisible. If `logger.ts`'s denylist or nginx's log format ever stops working,
 * a scrubber downstream means nobody finds out — the lines arrive clean and the
 * broken control is discovered by somebody else, later, somewhere worse.
 *
 * So the pipeline keeps the controls at the source, where the meaning of a
 * field is known, and this reads the result and says whether they held.
 *
 * It is not part of `npm run verify`, which is hermetic. This one needs a
 * running stack, so it runs after one — from the swarm's own runs, and by hand.
 *
 * Usage:
 *   node scripts/verify-log-hygiene.mjs                     # dev stack
 *   node scripts/verify-log-hygiene.mjs --url http://localhost:3103 --since 2h
 *
 * Exit code is non-zero if anything was found.
 *
 * ---------------------------------------------------------------------------
 * THIS SCRIPT MUST NOT PRINT WHAT IT FINDS
 * ---------------------------------------------------------------------------
 * A tool that reports a leak by quoting it has copied the leak into CI output,
 * a terminal scrollback and quite possibly a pasted bug report. Every finding
 * below is reported as its shape, its location and a truncated SHA-256 of the
 * offending value — enough to tell two findings apart and to confirm a fix,
 * and not enough to be the leak a second time.
 */
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
};

const LOKI = (flag('--url', process.env.LOKI_URL ?? 'http://localhost:3100')).replace(/\/$/, '');
const SINCE = flag('--since', '1h');
const LIMIT = Number(flag('--limit', '5000'));

const SINCE_SECONDS = (() => {
  const m = /^(\d+)([smhd])$/.exec(SINCE);
  if (!m) throw new Error(`--since must look like 30m, 2h, 1d; got ${JSON.stringify(SINCE)}`);
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86400 }[m[2]];
})();

/**
 * Addresses that are not a person.
 *
 * Container and host networking, loopback, link-local, multicast and the
 * unspecified block. Everything outside this set is treated as potentially a
 * visitor's address, including the RFC 2544 range the swarm draws its synthetic
 * identities from — those are fake, but a fake address in a log line still
 * means something logged an `X-Forwarded-For`, which is the defect.
 */
const INTERNAL_V4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^0\./,
  /^(22[4-9]|23\d)\./,
  /^255\./,
];

/**
 * A dotted quad, delimited by something that is not part of a longer token.
 *
 * `\b` on its own is not enough, and the failure is not hypothetical: the first
 * run of this script reported two findings in `prometheus` and `frontend` that
 * turned out to be `6.6.87.2` — the **WSL2 kernel version**, printed in both
 * containers' startup banners. A four-part version number is indistinguishable
 * from an address by shape alone.
 *
 * The lookbehind and lookahead reject a quad that is glued to a longer token
 * (`6.6.87.2-microsoft-standard-WSL2`), which is what a version string in a
 * banner always is. A real address in a log line is followed by a quote, a
 * colon, a comma or a space — never by a letter or a dash.
 *
 * This is a heuristic and it is the right kind: it errs towards missing a leak
 * that is formatted like a version, rather than towards crying wolf on every
 * startup. A detector that reports two findings on a clean stack is one that
 * gets run with `|| true` within a week.
 */
const DOTTED_QUAD = /(?<![\w.-])(?:\d{1,3}\.){3}\d{1,3}(?![\w.-])/g;

/** `name=value`, the shape a credential takes outside a JSON object. */
const CREDENTIAL_KV =
  /(?:^|[?&\s"'])(code|state|id_token|access_token|refresh_token|token|secret|signature|password|passwd|api_key|apikey)=([^&"'\s]+)/gi;

/**
 * Field names that must never carry a value out of the trusted boundary.
 *
 * The same list `backend/src/logger.ts` denies, checked here as JSON keys on
 * the shipped line. The logger throws on these outside production, so a hit
 * means either production redaction fired (and the field should not have been
 * there in the first place) or something reached the log stream without going
 * through the logger at all — nginx, a dependency, a `console.log`.
 */
const FORBIDDEN_JSON_KEYS = [
  'text',
  'body',
  'content',
  'message',
  'messages',
  'note',
  'notes',
  'payload',
  'frame',
  'raw',
  'ip',
  'remoteAddress',
  'clientIp',
  'xForwardedFor',
];

const isInternal = (addr) => {
  const parts = addr.split('.');
  if (parts.length !== 4 || parts.some((p) => Number(p) > 255)) return true; // not an address
  return INTERNAL_V4.some((re) => re.test(addr));
};

const fingerprint = (value) => createHash('sha256').update(value).digest('hex').slice(0, 12);

async function query() {
  const end = Date.now() * 1e6;
  const start = (Date.now() - SINCE_SECONDS * 1000) * 1e6;
  const url =
    `${LOKI}/loki/api/v1/query_range?` +
    new URLSearchParams({
      query: '{project=~".+"}',
      start: String(start),
      end: String(end),
      limit: String(LIMIT),
      direction: 'backward',
    });

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Loki returned ${res.status} ${res.statusText} for ${LOKI}`);
  }
  const json = await res.json();
  return json.data?.result ?? [];
}

const findings = [];
const record = (kind, stream, detail, value) => {
  findings.push({
    kind,
    service: stream.service ?? stream.container ?? 'unknown',
    detail,
    fingerprint: fingerprint(value),
  });
};

const streams = await query();
let lineCount = 0;

for (const s of streams) {
  for (const [, line] of s.values) {
    lineCount += 1;

    for (const match of line.match(DOTTED_QUAD) ?? []) {
      if (!isInternal(match)) record('public-ip', s.stream, 'address literal in log line', match);
    }

    for (const m of line.matchAll(CREDENTIAL_KV)) {
      if (m[2] !== 'REDACTED') record('credential', s.stream, `${m[1]}=…`, m[2]);
    }

    // Only meaningful on the streams that emit JSON; a plain-text line
    // containing the word "body" is not a leak.
    if (line.startsWith('{')) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = null;
      }
      if (parsed && typeof parsed === 'object') {
        for (const key of FORBIDDEN_JSON_KEYS) {
          const v = parsed[key];
          if (v !== undefined && v !== null && v !== '' && v !== '[REDACTED]') {
            record('forbidden-field', s.stream, `JSON key "${key}"`, String(v));
          }
        }
      }
    }
  }
}

console.log(`log hygiene: ${lineCount} line(s) across ${streams.length} stream(s), last ${SINCE}`);

if (findings.length === 0) {
  console.log('PASS — no address, credential or denied field found in shipped logs.');
  process.exit(0);
}

// Group so a single repeated leak reads as one problem rather than as hundreds.
//
// The key holds the whole finding rather than a joined string, and that is not
// style. A separator-joined key has to be split again to be printed, and
// `detail` contains spaces ("address literal in log line"), so splitting on one
// would print the first word and drop the rest. The first draft used a
// separator that reached the file as a literal NUL byte, which made the split
// work by accident and turned this script into a binary file to git and grep.
// That is the control-character trap in CLAUDE.md wearing different clothes.
// JSON round-trips exactly and has no separator to choose wrongly.
const grouped = new Map();
for (const f of findings) {
  const key = JSON.stringify([f.kind, f.service, f.detail, f.fingerprint]);
  const seen = grouped.get(key);
  grouped.set(key, { finding: f, count: (seen?.count ?? 0) + 1 });
}

console.error(`
FAIL — ${findings.length} finding(s), ${grouped.size} distinct:
`);
for (const { finding, count } of [...grouped.values()].sort((a, b) => b.count - a.count)) {
  console.error(
    `  ${finding.kind.padEnd(16)} ${finding.service.padEnd(12)} ${finding.detail}` +
      `  (sha256:${finding.fingerprint} ×${count})`,
  );
}
console.error(
  '\nValues are fingerprinted rather than printed: a tool that reports a leak by\n' +
    'quoting it has copied the leak into this output. Find the source by the\n' +
    'service and the shape, not by searching for the value.\n',
);
process.exit(1);
