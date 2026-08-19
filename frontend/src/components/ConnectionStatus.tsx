/**
 * A compact connection pill.
 *
 * State is carried by a label as well as a colour, never by colour alone.
 */
import type { ConnectionView } from '../view/presentation';

const MAP: Record<ConnectionView, { dot: string; label: string; text: string }> = {
  connected: { dot: 'bg-sage-400', label: 'Connected', text: 'text-ink-300' },
  connecting: { dot: 'bg-amber-400', label: 'Connecting', text: 'text-amber-300' },
  reconnecting: { dot: 'bg-amber-400', label: 'Reconnecting', text: 'text-amber-300' },
};

export function ConnectionStatus({ state }: { state: ConnectionView }): JSX.Element {
  const s = MAP[state];
  const animate = state !== 'connected';
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${s.text}`}>
      <span className="relative flex h-2 w-2">
        {animate && (
          <span
            className={`absolute inline-flex h-full w-full animate-ping rounded-full ${s.dot} opacity-60`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${s.dot}`} />
      </span>
      {s.label}
    </span>
  );
}
