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
import { useCallback, useEffect, useState } from 'react';

import { AppHeader } from './components/AppHeader';
import { useAutoSearch } from './hooks/useAutoSearch';
import { useBackButton } from './hooks/useBackButton';
import { useMatchNotification } from './hooks/useMatchNotification';
import { unlockSound } from './notify';
import { EMPTY_PROFILE, clearProfile, loadProfile, saveProfile } from './profile';
import type { Profile } from './protocol/types';
import { AuthModal } from './components/AuthModal';
import { ChatShell } from './components/ChatShell';
import { FiltersModal } from './components/FiltersModal';
import { LandingScreen } from './components/LandingScreen';
import { ReportDialog } from './components/ReportDialog';
import { SafetySheet } from './components/SafetySheet';
import { SettingsSheet } from './components/SettingsSheet';
import { Toast } from './components/Toast';
import { ACCOUNTS_ENABLED } from './features';
import { useChat } from './hooks/useChat';
import { usePreferences } from './hooks/usePreferences';
import type { ReportCategory } from './protocol/types';
import { connectionOf, phaseOf } from './view/presentation';

export function App(): JSX.Element {
  const chat = useChat();
  const { state } = chat;
  const { preferences, set: setPreference } = usePreferences();

  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [safetyOpen, setSafetyOpen] = useState(false);
  const [reporting, setReporting] = useState(false);

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
  const overlayOpen = filtersOpen || settingsOpen || authOpen || safetyOpen || reporting;

  // Enter starts a search from the landing screen; Escape skips a conversation.
  // Both are ignored while the user is typing into something, and Escape also
  // stands down whenever a dialog is open — there it means "close this".
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (phase === 'idle' && state.screen === 'idle' && event.key === 'Enter' && !overlayOpen) {
        event.preventDefault();
        chat.start();
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

  const showShell = phase === 'searching' || phase === 'chatting';

  useMatchNotification({ state, enabled: preferences.notifyOnMatch });

  // Back on a phone should leave the conversation, not the site. Active while
  // searching too: a search is a thing somebody equally wants to back out of.
  useBackButton({ active: showShell, onBack: chat.leave });

  // Browsers refuse to start audio without a user gesture. Starting a search is
  // the one gesture guaranteed to precede any match, so the context is unlocked
  // there rather than on load, where it would be refused.
  const startSearch = useCallback(() => {
    unlockSound();
    chat.start(profile);
  }, [chat, profile]);

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

  const resetProfile = useCallback(() => {
    setProfile(EMPTY_PROFILE);
    clearProfile();
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <AppHeader
        state={state}
        onHome={chat.leave}
        onOpenFilters={() => setFiltersOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenAuth={() => setAuthOpen(true)}
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
              onTyping={chat.typing}
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
              onProfileChange={updateProfile}
              onProfileClear={resetProfile}
            />
          )}
        </div>
      </main>

      <FiltersModal open={filtersOpen} onClose={() => setFiltersOpen(false)} />

      <SettingsSheet
        open={settingsOpen}
        preferences={preferences}
        profile={profile}
        inConversation={phase === 'chatting'}
        onClose={() => setSettingsOpen(false)}
        onChange={setPreference}
        onProfileChange={updateProfile}
        onProfileClear={resetProfile}
      />

      {/*
        Mounted only when accounts are enabled, which they are not. The modal
        guards itself as well, but a credential form that is never rendered is
        the stronger of the two controls.
      */}
      {ACCOUNTS_ENABLED && <AuthModal open={authOpen} onClose={() => setAuthOpen(false)} />}

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

      <Toast message={state.notice} onDismiss={chat.dismissNotice} />
    </div>
  );
}
