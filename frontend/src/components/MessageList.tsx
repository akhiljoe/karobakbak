/**
 * The message list, and the rendering boundary of §23.4.
 *
 * ---------------------------------------------------------------------------
 * DISPATCH ON THE TYPE, ALWAYS
 * ---------------------------------------------------------------------------
 * `message.type` is always present on an inbound frame, and this list switches
 * on it unconditionally rather than testing for the presence of a text field.
 * There is exactly one implementation today, and no plan for a second — the
 * product is text only (§23). The switch exists anyway, because the alternative
 * is `if (message.text)` scattered through a component tree, and every future
 * content type then has to be retrofitted through code that already assumed
 * there was only one kind of content.
 *
 * A type this build does not implement renders a **neutral placeholder** and
 * never throws. A client that crashed on an unfamiliar type would turn a
 * server rollout into a broken page for everyone on the old bundle.
 *
 * Nothing here builds HTML from message text. It is rendered as a text node,
 * React escapes it, and there is no `dangerouslySetInnerHTML` anywhere in this
 * package — the message came from a stranger and is treated as data.
 */
import { useEffect, useRef, useState } from 'react';
import { SmilePlus } from 'lucide-react';

import { REACTIONS } from '../protocol/types';

/**
 * What each reaction looks like, and what it is called.
 *
 * The wire carries a name — `laugh`, never a glyph — so the picture is decided
 * here and can change without touching the protocol, a stored value or the
 * console. Emoji rather than icons because these are five things everybody
 * already recognises, and drawing them ourselves would make them worse.
 */
const REACTION_GLYPHS: Record<string, string> = {
  like: '👍',
  heart: '❤️',
  laugh: '😂',
  wow: '😮',
  sad: '😢',
};

const REACTION_LABELS: Record<string, string> = {
  like: 'Like',
  heart: 'Love',
  laugh: 'Laugh',
  wow: 'Wow',
  sad: 'Sad',
};

/**
 * What a double-tap sends.
 *
 * The fast path needs one answer and this is it: a like is the least loaded
 * thing to send by accident, which matters when the gesture is two taps on the
 * message itself. Anything more specific belongs behind the picker, where it
 * was chosen on purpose.
 */
const DEFAULT_REACTION = 'like';

import { clientConfig } from '../config';
import type { ChatMessage } from '../state/machine';
import { SystemMessage } from './SystemMessage';

/** Which renderer a message needs. Pure, so the boundary is testable. */
export type MessageKind = 'text' | 'unsupported';

export function messageKindFor(type: string): MessageKind {
  return type === 'text' ? 'text' : 'unsupported';
}

interface MessageListProps {
  messages: readonly ChatMessage[];
  partnerTyping: boolean;
  partnerColour: string;
  /** A conversation is open, so the transcript opens with a system line. */
  conversationOpen: boolean;
  /** This conversation has been reported. Shown once, at the end. */
  reported: boolean;
  /** Where the stranger is connecting from, for the opening line. */
  partnerCountry?: string | null;
  /** React to one of the stranger's messages, or take it back. */
  onReact?: (messageId: string, reaction: string, active: boolean) => void;
}

