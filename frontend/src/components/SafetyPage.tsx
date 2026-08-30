/**
 * Safety, from `SafetyPage.dc.html`.
 *
 * ---------------------------------------------------------------------------
 * TWO GLYPHS, ONE DISTINCTION
 * ---------------------------------------------------------------------------
 * An amber `!` marks something to watch for **in somebody else** — the warning
 * signs. An ink `×` marks something not to do, or something we cannot do — the
 * don't-share list and the limits. Same tile, two meanings, no new colour.
 *
 * The distinction is the reason they are not the same mark: a reader scanning
 * this page mid-incident should be able to tell "this is about them" from "this
 * is about you" without reading the heading above it.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROLS COME BEFORE THE ADVICE
 * ---------------------------------------------------------------------------
 * Skip, Block and Report sit directly under the hero, above every paragraph of
 * guidance. Somebody who opens this page in the middle of a conversation that
 * has gone wrong needs the three controls, not an essay — and the essay is
 * still there for the person reading it beforehand.
 *
 * ---------------------------------------------------------------------------
 * STILLNESS WHERE IT COUNTS
 * ---------------------------------------------------------------------------
 * Sections 05 and 06 — a child, and immediate danger — carry no entrance
 * animation and no hover state. Everything above them does. A page element that
 * slides in and lifts under the cursor reads as something to play with, and
 * these two are the ones somebody reaches on the worst day they will have here.
 *
 * "karobakbak is not an emergency or crisis service" is deliberately **not** in
 * a panel. Boxing it would make it decoration; set bare, at display size, it
 * reads as the page speaking plainly.
 */
import { EditorialShell } from './EditorialShell';
import { pageById, type PageSection } from '../content/pages';

/** Headings that get the still treatment: no entrance, no hover. */
const STILL = new Set(['If somebody appears to be a child', 'If you are in immediate danger']);

/** The section whose bullets are warning signs about somebody else. */
const WARNING_SIGNS = 'Watch for common warning signs';

/** The section whose bullets are the three controls. */
const CONTROLS = 'Three controls, always available';

export function SafetyPage(): JSX.Element {
  const page = pageById('safety');
  if (page === undefined) throw new Error('safety: page missing');

  return (
    <EditorialShell title={page.title}>
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
          {page.title}
        </h1>
        <p
          className="animate-rise font-display italic leading-[1.45] text-ink-200"
          style={{
            margin: 'clamp(16px, 2cqw, 20px) 0 0',
            fontSize: 'clamp(19px, 2.3cqw, 23px)',
            maxWidth: '28em',
            animationDelay: '.12s',
          }}
        >
          {page.summary}
        </p>
        {page.intro !== undefined && (
          <p
            className="animate-rise text-[17px] leading-[1.85] text-ink-300"
            style={{ margin: 'clamp(14px, 1.8cqw, 18px) 0 0', maxWidth: '34em', animationDelay: '.18s' }}
          >
            {page.intro}
          </p>
        )}
      </div>

      {page.sections.map((section, index) => (
        <Section key={section.heading} section={section} number={index + 1} />
      ))}
    </EditorialShell>
  );
}

