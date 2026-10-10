#!/usr/bin/env node
/**
 * Turns the Alertmanager webhook URL into one that ntfy renders readably.
 *
 *   node scripts/ntfy-alert-url.mjs                 # keep the topic already in webhook-url
 *   node scripts/ntfy-alert-url.mjs https://ntfy.sh/<topic>   # set a new topic
 *   node scripts/ntfy-alert-url.mjs --print-template          # show the templates, touch nothing
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * Alertmanager's webhook posts JSON, and ntfy shows a body it was not told how
 * to read as raw text — so every alert arrived as a wall of JSON. ntfy can
 * render the JSON itself with Go templates passed in the URL (`tpl=yes`, `t=`,
 * `m=`, `p=`), which needs no relay, no new service and no change to
 * Alertmanager. The webhook URL is the only place that can carry them, because
 * both receivers share one `url_file`.
 *
 * What arrives on the phone:
 *
 *   🚨 Urgent · BackendAbsent                  (severity=page  -> priority 5)
 *   ⚠️ Warning · ReportsWaitingTooLong         (severity=ticket -> priority 3)
 *   👋 Activity · DailyChatSummary            (severity=info   -> priority 3, never resolved)
 *   ✅ Fixed · BackendAbsent                   (resolved        -> priority 2)
 *
 * then each alert's `summary`, its `description` while it is firing, and when it
 * started or ended in IST. Every rule in monitoring/prometheus/alerts.yml has a
 * summary and all but one a description; a rule without a description simply
 * sends the summary.
 *
 * ---------------------------------------------------------------------------
 * THE TOPIC IS A SECRET, SO THIS NEVER PRINTS IT
 * ---------------------------------------------------------------------------
 * Anybody who knows an ntfy.sh topic can read it. The script reads the topic
 * from the existing file and writes it back; what it prints is the host and the
 * byte count. The file is written without a trailing newline, like every other
 * secret file here (F-049).
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'monitoring', 'alertmanager', 'webhook-url');

const TIME = (field) =>
  `{{dateInZone "2 Jan, 3:04 pm" (toDate "2006-01-02T15:04:05Z07:00" .${field}) "Asia/Kolkata"}}`;

export const TEMPLATES = {
  title:
    '{{if eq .status "resolved"}}✅ Fixed{{else if eq .commonLabels.severity "page"}}🚨 Urgent{{else if eq .commonLabels.severity "info"}}👋 Activity{{else}}⚠️ Warning{{end}}' +
    ' · {{.groupLabels.alertname}}',
  message:
    '{{range .alerts}}' +
    '{{if eq .status "resolved"}}Resolved: {{end}}{{.annotations.summary}}\n' +
    '{{if ne .status "resolved"}}{{with .annotations.description}}\n{{.}}\n{{end}}{{end}}' +
    `\n{{if eq .status "resolved"}}Ended ${TIME('endsAt')}{{else}}Since ${TIME('startsAt')}{{end}} IST\n` +
    '{{end}}',
  priority: '{{if eq .status "resolved"}}2{{else if eq .commonLabels.severity "page"}}5{{else}}3{{end}}',
};

export function buildUrl(base) {
  const q = new URLSearchParams({ tpl: 'yes', t: TEMPLATES.title, m: TEMPLATES.message, p: TEMPLATES.priority });
  return `${base}?${q}`;
}

function topicBase(raw) {
  const value = raw.trim().split('?')[0];
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.pathname.split('/').filter(Boolean).length !== 1) return null;
  return `${url.origin}${url.pathname}`;
}

/**
 * The command line. Only runs when this file is executed, never when it is
 * imported, and every path that has not resolved a valid topic returns before
 * the write.
 *
 * Both rules were learnt the hard way: the first version ran its command line
 * on import, a test that imported it had stubbed `process.exit`, the "no topic"
 * branch therefore fell through, and the live webhook-url was overwritten with
 * `null?tpl=...` — the topic gone and every alert going nowhere. A function
 * that writes a secret file must not depend on `process.exit` to stop it.
 */
function main(args) {
  if (args.includes('--print-template')) {
    console.log(JSON.stringify(TEMPLATES, null, 2));
    return 0;
  }

  let base = null;
  if (args[0]) {
    base = topicBase(args[0]);
    if (!base) {
      console.error('expected an https URL of one topic, e.g. https://ntfy.sh/kbb-xxxxxxxx');
      return 1;
    }
  } else {
    if (!existsSync(file) || !statSync(file).isFile()) {
      console.error(`${file} does not exist (or is a directory). Pass the topic URL as an argument.`);
      return 1;
    }
    base = topicBase(readFileSync(file, 'utf8'));
    if (!base) {
      console.error('webhook-url does not hold an https URL of one ntfy topic. Pass the topic URL as an argument.');
      return 1;
    }
  }

  // Belt and braces: never write anything that is not a templated topic URL.
  const url = buildUrl(base);
  if (!url.startsWith('https://') || topicBase(url) !== base) {
    console.error('refusing to write: the URL did not come out as expected');
    return 1;
  }
  writeFileSync(file, url); // no trailing newline
  console.log(`webhook-url written: ${new URL(base).host}/<topic hidden>, ${Buffer.byteLength(url)} bytes, templated`);
  console.log('Alertmanager reads the file on every send; no restart needed.');
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
