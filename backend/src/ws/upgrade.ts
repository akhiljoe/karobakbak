/**
 * Everything the upgrade handler has to decide *about the request*, as pure
 * functions.
 *
 * These are the security-relevant reads of untrusted input on the HTTP side —
 * the client's address, its origin, its block token — so they are separated
 * from the plumbing and tested directly.
 */
import type { IncomingMessage } from 'node:http';

import type { Config } from '../config';
import { newClientToken } from '../util/ids';

/** The cookie carrying the block token. */
export const CLIENT_TOKEN_COOKIE = 'kbb_ct';

/**
 * Resolve the client's address.
 *
 * With no trusted proxy the peer address *is* the client. With N trusted
 * proxies the address is taken from `X-Forwarded-For` **counting from the
 * right**: each proxy appends the address it saw, so the rightmost N entries
 * were written by our own infrastructure and everything left of them is
 * whatever the client chose to send.
 *
 * Reading the leftmost entry — the usual shortcut — hands every client a free
 * choice of rate-limit bucket and a way to shed its blocks by setting a header.
 * A header too short for the configured hop count is treated as absent rather
 * than as partially trustworthy.
 */
export function clientAddress(req: IncomingMessage, trustProxyHops: number): string {
  const peer = req.socket.remoteAddress ?? '';
  if (trustProxyHops <= 0) return peer;

  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header.join(',') : (header ?? '');
  const chain = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (chain.length < trustProxyHops) return peer;
  return chain[chain.length - trustProxyHops] ?? peer;
}

/**
 * Whether the browser Origin is allowed to open a socket.
 *
 * An empty allowlist means "any origin", which `loadConfig` already refuses
 * under `NODE_ENV=production` (R9). A request with no Origin at all is allowed:
 * that is a non-browser client, which has no cross-site request forgery story
 * to worry about — the header exists to stop *another site's page* opening a
 * socket in a user's browser, not to authenticate anyone.
 */
export function isOriginAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return true;
  if (origin === undefined || origin === '') return true;
  return allowed.includes(origin);
}

/**
 * Read one cookie value. Deliberately minimal: this parses exactly the shape a
 * browser sends, and anything it does not understand becomes "no cookie",
 * which costs the client a fresh token rather than an error.
 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * A client token is server-generated and opaque. A value that does not look
 * like one is discarded rather than hashed, so a client cannot pick a token
 * that collides with somebody else's block key.
 */
const CLIENT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export interface ClientTokenResult {
  token: string;
  /** True when a fresh token was minted and has to be sent back. */
  issued: boolean;
}

/**
 * Take the client's block token from its cookie, or mint one.
 *
 * The token lives in an HttpOnly cookie rather than in `localStorage` and a
 * query parameter. A query parameter would put a stable pseudonymous
 * identifier into every proxy access log; `localStorage` would put it where
 * page script can read it. Neither is justified for a value whose only job is
 * to be hashed into a block dimension.
 *
 * It is **not** a credential and authorises nothing (R14). A client that drops
 * the cookie simply gets a new one, which costs it nothing and costs the block
 * dimension its precision — which is why the IP dimension exists alongside it.
 */
export function resolveClientToken(req: IncomingMessage): ClientTokenResult {
  const existing = readCookie(req.headers.cookie, CLIENT_TOKEN_COOKIE);
  if (existing !== null && CLIENT_TOKEN_PATTERN.test(existing)) {
    return { token: existing, issued: false };
  }
  return { token: newClientToken(), issued: true };
}

/**
 * The `Set-Cookie` for a freshly minted token.
 *
 * `Secure` only in production: the development stack is plain HTTP on
 * localhost, and a Secure cookie there is silently dropped, which would mint a
 * new token on every connection and make blocking untestable locally.
 */
export function clientTokenCookie(token: string, config: Config): string {
  const attributes = [
    `${CLIENT_TOKEN_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${config.blocks.ttlSeconds}`,
  ];
  if (config.isProduction) attributes.push('Secure');
  return attributes.join('; ');
}
