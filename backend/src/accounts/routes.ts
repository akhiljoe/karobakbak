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
import { fetchAvatar } from './avatar';
import { createHash } from 'node:crypto';
import type { ConnectionRepository } from './connections';
import type { BlockRepository } from './blocks';
import type { PresenceService } from './presence';
import { createKeys } from '../redis/keys';
import type { Redis } from 'ioredis';
import { TokenError, type OidcClient } from './oidc';

/** Carries state, nonce, the PKCE verifier and the landing mode across the redirect. */
const FLOW_COOKIE = '__Host-kbb_flow';

/**
 * How the browser got here, and therefore where it goes at the end.
 *
 * A closed list of two. Anything else read off the query string is `redirect`,
 * which is the safe direction: a full-page landing always works, while sending
 * a top-level navigation to the popup page would close a tab the user opened.
 */
export type FlowMode = 'redirect' | 'popup';

/**
 * The page a popup lands on. Static, served by the edge from the SPA root, and
 * deliberately not under `/auth/` — that prefix is proxied to this process, and
 * this file is a few hundred bytes nginx can serve without waking the backend.
 */
const POPUP_DONE_PAGE = '/signin-done.html';
/** The session credential itself. */
const SESSION_COOKIE = '__Host-kbb_session';

/**
 * What the sign-in and connection routes report to the metrics registry.
 *
 * Injected as callbacks rather than the registry itself, the same shape as
 * `MatchmakingObserver`: these routes should not be able to reach any metric
 * they were not given, and a test should not need a Prometheus registry to
 * assert what they counted.
 *
 * Nothing here counts a refusal. A request that was ignored, and a connection
 * that was not saved back, are private decisions — the `connectionsMade`
 * comment in `metrics/registry.ts` records that reasoning and
 * `RECONNECT_FAILURES` repeats it. What is counted is what succeeded and what
 * broke.
 */
export interface AccountsObserver {
  authStarted(): void;
  authCallback(outcome: 'ok' | 'flow_mismatch' | 'token_error' | 'no_account' | 'no_credential'): void;
  accountCreated(): void;
  reconnectPaired(): void;
  reconnectFailed(reason: 'no_session' | 'expired' | 'error'): void;
  connectionRemoved(): void;
  avatarRelayed(outcome: 'ok' | 'none' | 'error'): void;
}

export interface AuthRoutesDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly oidc: OidcClient;
  /** Metrics, or absent in a test that does not care what was counted. */
  readonly observer?: AccountsObserver;
  /**
   * The command connection, for the avatar URL cache only.
   *
   * Sign-in itself touches no Redis — it is a PostgreSQL flow — so this is
   * optional and every path treats its absence as "no avatar", the same as a
   * provider that returned no picture.
   */
  readonly redis?: Redis;
  /** Saved connections. Absent means the routes answer as if there are none. */
  readonly connections?: ConnectionRepository;
  /** Account-scoped blocks. Absent means the routes answer as if there are none. */
  readonly blocks?: BlockRepository;
  /** Who is online. Absent means nobody is reported online, ever. */
  readonly presence?: PresenceService;
  /**
   * Reconnect plumbing, supplied by the chat process.
   *
   * Given as functions rather than the lifecycle itself: these routes need to
   * put two sessions in a lane and tell them to look, and nothing more of the
   * matchmaking surface should be reachable from an HTTP handler.
   */
  readonly reconnect?: {
    /** Both sides' block keys, and a way to write a block between them. */
    block(offerAsker: string, offerTarget: string): Promise<boolean>;
    /** The session behind a request, if it is still attached here or anywhere. */
    notify(sessionId: string, event: { offer: string } | { startedAt: string }): Promise<boolean>;
    /** Put a session into a private lane so ordinary matchmaking pairs the two. */
    pair(sessionA: string, sessionB: string): Promise<void>;
  };
}

