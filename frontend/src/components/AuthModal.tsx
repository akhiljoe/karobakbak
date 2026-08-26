/**
 * The sign-in surface — premium only, and switched off.
 *
 * ---------------------------------------------------------------------------
 * THIS COMPONENT IS NOT REACHABLE IN THIS BUILD
 * ---------------------------------------------------------------------------
 * `ACCOUNTS_ENABLED` in `features.ts` is `false`, and `App.tsx` does not mount
 * this at all while it is. The file exists so the design work survives until
 * the decision that gates it is made, and turning the flag on is a commit
 * rather than a deploy.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PASSWORD FIELDS ARE GONE
 * ---------------------------------------------------------------------------
 * This was an email-and-password form with sign-in and sign-up modes. It is now
 * a single one-time link, because the account it guards is a subscription and
 * nothing else.
 *
 * A password is a credential this service would have to store, reset, rate
 * limit and one day be breached over, in exchange for protecting a ₹99
 * subscription that holds no conversation history. A link sent to the address
 * that already identifies the subscription is strictly less to get wrong, and
 * it keeps the account surface as small as the rest of the product claims: an
 * address and a subscription state, nothing that describes a person.
 *
 * ---------------------------------------------------------------------------
 * NO AUTHENTICATION CLIENT, DELIBERATELY
 * ---------------------------------------------------------------------------
 * No Supabase, no token storage, no network call of any kind. The original
 * design shipped with a hosted auth provider wired in; that was removed rather
 * than disabled, because a credential form pointed at a live external service
 * is not something to leave one boolean away from working. `onSubmit` is where
 * a real implementation goes, and it is the only way anything leaves here.
 *
 * While `PAYMENTS_ENABLED` is false the form says nothing was sent, rather than
 * showing "check your inbox" for a mail that will never arrive. A fake success
 * state is the most disorienting thing an unfinished flow can do, because the
 * person goes away and waits for it.
 */
import { useEffect, useState } from 'react';
import { Mail, X } from 'lucide-react';

import { ACCOUNTS_ENABLED, PAYMENTS_ENABLED } from '../features';
import { Button } from './Button';

interface AuthModalProps {
  open: boolean;
  onClose(): void;
  /** Where a real implementation would take over. Never called while disabled. */
  onSubmit?(email: string): void;
}

export function AuthModal({ open, onClose, onSubmit }: AuthModalProps): JSX.Element | null {
  const [email, setEmail] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const live = ACCOUNTS_ENABLED && PAYMENTS_ENABLED;

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    // The guard is here as well as at the mount site: a component that can
    // submit an address should refuse to do so itself, not rely on its parent.
    if (!live || !onSubmit) return;
    onSubmit(email);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Sign in"
    >
      <div
        className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-sm animate-fade-in rounded-t-3xl border border-ink-700 bg-ink-900 p-4 shadow-lift sm:rounded-3xl sm:p-5">
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-ink-700 sm:hidden" />

        <div className="mb-1 flex items-start justify-between gap-4">
          <h2 className="font-display text-lg font-semibold text-ink-50">Sign in</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <p className="mb-4 text-sm leading-relaxed text-ink-400">
          Only for premium subscriptions. Chatting needs no account and never will.
        </p>

        <form onSubmit={submit}>
          <label htmlFor="signin-email" className="mb-1.5 block text-sm text-ink-300">
            Email address
          </label>
          <div className="relative">
            <Mail
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-500"
              aria-hidden="true"
            />
            <input
              id="signin-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              disabled={!live}
              className="h-12 w-full rounded-xl border border-ink-700 bg-ink-950 pl-9 pr-3 text-base text-ink-100 placeholder:text-ink-600 focus:border-amber-400/60 focus:outline-none focus:ring-2 focus:ring-amber-400/25 disabled:opacity-50"
            />
          </div>

          <div className="mt-3">
            <Button size="lg" className="w-full" disabled={!live}>
              Send me a sign-in link
            </Button>
          </div>
        </form>

        {!live && (
          <p className="mt-3 rounded-lg border border-dashed border-amber-400/40 bg-amber-400/5 px-3 py-2.5 text-sm leading-relaxed text-ink-400">
            <span className="font-medium text-amber-300">Not live yet.</span> Subscriptions are not
            open, so there is nothing to sign in to and no mail will be sent.
          </p>
        )}

        <p className="mt-4 text-xs leading-relaxed text-ink-500">
          No password to forget, and none for us to lose. The address identifies the subscription
          and nothing else — your conversations are not linked to it.
        </p>
      </div>
    </div>
  );
}
