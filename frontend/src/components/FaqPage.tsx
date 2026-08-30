/**
 * FAQ, from `FAQPage.dc.html`.
 *
 * ---------------------------------------------------------------------------
 * NATIVE `<details>`, NOT AN ACCORDION COMPONENT
 * ---------------------------------------------------------------------------
 * The design calls for progressive disclosure, and the browser already has it.
 * `<details>`/`<summary>` gives keyboard operation, the correct ARIA semantics
 * and — the part a hand-built accordion always loses — **find-in-page**. Ctrl+F
 * on this page opens the section containing the match, because browsers expand
 * a closed `<details>` to reveal a hit inside it. A `useState` accordion keeps
 * its answers out of the DOM or hidden, and twenty answers become unsearchable
 * on a page whose entire job is answering a question somebody arrived with.
 *
 * It also means no JavaScript decides whether an answer is visible, so the page
 * works before hydration and keeps working if the bundle fails.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GROUPING IS PRESENTATION AND THE ORDER IS NOT
 * ---------------------------------------------------------------------------
 * `FAQ.sections` is the copy in the operator's order. `FAQ_GROUPS` names which
 * questions sit under which rule and in what order they are drawn. The numbers
 * on the chips are the position in the *rendered* sequence, so they read 1..20
 * down the page rather than exposing the order of the source file.
 *
 * A heading named in a group that no longer exists is a silent gap — the
 * question simply stops rendering. `faq.test.ts` fails on that rather than
 * leaving it to be noticed.
 */
import { EditorialShell } from './EditorialShell';
import { FAQ, FAQ_GROUPS, FAQ_OPEN_BY_DEFAULT, FAQ_VERDICT_FIRST } from '../content/faq';
import type { PageSection } from '../content/pages';
import { useDocumentTitle } from '../router';

export function FaqPage(): JSX.Element {
  useDocumentTitle(`${FAQ.title} · karobakbak`);

  const byHeading = new Map(FAQ.sections.map((section) => [section.heading, section]));
  let number = 0;

  return (
    <EditorialShell title={FAQ.title}>
      {/* ---------------------------------------------------------------- hero */}
      <div>
        <div className="flex animate-rise items-center gap-2.5">
          <span className="block h-[7px] w-[7px] animate-float-slow rounded-full bg-amber-400" />
          <span className="font-mono text-[13px] uppercase tracking-[0.2em] text-ink-400">
            karobakbak
          </span>
        </div>
        <h1
          className="animate-rise font-display font-semibold leading-[0.94] tracking-[-0.04em] text-ink-50"
          style={{
            margin: 'clamp(18px, 2.4cqw, 22px) 0 0',
            fontSize: 'clamp(56px, 8.6cqw, 88px)',
            animationDelay: '.06s',
          }}
        >
          {FAQ.title}
        </h1>
        <p
          className="animate-rise font-display italic leading-[1.45] text-ink-200"
          style={{
            margin: 'clamp(16px, 2cqw, 20px) 0 0',
            fontSize: 'clamp(19px, 2.3cqw, 23px)',
            maxWidth: '26em',
            animationDelay: '.12s',
          }}
        >
          {FAQ.summary}
        </p>
      </div>

      {/* ------------------------------------------------------------- groups */}
      {FAQ_GROUPS.map((group, groupIndex) => (
        <section
          key={group.label}
          style={{ marginTop: groupIndex === 0 ? 'clamp(44px, 5.5cqw, 64px)' : 'clamp(36px, 4.5cqw, 52px)' }}
        >
          <div
            className="flex items-center gap-3.5"
            style={{ marginBottom: 'clamp(18px, 2.2cqw, 24px)' }}
          >
            <span
              className={`font-mono text-[13px] uppercase tracking-[0.18em] ${
                group.accent ? 'text-amber-300' : 'text-ink-400'
              }`}
            >
              {group.label}
            </span>
            <span
              aria-hidden="true"
              className={`h-px flex-1 ${group.accent ? 'bg-ink-700' : 'bg-ink-800'}`}
            />
          </div>

          <div className="flex flex-col gap-2.5">
            {group.questions
              // Filtered before numbering, so a renamed heading cannot leave a
              // gap in the sequence on the chips. Dropped rather than thrown
              // on: a copy edit should not blank the page, and `faq.test.ts` is
              // what makes the mistake loud instead.
              .map((heading) => byHeading.get(heading))
              .filter((section): section is PageSection => section !== undefined)
              .map((section, indexInGroup) => {
                number += 1;
                return (
                  <QuestionRow
                    key={section.heading}
                    number={number}
                    section={section}
                    /*
                      The design gives exactly one row the amber left edge: the
                      first of the last group. It is the row somebody scanning
                      in a hurry should land on, so it is positional rather than
                      named — renaming the question keeps the accent.
                    */
                    priority={group.accent === true && indexInGroup === 0}
                  />
                );
              })}
          </div>
        </section>
      ))}
    </EditorialShell>
  );
}

