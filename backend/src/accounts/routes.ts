/**
 * The sign-in routes (§32, D48).
 *
 * ---------------------------------------------------------------------------
 * FOUR ROUTES, AND WHAT EACH ONE IS ALLOWED TO DO
 * ---------------------------------------------------------------------------
 *   GET  /auth/start     mint state + nonce + PKCE verifier, redirect out
 *   GET  /auth/callback  verify state, exchange, mint a session, redirect home
 *   GET  /auth/session   is this browser signed in
 *   POST /auth/signout   revoke this browser's credential
 *
 * ---------------------------------------------------------------------------
 * THE THREE SECRETS IN FLIGHT, AND WHY THEY ARE COOKIES
 * ---------------------------------------------------------------------------
 * A redirect flow has to carry three values from `/auth/start` to
 * `/auth/callback` through a round trip the server does not control:
 *
 *   state          proves the callback belongs to a flow this browser began.
 *                  Without it, an attacker's authorization code can be
 *                  delivered to a victim's session — login CSRF, which ends
 *                  with the victim's saved connections in the attacker's
 *                  account.
 *   nonce          proves the id token was minted for *this* flow. Without it a
 *                  token captured from any other sign-in against the same pool
 *                  and client replays here.
 *   code_verifier  proves the caller who redeems the code is the one who
 *                  started the flow. Never leaves this server; only its S256
 *                  challenge went to the provider.
 *
 * They ride in one short-lived httpOnly cookie rather than server-side state,
 * because server-side state would need a store, a TTL and a sweep to hold
 * something that is already bound to exactly one browser for ten minutes. The
 * cookie is `SameSite=Lax` — it must survive the provider's cross-site redirect
 * back, which `Strict` would drop, producing a sign-in that fails only for
 * people who actually completed it.
 *
 * It is cleared on the callback whatever the outcome, so a state value is
 * single-use. Replayable state is state that is not doing its job.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY NOT HERE
 * ---------------------------------------------------------------------------
 * No password, no reset, no email sending, no account-deletion endpoint on the
 * chat process. The credential is the provider's problem, which is the entire
 * reason for taking a provider (`docs/FEATURE-INTAKE.md`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import type { Config } from '../config';
import { errorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';
import { accountForSubject, bearerToken, mintCredential, resolveAccount, revokeCredential } from './credentials';
import { TokenError, type OidcClient } from './oidc';

/** Carries state, nonce and the PKCE verifier across the redirect. */
const FLOW_COOKIE = '__Host-kbb_flow';
/** The session credential itself. */
const SESSION_COOKIE = '__Host-kbb_session';

export interface AuthRoutesDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly oidc: OidcClient;
}

export interface AuthRoutes {
  start(req: IncomingMessage, res: ServerResponse): Promise<void>;
  callback(req: IncomingMessage, res: ServerResponse): Promise<void>;
  session(req: IncomingMessage, res: ServerResponse): Promise<void>;
  signout(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /**
   * The account behind a WebSocket upgrade, or null.
   *
   * Lives here rather than in the server because it is the same credential
   * resolution the HTTP routes do, and two copies would drift — the sharper
   * risk being that only one of them checks account status, leaving a suspended
   * account able to do over a socket what it is refused over HTTP.
   *
   * Never throws. A database that cannot answer resolves to null, which is the
   * anonymous path, because chat must not fail when accounts do.
   */
  accountForRequest(req: IncomingMessage): Promise<string | null>;
}

/**
 * Parse a Cookie header.
 *
 * Deliberately small and deliberately not a dependency. It splits on `;`, takes
 * the first `=` only — a cookie value may legitimately contain one — and does
 * not decode, because every value this file sets is base64url and would be
 * unchanged by decoding while `decodeURIComponent` throws on a malformed `%`.
 */
export function parseCookies(header: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name !== '' && out[name] === undefined) out[name] = value;
  }
  return out;
}

/** Constant-time, and length-safe — `timingSafeEqual` throws on a length mismatch. */
function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

