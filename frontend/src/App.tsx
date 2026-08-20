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

  const phase = phaseOf(state.screen);
  const connection = connectionOf(state.screen);

  // Any sheet about the current conversation is meaningless once it ends.
  useEffect(() => {
    if (state.screen !== 'chatting') {
      setSafetyOpen(false);
      setReporting(false);
    }
  }, [state.screen]);

  // Enter starts a search from the landing screen; Escape skips a conversation.
  // Both are ignored while the user is typing into something.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
      if (phase === 'idle' && state.screen === 'idle' && event.key === 'Enter') {
        event.preventDefault();
        chat.start();
      }
      if (phase === 'chatting' && event.key === 'Escape') chat.skip();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chat, phase, state.screen]);

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
              onStart={() => chat.start(profile)}
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
        blockAvailable={state.features.block}
        reportSent={state.reportSent}
        onClose={() => setSafetyOpen(false)}
        onReport={() => setReporting(true)}
        onBlock={chat.block}
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
