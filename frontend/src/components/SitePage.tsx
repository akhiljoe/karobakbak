/**
 * The shell every static page shares: header, readable column, footer.
 *
 * ---------------------------------------------------------------------------
 * ONE TEMPLATE, NOT SIX PAGES
 * ---------------------------------------------------------------------------
 * About, FAQ, Safety, Rules, Terms and Privacy differ only in their content,
 * which already lives as data in `content/pages.ts`. Giving each its own layout
 * would guarantee they drift — one gets a wider measure, another a different
 * heading size, and nobody notices until they are read back to back.
 *
 * ---------------------------------------------------------------------------
 * THE MEASURE IS THE DESIGN DECISION
 * ---------------------------------------------------------------------------
 * `max-w-2xl` on the prose column is roughly 65-75 characters at this type
 * size, which is the range long-form text stays readable in. These are pages
 * people open when they are worried about something — legibility beats
 * personality, and a full-width paragraph on a 1440px monitor is neither.
 */
import { ArrowLeft } from "lucide-react";

import type { StaticPage } from "../content/pages";
import { RouteLink, useDocumentTitle } from "../router";
import { Logo } from "./Logo";
import { SiteFooter } from "./SiteFooter";
import { SiteNav } from "./SiteNav";

interface SitePageProps {
  readonly page: StaticPage;
  /**
   * Anything a page needs that prose cannot carry — a link, a form, a live
   * value. Rendered above the sections, because on the one page that has this
   * (Contact) the actionable part is what the visitor came for and the prose is
   * context around it.
   */
  readonly children?: React.ReactNode;
}

export function SitePage({ page, children }: SitePageProps): JSX.Element {
  useDocumentTitle(`${page.title} · karobakbak`);

  /*
   * A scroll container of its own.
   *
   * `#root` is `h-[100dvh]` with `overflow-hidden` (see index.css), because the
   * chat app owns exactly one viewport and scrolls inside itself. A document
   * page that only set `min-h-full` therefore grew past the root and was
   * **clipped with no way to scroll to the rest** — it simply ended mid-sentence
   * on any screen shorter than its content.
   *
   * So the outer element scrolls and the inner one keeps `min-h-full`, which
   * still lets a short page push its footer to the bottom edge. `sticky` on the
   * header resolves against this container rather than the viewport, which is
   * what keeps it in place while the prose moves.
   */
  return (
    <div className="h-full overflow-y-auto bg-ink-950">
      <div className="flex min-h-full flex-col">
        <header className="safe-pt sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between gap-3 px-5 sm:px-6">
            <RouteLink
              to="/"
              aria-label="karobakbak — home"
              className="rounded-lg transition-opacity hover:opacity-80"
            >
              <Logo size={24} />
            </RouteLink>

            <div className="flex items-center gap-2">
              <SiteNav />
              <RouteLink
                to="/"
                className="inline-flex items-center gap-1.5 rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-50"
              >
                <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                Start chatting
              </RouteLink>
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-50 sm:text-4xl">
            {page.title}
          </h1>
          <p className="mt-2 text-base text-ink-400">{page.summary}</p>

          {children !== undefined && <div className="mt-8">{children}</div>}

          <div className="mt-9">
            {page.sections.map((section) => (
              <section key={section.heading} className="mb-8 last:mb-0">
                <h2 className="mb-2.5 font-display text-lg font-semibold text-ink-100">
                  {section.heading}
                </h2>
                {section.body.map((paragraph) => (
                  <p
                    key={paragraph}
                    className="mb-3 text-base leading-relaxed text-ink-300 last:mb-0"
                  >
                    {paragraph}
                  </p>
                ))}
              </section>
            ))}
          </div>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