export interface AuthRoutes {
  start(req: IncomingMessage, res: ServerResponse): Promise<void>;
  callback(req: IncomingMessage, res: ServerResponse): Promise<void>;
  session(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Relays the provider's profile image from this origin. */
  avatar(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The caller's saved connections. */
  connections(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Removes one of them, addressed by its per-account handle. */
  removeConnection(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The caller's blocks, as dates. */
  blocks(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Lifts one of them. */
  removeBlock(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Renames one connection, for this viewer only. */
  labelConnection(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Reads or changes whether this account appears online. */
  presence(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Which of a set of presence tokens point at somebody online now. */
  presenceLookup(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Ask somebody you met earlier, and who is online, to talk again. */
  reconnectAsk(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Accept such a request. Declining sends nothing and needs no route. */
  reconnectAccept(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** Refuse it and never be reachable by them again. */
  reconnectBlock(req: IncomingMessage, res: ServerResponse): Promise<void>;
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
  const { config, logger, db, oidc, redis, connections, blocks, presence, reconnect } = deps;
  const observer = deps.observer;
  const auth = config.auth;
  const keys = createKeys(config.redis.keyPrefix);

  /**
   * Remember where this account's picture lives, for as long as the session.
   *
   * Best effort in both directions. Redis being unavailable costs an avatar and
   * must never cost a sign-in, which is the same rule `/ready` encodes about
   * PostgreSQL in reverse: a subsystem that is not on the critical path may not
   * be allowed onto it by an error handler.
   */
  /**
   * A stable, per-viewer handle for the other side of a connection.
   *
   * The browser never receives another person's account id. `/auth/session`
   * already refuses to hand over the caller's *own* id — an opaque identifier
   * in a page is one more thing that can be copied into a screenshot or a bug
   * report — and somebody else's is worse by that argument, not better.
   *
   * Salted with the viewer's own id, so the same person appears under a
   * different handle to each of their connections and two people comparing
   * pages cannot discover that they share one. Truncated to 128 bits, which is
   * far past collision concerns for a list this size.
   *
   * It is derived rather than stored: nothing new goes in the database, and a
   * handle is meaningless outside the account it was minted for.
   */
  /**
   * The handle from a small JSON body, or null.
   *
   * Bounded before it is parsed: this route is authenticated, but a body is
   * read into memory before anything about it is known, and "authenticated" is
   * not "trusted with an unbounded upload". The same reasoning as
   * `PAYMENTS_MAX_BODY_BYTES`.
   */
  async function readHandle(req: IncomingMessage, shape = /^[0-9a-f]{32}$/): Promise<string | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.byteLength;
      if (size > 1024) return null;
      chunks.push(buf);
    }

    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof body !== 'object' || body === null) return null;
      const handle = (body as { handle?: unknown }).handle;
      // Exactly the shape this server mints. Anything else is not a handle it
      // could have issued, so there is nothing to look up.
      return typeof handle === 'string' && shape.test(handle) ? handle : null;
    } catch {
      return null;
    }
  }

  /** A small JSON object body, or null. Bounded before parsing, like `readHandle`. */
  async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      size += buf.byteLength;
      if (size > 1024) return null;
      chunks.push(buf);
    }
    try {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** A single-use offer id. Random, not derived: it names one moment. */
  function randomOffer(): string {
    return createHash('sha256')
      .update(`${Date.now()}:${Math.random()}:${Math.random()}`)
      .digest('hex')
      .slice(0, 32);
  }

  function connectionHandle(viewer: string, other: string): string {
    return createHash('sha256').update(`${viewer}:${other}`).digest('hex').slice(0, 32);
  }

  /** Whether there is a cached URL to serve. Any failure answers false. */
  async function avatarUrl(accountId: string): Promise<string | null> {
    if (redis === undefined || !auth.avatars) return null;
    try {
      return await redis.get(keys.avatar(accountId));
    } catch (err) {
      logger.warn('could not read an avatar url', errorFields(err));
      return null;
    }
  }

  async function hasAvatar(accountId: string): Promise<boolean> {
    return (await avatarUrl(accountId)) !== null;
  }

  async function rememberAvatar(accountId: string, url: string | null): Promise<void> {
    if (redis === undefined || !auth.avatars || url === null) return;
    try {
      await redis.set(keys.avatar(accountId), url, 'EX', auth.sessionTtlSeconds);
    } catch (err) {
      logger.warn('could not cache an avatar url', errorFields(err));
    }
  }

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

  /**
   * Where a finished flow sends the browser. Never an error body.
   *
   * Two destinations, because a sign-in can happen in the page or in a popup
   * the page opened, and a popup that lands on the app renders the whole
   * application inside a 480px window and then sits there. `POPUP_DONE_PAGE`
   * is a few hundred bytes that reports the outcome to its opener and closes
   * itself.
   *
   * The mode comes off the flow cookie, which this server wrote — never off
   * the callback's query string. It only decides where this browser lands, so
   * it is not an identity decision, but reading it from the request would let
   * a crafted callback URL choose a different landing page than the one the
   * flow started with, and there is no reason to allow that.
   */
  function home(res: ServerResponse, outcome: 'ok' | 'failed', mode: FlowMode = 'redirect'): void {
    const base = mode === 'popup' ? POPUP_DONE_PAGE : auth.returnUrl;
    const target = new URL(base, 'http://placeholder.invalid');
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
    async start(req: IncomingMessage, res: ServerResponse): Promise<void> {
      observer?.authStarted();
      const flow = oidc.start();
      // Matched against the one accepted value rather than passed through, so
      // the cookie can only ever hold a member of the closed list — the fourth
      // segment is parsed back out below and anything unrecognised is a
      // redirect anyway, but a value is easier to reason about than a parser.
      const started = new URL(req.url ?? '/', 'http://placeholder.invalid');
      const mode: FlowMode = started.searchParams.get('mode') === 'popup' ? 'popup' : 'redirect';
      setCookie(
        res,
        FLOW_COOKIE,
        `${flow.state}.${flow.nonce}.${flow.codeVerifier}.${mode}`,
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

      const [cookieState, nonce, verifier, rawMode] = raw.split('.');
      // A cookie written before this field existed has three segments, so an
      // absent mode is a redirect rather than a broken flow. That matters for
      // exactly one deploy — the one that ships this — during which somebody
      // is mid-sign-in with the old cookie in their browser.
      const mode: FlowMode = rawMode === 'popup' ? 'popup' : 'redirect';
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
        observer?.authCallback('flow_mismatch');
        home(res, 'failed', mode);
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
        observer?.authCallback('token_error');
        home(res, 'failed', mode);
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
        observer?.authCallback('no_account');
        home(res, 'failed', mode);
        return;
      }

      // Before the credential is minted, so a first sign-in that then fails to
      // mint is still counted as the account creation it was — the row exists.
      if (account.created) observer?.accountCreated();

      await rememberAvatar(account.accountId, identity.picture);

    const token = await mintCredential(db, logger, account.accountId, auth.sessionTtlSeconds);
      if (token === null) {
        observer?.authCallback('no_credential');
        home(res, 'failed', mode);
        return;
      }

      setCookie(res, SESSION_COOKIE, token, auth.sessionTtlSeconds);
      observer?.authCallback('ok');
      home(res, 'ok', mode);
    },

    async session(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      // Deliberately no account id in the body. The interface needs to know
      // *whether* somebody is signed in, and an opaque identifier in a page is
      // one more thing that can be copied into a bug report or a screenshot.
      //
      // `avatar` is a boolean for the same reason: it says whether `/auth/avatar`
      // has anything to serve, and never where the image came from. The
      // provider's CDN URL is not something a page should carry.
      if (!resolved.ok) {
        json(res, 200, { signedIn: false, avatar: false });
        return;
      }
      json(res, 200, { signedIn: true, avatar: await hasAvatar(resolved.accountId) });
    },

    async accountForRequest(req: IncomingMessage): Promise<string | null> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      return resolved.ok ? resolved.accountId : null;
    },

    /**
     * Relay the provider's profile image.
     *
     * Authenticated, because the URL is cached against an account and an
     * unauthenticated route would let anybody enumerate accounts by asking for
     * their pictures. It answers 404 for every absence — no session, no cached
     * URL, a fetch that failed — because the interface's only question is
     * whether an image appeared, and distinguishing "you are not signed in"
     * from "there is no picture" here tells a caller something it has no
     * business learning from an image endpoint.
     */
    async avatar(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        res.statusCode = 404;
        res.end();
        return;
      }

      const url = await avatarUrl(resolved.accountId);
      const image = url === null ? null : await fetchAvatar(url, logger);
      if (image === null) {
        // `none` and not `error`, deliberately, and it is the same conflation
        // the 404 makes on purpose: no cached URL and a fetch that failed are
        // indistinguishable to the caller, and a metric that told them apart
        // would be the only place the difference existed.
        observer?.avatarRelayed(url === null ? 'none' : 'error');
        res.statusCode = 404;
        res.end();
        return;
      }
      observer?.avatarRelayed('ok');

      res.statusCode = 200;
      res.setHeader('content-type', image.contentType);
      res.setHeader('content-length', image.body.byteLength);
      // `private`, so no shared cache holds one person's picture, and a day,
      // so the steady state is one upstream fetch per person per day rather
      // than one per page view. `no-transform` because a proxy that
      // recompresses an avatar is a proxy that has read it.
      res.setHeader('cache-control', 'private, max-age=86400, no-transform');
      res.end(image.body);
    },

    /**
     * The caller's saved connections, newest first.
     *
     * Each carries only a handle and a date, because that is all the table
     * holds and all that can be shown honestly. Nothing durable describes
     * another account — the server keeps no profile between sessions (D34) —
     * so a name or a picture here would mean storing one, which is a decision
     * about what people learn about each other rather than a display detail.
     */
    async connections(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }
      if (connections === undefined) {
        json(res, 200, { connections: [] });
        return;
      }

      try {
        const rows = await connections.list(resolved.accountId);
        // One round trip for the whole list rather than a lookup per row.
        const here =
          presence === undefined
            ? new Set<string>()
            : await presence.online(rows.map((row) => row.other));
        json(res, 200, {
          connections: rows.map((row) => ({
            handle: connectionHandle(resolved.accountId, row.other),
            since: row.since.toISOString(),
            // The viewer's own word for them, never the other side's.
            label: row.label,
            // False for somebody who turned presence off, which is
            // indistinguishable from being away — deliberately, since a
            // distinguishable "hidden" would disclose the very thing the
            // setting exists to hide.
            online: here.has(row.other),
          })),
        });
      } catch (err) {
        logger.error('could not list connections', errorFields(err));
        json(res, 500, { error: 'internal_error' });
      }
    },

    /**
     * Remove one connection.
     *
     * The body names a handle, never an account id, so a caller cannot address
     * a pair it is not part of even by guessing — the handle is salted with the
     * caller's own id, and the only way to turn one back into an account is to
     * be the account it was minted for. The server resolves it by re-listing
     * the caller's own connections, which is the same shape as the rule that no
     * console route may accept an identity hash (§25.3).
     *
     * Removal is unilateral and a hard delete: consent to connect is mutual,
     * consent to stay connected is not.
     */
    async removeConnection(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }
      if (connections === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }

      const handle = await readHandle(req);
      if (handle === null) {
        json(res, 400, { error: 'bad_request' });
        return;
      }

      try {
        const rows = await connections.list(resolved.accountId);
        const match = rows.find(
          (row) => connectionHandle(resolved.accountId, row.other) === handle,
        );
        if (match === undefined) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        await connections.remove(resolved.accountId, match.other);
        observer?.connectionRemoved();
        json(res, 200, { removed: true });
      } catch (err) {
        logger.error('could not remove a connection', errorFields(err));
        json(res, 500, { error: 'internal_error' });
      }
    },

    /**
     * The caller's blocks, newest first, as dates and nothing else.
     *
     * The blocked person stays a hash: they may have no account, and resolving
     * one would mean turning a pair of key hashes into an identity, which is
     * the cross-chat correlation §24.3 exists to prevent. You see that you
     * blocked somebody, and when.
     */
    async blocks(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }
      if (blocks === undefined) {
        json(res, 200, { blocks: [] });
        return;
      }
      try {
        const rows = await blocks.list(resolved.accountId);
        json(res, 200, {
          blocks: rows.map((row) => ({ handle: row.handle, since: row.since.toISOString() })),
        });
      } catch (err) {
        logger.error('could not list blocks', errorFields(err));
        json(res, 500, { error: 'internal_error' });
      }
    },

    /**
     * Lift a block.
     *
     * The handle names a moment, not a person, and is resolved against the
     * caller's own rows — so it cannot address somebody else's block even by
     * guessing, the same rule the connection handles follow.
     */
    async removeBlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }
      if (blocks === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }

      const handle = await readHandle(req, /^[0-9]{1,15}$/);
      if (handle === null) {
        json(res, 400, { error: 'bad_request' });
        return;
      }

      try {
        const removed = await blocks.remove(resolved.accountId, handle);
        json(res, removed ? 200 : 404, removed ? { removed: true } : { error: 'not_found' });
      } catch (err) {
        logger.error('could not remove a block', errorFields(err));
        json(res, 500, { error: 'internal_error' });
      }
    },

    /**
     * Rename a connection, for the caller only.
     *
     * The handle names a pair and is resolved against the caller's own rows, so
     * it cannot address somebody else's connection. The label is never sent to
     * the person it names and never leaves this account's view.
     */
    async labelConnection(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }
      if (connections === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }

      const body = await readBody(req);
      const handle = typeof body?.handle === 'string' ? body.handle : '';
      const label = typeof body?.label === 'string' ? body.label : '';
      if (!/^[0-9a-f]{32}$/.test(handle) || label.length > 200) {
        json(res, 400, { error: 'bad_request' });
        return;
      }

      try {
        const rows = await connections.list(resolved.accountId);
        const match = rows.find(
          (row) => connectionHandle(resolved.accountId, row.other) === handle,
        );
        if (match === undefined) {
          json(res, 404, { error: 'not_found' });
          return;
        }
        await connections.setLabel(resolved.accountId, match.other, label);
        json(res, 200, { label: label.trim().slice(0, 40) || null });
      } catch (err) {
        logger.error('could not label a connection', errorFields(err));
        json(res, 500, { error: 'internal_error' });
      }
    },

