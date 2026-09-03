import { describe, expect, it } from 'vitest';

import { loadClientConfig } from './config';
import { DEFAULT_PREFERENCES, loadPreferences, savePreferences } from './preferences';

/** An in-memory `Storage`, so nothing here depends on a browser. */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => data.get(key) ?? null,
    key: (index: number) => [...data.keys()][index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

/** Storage that throws on every access, as a blocked or private-mode browser does. */
function hostileStorage(): Storage {
  const boom = (): never => {
    throw new Error('storage is not available');
  };
  return {
    get length(): number {
      return boom();
    },
    clear: boom,
    getItem: boom,
    key: boom,
    removeItem: boom,
    setItem: boom,
  };
}

const KEY = 'karobakbak.preferences.v1';

describe('preferences', () => {
  it('defaults conversation starters to off', () => {
    // The product decision, pinned: something that appears uninvited at the top
    // of a new conversation is opt-in.
    expect(DEFAULT_PREFERENCES.icebreakers).toBe(false);
    expect(loadPreferences(fakeStorage()).icebreakers).toBe(false);
  });

  it('round-trips a change', () => {
    const storage = fakeStorage();
    savePreferences({ icebreakers: true, autoSearch: false, notifyOnMatch: true }, storage);
    expect(loadPreferences(storage).icebreakers).toBe(true);
  });

  it('falls back to the defaults rather than throwing', () => {
    // Every one of these is something a real browser can hand back: a value
    // from an older build, a half-written entry, or somebody editing by hand.
    for (const raw of ['', 'not json', 'null', '[]', '"a string"', '{"icebreakers":"yes"}', '{}']) {
      expect(loadPreferences(fakeStorage({ [KEY]: raw }))).toEqual(DEFAULT_PREFERENCES);
    }
  });

  it('survives storage being unavailable entirely', () => {
    // Private windows and blocked site data throw on access. A preference
    // failing to load must never be the reason a conversation cannot happen.
    expect(() => loadPreferences(hostileStorage())).not.toThrow();
    expect(loadPreferences(hostileStorage())).toEqual(DEFAULT_PREFERENCES);
    expect(() => savePreferences({ icebreakers: true, autoSearch: false, notifyOnMatch: true }, hostileStorage())).not.toThrow();
    expect(() => loadPreferences(undefined)).not.toThrow();
  });

  it('stores nothing but the settings', () => {
    // This store must never accumulate conversation state, message content or
    // identifiers — localStorage long outlives the socket, and the product is
    // anonymous.
    const storage = fakeStorage();
    savePreferences({ icebreakers: true, autoSearch: false, notifyOnMatch: true }, storage);
    // An exact list, not a subset check: the point is that a field added here
    // has to be a deliberate act, so that a name, a country or anything else
    // identifying cannot arrive by habit. Those live in `profile.ts`, which is
    // a separate store for exactly this reason.
    expect(Object.keys(JSON.parse(storage.getItem(KEY) ?? '{}')).sort()).toEqual([
      'autoSearch',
      'icebreakers',
      'notifyOnMatch',
    ]);
  });
});

describe('client config', () => {
  it('derives the socket URL from the page when none is configured', () => {
    expect(loadClientConfig({}).wsUrl).toBe('');
    expect(loadClientConfig({ VITE_WS_URL: '' }).wsUrl).toBe('');
    expect(loadClientConfig({ VITE_WS_URL: 'wss://example/ws' }).wsUrl).toBe('wss://example/ws');
  });

  it('turns advertising on for exactly one spelling', () => {
    expect(loadClientConfig({ VITE_ADS_ENABLED: 'true' }).ads.enabled).toBe(true);
    for (const value of ['TRUE', '1', 'yes', '', undefined, true]) {
      expect(loadClientConfig({ VITE_ADS_ENABLED: value }).ads.enabled).toBe(false);
    }
  });

  it('defaults the provider to the one that shows nothing', () => {
    expect(loadClientConfig({}).ads.provider).toBe('noop');
  });

  it('carries timings that used to be scattered through components', () => {
    const { timings } = loadClientConfig({});
    expect(timings.typingIdleMs).toBeGreaterThan(0);
    expect(timings.toastVisibleMs).toBeGreaterThan(0);
    expect(timings.messageGroupingMs).toBeGreaterThan(0);
    expect(timings.reconnectBackoffMs.length).toBeGreaterThan(0);
    // Backoff must actually back off, or a dead server gets hammered.
    const backoff = [...timings.reconnectBackoffMs];
    expect([...backoff].sort((a, b) => a - b)).toEqual(backoff);
  });

  /**
   * The timings are settable at build time (phase 38), and a build-time value
   * is inlined: a bad one cannot be corrected without another build, and a
   * `0` would turn a backoff into a spin and a timeout into an instant
   * failure. Both look like a broken server rather than a bad setting, which
   * is why they fall back rather than being taken literally.
   */
  it('takes the timings from the environment', () => {
    const config = loadClientConfig({
      VITE_TYPING_IDLE_MS: '1500',
      VITE_TOAST_VISIBLE_MS: '9000',
      VITE_RECONNECT_BACKOFF_MS: '100, 200, 400',
      VITE_CAPACITY_PROBE_TIMEOUT_MS: '750',
    });
    expect(config.timings.typingIdleMs).toBe(1500);
    expect(config.timings.toastVisibleMs).toBe(9000);
    expect(config.timings.reconnectBackoffMs).toEqual([100, 200, 400]);
    expect(config.timings.capacityProbeTimeoutMs).toBe(750);
  });

  it('refuses a value that would break the thing it configures', () => {
    const defaults = loadClientConfig({}).timings;
    for (const bad of ['0', '-5', 'soon', '', '  ']) {
      expect(loadClientConfig({ VITE_TYPING_IDLE_MS: bad }).timings.typingIdleMs).toBe(
        defaults.typingIdleMs,
      );
    }
  });

  it('falls back to the whole backoff curve rather than half of one', () => {
    // The shape is the point: the last entry repeats for every attempt after
    // it, so a partially-parsed list is a curve nobody designed.
    const defaults = loadClientConfig({}).timings.reconnectBackoffMs;
    expect(loadClientConfig({ VITE_RECONNECT_BACKOFF_MS: '100,nope,400' }).timings
      .reconnectBackoffMs).toEqual(defaults);
    expect(loadClientConfig({ VITE_RECONNECT_BACKOFF_MS: '100,0,400' }).timings
      .reconnectBackoffMs).toEqual(defaults);
  });
});
