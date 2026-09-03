/**
 * The capacity probe.
 *
 * Every branch here ends in a word that goes on a screen, and the failure
 * modes matter more than the success: a probe that threw would have to be
 * handled in the close handler of a socket that has just failed, and a probe
 * that guessed would caption a working service with an explanation of a
 * condition it does not have.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeCapacity, readState } from './capacity';

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading the answer', () => {
  it('takes the three states the server can send', () => {
    expect(readState({ state: 'ok' })).toBe('ok');
    expect(readState({ state: 'busy' })).toBe('busy');
    expect(readState({ state: 'unavailable' })).toBe('unavailable');
  });

  it('treats anything it does not recognise as unknown', () => {
    // Including a state a newer server might add. Guessing at an unknown word
    // would put words on a screen about a condition this build does not
    // understand.
    expect(readState({ state: 'overloaded' })).toBe('unknown');
    expect(readState({ state: 42 })).toBe('unknown');
    expect(readState({})).toBe('unknown');
    expect(readState(null)).toBe('unknown');
    expect(readState('busy')).toBe('unknown');
  });
});

describe('probing', () => {
  it('asks this origin, without credentials, and reports what came back', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ state: 'busy' }));
    vi.stubGlobal('fetch', fetchMock);

    expect(await probeCapacity()).toBe('busy');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/capacity');
    // Nothing here is about who is asking, and sending the session cookie to an
    // endpoint that does not read it is one more place it can leak.
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
  });

  it('answers unknown when the request fails outright', async () => {
    // The honest meaning of "the request to find out why the network failed
    // also failed" is "we do not know" — which is what the caller renders.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network');
      }),
    );
    expect(await probeCapacity()).toBe('unknown');
  });

  it('answers unknown on a non-2xx, rather than reading its body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ state: 'ok' }, false)));
    expect(await probeCapacity()).toBe('unknown');
  });

  it('answers unknown when the body is not JSON', async () => {
    // This is what a missing proxy looks like: the SPA answers 200 with
    // index.html, and parsing it fails. Reading that as anything but unknown
    // would report a service state from a page.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          }) as unknown as Response,
      ),
    );
    expect(await probeCapacity()).toBe('unknown');
  });

  it('never throws, whatever happens', async () => {
    // It is called from the close handler of a socket that has just failed, so
    // a rejection here would be an unhandled rejection on every failed connect.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(probeCapacity()).resolves.toBe('unknown');
  });
});
