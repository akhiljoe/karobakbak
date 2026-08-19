import { useCallback, useState } from 'react';

import {
  loadPreferences,
  savePreferences,
  type Preferences,
} from '../preferences';

export interface PreferencesApi {
  readonly preferences: Preferences;
  /** Change one setting. Applies immediately and persists if it can. */
  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void;
}

/**
 * The stored preferences, as React state.
 *
 * Read once on mount via the lazy initialiser rather than on every render:
 * `localStorage` is synchronous and touching it during render is a needless
 * cost on every keystroke elsewhere in the tree.
 *
 * Storage is written on change and never read again, so two tabs will not see
 * each other's edits until reload. That is fine for what lives here — a
 * preference is not shared state, and a `storage` event listener would be
 * machinery in service of a case nobody has.
 */
export function usePreferences(): PreferencesApi {
  const [preferences, setPreferences] = useState<Preferences>(() => loadPreferences());

  const set = useCallback(
    <K extends keyof Preferences>(key: K, value: Preferences[K]): void => {
      setPreferences((current) => {
        const next = { ...current, [key]: value };
        savePreferences(next);
        return next;
      });
    },
    [],
  );

  return { preferences, set };
}
