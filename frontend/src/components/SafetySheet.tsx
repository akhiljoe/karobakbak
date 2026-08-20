/**
 * The safety sheet.
 *
 * **Report** sends the conversation to a reviewer. The other side is never told
 * (security §31, §32).
 *
 * The copy here is one line, on purpose. The retention notice that used to sit
 * at the bottom of this menu was accurate and in the wrong place: somebody
 * opening it is dealing with a person, not reading a privacy policy, and a
 * paragraph about how long data is kept is friction at the moment friction is
 * least wanted. It still appears on the landing screen, where somebody deciding
 * whether to use the product at all can read it.
 *
 * Block used to live here too, behind two taps. It is now a single control in
 * the conversation header, next to the person it is about — burying the safe
 * action three screens deep meant most people took the fast one instead and
 * never blocked at all. One action per surface also removes the question of
 * which of two similar buttons somebody meant to press.
 *
 * Shown only if the server said it supports reporting on the `connected` frame.
 */
import { useEffect } from 'react';
import { ArrowRight, Flag, X } from 'lucide-react';

interface SafetySheetProps {
  open: boolean;
  reportAvailable: boolean;
  reportSent: boolean;
  onClose(): void;
  onReport(): void;
}

export function SafetySheet({
  open,
  reportAvailable,
  reportSent,
  onClose,
  onReport,
}: SafetySheetProps): JSX.Element | null {
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
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label="Safety options"
    >
      {/*
        A transparent backdrop, not a dimmed one. This is a menu hanging off a
        control, not a modal that takes over the screen — darkening everything
        would say "stop what you are doing", which is not what opening a menu
        means. It still covers the viewport so a click anywhere closes it.
      */}
      <div className="absolute inset-0" onClick={onClose} />

      {/*
        Anchored under the control that opened it, top right, rather than rising
        from the bottom. A sheet from the bottom edge is a fine pattern when it
        is the main event; for a menu it breaks the link between what was
        pressed and what appeared.
      */}
      <div className="absolute right-3 top-[4.5rem] w-[min(20rem,calc(100vw-1.5rem))] animate-fade-in rounded-2xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:right-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-ink-50">Report</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {reportAvailable && (
          <button
            onClick={() => {
              onReport();
              onClose();
            }}
            disabled={reportSent}
            className="mb-2 flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-950 px-4 py-3.5 text-left transition-all hover:border-ink-600 active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-400/15 text-amber-400">
              <Flag className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-ink-100">
                {reportSent ? 'Already reported' : 'Report'}
              </span>
              <span className="block text-xs text-ink-500">
                {reportSent ? 'Already sent for review.' : 'Send this to a reviewer.'}
              </span>
            </span>
            {!reportSent && <ArrowRight className="h-4 w-4 shrink-0 text-ink-600" />}
          </button>
        )}

      </div>
    </div>
  );
}