export function createAuthRoutes(deps: AuthRoutesDeps): AuthRoutes {
  const { config, logger, db, oidc } = deps;
  const auth = config.auth;

  /**
   * `__Host-` requires Secure, Path=/ and no Domain, and browsers enforce it.
   * That is worth having: it makes a subdomain unable to set a cookie this
   * origin will read, which is the attack a plain name is open to.
   *
   * Local HTTP cannot satisfy the prefix, so the name loses it there. The
   * prefix is a browser-enforced guarantee, not a naming convention, and a
   * `__Host-` cookie without Secure is simply rejected — silently, which would
   * read as "sign-in does nothing".
   */
  function cookieName(base: string): string {
    return auth.secureCookies ? base : base.replace('__Host-', 'kbb_');
  }

  function setCookie(
    res: ServerResponse,
    name: string,
    value: string,
    maxAgeSeconds: number,
  ): void {
    const parts = [
      `${cookieName(name)}=${value}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
    ];
    if (auth.secureCookies) parts.push('Secure');
    const existing = res.getHeader('set-cookie');
    const all = Array.isArray(existing) ? existing : existing === undefined ? [] : [String(existing)];
    res.setHeader('set-cookie', [...all, parts.join('; ')]);
  }

  function clearCookie(res: ServerResponse, name: string): void {
    setCookie(res, name, '', 0);
  }

  function cookiesOf(req: IncomingMessage): Record<string, string> {
    return parseCookies(req.headers.cookie);
  }

  /**
   * The session credential this browser holds.
   *
   * The cookie first, then `Authorization: Bearer`. Both, because the browser
   * uses a cookie and anything scripted uses a header, and supporting only one
   * would mean two credential systems the day the other is needed.
   */
  function credentialOf(req: IncomingMessage): string {
    const cookie = cookiesOf(req)[cookieName(SESSION_COOKIE)];
    if (typeof cookie === 'string' && cookie !== '') return cookie;
    return bearerToken(req.headers.authorization);
  }

  /** Home, with a marker the interface can act on. Never an error body. */
  function home(res: ServerResponse, outcome: 'ok' | 'failed'): void {
    const target = new URL(auth.returnUrl, 'http://placeholder.invalid');
    target.searchParams.set('signin', outcome);
    const relative = `${target.pathname}${target.search}`;
    res.statusCode = 302;
    res.setHeader('location', relative);
    res.end();
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    // Never cached: it is per-credential, and a shared cache holding it would
    // hand one browser's answer to another.
    res.setHeader('cache-control', 'no-store');
    res.end(payload);
  }

  return {
    async start(_req: IncomingMessage, res: ServerResponse): Promise<void> {
      const flow = oidc.start();
      setCookie(
        res,
        FLOW_COOKIE,
        `${flow.state}.${flow.nonce}.${flow.codeVerifier}`,
        auth.flowTtlSeconds,
      );
      res.statusCode = 302;
      res.setHeader('location', flow.authorizeUrl);
      res.end();
      return Promise.resolve();
    },

    async callback(req: IncomingMessage, res: ServerResponse): Promise<void> {
      // Single-use whatever happens next. A state value that survives a failed
      // callback can be replayed against a second one.
      const raw = cookiesOf(req)[cookieName(FLOW_COOKIE)] ?? '';
      clearCookie(res, FLOW_COOKIE);

      const url = new URL(req.url ?? '/', 'http://placeholder.invalid');
      const code = url.searchParams.get('code') ?? '';
      const state = url.searchParams.get('state') ?? '';

      const [cookieState, nonce, verifier] = raw.split('.');
      if (
        code === '' ||
        cookieState === undefined ||
        nonce === undefined ||
        verifier === undefined ||
        !sameToken(state, cookieState)
      ) {
        // The whole of login-CSRF prevention, and the reason it is checked
        // before anything expensive: an attacker's code delivered into a
        // victim's browser stops here, having cost one string comparison.
        logger.warn('sign-in callback did not match a started flow');
        home(res, 'failed');
        return;
      }

      let identity;
      try {
        identity = await oidc.exchange(code, verifier, nonce);
      } catch (err) {
        // `TokenError` messages are constants and carry no token material, so
        // they are safe to log. Anything else is reported without its message.
        if (err instanceof TokenError) logger.warn('sign-in failed', { reason: err.message });
        else logger.error('sign-in failed unexpectedly', errorFields(err));
        home(res, 'failed');
        return;
      }

      const account = await accountForSubject(
        db,
        logger,
        identity.subject,
        config.payments.recordRetentionDays,
      );
      if (!account.ok) {
        logger.warn('sign-in resolved no usable account', { reason: account.reason });
        home(res, 'failed');
        return;
      }

      const token = await mintCredential(db, logger, account.accountId, auth.sessionTtlSeconds);
      if (token === null) {
        home(res, 'failed');
        return;
      }

      setCookie(res, SESSION_COOKIE, token, auth.sessionTtlSeconds);
      home(res, 'ok');
    },

    async session(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      // Deliberately no account id in the body. The interface needs to know
      // *whether* somebody is signed in, and an opaque identifier in a page is
      // one more thing that can be copied into a bug report or a screenshot.
      json(res, 200, { signedIn: resolved.ok });
    },

    async accountForRequest(req: IncomingMessage): Promise<string | null> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      return resolved.ok ? resolved.accountId : null;
    },

    async signout(req: IncomingMessage, res: ServerResponse): Promise<void> {
      await revokeCredential(db, logger, credentialOf(req));
      clearCookie(res, SESSION_COOKIE);
      // Always 200. Signing out when not signed in is success — the caller's
      // goal is that this browser holds no working credential, and it does not.
      json(res, 200, { signedIn: false });
    },
  };
}
