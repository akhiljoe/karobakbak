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
  Users,
} from 'lucide-react';

import { useDuration } from '../hooks/useDuration';
import type { ChatState } from '../state/machine';
import { COUNTRY_NAMES, type Profile } from '../protocol/types';
import { GENDER_LABELS } from '../profile';
import { ACCOUNTS_ENABLED } from '../features';
import { HistoryPanel } from './HistoryPanel';
import { FriendsPanel } from './FriendsPanel';
import type { HistoryEntry } from '../history';
import { readConnections, removeConnection, type Connection } from '../connections';
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
  /** Whether an account exists to have connections. */
  signedIn: boolean;
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
  signedIn,
  onTyping,
  onReact,
  onSaveConnection,
  onSkip,
  onCancelSearch,
  onOpenSafety,
  onBack,
}: ChatShellProps): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  // The overflow menu closes on Escape and on any click outside the header, the
  // same as every other menu here. It also closes when the conversation ends,
  // because it is a menu about a stranger who is no longer there.
  useEffect(() => {
    if (!moreOpen) return;
    const close = (): void => setMoreOpen(false);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [moreOpen]);


  const [friendsOpen, setFriendsOpen] = useState(false);
  const [connections, setConnections] = useState<readonly Connection[] | null>(null);
  const [connectionsFailed, setConnectionsFailed] = useState(false);

  /*
    Fetched when the panel opens rather than on mount: it is a list most people
    will never look at, and asking for it on every conversation would be a
    request per chat to render nothing. Re-fetched on each open, because the
    other side can remove a connection at any time and a stale list would offer
    a Remove for something already gone.
  */
  useEffect(() => {
    if (!friendsOpen) return;
    let live = true;
    setConnections(null);
    setConnectionsFailed(false);
    void readConnections().then((rows) => {
      if (!live) return;
      setConnections(rows ?? []);
      setConnectionsFailed(rows === null);
    });
    return () => {
      live = false;
    };
  }, [friendsOpen]);
  const chatting = state.screen === 'chatting';

  // A menu about a stranger who has gone should not still be open.
  useEffect(() => {
    if (!chatting) setMoreOpen(false);
  }, [chatting]);
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
          {/*
            The overflow menu, for the one control that is a choice about a
            person rather than about the conversation. Adding somebody is not
            urgent and not frequent, so it costs a tap; Block stays out here for
            the opposite reason — see the note above.
          */}
          {chatting && ACCOUNTS_ENABLED && (
            <div className="relative shrink-0">
              <button
                onClick={() => setMoreOpen((was) => !was)}
                aria-label="More about this stranger"
                aria-haspopup="menu"
                aria-expanded={moreOpen}
                className={`inline-flex h-12 w-10 shrink-0 items-center justify-center rounded-xl border transition-all active:scale-95 ${
                  moreOpen
                    ? 'border-amber-400/60 text-amber-300'
                    : 'border-ink-700 text-ink-300 hover:border-ink-600 hover:bg-ink-800'
                }`}
              >
                <MoreVertical className="h-4 w-4" aria-hidden="true" />
              </button>

              {moreOpen && (
                <div
                  role="menu"
                  aria-label="This stranger"
                  className="absolute right-0 top-full z-40 mt-2 w-48 animate-fade-in overflow-hidden rounded-xl border border-ink-700 bg-ink-900 p-1 shadow-lift"
                >
                  <button
                    role="menuitem"
                    onClick={() => {
                      onSaveConnection(!state.connectionSaved);
                      setMoreOpen(false);
                    }}
                    disabled={state.connectionMade}
                    aria-pressed={state.connectionSaved}
                    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors disabled:cursor-default ${
                      state.connectionSaved
                        ? 'text-amber-300 hover:bg-ink-800'
                        : 'text-ink-200 hover:bg-ink-800 hover:text-ink-50'
                    }`}
                  >
                    <UserPlus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    {/*
                      A menu item is an action, so it says what tapping does
                      rather than what state you are in. "Request sent" was a
                      status pretending to be a control: the tap undid the
                      request and nothing said so, which read as no way to
                      cancel at all. The old button carried that in a `title`,
                      which moved out with it and was not replaced.

                      Three states, and never a fourth for "they added you".
                      That frame does not exist: a request is disclosed only on
                      reciprocity, so there is nothing between "requested" and
                      "friends" for the interface to show.
                    */}
                    {state.connectionMade
                      ? 'Friends'
                      : state.connectionSaved
                        ? 'Cancel request'
                        : 'Add friend'}
                  </button>

                  {/*
                    Said here because here is where it is asked. A request that
                    produces no visible effect reads as a broken button, and the
                    silence is the whole point: telling them you asked would
                    disclose it without the reciprocity it was conditional on.
                  */}
                  {!state.connectionMade && (
                    <p className="px-3 pb-2 pt-0.5 text-[11px] leading-relaxed text-ink-500">
                      {state.connectionSaved
                        ? 'Sent. They are told only if they add you too.'
                        : 'They are told only if they add you back.'}
                    </p>
                  )}
                </div>
              )}
            </div>
          )}

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
        Connections: a list, and not an action.

        They belong to the conversation surface — both are about people you met
        while chatting, and on the landing screen they would be controls for
        something that has not happened yet.

        THEY ARE ON THE LEFT, AND A ROW ABOVE THE ACTIONS
        The first attempt put them right-aligned directly under "Next stranger",
        which is the mistake the note on Block already describes: that button is
        pressed dozens of times a session, and anything sharing an edge with a
        reflex gets pressed by accident. This row follows the same grammar as
        the one below it — choice on the left, action on the right — so these
        sit on the left, and a whole row of separation stands between them and
        the thing everybody is actually aiming for.

        Links rather than buttons, because they open lists instead of doing
        something, and quiet enough not to compete with Next stranger for
        attention.

        Both panels open upward: this is near the bottom of the viewport, and
        one dropping downward would open off-screen on a phone.
      */}
      {chatting && (
      <div className="flex items-center gap-4 px-3 pt-1 sm:px-4">
        {/*
          Connections. Only when signed in: the list belongs to
          an account, and a control that always opens "sign in to see this"
          would be the disabled-but-present shape `features.ts` argues against.
        */}
        {ACCOUNTS_ENABLED && signedIn && (
          <div className="relative">
            <button
              onClick={() => setFriendsOpen((was) => !was)}
              aria-haspopup="dialog"
              aria-expanded={friendsOpen}
              className={`inline-flex items-center gap-1.5 rounded text-xs underline underline-offset-2 transition-colors ${
                friendsOpen ? 'text-amber-300' : 'text-ink-500 hover:text-ink-300'
              }`}
            >
              <Users className="h-3 w-3" aria-hidden="true" />
              Connections
            </button>

            <FriendsPanel
              open={friendsOpen}
              connections={connections}
              failed={connectionsFailed}
              onClose={() => setFriendsOpen(false)}
              onRemove={async (handle) => {
                const done = await removeConnection(handle);
                // Only drop the row once the server confirmed it, or the panel
                // would show a connection as gone that is still there.
                if (done) {
                  setConnections((was) => (was ?? []).filter((c) => c.handle !== handle));
                }
                return done;
              }}
            />
          </div>
        )}
      </div>
      )}

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
            Recent sits in the middle: between the checkbox on the left and the
            action on the right, touching neither. It used to be a link off to
            one side; the middle is where a list belongs when the two things
            around it are a preference and a reflex.

            "Add friend" used to be here and has moved to the overflow menu in
            the header, beside the person it is about.
          */}
          <div className="relative">
            <button
              onClick={() => setHistoryOpen((was) => !was)}
              aria-haspopup="dialog"
              aria-expanded={historyOpen}
              className={`inline-flex shrink-0 items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-medium transition-all active:scale-95 ${
                historyOpen
                  ? 'border-amber-400/60 bg-ink-900 text-amber-300'
                  : 'border-ink-700 bg-ink-900 text-ink-200 hover:border-ink-600 hover:bg-ink-800'
              }`}
            >
              <Clock className="h-3.5 w-3.5" aria-hidden="true" />
              Recent
              {history.length > 0 && <span className="text-ink-500">{history.length}</span>}
            </button>

            <HistoryPanel
              open={historyOpen}
              entries={history}
              placement="up"
              onClose={() => setHistoryOpen(false)}
              onClear={onClearHistory}
            />
          </div>

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
