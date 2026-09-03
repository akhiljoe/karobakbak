/**
 * Why the socket would not open.
 *
 * ---------------------------------------------------------------------------
 * A BROWSER CANNOT SEE A REFUSED HANDSHAKE
 * ---------------------------------------------------------------------------
 * When the server answers a WebSocket upgrade with 503, page script gets a
 * `close` event with code 1006, no status and no body — byte for byte what it
 * gets when the wifi dies, when the backend is down, and when a proxy drops the
 * connection. The status line exists on the wire and the browser does not hand
 * it over.
 *
 * So the only way to tell those apart is to ask over ordinary HTTP, which is
 * what this does. It is fetched **on failure only** — never polled — so the
 * traffic it adds is bounded by the reconnection backoff that already exists,
 * and it is deliberately cheap on the server: no Redis read, no counting, one
 * word back.
 *
 * `unknown` is a real answer and the common one. If the probe itself cannot get
 * through, the network is the problem, and that is the case the existing
 * "Connection lost" copy already describes correctly.
 */

import { clientConfig } from './config';

/** Where the probe lives. Same origin, so no CORS and no configuration. */
const CAPACITY_URL = '/api/capacity';

export type CapacityState = 'ok' | 'busy' | 'unavailable' | 'unknown';

/**
 * Ask the service why the socket would not open.
 *
 * Every failure answers `unknown` rather than throwing. A probe that rejects
 * would have to be handled at every call site, and the honest meaning of "the
 * request to find out why the network failed also failed" is "we do not know" —
 * which is exactly what the caller does with it.
 */
export async function probeCapacity(): Promise<CapacityState> {
  const controller = new AbortController();
  // Short on purpose, and configurable (`VITE_CAPACITY_PROBE_TIMEOUT_MS`): this
  // runs while somebody is looking at a screen that says the connection
  // dropped, and an answer arriving after the next reconnect has succeeded
  // would explain a failure that is already over.
  const timer = setTimeout(() => controller.abort(), clientConfig.timings.capacityProbeTimeoutMs);
  try {
    const response = await fetch(CAPACITY_URL, {
      method: 'GET',
      // No credentials. Nothing here is about who is asking, and sending the
      // session cookie to an endpoint that does not read it is one more place
      // it can leak.
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return 'unknown';
    const body: unknown = await response.json();
    return readState(body);
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read the one field, strictly.
 *
 * Anything unrecognised is `unknown`, including a state a newer server might
 * add. Guessing at an unknown word would put words on the screen about a
 * condition this build does not understand.
 */
export function readState(body: unknown): CapacityState {
  if (typeof body !== 'object' || body === null) return 'unknown';
  const state = (body as { state?: unknown }).state;
  if (state === 'ok' || state === 'busy' || state === 'unavailable') return state;
  return 'unknown';
}
