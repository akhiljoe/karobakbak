/**
 * Settings — the things a person can change about their own experience.
 *
 * Distinct from `FiltersModal`, which is about matchmaking and is currently
 * inert, and from `features.ts`, which is about what this build ships at all.
 * What is here takes effect immediately and is remembered in this browser.
 *
 * The copy is explicit that nothing here leaves the device, because in a
 * product whose entire proposition is anonymity, a settings screen is exactly
 * where somebody will wonder what is being stored about them.
 */
import { useEffect } from 'react';
import { Settings, X } from 'lucide-react';

import type { Preferences } from '../preferences';
import type { Profile } from '../protocol/types';
import { Button } from './Button';
import { ProfileFields } from './ProfileFields';

interface SettingsSheetProps {
  open: boolean;
  preferences: Preferences;
  profile: Profile;
  /** True while a conversation is running, so the editor can say what an edit reaches. */
  inConversation: boolean;
  onClose(): void;
  onChange<K extends keyof Preferences>(key: K, value: Preferences[K]): void;
  onProfileChange(profile: Profile): void;
  onProfileClear(): void;
}

export function SettingsSheet({
  open,
  preferences,
  profile,
  inConversation,
  onClose,
  onChange,
  onProfileChange,
  onProfileClear,
}: SettingsSheetProps): JSX.Element | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
    >
      <div className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative max-h-[90dvh] w-full max-w-md animate-fade-in overflow-y-auto rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl sm:p-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-ink-50">
            <Settings className="h-4 w-4 text-amber-400" />
            Settings
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <section className="mb-4">
          <h3 className="mb-2 px-1 text-xs font-semibold uppercase tracking-wider text-ink-400">
            About you
          </h3>
          <div className="rounded-xl border border-ink-700 bg-ink-950 px-3.5 py-3">
            <ProfileFields
              profile={profile}
              onChange={onProfileChange}
              onClear={onProfileClear}
              appliesToNextMatch={inConversation}
            />
          </div>
        </section>

        <Toggle
          label="Conversation starters"
          description="Offer a suggested opening line when you match with someone. Off by default."
          checked={preferences.icebreakers}
          onChange={(value) => onChange('icebreakers', value)}
        />

        <p className="mt-4 px-1 text-xs leading-relaxed text-ink-500">
          Settings are kept in this browser. Your preferences never leave it; what you declare above
          is sent to the person you match with, and to nobody else. Clearing your site data resets
          both.
        </p>

        <Button variant="secondary" className="mt-4 w-full" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Toggle({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange(value: boolean): void;
}): JSX.Element {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-700 bg-ink-950 px-3.5 py-3 transition-colors hover:border-ink-600">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 h-4 w-4 shrink-0 accent-amber-400"
      />
      <span className="flex-1">
        <span className="block text-sm font-medium text-ink-100">{label}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-ink-500">{description}</span>
      </span>
    </label>
  );
}