export function MessageList({
  messages,
  partnerTyping,
  partnerColour,
  conversationOpen,
  reported,
  partnerCountry,
  onReact,
}: MessageListProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);

  // Follow the conversation only when the reader is already at the bottom.
  // Yanking the viewport while somebody is reading back is worse than a
  // missed scroll, which is what the jump button is for.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }, [messages, partnerTyping]);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    setShowJump(!nearBottom && messages.length > 6);
  };

  const jumpToBottom = (): void => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="relative h-full">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto px-2.5 py-3 sm:px-4 sm:py-4"
        aria-live="polite"
        aria-label="Conversation"
      >
        <ol className="mx-auto flex max-w-3xl flex-col gap-1.5">
          {conversationOpen && <SystemMessage kind="started" country={partnerCountry} />}

          {messages.map((message, index) => {
            const previous = messages[index - 1];
            const grouped =
              previous !== undefined &&
              previous.from === message.from &&
              Date.parse(message.at) - Date.parse(previous.at) <
                clientConfig.timings.messageGroupingMs;
            return (
              <Bubble
                key={message.id}
                message={message}
                grouped={grouped}
                partnerColour={partnerColour}
                onReact={onReact}
              />
            );
          })}

          {reported && <SystemMessage kind="reported" />}
        </ol>

        {partnerTyping && (
          <div className="mx-auto mt-2 flex max-w-3xl animate-fade-in pl-1">
            <span
              className="inline-flex items-center gap-1 rounded-2xl rounded-bl-md bg-ink-800 px-3.5 py-2.5"
              aria-label="The stranger is typing"
            >
              <Dot delay="0ms" />
              <Dot delay="150ms" />
              <Dot delay="300ms" />
            </span>
          </div>
        )}
      </div>

      {showJump && (
        <button
          onClick={jumpToBottom}
          aria-label="Jump to latest message"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 animate-fade-in rounded-full bg-ink-800 px-3 py-1.5 text-xs font-medium text-ink-200 shadow-lift ring-1 ring-ink-700 transition-all hover:bg-ink-700"
        >
          Latest ↓
        </button>
      )}
    </div>
  );
}

function Dot({ delay }: { delay: string }): JSX.Element {
  return (
    <span
      className="h-1.5 w-1.5 animate-bounce rounded-full bg-ink-400"
      style={{ animationDelay: delay, animationDuration: '0.9s' }}
    />
  );
}

