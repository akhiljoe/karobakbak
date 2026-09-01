/**
 * The session-scoped history.
 *
 * Two things are worth testing and neither is the happy path. The cap, because
 * an uncapped list in `sessionStorage` grows for as long as a tab is open; and
 * the reader's tolerance, because this is storage another script on the origin
 * could have written and a panel must not be the thing that breaks a page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HISTORY_LIMIT,
  clearHistory,
  flagOf,
  readHistory,
  recordHistory,
  type HistoryEntry,
} from './history';

/** A minimal `sessionStorage`, since this package's tests run without a DOM. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    map,
  };
}

function entry(n: number): HistoryEntry {
  return {
    at: n,
    nickname: `Stranger ${n}`,
    name: null,
    colour: '#ffb420',
    country: 'IN',
    presence: null,
  };
}

beforeEach(() => {
  vi.stubGlobal('window', { sessionStorage: fakeStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('recordHistory', () => {
  it('puts the newest first', () => {
    recordHistory(entry(1));
    const list = recordHistory(entry(2));
    expect(list.map((e) => e.at)).toEqual([2, 1]);
  });

  it('never grows past the cap', () => {
    // A tab left open all day would otherwise accumulate one entry per skip,
    // and skipping is the most common thing anybody does here.
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) recordHistory(entry(i));
    expect(readHistory()).toHaveLength(HISTORY_LIMIT);
    // The oldest are the ones dropped.
    expect(readHistory()[0]?.at).toBe(HISTORY_LIMIT + 9);
  });

  it('survives storage refusing to write', () => {
    // Private windows and some enterprise policies throw rather than no-op. The
    // list returned is still right for this render; only its survival is lost.
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
        removeItem: () => undefined,
      },
    });
    expect(recordHistory(entry(1))).toHaveLength(1);
  });
});

describe('readHistory', () => {
  it('is empty when storage throws on read', () => {
    vi.stubGlobal('window', {
      sessionStorage: {
        getItem: () => {
          throw new DOMException('SecurityError');
        },
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    });
    expect(readHistory()).toEqual([]);
  });

  it('ignores anything that is not a well-formed entry', () => {
    /*
     * This is origin storage, not a server response — anything running on the
     * page could have written it. A malformed row that reached the panel would
     * render `undefined` where a nickname should be, so rows are validated
     * individually rather than the array being trusted as a whole.
     */
    vi.stubGlobal('window', {
      sessionStorage: fakeStorage({
        kbb_recent: JSON.stringify([
          entry(1),
          { at: 'soon', nickname: 'x', colour: '#fff', country: null },
          { nickname: 'no timestamp', colour: '#fff', country: null },
          null,
          'a string',
          { at: 2, nickname: 'ok', colour: '#fff', country: null, presence: null },
        ]),
      }),
    });
    expect(readHistory().map((e) => e.nickname)).toEqual(['Stranger 1', 'ok']);
  });

  it('keeps a row written before the declared name was recorded', () => {
    /*
     * `sessionStorage` outlives a reload, so a deploy mid-session leaves rows
     * from the previous build in a tab that is still open. Those rows have no
     * `name`, and dropping them would empty somebody's list for a reason they
     * could not possibly work out. The panel falls back to the nickname, which
     * is what the row held all along.
     */
    vi.stubGlobal('window', {
      sessionStorage: fakeStorage({
        kbb_recent: JSON.stringify([
          { at: 1, nickname: 'Older row', colour: '#fff', country: null, presence: null },
        ]),
      }),
    });
    const [row] = readHistory();
    expect(row?.nickname).toBe('Older row');
    expect(row?.name ?? row?.nickname).toBe('Older row');
  });

  it('keeps the declared name when there is one', () => {
    vi.stubGlobal('window', {
      sessionStorage: fakeStorage({
        kbb_recent: JSON.stringify([{ ...entry(1), name: 'Asha' }]),
      }),
    });
    expect(readHistory()[0]?.name).toBe('Asha');
  });

  it('is empty for storage that is not JSON, or not an array', () => {
    vi.stubGlobal('window', { sessionStorage: fakeStorage({ kbb_recent: 'not json' }) });
    expect(readHistory()).toEqual([]);
    vi.stubGlobal('window', { sessionStorage: fakeStorage({ kbb_recent: '{"a":1}' }) });
    expect(readHistory()).toEqual([]);
  });
});

describe('clearHistory', () => {
  it('empties the list', () => {
    recordHistory(entry(1));
    expect(clearHistory()).toEqual([]);
    expect(readHistory()).toEqual([]);
  });
});

describe('flagOf', () => {
  it('turns a country code into regional indicators', () => {
    expect(flagOf('IN')).toBe('\u{1F1EE}\u{1F1F3}');
    expect(flagOf('in')).toBe('\u{1F1EE}\u{1F1F3}');
  });

  it('is empty for anything that is not two letters', () => {
    // The country on an entry was declared by a stranger and validated as a
    // code, not as a country — so this takes whatever arrives.
    for (const bad of [null, '', 'I', 'IND', '12', 'I1']) {
      expect(flagOf(bad)).toBe('');
    }
  });
});
