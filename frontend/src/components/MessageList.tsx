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
}

/** Two messages from the same side within this window are visually grouped. */
const GROUPING_WINDOW_MS = 60_000;

export function MessageList({
  messages,
  partnerTyping,
  partnerColour,
  conversationOpen,
  reported,
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
              Date.parse(message.at) - Date.parse(previous.at) < GROUPING_WINDOW_MS;
            return (
              <Bubble
                key={message.id}
                message={message}
                grouped={grouped}
                partnerColour={partnerColour}
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
}: {
  message: ChatMessage;
  grouped: boolean;
  partnerColour: string;
}): JSX.Element {
  const mine = message.from === 'you';
  return (
    <li
      className={`flex animate-msg-in ${mine ? 'justify-end' : 'justify-start'} ${
        grouped ? 'mt-0.5' : 'mt-2'
      }`}
    >
      <div className={`flex max-w-[78%] flex-col ${mine ? 'items-end' : 'items-start'}`}>
        <div
          className={`whitespace-pre-wrap break-words px-3.5 py-2.5 text-[0.95rem] leading-relaxed ${
            mine
              ? 'rounded-2xl rounded-br-md bg-amber-400 text-ink-950'
              : 'rounded-2xl rounded-bl-md bg-ink-800 text-ink-100'
          }`}
          style={mine ? undefined : { borderLeft: `2px solid ${partnerColour}55` }}
        >
          {renderBody(message)}
        </div>
        <span className="mt-1 flex items-center gap-1.5 px-1 text-[0.65rem] text-ink-500">
          <time dateTime={message.at}>{formatTime(message.at)}</time>
          {mine ? <MessageStatus status={message.status} /> : null}
        </span>
      </div>
    </li>
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
    failed: 'Failed',
  };
  const tone = status === 'withheld' || status === 'failed' ? 'text-rose-400' : 'text-ink-500';
  return <span className={tone}>· {label[status]}</span>;
}

/** Wall-clock time, in the reader's locale. */
function formatTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return '';
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
