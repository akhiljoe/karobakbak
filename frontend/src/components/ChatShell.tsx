/**
 * The conversation layout: header, transcript, composer, actions.
 *
 * Covers both `searching` and `chatting`, because they are one continuous
 * place from the user's point of view — the search overlay sits on top of the
 * same shell rather than being a separate screen the layout jumps between.
 */
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  Clock,
  Loader2,
  MoreVertical,
  ShieldX,
  SkipForward,
  UserPlus,
  X,
} from 'lucide-react';

import { useDuration } from '../hooks/useDuration';
import type { ChatState } from '../state/machine';
import { COUNTRY_NAMES, type Profile } from '../protocol/types';
import { GENDER_LABELS } from '../profile';
import { ACCOUNTS_ENABLED } from '../features';
import { HistoryPanel } from './HistoryPanel';
import type { HistoryEntry } from '../history';
import {
  colourFor,
  composerDisabled,
  glyphFor,
  searchingDetail,
  showPresence,
  type ConnectionView,
} from '../view/presentation';
import { Avatar } from './Avatar';
import { ConnectionStatus } from './ConnectionStatus';
import { IcebreakerBar } from './IcebreakerBar';
import { MessageInput } from './MessageInput';
import { MessageList } from './MessageList';
import { ReconnectBanner } from './ReconnectBanner';

const SEARCHING_LINES = [
  'Looking for someone…',
  'Still searching…',
  'Nobody yet — hang on.',
  'Checking the rooms.',
  'Wandering the halls…',
] as const;

interface ChatShellProps {
  state: ChatState;
  connection: ConnectionView;
  searching: boolean;
  /** The person asked for conversation starters. Off unless they did. */
  icebreakersEnabled: boolean;
  /** Auto-find the next stranger when this one leaves. Same preference as Settings. */
  autoSearch: boolean;
  onToggleAutoSearch(value: boolean): void;
  /** Block the current partner and move on, in one action. */
  onBlockAndNext(): void;
  onSend(text: string): void;
  /** Strangers met in this session. Client-side only; see `history.ts`. */
  history: readonly HistoryEntry[];
  onClearHistory(): void;
  onTyping(active: boolean): void;
  onReact(messageId: string, reaction: string, active: boolean): void;
  /** Save this stranger, or withdraw it while the conversation is still running. */
  onSaveConnection(active: boolean): void;
  onSkip(): void;
  onCancelSearch(): void;
  onOpenSafety(): void;
  onBack(): void;
}

