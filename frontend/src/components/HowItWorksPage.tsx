/**
 * "How it works", laid out as three steps rather than six paragraphs.
 *
 * ---------------------------------------------------------------------------
 * THE WORDS ARE STILL DATA
 * ---------------------------------------------------------------------------
 * Every sentence on this page comes from `content/how-it-works.ts`, which is
 * transcribed from the operator's draft and guarded by `content/pages.test.ts`.
 * This file contributes layout and nothing else: no sentence is written here,
 * and none should be. If a claim needs to change, it changes in the content and
 * both the page and the tests follow.
 *
 * The coupling that does exist is **positional** — this renderer knows that the
 * first paragraph of a step is its lead line and that "Three controls" holds
 * one sentence per control. `sectionsByHeading` throws on a missing heading
 * rather than rendering a gap, so a rename is a loud failure at first render
 * instead of a silently half-empty page.
 *
 * ---------------------------------------------------------------------------
 * THE CONTROL ICONS COME FROM THE BOARD'S SPEC, NOT ITS PIXELS
 * ---------------------------------------------------------------------------
 * `How It Works Board.dc.html` renders the page and then states, in prose:
 * "Icons map to lucide SkipForward, Ban, Flag."
 *
 * The page artboard draws mono glyphs (`»`, `⊘`, `⚑`) because a design canvas
 * cannot import an icon set — the glyphs are a stand-in for the real marks, and
 * the spec line is there to say so. Following the pixels rather than the spec
 * gives a guillemet where the product shows a skip arrow.
 *
 * They are `aria-hidden`, because each sits beside its own name in text.
 */
import { Ban, Flag, SkipForward } from 'lucide-react';
import type { ReactNode } from 'react';

import type { PageSection, StaticPage } from '../content/pages';
import { pageById } from '../content/pages';
import { RouteLink } from '../router';
import { EditorialShell } from './EditorialShell';
import { StartChattingLink } from './StartChattingLink';

/**
 * Index a page's sections by heading, and refuse to be indexed by a heading
 * that is not there.
 *
 * Heading rather than position because `pages.test.ts` already guarantees
 * headings are unique within a page (they are React keys), and because a
 * reordered content file should move a block on the page rather than silently
 * pour step 03's prose into step 01's layout.
 */
function sectionReader(page: StaticPage): (heading: string) => PageSection {
  const byHeading = new Map(page.sections.map((s) => [s.heading, s]));
  return (heading) => {
    const found = byHeading.get(heading);
    if (found === undefined) {
      throw new Error(`how-it-works: no section "${heading}"`);
    }
    return found;
  };
}

/** One paragraph of a section, by position, or `''` if the content is shorter. */
function para(section: PageSection, index: number): string {
  return section.body[index] ?? '';
}

/*
 * The three documents step 01 tells people they are agreeing to.
 *
 * They are links on the page and plain text in the content, because the content
 * is also read by tests and could one day be read by something else — a string
 * with markup in it stops being a sentence. Longest phrase first: "Privacy
 * Policy" has to win against "Privacy" or the match splits in the wrong place.
 */
const POLICY_LINKS: ReadonlyArray<readonly [phrase: string, to: string]> = [
  ['Privacy Policy', '/privacy'],
  ['Terms', '/terms'],
  ['Rules', '/rules'],
];

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Turn the named document titles inside a sentence into real routed links.
 *
 * Deliberately not a general markdown pass. It replaces exactly three known
 * phrases, so a sentence that happens to contain the word "rules" in another
 * sense is unaffected — the match is case-sensitive and the phrases are
 * capitalised document titles.
 */
function withPolicyLinks(text: string): ReactNode {
  const pattern = new RegExp(
    `(${POLICY_LINKS.map(([phrase]) => escapeForRegExp(phrase)).join('|')})`,
    'g',
  );
  return text.split(pattern).map((piece, index) => {
    const match = POLICY_LINKS.find(([phrase]) => phrase === piece);
    if (match === undefined) return piece;
    return (
      <RouteLink
        // Index is a safe key here: the array is derived from one immutable
        // string and is rebuilt wholesale whenever that string changes.
        key={`${piece}-${index}`}
        to={match[1]}
        className="border-b border-amber-300/35 text-amber-300 transition-colors hover:border-amber-400 hover:text-amber-400"
      >
        {piece}
      </RouteLink>
    );
  });
}

