/**
 * The application header.
 *
 * The presence counts are shown as approximate, because the frame says they
 * are (`PresencePayload.approximate` is literally `true`), and they appear only
 * when the server said it supports presence at all.
 *
 * The sign-in control is absent rather than disabled: `ACCOUNTS_ENABLED` is
 * false and a button that opens a screen explaining it does nothing is worse
 * than no button. The filters control is the opposite case, and the reasoning
 * for the asymmetry is in `features.ts`.
 */
import { Lock, Settings, SlidersHorizontal, Users } from 'lucide-react';

import { ACCOUNTS_ENABLED } from '../features';
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
}

export function AppHeader({
  state,
  onHome,
  onOpenFilters,
  onOpenSettings,
  onOpenAuth,
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

        <button
          onClick={onOpenSettings}
          aria-label="Settings"
          className="inline-flex h-9 items-center gap-1 rounded-lg border border-ink-700 bg-ink-900 px-2.5 text-sm text-ink-200 transition-all hover:border-ink-600 hover:bg-ink-800 active:scale-95"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>

        {ACCOUNTS_ENABLED && (
          <button
            onClick={onOpenAuth}
            aria-label="Sign in or create account"
            className="inline-flex h-9 items-center gap-1 rounded-lg bg-amber-400 px-3 text-sm font-semibold text-ink-950 transition-all hover:bg-amber-300 active:scale-95"
          >
            Sign in
          </button>
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
