/**
 * A transient notice.
 *
 * Carries the reducer's `notice`, which is always developer-authored copy —
 * never a raw server string and never message content.
 */
import { useEffect } from 'react';
import { Info, X } from 'lucide-react';

import { clientConfig } from '../config';

interface ToastProps {
  message: string | null;
  onDismiss(): void;
}

export function Toast({ message, onDismiss }: ToastProps): JSX.Element | null {
  useEffect(() => {
    if (message === null) return;
    const id = window.setTimeout(onDismiss, clientConfig.timings.toastVisibleMs);
    return () => window.clearTimeout(id);
  }, [message, onDismiss]);

  if (message === null) return null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-14 z-50 flex justify-center px-4 sm:top-16">
      <div
        role="status"
        className="pointer-events-auto flex animate-fade-in items-center gap-2 rounded-full border border-ink-700 bg-ink-900 px-4 py-2 shadow-lift"
      >
        <Info className="h-4 w-4 shrink-0 text-amber-400" />
        <span className="text-sm text-ink-100">{message}</span>
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className="rounded-full p-0.5 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-200"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
