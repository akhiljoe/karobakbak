/**
 * The sign-in client.
 *
 * The branches worth testing are all failure branches. A sign-in that works is
 * visible immediately; a sign-in that fails in the wrong direction is not, and
 * the two directions are not equally bad — answering "signed out" when somebody
 * is signed in costs a click, while answering "signed in" when they are not
 * shows account controls that then fail one at a time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  endSession,
  readSession,
  readSigninOutcome,
  signinMessageOutcome,
  withoutSigninOutcome,
} from './auth';

function respondWith(body: unknown, ok = true): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      json: async () => body,
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readSigninOutcome', () => {
  it('reads the two outcomes the callback actually writes', () => {
    expect(readSigninOutcome('?signin=ok')).toBe('ok');
    expect(readSigninOutcome('?signin=failed')).toBe('failed');
  });

  it('is null for anything else, rather than inventing a third outcome', () => {
    // An unrecognised value is not a state to render. It is a value we did not
    // write, which means somebody typed it or something rewrote the URL.
    expect(readSigninOutcome('?signin=maybe')).toBeNull();
    expect(readSigninOutcome('?signin=')).toBeNull();
    expect(readSigninOutcome('?signin=OK')).toBeNull();
    expect(readSigninOutcome('')).toBeNull();
    expect(readSigninOutcome('?other=1')).toBeNull();
  });
});

describe('withoutSigninOutcome', () => {
  it('removes the marker so a refresh does not re-announce the sign-in', () => {
    expect(withoutSigninOutcome('http://x.test/?signin=ok', 'http://x.test')).toBe('/');
  });

  it('keeps every other parameter and the hash', () => {
    // The marker arrives on whatever AUTH_RETURN_URL is, which is not
    // guaranteed to be a bare path — dropping the rest of the query would lose
    // state the application put there.
    expect(withoutSigninOutcome('http://x.test/p?a=1&signin=ok&b=2#frag', 'http://x.test')).toBe(
      '/p?a=1&b=2#frag',
    );
  });

  it('leaves a URL that never had one alone', () => {
    expect(withoutSigninOutcome('http://x.test/p?a=1', 'http://x.test')).toBe('/p?a=1');
  });
});

describe('readSession', () => {
  /** Every failure answers this exact shape. */
  const OUT = { signedIn: false, avatar: false };

  it('is signed in only when the server said exactly true', async () => {
    respondWith({ signedIn: true });
    await expect(readSession()).resolves.toEqual({ signedIn: true, avatar: false });
  });

  it('reports an avatar only when the server said exactly true', async () => {
    /*
     * A boolean, never a URL. The provider's CDN address must not reach the
     * page: an <img> at it would be blocked by `img-src` and would report every
     * visitor to the vendor on every render.
     */
    respondWith({ signedIn: true, avatar: true });
    await expect(readSession()).resolves.toEqual({ signedIn: true, avatar: true });

    for (const value of ['true', 1, {}, 'yes']) {
      respondWith({ signedIn: true, avatar: value });
      await expect(readSession()).resolves.toEqual({ signedIn: true, avatar: false });
    }
  });

  it('is signed out when the server said so', async () => {
    respondWith({ signedIn: false });
    await expect(readSession()).resolves.toEqual(OUT);
  });

  it('refuses a truthy value that is not true', async () => {
    /*
     * The check is `=== true`, and this is why. A loose check would read
     * `"signedIn": "no"` as signed in — a non-empty string is truthy — and the
     * whole account surface hangs off this one boolean. The realistic route to
     * that response is not a malicious server but a proxy or an error page
     * answering 200 with a body shaped like something else.
     */
    for (const value of ['true', 'no', 1, {}, []]) {
      respondWith({ signedIn: value });
      await expect(readSession()).resolves.toEqual(OUT);
    }
  });

  it('is false when the response is not a JSON object at all', async () => {
    // `try_files` serving index.html for /auth/session is exactly this case:
    // a 200 whose body is a page. It must not read as signed in.
    respondWith(null);
    await expect(readSession()).resolves.toEqual(OUT);
    respondWith('signed in');
    await expect(readSession()).resolves.toEqual(OUT);
  });

  it('is false on a refusal and on unreadable JSON', async () => {
    respondWith({ signedIn: true }, false);
    await expect(readSession()).resolves.toEqual(OUT);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('unexpected token');
        },
      }),
    );
    await expect(readSession()).resolves.toEqual(OUT);
  });

  it('is false when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(readSession()).resolves.toEqual(OUT);
  });

  it('sends the cookie', async () => {
    // The credential is an HttpOnly cookie, so a request that does not carry
    // it answers "signed out" for everybody, always — and the symptom is
    // sign-in appearing not to work at all.
    respondWith({ signedIn: true });
    await readSession();
    expect(fetch).toHaveBeenCalledWith(
      '/auth/session',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });
});

