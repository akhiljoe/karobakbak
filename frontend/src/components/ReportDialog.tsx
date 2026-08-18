/**
 * The report dialog.
 *
 * The categories come from the protocol, not from a list retyped here, so the
 * two cannot drift. The user is told plainly what a report does and what it
 * does not: there is no verdict, no notification, and nothing comes back except
 * an acknowledgement that it was recorded (security §31).
 */
import { useState } from 'react';

import { REPORT_CATEGORIES, type ReportCategory } from '../protocol/types';

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

export function ReportDialog({ maxNoteLength, onCancel, onSubmit }: ReportDialogProps): JSX.Element {
  const [category, setCategory] = useState<ReportCategory>('harassment');
  const [note, setNote] = useState('');

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Report this conversation">
      <div className="modal__panel">
        <h2 className="modal__title">Report this conversation</h2>
        <p className="modal__lead">
          A person will review this. The other side is not told, and you will not hear what happened
          next.
        </p>

        <fieldset className="modal__field">
          <legend>What happened?</legend>
          {REPORT_CATEGORIES.map((value) => (
            <label key={value} className="radio">
              <input
                type="radio"
                name="category"
                value={value}
                checked={category === value}
                onChange={() => setCategory(value)}
              />
              {LABELS[value]}
            </label>
          ))}
        </fieldset>

        <label className="modal__field">
          <span>Anything you want to add (optional)</span>
          <textarea
            className="modal__note"
            rows={3}
            value={note}
            maxLength={maxNoteLength}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>

        <div className="modal__actions">
          <button className="button" onClick={onCancel}>
            Cancel
          </button>
          <button className="button button--primary" onClick={() => onSubmit(category, note)}>
            Send report
          </button>
        </div>
      </div>
    </div>
  );
}