function Section({ section, number }: { section: PageSection; number: number }): JSX.Element {
  const still = STILL.has(section.heading);
  const controls = section.heading === CONTROLS;
  const warning = section.heading === WARNING_SIGNS;
  const label = String(number).padStart(2, '0');

  return (
    <section style={{ marginTop: 'clamp(48px, 6cqw, 76px)' }}>
      <div className="flex items-baseline gap-3.5">
        <span className="font-mono text-[13px] text-ink-500">{label}</span>
        <h2
          className="font-display font-semibold leading-[1.2] tracking-[-0.02em] text-ink-100"
          style={{ fontSize: 'clamp(24px, 3.2cqw, 30px)' }}
        >
          {section.heading}
        </h2>
      </div>

      <div className="mt-[22px]">
        {section.body.map((paragraph, i) => {
          const last = i === section.body.length - 1;

          /*
           * The bare display line. It is the first sentence of "immediate
           * danger" and the only one on the page set this large without a
           * panel — a box would make it decoration, and this is the page
           * speaking.
           */
          if (section.heading === 'If you are in immediate danger' && i === 0) {
            return (
              <p
                key={paragraph}
                className="font-display font-semibold leading-[1.25] tracking-[-0.02em] text-ink-50"
                style={{ fontSize: 'clamp(23px, 2.9cqw, 30px)', maxWidth: '20em', margin: '0 0 18px' }}
              >
                {paragraph}
              </p>
            );
          }

          /*
           * The child-safety instruction: the middle callout of the three, and
           * the only one with a serif lead. Drawn from the copy rather than
           * written here — an earlier pass hard-coded the sentence and it then
           * appeared twice, once as prose and once in the panel.
           */
          if (section.heading === 'If somebody appears to be a child' && last) {
            const [lead, ...rest] = paragraph.split(/(?<=\.)\s+/);
            return (
              <div
                key={paragraph}
                className="mt-5 rounded-4.5 border border-ink-800 border-l-2 border-l-amber-400 bg-ink-900 px-5 py-4"
                style={{ maxWidth: '36em' }}
              >
                <p
                  className="font-display leading-[1.4] text-ink-50"
                  style={{ fontSize: 'clamp(18px, 2.1cqw, 21px)', margin: 0 }}
                >
                  {lead}
                </p>
                {rest.length > 0 && (
                  <p className="mt-2 text-[15px] leading-[1.75] text-ink-300">{rest.join(' ')}</p>
                )}
              </div>
            );
          }

          /*
           * The closing charge — the last of the three escalating callouts, and
           * the heaviest thing on the page. It is bold in the draft and it is
           * the sentence the whole page exists to leave somebody with.
           */
          if (section.heading.startsWith('What we do') && last) {
            return (
              <p
                key={paragraph}
                className="mt-6 rounded-4.5 border border-ink-700 border-l-2 border-l-amber-400 bg-ink-900 px-5 py-5 font-display font-semibold leading-[1.35] tracking-[-0.01em] text-ink-50"
                style={{ fontSize: 'clamp(20px, 2.5cqw, 25px)', maxWidth: '30em' }}
              >
                {paragraph}
              </p>
            );
          }

          return (
            <p
              key={paragraph}
              className="text-[17px] leading-[1.85] text-ink-300"
              style={{ maxWidth: '34em', margin: i === 0 ? 0 : '14px 0 0' }}
            >
              {paragraph}
            </p>
          );
        })}

        {section.bullets !== undefined &&
          (controls ? (
            <ul
              className="mt-5 grid gap-2.5"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}
            >
              {section.bullets.map((item, i) => {
                const [action, ...rest] = item.split(' ');
                return (
                  <li
                    key={item}
                    className="animate-pop-in rounded-4.5 border border-ink-800 bg-ink-900 px-4 py-3.5 transition-[transform,border-color] duration-200 hover:-translate-y-[2px] hover:border-ink-700"
                    style={{ animationDelay: `${0.06 * i + 0.1}s` }}
                  >
                    <span className="font-display text-[19px] font-semibold text-ink-50">{action}</span>
                    <span className="mt-1 block text-[15px] leading-[1.65] text-ink-300">
                      {rest.join(' ')}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <ul
              className="mt-5 grid gap-2"
              style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}
            >
              {section.bullets.map((item) => (
                <li
                  key={item}
                  className={`flex items-start gap-3 rounded-2xl border border-ink-800 bg-ink-900/60 px-3.5 py-3 ${
                    still ? '' : 'transition-colors duration-200 hover:border-ink-700'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`mt-[3px] flex h-[18px] w-[18px] flex-none items-center justify-center rounded-md font-mono text-[12px] leading-none ${
                      warning
                        ? 'bg-amber-400/15 text-amber-300'
                        : 'bg-ink-800 text-ink-400'
                    }`}
                  >
                    {warning ? '!' : '×'}
                  </span>
                  <span className="text-[15px] leading-[1.6] text-ink-300">{item}</span>
                </li>
              ))}
            </ul>
          ))}

        {section.tail?.map((paragraph, i) => {
          /*
           * The aggregation warning — small details becoming identifying when
           * put together — is the first of the three escalating callouts, and
           * the lightest. It is the least obvious sentence on the page and the
           * one people most often learn the hard way.
           */
          const aggregation = paragraph.startsWith('Be careful with details');
          if (aggregation) {
            return (
              <p
                key={paragraph}
                className="mt-5 rounded-4.5 border border-ink-800 border-l-2 border-l-amber-400 bg-ink-900 px-5 py-4 text-[16px] leading-[1.75] text-ink-200"
                style={{ maxWidth: '36em' }}
              >
                {paragraph}
              </p>
            );
          }
          return (
            <p
              key={paragraph}
              className="text-[17px] leading-[1.85] text-ink-300"
              style={{ maxWidth: '34em', margin: i === 0 ? '18px 0 0' : '14px 0 0' }}
            >
              {paragraph}
            </p>
          );
        })}
      </div>
    </section>
  );
}
