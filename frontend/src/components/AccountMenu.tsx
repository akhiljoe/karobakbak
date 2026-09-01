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
 * THE GLYPH IS NOT A PHOTO
 * ---------------------------------------------------------------------------
 * The obvious version shows the provider's profile picture. It costs the
 * `profile` scope back, a stored `picture` on `accounts`, a wider
 * `/auth/session` — which deliberately answers *whether* and never *who* — and
 * either a CSP hole for `lh3.googleusercontent.com` or an image proxy, because
 * an `<img>` pointed at Google reports every visitor to Google on every page
 * view. A shape that says "you are signed in" needs none of it.
 */
import { useEffect, useRef, useState } from 'react';
import { LogOut, User } from 'lucide-react';

import type { Session } from '../hooks/useSession';

interface AccountMenuProps {
  session: Session;
  /** Opens the sign-in dialog. Only reachable while signed out. */
  onOpenAuth(): void;
}

export function AccountMenu({ session, onOpenAuth }: AccountMenuProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
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
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border bg-ink-800 transition-all active:scale-95 ${
          open
            ? 'border-amber-400/60 text-amber-300'
            : 'border-ink-700 text-ink-200 hover:border-amber-400/60 hover:text-amber-300'
        }`}
      >
        {/* Decorative: the button already carries an accessible name. */}
        <User className="h-4 w-4" aria-hidden="true" />
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
        </div>
      )}
    </div>
  );
}
