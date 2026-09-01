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
import { Check, Pencil, UserMinus, Users, X } from 'lucide-react';

import type { Connection } from '../connections';

interface FriendsPanelProps {
  open: boolean;
  /** null while loading, or when the list could not be read at all. */
  connections: readonly Connection[] | null;
  failed: boolean;
  onClose(): void;
  onRemove(handle: string): Promise<boolean>;
  /** Rename one, for this viewer only. Empty clears the name. */
  onRename(handle: string, label: string): Promise<void>;
}

export function FriendsPanel({
  open,
  connections,
  failed,
  onClose,
  onRemove,
  onRename,
}: FriendsPanelProps): JSX.Element | null {
  const container = useRef<HTMLDivElement>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

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
      // Same fix as HistoryPanel: this hangs off a link on the left of a row,
      // so `right-0` grew leftwards off a narrow screen. Centred and clamped.
      // Same treatment as HistoryPanel, and the same reason: a panel anchored to
      // a control on a narrow screen hangs off the edge however tightly its
      // width is clamped. Fixed to the viewport on a phone, hung off the button
      // from `sm` upwards.
      className="fixed inset-x-3 bottom-24 z-40 max-h-[60vh] overflow-y-auto animate-fade-in overflow-hidden rounded-xl border border-ink-600 bg-ink-950 shadow-2xl ring-1 ring-black/50 sm:absolute sm:inset-x-auto sm:bottom-full sm:left-1/2 sm:mb-2 sm:w-72 sm:-translate-x-1/2"
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
                {/*
                  Online, or not. There is no third state: somebody who turned
                  presence off looks exactly like somebody who is away, which is
                  the point — a distinguishable "hidden" would disclose the very
                  thing the setting exists to hide.
                */}
                <span
                  aria-hidden="true"
                  className={`h-2 w-2 shrink-0 rounded-full ${
                    connection.online ? 'bg-green-400' : 'bg-ink-700'
                  }`}
                />

                {editing === connection.handle ? (
                  <input
                    autoFocus
                    value={draft}
                    maxLength={40}
                    placeholder="Their name, for you"
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        void onRename(connection.handle, draft);
                        setEditing(null);
                      }
                      // Escape abandons rather than saving a half-typed name,
                      // which is what pressing it means everywhere else.
                      if (event.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                    className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 focus:border-amber-400 focus:outline-none"
                  />
                ) : (
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink-200">
                      {connection.label ?? 'Connected'}
                    </p>
                    <p className="text-xs text-ink-500">
                      {connection.online
                        ? 'Online'
                        : new Date(connection.since).toLocaleDateString([], {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                          })}
                    </p>
                  </div>
                )}

                {editing === connection.handle ? (
                  <button
                    onMouseDown={(event) => {
                      // `onMouseDown`, because the input's `onBlur` fires first
                      // on a click and would close the editor before this ran.
                      event.preventDefault();
                      void onRename(connection.handle, draft);
                      setEditing(null);
                    }}
                    aria-label="Save this name"
                    className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-green-300"
                  >
                    <Check className="h-4 w-4" aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    onClick={() => {
                      setEditing(connection.handle);
                      setDraft(connection.label ?? '');
                    }}
                    aria-label="Rename this connection"
                    className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-amber-300"
                  >
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
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
        Names are yours alone — they never see them. Removing is immediate and does not ask them.
      </p>
    </div>
  );
}
