/**
 * Shown while the socket is away.
 *
 * The copy says the conversation is over rather than paused, because it is:
 * there is no session resumption (D7), and reconnecting lands on a brand new
 * session. Telling somebody to "hold on" would imply a conversation that will
 * come back.
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
        : 'Connection lost. Reconnecting — this starts a new conversation.'}
    </div>
  );
}
