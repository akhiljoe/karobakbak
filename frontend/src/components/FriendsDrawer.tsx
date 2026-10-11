/**
 * Friends — the people you and somebody else both chose to keep, in a drawer.
 *
 * Opened from the header, so it is reachable from every screen. It used to be
 * a popover above the composer, visible only while chatting or searching, which
 * meant the list was missing from the landing screen — the one place somebody
 * would go looking for a friend before deciding what to do.
 *
 * ---------------------------------------------------------------------------
 * LEFT, BECAUSE THE OPERATOR ASKED FOR LEFT
 * ---------------------------------------------------------------------------
 * The button that opens it is on the right. `SiteNav` argues that a panel
 * should appear on the side of the control that opened it, and that argument
 * still holds; this was a product decision made knowing it. If the drawer ever
 * feels disconnected from its button, that comment is why.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW MAY SAY
 * ---------------------------------------------------------------------------
 * Your own name for them, whether they are here, and roughly when they last
 * were (D65). Nothing durable describes another account (D34, §24.3), so there
 * is no picture and no name of theirs — only yours. A friend who hides, one
 * never seen, and every friend while *you* hide all fall back to the date you
 * became friends, so the three cannot be told apart.
 *
 * ---------------------------------------------------------------------------
 * REMOVING IS UNILATERAL, AND NOW IT IS CONFIRMED
 * ---------------------------------------------------------------------------
 * Consent to connect is mutual; consent to *stay* connected is not, so removal
 * never asks the other side. It does ask *you*, once, in the row itself — the
 * operator's call: the old bare icon was unclear, and one mistaken tap cost a
 * friendship that only another chance meeting could restore. The confirmation
 * is inline rather than a dialog, so it is one extra tap and never a detour.
 * Block, which is a safety control, is still unconfirmed, and must stay so.
 *
 * Rename and Remove live behind a labelled "⋯" menu rather than as two bare
 * icons, which is what made the old Remove unclear: a person-minus glyph beside
 * a pencil reads as decoration until somebody presses it.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, MessageCircle, MoreHorizontal, Pencil, UserMinus, Users, X } from 'lucide-react';

import type { FriendAskResult, FriendList } from '../connections';
import { sortFriends, statusLine } from '../view/friends';

interface FriendsDrawerProps {
  open: boolean;
  list: FriendList | null;
  failed: boolean;
  onClose(): void;
  onRemove(handle: string): Promise<boolean>;
  onRename(handle: string, label: string): Promise<void>;
  onAsk(handle: string): Promise<FriendAskResult>;
}

/** What a row's Chat button says after it was pressed. */
const ASK_LABEL: Record<FriendAskResult, string> = {
  asked: 'Asked',
  away: 'Not available',
  wait: 'Asked recently',
  failed: 'Try again',
};

