/**
 * The strangers you met in this session.
 *
 * A menu under the header control that opens it, the same shape as the account
 * menu: this is a small list belonging to one button, not something that should
 * dim the page behind it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A ROW DELIBERATELY DOES NOT HAVE
 * ---------------------------------------------------------------------------
 * No reconnect button. Reconnecting means asking the server to match you with
 * one specific person again, which is the clause `minor-safety-policy.md` §6
 * rests on and the thing the privacy policy says cannot happen. The list is a
 * record of who you met, not a route back to them.
 *
 * No report button either, yet. Reporting needs the conversation it refers to,
 * and this list deliberately holds no conversation id — keeping one would be
 * the first half of the reconnect feature above. Reporting stays where it
 * already works: during the conversation, and inside the late-block window.
 *
 * So a row is exactly what was on screen at the time — when, the colour and
 * nickname that conversation used, and the country the stranger declared. It is
 * a memory aid, and being only that is what keeps it free of every question the
 * durable version would have to answer.
 */
import { useEffect, useRef } from 'react';
import { Clock, Trash2, X } from 'lucide-react';

import { COUNTRY_NAMES } from '../protocol/types';
import { flagOf, type HistoryEntry } from '../history';

interface HistoryPanelProps {
  open: boolean;
  entries: readonly HistoryEntry[];
  onClose(): void;
  onClear(): void;
  /**
   * Which way it opens.
   *
   * `up` is for the link above the composer, which sits near the bottom of the
   * viewport — a panel dropping from there would open off the screen on a
   * phone, and the list would be unreachable rather than merely awkward.
   */
  placement?: 'down' | 'up';
}

export function HistoryPanel({
  open,
  entries,
  onClose,
  onClear,
  placement = 'down',
}: HistoryPanelProps): JSX.Element | null {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent): void => {
      if (container.current !== null && !container.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onPointer);
    window.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={container}
      role="dialog"
      aria-label="Recent strangers"
      /*
        Centred on its button and clamped to the viewport, not right-aligned.

        Right-aligning was correct while this hung off a control at the end of
        the header. The control is in the middle of the action row now, so
        `right-0` put a 288px panel to the *left* of a button near the middle of
        a phone — which is off the screen, with no way to scroll to it, because
        the page body does not scroll sideways.

        `max-w` is what actually keeps it on screen; centring is what keeps it
        pointing at the thing that opened it.
      */
      className={`absolute left-1/2 z-40 w-72 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 animate-fade-in overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-lift ${
        placement === 'up' ? 'bottom-full mb-2' : 'top-full mt-2'
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-ink-800 px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-sm font-medium text-ink-100">
          <Clock className="h-3.5 w-3.5 text-ink-400" aria-hidden="true" />
          Recent
          {entries.length > 0 && <span className="text-ink-500">— {entries.length}</span>}
        </span>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-lg p-1 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {entries.length === 0 ? (
        <p className="px-3 py-4 text-sm leading-relaxed text-ink-500">
          Nobody yet. Strangers you talk to appear here for this session only.
        </p>
      ) : (
        <>
          <ul className="max-h-72 overflow-y-auto py-1">
            {entries.map((entry) => (
              // `at` is this client's clock and two conversations can share a
              // millisecond only if the same person was met twice in one tick,
              // so the nickname joins it to keep the key stable.
              <li key={`${entry.at}-${entry.nickname}`} className="px-1">
                <div className="flex items-center gap-2.5 rounded-lg px-2 py-2">
                  {/* The accent that conversation used, so the row is recognisable. */}
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: entry.colour }}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink-200">{entry.nickname}</p>
                    {/*
                      Where they said they were from, and nothing else.

                      The time was here and is gone: it answered a question
                      nobody asked, and a list of timestamps reads as a log of
                      your evening rather than a list of people.

                      There is deliberately no online dot. Presence is keyed to
                      an account, and this list holds no account — only what was
                      on screen during the conversation. Knowing whether a past
                      stranger is here now would mean keeping a durable handle
                      for them, which is the thing `history.ts` does not do and
                      `minor-safety-policy.md` §6 is written about.
                    */}
                    <p className="text-xs text-ink-500">
                      {entry.country === null ? (
                        'Somewhere'
                      ) : (
                        <>
                          <span aria-hidden="true">{flagOf(entry.country)}</span>{' '}
                          {COUNTRY_NAMES[entry.country as keyof typeof COUNTRY_NAMES] ??
                            entry.country}
                        </>
                      )}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>

          <div className="border-t border-ink-800 p-1">
            <button
              onClick={onClear}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-100"
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              Clear
            </button>
          </div>
        </>
      )}

      <p className="border-t border-ink-800 px-3 py-2 text-xs leading-relaxed text-ink-500">
        Kept in this tab only, and gone when you close it. Never sent to us.
      </p>
    </div>
  );
}
