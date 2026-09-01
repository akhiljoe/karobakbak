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
import { useEffect, useRef, useState } from 'react';
import { Clock, MessageCircle, Trash2, X } from 'lucide-react';

import { COUNTRY_NAMES } from '../protocol/types';
import { askToReconnect, flagOf, onlineFrom, type AskResult, type HistoryEntry } from '../history';

interface HistoryPanelProps {
  open: boolean;
  entries: readonly HistoryEntry[];
  onClose(): void;
  onClear(): void;
  /** Whether asking somebody to chat again is possible at all. */
  signedIn: boolean;
  /** Opens the sign-in dialog, saying why it appeared. */
  onSignIn(reason: string): void;
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
  signedIn,
  onSignIn,
  placement = 'down',
}: HistoryPanelProps): JSX.Element | null {
  const container = useRef<HTMLDivElement>(null);
  const [online, setOnline] = useState<ReadonlySet<string>>(new Set());
  const [asked, setAsked] = useState<Record<string, AskResult>>({});

  /*
    Every state this button shows clears itself after three seconds.

    The disable exists to stop a double-tap becoming two requests, not to stop
    somebody trying again. A person whose friend was away a moment ago has every
    reason to press it once more, and a control that stays dead until the panel
    is closed and reopened reads as broken rather than as busy.

    Timers are held so a panel that closes mid-flight does not set state on a
    component nobody is looking at.
  */
  const timers = useRef<number[]>([]);
  useEffect(
    () => () => {
      timers.current.forEach((id) => window.clearTimeout(id));
      timers.current = [];
    },
    [],
  );

  const clearSoon = (key: string): void => {
    timers.current.push(
      window.setTimeout(() => {
        setAsked((was) => {
          const next = { ...was };
          delete next[key];
          return next;
        });
      }, 3000),
    );
  };

  /*
    Asked once, when the panel opens, and never on a timer. A list somebody
    glances at does not need to update while they look at it, and polling would
    turn a glance into a request every few seconds for the life of the tab.

    Only entries carrying a token are asked about, and most will not have one.
  */
  useEffect(() => {
    if (!open) return;
    let live = true;
    void onlineFrom(entries).then((here) => {
      if (live) setOnline(here);
    });
    return () => {
      live = false;
    };
  }, [open, entries]);

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

  /** What happened when this row was last asked. Rows with no token key by time. */
  const askedFor = (entry: HistoryEntry): AskResult | undefined =>
    asked[entry.presence ?? String(entry.at)];

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
      /*
        A harder edge than the rest of the interface carries. This floats over a
        transcript of a similar darkness, and a one-pixel `ink-700` border on
        `ink-900` was the same contrast as two panels side by side — which is
        fine for a card in a column and not fine for something overlapping
        content it is not part of. The ring and the deeper ground do the
        separating; the shadow alone was not enough on a dark surface.
      */
      /*
        Two different things, and the phone one is not a narrower version of the
        desktop one.

        On a wide screen it hangs off its button: centred, 288px, pointing at
        what opened it.

        On a phone it does not anchor to the button at all. Anchoring clamps the
        *width* and does nothing about the *position*, so a panel centred on a
        control in the middle of a narrow row still hangs off the edge — and the
        half that hangs off is the right-hand one, which is where each row's
        button lives. That is why it read as truncated and why the icon was
        missing: it was off-screen, not absent.

        So below `sm` it is fixed to the viewport with a margin on both sides,
        which is the shape the rest of the product already uses for anything
        that has to fit a phone.
      */
      className={`fixed inset-x-3 bottom-24 z-40 max-h-[60vh] overflow-y-auto animate-fade-in overflow-hidden rounded-xl border border-ink-600 bg-ink-950 shadow-2xl ring-1 ring-black/50 sm:absolute sm:inset-x-auto sm:left-1/2 sm:w-72 sm:-translate-x-1/2 ${
        placement === 'up' ? 'sm:bottom-full sm:mb-2' : 'sm:bottom-auto sm:top-full sm:mt-2'
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
                  {/*
                    The conversation's own accent, and a ring when they are here
                    now. A second dot would be two circles saying different
                    things side by side; the ring keeps one mark meaning one
                    person and adds the state to it.
                  */}
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      entry.presence !== null && online.has(entry.presence)
                        ? 'ring-2 ring-green-400 ring-offset-2 ring-offset-ink-900'
                        : ''
                    }`}
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
                      {entry.presence !== null && online.has(entry.presence) ? (
                        <span className="text-green-400">Online</span>
                      ) : entry.country === null ? (
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
                  {/*
                    On every row, not only the people who are here.

                    The earlier version hid it for anybody offline, on the
                    grounds that a button which mostly fails is worse than none.
                    Overruled deliberately: a row you cannot act on reads as a
                    dead list, and "they are not around" is a better answer than
                    a control that silently is not there. Pressing it for
                    somebody absent says Away and costs one request.

                    An icon rather than a word, sized to fill the right of the
                    row: it is the only action a row has, so it does not need a
                    label to disambiguate it from anything.
                  */}
                  <button
                    onClick={() => {
                      /*
                        Signed out, this asks rather than fails. The route
                        refuses without a credential and always will — that
                        check stays, because a client is not where a rule lives
                        — but a person pressing a button should not have to
                        deduce the rule from nothing happening.

                        A `title` was the first attempt and is invisible on a
                        phone, which is where this was reported.
                      */
                      if (!signedIn) {
                        onClose();
                        onSignIn('Sign in to chat with someone again. Your place here is kept.');
                        return;
                      }
                      const token = entry.presence;
                      if (token === null) {
                        const key = String(entry.at);
                        setAsked((was) => ({ ...was, [key]: 'away' }));
                        clearSoon(key);
                        return;
                      }
                      setAsked((was) => ({ ...was, [token]: 'asked' }));
                      void askToReconnect(token).then((result) => {
                        setAsked((was) => ({ ...was, [token]: result }));
                        clearSoon(token);
                      });
                    }}
                    disabled={askedFor(entry) === 'asked'}
                    aria-label={signedIn ? 'Ask to chat again' : 'Sign in to chat again'}
                    title={
                      askedFor(entry) === 'asked'
                        ? 'Asked'
                        : askedFor(entry) === 'signin'
                          ? 'Sign in to chat again'
                          : askedFor(entry) === 'away'
                            ? 'Not around right now'
                            : 'Ask to chat again'
                    }
                    className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                      !signedIn
                        ? 'border-ink-600 text-ink-300 hover:border-amber-400/60 hover:text-amber-300'
                        : askedFor(entry) === 'away' || askedFor(entry) === 'signin'
                          ? 'border-ink-700 text-ink-600'
                        : askedFor(entry) === 'asked'
                          ? 'border-green-500/50 bg-green-500/10 text-green-300'
                          : 'border-ink-600 text-ink-300 hover:border-green-500/50 hover:bg-green-500/10 hover:text-green-300'
                    }`}
                  >
                    <MessageCircle className="h-4 w-4" aria-hidden="true" />
                  </button>
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
        {/*
          Said before anything is pressed, not only after. A control whose
          requirement is discoverable solely by failing it is a control people
          learn by being refused.
        */}
        {!signedIn && (
          <span className="mb-1 block text-ink-400">Sign in to chat with someone again.</span>
        )}
        Kept in this tab only, and gone when you close it. Never sent to us.
      </p>
    </div>
  );
}
