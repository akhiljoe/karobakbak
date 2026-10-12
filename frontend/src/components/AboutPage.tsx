/**
 * "About" — the page that makes the argument, rather than answering a question.
 *
 * ---------------------------------------------------------------------------
 * THE WORDS ARE STILL DATA
 * ---------------------------------------------------------------------------
 * Same rule as `HowItWorksPage`: every sentence comes from the `about` entry in
 * `content/pages.ts`, and none is written here. That file is where the factual
 * claims are checked — `pages.test.ts` asserts this page says the age check is
 * *not* verified and that some partners are *automated*, and both guards read
 * the content rather than the component. Copy typed into this file would render
 * fine and be checked by nothing.
 *
 * The coupling is positional: the design gives some paragraphs a card, some a
 * pull quote and some a list, so this renderer knows which index is which. Two
 * sections were re-split in the content to suit it — "Why it exists" and "What
 * it is not" each hold their negations one per entry now, because the design
 * sets them as separate lines and the alternative was re-typing the words here.
 *
 * ---------------------------------------------------------------------------
 * SECTION 05 IS THE DISCLOSURE, NOT A DENIAL
 * ---------------------------------------------------------------------------
 * The design mock for this page carried a section headed "No pretending" that
 * read "karobakbak does not use bots to pretend to be people". That is false —
 * personas ship (`docs/AI-PERSONAS.md`), the Privacy Policy and Terms 3a
 * disclose them, and `pages.test.ts` fails an About page that does not contain
 * the word "automated". The section keeps the mock's treatment (a live sage dot
 * beside the prose) and the content's honest text.
 */
import { X } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';

import type { PageSection, StaticPage } from '../content/pages';
import { pageById } from '../content/pages';
import { RouteLink } from '../router';
import { EditorialShell } from './EditorialShell';
import { StartChattingLink } from './StartChattingLink';

function sectionReader(page: StaticPage): (heading: string) => PageSection {
  const byHeading = new Map(page.sections.map((s) => [s.heading, s]));
  return (heading) => {
    const found = byHeading.get(heading);
    if (found === undefined) throw new Error(`about: no section "${heading}"`);
    return found;
  };
}

function para(section: PageSection, index: number): string {
  return section.body[index] ?? '';
}

/** Paragraphs from `index` to the end, for the sections the design runs plain. */
function rest(section: PageSection, index: number): readonly string[] {
  return section.body.slice(index);
}

const BODY_CLASS = 'text-[17px] leading-[1.85] text-ink-300';
const BODY_STYLE = { maxWidth: '34em' };
const NUMBER_CLASS =
  'flex-none rounded-lg border border-ink-700 px-[9px] py-[5px] font-mono text-[13px] leading-none text-amber-300';

/** The numbered heading rule every section on this page opens with. */
function SectionHead({
  number,
  children,
}: {
  readonly number: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex items-center gap-3.5"
      style={{ marginBottom: 'clamp(20px, 2.4cqw, 26px)' }}
    >
      <span className={NUMBER_CLASS}>{number}</span>
      <h2
        className="font-display font-semibold leading-[1.15] tracking-[-0.025em] text-ink-100"
        style={{ fontSize: 'clamp(28px, 3.2cqw, 32px)' }}
      >
        {children}
      </h2>
    </div>
  );
}

/** A short amber rule and a serif line — the design's way of landing a point. */
function Punchline({ children }: { readonly children: ReactNode }): JSX.Element {
  return (
    <div
      className="flex items-center gap-3.5"
      style={{ marginTop: 'clamp(26px, 3cqw, 30px)' }}
    >
      <span
        className="block h-px w-[26px] flex-none origin-left animate-draw bg-amber-400"
        style={{ animationDuration: '.6s' }}
      />
      <p
        className="font-display text-ink-100"
        style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)' }}
      >
        {children}
      </p>
    </div>
  );
}

