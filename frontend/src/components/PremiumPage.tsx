/**
 * Premium: what a subscription would add, and what it deliberately would not.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COPY IS IN THIS FILE AND NOT IN `content/`
 * ---------------------------------------------------------------------------
 * Premium is not a `StaticPage`. It is not in the footer's list, it is not one
 * of the documents somebody looks up, and — unlike every page in `content/` —
 * what it says is conditional on `PAYMENTS_ENABLED`. Holding conditional copy
 * as data means encoding the condition in the data too, which is how a content
 * file turns into a template language.
 *
 * The discipline that applies to `content/` still applies to every sentence
 * here, and one claim on this page is load-bearing:
 *
 *   the email belongs to the SUBSCRIPTION, not to the person chatting
 *
 * Conversations are not linked to it. That separation is what makes the rest of
 * the anonymity story true; if it ever stops being true, this copy is a lie and
 * the anonymity claim goes with it.
 *
 * ---------------------------------------------------------------------------
 * SECTION 03 IS NOT A DISCLAIMER, IT IS THE POINT
 * ---------------------------------------------------------------------------
 * Gender, country and language are read from the declared profile, and a
 * declared profile is a claim rather than an attribute (`DESIGN.md` §26.4). A
 * filter narrows a pool; it verifies nothing. That is set as large as the
 * feature list above it, because a filter that reads as a safety control is
 * worse than no filter — it is the one place this page could mislead somebody
 * into lowering their guard.
 */
import { Check, Globe, Languages, Users, X } from 'lucide-react';

import { PAYMENTS_ENABLED } from '../features';
import { Button } from './Button';
import { EditorialShell } from './EditorialShell';

interface PremiumPageProps {
  readonly onSignIn: () => void;
}

const H2_STYLE = { fontSize: 'clamp(24px, 3.2cqw, 30px)' };
const H2_CLASS =
  'font-display font-semibold leading-[1.2] tracking-[-0.02em] text-ink-100';
const BODY_CLASS = 'text-[17px] leading-[1.85] text-ink-300';
const BODY_STYLE = { maxWidth: '34em' };

interface Addition {
  /*
   * `Premium Board.dc.html` names these: "Icons map to lucide Users, Globe,
   * Languages, Check." The page artboard draws mono glyphs because a canvas
   * cannot import an icon set; the spec line is the instruction.
   */
  readonly icon: typeof Globe;
  readonly title: string;
  readonly lines: readonly string[];
  /** The quieter trailing line, where one exists — always the caveat. */
  readonly caveat?: string;
}

const ADDITIONS: readonly Addition[] = [
  {
    icon: Users,
    title: 'Match by gender',
    lines: [
      'Choose whether you want to be matched with people of a particular gender.',
    ],
    caveat: 'Gender is self-declared. Nobody checks or verifies it.',
  },
  {
    icon: Globe,
    title: 'Match by country',
    lines: ['Choose any country, or leave it open to everyone.'],
    caveat: 'Your choice affects who you may be matched with.',
  },
  {
    icon: Languages,
    title: 'Match by language',
    lines: [
      'Choose the language you want to chat in and narrow your matching pool ' +
        'to people who have selected the same language.',
    ],
  },
];

/** What Premium does not provide, one card each. */
const NOT_PROVIDED: readonly string[] = [
  'Age filtering',
  'Precise location matching',
  'Verified identities',
  'Verified profiles',
  'Any guarantee that someone is who they claim to be',
];

/**
 * A field of dashed dots with one solid amber one: you, among strangers nobody
 * has checked.
 *
 * Dashed rather than filled is the whole idea — an outline is a person whose
 * declared details are a claim. It says "random, and unverified" without
 * claiming a population size, which is the same restraint `showPresence()`
 * applies to the live counter (D21).
 */
