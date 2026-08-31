/**
 * Matching filters — visible, and deliberately inert.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SHIPS DISABLED RATHER THAN NOT AT ALL
 * ---------------------------------------------------------------------------
 * The backend has the segmentation seam — queue keys are `chat:queue:{segment}`
 * and every Lua script already takes a segment argument — but only `default`
 * exists (`DESIGN.md` R6, D23). Nothing could act on a filter today.
 *
 * Two dishonest options were available: hide it, or let people set filters that
 * silently do nothing. This takes the third — show the controls, disable them,
 * and say why. A user who wants this learns it is coming; nobody is told their
 * preference was applied when it was not.
 *
 * ---------------------------------------------------------------------------
 * THE OPTION LIST IS NOW SETTLED, AND IT IS NARROWER THAN IT COULD BE
 * ---------------------------------------------------------------------------
 * This used to leave the options unenumerated, because gender and country
 * filtering on anonymous stranger chat was exactly what the minor-safety review
 * had to rule on (security §23–24).
 *
 * The list is **gender, country and language**, over the declared profile.
 *
 * Gender was held back once and then included, and the reasoning against it has
 * not gone away — it is worth keeping visible rather than deleting. Filtering on
 * a self-declared, unverified field is closer to targeting than to preference,
 * and on a service with no age assurance that is the harm D37 was written about.
 * Nothing here verifies anybody, and no copy may imply that it does.
 *
 * Inferring gender from message content instead of reading the declared field
 * would be a materially different feature: it classifies conversation text for
 * a purpose that is not safety, which the retention and purpose rules do not
 * currently cover. It is not what this filters on.
 *
 * The controls stay disabled until segments exist behind them. Nothing here
 * promises to work.
 */
import { useEffect } from 'react';
import { ArrowUpRight, Lock, SlidersHorizontal, X } from 'lucide-react';

import { FILTERS_ENABLED } from '../features';
import { COUNTRY_NAMES, GENDERS, type MatchPreferences } from '../protocol/types';
import { GENDER_OPTIONS, isEmptyPreferences } from '../profile';
import { Button } from './Button';

/**
 * Toggle one value in one dimension.
 *
 * Additive rather than exclusive: asking for two genders is a wider search, not
 * a contradictory one, and the server scores a candidate matching any of them.
 */
function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

interface FiltersModalProps {
  open: boolean;
  onClose(): void;
  /** What is currently being asked for. */
  preferences: MatchPreferences;
  onChange(preferences: MatchPreferences): void;
}

/**
 * The dimensions, in the order they are weighted server-side (§29.8).
 *
 * Intent is not one of them and never appears here. It is symmetric and free,
 * so it lives beside the profile where everybody can reach it (D45, §30.2) —
 * putting it in this modal would sell something that is not for sale.
 */
const PLANNED = ['Gender', 'Country'] as const;

export function FiltersModal({
  open,
  onClose,
  preferences,
  onChange,
}: FiltersModalProps): JSX.Element | null {
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
      aria-label="Matching filters"
    >
      <div className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-md animate-fade-in rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl sm:p-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-ink-50">
            <SlidersHorizontal className="h-4 w-4 text-amber-400" />
            Matching filters
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!FILTERS_ENABLED && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
            <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
              <Lock className="h-4 w-4 shrink-0 text-amber-400" aria-hidden="true" />
              Part of Premium
            </p>
            {/*
              One line and a link. The Premium page already explains what this
              costs, what it does and what it deliberately does not do — saying
              it again here is the kind of repetition that trains people to stop
              reading the notices that matter.

              A new tab, not a route: this modal opens from the header, which is
              present during a conversation, and navigating away in this tab
              would unmount the app and drop the socket mid-chat.
            */}
            <a
              href="/premium"
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-300 underline underline-offset-4 transition-colors hover:text-amber-200"
            >
              What you get
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          </div>
        )}

        {FILTERS_ENABLED ? (
          <div className="flex flex-col gap-4">
            <Chips
              label="Gender"
              options={GENDER_OPTIONS}
              selected={preferences.genders}
              onToggle={(value) =>
                onChange({ ...preferences, genders: toggle(preferences.genders, value) })
              }
            />

            {/*
              One country, not a multi-select. There are 240 of them, and asking
              for eight is not a preference — it is the absence of one, typed at
              length. Anywhere is the default and stays the honest answer.
            */}
            <label className="block">
              <span className="mb-1.5 block text-xs font-medium text-ink-300">Country</span>
              <select
                value={preferences.countries[0] ?? ''}
                onChange={(event) =>
                  onChange({
                    ...preferences,
                    countries: event.target.value === '' ? [] : [event.target.value],
                  })
                }
                className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 outline-none transition-colors focus:border-amber-500/60"
              >
                <option value="">Anywhere</option>
                {Object.entries(COUNTRY_NAMES).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </label>

            {/*
              The whole promise, in the words the server can actually keep. Not
              "match me with" — the search prefers, and takes an ordinary
              partner on the same pass when nobody fits (D44). Saying otherwise
              would be selling something this cannot deliver, and every value
              here is a claim a stranger typed anyway.
            */}
            <p className="text-xs leading-relaxed text-ink-500">
              {isEmptyPreferences(preferences)
                ? 'No preference set — you will be matched with anyone waiting.'
                : 'A higher chance of being matched with what you picked. When nobody fits, you still get matched right away rather than waiting.'}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {PLANNED.map((label) => (
              <li
                key={label}
                className="flex items-center justify-between rounded-xl border border-ink-800 bg-ink-950 px-3.5 py-3 opacity-60"
              >
                <span className="text-sm text-ink-300">{label}</span>
                <span className="inline-flex items-center gap-1 rounded-full bg-ink-800 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-ink-400">
                  <Lock className="h-2.5 w-2.5" aria-hidden="true" />
                  Premium
                </span>
              </li>
            ))}
          </ul>
        )}

        <Button variant="secondary" className="mt-4 w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** One dimension as a row of toggles. Small closed lists only. */
function Chips({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: readonly { value: string; label: string }[];
  selected: readonly string[];
  onToggle(value: string): void;
}): JSX.Element {
  return (
    <div>
      <span className="mb-1.5 block text-xs font-medium text-ink-300">{label}</span>
      <div className="flex flex-wrap gap-2">
        {options.map((option) => {
          const on = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(option.value)}
              className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                on
                  ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                  : 'border-ink-700 bg-ink-950 text-ink-300 hover:border-ink-600 hover:text-ink-100'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
