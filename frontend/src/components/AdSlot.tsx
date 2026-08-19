/**
 * An advertising slot.
 *
 * Renders nothing at all when ads are disabled or the provider declines, which
 * is the normal case. It is deliberately never placed inside the conversation:
 * the ads document requires that advertising not interrupt the chat, and a slot
 * that exists only on the landing, between-chats and desktop-rail positions
 * cannot.
 */
import { adsEnabled, providerFrom, type AdPlacement } from '../ads/provider';

const provider = providerFrom(import.meta.env.VITE_ADS_PROVIDER);

export function AdSlot({ slot }: AdPlacement): JSX.Element | null {
  if (!adsEnabled()) return null;
  const creative = provider.request({ slot });
  if (!creative) return null;

  return (
    <aside
      className="rounded-2xl border border-ink-800 bg-ink-900/40 p-4 text-left"
      aria-label="Sponsored"
    >
      <p className="text-sm font-semibold text-ink-100">{creative.headline}</p>
      <p className="mt-1 text-xs text-ink-400">{creative.body}</p>
    </aside>
  );
}
