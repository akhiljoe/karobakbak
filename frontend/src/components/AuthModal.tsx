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
 * IT MAKES EXACTLY ONE CLAIM
 * ---------------------------------------------------------------------------
 * It used to list everything an account gates and warn about checking the
 * address bar on the provider's page. That was a sales pitch plus a security
 * lecture in front of a single button, so both went — and the dialog then said
 * nothing at all, which was the opposite mistake. Opened from the header it
 * asked somebody to hand themselves to another origin and gave them no reason
 * to, above a heading that only restated the button.
 *
 * So: one heading that is a reason, and one sentence saying what an account
 * keeps. Connections, and nothing else — see the note beside that copy for why
 * the sentence has to stay this narrow, and why it never says "profile".
 *
 * The address-bar advice stays gone. It is carried by the thing that actually
 * demonstrates it — a real browser window with its own visible address bar,
 * which is more convincing than a sentence saying to look at one.
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
import { LogIn, X } from 'lucide-react';

import { clientConfig } from '../config';
import { SIGNIN_PROVIDER } from '../features';
import type { Session } from '../hooks/useSession';
import { Button } from './Button';
import { GoogleMark } from './GoogleMark';
import { Logo } from './Logo';

interface AuthModalProps {
  open: boolean;
  onClose(): void;
  session: Session;
  /**
   * Why this opened, when something asked for it.
   *
   * Shown above the button. A dialog that appears because somebody pressed
   * "Add friend" should say so — otherwise it reads as the product interrupting
   * them, and the connection between what they did and what they are being
   * asked for is left to them to make.
   */
  reason?: string | null;
  /**
   * Whether a conversation is live behind this dialog.
   *
   * It decides whether a blocked popup may fall back to a full-page redirect,
   * and it has to be that rather than `reason`, which is what it used to be.
   * `reason` says why the dialog opened; this says what navigating would
   * destroy. They agree from Add friend and disagree in exactly the case that
   * loses somebody their chat: signing in from the header while talking to
   * a stranger sets no reason, so the redirect was allowed and the socket died
   * with the navigation. `RESUME_GRACE_SECONDS` is 20, and a round trip through
   * the provider does not reliably finish inside it.
   */
  inConversation?: boolean;
}

export function AuthModal({
  open,
  onClose,
  session,
  reason = null,
  inConversation = false,
}: AuthModalProps): JSX.Element | null {
  const [leaving, setLeaving] = useState(false);
  const [popupBlocked, setPopupBlocked] = useState(false);

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
    if (!open) {
      setLeaving(false);
      setPopupBlocked(false);
    }
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
    /*
      The redirect fallback is allowed only when there is nothing to lose.

      This asked `reason === null`, which is a different question wearing the
      same answer most of the time: it permitted the redirect whenever nothing
      in the app had asked for the dialog. Signing in from the header *during a
      conversation* is exactly that case, and the navigation ended the chat -
      the socket dies with the page, and the 20-second grace window does not
      cover a round trip through the provider. Nothing failed loudly; the chat
      was simply gone on the way back.
    */
    const opened = session.signIn(!inConversation);
    if (!opened) {
      setLeaving(false);
      setPopupBlocked(true);
    }
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
      /*
        Centred at every width, which the other modals here are not.

        `FiltersModal`, `ReportDialog` and `SettingsSheet` are bottom sheets on
        a phone, and rightly: each is a tall scrolling form, so anchoring it to
        the bottom puts the controls under the thumb and lets the content run
        off the top. This one is a mark, two lines and a button. Pinned to the
        bottom it read as a sheet that had failed to fill - most of the screen
        dimmed and empty above a short panel - and the padding is what keeps it
        off the edges once it is no longer flush with one.
      */
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
    >
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/*
        Rounded on all four corners, and no drag handle. Both belonged to the
        sheet: a handle is an affordance for dragging something away, and this
        never could be dragged - it is a promise the panel cannot keep, and a
        floating panel wearing one is stranger still.
      */}
      <div className="relative w-full max-w-sm animate-fade-in rounded-3xl border border-ink-700 bg-ink-900 p-5 shadow-lift">

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

        <div className="flex flex-col items-center px-2 pb-6 pt-4 text-center">
          {/*
            The name, at a size somebody can read.

            This was a generic person glyph in a 64px circle with the mark
            beneath it at 14px in the dimmest grey on the palette. Both halves
            were wrong for the one dialog that hands somebody to another
            origin: the glyph was the same avatar placeholder the header shows
            for *any* signed-out visitor, so it identified nothing, and it was
            the largest thing on screen — while the only element that answers
            "whose sign-in is this" was a caption. Being unambiguous about that
            is the whole job here, so the lockup does it directly.
          */}
          <Logo size={34} wordClassName="text-2xl" className="mb-5" />

          <h2 className="font-display text-xl font-bold leading-snug text-ink-50">
            Sign in to continue
          </h2>

          {/*
            Why an account is worth having, said once.

            When something in the app asked for this, that ask is the reason and
            it is more specific than anything written here — stacking a general
            pitch on top of "Sign in to add people you meet" is two answers to a
            question with one.

            The claim is deliberately narrow, and narrow because it has to be
            true. An account keeps **connections** — the friends list, and being
            able to ask somebody to talk again. It does not keep conversations:
            messages are retained for abuse investigation and are never shown
            back to anybody (§2.1, §18.2), so "your chats are saved" would be a
            promise the product does not keep. Recent is not sold here either;
            it works signed out, in this tab, and saying otherwise would make
            the sign-in dialog lie about a feature somebody already has.

            "talk to them again", not "keep talking". There is no inbox and no
            thread to return to: you ask somebody you met to talk again, and the
            server pairs you if they accept. The shorter phrasing describes a
            product with private messaging in it.

            It continues the heading rather than restarting it - "Sign in to
            continue" / "To keep your friends". Both opened with "Sign in" for a
            while, which reads as the dialog asking twice. That is also why it
            is the smaller type: the heading is the ask, this is the reason for
            it, and they were competing at the same size.

            "Account", never "profile". A profile in this product is the name,
            age, gender and country declared for one conversation, which the
            server keeps for that conversation and no longer (D34, §24.3). Using
            the word here would name one thing after another and imply the
            declared profile is stored, which is exactly what it is not.
          */}
          <p className="mt-2 max-w-[17rem] text-xs leading-relaxed text-ink-400">
            {reason ?? 'To keep your friends, and talk to them again.'}
          </p>
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
          {popupBlocked && (
            <p className="mt-3 rounded-lg border border-dashed border-amber-400/40 bg-amber-400/5 px-3 py-2.5 text-sm leading-relaxed text-ink-400">
              <span className="font-medium text-amber-300">Your browser blocked the window.</span>{' '}
              Allow pop-ups for this site and try again — we did not send you away, because that
              would end the conversation you are in.
            </p>
          )}

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
