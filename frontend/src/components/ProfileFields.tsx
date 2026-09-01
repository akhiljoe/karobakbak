/**
 * The profile editor itself, shared by the landing card and Settings.
 *
 * One component rather than two copies: they are the same four fields with the
 * same bounds and the same disclosure warning, and a second copy would drift —
 * a field added in one place and not the other is a setting that appears to
 * exist and does not.
 */
import { useState } from 'react';
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
import { GENDER_OPTIONS, INTENT_OPTIONS, isEmptyProfile } from '../profile';

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
  /**
   * The declared intent, and its setter.
   *
   * Passed separately from `profile` rather than added to it, because `Profile`
   * is defined as the thing the other side is shown (D45, §30.1). Keeping the
   * two apart here means the sentence under the profile fields — "every
   * stranger you match with sees this" — stays true, which it would not be if
   * intent were one more entry in the same grid.
   */
  intent: string | null;
  onIntentChange: (intent: string | null) => void;
}

/** Countries sorted by the name a person reads, not by the code. */

export function ProfileFields({
  profile,
  onChange,
  onClear,
  appliesToNextMatch = false,
  intent,
  onIntentChange,
}: ProfileFieldsProps): JSX.Element {
  // The raw string, because "1" and "01" parse the same and only one of
  // them is somebody halfway through typing "18".
  const [ageText, setAgeText] = useState(profile.age === null ? '' : String(profile.age));
  const minorDeclared = declaresMinor(ageText, profile.age);

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
            aria-invalid={minorDeclared}
            aria-describedby={minorDeclared ? 'age-minor-warning' : undefined}
            onChange={(event) => {
              setAgeText(event.target.value);
              onChange({ ...profile, age: parseAge(event.target.value) });
            }}
            className={`${inputClass} ${minorDeclared ? 'border-rose-500 focus:border-rose-400' : ''}`}
          />
        </Field>

        {minorDeclared && (
          <p
            id="age-minor-warning"
            role="alert"
            className="col-span-2 -mt-1 text-sm leading-relaxed text-rose-400"
          >
            karobakbak is for adults. You must be {MIN_DECLARED_AGE} or over to use it — please
            close this tab.
          </p>
        )}

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


      {/*
        What is left of the disclosure paragraph.

        It opened with "Everyone you match with sees this. None of it is
        checked." Both surfaces that render these fields already say it in the
        place somebody reads before deciding to type: the landing card's own
        header carries "Shown to everyone you match with", and Settings sits
        under an "About you" heading reached by opening a panel about yourself.
        Said again under the inputs it was a third statement of the same fact,
        after the point where it could change what anybody typed.

        The timing note stays and is the whole element now, so there is nothing
        to render when it does not apply - an empty bordered line is worse than
        the sentence that was here.
      */}
      {appliesToNextMatch && (
        <p className="text-xs leading-relaxed text-amber-300/90">
          Changes apply to your next conversation, not this one.
        </p>
      )}

      {/*
        Separated by a rule, and last, because everything above it is shown to a
        stranger and this control is the one thing that is not. The paragraph
        that used to say so out loud is gone; the line under this select is what
        carries the distinction now, which is why it names the guarantee rather
        than gesturing at it.
      */}
      <div className="space-y-2 border-t border-ink-800 pt-3">
        <Field label="What are you here for?">
          <select
            value={intent ?? ''}
            onChange={(event) => onIntentChange(orNull(event.target.value))}
            className={inputClass}
          >
            <option value="">—</option>
            {INTENT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        {/*
          The whole weight of the claim sits on this sentence, so it says what
          is true and stops there. "Not shown" is the guarantee; "not knowable"
          is not, because being matched on a value leaks it probabilistically —
          two people paired on venting are likelier than chance to share it.
        */}
        <p className="text-xs leading-relaxed text-ink-500">
          Used only to find you a better match.{' '}
          <span className="text-ink-300">This is never shown to anyone.</span>
        </p>
      </div>

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
  className,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  /** Grid placement, for a field that should not sit in the two-column pair. */
  className?: string;
}): JSX.Element {
  return (
    <label className={`block${className ? ` ${className}` : ''}`}>
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
/**
 * Whether a declared age should be objected to *while it is being typed*.
 *
 * The hard part is that "1" is a prefix of "18" and "19". Warning on it would
 * fire on the way to a perfectly good answer, which is the same mistake
 * `parseAge` avoids by refusing to clamp.
 *
 * So a lone "1" is left alone and everything else under the minimum is
 * flagged immediately: "2" through "9" cannot become a valid age without a
 * second digit, and any two-digit number is already whatever it is going to be.
 *
 * It warns rather than blocks. The gate has already asked, the server is the
 * authority on the bound, and a field that refuses the keystroke teaches
 * somebody to lie one digit differently rather than to leave.
 */
function declaresMinor(raw: string, age: number | null): boolean {
  if (age === null) return false;
  if (age >= MIN_DECLARED_AGE) return false;
  const digits = raw.trim();
  if (digits === '1') return false;
  return true;
}

function parseAge(value: string): number | null {
  if (value.trim() === '') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : null;
}
