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

import type { Session } from '../hooks/useSession';
import { Button } from './Button';

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
    // The page is about to be replaced, so this flag only ever un-sets by the
    // navigation not happening. That is the case it is for: a blocked or
    // failed redirect otherwise leaves a button that looks untouched.
    setLeaving(true);
    session.signIn();
  };

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
          <h2 className="font-display text-lg font-semibold text-ink-50">
            {session.signedIn ? 'Your account' : 'Sign in'}
          </h2>
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

            <Button size="lg" className="w-full" onClick={signIn} disabled={leaving}>
              <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
              {leaving ? 'Taking you there…' : 'Continue to sign in'}
            </Button>

            <p className="mt-4 flex gap-2 text-xs leading-relaxed text-ink-500">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ink-600" aria-hidden="true" />
              <span>
                You will finish on our sign-in provider's page, not here — check the address bar
                before you type anything. Chatting never needs an account, and what you say in a
                conversation is not attached to one.
              </span>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
