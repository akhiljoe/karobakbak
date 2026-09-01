/**
 * The sign-in client.
 *
 * The branches worth testing are all failure branches. A sign-in that works is
 * visible immediately; a sign-in that fails in the wrong direction is not, and
 * the two directions are not equally bad — answering "signed out" when somebody
 * is signed in costs a click, while answering "signed in" when they are not
 * shows account controls that then fail one at a time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { endSession, readSession, readSigninOutcome, withoutSigninOutcome } from './auth';

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
  it('is true only when the server said exactly true', async () => {
    respondWith({ signedIn: true });
    await expect(readSession()).resolves.toBe(true);
  });

  it('is false when the server said so', async () => {
    respondWith({ signedIn: false });
    await expect(readSession()).resolves.toBe(false);
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
      await expect(readSession()).resolves.toBe(false);
    }
  });

  it('is false when the response is not a JSON object at all', async () => {
    // `try_files` serving index.html for /auth/session is exactly this case:
    // a 200 whose body is a page. It must not read as signed in.
    respondWith(null);
    await expect(readSession()).resolves.toBe(false);
    respondWith('signed in');
    await expect(readSession()).resolves.toBe(false);
  });

  it('is false on a refusal and on unreadable JSON', async () => {
    respondWith({ signedIn: true }, false);
    await expect(readSession()).resolves.toBe(false);

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => {
          throw new SyntaxError('unexpected token');
        },
      }),
    );
    await expect(readSession()).resolves.toBe(false);
  });

  it('is false when the network throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')));
    await expect(readSession()).resolves.toBe(false);
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
