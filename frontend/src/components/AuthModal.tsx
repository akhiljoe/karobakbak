/**
 * The sign-in surface — kept, and switched off.
 *
 * ---------------------------------------------------------------------------
 * THIS COMPONENT IS NOT REACHABLE IN THIS BUILD
 * ---------------------------------------------------------------------------
 * `ACCOUNTS_ENABLED` in `features.ts` is `false`, and `App.tsx` does not mount
 * this at all while it is. The file exists so the design work survives until
 * the decision that gates it is made.
 *
 * That decision is not a technical one. `DESIGN.md` §24 defers anonymous
 * accounts, recent chats and friend connections until the minor-safety and
 * age-assurance work is complete, because persistent identity plus mutual
 * connections **raises** grooming risk rather than lowering it. Turning the
 * flag on before that review is done would ship the exact thing the review
 * exists to rule on.
 *
 * Deliberately, there is no authentication client here — no Supabase, no
 * token storage, no network call of any kind. The original design shipped with
 * a hosted auth provider wired in; that was removed rather than disabled,
 * because a credential form pointed at a live external service is not
 * something to leave one boolean away from working. `onSubmit` is where a real
 * implementation would go, and it is the only way anything leaves this
 * component.
 */
import { useEffect, useState } from 'react';
import { Info, X } from 'lucide-react';

import { ACCOUNTS_ENABLED } from '../features';
import { Button } from './Button';

interface AuthModalProps {
  open: boolean;
  onClose(): void;
  /** Where a real implementation would take over. Never called while disabled. */
  onSubmit?(mode: 'sign_in' | 'sign_up', email: string, password: string): void;
}

export function AuthModal({ open, onClose, onSubmit }: AuthModalProps): JSX.Element | null {
  const [mode, setMode] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    // The guard is here as well as at the mount site: a component that can
    // submit credentials should refuse to do so itself, not rely on its parent.
    if (!ACCOUNTS_ENABLED || !onSubmit) return;
    onSubmit(mode, email, password);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
    >
      <div className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative w-full max-w-sm animate-fade-in rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl sm:p-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold text-ink-50">
            {mode === 'sign_in' ? 'Welcome back' : 'Create an account'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!ACCOUNTS_ENABLED && (
          <div className="mb-4 flex gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3.5 py-3">
            <Info className="h-4 w-4 shrink-0 text-amber-400" />
            <p className="text-xs leading-relaxed text-amber-100/90">
              <span className="font-semibold">Accounts are not available.</span> karobakbak is
              anonymous — no signup, no profile, no history. This screen is a placeholder for a
              decision that has not been made yet.
            </p>
          </div>
        )}

        <form onSubmit={submit} className="flex flex-col gap-2.5">
          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-500">
              Email
            </span>
            <input
              type="email"
              value={email}
              disabled={!ACCOUNTS_ENABLED}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-600 focus:border-amber-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="you@example.com"
            />
          </label>

          <label className="block">
            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-ink-500">
              Password
            </span>
            <input
              type="password"
              value={password}
              disabled={!ACCOUNTS_ENABLED}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-xl border border-ink-700 bg-ink-950 px-3 py-2.5 text-sm text-ink-100 placeholder:text-ink-600 focus:border-amber-400/50 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="••••••••"
            />
          </label>

          <Button type="submit" disabled={!ACCOUNTS_ENABLED} className="mt-1 w-full">
            {mode === 'sign_in' ? 'Sign in' : 'Create account'}
          </Button>
        </form>

        <button
          onClick={() => setMode(mode === 'sign_in' ? 'sign_up' : 'sign_in')}
          className="mt-3 w-full text-center text-xs text-ink-400 transition-colors hover:text-ink-200"
        >
          {mode === 'sign_in' ? 'Need an account? Sign up' : 'Already have one? Sign in'}
        </button>
      </div>
    </div>
  );
}
