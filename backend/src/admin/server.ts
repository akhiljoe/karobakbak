/**
 * The moderation console's HTTP listener.
 *
 * ---------------------------------------------------------------------------
 * WHY A SEPARATE LISTENER
 * ---------------------------------------------------------------------------
 * The chat server's port is the one nginx proxies to the internet. Hanging
 * console routes off it would put "read every retained conversation" one
 * `location` block away from being public, and the mistake would look like a
 * routing typo rather than a breach. A second listener that is simply never
 * published cannot be reached by a routing mistake at all.
 *
 * Authentication is therefore the *second* layer here, not the only one, and
 * the default bind address is loopback so the console is reachable through an
 * SSH tunnel and nowhere else until someone deliberately widens it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES NOT DO
 * ---------------------------------------------------------------------------
 * No route here returns message content. The read side and its mandatory audit
 * rows arrive next; this is the door, the session cookie and the guard that
 * later routes are mounted behind.
 */
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { Config } from '../config';
import type { Logger } from '../logger';
import { errorFields } from '../logger';
import type { AdminAuth, AdminIdentity } from './auth';

/** The console session cookie. Distinct name from the chat's block token. */
export const ADMIN_SESSION_COOKIE = 'kbb_admin';

/**
 * Cap on a request body.
 *
 * Every console request is a small JSON object — a username, a code, an id, a
 * justification. 16 KB is generous for all of them and small enough that an
 * unauthenticated caller cannot make the process buffer anything meaningful.
 */
const MAX_BODY_BYTES = 16 * 1024;

/**
 * The window the per-address login budget is counted over.
 *
 * The budget itself is configuration; the window is not, because the two
 * together are one rate and exposing both invites a deployment that sets a
 * generous count against an hour-long window and believes it is throttled.
 *
 * Deliberately in memory rather than in Redis: the console is one process, and
 * giving it a Redis dependency would mean the moderation tool goes down with
 * the chat's cache — exactly when someone needs to look at a report.
 */
const LOGIN_WINDOW_MS = 60_000;

/**
 * The console's own three files.
 *
 * An explicit map rather than a directory served by path, so there is no
 * traversal to get wrong: a request can only ever name one of these three
 * keys, and `..` resolves to nothing because the path is never joined with
 * caller input. A static server that takes the URL as a filename is the
 * classic way an admin origin ends up serving `/etc/passwd`.
 */
const STATIC_FILES = new Map<string, { file: string; type: string }>([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/console.css', { file: 'console.css', type: 'text/css; charset=utf-8' }],
  ['/console.js', { file: 'console.js', type: 'text/javascript; charset=utf-8' }],
]);

/** Read once at first request and kept: three small files that never change. */
const staticCache = new Map<string, Buffer>();

function serveStatic(res: ServerResponse, path: string): void {
  const entry = STATIC_FILES.get(path);
  if (entry === undefined) {
    res.writeHead(404).end();
    return;
  }
  let body = staticCache.get(entry.file);
  if (body === undefined) {
    body = readFileSync(join(__dirname, 'public', entry.file));
    staticCache.set(entry.file, body);
  }
  res.writeHead(200, {
    'content-type': entry.type,
    'content-length': body.length,
  });
  res.end(body);
}

export interface AdminServer {
  listen(): Promise<number>;
  close(): Promise<void>;
}

/** A request that has already been authenticated. */
export interface AdminRequestContext {
  readonly identity: AdminIdentity;
  readonly body: Record<string, unknown>;
}

/** A route mounted behind the session guard. */
export interface AdminRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  handle(context: AdminRequestContext): Promise<{ status: number; body: unknown }>;
}

