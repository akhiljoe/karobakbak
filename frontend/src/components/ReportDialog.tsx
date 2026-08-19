/**
 * The report dialog.
 *
 * The categories come from the protocol, not from a list retyped here, so the
 * two cannot drift. The user is told plainly what a report does and what it
 * does not: there is no verdict, no notification, and nothing comes back except
 * an acknowledgement that it was recorded (security §31).
 *
 * The note is user content and carries the same handling rule as a message —
 * it goes into `reports.note` and never into a log line or a metric.
 */
import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

import { REPORT_CATEGORIES, type ReportCategory } from '../protocol/types';
import { Button } from './Button';

const LABELS: Record<ReportCategory, string> = {
  harassment: 'Harassment or bullying',
  spam: 'Spam or advertising',
  sexual_content: 'Sexual content',
  grooming: 'Grooming or predatory behaviour',
  threats: 'Threats or violence',
  hate: 'Hate speech',
  scam: 'Scam or fraud',
  other: 'Something else',
};

interface ReportDialogProps {
  maxNoteLength: number;
  onCancel(): void;
  onSubmit(category: ReportCategory, note: string): void;
}

export function ReportDialog({
  maxNoteLength,
  onCancel,
  onSubmit,
}: ReportDialogProps): JSX.Element {
  const [category, setCategory] = useState<ReportCategory>('harassment');
  const [note, setNote] = useState('');

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Report this conversation"
    >
      <div className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative max-h-[90dvh] w-full max-w-md animate-fade-in overflow-y-auto rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl sm:p-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-semibold text-ink-50">
              Report this conversation
            </h2>
            <p className="mt-1 text-xs text-ink-400">
              A person will review this. The other side is not told, and you will not hear what
              happened next.
            </p>
          </div>
          <button
            onClick={onCancel}
            aria-label="Close"
            className="shrink-0 rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <fieldset className="mb-3">
          <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-500">
            What happened?
          </legend>
          <div className="flex flex-col gap-1">
            {REPORT_CATEGORIES.map((value) => (
              <label
                key={value}
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3 py-2.5 text-sm transition-colors ${
                  category === value
                    ? 'border-amber-400/50 bg-amber-400/10 text-ink-50'
                    : 'border-ink-700 bg-ink-950 text-ink-200 hover:border-ink-600'
                }`}
              >
                <input
                  type="radio"
                  name="category"
                  value={value}
                  checked={category === value}
                  onChange={() => setCategory(value)}
                  className="h-4 w-4 shrink-0 accent-amber-400"
                />
                {LABELS[value]}
              </label>
            ))}
          </div>
        </fieldset>

        <label className="mb-4 block">
          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-500">
            Anything you want to add (optional)
          </span>
          <textarea
            rows={3}
            value={note}
            maxLength={maxNoteLength}
            onChange={(event) => setNote(event.target.value)}
            className="w-full resize-none rounded-xl border border-ink-700 bg-ink-950 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-600 focus:border-amber-400/50 focus:outline-none"
            placeholder="What should a reviewer know?"
          />
        </label>

        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onCancel}>
            Cancel
          </Button>
          <Button className="flex-1" onClick={() => onSubmit(category, note)}>
            Send report
          </Button>
        </div>
      </div>
    </div>
  );
}
