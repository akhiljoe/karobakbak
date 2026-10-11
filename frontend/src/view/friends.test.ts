import { describe, expect, it } from 'vitest';

import type { Connection } from '../connections';
import { describeLastActive, onlineCount, sortFriends, statusLine } from './friends';

function friend(handle: string, over: Partial<Connection> = {}): Connection {
  return {
    handle,
    since: '2026-10-01T10:00:00.000Z',
    label: null,
    online: false,
    lastActive: null,
    ...over,
  };
}

describe('describeLastActive', () => {
  it('says "within the last hour" for a zero-hour bucket', () => {
    expect(describeLastActive({ unit: 'hour', count: 0 })).toBe('Active within the last hour');
  });

  it('pluralises every unit, and only above one', () => {
    expect(describeLastActive({ unit: 'hour', count: 1 })).toBe('Active 1 hour ago');
    expect(describeLastActive({ unit: 'hour', count: 3 })).toBe('Active 3 hours ago');
    expect(describeLastActive({ unit: 'day', count: 2 })).toBe('Active 2 days ago');
    expect(describeLastActive({ unit: 'week', count: 1 })).toBe('Active 1 week ago');
    expect(describeLastActive({ unit: 'month', count: 4 })).toBe('Active 4 months ago');
    expect(describeLastActive({ unit: 'year', count: 1 })).toBe('Active 1 year ago');
  });
});

describe('statusLine', () => {
  it('prefers Online over anything the server remembered', () => {
    expect(statusLine(friend('a', { online: true, lastActive: { unit: 'day', count: 2 } }))).toBe('Online');
  });

  it('falls back to the friendship date when there is no last-active', () => {
    // Hidden, never seen and not-shown-to-you all arrive as null and must read
    // the same, or hiding would be visible.
    expect(statusLine(friend('a'))).toMatch(/^Friends since /);
  });
});

describe('sortFriends', () => {
  it('puts online first, then the most recently active, then the unknown', () => {
    const sorted = sortFriends([
      friend('never'),
      friend('week', { lastActive: { unit: 'week', count: 1 } }),
      friend('online', { online: true }),
      friend('hours', { lastActive: { unit: 'hour', count: 5 } }),
      friend('days', { lastActive: { unit: 'day', count: 3 } }),
    ]);
    expect(sorted.map((c) => c.handle)).toEqual(['online', 'hours', 'days', 'week', 'never']);
  });

  it("keeps the server's newest-first order where it knows nothing else", () => {
    const sorted = sortFriends([friend('first'), friend('second'), friend('third')]);
    expect(sorted.map((c) => c.handle)).toEqual(['first', 'second', 'third']);
  });
});

describe('onlineCount', () => {
  it('counts the online ones, and nothing before the list has loaded', () => {
    expect(onlineCount(null)).toBe(0);
    expect(onlineCount([friend('a', { online: true }), friend('b'), friend('c', { online: true })])).toBe(2);
  });
});