function StrangerField(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="h-[74px] animate-rise overflow-hidden"
      style={{ marginTop: 'clamp(26px, 3cqw, 34px)', animationDelay: '.26s' }}
    >
      <div
        className="grid h-full content-center"
        style={{
          gridTemplateColumns: 'repeat(auto-fill, 27px)',
          rowGap: '18px',
        }}
      >
        {Array.from({ length: 16 }, (_, position) =>
          position === 3 ? (
            <span
              key={position}
              className="block h-[9px] w-[9px] animate-glow-pulse rounded-full bg-amber-400"
              style={{ animationDuration: '4s' }}
            />
          ) : (
            <span
              key={position}
              className="block h-[9px] w-[9px] animate-swap-soft rounded-full border border-dashed border-ink-600"
              style={{ animationDelay: `${(position % 8) * 0.4}s` }}
            />
          ),
        )}
      </div>
    </div>
  );
}

function SectionHead({
  number,
  children,
}: {
  readonly number: string;
  readonly children: string;
}): JSX.Element {
  return (
    <div className="flex items-baseline gap-3 border-t border-ink-800 pt-4">
      <span className="font-mono text-[13px] text-ink-400">{number}</span>
      <h2 className={H2_CLASS} style={H2_STYLE}>
        {children}
      </h2>
    </div>
  );
}

