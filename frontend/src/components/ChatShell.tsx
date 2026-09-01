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
  Flag,
} from 'lucide-react';

import { useDuration } from '../hooks/useDuration';
import type { ChatState } from '../state/machine';
import { COUNTRY_NAMES, type Profile } from '../protocol/types';
import { GENDER_LABELS } from '../profile';
import { ACCOUNTS_ENABLED } from '../features';
import { HistoryPanel } from './HistoryPanel';
import { FriendsPanel } from './FriendsPanel';
import type { HistoryEntry } from '../history';
import {
  labelConnection,
  readConnections,
  removeConnection,
  type Connection,
} from '../connections';
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
  /**
   * Seconds until auto-search starts the next conversation, or null.
   *
   * Non-null means the last conversation has ended and the next one is coming
   * on its own. The shell stays mounted through it rather than handing back to
   * the landing screen: somebody who asked for the next stranger automatically
   * has said they are staying, and bouncing them out to the front door between
   * every pair - marketing copy, footer and all - is the product forgetting
   * what they just told it.
   */
  autoSearchIn?: number | null;
  /** Stop the countdown and stay put. */
  onCancelAutoSearch?: () => void;
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
  /** Opens the sign-in dialog, saying why. */
  onOpenAuth(reason: string): void;
  onTyping(active: boolean): void;
  onReact(messageId: string, reaction: string, active: boolean): void;
  /** Save this stranger, or withdraw it while the conversation is still running. */
  onSaveConnection(active: boolean): void;
  /** Decline the incoming request. Sends nothing; see §31. */
  onDismissConnectionRequest(): void;
  onSkip(): void;
  onCancelSearch(): void;
  onOpenSafety(): void;
  onBack(): void;
}