const LEAD_CLASS = 'mt-[18px] leading-[1.55] text-ink-200';
const LEAD_STYLE = { fontSize: 'clamp(19px, 2.2cqw, 21px)', maxWidth: '28em' };
const BODY_CLASS = 'mt-[18px] text-[17px] leading-[1.85] text-ink-300';
const BODY_STYLE = { maxWidth: '33em' };
const H2_CLASS =
  'font-display font-semibold leading-[1.08] tracking-[-0.02em] text-ink-100';
const H2_STYLE = { fontSize: 'clamp(30px, 3.5cqw, 34px)' };
const SECTION_H2_STYLE = { fontSize: 'clamp(24px, 3.2cqw, 30px)' };

/** The optional fields, as the chips the design puts under step 01. */
const DECLARED_FIELDS = ['name', 'age', 'gender', 'country'] as const;

/**
 * Two dots approach, hold a dashed thread, drift apart. Six seconds, forever.
 *
 * Ambient and `aria-hidden`: it restates "you and whoever is next", which the
 * prose beside it already says in words. The global reduced-motion rule stops
 * it dead, leaving the two dots and the label, which still reads.
 */
function MatchLoop(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="relative mt-6 h-[132px] overflow-hidden rounded-4.5 border border-ink-800 bg-ink-900"
    >
      <span
        className="absolute left-1/2 top-1/2 -ml-[46px] block h-px w-[92px] animate-thread origin-center"
        style={{
          background:
            'repeating-linear-gradient(90deg, #6b5f4d 0 5px, transparent 5px 10px)',
        }}
      />
      <span className="absolute left-1/2 top-1/2 -ml-2 -mt-2 block h-4 w-4 animate-approach-l rounded-full bg-amber-400" />
      <span className="absolute left-1/2 top-1/2 -ml-2 -mt-2 block h-4 w-4 animate-approach-r rounded-full bg-sage-400" />
      <span className="absolute bottom-3.5 left-[18px] font-mono text-[13px] uppercase tracking-[0.16em] text-ink-400">
        you · whoever is next
      </span>
    </div>
  );
}

interface StepProps {
  readonly number: string;
  readonly section: PageSection;
  /** Anything the step shows below its prose. */
  readonly children?: ReactNode;
  /** The last step's rail fades out rather than stopping at a hard edge. */
  readonly last?: boolean;
}

function Step({ number, section, children, last = false }: StepProps): JSX.Element {
  /*
   * The heading in the content is "01 — Start", because a reader of the raw
   * content should see the ordering too. On the page the number is the rail, so
   * carrying it in the heading as well would print it twice.
   */
  const title = section.heading.replace(/^\d+\s*—\s*/, '');

  return (
    <div
      className="flex animate-pop-in"
      style={{ gap: 'clamp(18px, 2.6cqw, 30px)' }}
    >
      <div
        className="flex flex-none flex-col items-center"
        style={{ width: 'clamp(38px, 5cqw, 54px)' }}
      >
        <span
          className="font-mono font-medium leading-none text-amber-300"
          style={{ fontSize: 'clamp(22px, 2.6cqw, 28px)' }}
        >
          {number}
        </span>
        <span
          className="mt-3 w-px flex-1"
          style={{
            background: last
              ? 'linear-gradient(#2a241c, rgba(42,36,28,0))'
              : '#2a241c',
          }}
        />
      </div>

      <section style={{ paddingBottom: 'clamp(48px, 5.5cqw, 66px)' }}>
        <h2 className={H2_CLASS} style={H2_STYLE}>
          {title}
        </h2>
        <p className={LEAD_CLASS} style={LEAD_STYLE}>
          {para(section, 0)}
        </p>
        <p className={BODY_CLASS} style={BODY_STYLE}>
          {withPolicyLinks(para(section, 1))}
        </p>
        <p className={BODY_CLASS} style={BODY_STYLE}>
          {para(section, 2)}
        </p>
        {children}
      </section>
    </div>
  );
}

