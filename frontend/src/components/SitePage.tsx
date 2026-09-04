/**
 * The shell Terms and Privacy share.
 *
 * ---------------------------------------------------------------------------
 * IT SUPPLIES THE PROSE, `EditorialShell` SUPPLIES THE CHROME
 * ---------------------------------------------------------------------------
 * This used to carry its own header and its own `SiteFooter`, which was right
 * while every reference page rendered through it. One by one they left — About,
 * How it works, Rules, Contact, FAQ and Safety all took their own layouts on
 * top of `EditorialShell` — and Terms and Privacy were the two nobody moved.
 *
 * So the chrome drifted. `EditorialShell` pins its footer, aligns it to the
 * header's gutter and sets a 680px measure; this file had a footer at the end
 * of the prose, a `max-w-4xl` header and a 672px measure. Nothing failed and
 * nothing looked broken in isolation — the two documents simply stopped
 * matching the seven pages around them, which is only visible when you open one
 * after another.
 *
 * The fix is not to copy the numbers across. Two files reaching the same
 * numbers by hand is how they drifted in the first place. What remains here is
 * the part that is genuinely about these pages: turning `PageSection` data into
 * a column of prose.
 *
 * ---------------------------------------------------------------------------
 * ONE TEMPLATE, NOT TWO PAGES
 * ---------------------------------------------------------------------------
 * Terms and Privacy differ only in their content, which already lives as data
 * in `content/pages.ts`. Giving each its own layout would guarantee they drift
 * — one gets a wider measure, another a different heading size, and nobody
 * notices until they are read back to back.
 */
import type { StaticPage } from "../content/pages";
import { EditorialShell } from "./EditorialShell";

interface SitePageProps {
  readonly page: StaticPage;
  /**
   * Anything a page needs that prose cannot carry — a link, a form, a live
   * value. Rendered above the sections, because on a page that has this the
   * actionable part is what the visitor came for and the prose is context
   * around it.
   */
  readonly children?: React.ReactNode;
}

/** A list, at the one size and spacing both of this template's lists use. */
function Bullets({ items }: { readonly items: readonly string[] }): JSX.Element {
  return (
    <ul className="mb-3 list-disc space-y-1.5 pl-5 last:mb-0">
      {items.map((item) => (
        <li key={item} className="text-base leading-relaxed text-ink-300">
          {item}
        </li>
      ))}
    </ul>
  );
}

/**
 * A two-column table, first row the header.
 *
 * It scrolls inside its own box rather than widening the page: the retention
 * schedule's right column is a sentence, and on a phone the alternative to a
 * scroll container is a horizontal scrollbar on the whole document.
 */
function Table({
  rows,
}: {
  readonly rows: readonly (readonly [string, string])[];
}): JSX.Element {
  const [header, ...body] = rows;
  return (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="w-full min-w-[26rem] border-collapse text-left text-base">
        {header !== undefined && (
          <thead>
            <tr className="border-b border-ink-700">
              <th scope="col" className="py-2 pr-4 font-semibold text-ink-100">
                {header[0]}
              </th>
              <th scope="col" className="py-2 font-semibold text-ink-100">
                {header[1]}
              </th>
            </tr>
          </thead>
        )}
        <tbody>
          {body.map(([label, value]) => (
            <tr key={label} className="border-b border-ink-800/70 last:border-0">
              <th
                scope="row"
                className="py-2 pr-4 align-top font-normal leading-relaxed text-ink-200"
              >
                {label}
              </th>
              <td className="py-2 align-top leading-relaxed text-ink-300">
                {value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Paragraphs, at the one size and spacing this template uses. */
function Paragraphs({
  items,
}: {
  readonly items: readonly string[];
}): JSX.Element {
  return (
    <>
      {items.map((paragraph) => (
        <p
          key={paragraph}
          className="mb-3 text-base leading-relaxed text-ink-300 last:mb-0"
        >
          {paragraph}
        </p>
      ))}
    </>
  );
}

export function SitePage({ page, children }: SitePageProps): JSX.Element {
  return (
    <EditorialShell title={page.title}>
      <h1 className="font-display text-3xl font-semibold tracking-tight text-ink-50 sm:text-4xl">
        {page.title}
      </h1>
      <p className="mt-2 text-base text-ink-400">{page.summary}</p>
      {page.intro !== undefined && (
        <p className="mt-4 text-base leading-relaxed text-ink-300">
          {page.intro}
        </p>
      )}

      {children !== undefined && <div className="mt-8">{children}</div>}

      <div className="mt-9 pb-10">
        {page.sections.map((section) => (
          <section key={section.heading} className="mb-8 last:mb-0">
            <h2 className="mb-2.5 font-display text-lg font-semibold text-ink-100">
              {section.heading}
            </h2>
            <Paragraphs items={section.body} />

            {section.rows !== undefined && <Table rows={section.rows} />}
            {section.bullets !== undefined && (
              <Bullets items={section.bullets} />
            )}
            {section.tail !== undefined && <Paragraphs items={section.tail} />}
            {/*
              The second list, and it must be rendered.

              One Privacy section says what deleting a Premium account removes,
              then — after a "however" — what it does not. Before `tailBullets`
              existed there was nowhere to put the second list, so the two were
              concatenated into the first and the page stated the reverse of
              what it meant. Dropping it here would restore that bug in a
              quieter form: the page would simply stop saying what is withheld.
            */}
            {section.tailBullets !== undefined && (
              <Bullets items={section.tailBullets} />
            )}
          </section>
        ))}
      </div>
    </EditorialShell>
  );
}
