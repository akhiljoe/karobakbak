/**
 * The profile editor itself, shared by the landing card and Settings.
 *
 * One component rather than two copies: they are the same four fields with the
 * same bounds and the same disclosure warning, and a second copy would drift —
 * a field added in one place and not the other is a setting that appears to
 * exist and does not.
 */
import type { ReactNode } from 'react';
import { Eraser } from 'lucide-react';

import {
  COUNTRY_CODES,
  COUNTRY_NAMES,
  MAX_DECLARED_AGE,
  MAX_DISPLAY_NAME_LENGTH,
  MIN_DECLARED_AGE,
  type Profile,
} from '../protocol/types';
import { GENDER_OPTIONS, isEmptyProfile } from '../profile';

interface ProfileFieldsProps {
  profile: Profile;
  onChange: (profile: Profile) => void;
  onClear: () => void;
  /**
   * Shown when the profile is edited while a conversation is already running.
   *
   * The declaration is sent when you join the queue, so an edit cannot reach
   * the person you are already talking to. Saying so is not a caveat, it is the
   * difference between the control working and appearing to.
   */
  appliesToNextMatch?: boolean;
}

/** Countries sorted by the name a person reads, not by the code. */
const COUNTRY_OPTIONS = [...COUNTRY_CODES]
  .map((code) => ({ code, name: COUNTRY_NAMES[code] }))
  .sort((a, b) => a.name.localeCompare(b.name));

export function ProfileFields({
  profile,
  onChange,
  onClear,
  appliesToNextMatch = false,
}: ProfileFieldsProps): JSX.Element {
  const empty = isEmptyProfile(profile);

  return (
    <div className="space-y-3">
      <Field label="Name" hint={`Up to ${MAX_DISPLAY_NAME_LENGTH} characters`}>
        <input
          type="text"
          value={profile.name ?? ''}
          maxLength={MAX_DISPLAY_NAME_LENGTH}
          placeholder="What should people call you?"
          onChange={(event) => onChange({ ...profile, name: orNull(event.target.value) })}
          className={inputClass}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Age">
          <input
            type="number"
            inputMode="numeric"
            min={MIN_DECLARED_AGE}
            max={MAX_DECLARED_AGE}
            value={profile.age ?? ''}
            placeholder={`${MIN_DECLARED_AGE}+`}
            onChange={(event) => onChange({ ...profile, age: parseAge(event.target.value) })}
            className={inputClass}
          />
        </Field>

        <Field label="Gender">
          <select
            value={profile.gender ?? ''}
            onChange={(event) => onChange({ ...profile, gender: orNull(event.target.value) })}
            className={inputClass}
          >
            <option value="">—</option>
            {GENDER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="Country">
        <select
          value={profile.country ?? ''}
          onChange={(event) => onChange({ ...profile, country: orNull(event.target.value) })}
          className={inputClass}
        >
          <option value="">Prefer not to say</option>
          {COUNTRY_OPTIONS.map((option) => (
            <option key={option.code} value={option.code}>
              {option.name}
            </option>
          ))}
        </select>
      </Field>

      <p className="text-xs leading-relaxed text-ink-500">
        Every stranger you match with sees this. Nothing here is checked by us, so treat what other
        people declare the same way. You must be {MIN_DECLARED_AGE} or over to use karobakbak.
        {appliesToNextMatch && (
          <>
            {' '}
            <span className="text-amber-300/90">
              Changes apply to your next conversation, not this one.
            </span>
          </>
        )}
      </p>

      {!empty && (
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1.5 text-xs text-ink-400 underline underline-offset-2 transition-colors hover:text-amber-300"
        >
          <Eraser className="h-3 w-3" />
          Clear and stay anonymous
        </button>
      )}
    </div>
  );
}

const inputClass =
  'w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-50 placeholder:text-ink-600 focus:border-amber-500 focus:outline-none';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-ink-300">
        {label}
        {hint && <span className="ml-1.5 font-normal text-ink-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

/** One line describing what is currently declared, for a collapsed summary. */
export function summariseProfile(profile: Profile): string {
  const parts: string[] = [];
  if (profile.name) parts.push(profile.name);
  if (profile.age !== null) parts.push(String(profile.age));
  if (profile.gender) {
    parts.push(
      GENDER_OPTIONS.find((option) => option.value === profile.gender)?.label ?? profile.gender,
    );
  }
  if (profile.country) {
    parts.push(COUNTRY_NAMES[profile.country as keyof typeof COUNTRY_NAMES] ?? profile.country);
  }
  return parts.join(' · ');
}

function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the age field without fighting the person typing it.
 *
 * An empty box is "not saying", not zero. Anything unparseable is dropped
 * rather than clamped, so a half-typed "1" on the way to "19" does not jump to
 * the minimum under the cursor — the server is the authority on the bound, and
 * the input's own `min` communicates it.
 */
function parseAge(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}
