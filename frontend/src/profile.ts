/**
 * What this person chooses to tell strangers about themselves.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT IN preferences.ts
 * ---------------------------------------------------------------------------
 * A preference decides what the interface shows and never leaves the browser.
 * A profile is *sent to another person*. Different lifetime, different
 * consequence, and `preferences.ts` states plainly that it holds no
 * identifiers — a declared name and age sit close enough to that line that
 * putting them there would blur a rule worth keeping sharp.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS STORED HERE AND NOT ON THE SERVER
 * ---------------------------------------------------------------------------
 * So the user types it once, and no further. The server keeps nothing between
 * sessions: the profile is re-sent on every `join_queue` and lives only as long
 * as the session does.
 *
 * That is the whole point. A profile the *server* kept against a durable
 * identifier — the block token, an IP hash — would be a stable record of a
 * person across conversations, which is exactly the cross-chat correlator the
 * design forbids (DESIGN.md §24.3). Keeping it in the browser means the person
 * holds their own declaration and can drop it by clearing site data, with no
 * server-side trace to delete.
 *
 * Every access is guarded: `localStorage` throws in private modes and when a
 * browser blocks site data, and a profile failing to load must never be the
 * reason a conversation cannot happen.
 */
import {
  EMPTY_PROFILE,
  GENDERS,
  MAX_DECLARED_AGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DECLARED_AGE,
  isCountryCode,
  isGender,
  isVibe,
  type Profile,
} from './protocol/types';

const STORAGE_KEY = 'karobakbak.profile.v1';

export { EMPTY_PROFILE };

/**
 * Read the stored profile, dropping anything that no longer validates.
 *
 * Field by field rather than all-or-nothing: a stored gender that was removed
 * from `GENDERS`, or an age below a raised minimum, should cost that one field
 * and not the whole declaration. The server validates again regardless — this
 * only spares the user a rejected join for something they cannot see.
 */
export function loadProfile(storage: Storage | undefined = safeStorage()): Profile {
  if (!storage) return EMPTY_PROFILE;

  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return EMPTY_PROFILE;
  }
  if (raw === null) return EMPTY_PROFILE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_PROFILE;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return EMPTY_PROFILE;

  const value = parsed as Record<string, unknown>;
  return {
    name: cleanName(value.name),
    country: isCountryCode(value.country) ? value.country : null,
    age: cleanAge(value.age),
    gender: isGender(value.gender) ? value.gender : null,
    vibe: isVibe(value.vibe) ? value.vibe : null,
  };
}

/** Persist, or quietly do nothing when storage is unavailable. */
export function saveProfile(profile: Profile, storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // Full, or blocked. The declaration still applies to this session; it just
    // will not survive a reload, which is not worth failing anything over.
  }
}

/** Forget it entirely — the "clear" button, and the honest version of it. */
export function clearProfile(storage: Storage | undefined = safeStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to be done, and nothing depends on it.
  }
}

/** Whether anything at all was declared. */
export function isEmptyProfile(profile: Profile): boolean {
  return (
    profile.name === null &&
    profile.country === null &&
    profile.age === null &&
    profile.gender === null
  );
}

/**
 * Display labels. The wire value stays the full word.
 *
 * Short forms because this sits inline in a chat header beside an age and a
 * country — "24 · F · India" reads at a glance where "24 · Woman · India"
 * crowds it. The protocol keeps `female`/`male`, so the stored evidence and the
 * moderation console stay unambiguous for someone reading a case months later,
 * where a bare "F" is worse than useless.
 */
export const GENDER_LABELS: Record<string, string> = {
  female: 'F',
  male: 'M',
  nonbinary: 'NB',
  other: 'Other',
};

export const GENDER_OPTIONS = GENDERS.map((value) => ({
  value,
  label: GENDER_LABELS[value] ?? value,
}));

function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().slice(0, MAX_DISPLAY_NAME_LENGTH);
  return trimmed.length > 0 ? trimmed : null;
}

function cleanAge(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  if (value < MIN_DECLARED_AGE || value > MAX_DECLARED_AGE) return null;
  return value;
}

function safeStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
