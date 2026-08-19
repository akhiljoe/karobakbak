/**
 * A single conversation prompt, offered at the start of a match.
 *
 * Using one sends it as an ordinary message — there is no special path, and it
 * is moderated, rate limited and retained exactly like anything else typed by
 * hand.
 */
import { useState } from 'react';
import { ChevronRight, Sparkles, X } from 'lucide-react';

import { ICEBREAKERS } from '../icebreakers';

interface IcebreakerBarProps {
  onUse(prompt: string): void;
  onDismiss(): void;
}

export function IcebreakerBar({ onUse, onDismiss }: IcebreakerBarProps): JSX.Element | null {
  // Picked once per mount, so it does not change under the reader mid-glance.
  const [pick] = useState(() => {
    const category = ICEBREAKERS[Math.floor(Math.random() * ICEBREAKERS.length)];
    if (!category) return null;
    const prompt = category.prompts[Math.floor(Math.random() * category.prompts.length)];
    if (prompt === undefined) return null;
    return { category: category.category, prompt };
  });

  if (pick === null) return null;

  return (
    <div className="animate-fade-in border-b border-ink-800 bg-ink-900/60 px-2.5 py-2 sm:px-4 sm:py-2.5">
      <div className="mx-auto flex max-w-3xl items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-400/15 text-amber-400">
          <Sparkles className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[0.65rem] font-semibold uppercase tracking-wide text-amber-400/70">
            {pick.category} · Break the ice
          </p>
          <p className="truncate text-sm text-ink-200">{pick.prompt}</p>
        </div>
        <button
          onClick={() => onUse(pick.prompt)}
          className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-amber-400/15 px-2.5 py-1.5 text-xs font-medium text-amber-300 transition-all hover:bg-amber-400/25 active:scale-95"
        >
          Use <ChevronRight className="h-3 w-3" />
        </button>
        <button
          onClick={onDismiss}
          aria-label="Dismiss icebreaker"
          className="shrink-0 rounded-lg p-1 text-ink-500 transition-colors hover:bg-ink-800 hover:text-ink-300"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
