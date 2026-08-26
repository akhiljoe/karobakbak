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
 * Nothing here was added to fill space. The two new elements — the live count
 * and the three steps — are both *information*, and both answer a question the
 * button cannot: "is anybody actually there" and "what happens if I press
 * this". Random chat loses people to those two uncertainties, not to a shortage
 * of decoration.
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

import { HowItWorks } from './HowItWorks';
import { LogoMark } from './Logo';
import type { ChatState } from '../state/machine';
import { showPresence } from '../view/presentation';
import type { Profile } from '../protocol/types';
import { isEmptyProfile } from '../profile';
import { ProfileCard } from './ProfileCard';
import { AdSlot } from './AdSlot';
import { Button } from './Button';

interface LandingScreenProps {
  state: ChatState;
  ended: boolean;
  onStart(): void;
  /** Seconds until auto-search fires, or null when it is not running. */
  autoSearchIn: number | null;
  onCancelAutoSearch(): void;
  profile: Profile;
  onProfileChange(profile: Profile): void;
  onProfileClear(): void;
}

export function LandingScreen({
  state,
  ended,
  onStart,
  autoSearchIn,
  onCancelAutoSearch,
  profile,
  onProfileChange,
  onProfileClear,
}: LandingScreenProps): JSX.Element {
  const presence = state.features.presence ? state.presence : null;
  const connecting = state.screen === 'connecting' || state.screen === 'disconnected';
  // The strapline claims "no profile", which stops being true the moment
  // someone fills one in. Saying it anyway would be the kind of small
  // dishonesty that costs trust when noticed.
  const declaredAnything = !isEmptyProfile(profile);
  const live = showPresence(presence) && presence !== null;

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
          The mark, with two conversation dots that breathe rather than orbit.
          Smaller than it was: it is a signature on the page, not a hero image,
          and the height it gave up went to the headline.
        */}
        <div className="relative mb-5 flex h-14 w-14 items-center justify-center sm:mb-6 sm:h-16 sm:w-16 short:mb-3 short:h-12 short:w-12">
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-amber-400/10" />
          <LogoMark size={48} className="relative" />
          <span
            className="absolute -right-1 top-1 h-1.5 w-1.5 animate-float-slow rounded-full bg-amber-400/60"
            style={{ animationDelay: '0.4s' }}
          />
          <span
            className="absolute -left-1.5 bottom-2 h-1 w-1 animate-float-slow rounded-full bg-sage-400/50"
            style={{ animationDelay: '1.6s' }}
          />
        </div>

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

        <div className="mt-6 flex w-full justify-center sm:mt-7 short:mt-4">
          <ProfileCard profile={profile} onChange={onProfileChange} onClear={onProfileClear} />
        </div>

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
        */}
        <div className="mt-4 flex items-center justify-center gap-2 text-sm text-ink-400 short:mt-3">
          <Lock className="h-3.5 w-3.5 shrink-0 text-ink-500" />
          {declaredAnything
            ? 'No signup · No account · Your profile stays on this device'
            : 'No signup · No profile · No commitment'}
        </div>

        {/*
          The one line the removed footer was carrying that is not repeated
          anywhere else on this screen. Retention is a fact somebody is entitled
          to before they start rather than after, and the age gate states it
          again at the moment of consent.
        */}
        <p className="mt-3 max-w-xs text-xs leading-relaxed text-ink-500 short:hidden">
          Conversations are kept for a limited period so abuse can be investigated, then deleted.
        </p>

        {/*
          Back in the hero, beside the button, because "what happens if I press
          this" is asked *at* the button and a nav link is a worse answer than
          three words in place. Dropped on short viewports, where the button
          keeping its space matters more.
        */}
        <div className="mt-6 w-full short:hidden">
          <HowItWorks />
        </div>

        {/*
          Rendered only above 100 (D21, `showPresence`). Below that the element
          does not exist at all: a small true number is worse for a visitor than
          silence, and a large invented one is not on the table.

          "online" rather than "chatting", because `online` counts people
          connected and `conversations` counts pairs. Calling the first one
          "chatting right now" would read better and be wrong.
        */}
        {live && (
          <div className="mt-4 inline-flex animate-fade-in items-center gap-2 rounded-full border border-ink-800 bg-ink-900/60 px-3.5 py-1.5 text-sm text-ink-300">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
            </span>
            <span>
              <span className="font-mono text-ink-100">{presence.online.toLocaleString()}</span>{' '}
              people online right now
            </span>
          </div>
        )}

        {/*
          `empty:hidden` because `AdSlot` renders `null` while ads are disabled,
          which left this wrapper present, empty, and still spending its 24px
          top margin. A gap held open for a thing that is not there.
        */}
        <div className="mt-6 w-full max-w-xs empty:hidden">
          <AdSlot slot={ended ? 'between-chats' : 'landing'} />
        </div>
      </div>

    </div>
  );
}
