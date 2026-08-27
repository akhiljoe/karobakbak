/**
 * The Rules — fourteen numbered sections in three groups.
 *
 * ---------------------------------------------------------------------------
 * THE WORDS ARE DATA, AND THIS PAGE IS WHY THAT MATTERS MOST
 * ---------------------------------------------------------------------------
 * Every sentence comes from the `rules` entry in `content/pages.ts`, which is
 * transcribed from `docs/rewrite-wording/rules.md` and checked against it by
 * `content/pages.test.ts`. Of all the copy in this product this is the text
 * least safe to paraphrase: it states what is prohibited and what enforcement
 * may follow, and a page that quietly softens a prohibition is a page that
 * misleads somebody about what will happen to them.
 *
 * ---------------------------------------------------------------------------
 * SECTION 01 IS SET APART ON PURPOSE
 * ---------------------------------------------------------------------------
 * The design gives it a card with an amber edge and a filled amber number,
 * where every other section gets an outlined one. That is not decoration —
 * it is the only rule the draft describes as having no second chance, and the
 * page says so in the label above the heading before the reader has parsed a
 * word of the body.
 *
 * ---------------------------------------------------------------------------
 * THE APPEALS ADDRESS IS CONFIGURATION
 * ---------------------------------------------------------------------------
 * The draft writes `[CONTACT EMAIL]` and the artboard fills it with
 * `hello@example.invalid` — a reserved TLD that cannot resolve. Neither ships.
 * `VITE_CONTACT_EMAIL` supplies the real address, and when it is unset this
 * page links to Contact instead of rendering a `mailto:` to nothing. An address
 * that bounces is worse than no address, because §14 is a promise of review.
 */
import { Ban, Flag, SkipForward } from 'lucide-react';
import type { ReactNode } from 'react';

import { clientConfig } from '../config';
import type { PageSection } from '../content/pages';
import { pageById } from '../content/pages';
import { RouteLink } from '../router';
import { EditorialShell } from './EditorialShell';
import { StartChattingLink } from './StartChattingLink';

const BODY_CLASS = 'text-[17px] leading-[1.85] text-ink-300';
const BODY_STYLE = { maxWidth: '34em' };

/**
 * The three groups the fourteen sections fall into.
 *
 * Held as counts rather than as a field on each section, because the grouping
 * is a property of the page's layout and not of the content — the draft is a
 * flat numbered list, and giving every section a `group` string in the content
 * would be this file's opinion stored in the content layer.
 *
 * A mismatch between these counts and the section list is caught below rather
 * than silently dropping the tail of the page.
 */
const GROUPS: ReadonlyArray<{ readonly label: string; readonly count: number }> = [
  { label: 'no second chance', count: 1 },
  { label: 'what is prohibited', count: 7 },
  { label: 'enforcement', count: 6 },
];

/** `1` → `01`. The design numbers every section to two digits. */
function ordinal(index: number): string {
  return String(index + 1).padStart(2, '0');
}

/** The rule that separates one group of sections from the next. */
function GroupRule({ label }: { readonly label: string }): JSX.Element {
  return (
    <div className="flex items-center gap-3.5">
      <span className="font-mono text-[13px] uppercase tracking-[0.18em] text-ink-400">
        {label}
      </span>
      <span aria-hidden="true" className="block h-px flex-1 bg-ink-800" />
    </div>
  );
}

/** One prohibition, as the design's bordered tile. */
function ProhibitionTile({ text }: { readonly text: string }): JSX.Element {
  return (
    <li className="flex items-start gap-3 rounded-[14px] border border-ink-800 bg-ink-900 px-4 py-3.5 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-ink-700">
      <span
        aria-hidden="true"
        className="flex-none font-mono text-[15px] leading-[1.5] text-ink-400"
      >
        ×
      </span>
      <span className="text-base leading-[1.5] text-ink-200">{text}</span>
    </li>
  );
}

const CONTROL_ICONS = [SkipForward, Ban, Flag] as const;

/**
 * Section 09's three controls, which the design sets as cards rather than as
 * the tiles every other list on this page uses — they are the things you *may*
 * do, in a page otherwise made of things you may not.
 *
 * Each draft line reads "Skip — leave the conversation and move on.", so the
 * name is what precedes the em dash. Split rather than stored twice, because
 * the sentence has to stay matchable against the draft.
 */
