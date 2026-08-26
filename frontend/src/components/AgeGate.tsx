/**
 * The age gate — a statement, not a check.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS FOR
 * ---------------------------------------------------------------------------
 * `docs/policies/minor-safety-policy.md` §3 settles on "exclude minors, and
 * ask" rather than verifying anyone, which makes this screen the *entire*
 * enforcement. Its wording therefore carries more weight than any other string
 * in the product, and it has exactly one job: to be a statement somebody
 * actually read, rather than a dialog they dismissed.
 *
 * It must never be described, in copy or in code, as age assurance. It is not
 * one. `agegate.ts` says the same thing at more length.
 *
 * ---------------------------------------------------------------------------
 * FOUR DELIBERATE CHOICES IN THE COPY
 * ---------------------------------------------------------------------------
 *  * **The heading is the requirement**, not a greeting. It is the one line
 *    that survives being skimmed.
 *  * **"We do not check anyone's age" is on this screen**, not buried in the
 *    Terms. A gate that implies verification is worse than no gate: it
 *    manufactures a false sense of safety in the person who passes it, who is
 *    then talking to strangers they believe were screened.
 *  * **Retention is mentioned here**, because this is the last moment before a
 *    conversation starts. F-016 exists because the landing screen used to say
 *    the opposite of the truth in the same paragraph.
 *  * **"Leave" is a real button.** A gate whose only action is agreement is not
 *    a choice, and in some regimes not a valid one.
 *
 * ---------------------------------------------------------------------------
 * IT IS DELIBERATELY HARDER TO DISMISS THAN ANYTHING ELSE HERE
 * ---------------------------------------------------------------------------
 * Every other dialog in this interface closes on Escape and on a click outside,
 * and consistency is usually the right instinct. Not here. Those gestures exist
 * to let somebody back out of something they opened by accident; this was not
 * opened by accident, and backing out of it silently would leave the
 * requirement unstated and the user in the product anyway.
 *
 * So there is no close button, no backdrop handler, and no Escape listener —
 * and, because the global Escape shortcut in `App.tsx` skips a conversation,
 * this contributes to `overlayOpen` so that shortcut stands down while the gate
 * is showing.
 */
import { ExternalLink } from 'lucide-react';

import { Button } from './Button';

interface AgeGateProps {
  /** Published Terms. Empty renders the fallback notice instead of a link. */
  termsUrl: string;
  /** Published Privacy Policy. Same. */
  privacyUrl: string;
  /** Acknowledged. The caller records it and lets the person through. */
  onAccept(): void;
  /** Declined. Takes them away rather than closing the dialog. */
  onLeave(): void;
}

export function AgeGate({
  termsUrl,
  privacyUrl,
  onAccept,
  onLeave,
}: AgeGateProps): JSX.Element {
  const linked = termsUrl !== '' && privacyUrl !== '';

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="age-gate-title"
    >
      {/*
        No `onClick` on the backdrop. Clicking away is how every other overlay
        here closes, and this one must not: see the note at the top of the file.
      */}
      <div className="absolute inset-0 bg-ink-950/90 backdrop-blur-sm" />

      <div className="relative w-full max-w-md animate-fade-in rounded-3xl border border-ink-700 bg-ink-900 p-6 shadow-lift">
        <h2
          id="age-gate-title"
          className="font-display text-xl font-semibold text-ink-50"
        >
          You must be 18 or over
        </h2>

        <div className="mt-4 space-y-3 text-sm leading-relaxed text-ink-300">
          <p>
            karobakbak connects you with a randomly chosen stranger. You do not
            choose who you are matched with, and neither do they.
          </p>
          <p>
            <span className="font-semibold text-ink-100">
              We do not check anyone&rsquo;s age.
            </span>{' '}
            We ask, and we cannot tell you who anyone is. Treat everything a
            stranger tells you about themselves as unverified.
          </p>
          <p>
            Conversations are kept for 30 days, or 90 days if someone reports
            them, so that they can be investigated.
          </p>
        </div>

        {/*
          The agreement, at the moment it is actually being given. This screen
          is the last thing before a conversation starts, which makes it the
          honest place to say what continuing means — better than a line of
          footer text nobody reads on the way past.

          It does not replace the links below: `age-gate.md` requires both
          documents to be reachable without passing this gate, which is what the
          header menu is for.
        */}
        <p className="mt-5 text-sm leading-relaxed text-ink-400">
          By continuing you agree to the{' '}
          <a
            href="/terms"
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-200 underline underline-offset-4 hover:text-amber-300"
          >
            Terms
          </a>{' '}
          and the{' '}
          <a
            href="/privacy"
            target="_blank"
            rel="noreferrer noopener"
            className="text-ink-200 underline underline-offset-4 hover:text-amber-300"
          >
            Privacy Policy
          </a>
          , and confirm you are 18 or over.
        </p>

        <div className="mt-5 flex flex-col gap-2.5">
          <Button size="lg" onClick={onAccept} autoFocus>
            I am 18 or over
          </Button>
          <Button size="lg" variant="secondary" onClick={onLeave}>
            Leave
          </Button>
        </div>

        {/*
          The documents ship with the bundle now (`content/legal.ts`), so the
          gate always has somewhere real to point. This used to say "not
          published in this build" whenever the external URLs were unset — true
          then, and a lie now.

          A configured external URL still wins: a deployment that publishes
          canonical copies at a domain should link those, because that is the
          version somebody can cite. Absent one, the in-app page *is* the
          published version. Either way `docs/policies/age-gate.md` is
          satisfied — both documents reachable without passing the gate.
        */}
        <div className="mt-5 border-t border-ink-800 pt-4 text-center text-sm text-ink-400">
          {linked ? (
            <p className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1">
              <a
                href={termsUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-ink-300 underline underline-offset-2 transition-colors hover:text-ink-100"
              >
                Terms
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
              <a
                href={privacyUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-ink-300 underline underline-offset-2 transition-colors hover:text-ink-100"
              >
                Privacy Policy
                <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </p>
          ) : (
            /*
              A new tab, not a route. The gate is holding a pending "start
              chatting" — navigating away in this tab would discard it, and
              somebody who came back would have to press the button again and
              wonder whether the first press did anything.
            */
            <p className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
              <a
                href="/terms"
                target="_blank"
                rel="noreferrer noopener"
                className="rounded py-1 text-ink-300 underline underline-offset-4 transition-colors hover:text-ink-100"
              >
                Terms
              </a>
              <a
                href="/privacy"
                target="_blank"
                rel="noreferrer noopener"
                className="rounded py-1 text-ink-300 underline underline-offset-4 transition-colors hover:text-ink-100"
              >
                Privacy Policy
              </a>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
