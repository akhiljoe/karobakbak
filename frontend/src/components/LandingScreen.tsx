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
import { Lock, Sparkles } from 'lucide-react';

import type { ChatState } from '../state/machine';
import type { Profile } from '../protocol/types';
import { isEmptyProfile } from '../profile';
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

          Both halves are claims about this system and are checked against it,
          the same rule the policy documents follow. The declared variant used
          to read "your profile stays on this device" and that was simply false:
          the profile rides on `join_queue`, is shown to the partner, and is
          written to `conversations.profile_a`/`_b` for the retention period,
          where the console can read it. What IS true is the §24.3 property —
          the server keeps no profile between sessions, the browser re-sends it
          every time, and nothing links one conversation to the next.

          The other half avoids "no profile", which stopped being the whole
          story once there was a profile editor and an intent selector to reach.
        */}
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-400 short:mt-3">
          <Lock className="h-3.5 w-3.5 shrink-0 text-ink-500" />
          {declaredAnything
            ? 'Nothing you declare follows you from one conversation to the next'
            : 'Free, anonymous, and nothing to set up'}
        </div>





      </div>

    </div>
  );
}
