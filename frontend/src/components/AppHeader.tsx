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
import { MessageCircle, SlidersHorizontal, Users } from 'lucide-react';

import { ACCOUNTS_ENABLED } from '../features';
import type { ChatState } from '../state/machine';

interface AppHeaderProps {
  state: ChatState;
  onOpenFilters(): void;
  onOpenAuth(): void;
}

export function AppHeader({ state, onOpenFilters, onOpenAuth }: AppHeaderProps): JSX.Element {
  const presence = state.features.presence ? state.presence : null;

  return (
    <header className="safe-pt sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
      <div className="flex h-12 items-center gap-2 px-3 sm:gap-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-ink-900 ring-1 ring-ink-700">
            <MessageCircle className="h-4 w-4 text-amber-400" strokeWidth={2.2} />
          </span>
          <span className="font-display text-base font-semibold tracking-tight text-ink-50">
            karobakbak
          </span>
        </div>

        <div className="flex-1" />

        {presence && (
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
          <SlidersHorizontal className="h-3.5 w-3.5" />
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