function Bubble({
  message,
  grouped,
  partnerColour,
  onReact,
}: {
  message: ChatMessage;
  grouped: boolean;
  partnerColour: string;
  onReact?: (messageId: string, reaction: string, active: boolean) => void;
}): JSX.Element {
  const mine = message.from === 'you';
  // Only the stranger's messages. Reacting to your own is a mis-tap rather than
  // a feature, and offering it would make the gesture ambiguous everywhere.
  const offer = !mine && onReact !== undefined;
  const yours = message.reactions?.you;

  // The picker, opened by a long press on touch and by the control beside the
  // timestamp with a pointer or a keyboard. Touch has no hover to reveal
  // anything with, so the affordance has to be summoned deliberately.
  const [picking, setPicking] = useState(false);
  const holdTimer = useRef<number | null>(null);
  const holdFrom = useRef<{ x: number; y: number } | null>(null);

  const cancelHold = (): void => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
    holdFrom.current = null;
  };

  const startHold = (event: React.TouchEvent): void => {
    if (!offer) return;
    cancelHold();
    const touch = event.touches[0];
    holdFrom.current = touch ? { x: touch.clientX, y: touch.clientY } : null;
    // Long enough not to fire while somebody is scrolling past, short enough
    // to feel like a press rather than a wait.
    holdTimer.current = window.setTimeout(() => setPicking(true), 450);
  };

  /**
   * Cancel only when the finger has actually gone somewhere.
   *
   * Cancelling on any `touchmove` at all is the version that shipped first, and
   * it meant the press almost never completed: a finger resting on glass for
   * 450ms drifts a few pixels, every one of which fired the event. What
   * distinguishes a press from a scroll is distance, not motion.
   */
  const moveHold = (event: React.TouchEvent): void => {
    const from = holdFrom.current;
    const touch = event.touches[0];
    if (!from || !touch) return;
    const moved = Math.hypot(touch.clientX - from.x, touch.clientY - from.y);
    if (moved > 10) cancelHold();
  };

  useEffect(() => cancelHold, []);

  // Dismissed by anything that is not a choice — a tap elsewhere, a scroll, or
  // Escape. A picker that can only be closed by choosing is a trap on a phone,
  // where there is no cursor to move away.
  useEffect(() => {
    if (!picking) return;
    const close = (): void => setPicking(false);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [picking]);

  // The id the *partner* knows this message by. Our own messages carry a local
  // id until the ack lands, and a reaction naming that would match nothing on
  // the other side.
  const send = (reaction: string): void => {
    setPicking(false);
    // Choosing the one already there takes it back, so the picker never has a
    // dead option and removal never needs a control of its own. Choosing a
    // different one replaces it in a single frame: the receiver stores one
    // reaction per side, so there is nothing to clear first.
    onReact?.(message.serverId ?? message.id, reaction, yours !== reaction);
  };

  return (
    <li
      className={`group flex animate-msg-in ${mine ? 'justify-end' : 'justify-start'} ${
        grouped ? 'mt-0.5' : 'mt-2'
      }`}
    >
      <div className={`flex max-w-[78%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        <div
          className={`relative whitespace-pre-wrap break-words px-3.5 py-2.5 text-[0.95rem] leading-relaxed ${
            mine
              ? 'rounded-2xl rounded-br-md bg-amber-400 text-ink-950'
              : 'rounded-2xl rounded-bl-md bg-ink-800 text-ink-100'
          } ${offer ? 'cursor-pointer select-none touch-manipulation' : ''}`}
          style={{
            ...(mine ? {} : { borderLeft: `2px solid ${partnerColour}55` }),
            // iOS raises its own selection callout on a long press, directly on
            // top of the picker the press just opened.
            ...(offer ? { WebkitTouchCallout: 'none' as const } : {}),
          }}
          // Double-click covers the fast path on both: browsers deliver a
          // double-tap as dblclick, so one handler serves the gesture people
          // already expect from every other chat app.
          onDoubleClick={offer ? () => send(DEFAULT_REACTION) : undefined}
          onTouchStart={startHold}
          onTouchEnd={cancelHold}
          onTouchMove={moveHold}
          onTouchCancel={cancelHold}
          // A long press otherwise raises the selection handles or the context
          // menu on top of the control it just revealed.
          onContextMenu={offer ? (event) => event.preventDefault() : undefined}
        >
          {offer && (
            <div
              role="menu"
              aria-label="Pick a reaction"
              // Stops the window listener that closes it from firing on the
              // press that is choosing something.
              onPointerDown={(event) => event.stopPropagation()}
              // Hover shows it outright on anything with a pointer — the row
              // *is* the affordance, and a button that opens a row of buttons
              // is a step that exists only because touch needed one.
              //
              // `(hover: hover)` keeps it off touch devices, where a tap leaves
              // a sticky :hover behind and the picker would appear on a single
              // tap, competing with the long press that is supposed to open it.
              className={`absolute -top-11 left-0 z-10 animate-fade-in gap-0.5 rounded-full border border-ink-700 bg-ink-900 px-1.5 py-1 shadow-lift ${
                picking ? 'flex' : 'hidden [@media(hover:hover)]:group-hover:flex'
              }`}
            >
              {REACTIONS.map((reaction) => (
                <button
                  key={reaction}
                  type="button"
                  role="menuitem"
                  onClick={() => send(reaction)}
                  aria-label={REACTION_LABELS[reaction]}
                  aria-pressed={yours === reaction}
                  className={`touch-manipulation rounded-full px-1.5 py-1 text-base leading-none transition-transform hover:scale-125 ${
                    yours === reaction ? 'bg-ink-800' : ''
                  }`}
                >
                  {REACTION_GLYPHS[reaction]}
                </button>
              ))}
            </div>
          )}
          {renderBody(message)}
          <Reactions
            reactions={message.reactions}
            onRemove={yours === undefined ? undefined : () => send(yours)}
          />
        </div>
        <span className="mt-1 flex items-center gap-1.5 px-1 text-[0.65rem] text-ink-500">
          <time dateTime={message.at}>{formatTime(message.at)}</time>
          {mine ? <MessageStatus status={message.status} /> : null}
          {/*
            The keyboard path to the same picker. Hover opens it for a pointer
            and a long press opens it on touch; neither is reachable from a
            keyboard, and a feature only some people can use is worse than one
            nobody can.
          */}
          {offer && (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                setPicking((open) => !open);
              }}
              aria-label="React to this message"
              aria-expanded={picking}
              className="-m-2 touch-manipulation rounded p-2 text-ink-600 opacity-0 transition-opacity focus-visible:opacity-100"
            >
              <SmilePlus className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          )}
        </span>
      </div>
    </li>
  );
}

/**
 * The hearts on a message, ours and theirs.
 *
 * Overlapping the bubble's bottom edge rather than sitting under it, so a
 * reaction does not reflow the conversation as it arrives — a message moving
 * because somebody else tapped it is the kind of jump that loses your place
 * while you are reading.
 */
function Reactions({
  reactions,
  onRemove,
}: {
  reactions: ChatMessage['reactions'];
  /** Present only when one of these is ours to take back. */
  onRemove?: () => void;
}): JSX.Element | null {
  const yours = reactions?.you;
  const theirs = reactions?.partner;
  if (yours === undefined && theirs === undefined) return null;

  const same = yours !== undefined && yours === theirs;
  const shown = same
    ? [yours]
    : ([yours, theirs].filter((value) => value !== undefined) as string[]);
  const label =
    yours !== undefined && theirs !== undefined
      ? 'You both reacted'
      : yours !== undefined
        ? 'You reacted'
        : 'They reacted';

  const body = (
    <>
      {shown.map((reaction) => (
        <span key={reaction} className="text-[0.7rem] leading-none">
          {REACTION_GLYPHS[reaction] ?? reaction}
        </span>
      ))}
      {same && <span className="text-[0.6rem] font-medium text-ink-300">2</span>}
    </>
  );

  const chip =
    'absolute -bottom-2 right-2 inline-flex items-center gap-0.5 rounded-full border border-ink-700 bg-ink-900 px-1.5 py-0.5 shadow-sm';

  // Tapping your own reaction takes it back — the gesture people already have
  // from every other chat app, and the only one big enough to hit reliably.
  // The badge is small on purpose; `after:-inset-3` carries the touch target
  // out to something a thumb can find without moving a pixel on screen.
  if (onRemove === undefined) {
    return (
      <span className={chip} aria-label={label}>
        {body}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onRemove();
      }}
      // The badge sits inside the bubble, whose double-click adds a reaction.
      // Without this a quick double-tap on the badge removes it and puts it
      // straight back.
      onDoubleClick={(event) => event.stopPropagation()}
      aria-label="Remove your reaction"
      className={`${chip} touch-manipulation after:absolute after:-inset-3 after:content-[''] hover:border-ink-600`}
    >
      {body}
    </button>
  );
}

function renderBody(message: ChatMessage): JSX.Element {
  switch (messageKindFor(message.type)) {
    case 'text':
      return <TextMessage text={message.text} />;
    case 'unsupported':
      return <UnsupportedMessage />;
  }
}

/**
 * The only implementation.
 *
 * The text is rendered as a text node. React escapes it, and nothing here
 * builds HTML from it.
 */
function TextMessage({ text }: { text: string }): JSX.Element {
  return <>{text}</>;
}

/** A content type this build cannot render. Neutral, and never an error. */
function UnsupportedMessage(): JSX.Element {
  return (
    <span className="italic text-ink-400">
      This message can&rsquo;t be shown in this version.
    </span>
  );
}

/**
 * Sent, never read.
 *
 * `message_ack` means the server accepted and routed the message (D14). There
 * is no read receipt in this protocol, and showing one would be inventing a
 * guarantee the server refuses to make.
 */
function MessageStatus({ status }: { status: ChatMessage['status'] }): JSX.Element | null {
  if (!status) return null;
  const label: Record<NonNullable<ChatMessage['status']>, string> = {
    sending: 'Sending…',
    sent: 'Sent',
    withheld: 'Not delivered',
    // Distinct from `withheld`, and worth the extra word: one means the service
    // stopped it, the other means the stranger was not there to receive it.
    // Nothing is buffered (D43), so it will not arrive later — saying "Sent"
    // here was the protocol's old boolean showing through, and it promised
    // something that had already failed to happen.
    undelivered: 'Nobody received this',
    failed: 'Failed',
  };
  const tone =
    status === 'withheld' || status === 'failed' || status === 'undelivered'
      ? 'text-rose-400'
      : 'text-ink-500';
  return <span className={tone}>· {label[status]}</span>;
}

/** Wall-clock time, in the reader's locale. */
function formatTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
