/**
 * A compact connection pill.
 *
 * ---------------------------------------------------------------------------
 * WHEN THE LABEL IS VISIBLE, AND WHY IT IS NOT ALWAYS
 * ---------------------------------------------------------------------------
 * "Connected" is the state a conversation is in essentially all of the time, so
 * spelling it out beside the stranger's name is a word that never changes and
 * never helps — it crowds the declared profile on a phone to say what a green
 * dot already says.
 *
 * The other states keep their labels, and that asymmetry is the point: a
 * problem must never be signalled by colour alone. An amber dot on its own
 * leaves somebody guessing at exactly the moment the interface owes them an
 * explanation, and a colour-blind user nothing at all.
 *
 * The healthy state still carries a text label for assistive technology, it is
 * simply not painted. Nobody loses the information; it stops taking up room.
 */
import type { ConnectionView } from '../view/presentation';

const MAP: Record<ConnectionView, { dot: string; label: string; text: string }> = {
  connected: { dot: 'bg-sage-400', label: 'Connected', text: 'text-ink-300' },
  connecting: { dot: 'bg-amber-400', label: 'Connecting', text: 'text-amber-300' },
  reconnecting: { dot: 'bg-amber-400', label: 'Reconnecting', text: 'text-amber-300' },
};

export function ConnectionStatus({ state }: { state: ConnectionView }): JSX.Element {
  const s = MAP[state];
  const healthy = state === 'connected';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className="relative flex h-2 w-2">
        {!healthy && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${s.dot} opacity-60`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${s.dot}`} />
      </span>
      <span className={healthy ? 'sr-only' : undefined}>{s.label}</span>
    </span>
  );
}
