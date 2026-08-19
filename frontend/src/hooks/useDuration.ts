import { useEffect, useState } from 'react';

/**
 * How long the current conversation has been running, as `mm:ss`.
 *
 * Purely cosmetic, and deliberately local: the server does not send a duration,
 * and the `startedAt` on the `matched` frame is the authority for when it
 * began. Ticks only while a conversation is live.
 */
export function useDuration(startedAt: string | null): string {
  const [, tick] = useState(0);

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  if (startedAt === null) return '00:00';
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return '00:00';

  const elapsed = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