export function FriendsDrawer({
  open,
  list,
  failed,
  onClose,
  onRemove,
  onRename,
  onAsk,
}: FriendsDrawerProps): JSX.Element | null {
  const [removing, setRemoving] = useState<string | null>(null);
  /** The row whose ⋯ menu is open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The row asking "remove this friend?". */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** The row whose removal the server refused, so it can say so. */
  const [removeFailed, setRemoveFailed] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [asked, setAsked] = useState<Record<string, FriendAskResult>>({});

  useEffect(() => {
    if (!open) {
      // A fresh drawer each time: "Asked" from ten minutes ago is not news.
      setAsked({});
      setEditing(null);
      setMenuFor(null);
      setConfirming(null);
      setRemoveFailed(null);
      return;
    }
    // Escape backs out one layer at a time: a menu or a confirmation first,
    // then the drawer. Closing the whole drawer to cancel a question is not
    // what anybody pressing Escape on that question meant.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      if (menuFor !== null) setMenuFor(null);
      else if (confirming !== null) setConfirming(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose, menuFor, confirming]);

  // A menu closes on any press outside it, like every other menu here.
  useEffect(() => {
    if (menuFor === null) return;
    const onPointer = (event: PointerEvent): void => {
      const target = event.target as Element | null;
      if (target?.closest('[data-friend-menu]') === null) setMenuFor(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [menuFor]);

  if (!open) return null;

  const rows = list === null ? null : sortFriends(list.connections);
  const online = rows === null ? 0 : rows.filter((c) => c.online).length;

  const remove = (handle: string): void => {
    setRemoving(handle);
    setRemoveFailed(null);
    void onRemove(handle)
      .then((done) => {
        // On success the row is gone; on failure it stays, saying so, rather
        // than closing the question as if it had worked.
        if (done) setConfirming(null);
        else setRemoveFailed(handle);
      })
      .finally(() => setRemoving(null));
  };

  const ask = (handle: string): void => {
    setAsked((was) => ({ ...was, [handle]: 'asked' }));
    void onAsk(handle).then((result) => setAsked((was) => ({ ...was, [handle]: result })));
  };

  /*
    A portal, for the reason `SiteNav` gives at length: the header's
    backdrop-filter makes it the containing block for anything `fixed` inside
    it, so a drawer rendered in place would be clipped to a 56px strip.
  */
  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Friends">
      <button
        type="button"
        aria-label="Close friends"
        onClick={onClose}
        onPointerDown={onClose}
        className="absolute inset-0 h-full w-full animate-fade-in cursor-default bg-ink-950/70 backdrop-blur-sm"
      />

      <aside className="safe-pt absolute inset-y-0 left-0 flex w-[min(20rem,calc(100vw_-_3rem))] animate-slide-in-left flex-col border-r border-ink-700 bg-ink-900 shadow-lift">
        <div className="flex items-center justify-between gap-2 border-b border-ink-800 px-4 py-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-100">
            <Users className="h-4 w-4 text-ink-400" aria-hidden="true" />
            Friends
            {rows !== null && rows.length > 0 && (
              <span className="text-ink-500">
                — {online > 0 ? `${online} online` : rows.length}
              </span>
            )}
          </span>
          <button
            onClick={onClose}
            aria-label="Close friends"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {failed ? (
            // Distinct from "you have none". Those are different statements and
            // only one of them would be a lie.
            <p className="px-4 py-5 text-sm leading-relaxed text-ink-400">
              We could not load your friends. Try again in a moment.
            </p>
          ) : rows === null ? (
            <p className="px-4 py-5 text-sm text-ink-500">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="px-4 py-5 text-sm leading-relaxed text-ink-500">
              None yet. When you and a stranger both save each other during a chat, they appear here.
            </p>
          ) : (
            <ul className="py-1">
              {rows.map((connection) => (
                <li key={connection.handle} className="px-2">
                  {confirming === connection.handle ? (
                    /*
                      The confirmation takes the row's place, so what is being
                      removed is the thing on screen and nothing else. Remove is
                      on the right, where the ⋯ was, and Cancel is the left —
                      so a second tap in the same spot is the deliberate one.
                    */
                    <div className="my-1 rounded-lg border border-rose-500/30 bg-rose-500/5 px-3 py-2.5">
                      <p className="text-sm text-ink-100">
                        Remove {connection.label ?? 'this friend'}?
                      </p>
                      <p className="mt-0.5 text-xs leading-relaxed text-ink-400">
                        They won't be told. To be friends again you would both have to save each
                        other in a chat.
                      </p>
                      {removeFailed === connection.handle && (
                        <p className="mt-1 text-xs text-amber-300">Could not remove — try again.</p>
                      )}
                      <div className="mt-2 flex justify-end gap-2">
                        <button
                          autoFocus
                          onClick={() => {
                            setConfirming(null);
                            setRemoveFailed(null);
                          }}
                          className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-200 transition-colors hover:bg-ink-800"
                        >
                          Cancel
                        </button>
                        <button
                          onClick={() => remove(connection.handle)}
                          disabled={removing === connection.handle}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/50 bg-rose-500/10 px-3 py-1.5 text-xs font-medium text-rose-200 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
                        >
                          <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                          {removing === connection.handle ? 'Removing…' : 'Remove friend'}
                        </button>
                      </div>
                    </div>
                  ) : (
                  <div className="relative flex items-center gap-2 rounded-lg px-2 py-2.5">
                    {/*
                      Online, or not. There is no third state: somebody who
                      turned presence off looks exactly like somebody away.
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
                          // Escape abandons rather than saving a half-typed
                          // name — and stops here, so it does not also close
                          // the drawer.
                          if (event.key === 'Escape') {
                            event.stopPropagation();
                            setEditing(null);
                          }
                        }}
                        onBlur={() => setEditing(null)}
                        className="min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-950 px-2 py-1 text-sm text-ink-100 focus:border-amber-400 focus:outline-none"
                      />
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-ink-200">
                          {connection.label ?? 'Friend'}
                        </p>
                        <p
                          className={`truncate text-xs ${
                            connection.online ? 'text-green-300' : 'text-ink-500'
                          }`}
                        >
                          {statusLine(connection)}
                        </p>
                      </div>
                    )}

                    {/*
                      Chat, only for somebody here. It sends them a prompt they
                      can take, ignore or block; ignoring tells you nothing.
                    */}
                    {connection.online && editing !== connection.handle && (
                      <button
                        onClick={() => ask(connection.handle)}
                        disabled={asked[connection.handle] !== undefined && asked[connection.handle] !== 'failed'}
                        className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-green-500/40 px-2 py-1 text-xs font-medium text-green-300 transition-colors hover:bg-green-500/10 disabled:border-ink-700 disabled:text-ink-400 disabled:hover:bg-transparent"
                      >
                        <MessageCircle className="h-3.5 w-3.5" aria-hidden="true" />
                        {asked[connection.handle] === undefined ? 'Chat' : ASK_LABEL[asked[connection.handle]!]}
                      </button>
                    )}

                    {editing === connection.handle ? (
                      <button
                        onMouseDown={(event) => {
                          // `onMouseDown`, because the input's `onBlur` fires
                          // first on a click and would close the editor.
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
                      <div data-friend-menu className="relative">
                        <button
                          onClick={() =>
                            setMenuFor((was) => (was === connection.handle ? null : connection.handle))
                          }
                          aria-haspopup="menu"
                          aria-expanded={menuFor === connection.handle}
                          aria-label={`Options for ${connection.label ?? 'this friend'}`}
                          className={`rounded-lg p-1.5 transition-colors hover:bg-ink-800 hover:text-ink-100 ${
                            menuFor === connection.handle ? 'bg-ink-800 text-ink-100' : 'text-ink-400'
                          }`}
                        >
                          <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                        </button>
                        {menuFor === connection.handle && (
                          <div
                            role="menu"
                            className="absolute right-0 top-full z-10 mt-1 w-44 animate-fade-in rounded-xl border border-ink-700 bg-ink-950 p-1 shadow-lift"
                          >
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMenuFor(null);
                                setEditing(connection.handle);
                                setDraft(connection.label ?? '');
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50"
                            >
                              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                              Rename
                            </button>
                            <button
                              role="menuitem"
                              onClick={() => {
                                setMenuFor(null);
                                setRemoveFailed(null);
                                setConfirming(connection.handle);
                              }}
                              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
                            >
                              <UserMinus className="h-3.5 w-3.5" aria-hidden="true" />
                              Remove friend
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Padding on an inner box: `safe-pb` sets its own horizontal padding and would override it. */}
        <div className="safe-pb border-t border-ink-800">
          <div className="px-4 py-3 text-xs leading-relaxed text-ink-500">
            {list !== null && !list.sharing && (
              // Said, rather than left to look broken: the mutual rule (D65).
              <p className="mb-2 text-amber-300/90">
                You appear offline, so you can't see when friends were last active.
              </p>
            )}
            <p>Names are yours alone — they never see them. Removing a friend does not tell them.</p>
          </div>
        </div>
      </aside>
    </div>,
    document.body,
  );
}
