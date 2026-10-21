/**
 * The age gate — a statement, not a check.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS SCREEN IS FOR
 * ---------------------------------------------------------------------------
 * The minor-safety position settles on "exclude minors, and ask" rather than
 * verifying anyone, which makes this screen the *entire*
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
import { useState } from 'react';

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
  // Reset with the dialog. A box ticked in a previous session is not a
  // decision taken in this one, and this gate is asked once per browser.
  const [agreed, setAgreed] = useState(false);

  /*
   * A configured canonical URL wins over the in-app page.
   *
   * A deployment that publishes the documents at a domain should link those,
   * because that is the version somebody can cite in a complaint. Absent one,
   * the in-app page *is* the published version — the documents ship with the
   * bundle, so unlike before there is never nothing to point at.
   */
  const terms = termsUrl !== '' ? termsUrl : '/terms';
  const privacy = privacyUrl !== '' ? privacyUrl : '/privacy';

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

        {/*
          One acknowledgement, carrying both halves.

          The age representation and the agreement to the documents are the same
          act — somebody is stating a fact about themselves and accepting the
          rules that follow from it — so they are one tick rather than a tick
          plus a button that means something different. An unticked box is the
          only part of a dialog that requires a decision rather than a
          dismissal, which is why the box carries the substance and the button
          only confirms it.

          The behaviour undertaking sits inside it rather than beside it. Split
          across two boxes it becomes a form; here it is one sentence somebody
          reads on the way to the button.

          What used to be explained on this screen — how matching works, that
          age is not checked, how long conversations are kept — is in the Terms,
          linked from the box itself. `docs/policies/age-gate.md` argues the
          age-not-checked line belongs on the gate; that was overruled
          deliberately, and this comment exists so the next reader knows it was
          a decision rather than an omission.
        */}
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-ink-700 bg-ink-950 px-3.5 py-3.5 transition-colors hover:border-ink-600">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(event) => setAgreed(event.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
          />
          <span className="text-sm leading-relaxed text-ink-300">
            I am 18 or over. I have read and agree to the{' '}
            <a
              href={terms}
              target="_blank"
              rel="noreferrer noopener"
              className="text-ink-100 underline underline-offset-4 hover:text-amber-300"
            >
              Terms
            </a>
            ,{' '}
            <a
              href={privacy}
              target="_blank"
              rel="noreferrer noopener"
              className="text-ink-100 underline underline-offset-4 hover:text-amber-300"
            >
              Privacy Policy
            </a>{' '}
            and{' '}
            <a
              href="/rules"
              target="_blank"
              rel="noreferrer noopener"
              className="text-ink-100 underline underline-offset-4 hover:text-amber-300"
            >
              Rules
            </a>
            , and I will not send sexual content to anyone who has not welcomed it or who may be
            under 18.
          </span>
        </label>

        <div className="mt-5 flex flex-col gap-2.5">
          <Button size="lg" onClick={onAccept} disabled={!agreed} autoFocus>
            Start chatting
          </Button>
          <Button size="lg" variant="secondary" onClick={onLeave}>
            Leave
          </Button>
        </div>

      </div>
    </div>
  );
}
