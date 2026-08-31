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
import { Heart } from 'lucide-react';

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
  /** React to one of the stranger's messages, or take it back. */
  onReact?: (messageId: string, active: boolean) => void;
}

export function MessageList({
  messages,
  partnerTyping,
  partnerColour,
  conversationOpen,
  reported,
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
          {conversationOpen && <SystemMessage kind="started" />}

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
  onReact?: (messageId: string, active: boolean) => void;
}): JSX.Element {
  const mine = message.from === 'you';
  // Only the stranger's messages. Reacting to your own is a mis-tap rather than
  // a feature, and offering it would make the gesture ambiguous everywhere.
  const reactable = !mine && onReact !== undefined;
  const reacted = message.reactions?.you !== undefined;
  // Offered whether or not one is already there: the same control adds it and
  // takes it back, so there is never a state the gesture cannot reach.
  const offer = reactable;

  // Revealed by a long press. Hover does the same thing on a pointer device
  // through `group-hover`, which touch has no equivalent of — a tap is either a
  // click or nothing, so the affordance has to be summoned deliberately.
  const [held, setHeld] = useState(false);
  const holdTimer = useRef<number | null>(null);

  const cancelHold = (): void => {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  const startHold = (): void => {
    if (!offer) return;
    cancelHold();
    // Long enough not to fire while somebody is scrolling past, short enough
    // to feel like a press rather than a wait.
    holdTimer.current = window.setTimeout(() => setHeld(true), 450);
  };

  useEffect(() => cancelHold, []);

  // The id the *partner* knows this message by. Our own messages carry a local
  // id until the ack lands, and a reaction naming that would match nothing on
  // the other side.
  const react = (): void => {
    setHeld(false);
    // Toggle. Removing is `active: false` rather than a separate command,
    // mirroring `typing` — stopping is an event, not the absence of one.
    onReact?.(message.serverId ?? message.id, !reacted);
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
          } ${offer ? 'cursor-pointer select-none' : ''}`}
          style={mine ? undefined : { borderLeft: `2px solid ${partnerColour}55` }}
          // Double-click covers the fast path on both: browsers deliver a
          // double-tap as dblclick, so one handler serves the gesture people
          // already expect from every other chat app.
          onDoubleClick={offer ? react : undefined}
          onTouchStart={startHold}
          onTouchEnd={cancelHold}
          onTouchMove={cancelHold}
          onTouchCancel={cancelHold}
          // A long press otherwise raises the selection handles or the context
          // menu on top of the control it just revealed.
          onContextMenu={offer ? (event) => event.preventDefault() : undefined}
        >
          {renderBody(message)}
          <Reactions reactions={message.reactions} />
        </div>
        <span className="mt-1 flex items-center gap-1.5 px-1 text-[0.65rem] text-ink-500">
          <time dateTime={message.at}>{formatTime(message.at)}</time>
          {mine ? <MessageStatus status={message.status} /> : null}
          {/*
            Keyboard and screen-reader path for the same action. A double-tap is
            not reachable without a pointer, and a feature only some people can
            use is worse than one nobody can.
          */}
          {offer && (
            <button
              type="button"
              onClick={react}
              aria-label={reacted ? 'Remove your reaction' : 'React with a heart'}
              aria-pressed={reacted}
              className={`rounded p-0.5 transition-opacity hover:text-rose-300 focus-visible:opacity-100 group-hover:opacity-100 ${
                held || reacted ? 'opacity-100' : 'opacity-0'
              } ${reacted ? 'text-rose-400' : 'text-ink-600'}`}
            >
              <Heart
                className={`h-3 w-3 ${reacted ? 'fill-rose-400' : ''}`}
                aria-hidden="true"
              />
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
function Reactions({ reactions }: { reactions: ChatMessage['reactions'] }): JSX.Element | null {
  if (!reactions?.you && !reactions?.partner) return null;
  const both = reactions.you !== undefined && reactions.partner !== undefined;
  return (
    <span
      className="absolute -bottom-2 right-2 inline-flex items-center gap-0.5 rounded-full border border-ink-700 bg-ink-900 px-1.5 py-0.5 shadow-sm"
      aria-label={both ? 'You both reacted' : reactions.you ? 'You reacted' : 'They reacted'}
    >
      <Heart className="h-2.5 w-2.5 fill-rose-400 text-rose-400" aria-hidden="true" />
      {both && <span className="text-[0.6rem] font-medium text-ink-300">2</span>}
    </span>
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
