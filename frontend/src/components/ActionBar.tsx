/**
 * The conversation action bar.
 *
 * Skip is always available. The safety entry point appears only when the
 * server said it supports reporting or blocking on the `connected` frame — a
 * button for a capability the server has turned off is a button that exists to
 * be refused.
 *
 * There is no "friend" or "connect" action. Mutual connections are deferred
 * behind the minor-safety work (`DESIGN.md` §24), and a control that sent a
 * request nothing receives would be a lie in the interface.
 *
 * Auto-next lives here rather than only in Settings because it is a decision
 * about *this* stretch of conversations, made while having them. A person three
 * skips into a bad run should be able to turn it on where they are, not go
 * looking for a settings panel — and should be able to see at a glance that it
 * is on, which a buried checkbox cannot do.
 */
import { Flag, ShieldX, SkipForward } from 'lucide-react';

interface ActionBarProps {
  safetyAvailable: boolean;
  blockAvailable: boolean;
  autoSearch: boolean;
  onSkip(): void;
  onOpenSafety(): void;
  onBlockAndNext(): void;
  onToggleAutoSearch(value: boolean): void;
}

export function ActionBar({
  safetyAvailable,
  blockAvailable,
  autoSearch,
  onSkip,
  onOpenSafety,
  onBlockAndNext,
  onToggleAutoSearch,
}: ActionBarProps): JSX.Element {
  return (
    <div className="safe-pb border-t border-ink-800 bg-ink-950/90 backdrop-blur-md">
      <label className="flex cursor-pointer items-center justify-center gap-2 border-b border-ink-800/60 px-3 py-2 text-xs text-ink-400 transition-colors hover:text-ink-200">
        <input
          type="checkbox"
          checked={autoSearch}
          onChange={(event) => onToggleAutoSearch(event.target.checked)}
          className="h-3.5 w-3.5 accent-amber-400"
        />
        <span>
          Auto-find the next stranger
          <span className="ml-1 text-ink-600">· never after you block someone</span>
        </span>
      </label>

      <nav className="flex items-stretch" aria-label="Conversation actions">
        <ActionButton
          onClick={onSkip}
          icon={<SkipForward className="h-5 w-5" />}
          label="Next stranger"
        />
        {blockAvailable && (
          <ActionButton
            onClick={onBlockAndNext}
            icon={<ShieldX className="h-5 w-5" />}
            label="Block & next"
            tone="danger"
          />
        )}
        {safetyAvailable && (
          <ActionButton onClick={onOpenSafety} icon={<Flag className="h-5 w-5" />} label="Safety" />
        )}
      </nav>
    </div>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
  tone = 'neutral',
}: {
  onClick(): void;
  icon: React.ReactNode;
  label: string;
  tone?: 'neutral' | 'danger';
}): JSX.Element {
  const danger = tone === 'danger';
  return (
    <button
      onClick={onClick}
      className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2.5 transition-all active:scale-95 active:bg-ink-800"
    >
      {/*
        Tinted, not shouting. This sits beside the button people press dozens
        of times a session, so it has to be findable in a hurry without being
        the thing the eye lands on first.
      */}
      <span className={danger ? 'text-rose-400/80' : 'text-ink-300'}>{icon}</span>
      <span className={`text-[0.7rem] font-medium ${danger ? 'text-rose-400/70' : 'text-ink-400'}`}>
        {label}
      </span>
    </button>
  );
}
