/**
 * The avatar fetch.
 *
 * This is the only place in the backend that takes a URL from outside and makes
 * a request to it. The token carrying that URL is signed and verified, so this
 * is not attacker-controlled in the ordinary sense — but "a URL we were handed,
 * which we then fetch" is the shape of every server-side request forgery, and a
 * misconfigured or compromised IdP is exactly the case these tests exist for.
 *
 * Every refusal below is a network request that must not happen, so each one
 * asserts that `fetch` was never reached rather than only that the answer was
 * null. A guard that returns null *after* making the request has not guarded
 * anything.
 */
import { describe, expect, it, jest } from '@jest/globals';

import { fetchAvatar, isAllowedImageHost } from '../../src/accounts/avatar';
import { createLogger } from '../../src/logger';

const logger = createLogger({ level: 'error' });

/** A fetch that answers one image, and records whether it was called. */
function stubImage(
  bytes: Uint8Array,
  contentType = 'image/png',
  status = 200,
): jest.Mock<typeof fetch> {
  return jest.fn(async () =>
    Promise.resolve(
      new Response(status === 200 ? bytes : null, {
        status,
        headers: { 'content-type': contentType },
      }),
    ),
  ) as unknown as jest.Mock<typeof fetch>;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const OK_URL = 'https://lh3.googleusercontent.com/a/abc=s96-c';

describe('isAllowedImageHost', () => {
  it('matches a provider CDN and its subdomains', () => {
    expect(isAllowedImageHost('lh3.googleusercontent.com')).toBe(true);
    expect(isAllowedImageHost('LH3.GoogleUserContent.com')).toBe(true);
  });

  it('does not match a host that merely ends with the same letters', () => {
    /*
     * The reason the allowlist carries a leading dot. `evil-googleusercontent.com`
     * is a domain anybody can register, and a naive `endsWith('googleusercontent.com')`
     * would treat it as the provider's CDN.
     */
    expect(isAllowedImageHost('evil-googleusercontent.com')).toBe(false);
    expect(isAllowedImageHost('googleusercontent.com.attacker.test')).toBe(false);
    expect(isAllowedImageHost('example.com')).toBe(false);
  });
});

/**
 * The limits the route passes in production, as `config.ts` defaults them.
 * Stated here rather than imported so a change to the default is visible as a
 * diff in this file, where the ceiling is what is being tested.
 */
const LIMITS = { maxBytes: 128 * 1024, timeoutMs: 4000 };

describe('fetchAvatar', () => {
  it('returns the image and its type', async () => {
    const fetcher = stubImage(PNG);
    const image = await fetchAvatar(OK_URL, logger, LIMITS, fetcher);

    expect(image).not.toBeNull();
    expect(image?.contentType).toBe('image/png');
    expect(image?.body.byteLength).toBe(PNG.byteLength);
  });

  it('refuses to follow redirects', async () => {
    // An allowlisted host that answers 302 to somewhere else would otherwise
    // walk straight past the allowlist, which is the whole point of having one.
    const fetcher = stubImage(PNG);
    await fetchAvatar(OK_URL, logger, LIMITS, fetcher);

    const options = (fetcher.mock.calls[0] as unknown[])[1] as RequestInit;
    expect(options.redirect).toBe('error');
  });

  it.each([
    ['a host that is not allowlisted', 'https://attacker.test/a.png'],
    ['a lookalike host', 'https://evil-googleusercontent.com/a.png'],
    ['plain http', 'http://lh3.googleusercontent.com/a.png'],
    ['link-local metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['a private address', 'https://192.168.0.1/a.png'],
    ['a non-URL', 'not a url at all'],
    ['a file URL', 'file:///etc/passwd'],
  ])('makes no request at all for %s', async (_name, url) => {
    const fetcher = stubImage(PNG);
    await expect(fetchAvatar(url, logger, LIMITS, fetcher)).resolves.toBeNull();
    // The assertion that matters. Answering null after making the request
    // would mean the metadata endpoint had already been contacted.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('refuses a body that is not a declared image type', async () => {
    // A CDN answering HTML is a CDN answering an error page, and relaying it
    // from this origin would serve somebody else's markup as our content.
    const fetcher = stubImage(PNG, 'text/html');
    await expect(fetchAvatar(OK_URL, logger, LIMITS, fetcher)).resolves.toBeNull();
  });

  it('refuses an empty body and a body over the ceiling', async () => {
    await expect(fetchAvatar(OK_URL, logger, LIMITS, stubImage(new Uint8Array(0)))).resolves.toBeNull();

    // Checked on what arrived rather than on `Content-Length`, which the sender
    // writes and can lie about.
    const huge = new Uint8Array(200 * 1024);
    await expect(fetchAvatar(OK_URL, logger, LIMITS, stubImage(huge))).resolves.toBeNull();
  });

  it('refuses a non-200', async () => {
    await expect(fetchAvatar(OK_URL, logger, LIMITS, stubImage(PNG, 'image/png', 404))).resolves.toBeNull();
  });

  it('answers null when the request throws', async () => {
    // Timeout, abort, refused redirect, DNS, TLS — all the same to the caller,
    // and none of them may cost somebody their sign-in.
    const fetcher = jest.fn(async () =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as jest.Mock<typeof fetch>;
    await expect(fetchAvatar(OK_URL, logger, LIMITS, fetcher)).resolves.toBeNull();
  });
});
