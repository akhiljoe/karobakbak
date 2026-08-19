/**
 * The safety sheet.
 *
 * Two actions, and they are genuinely different things, so the copy says so:
 *
 *  * **Report** sends evidence to a reviewer and ends the conversation. The
 *    other side is never told (security §31, §32).
 *  * **Block** is a matching filter going forward, not a retroactive undo. It
 *    stops future pairings; it does not unsend anything (D18, §10.16).
 *
 * Each entry is shown only if the server said it supports that command on the
 * `connected` frame.
 */
import { useEffect } from 'react';
import { ArrowRight, Ban, Flag, X } from 'lucide-react';

interface SafetySheetProps {
  open: boolean;
  reportAvailable: boolean;
  blockAvailable: boolean;
  reportSent: boolean;
  onClose(): void;
  onReport(): void;
  onBlock(): void;
}

export function SafetySheet({
  open,
  reportAvailable,
  blockAvailable,
  reportSent,
  onClose,
  onReport,
  onBlock,
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
      className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      role="dialog"
      aria-modal="true"
      aria-label="Safety options"
    >
      <div className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-sm animate-fade-in rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-ink-50">Safety</h2>
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
                {reportSent
                  ? 'A reviewer has this conversation.'
                  : 'Send this conversation to a reviewer'}
              </span>
            </span>
            {!reportSent && <ArrowRight className="h-4 w-4 shrink-0 text-ink-600" />}
          </button>
        )}

        {blockAvailable && (
          <button
            onClick={() => {
              onBlock();
              onClose();
            }}
            className="flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-950 px-4 py-3.5 text-left transition-all hover:border-ink-600 active:scale-[0.98]"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-rose-500/15 text-rose-400">
              <Ban className="h-4 w-4" />
            </span>
            <span className="flex-1">
              <span className="block text-sm font-medium text-rose-400">Block</span>
              <span className="block text-xs text-ink-500">
                Stops future matches with them. It does not undo this one.
              </span>
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-ink-600" />
          </button>
        )}

        <p className="mt-3 px-1 text-xs leading-relaxed text-ink-500">
          Conversations are kept for a limited period so abuse can be investigated, then deleted
          automatically. They are never shown back to you.
        </p>
      </div>
    </div>
  );
}