/**
 * A specimen conversation, beside the claim that the product is text only.
 *
 * It exists to *show* the thing the paragraph describes: two bubbles, a typing
 * indicator, and a Skip control. Pressing Skip swaps in the next exchange,
 * which is the one gesture this product is built around and the cheapest
 * possible demonstration of it.
 *
 * The openers are invented for this page rather than drawn from anything real —
 * `messages.body` never leaves the trusted boundary, and a "sample" of genuine
 * conversation would be exactly the leak rule 1 forbids.
 *
 * Re-mounting on `index` (via `key`) is what replays the entrance animations.
 * The alternative — clearing and restoring `style.animation` on each bubble —
 * is what the mock did, and it means reaching into the DOM to restart something
 * React already knows how to rebuild.
 */
const OPENERS: ReadonlyArray<readonly [ask: string, reply: string]> = [
  ['hey — where are you writing from?', 'a train, somewhere north'],
  ['what was the last thing that made you laugh?', 'my own handwriting'],
  ['do you think people are mostly kind?', 'mostly, in small doses'],
  ['what are you avoiding right now?', 'a spreadsheet. you?'],
];

function TextOnlySpecimen(): JSX.Element {
  const [index, setIndex] = useState(0);
  const [ask, reply] = OPENERS[index % OPENERS.length] ?? OPENERS[0]!;

  return (
    <div className="flex flex-col gap-3 rounded-4.5 border border-ink-800 bg-ink-900 p-5 shadow-lift">
      <div className="flex items-center gap-[9px] border-b border-ink-800 pb-1.5 font-mono text-[13px] uppercase tracking-[0.14em] text-ink-400">
        <span className="block h-[7px] w-[7px] animate-dot-pulse rounded-full bg-sage-400" />
        stranger
      </div>

      <div key={index} className="flex flex-col gap-3">
        <div className="max-w-[86%] animate-msg-in self-start rounded-[16px_16px_16px_5px] bg-ink-800 px-[15px] py-[11px] text-base leading-[1.5] text-ink-200">
          {ask}
        </div>
        <div
          className="max-w-[86%] animate-msg-in self-end rounded-[16px_16px_5px_16px] bg-ink-700 px-[15px] py-[11px] text-base leading-[1.5] text-ink-100"
          style={{ animationDelay: '.9s' }}
        >
          {reply}
        </div>
        <div
          className="flex animate-msg-in gap-[5px] self-start rounded-[16px_16px_16px_5px] bg-ink-800 px-[15px] py-[13px]"
          style={{ animationDelay: '1.7s' }}
          aria-hidden="true"
        >
          {[0, 0.2, 0.4].map((delay) => (
            <span
              key={delay}
              className="block h-[5px] w-[5px] animate-float-slow rounded-full bg-ink-400"
              style={{ animationDuration: '1.4s', animationDelay: `${delay}s` }}
            />
          ))}
        </div>
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 border-t border-ink-800 pt-3.5">
        <span className="font-mono text-[13px] uppercase tracking-[0.14em] text-ink-400">
          anonymous
        </span>
        <button
          type="button"
          onClick={() => setIndex((current) => current + 1)}
          className="flex min-h-[44px] items-center gap-2 rounded-full border border-ink-700 px-[15px] py-[9px] font-mono text-[13px] uppercase tracking-[0.1em] text-ink-300 transition-[color,border-color,transform] duration-200 hover:-translate-y-0.5 hover:border-amber-300 hover:text-amber-300"
        >
          Skip
          <span aria-hidden="true">»</span>
        </button>
      </div>
    </div>
  );
}

/** A bordered card holding one short negation, for the "what it is not" grid. */
function NotCard({
  label,
  full,
}: {
  readonly label: string;
  /** Spans the whole row — the design gives the last one its own line. */
  readonly full?: boolean;
}): JSX.Element {
  return (
    <div
      className="flex animate-pop-in items-center gap-3 rounded-[14px] border border-ink-800 bg-ink-900 px-4 py-[18px] transition-[transform,border-color] duration-200 hover:-translate-y-[3px] hover:border-ink-700"
      style={full ? { gridColumn: '1 / -1' } : undefined}
    >
      <X className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
      <span className="font-display text-lg text-ink-200">{label}</span>
    </div>
  );
}

