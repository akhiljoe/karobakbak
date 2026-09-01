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
 *
 * ---------------------------------------------------------------------------
 * SIGNING OUT IS NOT HERE
 * ---------------------------------------------------------------------------
 * It was, and it made this dialog two things at once — which showed: finishing
 * a sign-in left the same centred panel on screen, now offering Sign out. A
 * modal is the right shape for something that interrupts and leaves for another
 * origin, which signing in does and signing out does not. Sign out is one
 * action belonging to one control, so it lives in the menu under that control
 * (`AccountMenu`), and this dialog closes itself the moment a session exists.
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // A dialog reopened after an abandoned sign-in should offer the button
  // again, not the "waiting" label from the attempt nobody finished.
  useEffect(() => {
    if (!open) setLeaving(false);
  }, [open]);

  /*
   * Close the moment there is a session, however that happened.
   *
   * This dialog is only ever "sign in" now — signing out moved to the header
   * menu — so being open while signed in is not a state, it is the tail end of
   * a flow that has finished. Without this it stayed open across the whole
   * flow: press "Sign in to continue", finish in the popup, the popup closes,
   * and you are left looking at a panel you did not ask for on top of the page
   * you actually wanted. The correct end of a successful sign-in is the page
   * you were already on, with the toast saying it worked.
   *
   * Ungated, so a sign-in completed in another tab closes this too rather than
   * leaving a dialog offering something already done.
   */
  useEffect(() => {
    if (open && session.signedIn) onClose();
  }, [open, session.signedIn, onClose]);

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
  // looking pressable while a window is open. A finished sign-in closes the
  // whole dialog, and an abandoned one resets this when it is next opened.
  const busyLabel = leaving ? 'Waiting for the sign-in window…' : null;

  // The published Terms when there is one, the in-app page otherwise. Same
  // fallback the age gate uses, for the same reason: a development build has
  // nowhere public to point and must not link nowhere.
  const termsUrl = clientConfig.legal.termsUrl !== '' ? clientConfig.legal.termsUrl : '/terms';

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
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
            The same round glyph as the header's account control, larger. It is
            deliberately not the provider's profile picture — `AccountMenu` has
            the note on what fetching a photo would cost.

            The karobakbak mark sits underneath rather than here, because this
            dialog is the one place that sends somebody to another origin and
            the thing worth being unambiguous about is whose sign-in this is.
          */}
          <span className="mb-4 inline-flex h-16 w-16 items-center justify-center rounded-full bg-ink-800 text-ink-300 ring-1 ring-ink-700">
            <User className="h-8 w-8" aria-hidden="true" />
          </span>

          <h2 className="font-display text-xl font-semibold text-ink-50">
            Sign in to continue
          </h2>

          <span className="mt-2 inline-flex items-center gap-1.5 text-xs text-ink-500">
            <LogoMark size={14} />
            karobakbak
          </span>
        </div>

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
      </div>
    </div>
  );
}