export function createAdminServer(deps: {
  config: Config;
  logger: Logger;
  auth: AdminAuth;
  routes?: readonly AdminRoute[];
}): AdminServer {
  const { config, logger, auth } = deps;
  const routes = deps.routes ?? [];
  const attempts = new Map<string, { count: number; resetAt: number }>();

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      logger.error('console request failed', errorFields(err));
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    const method = req.method ?? 'GET';

    // Security headers on every response, including errors. The console
    // renders retained conversation content, so a script injected into this
    // origin would be able to read all of it.
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader(
      'content-security-policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
    );

    if (path === '/health') {
      json(res, 200, { status: 'ok' });
      return;
    }

    // The console itself, before the guard: the sign-in page is by definition
    // reachable without a session. These three files contain no data — the
    // page is empty until it fetches, and every fetch is guarded.
    if (method === 'GET' && STATIC_FILES.has(path)) {
      serveStatic(res, path);
      return;
    }

    // Origin is checked on every state-changing request. The cookie is
    // SameSite=Strict, which already defeats the classic cross-site form post,
    // but SameSite is a browser behaviour and this is a defence that does not
    // depend on the caller's browser being current.
    if (method === 'POST' && !originAllowed(req)) {
      logger.warn('console refused a request from a disallowed origin');
      json(res, 403, { error: 'origin_not_allowed' });
      return;
    }

    if (method === 'POST' && path === '/api/login') {
      await handleLogin(req, res);
      return;
    }

    if (method === 'POST' && path === '/api/logout') {
      const token = readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
      if (token !== null) await auth.logout(token);
      clearSessionCookie(res);
      json(res, 200, { status: 'logged_out' });
      return;
    }

    // Everything below needs a session.
    const token = readCookie(req.headers.cookie, ADMIN_SESSION_COOKIE);
    if (token === null) {
      json(res, 401, { error: 'not_authenticated' });
      return;
    }
    const session = await auth.resolveSession(token);
    if (session.status === 'unavailable') {
      json(res, 503, { error: 'unavailable' });
      return;
    }
    if (session.status !== 'ok') {
      // Clear a cookie that cannot work, so a stale one does not keep
      // producing 401s that look like a broken login.
      clearSessionCookie(res);
      json(res, 401, { error: 'not_authenticated' });
      return;
    }

    if (method === 'GET' && path === '/api/session') {
      json(res, 200, {
        username: session.identity.username,
        role: session.identity.role,
        expiresAt: session.expiresAt.toISOString(),
      });
      return;
    }

    const route = routes.find((entry) => entry.method === method && entry.path === path);
    if (route === undefined) {
      json(res, 404, { error: 'not_found' });
      return;
    }

    let body: Record<string, unknown> = {};
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (parsed === null) {
        json(res, 400, { error: 'invalid_body' });
        return;
      }
      body = parsed;
    }

    const result = await route.handle({ identity: session.identity, body });
    json(res, result.status, result.body);
  }

  async function handleLogin(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const address = req.socket.remoteAddress ?? 'unknown';
    if (!spendAttempt(address)) {
      json(res, 429, { error: 'too_many_attempts' });
      return;
    }

    const body = await readJsonBody(req);
    if (body === null) {
      json(res, 400, { error: 'invalid_body' });
      return;
    }
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const code = typeof body.code === 'string' ? body.code : '';
    if (username === '' || password === '' || code === '') {
      json(res, 400, { error: 'invalid_body' });
      return;
    }

    const result = await auth.login(username, password, code);
    if (result.status === 'unavailable') {
      json(res, 503, { error: 'unavailable' });
      return;
    }
    if (result.status === 'locked') {
      json(res, 423, { error: 'locked', until: result.until.toISOString() });
      return;
    }
    if (result.status !== 'ok') {
      // One message for every failure. Which factor was wrong is exactly what
      // an attacker wants narrowed down.
      json(res, 401, { error: 'invalid_credentials' });
      return;
    }

    setSessionCookie(res, result.token, result.expiresAt);
    json(res, 200, {
      username: result.identity.username,
      role: result.identity.role,
      expiresAt: result.expiresAt.toISOString(),
    });
  }

  function originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    // A request with no Origin is not a browser doing a cross-site post, which
    // is what this check exists to stop. `curl` and the test client land here.
    if (origin === undefined || origin === '') return true;
    if (config.admin.allowedOrigins.length === 0) return true;
    return config.admin.allowedOrigins.includes(origin);
  }

  function setSessionCookie(res: ServerResponse, token: string, expiresAt: Date): void {
    const parts = [
      `${ADMIN_SESSION_COOKIE}=${token}`,
      'Path=/',
      'HttpOnly',
      // Strict rather than Lax: there is no cross-site flow into this console
      // that anyone should be following, and Lax would still send the cookie
      // on a top-level navigation someone was tricked into.
      'SameSite=Strict',
      `Expires=${expiresAt.toUTCString()}`,
    ];
    // Secure would make the cookie undeliverable over the plain-HTTP tunnel a
    // developer uses locally, so it follows the environment rather than being
    // unconditional.
    if (config.isProduction) parts.push('Secure');
    res.setHeader('set-cookie', parts.join('; '));
  }

  function clearSessionCookie(res: ServerResponse): void {
    const parts = [
      `${ADMIN_SESSION_COOKIE}=`,
      'Path=/',
      'HttpOnly',
      'SameSite=Strict',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ];
    if (config.isProduction) parts.push('Secure');
    res.setHeader('set-cookie', parts.join('; '));
  }

  /** Fixed window, per address. Swept lazily so an idle console holds nothing. */
  function spendAttempt(address: string): boolean {
    const now = Date.now();
    const existing = attempts.get(address);
    if (existing === undefined || existing.resetAt <= now) {
      attempts.set(address, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
      if (attempts.size > 1024) {
        for (const [key, entry] of attempts) if (entry.resetAt <= now) attempts.delete(key);
      }
      return true;
    }
    if (existing.count >= config.admin.loginAttemptsPerMinute) return false;
    existing.count += 1;
    return true;
  }

  return {
    async listen(): Promise<number> {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.admin.port, config.admin.host, () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
      const address = server.address();
      const port = address !== null && typeof address === 'object' ? address.port : config.admin.port;
      logger.info('moderation console listening', { port, host: config.admin.host });
      return port;
    },

    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Read one cookie value, or null. Deliberately minimal. */
export function readCookie(header: string | undefined, name: string): string | null {
  if (header === undefined) return null;
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Read a JSON object body, or null if it is oversized, malformed, or not an
 * object. Returning null rather than throwing keeps every bad body a 400
 * instead of a 500 that distinguishes shapes of badness.
 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Re-exported so a caller can build the guard without importing the module. */
export type { Server };