export function ChatShell({
  state,
  connection,
  searching,
  autoSearchIn = null,
  onCancelAutoSearch,
  icebreakersEnabled,
  autoSearch,
  onToggleAutoSearch,
  onBlockAndNext,
  onSend,
  history,
  onClearHistory,
  signedIn,
  onOpenAuth,
  onTyping,
  onReact,
  onSaveConnection,
  onDismissConnectionRequest,
  onSkip,
  onCancelSearch,
  onOpenSafety,
  onBack,
}: ChatShellProps): JSX.Element {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  /*
    An open menu closes on a tap anywhere else, and on Escape.

    Requiring a second tap on the same three dots is the behaviour of a menu
    that has trapped you: every other dismissable surface in this product goes
    away when you look elsewhere, and a person who has decided against the menu
    has already moved their thumb.

    `pointerdown`, not `mousedown` — this is used on a phone, and pointer events
    cover touch without waiting for the synthesised mouse event. The ref wraps
    the button *and* the menu, so tapping the button is never "outside": the
    close and the toggle would otherwise both fire and the menu would reopen.
  */
  useEffect(() => {
    if (!moreOpen) return;
    const onPointer = (event: PointerEvent): void => {
      if (moreRef.current !== null && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMoreOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);

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
  // The gap between two conversations, with the next one already on its way.
  // The transcript is cleared by the time this is true, so there is nothing to
  // preserve behind the overlay - only somewhere to stand.
  const advancing = autoSearchIn !== null;

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
            pulsing={searching || advancing}
          />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-sm font-semibold text-ink-50">
                {searching
                  ? 'Finding someone…'
                  : advancing
                    ? 'Up next'
                    : (state.partner?.profile?.name ?? state.partner?.nickname ?? 'Stranger')}
              </h2>
              <ConnectionStatus state={connection} />
            </div>
            <div className="flex h-4 items-center gap-2 text-xs text-ink-400">
              {searching ? (
                'Looking for a stranger'
              ) : advancing ? (
                'That conversation ended'
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
          {chatting && (
            <div className="relative shrink-0" ref={moreRef}>
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
                  {ACCOUNTS_ENABLED && (
                  <button
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      /*
                        Signed out, this asks rather than fails. The server
                        answers ACCOUNT_REQUIRED and always will — that check
                        stays, because a client is not where a rule lives — but
                        somebody pressing a button should not have to learn the
                        rule from an error.

                        The conversation survives the detour: signing in happens
                        in a popup, so this page never navigates and the socket
                        it holds stays open. They come back to the same chat and
                        press again.
                      */
                      if (!signedIn) {
                        onOpenAuth('To add people you meet. Your chat stays open.');
                        return;
                      }
                      onSaveConnection(!state.connectionSaved);
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
                  )}

                  {/*
                    No explanatory note under the button, in any state.

                    Three of them lived here in turn: a precondition for signed-
                    out visitors, a description of what asking does, and a
                    confirmation after asking. All three were prose inside a
                    menu, which is a list of actions - somebody opens it to
                    press something, not to read.

                    What each was carrying is still carried, somewhere it works
                    better. The precondition is the sign-in dialog that the tap
                    opens. The confirmation is the button itself, which reads
                    "Cancel request" once a request is out and "Friends" once it
                    is mutual - a control that states its own state, rather than
                    a sentence beside it that has to agree.

                    The reciprocity rule is unchanged and is still the reason
                    nothing is announced: telling somebody you asked would
                    disclose it without the agreement it was conditional on.
                  */}
                  {/*
                    Block and Report, in the same menu as Add friend rather than
                    beside it in the header. One control about this person, not
                    three competing for a phone's width.

                    Block keeps its own colour and sits directly above Report.
                    It was a labelled button out here for a reason worth
                    restating: it has to be findable in a hurry by somebody who
                    is uncomfortable, and behind a menu that costs a tap. What
                    the tap buys is that the menu is *one* place, in the header,
                    beside who it is about — rather than a control the eye has
                    to find among others. If that trade ever reads wrong, this
                    is the note to reverse.
                  */}
                  {state.features.block && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        onBlockAndNext();
                        setMoreOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-rose-300 transition-colors hover:bg-rose-500/10"
                    >
                      <ShieldX className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {/*
                        One word, and the action behind it still advances -
                        `onBlockAndNext` blocks and finds somebody new. That is
                        deliberate and was decided rather than overlooked: the
                        label read "Block and find someone else", which is the
                        longest item in a menu of three and describes the
                        consequence rather than the decision. Somebody reaching
                        for this wants out of *this* conversation, and going
                        somewhere else is what leaving it means here.

                        It is not the D39 case. Auto-search must never fire
                        after a block, and does not - `useAutoSearch` qualifies
                        only on `partner_left`. This is an explicit press, and
                        an explicit request to move on is not an automatic
                        behaviour deciding to move somebody on.
                      */}
                      Block
                    </button>
                  )}

                  {safetyAvailable && (
                    <button
                      role="menuitem"
                      onClick={() => {
                        onOpenSafety();
                        setMoreOpen(false);
                      }}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50"
                    >
                      <Flag className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      Report
                    </button>
                  )}
                </div>
              )}
            </div>
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

          {advancing && autoSearchIn !== null && (
            <AdvancingOverlay
              seconds={autoSearchIn}
              notice={state.notice}
              onCancel={onCancelAutoSearch}
            />
          )}

          {showIcebreaker && (
            <IcebreakerBar onUse={onSend} onDismiss={() => setIcebreakerDismissed(true)} />
          )}

          <div
            className={`flex-1 overflow-hidden transition-opacity duration-300 ${
              searching || advancing ? 'pointer-events-none opacity-0' : 'opacity-100'
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
      {/*
        The incoming ask, above the action row and below the transcript, so it
        is between the conversation and the controls rather than covering
        either. Not a modal: it is not urgent, it must not interrupt typing, and
        a dialog over a live conversation is the wrong weight for a question
        that can simply be left alone.

        Three answers, and only two of them send anything. Ignore dismisses it
        here and tells the asker nothing — a refusal is never disclosed (§31),
        which is the half of D47 that did not change.
      */}
      {chatting && state.connectionAsked && !state.connectionMade && (
        <div className="mx-auto mb-1 flex w-full max-w-3xl flex-wrap items-center gap-2 rounded-xl border border-amber-400/35 bg-amber-400/5 px-3 py-2 text-xs">
          <UserPlus className="h-3.5 w-3.5 shrink-0 text-amber-300" aria-hidden="true" />
          <span className="flex-1 text-ink-200">They would like to stay in touch.</span>
          <button
            onClick={() => {
              onSaveConnection(true);
              onDismissConnectionRequest();
            }}
            className="rounded-lg border border-green-500/40 px-2.5 py-1 font-medium text-green-300 transition-colors hover:bg-green-500/10"
          >
            Add back
          </button>
          <button
            onClick={onDismissConnectionRequest}
            className="rounded-lg border border-ink-700 px-2.5 py-1 text-ink-300 transition-colors hover:border-ink-600 hover:bg-ink-800"
          >
            Ignore
          </button>
          {state.features.block && (
            <button
              onClick={onBlockAndNext}
              className="rounded-lg border border-rose-500/40 px-2.5 py-1 text-rose-300 transition-colors hover:bg-rose-500/10"
            >
              Block
            </button>
          )}
        </div>
      )}

      {/*
        Visible while searching as well as while chatting. Waiting is exactly
        when somebody looks at who they met before — the list is most useful in
        the gap, and hiding it there made it disappear at the moment it was
        wanted. Nothing in it depends on there being a conversation.
      */}
      {(chatting || searching) && (
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
              onRename={async (handle, label) => {
                const saved = await labelConnection(handle, label);
                // Applied only on confirmation, so a failed save leaves the old
                // name on screen rather than a new one that was never stored.
                setConnections((was) =>
                  (was ?? []).map((c) => (c.handle === handle ? { ...c, label: saved } : c)),
                );
              }}
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
      {(chatting || searching) && (
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
              signedIn={signedIn}
              onSignIn={onOpenAuth}
              onClose={() => setHistoryOpen(false)}
              onClear={onClearHistory}
            />
          </div>

          {/*
            Only while there is somebody to skip. Searching already *is* looking
            for the next stranger, so the button would either do nothing or
            restart the thing it is sitting next to.

            A spacer keeps Recent in the middle rather than letting it slide
            right when this goes, which would move a control under the thumb
            that was aiming at something else.
          */}
          {chatting ? (
            <button
              onClick={onSkip}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs font-medium text-ink-200 transition-all hover:border-ink-600 hover:bg-ink-800 active:scale-95"
            >
              <SkipForward className="h-3.5 w-3.5" />
              Next stranger
            </button>
          ) : (
            <span aria-hidden="true" className="w-24 shrink-0" />
          )}
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

/**
 * The pause between two conversations, when the next one is automatic.
 *
 * Deliberately quieter than `SearchingOverlay`. Nothing is happening yet - the
 * countdown exists so the next stranger does not arrive before somebody has
 * registered that the last one left, and an animation would say "working" when
 * the honest state is "waiting a moment on purpose".
 *
 * Cancel is always offered and always visible. A countdown that cannot be
 * stopped is not a convenience, and this one starts on its own: somebody who
 * wants to stop and read what was said, or simply stop, must not have to race
 * it.
 */
function AdvancingOverlay({
  seconds,
  notice,
  onCancel,
}: {
  seconds: number;
  notice: string | null;
  onCancel?: (() => void) | undefined;
}): JSX.Element {
  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-ink-950 px-6 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full border border-ink-700 bg-ink-900 font-display text-2xl font-semibold text-amber-300">
        {seconds}
      </span>

      {/*
        The reducer's notice, which already says what happened and says it
        differently for a stranger leaving and for a block. Re-writing it here
        would be a second place to keep that distinction correct.
      */}
      {notice !== null && <p className="mt-4 text-sm text-ink-300">{notice}</p>}

      <p className="mt-1 text-sm text-ink-500">
        Finding someone new in {seconds}s
      </p>

      {onCancel && (
        <button
          onClick={onCancel}
          className="mt-5 rounded-xl border border-ink-700 px-4 py-2 text-sm text-ink-300 transition-colors hover:border-ink-600 hover:bg-ink-800 hover:text-ink-50"
        >
          Stay here
        </button>
      )}
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
