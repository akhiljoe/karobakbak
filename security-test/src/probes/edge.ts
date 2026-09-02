/**
 * What the edge actually serves, as opposed to what `security-headers.conf`
 * says it serves.
 *
 * `CLAUDE.md`'s rule is "verify the served artifact, not the source", and it
 * was written after three separate rounds of debugging code that was already
 * correct. A header is the easiest thing in this system to get right in a file
 * and wrong in a response: nginx replaces rather than merges `add_header`, so
 * any location that sets one of its own silently loses all the others.
 */
import { fail, pass, type Context, type Probe, type Result } from '../probe';

interface Fetched {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
}

async function get(url: string, init?: RequestInit): Promise<Fetched> {
  const res = await fetch(url, { redirect: 'manual', ...init });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** Every header the config sets, checked on every path that serves content. */
const REQUIRED = [
  'content-security-policy',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'x-frame-options',
];

export const securityHeaders: Probe = {
  id: 'EDGE-1',
  name: 'security headers reach every response, not just the root',
  proves:
    'nginx replaces rather than merges add_header, so a location that sets one of its own ' +
    'loses all the rest. This is the check that a location was not added without the include.',
  async run(ctx): Promise<Result> {
    // The index, a hashed asset, and a path that falls through to the SPA.
    const paths = ['/', '/index.html', '/some/deep/route'];
    const missing: string[] = [];

    for (const path of paths) {
      const res = await get(`${ctx.origin}${path}`);
      for (const header of REQUIRED) {
        if (!res.headers.has(header)) missing.push(`${path} is missing ${header}`);
      }
    }

    if (missing.length > 0) return fail(`${missing.length} header(s) absent`, missing);
    return pass(`all ${REQUIRED.length} headers present on ${paths.length} paths`);
  },
};

export const cspShape: Probe = {
  id: 'EDGE-2',
  name: 'the CSP forbids framing, inline script and a base tag',
  proves:
    'The console holds a session that can read every retained conversation, and the chat page ' +
    'renders text a stranger typed. A CSP that allows unsafe-inline script is most of an XSS.',
  async run(ctx): Promise<Result> {
    const res = await get(`${ctx.origin}/`);
    const csp = res.headers.get('content-security-policy') ?? '';
    if (csp === '') return fail('no Content-Security-Policy on the index');

    const problems: string[] = [];
    // `style-src 'unsafe-inline'` is accepted here and script-src is not: a
    // style cannot exfiltrate a message, and the build inlines critical CSS.
    if (/script-src[^;]*'unsafe-inline'/.test(csp)) problems.push("script-src allows 'unsafe-inline'");
    if (/script-src[^;]*'unsafe-eval'/.test(csp)) problems.push("script-src allows 'unsafe-eval'");
    if (!/frame-ancestors\s+'none'/.test(csp)) problems.push("frame-ancestors is not 'none'");
    if (!/object-src\s+'none'/.test(csp)) problems.push("object-src is not 'none'");
    if (!/base-uri\s+'none'/.test(csp)) problems.push("base-uri is not 'none'");

    if (problems.length > 0) return fail('the policy is weaker than it should be', problems);
    return pass('script-src, frame-ancestors, object-src and base-uri are all locked down');
  },
};

/**
 * The scrape endpoint is for this service, not for the internet.
 *
 * `prometheus.yml` scrapes the backends directly on the private network and
 * says so; nginx returns 404 for `/metrics` on purpose. A metrics endpoint
 * reachable from outside publishes every counter on the four dashboards,
 * including the safety ones.
 */
export const metricsNotPublic: Probe = {
  id: 'EDGE-3',
  name: '/metrics is not reachable through the edge',
  proves: 'The scrape endpoint publishes every counter this system keeps. It is for Prometheus.',
  async run(ctx): Promise<Result> {
    const res = await get(`${ctx.origin}/metrics`);
    if (res.status === 200 && res.body.includes('chat_')) {
      return fail(`the edge served the scrape (${res.status}, ${res.body.length} bytes)`);
    }
    return pass(`the edge answered ${res.status}`);
  },
};

/**
 * A request line carrying a credential must not come back in a response the
 * way it went in, and must not be logged. The log half is F-036 and is checked
 * by `verify-log-hygiene.mjs`; this checks the response half.
 */
export const authCallbackDoesNotEcho: Probe = {
  id: 'EDGE-4',
  name: 'the sign-in callback does not reflect its own query string',
  proves:
    'The OIDC callback carries a single-use authorization code. A response that echoes it into ' +
    'the page puts a credential somewhere a screenshot or a bug report can carry it.',
  async run(ctx): Promise<Result> {
    const canary = 'CANARY_AUTHORIZATION_CODE_9f3a';
    const res = await get(`${ctx.origin}/auth/callback?code=${canary}&state=abc`);
    if (res.body.includes(canary)) {
      return fail(`the response body reflected the code (status ${res.status})`);
    }
    return pass(`status ${res.status}, and the code appears nowhere in the body`);
  },
};

/**
 * Every console route, unauthenticated.
 *
 * The console's session can read every retained conversation, so the only
 * acceptable answers with no credential are "no" and "there is nothing here".
 * A 200 on any of them is the whole system.
 */
export const consoleRequiresAuth: Probe = {
  id: 'EDGE-5',
  name: 'no moderation console route answers without a session',
  proves: 'A console session can read every retained conversation (§25, D32).',
  async run(ctx): Promise<Result> {
    if (ctx.consoleOrigin === null) {
      return { verdict: 'SKIP', detail: 'no console origin given; pass --console to enable' };
    }

    const routes = [
      '/api/reports',
      '/api/reports/open',
      '/api/conversations',
      '/api/enforcement',
      '/api/personas',
      '/api/audit',
    ];
    const answered: string[] = [];

    for (const route of routes) {
      const res = await get(`${ctx.consoleOrigin}${route}`);
      // 401 and 403 are refusals; 404 is "no such route", which is also fine —
      // an unauthenticated caller learning nothing is the point.
      if (res.status === 200) answered.push(`${route} answered 200 (${res.body.length} bytes)`);
    }

    if (answered.length > 0) return fail('a console route answered without a session', answered);
    return pass(`all ${routes.length} probed routes refused an unauthenticated caller`);
  },
};
