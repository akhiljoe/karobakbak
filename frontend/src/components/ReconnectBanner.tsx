/**
 * Shown while the socket is away.
 *
 * The copy used to say the conversation was over, which was true under D7 and
 * became a lie under §28/D42: the server now holds the seat for a bounded
 * window and the conversation usually does come back. Worse than merely wrong —
 * told it was already finished, a person closes the tab, and closing the tab
 * takes the `sessionStorage` resume token with it and makes the sentence true.
 *
 * So it says what is actually happening, and it says the window is bounded.
 * `ChatShell` shows the seconds beside it; this stays legible without them.
 */
import { WifiOff } from 'lucide-react';

import type { ConnectionView } from '../view/presentation';

export function ReconnectBanner({ connection }: { connection: ConnectionView }): JSX.Element | null {
  if (connection === 'connected') return null;

  return (
    <div
      role="status"
      aria-live="assertive"
      className="flex animate-fade-in items-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-2 text-sm text-amber-200 sm:px-4"
    >
      <WifiOff className="h-4 w-4 shrink-0" />
      {connection === 'connecting'
        ? 'Connecting…'
        : 'Connection lost. Reconnecting — your conversation is held for a moment.'}
    </div>
  );
}
