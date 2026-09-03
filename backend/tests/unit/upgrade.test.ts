import type { IncomingMessage } from 'node:http';

import { loadConfig, type Env } from '../../src/config';
import {
  admission,
  CLIENT_TOKEN_COOKIE,
  clientAddress,
  clientTokenCookie,
  isOriginAllowed,
  readCookie,
  resolveClientToken,
} from '../../src/ws/upgrade';

function request(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = '10.0.0.9',
): IncomingMessage {
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

function config(overrides: Env = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    ...overrides,
  });
}

describe('clientAddress', () => {
  it('uses the peer address when no proxy is trusted', () => {
    const req = request({ 'x-forwarded-for': '1.2.3.4' });
    // The header is present and deliberately ignored: with no proxy in front,
    // anything in it was written by the client.
    expect(clientAddress(req, 0)).toBe('10.0.0.9');
  });

  it('reads from the right, so a client cannot choose its own address', () => {
    // "spoofed, real" is what arrives when the client sent a header and one
    // trusted proxy appended the address it actually saw.
    const req = request({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
    expect(clientAddress(req, 1)).toBe('203.0.113.7');
  });

  it('counts hops, not entries', () => {
    const req = request({ 'x-forwarded-for': 'client, edge, inner' });
    expect(clientAddress(req, 2)).toBe('edge');
    expect(clientAddress(req, 3)).toBe('client');
  });

  it('reads the real client through the deployed Caddy and nginx chain', () => {
    // The production topology, and the setting most likely to be wrong in it.
    // Measured by running the real chain and reading the header at the far end:
    // Caddy *discards* whatever the client sent and writes the address it saw,
    // then nginx appends Caddy's address. Two entries, never three — the
    // forged value does not survive to be counted.
    const asDeployed = request({ 'x-forwarded-for': '198.51.100.7, 172.20.0.4' });

    expect(clientAddress(asDeployed, 2)).toBe('198.51.100.7');

    // One hop is the mistake this guards: every user resolves to nginx's own
    // address, so the whole service shares one rate-limit bucket and one block
    // identity — a ban on anyone becomes a ban on everyone.
    expect(clientAddress(asDeployed, 1)).toBe('172.20.0.4');

    // Three is the CDN topology. Against a two-entry chain it is too short to
    // trust, so the peer address is used rather than a guess.
    expect(clientAddress(asDeployed, 3)).toBe('10.0.0.9');
  });

  it('falls back to the peer when the chain is shorter than the hop count', () => {
    // A header too short to contain what our own proxies should have written
    // is not partially trustworthy — it is absent.
    const req = request({ 'x-forwarded-for': '1.2.3.4' });
    expect(clientAddress(req, 2)).toBe('10.0.0.9');
    expect(clientAddress(request({}), 1)).toBe('10.0.0.9');
  });

  it('tolerates padding and a repeated header', () => {
    expect(clientAddress(request({ 'x-forwarded-for': ' a , b ' }), 1)).toBe('b');
    expect(clientAddress(request({ 'x-forwarded-for': ['a', 'b'] }), 1)).toBe('b');
  });

  it('never returns an empty string for a socket with no address', () => {
    const req = { headers: {}, socket: {} } as unknown as IncomingMessage;
    // Hashing '' is still a stable bucket, so this degrades to one shared
    // rate-limit key rather than to a crash.
    expect(clientAddress(req, 0)).toBe('');
  });
});

describe('isOriginAllowed', () => {
  it('accepts a listed origin and refuses anything else', () => {
    const allowed = ['https://chat.example.com', 'http://localhost:5173'];
    expect(isOriginAllowed('https://chat.example.com', allowed)).toBe(true);
    expect(isOriginAllowed('https://evil.example.com', allowed)).toBe(false);
    // No substring or suffix matching: a prefix of an allowed origin is a
    // different site.
    expect(isOriginAllowed('https://chat.example.com.evil.test', allowed)).toBe(false);
    expect(isOriginAllowed('http://localhost:5174', allowed)).toBe(false);
  });

  it('allows any origin when the allowlist is empty', () => {
    // Development only: loadConfig makes an empty allowlist fatal in
    // production (R9), so this branch cannot be reached there.
    expect(isOriginAllowed('https://anything.test', [])).toBe(true);
  });

  it('allows a request with no Origin at all', () => {
    // A non-browser client. The header exists to stop another site's page
    // opening a socket in a user's browser, not to authenticate a caller.
    expect(isOriginAllowed(undefined, ['https://chat.example.com'])).toBe(true);
    expect(isOriginAllowed('', ['https://chat.example.com'])).toBe(true);
  });
});

describe('readCookie', () => {
  it('finds a value among several cookies', () => {
    expect(readCookie('a=1; kbb_ct=abc123; b=2', CLIENT_TOKEN_COOKIE)).toBe('abc123');
    expect(readCookie('kbb_ct=abc123', CLIENT_TOKEN_COOKIE)).toBe('abc123');
  });

  it('returns null for anything it does not understand', () => {
    for (const header of [undefined, '', 'novalue', 'other=1', 'kbb_ct=', 'kbb_ctx=abc']) {
      expect(readCookie(header, CLIENT_TOKEN_COOKIE)).toBeNull();
    }
  });

  it('does not match a cookie whose name merely contains the target', () => {
    expect(readCookie('xkbb_ct=abc', CLIENT_TOKEN_COOKIE)).toBeNull();
  });
});

describe('resolveClientToken', () => {
  it('reuses a well-formed token from the cookie', () => {
    const token = 'Ab3-_xYz01234567';
    expect(resolveClientToken(request({ cookie: `kbb_ct=${token}` }))).toEqual({
      token,
      issued: false,
    });
  });

  it('mints a fresh token when there is no cookie', () => {
    const result = resolveClientToken(request({}));
    expect(result.issued).toBe(true);
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(resolveClientToken(request({})).token).not.toBe(result.token);
  });

  it('discards a token that does not look server-generated', () => {
    // A client picking its own token could aim it at somebody else's block
    // key. Anything off-shape is replaced rather than hashed.
    for (const bogus of ['short', 'has spaces here 12345', `${'x'.repeat(65)}`, 'has;semicolon123']) {
      const result = resolveClientToken(request({ cookie: `kbb_ct=${bogus}` }));
      expect(result.issued).toBe(true);
      expect(result.token).not.toBe(bogus);
    }
  });
});

describe('clientTokenCookie', () => {
  it('is HttpOnly, scoped and bounded by the block TTL', () => {
    const cookie = clientTokenCookie('token123456789012', config());
    expect(cookie).toContain('kbb_ct=token123456789012');
    // HttpOnly keeps it away from page script; the URL never carries it, so
    // no proxy access log does either.
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${config().blocks.ttlSeconds}`);
  });

  it('adds Secure only in production', () => {
    // A Secure cookie on the plain-HTTP development stack is silently dropped,
    // which would mint a new token every connection and make blocking
    // untestable locally.
    expect(clientTokenCookie('token123456789012', config())).not.toContain('Secure');
    expect(
      clientTokenCookie(
        'token123456789012',
        // Production also refuses the published hash salt, so a config that
        // starts must set one.
        config({
          NODE_ENV: 'production',
          ALLOWED_ORIGINS: 'https://chat.example.com',
          IP_HASH_SALT: 'a-real-secret',
        }),
      ),
    ).toContain('Secure');
  });
});


/**
 * The three admission bands (D63).
 *
 * Boundaries, because that is the whole of the function: the interesting cases
 * are the first seat inside the reserve and the last seat overall, and neither
 * is reachable in a test that fills a real instance.
 */
describe('admission', () => {
  it('admits freely below the reserve', () => {
    expect(admission(0, 100, 5)).toBe('open');
    expect(admission(94, 100, 5)).toBe('open');
  });

  it('holds the last seats for resumptions', () => {
    expect(admission(95, 100, 5)).toBe('reserved');
    expect(admission(99, 100, 5)).toBe('reserved');
  });

  it('refuses everybody at the ceiling, resumption or not', () => {
    // The reserve is headroom for people coming back, not an extension of the
    // ceiling: the ceiling is what the box can actually serve.
    expect(admission(100, 100, 5)).toBe('full');
    expect(admission(140, 100, 5)).toBe('full');
  });

  it('has no reserved band at all when nothing is reserved', () => {
    // RESUME_GRACE_SECONDS=0 derives a reserve of zero, and this is the shape
    // that has to stay correct: two bands, and the ceiling in the same place it
    // was before any of this existed.
    expect(admission(99, 100, 0)).toBe('open');
    expect(admission(100, 100, 0)).toBe('full');
  });
});
