/**
 * The desktop advertising column.
 *
 * Reserves space on wide screens and nothing else. The provider behind it is a
 * no-op until a real one is chosen (`ads/provider.ts`), and it is handed a slot
 * name — never a session, a match, a partner or a message (D22, I13).
 *
 * Hidden below `xl`, so it can never push or overlap the conversation. When no
 * provider is configured the reserved space is shown as such rather than left
 * blank, so the layout it will occupy is visible while building.
 */
import { adsEnabled } from '../ads/provider';
import { AdSlot } from './AdSlot';

export function AdRail(): JSX.Element {
  return (
    <aside className="hidden w-[260px] shrink-0 xl:block" aria-label="Sponsored content">
      <div className="sticky top-16 flex h-[calc(100dvh-4rem)] flex-col">
        <div className="m-3 flex flex-1 items-center justify-center rounded-2xl border border-dashed border-ink-800 bg-ink-900/30 p-6 text-center">
          {adsEnabled() ? (
            <AdSlot slot="between-chats" />
          ) : (
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-ink-600">Ad space</p>
              <p className="mt-2 text-xs text-ink-600">
                Reserved for non-intrusive sponsored content.
              </p>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
