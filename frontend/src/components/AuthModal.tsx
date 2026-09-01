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
 * IT MAKES NO CLAIMS AT ALL
 * ---------------------------------------------------------------------------
 * It listed what an account gates and warned about checking the address bar on
 * the provider's page. Both are gone, deliberately: this dialog is opened by
 * somebody who already decided to sign in, and a sales pitch plus a security
 * lecture in front of a single button is a wall of text between a person and
 * the thing they clicked for.
 *
 * Nothing was traded away to shorten it. The benefits belong on the pages that
 * describe the product, and the address-bar advice is now carried by the thing
 * that actually demonstrates it — a real browser window with its own visible
 * address bar, which is more convincing than a sentence saying to look at one.
 *
 * It closes on Escape and on the backdrop, unlike the age gate, which
 * deliberately does neither. This one is a choice somebody can decline.
 */
import { useEffect, useState } from 'react';
import { LogIn, User, X } from 'lucide-react';

import { clientConfig } from '../config';
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

  // The published Terms when there is one, the in-app page otherwise. Same
  // fallback the age gate uses, for the same reason: a development build has
  // nowhere public to point and must not link nowhere.
  const termsUrl = clientConfig.legal.termsUrl !== '' ? clientConfig.legal.termsUrl : '/terms';

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

        {/*
          The close control sits alone in the corner rather than in a row with
          the heading, because the heading is centred now and a flex row with an
          X on one end pulls it off centre by exactly the width of the X.
        */}
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute right-3 top-3 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="flex flex-col items-center px-2 pb-6 pt-3 text-center">
          {/*
            The same round glyph as the header's signed-in control, larger. It
            is deliberately not the provider's profile picture: see the note on
            that control in AppHeader for what fetching a photo would cost.

            The karobakbak mark sits underneath rather than here, because this
            dialog is the one place that sends somebody to another origin and
            the thing worth being unambiguous about is whose sign-in this is.
          */}
          <span className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-ink-800 text-ink-300 ring-1 ring-ink-700">
            <User className="h-8 w-8" aria-hidden="true" />
          </span>

          <h2 className="font-display text-xl font-semibold text-ink-50">
            {session.signedIn ? 'Your account' : 'Sign in to continue'}
          </h2>

          <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-500">
            <LogoMark size={14} />
            karobakbak
          </span>
        </div>

        {session.signedIn ? (
          <>
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
                className="inline-flex h-12 w-full items-center justify-center gap-3 rounded-xl border border-ink-600 bg-ink-800 px-4 text-[15px] font-medium text-ink-50 transition-all hover:border-ink-500 hover:bg-ink-700 active:scale-[0.99] disabled:cursor-default disabled:opacity-60"
              >
                <GoogleMark />
                {busyLabel ?? 'Sign in with Google'}
              </button>
            ) : (
              <Button size="lg" className="w-full" onClick={signIn} disabled={leaving}>
                <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
                {busyLabel ?? 'Continue to sign in'}
              </Button>
            )}

            {/*
              The one line of prose left, and it is not a benefit — it is the
              agreement being entered into by pressing the button above, which
              is the moment it is worth saying.

              Rendered only when there is somewhere for it to point.
              `VITE_TERMS_URL` is empty in a development build on purpose, and
              the in-app /terms route is the fallback; a link to nothing would
              be worse than no link, which is the same rule the age gate follows.
            */}
            <p className="mt-4 text-center text-xs leading-relaxed text-ink-500">
              By continuing you agree to our{' '}
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-ink-300 underline underline-offset-2 transition-colors hover:text-amber-300"
              >
                Terms
              </a>
              .
            </p>
          </>
        )}
      </div>
    </div>
  );
}
