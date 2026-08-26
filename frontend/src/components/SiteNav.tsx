/**
 * The header navigation, and the only navigation on the homepage.
 *
 * ---------------------------------------------------------------------------
 * WHY THE MENU EXISTS ON DESKTOP TOO
 * ---------------------------------------------------------------------------
 * The homepage has no footer. It is one screen with a button on it, and a
 * footer was the only thing making it scroll — so the links a footer carries
 * had to go somewhere, and this is it.
 *
 * That makes the menu load-bearing rather than a mobile convenience:
 * `docs/policies/age-gate.md` requires Terms and the Privacy Policy to be
 * reachable **without passing the gate**, and with no footer the header is the
 * only place left that satisfies it. A visitor who never presses "Start
 * chatting" must still be able to read both, and now can, at every screen size.
 *
 * ---------------------------------------------------------------------------
 * TWO GROUPS, DELIBERATELY UNEQUAL
 * ---------------------------------------------------------------------------
 * Primary — how it works, safety, FAQ, about — is what somebody asks before
 * deciding. Those sit inline from `md` up because they are the ones worth
 * spending header width on.
 *
 * Secondary — rules, contact, terms, privacy — is what somebody looks up once.
 * Those live in the menu at every size. Putting all nine inline would be a
 * sitemap in a header, which means the product could not decide what mattered.
 */
import { useEffect, useState } from 'react';
import { Menu, X } from 'lucide-react';

import { clientConfig } from '../config';
import { ACCOUNTS_ENABLED } from '../features';
import { RouteLink } from '../router';

interface NavItem {
  readonly to: string;
  readonly label: string;
}

const PRIMARY_BASE: readonly NavItem[] = [
  { to: '/how-it-works', label: 'How it works' },
  { to: '/safety', label: 'Safety' },
  { to: '/faq', label: 'FAQ' },
  { to: '/about', label: 'About' },
];

const SECONDARY: readonly NavItem[] = [
  { to: '/rules', label: 'Rules' },
  { to: '/contact', label: 'Contact' },
  { to: '/terms', label: 'Terms' },
  { to: '/privacy', label: 'Privacy' },
];

function primary(): readonly NavItem[] {
  if (!ACCOUNTS_ENABLED) return PRIMARY_BASE;
  // Second, matching the design: after the explanation, before the reassurance.
  return [PRIMARY_BASE[0]!, { to: '/premium', label: 'Premium' }, ...PRIMARY_BASE.slice(1)];
}

/** Every path the header can reach, so nothing else has to repeat the list. */
export function navPaths(): ReadonlySet<string> {
  return new Set([...primary(), ...SECONDARY].map((item) => item.to));
}

const INLINE_CLASS =
  'rounded-lg px-2 py-1.5 text-sm text-ink-300 transition-colors hover:bg-ink-800/60 hover:text-ink-50';

const PANEL_CLASS =
  'rounded-lg px-3 py-2.5 text-base text-ink-200 transition-colors hover:bg-ink-800 hover:text-ink-50';

export function SiteNav(): JSX.Element {
  const [open, setOpen] = useState(false);
  const links = primary();
  const support = clientConfig.supportUrl;

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const close = (): void => setOpen(false);

  return (
    <>
      <nav aria-label="Site" className="hidden items-center gap-0.5 md:flex">
        {links.map((item) => (
          <RouteLink key={item.to} to={item.to} className={INLINE_CLASS}>
            {item.label}
          </RouteLink>
        ))}
      </nav>

      <button
        onClick={() => setOpen(true)}
        aria-label="More"
        aria-expanded={open}
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-300 transition-colors hover:bg-ink-800 hover:text-ink-50"
      >
        <Menu className="h-5 w-5" />
      </button>

      {open && (
        <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Menu">
          <div
            className="absolute inset-0 animate-fade-in bg-ink-950/70 backdrop-blur-sm"
            onClick={close}
          />

          <div className="safe-pt absolute inset-x-0 top-0 animate-fade-in border-b border-ink-700 bg-ink-900 px-3 pb-3 shadow-lift sm:inset-x-auto sm:right-3 sm:top-3 sm:w-64 sm:rounded-2xl sm:border">
            <div className="flex justify-end py-1">
              <button
                onClick={close}
                aria-label="Close menu"
                className="rounded-lg p-1.5 text-ink-400 transition-colors hover:bg-ink-800 hover:text-ink-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {/* Already inline on desktop; only the small header needs these. */}
            <nav aria-label="Product" className="flex flex-col md:hidden">
              {links.map((item) => (
                <RouteLink key={item.to} to={item.to} onClick={close} className={PANEL_CLASS}>
                  {item.label}
                </RouteLink>
              ))}
            </nav>

            <div className="my-2 border-t border-ink-800 md:mt-0" />

            <nav aria-label="More" className="flex flex-col">
              {SECONDARY.map((item) => (
                <RouteLink key={item.to} to={item.to} onClick={close} className={PANEL_CLASS}>
                  {item.label}
                </RouteLink>
              ))}
              {support !== '' && (
                <a
                  href={support}
                  target="_blank"
                  rel="noreferrer noopener"
                  onClick={close}
                  className={`${PANEL_CLASS} text-amber-300/90 hover:text-amber-300`}
                >
                  Buy me a coffee
                </a>
              )}
            </nav>
          </div>
        </div>
      )}
    </>
  );
}
