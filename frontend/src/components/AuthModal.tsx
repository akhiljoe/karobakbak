/**
 * The sign-in surface.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS REPLACED, AND WHY IT HAD TO GO
 * ---------------------------------------------------------------------------
 * This was a magic-link email form gated on `ACCOUNTS_ENABLED && PAYMENTS_ENABLED`,
 * whose copy read "Only for premium subscriptions". Both halves were wrong by
 * the time sign-in was built:
 *
 *  * The protocol is OIDC against a hosted provider (§32, D48). There is no
 *    address to collect here and no mail to send — the provider owns the
 *    credential entirely, which is the point of choosing it.
 *  * Signing in is **free** (§31). Coupling it to `PAYMENTS_ENABLED` would have
 *    hidden a free feature behind a paid flag, with nothing in the types to
 *    notice. Premium is the asymmetric matching preferences and nothing else.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO FORM
 * ---------------------------------------------------------------------------
 * One button that leaves. Anything typed here would be a credential this
 * origin had touched, and the reason for an external provider is that it never
 * does. The button navigates; it does not submit, fetch or validate.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT PROMISES IS BOUNDED BY WHAT IS BUILT
 * ---------------------------------------------------------------------------
 * Saved connections and history are what an account gates (§31). The copy says
 * exactly those and does not mention friend requests, which are specified and
 * not yet built — a list of benefits is a claim, and one item of it being
 * aspirational makes the whole list untrustworthy.
 *
 * It closes on Escape and on the backdrop, unlike the age gate, which
 * deliberately does neither. This one is a choice somebody can decline.
 */
import { useEffect, useState } from 'react';
import { LogIn, ShieldCheck, X } from 'lucide-react';

import { SIGNIN_PROVIDER } from '../features';
import type { Session } from '../hooks/useSession';
import { Button } from './Button';
import { GoogleMark } from './GoogleMark';
import { LogoMark } from './Logo';

interface AuthModalProps {
  open: boolean;
  onClose(): void;
  session: Session;
}

export function AuthModal({ open, onClose, session }: AuthModalProps): JSX.Element | null {
  const [leaving, setLeaving] = useState(false);
  const [signOutFailed, setSignOutFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A modal that is reopened after a failed sign-out should not still be
  // showing the failure from last time.
  useEffect(() => {
    if (!open) setSignOutFailed(false);
  }, [open]);

  if (!open) return null;

  const signIn = (): void => {
    // Called straight from the click, with nothing awaited before it: a browser
    // permits `window.open` only while it can attribute the call to a gesture,
    // and one `await` in between is enough to lose that and have the popup
    // blocked.
    setLeaving(true);
    session.signIn();
  };

  // The popup leaves this dialog on screen behind it, so the button has to stop
  // looking pressable once a window is open. It un-sets when the flow finishes,
  // because `signedIn` changing re-renders this and the dialog is closed by the
  // header; if the person abandons the popup, reopening the dialog resets it.
  const busyLabel = leaving ? 'Waiting for the sign-in window…' : null;

  const signOut = (): void => {
    void session.signOut().then((confirmed) => {
      setSignOutFailed(!confirmed);
      if (confirmed) onClose();
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={session.signedIn ? 'Account' : 'Sign in'}
    >
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm animate-fade-in rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl sm:p-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-1 flex items-start justify-between gap-4">
          <div className="flex items-center gap-2.5">
            {/*
              The mark, at the size the header uses. The dialog is the one place
              in the product that sends somebody to a different origin, so it is
              the one place worth restating whose sign-in this is — the next
              thing they see is Google's page, and a person who cannot remember
              what they clicked from is a person who should not be typing a
              password.
            */}
            <LogoMark size={22} />
            <h2 className="font-display text-lg font-semibold text-ink-50">
              {session.signedIn ? 'Your account' : 'Sign in'}
            </h2>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {session.signedIn ? (
          <>
            <p className="mb-4 text-sm leading-relaxed text-ink-400">
              You are signed in. Saved connections and recent conversations are kept on this
              account.
            </p>

            <Button size="lg" className="w-full" onClick={signOut}>
              Sign out
            </Button>

            {signOutFailed && (
              <p className="mt-3 rounded-lg border border-dashed border-amber-400/40 bg-amber-400/5 px-3 py-2.5 text-sm leading-relaxed text-ink-400">
                <span className="font-medium text-amber-300">Still signed in.</span> We could not
                reach the server, so nothing was revoked. Try again.
              </p>
            )}
          </>
        ) : (
          <>
            <p className="mb-4 text-sm leading-relaxed text-ink-400">
              Signing in is free. It keeps the strangers you saved and your recent conversations,
              so they survive closing the tab.
            </p>

            {SIGNIN_PROVIDER === 'google' ? (
              /*
                Google's own button, not ours. The light plate and the
                unrecoloured mark are both required by their brand guidelines —
                the G may not be tinted to suit a dark theme — so this is
                deliberately the one control in the product that is not on the
                palette. It is `type="button"` and a plain element rather than
                `Button`, because `Button` carries the amber styling that would
                have to be undone here anyway.
              */
              <button
                type="button"
                onClick={signIn}
                disabled={leaving}
                className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-xl bg-white px-4 text-[15px] font-medium text-[#1f1f1f] shadow-sm transition-all hover:bg-ink-100 active:scale-[0.99] disabled:cursor-default disabled:opacity-60"
              >
                <GoogleMark />
                {busyLabel ?? 'Continue with Google'}
              </button>
            ) : (
              <Button size="lg" className="w-full" onClick={signIn} disabled={leaving}>
                <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
                {busyLabel ?? 'Continue to sign in'}
              </Button>
            )}

            <p className="mt-4 flex gap-2 text-xs leading-relaxed text-ink-500">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-600" aria-hidden="true" />
              <span>
                A {SIGNIN_PROVIDER === 'google' ? 'Google' : 'sign-in'} window opens on top of this
                one — check the address bar there before you type anything. Chatting never needs an
                account, and what you say in a conversation is not attached to one.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
