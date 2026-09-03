/**
 * The landing screen, and the screen shown after a conversation ends.
 *
 * ---------------------------------------------------------------------------
 * THE COMPOSITION IS THE FEATURE
 * ---------------------------------------------------------------------------
 * This page did not feel empty because it lacked content. It felt empty because
 * everything on it was roughly the same size and evenly spaced, so nothing led.
 * The fix is hierarchy rather than volume: one headline large enough to be the
 * subject of the page, one button that is obviously the thing to press, and
 * everything else deliberately quieter than both.
 *
 * Nothing is here that does not move somebody toward the button. The live count
 * went to the searching screen, where "is anybody actually there" is a question
 * being asked rather than decoration; the three-step strip went to its own page,
 * because it explained something the button already implies.
 *
 * ---------------------------------------------------------------------------
 * MOBILE IS THE LAYOUT, NOT A NARROWER ONE
 * ---------------------------------------------------------------------------
 * The composition is built to land inside one viewport at 375x667 and up, so
 * nothing that matters sits below the fold on a phone. `overflow-y-auto` stays
 * as a safety valve rather than a scroll surface: at 320px, in landscape, or
 * with a large accessibility font, content that cannot fit must scroll rather
 * than be clipped. A page that never scrolls but hides its own button is worse
 * than one that scrolls a little.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE COPY IS NOT ALLOWED TO SAY
 * ---------------------------------------------------------------------------
 * The retention line stays factual: conversations *are* kept for a period and
 * then deleted, because abuse has to be investigable. "Nothing is stored" is
 * the easy lie and the one a user would most reasonably feel betrayed by.
 * Likewise "completely anonymous" — anonymous to the person you are talking to,
 * yes; to us, not entirely, and the FAQ says so in those words.
 */
import { Dices, Lock, Sparkles } from 'lucide-react';

import type { ChatState } from '../state/machine';
import type { Profile } from '../protocol/types';
import { isEmptyProfile } from '../profile';
import { capacityLine } from '../view/presentation';
import { Button } from './Button';

interface LandingScreenProps {
  state: ChatState;
  ended: boolean;
  onStart(): void;
  /** Seconds until auto-search fires, or null when it is not running. */
  autoSearchIn: number | null;
  onCancelAutoSearch(): void;
  profile: Profile;
}

