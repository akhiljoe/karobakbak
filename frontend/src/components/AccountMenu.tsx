/**
 * The header's account control: a button, and — once signed in — a menu that
 * drops from it.
 *
 * ---------------------------------------------------------------------------
 * WHY SIGNING OUT IS NOT A DIALOG
 * ---------------------------------------------------------------------------
 * It was, and it was wrong. A centred modal with a dimmed backdrop is the right
 * shape for something that interrupts: a decision to make, a document to
 * acknowledge, a flow that leaves the site. Signing out is none of those. It is
 * one action belonging to one control, and a menu anchored under that control
 * says so — it points at where it came from, and dismissing it costs a click
 * anywhere.
 *
 * Signing *in* keeps the dialog, and the asymmetry is deliberate: that one does
 * interrupt, it does leave for another origin, and it carries the Terms.
 *
 * ---------------------------------------------------------------------------
 * THE PHOTO COMES FROM THIS ORIGIN, OR NOT AT ALL
 * ---------------------------------------------------------------------------
 * `/auth/avatar` relays the provider's picture; the provider's own CDN URL
 * never reaches this page. An `<img>` pointed at it would be blocked by
 * `img-src 'self' data:` before it was a policy problem, and it would report
 * every visitor's IP and referring page to the vendor on every render, for a
 * signed-in user, on every page they open.
 *
 * The glyph is not a placeholder waiting to be replaced — it is the answer
 * whenever there is no picture, which is an ordinary state: avatars are off,
 * the provider returned none, the image was too large, the fetch failed, or
 * Redis was restarted and the cached URL went with it. `onError` falls back to
 * it too, so a 404 from our own route degrades to the same shape rather than a
 * broken-image icon.
 */
import { useEffect, useRef, useState } from 'react';
import { LogOut, ShieldOff, User } from 'lucide-react';

import { AVATAR_URL } from '../auth';
import { readBlocks, removeBlock, type Block } from '../connections';
import type { Session } from '../hooks/useSession';

interface AccountMenuProps {
  session: Session;
  /** Opens the sign-in dialog. Only reachable while signed out. */
  onOpenAuth(): void;
}

