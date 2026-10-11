/**
 * How the friends drawer describes the people in it. Pure, and tested.
 *
 * The server decides everything that matters here — who is online, whether a
 * last-active may be shown at all, and how coarse it is (D65). These functions
 * only turn its answer into words and an order.
 */
import type { Connection, LastActive } from '../connections';

/** "3 hours ago", "1 week ago", or "within the last hour". */
export function describeLastActive(lastActive: LastActive): string {
  const { unit, count } = lastActive;
  if (unit === 'hour' && count === 0) return 'Active within the last hour';
  return `Active ${count} ${unit}${count === 1 ? '' : 's'} ago`;
}

/**
 * The second line of a row.
 *
 * Online, then last-active, then when you became friends. The last is the
 * fallback for every friend the server sends no last-active for — hidden, never
 * seen, or not shown to a viewer who hides — and that sameness is the point: the
 * three must read alike, or hiding would be visible.
 */
export function statusLine(connection: Connection): string {
  if (connection.online) return 'Online';
  if (connection.lastActive !== null) return describeLastActive(connection.lastActive);
  return `Friends since ${new Date(connection.since).toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

const UNIT_HOURS: Record<LastActive['unit'], number> = {
  hour: 1,
  day: 24,
  week: 24 * 7,
  month: 24 * 30,
  year: 24 * 365,
};

/** Hours ago a bucket stands for, for ordering only. Unknown sorts last. */
function hoursAgo(connection: Connection): number {
  if (connection.online) return -1;
  if (connection.lastActive === null) return Number.POSITIVE_INFINITY;
  return connection.lastActive.count * UNIT_HOURS[connection.lastActive.unit];
}

/**
 * Online first, then most recently active, then newest friendship.
 *
 * The last tie-break is the server's own order, which is newest first, so a
 * list where nobody shares anything reads exactly as it did before D65.
 */
export function sortFriends(connections: readonly Connection[]): Connection[] {
  return connections
    .map((connection, index) => ({ connection, index }))
    .sort((a, b) => hoursAgo(a.connection) - hoursAgo(b.connection) || a.index - b.index)
    .map(({ connection }) => connection);
}

/** How many are online, for the header badge. */
export function onlineCount(connections: readonly Connection[] | null): number {
  return connections === null ? 0 : connections.filter((c) => c.online).length;
}
