/**
 * The landing screen, and the screen shown after a conversation ends.
 *
 * The copy is deliberate about what this product does and does not keep. It
 * says conversations are retained for a period and then deleted, because they
 * are — claiming they vanish the moment you close the tab would be the easy
 * lie, and the retention section of the design exists precisely so abuse can be
 * investigated.
 */
import { Lock, MessageCircle, Shield, Sparkles, Users } from 'lucide-react';

import { clientConfig, hasLegalLinks } from '../config';
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

const legalLinks = hasLegalLinks(clientConfig);

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

  return (
    <div className="relative flex h-full animate-fade-in flex-col overflow-y-auto">
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

      <div className="flex flex-1 flex-col items-center justify-center px-6 py-8 text-center">
        {showPresence(presence) && presence && (
          <div className="mb-6 inline-flex animate-fade-in items-center gap-2 rounded-full border border-ink-800 bg-ink-900/60 px-3.5 py-1.5 text-sm text-ink-300 sm:mb-8">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
            </span>
            <span className="font-mono text-ink-100">{compact(presence.online)}</span> online
            <span className="text-ink-600">·</span>
            <Users className="h-3.5 w-3.5 text-ink-500" />
            <span className="font-mono text-ink-100">{compact(presence.conversations)}</span> chatting
          </div>
        )}

        <div className="relative mx-auto mb-6 flex h-16 w-16 items-center justify-center sm:mb-8 sm:h-20 sm:w-20">
          <span className="absolute inset-0 animate-pulse-ring rounded-full bg-amber-400/10" />
          <span className="relative flex h-12 w-12 items-center justify-center rounded-2xl bg-ink-900 shadow-lift ring-1 ring-ink-700 sm:h-16 sm:w-16">
            <MessageCircle className="h-6 w-6 text-amber-400 sm:h-8 sm:w-8" strokeWidth={2} />
          </span>
        </div>

        <h1 className="text-balance font-display text-4xl font-semibold tracking-tight text-ink-50 sm:text-6xl">
          {ended ? 'That one is over.' : 'Meet someone new.'}
        </h1>
        <p className="text-pretty mx-auto mt-4 max-w-md text-base text-ink-300 sm:mt-5 sm:text-lg">
          {ended
            ? 'There is no way back to that conversation. There is always another stranger.'
            : 'Random. Anonymous. Instant. Talk to a stranger — no signup, no history, just a conversation.'}
        </p>

        <div className="mt-8 flex w-full justify-center sm:mt-10">
          <ProfileCard profile={profile} onChange={onProfileChange} onClear={onProfileClear} />
        </div>

        <div className="mt-5 w-full max-w-xs">
          <Button size="lg" onClick={onStart} disabled={connecting} className="w-full">
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

        <div className="mt-6 flex items-center justify-center gap-2 text-xs text-ink-500">
          <Lock className="h-3 w-3" />
          {/*
            "Nothing kept after you leave" used to sit here, directly above a
            footer correctly saying conversations are kept for a limited period.
            The intended meaning was that the *declaration* is not kept
            server-side, which is true and is a real design achievement (D34) —
            but as written it was an unqualified retention claim, and it is the
            line a user reads as the privacy promise.
          */}
          {declaredAnything
            ? 'No signup · No account · Your profile stays on this device'
            : 'No signup · No profile · Anonymous'}
        </div>

        <div className="mt-8 w-full max-w-xs">
          <AdSlot slot={ended ? 'between-chats' : 'landing'} />
        </div>
      </div>

      <footer className="shrink-0 border-t border-ink-800/50 px-6 py-4">
        <div className="mx-auto flex max-w-md items-start justify-center gap-2 text-center text-xs leading-relaxed text-ink-500">
          <Shield className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-600" />
          <span>
            Be kind. Report or block anyone who makes you uncomfortable. Conversations are kept for
            a limited period so abuse can be investigated, then deleted automatically.
          </span>
        </div>

        {/*
          The age gate links these too, but it is shown once per browser. Without
          a second route, everybody who has already acknowledged it could never
          reach the documents again — and a policy nobody can find is not
          published (docs/policies/README.md step 5).

          Here rather than in settings because this is the screen somebody sits
          on before starting a conversation, which is when the question of what
          is kept actually occurs to them.
        */}
        {legalLinks && (
          <div className="mx-auto mt-3 flex max-w-md items-center justify-center gap-4 text-xs text-ink-600">
            <a
              href={clientConfig.legal.termsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 transition-colors hover:text-ink-300"
            >
              Terms
            </a>
            <a
              href={clientConfig.legal.privacyUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="underline underline-offset-2 transition-colors hover:text-ink-300"
            >
              Privacy
            </a>
          </div>
        )}
      </footer>
    </div>
  );
}

function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