export function AboutPage(): JSX.Element {
  const page = pageById('about');
  const section = sectionReader(page);

  const short = section('The short version');
  const why = section('Why it exists');
  const textOnly = section('Just the conversation');
  const anonymous = section('Anonymous, with an important distinction');
  const automated = section('Some conversations are with automated accounts');
  const adults = section('Adults only');
  const notThis = section('What it is not');

  return (
    <EditorialShell title={page.title}>
      {/* ---------------------------------------------------------------- hero */}
      <div className="animate-fade-in">
        <div className="flex items-center gap-2.5">
          <span className="block h-[7px] w-[7px] animate-float-slow rounded-full bg-amber-400" />
          <span className="font-mono text-[13px] uppercase tracking-[0.2em] text-ink-400">
            karobakbak
          </span>
        </div>
        {/*
          Letter by letter, then a caret. It is an entrance rather than a
          typewriter effect — the word is complete in the DOM from the first
          frame, so it is read and indexed as "About" regardless of the motion.
        */}
        <h1
          className="flex font-display font-semibold leading-[0.9] tracking-[-0.04em] text-ink-50"
          style={{
            margin: 'clamp(18px, 2.4cqw, 22px) 0 0',
            fontSize: 'clamp(62px, 9cqw, 96px)',
          }}
        >
          {[...page.title].map((letter, position) => (
            <span
              key={`${letter}-${position}`}
              className="inline-block animate-rise"
              style={{ animationDelay: `${0.05 + position * 0.07}s` }}
            >
              {letter}
            </span>
          ))}
          <span
            aria-hidden="true"
            className="animate-blink ml-[0.12em] mb-[0.1em] mt-[0.18em] inline-block w-[0.12em] self-stretch bg-amber-400"
            style={{ animationDelay: '.9s' }}
          />
        </h1>
        <p
          className="font-display italic leading-[1.45] text-ink-200"
          style={{
            margin: 'clamp(24px, 3cqw, 30px) 0 0',
            fontSize: 'clamp(22px, 2.6cqw, 26px)',
            maxWidth: '22em',
          }}
        >
          {page.summary}
        </p>
        <div
          className="h-px w-full origin-left animate-draw"
          style={{
            background: 'linear-gradient(90deg, #ffb420 0 44px, #2a241c 44px)',
            marginTop: 'clamp(30px, 4cqw, 40px)',
            animationDelay: '.5s',
          }}
        />
      </div>

      <div
        className="flex flex-col"
        style={{
          gap: 'clamp(66px, 6.5cqw, 80px)',
          padding: 'clamp(48px, 6cqw, 72px) 0 clamp(64px, 7cqw, 96px)',
        }}
      >
        {/* ------------------------------------------------ 01 short version */}
        <section className="animate-fade-in">
          <SectionHead number="01">{short.heading}</SectionHead>
          <p
            className="leading-[1.55] text-ink-100"
            style={{ fontSize: 'clamp(21px, 2.3cqw, 22px)', maxWidth: '28em' }}
          >
            {para(short, 0)}
          </p>
          <p
            className={BODY_CLASS}
            style={{ ...BODY_STYLE, marginTop: 'clamp(22px, 2.4cqw, 26px)' }}
          >
            {para(short, 1)}
          </p>
          <Punchline>{para(short, 2)}</Punchline>
        </section>

        {/* -------------------------------------------------- 02 why it exists */}
        <section className="animate-fade-in">
          <SectionHead number="02">{why.heading}</SectionHead>
          <p className={BODY_CLASS} style={BODY_STYLE}>
            {para(why, 0)}
          </p>
          <p
            className="mt-5 leading-[1.6] text-ink-200"
            style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)', maxWidth: '30em' }}
          >
            {para(why, 1)}
          </p>
          {/*
            The four negations, one per line with a short dash. They are what
            the product removed, so the design gives each its own beat rather
            than running them together in a sentence.
          */}
          <ul
            className="flex list-none flex-col gap-3"
            style={{ marginTop: 'clamp(28px, 3cqw, 34px)' }}
          >
            {why.body.slice(2, 6).map((line) => (
              <li key={line} className="flex items-baseline gap-3">
                <span
                  aria-hidden="true"
                  className="relative -top-1.5 block h-px w-3.5 flex-none origin-left animate-draw bg-ink-600"
                  style={{ animationDuration: '.5s' }}
                />
                <span className="text-[17px] leading-[1.6] text-ink-300">
                  {line}
                </span>
              </li>
            ))}
          </ul>
          <blockquote
            className="border-l-2 border-ink-700"
            style={{
              margin: 'clamp(32px, 3.4cqw, 40px) 0 0',
              paddingLeft: 'clamp(20px, 2.5cqw, 26px)',
            }}
          >
            <p
              className="font-display leading-[1.22] tracking-[-0.025em] text-ink-50"
              style={{ fontSize: 'clamp(30px, 3.8cqw, 36px)' }}
            >
              {para(why, 6)}
            </p>
          </blockquote>
          <p
            className={BODY_CLASS}
            style={{ ...BODY_STYLE, marginTop: 'clamp(30px, 3.2cqw, 38px)' }}
          >
            {para(why, 7)}
          </p>
          <p
            className="mt-[18px] font-display leading-[1.5] text-ink-200"
            style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)' }}
          >
            {para(why, 8)}
          </p>
        </section>

        {/* --------------------------------------------------- 03 text only */}
        <section className="animate-fade-in">
          <SectionHead number="03">{textOnly.heading}</SectionHead>
          <div
            className="grid items-start"
            style={{
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 'clamp(26px, 3cqw, 32px)',
            }}
          >
            <div>
              <p
                className="leading-[1.6] text-ink-200"
                style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)' }}
              >
                {para(textOnly, 0)}
              </p>
              {rest(textOnly, 1).map((paragraph) => (
                <p key={paragraph} className={`mt-5 ${BODY_CLASS}`}>
                  {paragraph}
                </p>
              ))}
            </div>
            <TextOnlySpecimen />
          </div>
        </section>

        {/* --------------------------------------------------- 04 anonymous */}
        <section className="animate-fade-in">
          <SectionHead number="04">{anonymous.heading}</SectionHead>
          <p className={BODY_CLASS} style={BODY_STYLE}>
            {para(anonymous, 0)}
          </p>
          <p className={`mt-5 ${BODY_CLASS}`} style={BODY_STYLE}>
            {para(anonymous, 1)}
          </p>
          {/*
            "Anonymous does not mean invisible" is the correction the whole
            section exists to make, so it is set as the loudest thing in it
            rather than as the third paragraph of five.
          */}
          <div
            className="rounded-4.5 border border-ink-700 border-l-2 border-l-amber-400 bg-ink-900"
            style={{
              margin: 'clamp(28px, 3cqw, 34px) 0',
              padding: 'clamp(22px, 2.6cqw, 28px)',
            }}
          >
            <p
              className="font-display leading-[1.3] text-ink-50"
              style={{ fontSize: 'clamp(23px, 2.7cqw, 26px)' }}
            >
              {para(anonymous, 2)}
            </p>
            <p className="mt-[18px] text-base leading-[1.8] text-ink-300">
              {para(anonymous, 3)}
            </p>
          </div>
          <p className="text-[17px] leading-[1.85] text-ink-200" style={BODY_STYLE}>
            {para(anonymous, 4)}
          </p>
        </section>

        {/* --------------------------------------------------- 05 automated */}
        <section className="animate-fade-in">
          <SectionHead number="05">{automated.heading}</SectionHead>
          <div className="flex gap-4" style={{ maxWidth: '36em' }}>
            <span
              aria-hidden="true"
              className="mt-[11px] block h-[9px] w-[9px] flex-none animate-dot-pulse rounded-full bg-sage-400"
            />
            <div>
              {automated.body.map((paragraph, position) => (
                <p
                  key={paragraph}
                  className={position === 0 ? BODY_CLASS : `mt-5 ${BODY_CLASS}`}
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        </section>

        {/* ------------------------------------------------------ 06 adults */}
        <section className="animate-fade-in">
          <SectionHead number="06">{adults.heading}</SectionHead>
          <div
            className="flex flex-wrap items-start rounded-4.5 border border-ink-700 bg-ink-900"
            style={{
              gap: 'clamp(18px, 2.4cqw, 26px)',
              padding: 'clamp(22px, 2.6cqw, 28px)',
            }}
          >
            {/*
              A badge, not a seal. It states the rule the age gate asks about;
              it is not a claim that anything was checked, which is what the
              second line says in words.
            */}
            <div
              className="flex-none animate-glow-pulse rounded-[14px] border border-ink-600 px-3.5 py-3 font-mono font-medium leading-none text-amber-300"
              style={{ fontSize: 'clamp(26px, 2.8cqw, 28px)' }}
            >
              18+
            </div>
            <div className="min-w-[180px] flex-1">
              <p
                className="leading-[1.55] text-ink-100"
                style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)' }}
              >
                {para(adults, 0)}
              </p>
              <p className="mt-4 text-base leading-[1.8] text-ink-300">
                {para(adults, 1)}
              </p>
              <p className="mt-3.5 text-base leading-[1.8] text-ink-400">
                {para(adults, 2)}
              </p>
            </div>
          </div>
        </section>

        {/* --------------------------------------------------- 07 what it is not */}
        <section className="animate-fade-in">
          <SectionHead number="07">{notThis.heading}</SectionHead>
          <div
            className="grid gap-2.5"
            style={{
              gridTemplateColumns: 'repeat(auto-fit, minmax(165px, 1fr))',
            }}
          >
            {notThis.body.slice(0, 4).map((label) => (
              <NotCard key={label} label={label} />
            ))}
            <NotCard label={para(notThis, 4)} full />
          </div>
          <p
            className={BODY_CLASS}
            style={{ ...BODY_STYLE, marginTop: 'clamp(28px, 3cqw, 34px)' }}
          >
            {para(notThis, 5)}
          </p>
          <p className={`mt-5 ${BODY_CLASS}`} style={BODY_STYLE}>
            {para(notThis, 6)}
          </p>
          <p
            className="animate-shimmer-slow bg-clip-text font-display leading-[1.12] tracking-[-0.03em] text-transparent"
            style={{
              marginTop: 'clamp(34px, 3.6cqw, 42px)',
              fontSize: 'clamp(36px, 4.4cqw, 44px)',
              backgroundImage:
                'linear-gradient(100deg, #f7f5f3 34%, #ffc94a 50%, #f7f5f3 66%)',
              backgroundSize: '200% 100%',
            }}
          >
            {para(notThis, 7)}
          </p>
          <div
            className="flex flex-wrap gap-3"
            style={{ marginTop: 'clamp(30px, 3.2cqw, 36px)' }}
          >
            <StartChattingLink
              className="flex flex-1 basis-[200px] items-center justify-center rounded-full bg-amber-400 px-6 py-[15px] text-[17px] font-semibold text-ink-950 transition-[transform,background,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-amber-300 hover:shadow-glow"
            />
            <RouteLink
              to="/rules"
              className="flex flex-1 basis-[200px] items-center justify-center rounded-full border border-ink-700 px-6 py-[15px] text-[17px] font-medium text-ink-200 transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:text-ink-100"
            >
              Read the rules
            </RouteLink>
          </div>
        </section>
      </div>
    </EditorialShell>
  );
}