export function PremiumPage({ onSignIn }: PremiumPageProps): JSX.Element {
  return (
    <EditorialShell title="Premium">
      {/* ---------------------------------------------------------------- hero */}
      <div>
        <div className="flex animate-rise items-center gap-2.5">
          <span className="block h-[7px] w-[7px] animate-float-slow rounded-full bg-amber-400" />
          <span className="font-mono text-[13px] uppercase tracking-[0.2em] text-ink-400">
            Premium
          </span>
        </div>
        <h1
          className="font-display font-semibold leading-[1.02] tracking-[-0.035em] text-ink-50"
          style={{
            margin: 'clamp(18px, 2.4cqw, 22px) 0 0',
            fontSize: 'clamp(40px, 5.8cqw, 60px)',
            maxWidth: '17em',
          }}
        >
          <span className="block animate-rise" style={{ animationDelay: '.06s' }}>
            Random by default.
          </span>
          <span
            className="block animate-rise text-ink-200"
            style={{ animationDelay: '.16s' }}
          >
            More choice when you want it.
          </span>
        </h1>

        <StrangerField />

        <p
          className="animate-rise leading-[1.65] text-ink-200"
          style={{
            margin: 'clamp(22px, 2.6cqw, 28px) 0 0',
            fontSize: 'clamp(19px, 2.2cqw, 20px)',
            maxWidth: '32em',
            animationDelay: '.34s',
          }}
        >
          Free matching stays free and fully random. Premium lets you narrow
          your matching pool by gender, country and language.
        </p>
      </div>

      {/* ---------------------------------------------------------- the price */}
      <div
        className="animate-pop-in overflow-hidden rounded-4.5 border border-ink-700 bg-ink-900 shadow-lift"
        style={{ marginTop: 'clamp(32px, 3.5cqw, 44px)', animationDelay: '.4s' }}
      >
        <div
          className="flex flex-wrap items-baseline gap-x-3.5 gap-y-2 border-b border-ink-800"
          style={{ padding: 'clamp(20px, 2.6cqw, 26px)' }}
        >
          <span
            className="font-mono font-medium tracking-[-0.01em] text-ink-100"
            style={{ fontSize: 'clamp(24px, 3cqw, 30px)' }}
          >
            ₹99 / month
          </span>
          <span className="text-[15px] text-ink-400" aria-hidden="true">
            ·
          </span>
          <span className="text-[15px] text-ink-300">Cancel any time</span>
        </div>

        <div
          className="flex flex-col gap-3.5"
          style={{ padding: 'clamp(20px, 2.6cqw, 26px)' }}
        >
          {/*
            The page states plainly that nothing here can be bought. Hiding it
            entirely was considered and rejected: somebody deciding whether this
            product is for them cannot find out what it would cost, and a page
            that is honest about not being open yet is the honest version of the
            same caution.
          */}
          {!PAYMENTS_ENABLED && (
            <>
              <div className="flex items-center gap-2.5">
                <span
                  aria-hidden="true"
                  className="block h-[9px] w-[9px] flex-none animate-dot-pulse-amber rounded-full bg-amber-400"
                />
                <span
                  className="font-display font-semibold text-ink-50"
                  style={{ fontSize: 'clamp(21px, 2.5cqw, 24px)' }}
                >
                  Not open yet.
                </span>
              </div>
              <p
                className="text-base leading-[1.7] text-ink-300"
                style={{ maxWidth: '36em' }}
              >
                Premium subscriptions are not available yet. Nothing on this
                page can be purchased today.
              </p>
            </>
          )}

          <div className="mt-1 flex flex-wrap items-center gap-3.5">
            {PAYMENTS_ENABLED ? (
              <Button size="lg" className="basis-[180px]" onClick={onSignIn}>
                Subscribe
              </Button>
            ) : (
              <button
                type="button"
                disabled
                aria-disabled="true"
                /*
                  ink-600 on ink-800 is below the usual contrast floor and is
                  correct here: the spec calls it out because this text *is*
                  disabled, and a disabled control that reads as enabled is the
                  worse failure. The sentence above it carries the meaning.
                */
                className="min-h-[52px] flex-none basis-[180px] cursor-not-allowed rounded-full border border-ink-800 bg-ink-800 px-6 py-[15px] text-[17px] font-semibold text-ink-600"
              >
                Subscribe
              </button>
            )}
            <span className="text-[15px] text-ink-400">
              Already have Premium?{' '}
              <button
                type="button"
                onClick={onSignIn}
                className="border-b border-amber-300/35 text-amber-300 transition-colors hover:border-amber-400 hover:text-amber-400"
              >
                Sign in
              </button>
            </span>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------- 01 what it adds */}
      <section style={{ marginTop: 'clamp(56px, 6.5cqw, 84px)' }}>
        <SectionHead number="01">What Premium adds</SectionHead>
        <div
          className="mt-[26px] grid gap-3"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}
        >
          {ADDITIONS.map(({ icon: Icon, title, lines, caveat }) => (
            <div
              key={title}
              className="animate-pop-in rounded-4.5 border border-ink-800 bg-ink-900 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-ink-700 hover:shadow-lift"
              style={{ padding: 'clamp(20px, 2.4cqw, 24px)' }}
            >
              <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[11px] bg-ink-800 text-amber-300">
                <Icon
                  className="h-[18px] w-[18px]"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
              </div>
              <h3 className="mt-3.5 font-display text-[21px] font-semibold text-ink-100">
                {title}
              </h3>
              {lines.map((line) => (
                <p
                  key={line}
                  className="mt-2.5 text-[15px] leading-[1.7] text-ink-300"
                >
                  {line}
                </p>
              ))}
              {caveat !== undefined && (
                <p className="mt-3 text-sm leading-[1.65] text-ink-400">
                  {caveat}
                </p>
              )}
            </div>
          ))}

          {/*
            The sage left border marks this one as the reassurance rather than
            an upsell: it is the card that says nothing moves *out* of free.
          */}
          <div
            className="animate-pop-in rounded-4.5 border border-ink-800 border-l-2 border-l-sage-400 bg-ink-900 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-lift"
            style={{ padding: 'clamp(20px, 2.4cqw, 24px)', animationDelay: '.2s' }}
          >
            <div className="flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-ink-800 text-sage-400">
              <Check className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
            </div>
            <h3 className="mt-3.5 font-display text-[21px] font-semibold text-ink-100">
              Everything in free
            </h3>
            <p className="mt-2.5 text-[15px] leading-[1.7] text-ink-300">
              Premium doesn&rsquo;t take anything away from free chat.
            </p>
            <p className="mt-3 text-[15px] leading-[1.7] text-ink-300">
              You still get Skip, Block and Report, with the same safety
              controls and the same data-retention rules.
            </p>
            <p className="mt-3 text-[15px] leading-[1.7] text-ink-200">
              Free chatting remains free.
            </p>
          </div>
        </div>
      </section>

      {/* ----------------------------------------------------- 02 the email */}
      <section style={{ marginTop: 'clamp(56px, 6.5cqw, 84px)' }}>
        <SectionHead number="02">The one place an email is involved</SectionHead>
        <p
          className="mt-[22px] leading-[1.6] text-ink-200"
          style={{ fontSize: 'clamp(18px, 2.1cqw, 20px)', maxWidth: '30em' }}
        >
          Premium is the only part of karobakbak that requires an account.
        </p>
        <div
          className="rounded-4.5 border border-ink-700 border-l-2 border-l-amber-400 bg-ink-900"
          style={{
            margin: 'clamp(24px, 3cqw, 30px) 0',
            padding: 'clamp(20px, 2.6cqw, 26px)',
          }}
        >
          <p className="text-base leading-[1.75] text-ink-200">
            Your email address is used to manage your subscription. It is not
            presented to people you chat with, and your conversations are not
            linked to your Premium account simply because you have one.
          </p>
        </div>
        <p className={BODY_CLASS} style={BODY_STYLE}>
          You can still use the free product without an account.
        </p>
        <p className={`mt-[18px] ${BODY_CLASS}`} style={BODY_STYLE}>
          If you cancel Premium, your subscription ends and you can continue
          using karobakbak for free.
        </p>
      </section>

      {/* ------------------------------------------ 03 what it does not do */}
      <section
        style={{
          marginTop: 'clamp(56px, 6.5cqw, 84px)',
          paddingBottom: 'clamp(60px, 7cqw, 96px)',
        }}
      >
        <SectionHead number="03">What Premium filtering does not do</SectionHead>
        <p
          className="mt-[22px] leading-[1.6] text-ink-200"
          style={{ fontSize: 'clamp(18px, 2.1cqw, 20px)', maxWidth: '32em' }}
        >
          Filters narrow the matching pool. They do not verify anything about
          the people you meet.
        </p>
        <p className={`mt-[18px] ${BODY_CLASS}`} style={BODY_STYLE}>
          Gender, country and language are self-declared. Someone may be
          mistaken, inaccurate or simply dishonest about what they have
          selected.
        </p>
        <p
          className="text-[17px] leading-[1.78] text-ink-200"
          style={{ marginTop: 'clamp(26px, 3cqw, 32px)' }}
        >
          Premium does not provide:
        </p>
        <div
          className="mt-4 grid gap-2.5"
          style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}
        >
          {NOT_PROVIDED.map((item, position) => (
            <div
              key={item}
              className="flex animate-pop-in items-center gap-2.5 rounded-[14px] border border-ink-800 bg-ink-900 px-4 py-[17px] transition-[transform,border-color] duration-200 hover:-translate-y-[3px] hover:border-ink-700"
              style={
                position === NOT_PROVIDED.length - 1
                  ? { gridColumn: '1 / -1' }
                  : undefined
              }
            >
              <X className="h-4 w-4 shrink-0 text-ink-400" aria-hidden="true" />
              <span className="font-display text-lg text-ink-200">{item}</span>
            </div>
          ))}
        </div>
        <p
          className="font-display leading-[1.2] tracking-[-0.025em] text-ink-50"
          style={{
            marginTop: 'clamp(34px, 3.6cqw, 42px)',
            fontSize: 'clamp(29px, 3.4cqw, 36px)',
            maxWidth: '22em',
          }}
        >
          Filtering is a matching preference, not a safety feature.
        </p>
        <div className="mt-[22px] flex items-center gap-3.5">
          <span
            aria-hidden="true"
            className="block h-px w-[26px] flex-none origin-left animate-draw bg-amber-400"
            style={{ animationDuration: '.6s' }}
          />
          <p
            className="font-display text-ink-100"
            style={{ fontSize: 'clamp(19px, 2.1cqw, 20px)' }}
          >
            You are still talking to strangers.
          </p>
        </div>
      </section>
    </EditorialShell>
  );
}
