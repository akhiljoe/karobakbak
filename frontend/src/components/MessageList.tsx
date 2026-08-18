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
 */
import type { ChatMessage } from '../state/machine';

/** Which renderer a message needs. Pure, so the boundary is testable. */
export type MessageKind = 'text' | 'unsupported';

export function messageKindFor(type: string): MessageKind {
  return type === 'text' ? 'text' : 'unsupported';
}

interface MessageListProps {
  messages: readonly ChatMessage[];
  youNickname: string;
  partnerNickname: string;
  youColour: string;
  partnerColour: string;
}

export function MessageList({
  messages,
  youNickname,
  partnerNickname,
  youColour,
  partnerColour,
}: MessageListProps): JSX.Element {
  return (
    <ol className="messages" aria-live="polite" aria-label="Conversation">
      {messages.map((message) => {
        const mine = message.from === 'you';
        return (
          <li key={message.id} className={mine ? 'message message--mine' : 'message'}>
            <span className="message__who" style={{ color: mine ? youColour : partnerColour }}>
              {mine ? youNickname : partnerNickname}
            </span>
            {renderBody(message)}
            {mine ? <MessageStatus status={message.status} /> : null}
          </li>
        );
      })}
    </ol>
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
 * builds HTML from it — the message came from a stranger, and the whole
 * pipeline treats it as data rather than markup.
 */
function TextMessage({ text }: { text: string }): JSX.Element {
  return <p className="message__text">{text}</p>;
}

/** A content type this build cannot render. Neutral, and never an error. */
function UnsupportedMessage(): JSX.Element {
  return (
    <p className="message__text message__text--unsupported">
      This message can&rsquo;t be shown in this version.
    </p>
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
  return (
    <span className={`message__status message__status--${status}`}>{label[status]}</span>
  );
}
