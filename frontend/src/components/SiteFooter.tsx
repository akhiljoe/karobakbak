/**
 * The footer: the things somebody looks up once.
 *
 * ---------------------------------------------------------------------------
 * WHY IT LISTS THE HEADER'S SECONDARY SET AND NOT "WHATEVER THE HEADER LACKS"
 * ---------------------------------------------------------------------------
 * This used to render `STATIC_PAGES` filtered by `navPaths()` — every page the
 * header could not reach. That was correct exactly until the header grew a menu
 * containing Rules, Contact, Terms and Privacy, at which point the filter
 * matched every page and **the footer rendered an empty `<nav>` on every screen
 * in the product**. Nothing failed; there was simply no footer any more, which
 * is the worst shape a bug can take in navigation.
 *
 * A derived list that silently empties when its source grows is the wrong
 * relationship. The footer now names what it shows: the same secondary set the
 * header keeps behind its menu button. The two are meant to agree — a reader at
 * the foot of a long page should not have to find a menu to reach the Rules —
 * and `secondaryNav()` is the one list they both read.
 *
 * ---------------------------------------------------------------------------
 * TERMS AND PRIVACY ARE PAGES, NOT OUTBOUND LINKS
 * ---------------------------------------------------------------------------
 * They used to point at a domain that does not exist, so they were hidden, and
 * `docs/policies/README.md` step 5 says a policy nobody can find is not
 * published. They ship with the bundle now (`content/legal.ts`), which takes
 * the domain off the critical path entirely.
 */

import { RouteLink } from '../router';
import { secondaryNav } from './SiteNav';

export function SiteFooter(): JSX.Element {
  return (
    <footer className="safe-pb shrink-0 border-t border-ink-800/50 px-6 py-5 short:py-3">
      <nav
        aria-label="More"
        className="mx-auto flex max-w-lg flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-ink-400"
      >
        {secondaryNav().map((item) => (
          <RouteLink
            key={item.to}
            to={item.to}
            className="rounded py-1 underline underline-offset-4 transition-colors hover:text-ink-100"
          >
            {item.label}
          </RouteLink>
        ))}
      </nav>
    </footer>
  );
}