    /**
     * Read the presence setting, or change it.
     *
     * `GET` answers whether this account currently appears online to its
     * connections; `POST` sets it. Turning it off withdraws immediately rather
     * than waiting out the TTL — somebody asking to stop being visible means
     * now.
     */
    async presence(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      if (!resolved.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }
      if (presence === undefined) {
        json(res, 200, { share: false });
        return;
      }

      try {
        if (req.method === 'GET') {
          json(res, 200, { share: await presence.sharing(resolved.accountId) });
          return;
        }
        const body = await readBody(req);
        if (typeof body?.share !== 'boolean') {
          json(res, 400, { error: 'bad_request' });
          return;
        }
        await presence.setSharing(resolved.accountId, body.share);
        json(res, 200, { share: body.share });
      } catch (err) {
        logger.error('could not read or change presence sharing', errorFields(err));
        json(res, 500, { error: 'internal_error' });
      }
    },

    /**
     * Which of these tokens are online.
     *
     * Deliberately open to signed-out callers. A token is minted only for
     * somebody who chose to share presence, it expires on its own, and it
     * answers exactly one question — so requiring an account here would gate a
     * capability the person was already handed, for no gain. Holding the token
     * *is* the authorisation.
     *
     * Answers only the tokens that are online. An unknown or expired token is
     * indistinguishable from an offline one, which is what stops this being a
     * way to test whether a token was ever real.
     */
    async presenceLookup(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (presence === undefined) {
        json(res, 200, { online: [] });
        return;
      }

      const body = await readBody(req);
      const raw = body?.tokens;
      if (!Array.isArray(raw)) {
        json(res, 400, { error: 'bad_request' });
        return;
      }
      // Bounded and shape-checked. The panel asks about at most fifteen, which
      // is the cap on the list it is drawn from.
      const tokens = raw
        .filter((t): t is string => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t))
        .slice(0, 15);
      if (tokens.length === 0) {
        json(res, 200, { online: [] });
        return;
      }

