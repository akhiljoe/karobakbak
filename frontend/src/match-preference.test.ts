/**
 * The stored match preference (D44, §29).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS STRICTER THAN THE PROFILE
 * ---------------------------------------------------------------------------
 * A stored profile field the server would refuse costs that one field. A stored
 * *preference* value the server would refuse fails the **whole join** — the
 * validator refuses rather than trims, deliberately, because a join that
 * silently dropped half a request is indistinguishable from one that honoured
 * it and found nobody.
 *
 * So a value left behind by an older build — a vibe that was renamed, a country
 * code that was retired — would stop somebody searching at all, with an error
 * about a preference they cannot see and did not set today. Filtering on the
 * way out of storage is what prevents that.
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PREFERENCES,
  isEmptyPreferences,
  loadPreferences,
  savePreferences,
} from './profile';

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

const KEY = 'karobakbak.preference.v1';

describe('loadPreferences', () => {
  it('reads nothing as no preference', () => {
    expect(loadPreferences(fakeStorage())).toEqual(EMPTY_PREFERENCES);
  });

  it('round-trips what was saved', () => {
    const storage = fakeStorage();
    savePreferences({ genders: ['female'], countries: ['IN'], vibes: ['chill'] }, storage);
    expect(loadPreferences(storage)).toEqual({
      genders: ['female'],
      countries: ['IN'],
      vibes: ['chill'],
    });
  });

  it('drops a value the server would refuse, keeping the rest', () => {
    // The failure this exists to prevent: one stale value in storage refusing
    // every join, with an error about something the user cannot see.
    const storage = fakeStorage({
      [KEY]: JSON.stringify({
        genders: ['female', 'woman'],
        countries: ['IN', 'ZZ'],
        vibes: ['chill', 'spicy'],
      }),
    });
    expect(loadPreferences(storage)).toEqual({
      genders: ['female'],
      countries: ['IN'],
      vibes: ['chill'],
    });
  });

  it('collapses duplicates and caps a dimension', () => {
    const storage = fakeStorage({
      [KEY]: JSON.stringify({
        genders: ['female', 'female'],
        countries: Array(20).fill('IN'),
        vibes: [],
      }),
    });
    const loaded = loadPreferences(storage);
    expect(loaded.genders).toEqual(['female']);
    // Deduplicated first, so twenty of the same code is one, not eight.
    expect(loaded.countries).toEqual(['IN']);
  });

  it('survives anything that is not the shape it expects', () => {
    for (const raw of ['not json', '[]', 'null', '{"genders":"female"}', '{"vibes":42}']) {
      expect(loadPreferences(fakeStorage({ [KEY]: raw }))).toEqual(EMPTY_PREFERENCES);
    }
  });

  it('returns no preference when storage is unavailable', () => {
    // Private mode, blocked site data. A search must still be possible.
    expect(loadPreferences(hostileStorage())).toEqual(EMPTY_PREFERENCES);
    expect(() => savePreferences({ ...EMPTY_PREFERENCES }, hostileStorage())).not.toThrow();
  });
});

describe('isEmptyPreferences', () => {
  it('is true only when nothing at all is asked for', () => {
    expect(isEmptyPreferences(EMPTY_PREFERENCES)).toBe(true);
    expect(isEmptyPreferences({ genders: [], countries: [], vibes: ['deep'] })).toBe(false);
  });
});