export function AccountMenu({ session, onOpenAuth }: AccountMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [imageBroken, setImageBroken] = useState(false);
  const [blocks, setBlocks] = useState<readonly Block[] | null>(null);
  const [showBlocks, setShowBlocks] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  /*
    Fetched when the list is opened, not when the menu is. Most people have
    blocked nobody and will never open it, and a request per menu-open would be
    a round trip to render a heading.
  */
  useEffect(() => {
    if (!showBlocks) return;
    let live = true;
    setBlocks(null);
    void readBlocks().then((rows) => {
      if (live) setBlocks(rows ?? []);
    });
    return () => {
      live = false;
    };
  }, [showBlocks]);

  // A menu that closes forgets it was showing the list, so reopening it lands
  // on the menu rather than mid-way into a sub-view.
  useEffect(() => {
    if (!open) setShowBlocks(false);
  }, [open]);
  const container = useRef<HTMLDivElement>(null);

  /*
   * Dismiss on anything that means "not this".
   *
   * `mousedown` rather than `click`: a click that starts inside the menu and
   * ends outside it — a drag over the Sign out label, a text selection — is not
   * a dismissal, and `click` fires on the release, so it would close the menu
   * out from under the press.
   *
   * Both listeners are attached only while the menu is open. A menu that is
   * shut has nothing to dismiss, and a permanently attached document listener
   * is a thing that runs on every click in the application forever.
   */
  useEffect(() => {
    if (!open) return;

    const onPointer = (event: MouseEvent): void => {
      if (container.current !== null && !container.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Signing out elsewhere, or a session that expired, should not leave a menu
  // hanging over a header that no longer has an account behind it.
  useEffect(() => {
    if (!session.signedIn) {
      setOpen(false);
      setFailed(false);
      // So the next sign-in retries the image rather than inheriting a failure
      // that belonged to somebody else's session.
      setImageBroken(false);
    }
  }, [session.signedIn]);

  const signOut = (): void => {
    void session.signOut().then((confirmed) => {
      // Only close on confirmation. Closing regardless would look like the
      // sign-out worked, which is the one thing it must not claim falsely —
      // somebody on a shared machine would walk away from a live credential.
      setFailed(!confirmed);
      if (confirmed) setOpen(false);
    });
  };

  if (!session.signedIn) {
    return (
      <button
        onClick={onOpenAuth}
        aria-label="Sign in"
        className="inline-flex h-9 items-center gap-1 rounded-lg bg-amber-400 px-3 text-sm font-semibold text-ink-950 transition-all hover:bg-amber-300 active:scale-95"
      >
        Sign in
      </button>
    );
  }

  return (
    <div className="relative" ref={container}>
      <button
        onClick={() => setOpen((was) => !was)}
        aria-label="Your account"
        aria-haspopup="menu"
        aria-expanded={open}
        className={`inline-flex h-9 w-9 items-center justify-center overflow-hidden rounded-full border bg-ink-800 transition-all active:scale-95 ${
          open
            ? 'border-amber-400/60 text-amber-300'
            : 'border-ink-700 text-ink-200 hover:border-amber-400/60 hover:text-amber-300'
        }`}
      >
        {/* Decorative either way: the button already carries an accessible name. */}
        {session.avatar && !imageBroken ? (
          <img
            src={AVATAR_URL}
            alt=""
            aria-hidden="true"
            width={36}
            height={36}
            onError={() => setImageBroken(true)}
            className="h-full w-full rounded-full object-cover"
          />
        ) : (
          <User className="h-4 w-4" aria-hidden="true" />
        )}
      </button>

      {open && (
        /*
          Right-aligned to the button rather than left, because the control sits
          at the end of the header and a left-aligned panel would hang off the
          edge of a narrow viewport. `z-40` puts it above the header's own
          `z-30` without reaching the `z-50` the dialogs use.
        */
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-40 mt-2 w-48 animate-fade-in overflow-hidden rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-lift"
        >
          <p className="px-3 pb-1.5 pt-2 text-xs text-ink-500">Signed in</p>

          <button
            role="menuitem"
            onClick={signOut}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            Sign out
          </button>

          {failed && (
            <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-amber-300">
              Still signed in — we could not reach the server.
            </p>
          )}

          {/*
            Blocked people, and the only place they can be lifted.

            It lives behind the account rather than beside Block in the chat,
            because a block is made about somebody in front of you and undone
            later, in the cold light of day, about somebody you can no longer
            see. Signed out there is no list at all — blocks are keyed to an IP
            and a cookie, both of which change, so there is nothing stable to
            ask about. That asymmetry is real and is a reason to sign in.
          */}
          <button
            role="menuitem"
            onClick={() => setShowBlocks((was) => !was)}
            aria-expanded={showBlocks}
            className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50"
          >
            <ShieldOff className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            Blocked people
          </button>

          {showBlocks && (
            <div className="border-t border-ink-800 pt-1">
              {blocks === null ? (
                <p className="px-3 py-2 text-xs text-ink-500">Loading…</p>
              ) : blocks.length === 0 ? (
                <p className="px-3 py-2 text-xs leading-relaxed text-ink-500">
                  You have not blocked anybody. Blocks made while signed out are not listed here.
                </p>
              ) : (
                <ul className="max-h-44 overflow-y-auto">
                  {blocks.map((block) => (
                    <li key={block.handle} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="flex-1 text-xs text-ink-400">
                        Blocked{' '}
                        {new Date(block.since).toLocaleDateString([], {
                          day: 'numeric',
                          month: 'short',
                        })}
                      </span>
                      <button
                        disabled={busy === block.handle}
                        onClick={() => {
                          setBusy(block.handle);
                          void removeBlock(block.handle)
                            .then((done) => {
                              // Only on confirmation, or the row would vanish
                              // while the block still holds.
                              if (done) {
                                setBlocks((was) =>
                                  (was ?? []).filter((b) => b.handle !== block.handle),
                                );
                              }
                            })
                            .finally(() => setBusy(null));
                        }}
                        className="rounded-lg border border-ink-700 px-2 py-0.5 text-[11px] text-ink-300 transition-colors hover:border-amber-400/60 hover:text-amber-300 disabled:opacity-50"
                      >
                        Unblock
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
