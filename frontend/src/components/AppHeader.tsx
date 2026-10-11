/**
 * The application header.
 *
 * The presence counts are shown as approximate, because the frame says they
 * are (`PresencePayload.approximate` is literally `true`), and they appear only
 * when the server said it supports presence at all.
 *
 * The account control lives in `AccountMenu`: a labelled button while signed
 * out, and a round avatar with a menu under it once signed in — a state, not a
 * call to action. Signing out belongs in that menu rather than in a centred
 * dialog, and the reasoning for both that and the glyph is on the component.
 *
 * The sign-in control is absent rather than disabled whenever it would be
 * wrong: `ACCOUNTS_ENABLED` off, and also for the moment before the first
 * `/auth/session` answer arrives. Rendering "Sign in" during that moment and
 * swapping it to "Account" is a visible flicker that tells the user something
 * false in between, and the something-false is what a header should never do.
 * The check is one same-origin request, so the gap is not perceptible.
 *
 * The filter control is now the same case. It used to render always and open a
 * modal whose contents were a "Part of Premium" lock — a control on the chat
 * surface whose only function was to say no. `FILTERS_AVAILABLE` hides it until
 * filters both exist and can be paid for; Premium is described on its own page,
 * which is where somebody goes to find out what it costs.
 *
 * `session.premium` is the second half of that, and it is per-user rather than
 * per-deployment. Without it, the day payments are switched on every visitor
 * gets the control, sets a preference, and has it dropped by the D51 gate on
 * the server — silently, because §29.4 requires a refused preference to be
 * invisible. That rule is right for somebody who has paid and spent their
 * hourly budget, and exactly wrong for somebody who never paid at all: they
 * would watch the setting be accepted and never learn it did nothing.
 *
 * It is false during the first `/auth/session` round trip, so a paying user
 * sees the control appear a moment after the page does. That is the same trade
 * the sign-in button makes above, in the same direction: showing nothing
 * briefly beats showing something false.
 *
 * Friends sits immediately left of the avatar, because it belongs to the
 * account the avatar stands for — signed out there is no list, so there is no
 * button (absent, not disabled). The number on it is how many friends are
 * online and appears only when that is more than zero: a badge reading 0 is a
 * claim about nobody that draws the eye to nothing.
 */
import { Lock, Settings, SlidersHorizontal, Users } from 'lucide-react';

import { ACCOUNTS_ENABLED, FILTERS_AVAILABLE } from '../features';
import { AccountMenu } from './AccountMenu';
import type { Session } from '../hooks/useSession';
import { LogoMark } from './Logo';
import { SiteNav, SiteNavLinks } from './SiteNav';
import type { ChatState } from '../state/machine';
import { showPresence } from '../view/presentation';

interface AppHeaderProps {
  state: ChatState;
  onHome(): void;
  onOpenFilters(): void;
  onOpenSettings(): void;
  onOpenAuth(): void;
  session: Session;
  /** Null when signed out, or when accounts are off: then there is no button. */
  friends: { online: number; open: boolean; onOpen(): void } | null;
}

export function AppHeader({
  state,
  onHome,
  onOpenFilters,
  onOpenSettings,
  onOpenAuth,
  session,
  friends,
}: AppHeaderProps): JSX.Element {
  const presence = state.features.presence ? state.presence : null;

  return (
    <header className="safe-pt sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
      <div className="flex h-12 items-center gap-2 px-3 sm:gap-3 sm:px-6">
        {/* Leftmost, before the brand, so the panel drops from the page edge. */}
        <SiteNav />

        {/*
          The brand is the way home, which is what a logo is everywhere else.
          A button rather than an <a href="/">: a reload would drop the socket
          and start a whole new session for what the user thinks of as "go
          back". `onHome` leaves the conversation properly and keeps the
          connection.
        */}
        <button
          onClick={onHome}
          aria-label="karobakbak — home"
          className="flex items-center gap-2 rounded-lg px-1 py-0.5 transition-opacity hover:opacity-80 active:scale-95"
        >
          <LogoMark size={26} />
          <span className="font-display text-base font-semibold tracking-tight text-ink-50">
            karobakbak
          </span>
        </button>

        <SiteNavLinks />

        <div className="flex-1" />

        {showPresence(presence) && presence && (
          <div
            className="flex items-center gap-1.5 text-xs text-ink-400 sm:gap-2"
            title="Counts are approximate"
          >
            <span className="flex items-center gap-1">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
              </span>
              <span className="font-mono text-ink-200">{compact(presence.online)}</span>
              <span className="hidden sm:inline">online</span>
            </span>
            <span className="hidden text-ink-600 sm:inline">·</span>
            <span className="hidden items-center gap-1 sm:flex">
              <Users className="h-3 w-3" />
              <span className="font-mono text-ink-200">{compact(presence.conversations)}</span>
              chatting
            </span>
          </div>
        )}

        {FILTERS_AVAILABLE && session.premium && (
        <button
          onClick={onOpenFilters}
          aria-label="Matching filters"
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 text-sm text-ink-200 transition-all hover:border-ink-600 hover:bg-ink-800 active:scale-95"
        >
          <span className="relative inline-flex">
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {/*
                A lock rather than a shield. `ShieldX` is already the block
                control in the conversation header, and a shield on a matching
                preference would read as a safety feature — which filtering
                explicitly is not: it narrows the pool and verifies nothing.
              */}
              <Lock
                className="absolute -right-1 -top-1 h-2.5 w-2.5 text-amber-400"
                aria-hidden="true"
              />
            </span>
        </button>
        )}

        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 text-sm text-ink-200 transition-all hover:border-ink-600 hover:bg-ink-800 active:scale-95"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>

        {friends !== null && (
          <button
            onClick={friends.onOpen}
            aria-haspopup="dialog"
            aria-expanded={friends.open}
            aria-label={
              friends.online > 0 ? `Friends, ${friends.online} online` : 'Friends'
            }
            className="relative inline-flex h-9 items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-2.5 text-sm text-ink-200 transition-all hover:border-ink-600 hover:bg-ink-800 active:scale-95"
          >
            <Users className="h-3.5 w-3.5" aria-hidden="true" />
            {/* The word only where there is room for it; the icon says it on a phone. */}
            <span className="hidden sm:inline">Friends</span>
            {friends.online > 0 && (
              <span
                aria-hidden="true"
                className="absolute -right-1.5 -top-1.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-green-500 px-1 font-mono text-[10px] font-semibold leading-none text-ink-950"
              >
                {friends.online > 9 ? '9+' : friends.online}
              </span>
            )}
          </button>
        )}

        {/*
          Absent rather than disabled while the flag is off or the first
          session answer has not arrived. The control owns its own menu; see
          AccountMenu for why signing out is a menu and signing in is a dialog.
        */}
        {ACCOUNTS_ENABLED && !session.checking && (
          <AccountMenu session={session} onOpenAuth={onOpenAuth} />
        )}
      </div>
    </header>
  );
}

/** 1200 -> "1.2k". Keeps the header from reflowing as the count moves. */
function compact(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
