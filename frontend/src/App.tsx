/**
 * The application shell.
 *
 * One layout at a time, chosen by the state machine. The controls a user sees
 * are gated on `features` from the `connected` frame, so this build never
 * offers a button for something the server has turned off — a client that
 * discovers a capability through a rejection is a client that has to explain
 * the rejection.
 *
 * Everything this file knows about the session comes from `useChat`. It holds
 * only the state that is genuinely about the interface: which sheet is open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { AgeGate } from './components/AgeGate';
import { AppHeader } from './components/AppHeader';
import { useAutoSearch } from './hooks/useAutoSearch';
import { useBackButton } from './hooks/useBackButton';
import { useMatchNotification } from './hooks/useMatchNotification';
import { unlockSound } from './notify';
import {
  EMPTY_PROFILE,
  clearProfile,
  loadPreferences,
  loadProfile,
  loadMatchIntent,
  savePreferences,
  saveProfile,
  saveMatchIntent,
} from './profile';
import type { MatchPreferences, Profile } from './protocol/types';
import { AuthModal } from './components/AuthModal';
import { ChatShell } from './components/ChatShell';
import { FiltersModal } from './components/FiltersModal';
import { LandingScreen } from './components/LandingScreen';
import { SiteFooter } from './components/SiteFooter';
import { consumeChatRequest } from './intent';
import { ReportDialog } from './components/ReportDialog';
import { SafetySheet } from './components/SafetySheet';
import { SettingsSheet } from './components/SettingsSheet';
import { Toast } from './components/Toast';
import { acknowledgeAge, hasAcknowledgedAge } from './agegate';
import { clientConfig } from './config';
import { ACCOUNTS_ENABLED, FILTERS_AVAILABLE } from './features';
import { useChat } from './hooks/useChat';
import { usePreferences } from './hooks/usePreferences';
import { useSession } from './hooks/useSession';
import {
  acceptReconnect,
  clearHistory,
  readHistory,
  recordHistory,
  type HistoryEntry,
} from './history';
import type { ReportCategory } from './protocol/types';
import { connectionOf, phaseOf } from './view/presentation';

export function App(): JSX.Element {
  const chat = useChat();
  const { state } = chat;
  const { preferences, set: setPreference } = usePreferences();
  const session = useSession();

  const [history, setHistory] = useState<readonly HistoryEntry[]>(() => readHistory());

  /**
   * Remember the stranger while the conversation is live, and file them when it
   * ends.
   *
   * A ref rather than state, because writing it must not re-render: it changes
   * on every match and nothing displays it. The reducer clears `partner` as
   * part of ending a conversation — correctly, since nothing should still be
   * rendering a stranger who has gone — so by the time the end is observable
   * the thing worth recording is already gone from state. This holds it.
   */
  const met = useRef<HistoryEntry | null>(null);

  useEffect(() => {
    if (state.partner === null) return;
    met.current = {
      at: Date.now(),
      nickname: state.partner.nickname,
      colour: state.partner.colour,
      country: state.partner.profile?.country ?? null,
      // Null for a partner who was signed out, or who turned presence off. No
      // token means no dot, and nothing about them is remembered.
      presence: state.partnerPresence,
    };
  }, [state.partner]);

  useEffect(() => {
    // `matchId` going null is the one signal that means "that conversation is
    // over", and it covers every ending: they left, you skipped, you blocked,
    // the socket dropped past its grace window. Watching `screen` instead would
    // miss the transitions that go straight back to searching.
    if (state.matchId !== null || met.current === null) return;
    setHistory(recordHistory(met.current));
    met.current = null;
  }, [state.matchId]);

  /**
   * What to say about a sign-in that has just come back from the provider.
   *
   * The failed case says *nothing was changed*, deliberately. The natural
   * reading of a silent failure is that something half-happened — an account
   * made, an address kept — and none of it is true: a refused exchange leaves
   * the server exactly as it was, and saying so is cheaper than the support
   * question that follows from not saying it.
   */
  const signinNotice =
    session.outcome === 'ok'
      ? 'Signed in.'
      : session.outcome === 'failed'
        ? 'Sign-in did not finish. Nothing was changed.'
        : null;

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  // Why the sign-in dialog was opened, when something asked for it. Cleared on
  // close, so opening it from the header later does not inherit an explanation
  // for something the person is no longer doing.
  const [authReason, setAuthReason] = useState<string | null>(null);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [reporting, setReporting] = useState(false);
  /**
   * Whether the age gate is on screen *now*.
   *
   * Separate from `ageAcknowledged`, which is the durable fact. The gate used
   * to be shown for the whole of `!ageAcknowledged`, which made it the first
   * thing a visitor saw — a wall in front of a product they had not seen yet.
   *
   * `docs/policies/age-gate.md` asks for something narrower than that, twice:
   * "a blocking interstitial **before the first conversation**", and "what the
   * gate blocks is entering the queue, not opening the connection". It also
   * requires Terms and Privacy to be "reachable **without** passing the gate",
   * which a gate covering the landing screen made impossible — the only way to
   * those links was through the thing they were supposed to be reachable
   * around.
   *
   * So it opens when somebody tries to start a conversation. Same gate, same
   * copy, same refusal to close on Escape or a backdrop click; it is asked at
   * the moment it is actually about, which is the moment the policy names.
   */
  const [gateOpen, setGateOpen] = useState(false);

  /*
    Read once, on the first render, rather than in an effect. The gate no
    longer covers the landing screen — it opens when somebody starts a
    conversation — so the old reason for this (avoiding one painted frame of
    landing screen before the gate appeared) is gone. It stays synchronous for a
    smaller but still real one: `startSearch` reads `ageAcknowledged`, and a
    value that arrives an effect late would let the very first press through
    ungated.

    Storage being unreadable resolves to `false`, which shows the gate. That is
    the correct direction to fail.
  */
  const [ageAcknowledged, setAgeAcknowledged] = useState(hasAcknowledgedAge);

  const phase = phaseOf(state);
  const connection = connectionOf(state.screen);

  // Any sheet about the current conversation is meaningless once it ends — but
  // a dropped socket is not the conversation ending (§28), and closing a report
  // dialog mid-blip would throw away a note somebody was part-way through
  // writing. Keyed on the phase, which knows the difference.
  useEffect(() => {
    if (phase !== 'chatting') {
      setSafetyOpen(false);
      setReporting(false);
    }
  }, [phase]);

  /**
   * Whether anything is layered over the conversation.
   *
   * Every one of these dialogs closes itself on Escape, with its own
   * `window` keydown listener. So does the shortcut below — and two
   * bubble-phase listeners on the same target both run, so Escape used to
   * close the sheet *and* skip the stranger. Skipping is irreversible: the
   * match is torn down server-side and that person cannot be reached again, so
   * somebody who opened the safety sheet because they were uncomfortable and
   * pressed Escape to back out lost the conversation they were about to
   * report. This is the state the shortcut consults to stand down.
   */
  // The gate counts as an overlay, so the global Enter and Escape shortcuts
  // below stand down while it is showing. Escape skips a conversation, and a
  // keypress reaching past this screen would be acting on a product the person
  // has not yet been allowed into.
  const overlayOpen =
    gateOpen ||
    filtersOpen ||
    settingsOpen ||
    authOpen ||
    safetyOpen ||
    reporting;

  // Enter starts a search from the landing screen; Escape skips a conversation.
  // Both are ignored while the user is typing into something, and Escape also
  // stands down whenever a dialog is open — there it means "close this".
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (phase === 'idle' && state.screen === 'idle' && event.key === 'Enter' && !overlayOpen) {
        event.preventDefault();
        chat.start(profile, matchPreferences, matchIntent);
      }
      if (phase === 'chatting' && event.key === 'Escape' && !overlayOpen) chat.skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat, overlayOpen, phase, state.screen]);

  const submitReport = useCallback(
    (category: ReportCategory, note: string) => {
      chat.report(category, note);
      setReporting(false);
    },
    [chat],
  );

  // Read once on mount: localStorage is synchronous and touching it during
  // render would cost on every keystroke elsewhere in the tree.
  const [profile, setProfile] = useState<Profile>(() => loadProfile());
  // Kept beside the profile and sent with it: both ride on `join_queue`, and
  // both are re-sent every time because the server keeps nothing between
  // sessions.
  const [matchPreferences, setMatchPreferences] = useState<MatchPreferences>(() =>
    loadPreferences(),
  );
  // A third thing riding the same join, and deliberately its own piece of state
  // rather than a field on the profile: `Profile` is what the other side is
  // shown, and this is the one declaration that is not (D45, §30.1).
  const [matchIntent, setMatchIntent] = useState<string | null>(() => loadMatchIntent());

  const showShell = phase === 'searching' || phase === 'chatting';

  useMatchNotification({ state, enabled: preferences.notifyOnMatch });

  // Back on a phone should leave the conversation, not the site. Active while
  // searching too: a search is a thing somebody equally wants to back out of.
  useBackButton({ active: showShell, onBack: chat.leave });

  // Browsers refuse to start audio without a user gesture. Starting a search is
  // the one gesture guaranteed to precede any match, so the context is unlocked
  // there rather than on load, where it would be refused.
  /*
    Both sides agreed to talk again, so both start looking — through the
    ordinary search, because the server has already put them in a private queue
    lane and ordinary matchmaking is what pairs them there. Nothing about this
    path is reconnect-specific, which is why every guard that applies to a
    random match applies here too.
  */
  useEffect(() => {
    if (!state.reconnectReady) return;
    chat.reconnectStarted();
    startSearch();
  }, [state.reconnectReady]);

  const startSearch = useCallback(() => {
    // The last moment before a conversation starts, which is exactly where the
    // policy puts the gate. Acknowledging carries straight on into the search,
    // because the person already asked for that by pressing the button.
    if (!ageAcknowledged) {
      setGateOpen(true);
      return;
    }
    unlockSound();
    chat.start(profile, matchPreferences, matchIntent);
  }, [ageAcknowledged, chat, matchIntent, matchPreferences, profile]);

  /**
   * Block this person and move on, in one action.
   *
   * Auto-search deliberately refuses to fire after a block — being dropped into
   * a new conversation seconds after blocking someone contradicts what blocking
   * meant. This is not that: the button says "next", so the person asked. An
   * explicit request and an automatic behaviour are different things, and only
   * the automatic one needs protecting against.
   *
   * Both frames go out on the same socket in order, so the server ends the
   * match and then queues the join; no wait is needed between them.
   */
  const blockAndNext = useCallback(() => {
    chat.block();
    startSearch();
  }, [chat, startSearch]);

  const autoSearch = useAutoSearch({
    state,
    enabled: preferences.autoSearch,
    onSearch: startSearch,
  });

  // Held in the browser, re-sent on every join. The server keeps nothing
  // between sessions, so this is the only place the declaration lives.
  const updateProfile = useCallback((next: Profile) => {
    setProfile(next);
    saveProfile(next);
  }, []);

  const updateMatchIntent = useCallback((next: string | null) => {
    setMatchIntent(next);
    saveMatchIntent(next);
  }, []);

  /*
   * "Start chatting", pressed on a page that has no socket.
   *
   * `App` is mounted only on `/`, so a CTA on About or Terms can do no more
   * than record the request (`intent.ts`) and navigate here. This is where it
   * is honoured.
   *
   * It waits for the connection rather than firing on mount, because
   * `chat.start` goes through `sendCommand`, which **returns false and drops
   * the frame** when the socket is not open yet. Mounting and immediately
   * joining would therefore do nothing at all on a cold navigation — the join
   * would vanish and the visitor would sit on the landing screen having pressed
   * a button twice. `connecting` is the same condition the landing button
   * disables itself on, so the two agree by construction.
   *
   * The request is read once, into a ref, so that a re-render cannot re-arm it,
   * and it is cleared before `startSearch` runs so a failure to connect does
   * not leave it primed for later.
   */
  const pendingStart = useRef(consumeChatRequest());
  const connecting =
    state.screen === 'connecting' || state.screen === 'disconnected';

  useEffect(() => {
    if (!pendingStart.current || connecting) return;
    pendingStart.current = false;
    startSearch();
  }, [connecting, startSearch]);

  const acceptAge = useCallback(() => {
    acknowledgeAge();
    // Set regardless of whether the write succeeded. A private window cannot
    // remember the acknowledgement, and refusing to proceed because of that
    // would punish somebody for their browser settings; they are asked again
    // next time instead.
    setAgeAcknowledged(true);
    setGateOpen(false);
    // Carry on into the search they asked for. Making them press "Start" a
    // second time would read as the gate having failed.
    unlockSound();
    chat.start(profile, matchPreferences, matchIntent);
  }, [chat, matchIntent, matchPreferences, profile]);

  const leaveFromGate = useCallback(() => {
    // `about:blank` rather than `window.close()`, which browsers refuse for a
    // tab the script did not open. Leaving has to actually leave.
    window.location.href = 'about:blank';
  }, []);

  // Clears the profile only. The intent is not part of it and is not shown to
  // anybody, so "clear and stay anonymous" has nothing to clear here — wiping
  // it too would silently turn off a matching control the button never
  // mentioned.
  const resetProfile = useCallback(() => {
    setProfile(EMPTY_PROFILE);
    clearProfile();
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/*
        Rendered over the shell rather than instead of it, so the socket is
        already connecting while the gate is up: `age-gate.md` gates *entering
        the queue*, not opening the connection. Nothing behind this can be
        reached — every control that starts a conversation is on the landing
        screen underneath, and `overlayOpen` stands the keyboard shortcuts down.
      */}
      {gateOpen && (
        <AgeGate
          termsUrl={clientConfig.legal.termsUrl}
          privacyUrl={clientConfig.legal.privacyUrl}
          onAccept={acceptAge}
          onLeave={leaveFromGate}
        />
      )}

      <AppHeader
        state={state}
        onHome={chat.leave}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAuth={() => {
          setAuthReason(null);
          setAuthOpen(true);
        }}
        session={session}
      />

      <main className="flex flex-1 overflow-hidden">
        <div className="flex-1 overflow-hidden">
          {showShell ? (
            <ChatShell
              state={state}
              connection={connection}
              searching={phase === 'searching'}
              icebreakersEnabled={preferences.icebreakers}
              autoSearch={preferences.autoSearch}
              onToggleAutoSearch={(value) => setPreference('autoSearch', value)}
              onBlockAndNext={blockAndNext}
              onSend={chat.send}
              history={history}
              onClearHistory={() => setHistory(clearHistory())}
              signedIn={session.signedIn}
              onOpenAuth={(reason) => {
                setAuthReason(reason);
                setAuthOpen(true);
              }}
              onTyping={chat.typing}
              onReact={chat.react}
              onSaveConnection={chat.saveConnection}
              onDismissConnectionRequest={chat.dismissConnectionRequest}
              onSkip={chat.skip}
              onCancelSearch={chat.leave}
              onOpenSafety={() => setSafetyOpen(true)}
              onBack={chat.leave}
            />
          ) : (
            <LandingScreen
              state={state}
              ended={phase === 'ended'}
              onStart={startSearch}
              autoSearchIn={autoSearch.secondsLeft}
              onCancelAutoSearch={autoSearch.cancel}
              profile={profile}
            />
          )}
        </div>
      </main>

      {/*
        The footer belongs to the landing screen, and to nothing past it.
        --------------------------------------------------------------------
        Every link here leaves `/`, which unmounts this component and drops the
        WebSocket — `Root.tsx` reasons about exactly that and concludes it is
        acceptable *because the footer only renders where no conversation is in
        progress*. `showShell` is that condition: it is true while searching and
        while chatting, and false on the landing and ended screens.

        So this is not a styling choice that could be relaxed later. Rendering
        this inside `ChatShell` would put a one-click socket-drop beside a live
        conversation, which is the thing the comment in `Root.tsx` is promising
        does not exist.
      */}
      {!showShell && <SiteFooter width="full" />}

      {/* Unmounted with its button: nothing can open it, so nothing renders it. */}
      {FILTERS_AVAILABLE && (
        <FiltersModal
          open={filtersOpen}
          onClose={() => setFiltersOpen(false)}
          preferences={matchPreferences}
          onChange={(next) => {
            setMatchPreferences(next);
            savePreferences(next);
          }}
        />
      )}

      <SettingsSheet
        open={settingsOpen}
        preferences={preferences}
        profile={profile}
        inConversation={phase === 'chatting'}
        onClose={() => setSettingsOpen(false)}
        onChange={setPreference}
        onProfileChange={updateProfile}
        onProfileClear={resetProfile}
        intent={matchIntent}
        onIntentChange={updateMatchIntent}
      />

      {/*
        Mounted only when accounts are enabled. There is no credential form
        behind this any more — the modal's only action is a navigation to the
        provider — but the mount guard stays, because the flag is what says the
        server has the four routes registered at all.
      */}
      {ACCOUNTS_ENABLED && (
        <AuthModal
          open={authOpen}
          reason={authReason}
          onClose={() => {
            setAuthOpen(false);
            setAuthReason(null);
          }}
          session={session}
        />
      )}

      <SafetySheet
        open={safetyOpen}
        reportAvailable={state.features.report}
        reportSent={state.reportSent}
        onClose={() => setSafetyOpen(false)}
        onReport={() => setReporting(true)}
      />

      {reporting && (
        <ReportDialog
          maxNoteLength={state.limits?.maxReportNoteLength ?? 500}
          onCancel={() => setReporting(false)}
          onSubmit={submitReport}
        />
      )}

      {/*
        One toast, and the sign-in outcome wins the tie.

        It is reported exactly once per return from the provider and it is the
        only feedback that a redirect the user just watched actually finished;
        a chat notice will still be there afterwards, while this one has no
        second chance to be shown. `useSession` strips the marker from the URL
        as it reads it, so a refresh does not re-announce it.
      */}
      {/*
        An offer from somebody met earlier, waiting to be answered.

        Rendered over the landing screen rather than as a dialog: it is not
        urgent, it expires on its own in two minutes, and it must not sit in
        front of somebody who is about to press Start chatting. Ignoring it is
        the default in the strongest sense — doing nothing at all is a refusal,
        and no refusal is ever sent.
      */}
      {state.reconnectOffer !== null && (
        <div className="pointer-events-auto fixed inset-x-3 top-16 z-40 mx-auto max-w-sm animate-fade-in rounded-xl border border-green-500/40 bg-ink-900 p-3 shadow-2xl ring-1 ring-black/50">
          <p className="mb-2 text-sm text-ink-100">
            Someone you talked to earlier is here and would like to chat again.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                const offer = state.reconnectOffer;
                /*
                  Signed out, this offers the way through rather than failing.
                  The offer lives two minutes, which is comfortably longer than
                  a sign-in popup takes — and the popup does not navigate this
                  page, so the request is still waiting afterwards.
                */
                if (!session.signedIn) {
                  setAuthReason('Sign in to chat with them again.');
                  setAuthOpen(true);
                  return;
                }
                chat.dismissReconnect();
                if (offer !== null) void acceptReconnect(offer);
              }}
              className="rounded-lg border border-green-500/50 px-3 py-1.5 text-xs font-medium text-green-300 transition-colors hover:bg-green-500/10"
            >
              {session.signedIn ? 'Chat' : 'Sign in to chat'}
            </button>
            <button
              onClick={chat.dismissReconnect}
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-xs text-ink-300 transition-colors hover:bg-ink-800"
            >
              Ignore
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
            {session.signedIn
              ? 'Ignoring tells them nothing.'
              : 'Talking to a chosen person needs an account. Ignoring tells them nothing.'}
          </p>
        </div>
      )}

      <Toast
        message={signinNotice ?? state.notice}
        onDismiss={signinNotice === null ? chat.dismissNotice : session.dismissOutcome}
      />
    </div>
  );
}
