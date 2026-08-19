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
    savePreferences({ icebreakers: true }, storage);
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
    expect(() => savePreferences({ icebreakers: true }, hostileStorage())).not.toThrow();
    expect(() => loadPreferences(undefined)).not.toThrow();
  });

  it('stores nothing but the settings', () => {
    // This store must never accumulate conversation state, message content or
    // identifiers — localStorage long outlives the socket, and the product is
    // anonymous.
    const storage = fakeStorage();
    savePreferences({ icebreakers: true }, storage);
    expect(Object.keys(JSON.parse(storage.getItem(KEY) ?? '{}'))).toEqual(['icebreakers']);
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
});