      try {
        const here = await presence.resolveTokens(tokens);
        json(res, 200, { online: [...here] });
      } catch (err) {
        logger.error('could not resolve presence tokens', errorFields(err));
        json(res, 200, { online: [] });
      }
    },

    /**
     * Ask a past partner to talk again.
     *
     * Both people have to be online — this is the whole design, and it is what
     * makes the feature cost nothing: the request travels down a socket that
     * already exists, so there is no inbox, no polling and no push service. If
     * they are not here, the answer says so and nothing is stored.
     *
     * The offer is minted here and held in Redis for two minutes: long enough
     * to answer a prompt, short enough that an unanswered one is simply gone
     * rather than something to clean up.
     */
    async reconnectAsk(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (presence === undefined || reconnect === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }

      /*
        The asker's own session is resolved from their account, never taken from
        the request. The first version accepted a `from` field, which was both a
        protocol rule 3 violation — routing must never come off a client frame —
        and broken, because the client had nothing sensible to put in it and
        sent a placeholder. A caller who could name the asking session could
        push two strangers into a conversation with each other.

        Being signed in is therefore required. That is not a new constraint in
        substance: a reconnect ends in a connection request, which needs an
        account anyway.
      */
      const me = await resolveAccount(db, logger, credentialOf(req));
      if (!me.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }

      const mySession = await presence.sessionFor(me.accountId);
      if (mySession === null) {
        observer?.reconnectFailed('no_session');
        // No live session for this account — the socket is gone, or the
        // heartbeat has not run yet. Nothing to pair.
        json(res, 200, { asked: false, reason: 'away' });
        return;
      }

      const body = await readBody(req);
      const token = typeof body?.token === 'string' ? body.token : '';
      if (!/^[0-9a-f]{32}$/.test(token)) {
        json(res, 400, { error: 'bad_request' });
        return;
      }

      const theirSession = await presence.sessionForToken(token);
      if (theirSession === null) {
        // One answer for every reason — expired, invented, opted out, away — so
        // this cannot be used to learn anything about a token beyond whether
        // the ask can happen right now.
        json(res, 200, { asked: false, reason: 'away' });
        return;
      }

      const offer = randomOffer();
      try {
        // Holds both sides of the pairing, so accepting needs nothing from the
        // client but the offer itself.
        await redis?.set(
          `${config.redis.keyPrefix}:offer:${offer}`,
          `${mySession}:${theirSession}`,
          'EX',
          120,
        );
      } catch (err) {
        logger.warn('could not record a reconnect offer', errorFields(err));
        json(res, 200, { asked: false, reason: 'away' });
        return;
      }

      const delivered = await reconnect.notify(theirSession, { offer });
      json(res, 200, { asked: delivered, ...(delivered ? {} : { reason: 'away' }) });
    },

    /**
     * Accept, and put both sides into a private lane.
     *
     * The pairing is ordinary matchmaking: both join a queue segment nobody
     * else is in, and `tryMatch` does the rest. Every guard it already applies
     * applies here — a block in either direction still refuses, and a reconnect
     * therefore cannot reach somebody who blocked you, without a line of code
     * saying so.
     *
     * Declining has no route at all. It sends nothing, so a refusal is never
     * disclosed.
     */
    async reconnectAccept(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (reconnect === undefined || redis === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }

      /*
        Receiving a request needs no account — the prompt reaches anybody who is
        still in the conversation they were met in. Taking it does.

        That asymmetry is deliberate. Chatting with a stranger never needs an
        account and never will; chatting with a *chosen* person is the thing an
        account is for, and it is the one direction of contact where being
        reachable again should be a thing somebody opted into. So the prompt
        arrives, says so, and offers the way through.
      */
      const me = await resolveAccount(db, logger, credentialOf(req));
      if (!me.ok) {
        json(res, 401, { error: 'sign_in_required' });
        return;
      }

      const body = await readBody(req);
      const offer = typeof body?.offer === 'string' ? body.offer : '';
      if (!/^[0-9a-f]{32}$/.test(offer)) {
        json(res, 400, { error: 'bad_request' });
        return;
      }

      const key = `${config.redis.keyPrefix}:offer:${offer}`;
      let stored: string | null = null;
      try {
        stored = await redis.get(key);
        // Single use, spent on acceptance: a replayed offer would put somebody
        // back in a private lane long after the moment passed.
        if (stored !== null) await redis.del(key);
      } catch (err) {
        logger.warn('could not redeem a reconnect offer', errorFields(err));
      }
      if (stored === null) {
        observer?.reconnectFailed('expired');
        json(res, 404, { error: 'expired' });
        return;
      }

      const [asker, accepter] = stored.split(':');
      if (asker === undefined || accepter === undefined) {
        observer?.reconnectFailed('error');
        json(res, 404, { error: 'expired' });
        return;
      }

      await reconnect.pair(asker, accepter);
      const startedAt = new Date().toISOString();
      // Both are told, because both have to start looking for the lane to
      // contain two people.
      await Promise.all([
        reconnect.notify(asker, { startedAt }),
        reconnect.notify(accepter, { startedAt }),
      ]);
      observer?.reconnectPaired();
      json(res, 200, { paired: true });
    },

    /**
     * Decline, and make sure they cannot reach you again.
     *
     * A separate route from accepting rather than a flag on it, because the two
     * are opposite in every way that matters: one is an agreement and answers
     * the asker, the other is a refusal and must not. Nothing is sent back
     * here — the asker learns exactly what an ignore tells them, which is
     * nothing, and that is the point. Somebody blocking should not have to
     * announce it to the person they are blocking.
     *
     * Needs no account. Being able to refuse somebody is not a feature to gate
     * behind signing in, and the person doing it may well be the one who never
     * signed in.
     */
    async reconnectBlock(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (reconnect === undefined || redis === undefined) {
        json(res, 404, { error: 'not_found' });
        return;
      }

      const body = await readBody(req);
      const offer = typeof body?.offer === 'string' ? body.offer : '';
      if (!/^[0-9a-f]{32}$/.test(offer)) {
        json(res, 400, { error: 'bad_request' });
        return;
      }

      const key = `${config.redis.keyPrefix}:offer:${offer}`;
      let stored: string | null = null;
      try {
        stored = await redis.get(key);
        // Spent either way. An offer that survived a block would let the same
        // request be answered again by whoever still held it.
        if (stored !== null) await redis.del(key);
      } catch (err) {
        logger.warn('could not redeem a reconnect offer for a block', errorFields(err));
      }
      if (stored === null) {
        // Already answered, or expired. Answered as success: the caller's goal
        // is that this person cannot reach them, and an expired offer cannot.
        json(res, 200, { blocked: false });
        return;
      }

      const [asker, target] = stored.split(':');
      if (asker === undefined || target === undefined) {
        json(res, 200, { blocked: false });
        return;
      }

      json(res, 200, { blocked: await reconnect.block(asker, target) });
    },

    async signout(req: IncomingMessage, res: ServerResponse): Promise<void> {
      // Read before the credential dies, or there is no account to forget for.
      const resolved = await resolveAccount(db, logger, credentialOf(req));
      await revokeCredential(db, logger, credentialOf(req));
      if (resolved.ok && redis !== undefined) {
        // Signing out should not leave a picture of somebody behind on a
        // machine they have just finished using.
        try {
          await redis.del(keys.avatar(resolved.accountId));
        } catch (err) {
          logger.warn('could not clear a cached avatar url', errorFields(err));
        }
      }
      clearCookie(res, SESSION_COOKIE);
      // Always 200. Signing out when not signed in is success — the caller's
      // goal is that this browser holds no working credential, and it does not.
      json(res, 200, { signedIn: false });
    },
  };
}
