/**
 * An advertising slot.
 *
 * Renders nothing at all when ads are disabled or the provider declines, which
 * is the normal case. It is deliberately never placed inside the conversation:
 * the ads document requires that advertising not interrupt the chat, and a slot
 * that exists only on the landing and between-chats screens cannot.
 */
import { adsEnabled, providerFrom, type AdPlacement } from '../ads/provider';

const provider = providerFrom(import.meta.env.VITE_ADS_PROVIDER);

export function AdSlot({ slot }: AdPlacement): JSX.Element | null {
  if (!adsEnabled()) return null;
  const creative = provider.request({ slot });
  if (!creative) return null;

  return (
    <aside className="ad" aria-label="Sponsored">
      <p className="ad__headline">{creative.headline}</p>
      <p className="ad__body">{creative.body}</p>
    </aside>
  );
}