interface QuestionRowProps {
  readonly number: number;
  readonly section: PageSection;
  readonly priority: boolean;
}

function QuestionRow({ number, section, priority }: QuestionRowProps): JSX.Element {
  const open = FAQ_OPEN_BY_DEFAULT.includes(section.heading);
  const verdictFirst = FAQ_VERDICT_FIRST.includes(section.heading);
  const [verdict, ...rest] = section.body;

  return (
    <details
      open={open}
      className={`group overflow-hidden rounded-4.5 border bg-ink-900 transition-colors ${
        priority ? 'border-ink-700 border-l-2 border-l-amber-400' : 'border-ink-800'
      }`}
    >
      {/*
        `list-none` on both the element and the WebKit pseudo-element: Safari
        draws the disclosure triangle from `::-webkit-details-marker` and
        ignores `list-style` on the summary itself, so a rule that looks
        complete on Chrome leaves a stray triangle beside every question.
      */}
      <summary
        className="flex min-h-[60px] cursor-pointer list-none items-center gap-3.5 px-[18px] py-4 [&::-webkit-details-marker]:hidden"
      >
        <span
          className={`flex-none rounded-[7px] border px-2 py-1 font-mono text-[13px] leading-none transition-colors ${
            open || priority
              ? 'border-ink-600 text-amber-300'
              : 'border-ink-700 text-ink-400 group-open:border-ink-600 group-open:text-amber-300'
          }`}
        >
          {String(number).padStart(2, '0')}
        </span>

        <span
          className="flex-1 font-display leading-[1.3] text-ink-100"
          style={{ fontSize: 'clamp(19px, 2.1cqw, 21px)' }}
        >
          {section.heading}
        </span>

        {/*
          A rotating chevron rather than a swapped glyph, so the state change is
          one continuous movement. `aria-hidden` because `<summary>` already
          announces expanded/collapsed — a second announcement would be noise.
        */}
        <span
          aria-hidden="true"
          className="flex-none font-mono text-[15px] text-ink-400 transition-transform duration-200 group-open:rotate-90 group-open:text-amber-300"
        >
          ›
        </span>
      </summary>

      <div className="animate-answer-in px-[18px] pb-5">
        {verdict !== undefined && (
          <p
            className={
              verdictFirst
                ? 'font-display leading-[1.3] text-ink-50'
                : 'text-[15px] leading-[1.8] text-ink-300'
            }
            style={verdictFirst ? { fontSize: 'clamp(21px, 2.3cqw, 23px)', margin: 0 } : { margin: 0 }}
          >
            {verdict}
          </p>
        )}

        {rest.map((paragraph) => (
          <p key={paragraph} className="mt-3 text-[15px] leading-[1.8] text-ink-300">
            {paragraph}
          </p>
        ))}

        {section.bullets !== undefined && (
          /*
            The three options are set as cards rather than list items, matching
            Rules and How it works — they are the same three controls, and a
            reader who has met them once should recognise them here.
          */
          <ul className="mt-4 grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            {section.bullets.map((item) => {
              const [action, ...tail] = item.split(' ');
              return (
                <li
                  key={item}
                  className="rounded-2xl border border-ink-800 bg-ink-950/40 px-3.5 py-3 text-[15px] leading-[1.6] text-ink-300"
                >
                  <span className="font-semibold text-ink-100">{action}</span> {tail.join(' ')}
                </li>
              );
            })}
          </ul>
        )}

        {section.tail?.map((paragraph) => (
          <p key={paragraph} className="mt-3 text-[15px] leading-[1.8] text-ink-300">
            {paragraph}
          </p>
        ))}
      </div>
    </details>
  );
}