/** One of Skip, Block, Report. */
function ControlCard({
  icon: Icon,
  sentence,
}: {
  readonly icon: typeof SkipForward;
  /** "Skip ends the conversation and …" — the first word is the control. */
  readonly sentence: string;
}): JSX.Element {
  const [name, ...rest] = sentence.split(' ');
  return (
    <div className="animate-pop-in rounded-4.5 border border-ink-800 bg-ink-900 p-[22px] transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-ink-700 hover:shadow-lift">
      <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] bg-ink-800 text-amber-300">
        <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} aria-hidden="true" />
      </div>
      <div className="mt-3.5 text-[17px] font-semibold text-ink-100">{name}</div>
      <p className="mt-2 text-[15px] leading-[1.65] text-ink-300">
        {rest.join(' ')}
      </p>
    </div>
  );
}

export function HowItWorksPage(): JSX.Element {
  const page = pageById('how-it-works');
  const section = sectionReader(page);

  const start = section('01 — Start');
  const matched = section('02 — Get matched');
  const talk = section('03 — Talk');
  const controls = section('Three controls, always there');
  const anonymity = section('What about anonymity?');
  const cost = section('What it costs');

  return (
    <EditorialShell title={page.title}>
      {/* ---------------------------------------------------------------- hero */}
      <div>
        <div className="flex animate-rise items-center gap-2.5">
          <span className="block h-[7px] w-[7px] animate-float-slow rounded-full bg-amber-400" />
          <span className="font-mono text-[13px] uppercase tracking-[0.2em] text-ink-400">
            three steps
          </span>
        </div>
        <h1
          className="flex flex-wrap font-display font-semibold leading-[0.92] tracking-[-0.04em] text-ink-50"
          style={{
            margin: 'clamp(18px, 2.4cqw, 22px) 0 0',
            fontSize: 'clamp(54px, 8.4cqw, 84px)',
            gap: '0 0.26em',
            maxWidth: '11em',
          }}
        >
          {/*
            Word by word rather than as one string, so each lands a beat after
            the last. Purely an entrance — it plays once and the words are
            ordinary text in the DOM, so it reads correctly to a screen reader
            and to a crawler.
          */}
          <span className="inline-block animate-rise" style={{ animationDelay: '.06s' }}>
            How
          </span>
          <span className="inline-block animate-rise" style={{ animationDelay: '.14s' }}>
            it
          </span>
          <span
            className="inline-block animate-rise text-amber-300"
            style={{ animationDelay: '.22s' }}
          >
            works
          </span>
        </h1>
        <div
          className="h-px w-full origin-left animate-draw"
          style={{
            background: 'linear-gradient(90deg, #ffb420 0 44px, #2a241c 44px)',
            margin: 'clamp(28px, 3.4cqw, 36px) 0',
            animationDelay: '.4s',
          }}
        />
        <p
          className="animate-rise font-display italic leading-[1.45] text-ink-200"
          style={{
            fontSize: 'clamp(21px, 2.5cqw, 25px)',
            maxWidth: '22em',
            animationDelay: '.3s',
          }}
        >
          {page.summary}
        </p>
      </div>

      {/* --------------------------------------------------------------- steps */}
      <div
        className="flex flex-col"
        style={{ padding: 'clamp(52px, 6cqw, 76px) 0 0' }}
      >
        <Step number="01" section={start}>
          <div className="mt-5 flex flex-wrap gap-2">
            {DECLARED_FIELDS.map((field) => (
              <span
                key={field}
                className="rounded-full border border-dashed border-ink-700 bg-ink-900 px-[13px] py-[7px] font-mono text-[13px] uppercase tracking-[0.08em] text-ink-300"
              >
                {field}
              </span>
            ))}
            <span className="px-1 py-[7px] font-mono text-[13px] uppercase tracking-[0.08em] text-ink-400">
              all optional
            </span>
          </div>
        </Step>

        <Step number="02" section={matched}>
          <MatchLoop />
        </Step>

        <Step number="03" section={talk} last />
      </div>

      {/* ------------------------------------------------------- the controls */}
      <section
        className="border-t border-ink-800"
        style={{ paddingTop: 'clamp(32px, 4cqw, 44px)' }}
      >
        <h2
          className="font-display font-semibold leading-[1.2] tracking-[-0.02em] text-ink-100"
          style={SECTION_H2_STYLE}
        >
          {controls.heading}
        </h2>
        <div
          className="mt-[26px] grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}
        >
          <ControlCard icon={SkipForward} sentence={para(controls, 0)} />
          <ControlCard icon={Ban} sentence={para(controls, 1)} />
          <ControlCard icon={Flag} sentence={para(controls, 2)} />
        </div>
        <p
          className="mt-6 text-[17px] leading-[1.85] text-ink-300"
          style={{ maxWidth: '34em' }}
        >
          {para(controls, 3)}
        </p>
      </section>

      {/* ------------------------------------------------------- anonymity */}
      <section
        className="border-t border-ink-800"
        style={{
          marginTop: 'clamp(52px, 6cqw, 72px)',
          paddingTop: 'clamp(32px, 4cqw, 44px)',
        }}
      >
        <h2
          className="font-display font-semibold leading-[1.2] tracking-[-0.02em] text-ink-100"
          style={SECTION_H2_STYLE}
        >
          {anonymity.heading}
        </h2>
        <p
          className="mt-[22px] text-[17px] leading-[1.85] text-ink-300"
          style={{ maxWidth: '34em' }}
        >
          {para(anonymity, 0)}
        </p>
        {/*
          The warning is the one paragraph on this page somebody must not skim,
          so it is the one paragraph given a border and a background. Every
          other reassurance on the page is plain.
        */}
        <div
          className="rounded-4.5 border border-ink-700 border-l-2 border-l-amber-400 bg-ink-900"
          style={{
            margin: 'clamp(24px, 3cqw, 30px) 0',
            padding: 'clamp(20px, 2.6cqw, 26px)',
          }}
        >
          <p className="text-base leading-[1.75] text-ink-200">
            {para(anonymity, 1)}
          </p>
        </div>
        <p
          className="text-[17px] leading-[1.85] text-ink-300"
          style={{ maxWidth: '34em' }}
        >
          {withPolicyLinks(para(anonymity, 2))}
        </p>
      </section>

      {/* ------------------------------------------------------------ cost */}
      <section
        className="border-t border-ink-800"
        style={{
          marginTop: 'clamp(52px, 6cqw, 72px)',
          paddingTop: 'clamp(32px, 4cqw, 44px)',
          paddingBottom: 'clamp(60px, 7cqw, 96px)',
        }}
      >
        <h2
          className="font-display font-semibold leading-[1.2] tracking-[-0.02em] text-ink-100"
          style={SECTION_H2_STYLE}
        >
          {cost.heading}
        </h2>
        <div className="mt-5 flex items-baseline gap-4">
          <p
            className="animate-shimmer-slow bg-clip-text font-display leading-none tracking-[-0.035em] text-transparent"
            style={{
              fontSize: 'clamp(52px, 6.8cqw, 70px)',
              backgroundImage:
                'linear-gradient(100deg, #f7f5f3 34%, #ffc94a 50%, #f7f5f3 66%)',
              backgroundSize: '200% 100%',
            }}
          >
            {para(cost, 0)}
          </p>
          <span className="rounded-full border border-sage-400/35 px-[11px] py-1.5 font-mono text-[13px] uppercase tracking-[0.12em] text-sage-400">
            free
          </span>
        </div>
        <p
          className="mt-[22px] text-[17px] leading-[1.85] text-ink-300"
          style={{ maxWidth: '34em' }}
        >
          {para(cost, 1)}
        </p>
        <div
          className="flex flex-wrap gap-3"
          style={{ marginTop: 'clamp(28px, 3cqw, 34px)' }}
        >
          <StartChattingLink
            className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full bg-amber-400 px-6 py-[15px] text-[17px] font-semibold text-ink-950 transition-[transform,background,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-amber-300 hover:shadow-glow"
          />
          <RouteLink
            to="/rules"
            className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full border border-ink-700 px-6 py-[15px] text-[17px] font-medium text-ink-200 transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:text-ink-100"
          >
            Read the rules
          </RouteLink>
        </div>
      </section>
    </EditorialShell>
  );
}