export function LandingScreen({
  state,
  ended,
  onStart,
  autoSearchIn,
  onCancelAutoSearch,
  profile,
}: LandingScreenProps): JSX.Element {
  const connecting = state.screen === 'connecting' || state.screen === 'disconnected';
  const capacityMessage = capacityLine(state.capacity);
  // The strapline claims "no profile", which stops being true the moment
  // someone fills one in. Saying it anyway would be the kind of small
  // dishonesty that costs trust when noticed.
  const declaredAnything = !isEmptyProfile(profile);

  return (
    <div className="relative flex h-full animate-fade-in flex-col overflow-y-auto">
      {/*
        Four points of drift, not a particle system. They sit well away from the
        centre column so nothing competes with the headline, and the global
        `prefers-reduced-motion` rule in index.css stops them dead for anybody
        who has asked for that.
      */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        <span className="absolute left-[12%] top-[18%] h-2 w-2 animate-float-slow rounded-full bg-amber-400/40" />
        <span
          className="absolute right-[16%] top-[26%] h-1.5 w-1.5 animate-float-slow rounded-full bg-sage-400/40"
          style={{ animationDelay: '1.2s' }}
        />
        <span
          className="absolute bottom-[30%] left-[20%] h-1 w-1 animate-float-slow rounded-full bg-amber-300/30"
          style={{ animationDelay: '2s' }}
        />
        <span
          className="absolute bottom-[24%] right-[22%] h-2 w-2 animate-float-slow rounded-full bg-sage-500/30"
          style={{ animationDelay: '0.6s' }}
        />
      </div>

      {/*
        `min-h-full` rather than `flex-1`: the hero is exactly one viewport tall
        so the button is always reachable without scrolling, and the sections
        below start where the fold is rather than being squeezed in beside it.
      */}
      <div className="flex min-h-full flex-col items-center justify-center px-5 py-6 text-center sm:px-6 sm:py-8 short:py-4">


        {/*
          The focal point, and sized like one. 38px on a phone, 64px on a wide
          desktop — large enough that the page has an unambiguous subject, which
          is the whole of what was missing.
        */}
        <h1 className="text-balance font-display text-[2.375rem] font-semibold leading-[1.08] tracking-tight text-ink-50 sm:text-5xl lg:text-6xl">
          {ended ? (
            'That one is over.'
          ) : (
            <>
              Talk to someone you&rsquo;ve{' '}
              {/*
                One accented phrase, not a gradient and not a second colour on
                the page. It gives the headline somewhere to land and makes the
                proposition — a person you do not know — the part that carries
                the warmth. Italic because the serif has a genuinely good one.
              */}
              <span className="italic text-amber-300">never met</span>.
            </>
          )}
        </h1>

        <p className="text-pretty mx-auto mt-3.5 max-w-sm text-base text-ink-300 sm:mt-4 sm:max-w-md sm:text-lg short:mt-2">
          {ended
            ? 'There is no way back to that conversation. There is always another stranger.'
            : 'Random. Anonymous. Just a conversation.'}
        </p>

        {/*
          Full width on a phone, where a centred pill wastes the thumb's easiest
          target; back to its natural width from `sm` up, where a button the
          width of the viewport reads as a form submit.
        */}
        <div className="mt-4 w-full max-w-md sm:mt-5 sm:max-w-xs short:mt-3">
          <Button
            size="lg"
            onClick={onStart}
            disabled={connecting}
            className="w-full shadow-[0_6px_24px_-10px_rgba(255,180,32,0.55)] transition-shadow duration-300 hover:shadow-[0_10px_34px_-8px_rgba(255,180,32,0.7)]"
          >
            <Sparkles className="h-5 w-5" />
            {connecting
              ? 'Connecting…'
              : autoSearchIn !== null
                ? `Finding someone in ${autoSearchIn}…`
                : ended
                  ? 'Find someone else'
                  : 'Start chatting'}
          </Button>

          {/*
            Why the button has been saying "Connecting…" for a while.
            ------------------------------------------------------------------
            This is the case the capacity probe was built for. A refused
            handshake gives page script a close with code 1006 and nothing
            else, so without it a busy service and a broken laptop look
            identical from here — and the person on the landing screen has no
            conversation to explain the wait either.

            `ok` and `unknown` say nothing at all: the first means the service
            would have taken the connection, so the fault is local and the page
            cannot describe it better than the button does, and the second means
            the probe could not get through either, which is the same thing seen
            from further away. The words live in `presentation.ts`, where they
            are tested without a render.
          */}
          {connecting && capacityMessage !== null && (
            <p role="status" className="mt-2 text-xs leading-relaxed text-amber-300/90">
              {capacityMessage}
            </p>
          )}

          {/*
            A countdown that cannot be stopped is not a convenience. The cancel
            is the whole reason this is acceptable to have on by choice.
          */}
          {autoSearchIn !== null && (
            <button
              type="button"
              onClick={onCancelAutoSearch}
              className="mt-2 w-full text-xs text-ink-400 underline underline-offset-2 transition-colors hover:text-amber-300"
            >
              Stay here instead
            </button>
          )}
        </div>


        {/*
          Was `text-xs text-ink-500` — technically readable, visually invisible,
          which wasted the most reassuring line on the page. It is the answer to
          "what is this going to cost me", and it should be legible at a glance.

          The declared half is a **tagline**, and the two before it were both
          claims that did not survive being checked. "Your profile stays on this
          device" was plainly false: the profile rides on `join_queue`, is shown
          to the partner, and is written to `conversations.profile_a`/`_b` for
          the retention period, where the console can read it. Its replacement,
          "nothing you declare follows you from one conversation to the next",
          overstated in a quieter way — the browser re-sends the same
          declaration to every stranger, so what does not follow you is anything
          the *server* keeps, which is not what the sentence said.

          A tagline makes no claim, so there is nothing left to be wrong. The
          privacy properties are true and belong where they can be stated in
          full, not compressed into one line under a padlock.

          The padlock stays, and it is worth knowing what it is doing so nobody
          later reads it as a promise about the sentence beside it. An icon
          labels a category, and this row is the reassurance strip under the
          button - the place the page says "this is safe and costs nothing".
          That is what the lock marks, and it marks the row rather than either
          branch: one of them is a tagline, the other is the practical fact that
          there is nothing to sign up for. Neither is a security guarantee, and
          the lock must not be allowed to grow into one - if a claim is ever put
          back in this slot it has to be true on its own, with the icon adding
          nothing to it.

          The other half avoids "no profile", which stopped being the whole
          story once there was a profile editor and an intent selector to reach.
          It is kept for somebody who has declared nothing, because "nothing to
          set up" is the practical fact a first-time visitor wants; the tagline
          is for somebody who has already done the setting up.
        */}
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-400 short:mt-3">
          {/*
            The icon follows the branch, because the two sentences are not the
            same kind of thing. One is a privacy fact and takes the padlock; the
            other is a tagline about random pairing and takes the dice. A single
            glyph for both was always wrong for one of them.
          */}
          {declaredAnything ? (
            <Dices className="h-3.5 w-3.5 shrink-0 text-ink-500" />
          ) : (
            <Lock className="h-3.5 w-3.5 shrink-0 text-ink-500" />
          )}
          {declaredAnything
            ? 'Somebody new, every time.'
            : 'Free, anonymous, and nothing to set up'}
        </div>





      </div>

    </div>
  );
}