describe('endSession', () => {
  it('confirms only what the server confirmed', async () => {
    respondWith({ signedIn: false });
    await expect(endSession()).resolves.toBe(true);
  });

  it('does not confirm a sign-out the server refused', async () => {
    respondWith({}, false);
    await expect(endSession()).resolves.toBe(false);
  });

  it('does not confirm a sign-out that never arrived', async () => {
    /*
     * The one lie this module must not tell. Reporting success here would let
     * the interface show a signed-out header on a shared machine while the
     * credential is still live on the server — the person walks away believing
     * something that is false, which is worse than an error they can act on.
     */
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(endSession()).resolves.toBe(false);
  });

  it('posts, because the route is a POST and a GET would be a 404 read as success', async () => {
    respondWith({ signedIn: false });
    await endSession();
    expect(fetch).toHaveBeenCalledWith('/auth/signout', expect.objectContaining({ method: 'POST' }));
  });
});

describe('signinMessageOutcome', () => {
  /*
   * A `message` event can be fired by any page that holds a reference to this
   * window — another tab it opened, an extension, an embedding frame. This is
   * the only place one is turned into something the application acts on, so
   * every field is checked and anything unrecognised is null.
   *
   * What it returns is a hint either way: the caller re-asks /auth/session,
   * because a message is not evidence that a credential exists.
   */
  /*
   * This package's tests run without a DOM — there is no jsdom in the
   * devDependencies and the other ten files never needed one. `window` is
   * stubbed for the three lines that want it rather than pulling in an
   * environment, because the function under test reads exactly one property.
   */
  const origin = 'http://localhost:3001';
  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin } });
  });

  const message = (data: unknown, from = origin): MessageEvent =>
    ({ origin: from, data }) as MessageEvent;

  it('reads an outcome from a message this origin sent', () => {
    expect(signinMessageOutcome(message({ source: 'karobakbak-signin', outcome: 'ok' }))).toBe('ok');
    expect(signinMessageOutcome(message({ source: 'karobakbak-signin', outcome: 'failed' }))).toBe(
      'failed',
    );
  });

  it('ignores a message from another origin', () => {
    expect(
      signinMessageOutcome(
        message({ source: 'karobakbak-signin', outcome: 'ok' }, 'https://evil.example'),
      ),
    ).toBeNull();
  });

  it('ignores anything without the marker, or with an outcome we did not write', () => {
    expect(signinMessageOutcome(message({ outcome: 'ok' }))).toBeNull();
    expect(signinMessageOutcome(message({ source: 'something-else', outcome: 'ok' }))).toBeNull();
    expect(signinMessageOutcome(message({ source: 'karobakbak-signin', outcome: 'yes' }))).toBeNull();
    expect(signinMessageOutcome(message({ source: 'karobakbak-signin' }))).toBeNull();
  });

  it('ignores a message that is not an object at all', () => {
    expect(signinMessageOutcome(message('ok'))).toBeNull();
    expect(signinMessageOutcome(message(null))).toBeNull();
    expect(signinMessageOutcome(message(undefined))).toBeNull();
  });
});
