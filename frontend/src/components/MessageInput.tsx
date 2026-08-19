/**
 * The composer.
 *
 * ---------------------------------------------------------------------------
 * THE LENGTH LIMIT COMES FROM THE SERVER
 * ---------------------------------------------------------------------------
 * `maxLength` is whatever arrived on the `connected` frame, not a constant in
 * this file. The server enforces it regardless; matching it here means the
 * counter tells the truth and a message is never composed only to be refused.
 * Counting is done with `Array.from` because the server counts **code points**,
 * and `String.length` would disagree with it on any emoji.
 *
 * Typing notifications are debounced by `useChat`, which knows the per-command
 * rate limit. This component only reports intent.
 */
import { useEffect, useRef, useState } from 'react';
import { Send } from 'lucide-react';

interface MessageInputProps {
  maxLength: number;
  disabled: boolean;
  onSend(text: string): void;
  onTyping(active: boolean): void;
}

/** How tall the textarea may grow before it scrolls instead. */
const MAX_HEIGHT_PX = 120;

/** Show the remaining-characters counter only once it starts to matter. */
const COUNTER_VISIBLE_AT = 120;

export function MessageInput({
  maxLength,
  disabled,
  onSend,
  onTyping,
}: MessageInputProps): JSX.Element {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const length = Array.from(value).length;
  const remaining = maxLength - length;

  // Grow with the content, up to a ceiling.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  // A composer that goes away mid-sentence must withdraw the indicator, or the
  // partner is left watching "typing…" from someone who is gone.
  useEffect(() => {
    if (disabled) onTyping(false);
  }, [disabled, onTyping]);

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || disabled) return;
    onSend(trimmed);
    setValue('');
    onTyping(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    // Truncate by code point, matching how the server measures it.
    const next = Array.from(event.target.value).slice(0, maxLength).join('');
    setValue(next);
    if (!disabled) onTyping(next.trim().length > 0);
  };

  return (
    <div className="border-t border-ink-800 bg-ink-950/90 backdrop-blur-md">
      <div className="px-2 py-2 sm:px-4">
        <div
          className={`mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border bg-ink-900 px-2.5 py-1.5 transition-colors sm:px-3 ${
            disabled ? 'border-ink-800 opacity-60' : 'border-ink-700 focus-within:border-amber-400/50'
          }`}
        >
          <textarea
            ref={textareaRef}
            rows={1}
            value={value}
            disabled={disabled}
            onChange={onChange}
            onKeyDown={onKeyDown}
            placeholder={disabled ? 'Waiting to match…' : 'Type a message…'}
            aria-label="Message"
            className="flex-1 resize-none bg-transparent py-1.5 text-base text-ink-50 placeholder:text-ink-500 focus:outline-none disabled:cursor-not-allowed"
          />
          <div className="flex items-center gap-2 pb-1">
            {remaining < COUNTER_VISIBLE_AT && (
              <span
                className={`font-mono text-xs ${remaining < 20 ? 'text-rose-400' : 'text-ink-500'}`}
                aria-label={`${remaining} characters remaining`}
              >
                {remaining}
              </span>
            )}
            <button
              type="button"
              onClick={submit}
              disabled={disabled || value.trim().length === 0}
              aria-label="Send message"
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-400 text-ink-950 transition-all hover:bg-amber-300 active:scale-95 disabled:bg-ink-700 disabled:text-ink-500 disabled:active:scale-100"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
