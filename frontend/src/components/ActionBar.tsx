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
 */
import { Flag, SkipForward } from 'lucide-react';

interface ActionBarProps {
  safetyAvailable: boolean;
  onSkip(): void;
  onOpenSafety(): void;
}

export function ActionBar({
  safetyAvailable,
  onSkip,
  onOpenSafety,
}: ActionBarProps): JSX.Element {
  return (
    <nav
      className="safe-pb flex items-stretch border-t border-ink-800 bg-ink-950/90 backdrop-blur-md"
      aria-label="Conversation actions"
    >
      <ActionButton
        onClick={onSkip}
        icon={<SkipForward className="h-5 w-5" />}
        label="Next stranger"
      />
      {safetyAvailable && (
        <ActionButton onClick={onOpenSafety} icon={<Flag className="h-5 w-5" />} label="Safety" />
      )}
    </nav>
  );
}

function ActionButton({
  onClick,
  icon,
  label,
}: {
  onClick(): void;
  icon: React.ReactNode;
  label: string;
}): JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex flex-1 flex-col items-center justify-center gap-0.5 py-2.5 transition-all active:scale-95 active:bg-ink-800"
    >
      <span className="text-ink-300">{icon}</span>
      <span className="text-[0.7rem] font-medium text-ink-400">{label}</span>
    </button>
  );
}
