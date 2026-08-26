/**
 * The 404.
 *
 * Deliberately a real page rather than a redirect to the homepage. A redirect
 * loses the information that something was wrong — the visitor believes they
 * arrived at what they asked for, and a crawler indexes the landing screen
 * under every mistyped URL it finds.
 *
 * It also does the one useful thing a 404 can: puts the primary action back in
 * front of somebody who is otherwise at a dead end.
 */
import { LogoMark } from './Logo';
import { RouteLink, useDocumentTitle } from '../router';
import { STATIC_PAGES } from '../content/pages';

export function NotFound(): JSX.Element {
  useDocumentTitle('Not found · karobakbak');

  return (
    <div className="flex h-full flex-col items-center justify-center overflow-y-auto bg-ink-950 px-6 py-16 text-center">
      <LogoMark size={44} />

      <h1 className="mt-6 font-display text-3xl font-semibold tracking-tight text-ink-50 sm:text-4xl">
        Nothing here.
      </h1>
      <p className="mt-3 max-w-sm text-base text-ink-300">
        That page does not exist, or it never did. No harm done.
      </p>

      <RouteLink
        to="/"
        className="mt-7 inline-flex h-12 items-center justify-center rounded-xl bg-amber-400 px-6 font-medium text-ink-950 shadow-[0_6px_24px_-10px_rgba(255,180,32,0.55)] transition-all hover:bg-amber-300 active:scale-[0.98]"
      >
        Start chatting
      </RouteLink>

      <nav
        aria-label="Pages"
        className="mt-10 flex max-w-md flex-wrap items-center justify-center gap-x-5 gap-y-1 text-sm text-ink-400"
      >
        {STATIC_PAGES.map((page) => (
          <RouteLink
            key={page.id}
            to={`/${page.id}`}
            className="rounded py-1 underline underline-offset-4 transition-colors hover:text-ink-100"
          >
            {page.title}
          </RouteLink>
        ))}
      </nav>
    </div>
  );
}