function ControlCards({ items }: { readonly items: readonly string[] }): JSX.Element {
  return (
    <div
      className="mt-[18px] grid gap-3"
      style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}
    >
      {items.map((sentence, position) => {
        const [name, ...rest] = sentence.split(' — ');
        const Icon = CONTROL_ICONS[position] ?? Flag;
        return (
          <div
            key={sentence}
            className="rounded-4.5 border border-ink-800 bg-ink-900 p-[22px] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-ink-700 hover:shadow-lift"
          >
            <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] bg-ink-800 text-amber-300">
              <Icon
                className="h-[18px] w-[18px]"
                strokeWidth={1.8}
                aria-hidden="true"
              />
            </div>
            <div className="mt-3.5 text-[17px] font-semibold text-ink-100">
              {name}
            </div>
            <p className="mt-2 text-[15px] leading-[1.65] text-ink-300">
              {rest.join(' — ')}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** Every section except the first, which gets its own treatment below. */
function Rule({
  index,
  section,
  children,
}: {
  readonly index: number;
  readonly section: PageSection;
  /** Rendered after the tail, where a section needs more than prose. */
  readonly children?: ReactNode;
}): JSX.Element {
  const controls = section.heading === 'Use the controls when you need them';

  return (
    <section>
      <div
        className="flex items-center gap-3.5"
        style={{ marginBottom: 'clamp(20px, 2.4cqw, 26px)' }}
      >
        <span className="flex-none rounded-lg border border-ink-700 px-[9px] py-[5px] font-mono text-[13px] leading-none text-amber-300">
          {ordinal(index)}
        </span>
        <h2
          className="font-display font-semibold leading-[1.15] tracking-[-0.025em] text-ink-100"
          style={{ fontSize: 'clamp(28px, 3.2cqw, 32px)' }}
        >
          {section.heading}
        </h2>
      </div>

      {section.body.map((paragraph, position) => (
        <p
          key={paragraph}
          className={position === 0 ? BODY_CLASS : `mt-[18px] ${BODY_CLASS}`}
          style={BODY_STYLE}
        >
          {paragraph}
        </p>
      ))}

      {section.bullets !== undefined &&
        (controls ? (
          <ControlCards items={section.bullets} />
        ) : (
          <ul className="mt-[18px] flex list-none flex-col gap-2.5">
            {section.bullets.map((item) => (
              <ProhibitionTile key={item} text={item} />
            ))}
          </ul>
        ))}

      {section.tail?.map((paragraph) => (
        <p key={paragraph} className={`mt-[18px] ${BODY_CLASS}`} style={BODY_STYLE}>
          {paragraph}
        </p>
      ))}

      {children}
    </section>
  );
}

export function RulesPage(): JSX.Element {
  const page = pageById('rules');
  const email = clientConfig.contactEmail;

  const total = GROUPS.reduce((sum, group) => sum + group.count, 0);
  if (total !== page.sections.length) {
    throw new Error(
      `rules: ${GROUPS.length} groups cover ${total} sections, content has ${page.sections.length}`,
    );
  }

  const [first, ...rest] = page.sections;
  if (first === undefined) throw new Error('rules: no sections');

  /* Where each group after the first begins, so the rules can be interleaved. */
  const laterGroups = GROUPS.slice(1);
  let cursor = 0;

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
            margin: 'clamp(22px, 2.8cqw, 28px) 0 0',
            fontSize: 'clamp(21px, 2.5cqw, 25px)',
            maxWidth: '22em',
            animationDelay: '.18s',
          }}
        >
          {page.summary}
        </p>
        <div
          className="h-px w-full origin-left animate-draw"
          style={{
            background: 'linear-gradient(90deg, #ffb420 0 44px, #2a241c 44px)',
            marginTop: 'clamp(30px, 4cqw, 40px)',
            animationDelay: '.34s',
          }}
        />
        {page.intro !== undefined && (
          <p
            className="animate-rise leading-[1.65] text-ink-100"
            style={{
              margin: 'clamp(28px, 3.2cqw, 34px) 0 0',
              fontSize: 'clamp(19px, 2.1cqw, 20px)',
              maxWidth: '32em',
              animationDelay: '.26s',
            }}
          >
            {page.intro}
          </p>
        )}
      </div>

      {/* --------------------------------------------- 01, the one apart */}
      <section
        className="animate-pop-in rounded-4.5 border border-ink-700 border-l-2 border-l-amber-400 bg-ink-900"
        style={{
          marginTop: 'clamp(40px, 4.5cqw, 56px)',
          padding: 'clamp(24px, 2.8cqw, 32px)',
          animationDelay: '.4s',
        }}
      >
        <div className="flex items-center gap-3">
          {/* Filled, where every other number is outlined. */}
          <span className="flex-none rounded-lg bg-amber-400 px-2.5 py-1.5 font-mono text-sm font-medium leading-none text-ink-950">
            {ordinal(0)}
          </span>
          <span className="font-mono text-[13px] uppercase tracking-[0.16em] text-amber-300">
            {GROUPS[0]?.label}
          </span>
        </div>
        <h2
          className="mt-[18px] font-display font-semibold leading-[1.12] tracking-[-0.025em] text-ink-50"
          style={{ fontSize: 'clamp(28px, 3.4cqw, 34px)', maxWidth: '20em' }}
        >
          {first.heading}
        </h2>
        <p
          className="mt-5 leading-[1.6] text-ink-100"
          style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)', maxWidth: '30em' }}
        >
          {first.body[0]}
        </p>
        {first.body.slice(1, -1).map((paragraph) => (
          <p key={paragraph} className={`mt-[18px] ${BODY_CLASS}`} style={BODY_STYLE}>
            {paragraph}
          </p>
        ))}
        {/*
          The last line of §01 — "There is no warning for this category." — is
          set as the section's closing statement rather than as another
          paragraph, because it is the sentence the whole card exists to deliver.
        */}
        <div
          className="flex items-center gap-3.5"
          style={{ marginTop: 'clamp(24px, 2.8cqw, 30px)' }}
        >
          <span aria-hidden="true" className="block h-px w-[26px] flex-none bg-amber-400" />
          <p
            className="font-display leading-[1.35] text-ink-100"
            style={{ fontSize: 'clamp(20px, 2.2cqw, 22px)' }}
          >
            {first.body[first.body.length - 1]}
          </p>
        </div>
      </section>

      {/* ------------------------------------------------- 02 onwards */}
      <div
        className="flex flex-col"
        style={{
          gap: 'clamp(60px, 6cqw, 74px)',
          padding: 'clamp(60px, 6.5cqw, 84px) 0 clamp(64px, 7cqw, 96px)',
        }}
      >
        {laterGroups.map((group) => {
          const from = 1 + cursor;
          cursor += group.count;
          const sections = rest.slice(from - 1, from - 1 + group.count);
          return (
            <div key={group.label} className="flex flex-col" style={{ gap: 'clamp(60px, 6cqw, 74px)' }}>
              <GroupRule label={group.label} />
              {sections.map((section, position) => (
                <Rule
                  key={section.heading}
                  index={from + position}
                  section={section}
                />
              ))}
            </div>
          );
        })}

        {/*
          §14 promises a review, so it has to say how to ask for one. The draft's
          placeholder is replaced by the configured address, or — when there is
          none — by the Contact page, which explains what can be reached and how.
        */}
        <p className={BODY_CLASS} style={BODY_STYLE}>
          {email === '' ? (
            <>
              To request a review, see{' '}
              <RouteLink
                to="/contact"
                className="border-b border-amber-300/35 text-amber-300 transition-colors hover:border-amber-400 hover:text-amber-400"
              >
                Contact
              </RouteLink>
              .
            </>
          ) : (
            <>
              To request a review, email{' '}
              <a
                href={`mailto:${email}`}
                className="border-b border-amber-300/35 font-mono text-amber-300 transition-colors hover:border-amber-400 hover:text-amber-400"
              >
                {email}
              </a>
              .
            </>
          )}
        </p>

        <div className="flex flex-wrap gap-3">
          <StartChattingLink
            className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full bg-amber-400 px-6 py-[15px] text-[17px] font-semibold text-ink-950 transition-[transform,background,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-amber-300 hover:shadow-glow"
          />
          <RouteLink
            to="/contact"
            className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full border border-ink-700 px-6 py-[15px] text-[17px] font-medium text-ink-200 transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:text-ink-100"
          >
            Contact us
          </RouteLink>
        </div>
      </div>
    </EditorialShell>
  );
}
