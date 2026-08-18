/**
 * The message composer.
 *
 * Pre-validates against the limits the server sent in `connected`, rather than
 * against a constant compiled into this bundle. A client that hardcodes 500 is
 * a client that starts rejecting valid messages the day an operator raises the
 * limit — and starts sending refused ones the day they lower it.
 */
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';

interface ComposerProps {
  maxLength: number;
  onSend(text: string): void;
  onTyping(active: boolean): void;
}

export function Composer({ maxLength, onSend, onTyping }: ComposerProps): JSX.Element {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const remaining = maxLength - text.length;
  const tooLong = remaining < 0;
  const canSubmit = text.trim().length > 0 && !tooLong;

  const submit = (event?: FormEvent): void => {
    event?.preventDefault();
    if (!canSubmit) return;
    onSend(text);
    setText('');
    onTyping(false);
    inputRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // Enter sends, Shift+Enter breaks the line. The reverse would make every
    // multi-line message an accident.
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <form className="composer" onSubmit={submit}>
      <textarea
        ref={inputRef}
        className="composer__input"
        value={text}
        rows={2}
        placeholder="Say something"
        aria-label="Message"
        onKeyDown={onKeyDown}
        onChange={(event) => {
          setText(event.target.value);
          onTyping(event.target.value.length > 0);
        }}
      />
      <div className="composer__side">
        <span className={tooLong ? 'composer__count composer__count--over' : 'composer__count'}>
          {remaining}
        </span>
        <button className="button button--primary" type="submit" disabled={!canSubmit}>
          Send
        </button>
      </div>
    </form>
  );
}
