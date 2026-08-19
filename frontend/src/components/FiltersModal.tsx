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
 * The options are intentionally *not* enumerated here. Gender and country
 * filtering on anonymous stranger chat is exactly the surface the minor-safety
 * review has to rule on (security §23–24), and shipping the option lists now
 * would prejudge that review.
 */
import { useEffect } from 'react';
import { Info, SlidersHorizontal, X } from 'lucide-react';

import { FILTERS_ENABLED } from '../features';
import { Button } from './Button';

interface FiltersModalProps {
  open: boolean;
  onClose(): void;
}

const PLANNED = ['Language', 'Interests', 'Region'] as const;

export function FiltersModal({ open, onClose }: FiltersModalProps): JSX.Element | null {
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
          <div className="mb-4 flex gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
            <Info className="h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-100/90">
              <span className="font-semibold">Not available yet.</span> Everyone is matched from a
              single pool right now, so nothing here would change who you meet. These controls are
              switched off rather than hidden so you can see what is planned.
            </p>
          </div>
        )}

        <ul className="flex flex-col gap-2">
          {PLANNED.map((label) => (
            <li
              key={label}
              className="flex items-center justify-between rounded-xl border border-ink-800 bg-ink-950 px-3.5 py-3 opacity-60"
            >
              <span className="text-sm text-ink-300">{label}</span>
              <span className="rounded-full bg-ink-800 px-2 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide text-ink-400">
                Planned
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-4 px-1 text-xs leading-relaxed text-ink-500">
          Filters only start to help once enough people are online that a narrower pool still
          matches quickly.
        </p>

        <Button variant="secondary" className="mt-4 w-full" onClick={onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}
