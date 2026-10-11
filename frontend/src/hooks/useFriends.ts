/**
 * The friends list, kept fresh enough for a badge and a drawer.
 *
 * ---------------------------------------------------------------------------
 * WHY IT POLLS, AND HOW LITTLE
 * ---------------------------------------------------------------------------
 * The header shows how many friends are online, so the list has to be read
 * while the drawer is closed — there is no push for it, and adding one would
 * mean a presence event per friend per change on the socket, which is the
 * per-user presence stream R13 kept off the wire. One small request a minute
 * is the cost instead: every thirty seconds while the drawer is open, every
 * sixty while it is closed, never while the tab is in the background, and not
 * at all for somebody signed out.
 *
 * A failed read keeps the last good list rather than blanking it. A badge that
 * flickers to nothing on one dropped request is worse than one a minute stale.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  askFriend,
  labelConnection,
  readConnections,
  removeConnection,
  type FriendAskResult,
  type FriendList,
} from '../connections';

const OPEN_INTERVAL_MS = 30_000;
const CLOSED_INTERVAL_MS = 60_000;

export interface Friends {
  /** Null until the first answer arrives. */
  readonly list: FriendList | null;
  /** The last read failed and there is nothing older to show. */
  readonly failed: boolean;
  readonly open: boolean;
  setOpen(open: boolean): void;
  remove(handle: string): Promise<boolean>;
  rename(handle: string, label: string): Promise<void>;
  ask(handle: string): Promise<FriendAskResult>;
}

export function useFriends(enabled: boolean): Friends {
  const [list, setList] = useState<FriendList | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const live = useRef(true);

  const refresh = useCallback(async () => {
    const answer = await readConnections();
    if (!live.current) return;
    // A failure is reported only while there is no older list to show; see
    // the return below.
    setFailed(answer === null);
    if (answer !== null) setList(answer);
  }, []);

  // Signing out empties it at once: a list belongs to an account, and the next
  // person at this browser must not see the last one's friends.
  useEffect(() => {
    if (enabled) return;
    setList(null);
    setFailed(false);
    setOpen(false);
  }, [enabled]);

  useEffect(() => {
    live.current = true;
    if (!enabled) return;

    const tick = (): void => {
      if (document.visibilityState === 'visible') void refresh();
    };
    tick();
    const timer = window.setInterval(tick, open ? OPEN_INTERVAL_MS : CLOSED_INTERVAL_MS);
    // Coming back to the tab reads at once instead of waiting out the interval,
    // so the badge is right at the moment somebody looks at it.
    document.addEventListener('visibilitychange', tick);
    return () => {
      live.current = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [enabled, open, refresh]);

  const remove = useCallback(async (handle: string) => {
    const done = await removeConnection(handle);
    // Only once the server confirmed it, or the drawer would show a friend as
    // gone who is still there.
    if (done) {
      setList((was) =>
        was === null ? was : { ...was, connections: was.connections.filter((c) => c.handle !== handle) },
      );
    }
    return done;
  }, []);

  const rename = useCallback(async (handle: string, label: string) => {
    const saved = await labelConnection(handle, label);
    // Applied only on confirmation, so a failed save leaves the old name on
    // screen rather than a new one that was never stored.
    setList((was) =>
      was === null
        ? was
        : {
            ...was,
            connections: was.connections.map((c) => (c.handle === handle ? { ...c, label: saved } : c)),
          },
    );
  }, []);

  return { list, failed: failed && list === null, open, setOpen, remove, rename, ask: askFriend };
}