export function ChatShell({
  state,
  connection,
  searching,
  icebreakersEnabled,
  autoSearch,
  onToggleAutoSearch,
  onBlockAndNext,
  onSend,
  history,
  onClearHistory,
  onTyping,
  onReact,
  onSaveConnection,
  onSkip,
  onCancelSearch,
  onOpenSafety,
  onBack,
}: ChatShellProps): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const chatting = state.screen === 'chatting';
  const duration = useDuration(chatting ? state.matchStartedAt : null);
  // What they said about themselves, as a subtitle. Null when they declared
  // nothing, which is the common case and the one the copy defaults to.
  const declared = describeProfile(state.partner?.profile ?? null);
  // Two different waits, and they are not the same message. `partnerAway` is
  // "they dropped, their seat is held"; `reconnecting` is "*we* dropped".
  const partnerCountdown = useCountdown(state.partnerAway);
  const reconnecting = state.screen === 'disconnected' && state.matchId !== null;
  const selfCountdown = useCountdown(
    reconnecting && state.resumeGraceSeconds > 0
      ? new Date(Date.now() + state.resumeGraceSeconds * 1000).toISOString()
      : null,
  );
  const [icebreakerDismissed, setIcebreakerDismissed] = useState(false);

  // A new conversation gets a fresh offer of a prompt.
  useEffect(() => {
    setIcebreakerDismissed(false);
  }, [state.matchId]);

  const showIcebreaker =
    icebreakersEnabled && chatting && !icebreakerDismissed && state.messages.length === 0;
  // Report only. Block is its own control now, gated separately — a sheet that
  // opened with nothing in it because only blocking was enabled would be a
  // button advertising a capability the server had turned off.
  const safetyAvailable = state.features.report;

  return (
    <div className="flex h-full flex-col">
      <header className="sticky top-0 z-20 border-b border-ink-800 bg-ink-950/80 backdrop-blur-md">
        <div className="flex h-16 items-center gap-2 px-3 sm:gap-3 sm:px-4">
          <button
            onClick={onBack}
            aria-label="Back to home"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-200 transition-all hover:bg-ink-800 hover:text-ink-50 active:scale-95"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>

          <Avatar
            glyph={glyphFor(state.partner)}
            colour={colourFor(state.partner)}
            size="sm"
            pulsing={searching}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-ink-50">
                {searching
                  ? 'Finding someone…'
                  : (state.partner?.profile?.name ?? state.partner?.nickname ?? 'Stranger')}
              </h2>
              <ConnectionStatus state={connection} />
            </div>
            <div className="flex h-4 items-center gap-2 text-xs text-ink-400">
              {searching ? (
                'Looking for a stranger'
              ) : reconnecting ? (
                <span className="text-amber-300">
                  Reconnecting{selfCountdown === null ? '…' : ` — ${selfCountdown}s`}
                </span>
              ) : state.partnerTyping ? (
                <span className="text-amber-300">typing…</span>
              ) : (
                <>
                  {/*
                    "Anonymous" only while they declared nothing. Showing it
                    beside an age and a country would be the interface
                    contradicting itself.
                  */}
                  <span>{declared ?? 'Anonymous'}</span>
                  {chatting && (
                    <>
                      <span className="text-ink-600">·</span>
                      <span className="inline-flex items-center gap-1 font-mono text-ink-500">
                        <Clock className="h-3 w-3" />
                        {duration}
                      </span>
                    </>
                  )}
                </>
              )}
            </div>
          </div>

          {/*
            Icon above label, not beside it. Side by side, the two buttons ate
            the width the declared name needs on a phone and the header read as
            cramped; stacked, each is 56px wide instead of ~90px. The header
            grows to 64px so the touch target stays around 48px — shrinking the
            buttons to fit a 56px bar would have traded one mobile problem for a
            worse one.

            Block sits up here, beside who it is about, and deliberately not in
            the action bar. Down there it shared an edge with "Next stranger" —
            the button somebody presses dozens of times a session — and a
            destructive, rate-limited action one thumb-width from a reflex is an
            accident waiting to be reported as a bug.

            Icon plus word, not an icon alone: it has to be findable in a hurry
            by somebody who is uncomfortable, and an unlabelled icon is only
            discoverable to people who already know what it does.
          */}
          {chatting && state.features.block && (
            <button
              onClick={onBlockAndNext}
              aria-label="Block this stranger and find someone else"
              className="inline-flex h-12 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border border-rose-500/30 text-rose-400/90 transition-all hover:border-rose-500/60 hover:bg-rose-500/10 active:scale-95"
            >
              <ShieldX className="h-4 w-4" />
              <span className="text-[0.65rem] font-medium leading-none">Block</span>
            </button>
          )}

          {/*
            Reporting is a *considered* action — pick a category, maybe write a
            note, ask a human to look. Nobody does that in a panic, so it does
            not need to compete with Block for width or attention; it needs to
            be findable. One level in, behind a labelled control, is the trade.

            It stays available for the whole conversation and nowhere else: a
            report needs the match that is being reported, so there is no
            reporting from the ended screen.
          */}
          {chatting && safetyAvailable && (
            <button
              onClick={onOpenSafety}
              aria-label="Safety and reporting options"
              className="inline-flex h-12 w-9 shrink-0 items-center justify-center rounded-xl text-ink-400 transition-all hover:bg-ink-800 hover:text-ink-100 active:scale-95"
            >
              <MoreVertical className="h-5 w-5" />
            </button>
          )}

          {searching && (
            <button
              onClick={onCancelSearch}
              aria-label="Cancel search"
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl text-ink-200 transition-all hover:bg-ink-800 hover:text-ink-50 active:scale-95"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>
      </header>

      <ReconnectBanner connection={connection} />

      <div className="flex flex-1 overflow-hidden">
        <div className="relative flex flex-1 flex-col overflow-hidden">
          {searching && (
            <SearchingOverlay
              waiting={state.waiting}
              presence={state.features.presence ? state.presence : null}
            />
          )}

          {showIcebreaker && (
            <IcebreakerBar onUse={onSend} onDismiss={() => setIcebreakerDismissed(true)} />
          )}

          <div
            className={`flex-1 overflow-hidden transition-opacity duration-300 ${
              searching ? 'pointer-events-none opacity-0' : 'opacity-100'
            }`}
          >
            <MessageList
              messages={state.messages}
              partnerTyping={state.partnerTyping}
              partnerColour={colourFor(state.partner)}
              // The conversation, not the socket: a blip must not take the
              // opening line out of a transcript that is still on screen.
              conversationOpen={state.matchId !== null}
              reported={state.reportSent}
              partnerCountry={state.partner?.profile?.country ?? null}
              // Absent while the composer is disabled, so the gesture is
              // offered exactly when a frame could actually be sent — a
              // partner who is away cannot receive one (D43).
              onReact={composerDisabled(state) ? undefined : onReact}
            />
          </div>
        </div>

      </div>

      {/*
        One row above the composer: the choice on the left, the action on the
        right. Both are about moving on, so they belong together and beside the
        thing you are typing in — and both are deliberately far from Block,
        which lives in the header. Side by side is how a reflex becomes a block
        somebody did not mean.
      */}
      {chatting && (
        <div className="flex items-center justify-between gap-3 px-3 pb-1.5 pt-1 sm:px-4">
          <label className="flex cursor-pointer items-center gap-2 text-xs text-ink-400 transition-colors hover:text-ink-200">
            <input
              type="checkbox"
              checked={autoSearch}
              onChange={(event) => onToggleAutoSearch(event.target.checked)}
              className="h-3.5 w-3.5 shrink-0 accent-amber-400"
            />
            <span className="leading-tight">
              Auto-find next
              <span className="ml-1 hidden text-ink-600 sm:inline">· never after you block</span>
            </span>
          </label>

          {/*
            Absent, not disabled, while accounts are off — the rule the filter
            control and Premium already follow. A save button that renders and
            refuses still takes focus and still announces itself to a screen
            reader before saying no.

            It sits with the conversation controls rather than beside Block: it
            is the one *positive* thing you can do about a stranger, and putting
            it next to the destructive control would be a strange pair of
            neighbours. It is deliberately not near "Next stranger" either —
            see the note above about reflexes and adjacency.
          */}
          {ACCOUNTS_ENABLED && (
            <button
              onClick={() => onSaveConnection(!state.connectionSaved)}
              disabled={state.connectionMade}
              aria-pressed={state.connectionSaved}
              title={
                state.connectionMade
                  ? 'Connected'
                  : state.connectionSaved
                    ? 'Saved. Tap to undo.'
                    : 'Save this stranger'
              }
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all active:scale-95 ${
                state.connectionSaved
                  ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                  : 'border-ink-700 bg-ink-900 text-ink-200 hover:border-ink-600 hover:bg-ink-800'
              } ${state.connectionMade ? 'cursor-default' : ''}`}
            >
              <UserPlus className="h-3.5 w-3.5" />
              {/*
                Three labels for three genuinely different states, and never a
                fourth for "they saved you". That frame does not exist: a save
                is disclosed only on reciprocity, so there is nothing between
                "saved" and "connected" for the interface to show.
              */}
              {state.connectionMade ? 'Connected' : state.connectionSaved ? 'Saved' : 'Save'}
            </button>
          )}

          <button
            onClick={onSkip}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-ink-200 transition-all hover:border-ink-600 hover:bg-ink-800 active:scale-95"
          >
            <SkipForward className="h-3.5 w-3.5" />
            Next stranger
          </button>
        </div>
      )}

      {/*
        Above the composer rather than beside the stranger's name, because the
        composer is what it explains. Next to the profile it read as a fact
        about them; here it reads as the reason the box below will not accept
        anything, which is what somebody staring at a disabled field is
        actually asking.
      */}
      {state.partnerAway !== null && (
        <div
          role="status"
          className="mx-auto mb-1.5 flex w-full max-w-3xl items-center gap-2 px-1 text-xs text-amber-300"
        >
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
          <span>
            They dropped out
            {partnerCountdown === null ? '' : ` — back within ${partnerCountdown}s`}. You can wait
            or move on.
          </span>
        </div>
      )}

      {/*
        Recent strangers, as a link rather than a header icon.

        It belongs to the conversation surface: it is a list of people you met
        while chatting, it is empty until you have chatted, and on the landing
        screen it would be a control for something that has not happened yet.
        Beside the composer it sits where somebody already is.

        A link and not a button, because it opens a list rather than performing
        an action, and the row above the composer is not a place for another
        piece of chrome competing with Skip and Block.

        The panel opens upward — this is near the bottom of the viewport, and a
        panel dropping from here would open off-screen on a phone.
      */}
      <div className="mx-auto flex w-full max-w-3xl justify-end px-1 pb-1">
        <div className="relative">
          <button
            onClick={() => setHistoryOpen((was) => !was)}
            aria-haspopup="dialog"
            aria-expanded={historyOpen}
            className={`inline-flex items-center gap-1.5 rounded text-xs underline underline-offset-2 transition-colors ${
              historyOpen ? 'text-amber-300' : 'text-ink-500 hover:text-ink-300'
            }`}
          >
            <Clock className="h-3 w-3" aria-hidden="true" />
            Recent
            {history.length > 0 && <span className="no-underline">({history.length})</span>}
          </button>

          <HistoryPanel
            open={historyOpen}
            entries={history}
            placement="up"
            onClose={() => setHistoryOpen(false)}
            onClear={onClearHistory}
          />
        </div>
      </div>

      <MessageInput
        maxLength={state.limits?.maxMessageLength ?? 500}
        disabled={composerDisabled(state)}
        onSend={onSend}
        onTyping={onTyping}
      />

    </div>
  );
}

function SearchingOverlay({
  waiting,
  presence,
}: {
  waiting: number;
  presence: { online: number; conversations: number } | null;
}): JSX.Element {
  return (
    <div
      className="absolute inset-0 z-10 flex animate-fade-in flex-col items-center justify-center px-6 text-center"
      role="status"
      aria-live="polite"
    >
      <div className="relative flex h-40 w-40 items-center justify-center">
        <span className="absolute h-20 w-20 animate-pulse-ring rounded-full bg-amber-400/15" />
        <span
          className="absolute h-20 w-20 animate-pulse-ring rounded-full bg-amber-400/10"
          style={{ animationDelay: '0.7s' }}
        />
        <span
          className="absolute h-20 w-20 animate-pulse-ring rounded-full bg-amber-400/5"
          style={{ animationDelay: '1.4s' }}
        />
        <div className="absolute h-32 w-32 animate-[spin_8s_linear_infinite]">
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-amber-400 shadow-glow" />
        </div>
        <div className="absolute h-40 w-40 animate-[spin_12s_linear_infinite_reverse]">
          <span className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-sage-400" />
        </div>
        <span className="relative h-14 w-14 animate-float-slow rounded-full bg-amber-400 shadow-glow" />
      </div>

      <RotatingLine />
      <p className="mt-2 text-sm text-ink-400">{searchingDetail(waiting)}</p>

      {/*
        The live count, moved here from the landing page.

        It answers one question — "is anybody actually here?" — and this is the
        moment somebody asks it. On the landing screen the same number was
        decoration; while the spinner is turning it is the difference between
        waiting and giving up.

        Still governed by `showPresence`, so it is absent below 100 rather than
        reassuring nobody with a small number (D21).
      */}
      {showPresence(presence) && presence !== null && (
        <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-ink-800 bg-ink-900/60 px-3.5 py-1.5 text-sm text-ink-300">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sage-400 opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-sage-400" />
          </span>
          <span>
            <span className="font-mono text-ink-100">{presence.online.toLocaleString()}</span> people
            online right now
          </span>
        </p>
      )}
    </div>
  );
}

function RotatingLine(): JSX.Element {
  const [index, setIndex] = useState(0);
  const lengthRef = useRef(SEARCHING_LINES.length);

  useEffect(() => {
    const id = window.setInterval(() => setIndex((n) => (n + 1) % lengthRef.current), 2600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <p
      key={index}
      className="mt-12 animate-fade-in font-display text-2xl font-medium text-ink-100"
    >
      {SEARCHING_LINES[index]}
    </p>
  );
}

/**
 * One line of what a partner declared: "24 · Woman · India".
 *
 * The name is deliberately absent — it is already the header. Returns null
 * rather than an empty string when nothing was declared, so the caller falls
 * back to "Anonymous" instead of rendering a gap.
 *
 * None of this is verified, and the interface should never imply it is. It
 * appears as a quiet subtitle rather than a badge for exactly that reason: a
 * badge reads as a credential.
 */
function describeProfile(profile: Profile | null): string | null {
  if (!profile) return null;
  const parts: string[] = [];
  if (profile.age !== null) parts.push(String(profile.age));
  if (profile.gender) parts.push(GENDER_LABELS[profile.gender] ?? profile.gender);
  if (profile.country) {
    parts.push(COUNTRY_NAMES[profile.country as keyof typeof COUNTRY_NAMES] ?? profile.country);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Seconds remaining until an ISO deadline, ticking, or null when there is none.
 *
 * A countdown rather than a spinner because the two answer different questions.
 * A spinner says "something is happening"; this says "how long you have to
 * wait, and that it is bounded" — which is what somebody staring at a paused
 * conversation actually wants to know.
 */
function useCountdown(until: string | null): number | null {
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    if (until === null) {
      setLeft(null);
      return;
    }
    const deadline = new Date(until).getTime();
    const tick = (): void => {
      setLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 500);
    return () => window.clearInterval(timer);
  }, [until]);

  return left;
}
