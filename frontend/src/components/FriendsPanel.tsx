/**
 * Saved connections — the people you and somebody else both chose to keep.
 *
 * Sits beside "Recent" above the composer, and for the same reason: it belongs
 * to the conversation surface, where the person it is about is one row away.
 *
 * ---------------------------------------------------------------------------
 * WHY A ROW IS A DATE AND NOTHING ELSE
 * ---------------------------------------------------------------------------
 * Nothing durable describes another account. The server keeps no profile
 * between sessions (D34, §24.3), and the `connections` table is a pair and a
 * timestamp — deliberately, since `010_accounts.sql` names a `conversation_id`
 * on that table as the line to defend in review. So a name or a picture here
 * would mean storing one, which is a decision about what people learn about
 * each other rather than a display choice, and it has not been made.
 *
 * The honest consequence is that this list is thin. It is still worth having:
 * it says how many connections exist, when each was made, and it is the only
 * place they can be removed.
 *
 * ---------------------------------------------------------------------------
 * REMOVING IS UNILATERAL, AND IT IS NOT CONFIRMED
 * ---------------------------------------------------------------------------
 * Consent to connect is mutual; consent to *stay* connected is not. Requiring
 * agreement to leave would mean somebody cannot stop being contactable. There
 * is no "are you sure" dialog for the same reason the block button has none:
 * making it harder to withdraw is not a safety feature.
 */
import { useEffect, useRef, useState } from 'react';
import { UserMinus, Users, X } from 'lucide-react';

import type { Connection } from '../connections';

interface FriendsPanelProps {
  open: boolean;
  /** null while loading, or when the list could not be read at all. */
  connections: readonly Connection[] | null;
  failed: boolean;
  onClose(): void;
  onRemove(handle: string): Promise<boolean>;
}

export function FriendsPanel({
  open,
  connections,
  failed,
  onClose,
  onRemove,
}: FriendsPanelProps): JSX.Element | null {
  const container = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (container.current !== null && !container.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  const remove = (handle: string): void => {
    setRemoving(handle);
    void onRemove(handle).finally(() => setRemoving(null));
  };

  return (
    <div
      ref={container}
      role="dialog"
      aria-label="Saved connections"
      className="absolute bottom-full right-0 z-40 mb-2 w-72 animate-fade-in overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-lift"
    >
      <div className="flex items-center justify-between gap-2 border-b border-ink-800 px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-100">
          <Users className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          Connections
          {connections !== null && connections.length > 0 && (
            <span className="text-ink-500">— {connections.length}</span>
          )}
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-lg p-1 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {failed ? (
        // Distinct from "you have none". Those are different statements and
        // only one of them would be a lie.
        <p className="px-3 py-4 text-sm leading-relaxed text-ink-400">
          We could not load your connections. Try again in a moment.
        </p>
      ) : connections === null ? (
        <p className="px-3 py-4 text-sm text-ink-500">Loading…</p>
      ) : connections.length === 0 ? (
        <p className="px-3 py-4 text-sm leading-relaxed text-ink-500">
          None yet. When you and a stranger both save each other during a chat, they appear here.
        </p>
      ) : (
        <ul className="max-h-72 overflow-y-auto py-1">
          {connections.map((connection) => (
            <li key={connection.handle} className="px-1">
              <div className="flex items-center gap-2 rounded-lg px-2 py-2">
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-ink-200">Connected</p>
                  <p className="text-xs text-ink-500">
                    {new Date(connection.since).toLocaleDateString([], {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                </div>
                <button
                  onClick={() => remove(connection.handle)}
                  disabled={removing === connection.handle}
                  aria-label="Remove this connection"
                  className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-amber-300 disabled:opacity-50"
                >
                  <UserMinus className="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-ink-800 px-3 py-2 text-xs leading-relaxed text-ink-500">
        Removing is immediate and does not ask them.
      </p>
    </div>
  );
}
