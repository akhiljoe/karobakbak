/**
 * The footer on the landing screen.
 *
 * Replaces a single row of two links. The safety line above it stays where it
 * was — it is the one piece of footer text somebody actually reads before
 * starting a conversation, and moving it into a column of links would bury it.
 *
 * ---------------------------------------------------------------------------
 * EVERY PAGE IS NOW IN THE PRODUCT, INCLUDING THE LEGAL ONES
 * ---------------------------------------------------------------------------
 * Terms and Privacy used to be outbound links to a domain that does not exist,
 * so they were hidden — and `docs/policies/README.md` step 5 says a policy
 * nobody can find is not published. They are pages now (`content/legal.ts`),
 * which removes the domain from the critical path entirely: the documents ship
 * with the bundle.
 *
 * Contact and the donation link are still configuration, and an unset one is
 * **omitted** rather than rendered as a dead link or a `mailto:` to nothing. An
 * address that bounces is worse than no address, because the Privacy page
 * commits to acknowledging complaints within 24 hours.
 */
import { Shield } from 'lucide-react';

import { clientConfig } from '../config';
import { STATIC_PAGES } from '../content/pages';
import { RouteLink } from '../router';
import { navPaths } from './SiteNav';

/*
 * Only what the header does not already carry.
 *
 * The header navigates the product; this is for the things somebody looks up
 * once. Listing all nine in both places made the footer four lines tall on a
 * narrow screen and taught nobody anything the header had not already said.
 */
export function SiteFooter(): JSX.Element {
  const inHeader = navPaths();
  return (
    <footer className="safe-pb shrink-0 border-t border-ink-800/50 px-6 py-5 short:py-3">
      <div className="mx-auto flex max-w-lg items-start justify-center gap-2 text-center text-sm leading-relaxed text-ink-300">
        <Shield className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" />
        <span>
          Be kind. Report or block anyone who makes you uncomfortable. Conversations are kept for a
          limited period so abuse can be investigated, then deleted automatically.
        </span>
      </div>

      <nav
        aria-label="Site"
        className="mx-auto mt-4 flex max-w-lg flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-ink-400 short:mt-2.5"
      >
        {STATIC_PAGES.filter((page) => !inHeader.has(`/${page.id}`)).map((page) => (
          <RouteLink
            key={page.id}
            to={`/${page.id}`}
            className="rounded py-1 underline underline-offset-4 transition-colors hover:text-ink-100"
          >
            {page.title}
          </RouteLink>
        ))}

        {clientConfig.supportUrl !== '' && (
          <a
            href={clientConfig.supportUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="rounded py-1 underline underline-offset-4 transition-colors hover:text-amber-300"
          >
            Buy me a coffee
          </a>
        )}


      </nav>
    </footer>
  );
}
