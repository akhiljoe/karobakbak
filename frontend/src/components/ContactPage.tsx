/**
 * Contact — what to write about, and what happens after you do.
 *
 * ---------------------------------------------------------------------------
 * THE PAGE OPENS BY POINTING SOMEWHERE ELSE
 * ---------------------------------------------------------------------------
 * The first thing under the two commitments is a callout telling the reader to
 * use **Report** instead, and that ordering is the design's, not an accident of
 * the transcription.
 *
 * It is there because an email about a bad conversation arrives with no
 * conversation attached: reporting inside the chat sends the transcript with
 * it, extends retention from 30 days to 90, and puts it in the review queue. An
 * email does none of that, and by the time it is read the conversation it
 * describes may already have been deleted on schedule. Somebody who writes
 * instead of reporting has usually lost the only evidence.
 *
 * ---------------------------------------------------------------------------
 * THE ADDRESS IS CONFIGURATION, AND MAY BE ABSENT
 * ---------------------------------------------------------------------------
 * The draft and the artboard both print `hello@example.invalid` — `.invalid` is
 * a reserved TLD that is guaranteed never to resolve, which is exactly what a
 * placeholder should look like and exactly what must not ship.
 *
 * `VITE_CONTACT_EMAIL` supplies the real one. When it is unset every place that
 * would show it says so plainly instead, because this page commits to
 * acknowledging a message within 24 hours and an address that bounces makes
 * that a lie rather than a delay.
 */
import { X } from 'lucide-react';

import { clientConfig } from '../config';
import { CONTACT_SLA } from '../content/contact';
import type { PageSection } from '../content/pages';
import type { StaticPage } from '../content/pages';
import { pageById } from '../content/pages';
import { RouteLink } from '../router';
import { EditorialShell } from './EditorialShell';
import { StartChattingLink } from './StartChattingLink';

const BODY_CLASS = 'text-[17px] leading-[1.85] text-ink-300';
const BODY_STYLE = { maxWidth: '34em' };

function sectionReader(page: StaticPage): (heading: string) => PageSection {
  const byHeading = new Map(page.sections.map((s) => [s.heading, s]));
  return (heading) => {
    const found = byHeading.get(heading);
    if (found === undefined) throw new Error(`contact: no section "${heading}"`);
    return found;
  };
}

/** The numbered heading rule the numbered sections open with. */
function SectionHead({
  number,
  children,
}: {
  readonly number: string;
  readonly children: string;
}): JSX.Element {
  return (
    <div
      className="flex items-center gap-3.5"
      style={{ marginBottom: 'clamp(20px, 2.4cqw, 26px)' }}
    >
      <span className="flex-none rounded-lg border border-ink-700 px-[9px] py-[5px] font-mono text-[13px] leading-none text-amber-300">
        {number}
      </span>
      <h2
        className="font-display font-semibold leading-[1.15] tracking-[-0.025em] text-ink-100"
        style={{ fontSize: 'clamp(28px, 3.2cqw, 32px)' }}
      >
        {children}
      </h2>
    </div>
  );
}

/**
 * The address, or an honest statement that there is not one.
 *
 * Rendered as a block the way the design sets it — a bordered row with an
 * arrow — rather than as an inline link, because on this page the address *is*
 * the call to action.
 */
function AddressBlock(): JSX.Element {
  const email = clientConfig.contactEmail;

  if (email === '') {
    return (
      <p
        className="mt-5 rounded-4.5 border border-dashed border-ink-700 bg-ink-900 px-5 py-4 text-base leading-[1.7] text-ink-300"
        style={{ maxWidth: '34em' }}
      >
        No contact address is configured for this deployment yet, so there is
        nothing here to write to. Use <strong className="text-ink-100">Report</strong>{' '}
        inside a conversation — that route always works.
      </p>
    );
  }

  return (
    <a
      href={`mailto:${email}`}
      className="mt-5 flex items-center justify-between gap-4 rounded-4.5 border border-ink-700 bg-ink-900 px-5 py-4 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-ink-500"
      style={{ maxWidth: '34em' }}
    >
      <span className="break-all font-mono text-base text-amber-300">{email}</span>
      <span aria-hidden="true" className="flex-none text-lg text-ink-400">
        →
      </span>
    </a>
  );
}

export function ContactPage(): JSX.Element {
  const page = pageById('contact');
  const section = sectionReader(page);

  const report = section('Reporting a conversation? Use Report instead');
  const about = section('What you can contact us about');
  const privacy = section('Privacy and data requests');
  const serious = section('If you need to report something serious');
  const cannot = section('What we cannot do');
  const note = section('A note about email');

  const emailConfigured = clientConfig.contactEmail !== '';

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
      </div>

      {/* ------------------------------------------------ the two commitments */}
      <div
        className="grid gap-3"
        style={{
          gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
          marginTop: 'clamp(34px, 4cqw, 46px)',
        }}
      >
        {CONTACT_SLA.map((step) => (
          <div
            key={step.step}
            className="animate-pop-in rounded-4.5 border border-ink-800 bg-ink-900 transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-[3px] hover:border-ink-700 hover:shadow-lift"
            style={{ padding: 'clamp(20px, 2.4cqw, 24px)' }}
          >
            <span className="font-mono text-[13px] uppercase tracking-[0.16em] text-ink-400">
              {step.step}
            </span>
            <h2 className="mt-3 font-display text-[21px] font-semibold text-ink-100">
              {step.title}
            </h2>
            <p className="mt-2.5 text-[15px] leading-[1.7] text-ink-300">
              {step.detail}
            </p>
          </div>
        ))}
      </div>

      {/* -------------------------------------------------- start here */}
      <section
        className="rounded-4.5 border border-ink-700 border-l-2 border-l-amber-400 bg-ink-900"
        style={{
          marginTop: 'clamp(34px, 4cqw, 46px)',
          padding: 'clamp(22px, 2.8cqw, 30px)',
        }}
      >
        <span className="font-mono text-[13px] uppercase tracking-[0.16em] text-amber-300">
          start here
        </span>
        <h2
          className="mt-3.5 font-display font-semibold leading-[1.15] tracking-[-0.025em] text-ink-50"
          style={{ fontSize: 'clamp(24px, 2.9cqw, 28px)', maxWidth: '20em' }}
        >
          {report.heading}
        </h2>
        {report.body.map((paragraph, position) => (
          <p
            key={paragraph}
            className={
              position === 0
                ? 'mt-4 text-base leading-[1.8] text-ink-200'
                : 'mt-4 text-base leading-[1.8] text-ink-300'
            }
          >
            {paragraph}
          </p>
        ))}
      </section>

      <div
        className="flex flex-col"
        style={{
          gap: 'clamp(56px, 6cqw, 72px)',
          padding: 'clamp(56px, 6cqw, 76px) 0 clamp(64px, 7cqw, 96px)',
        }}
      >
        {/* ------------------------------------------- 01 what to write about */}
        <section>
          <SectionHead number="01">{about.heading}</SectionHead>
          {about.body.map((paragraph) => (
            <p key={paragraph} className={BODY_CLASS} style={BODY_STYLE}>
              {paragraph}
            </p>
          ))}
          <ul
            className="mt-[18px] grid list-none gap-2.5"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))' }}
          >
            {about.bullets?.map((item) => (
              <li
                key={item}
                className="rounded-[14px] border border-ink-800 bg-ink-900 px-4 py-3.5 text-[15px] leading-[1.5] text-ink-200 transition-[transform,border-color] duration-200 hover:-translate-y-0.5 hover:border-ink-700"
              >
                {item}
              </li>
            ))}
          </ul>
          {about.tail?.map((paragraph) => (
            <p
              key={paragraph}
              className={`mt-[18px] ${BODY_CLASS}`}
              style={BODY_STYLE}
            >
              {paragraph}
            </p>
          ))}
        </section>

        {/* ---------------------------------------------- 02 privacy requests */}
        <section>
          <SectionHead number="02">{privacy.heading}</SectionHead>
          <p className={BODY_CLASS} style={BODY_STYLE}>
            {privacy.body[0]}
          </p>
          <AddressBlock />
          {privacy.body.slice(1).map((paragraph) => (
            <p
              key={paragraph}
              className={`mt-[18px] ${BODY_CLASS}`}
              style={BODY_STYLE}
            >
              {paragraph}
            </p>
          ))}
        </section>

        {/* -------------------------------------------------- 03 serious */}
        <section>
          <SectionHead number="03">{serious.heading}</SectionHead>
          {serious.body.map((paragraph, position) => (
            <p
              key={paragraph}
              className={position === 0 ? BODY_CLASS : `mt-[18px] ${BODY_CLASS}`}
              style={BODY_STYLE}
            >
              {paragraph}
            </p>
          ))}
          {/*
            The emergency-services line is the one sentence on this page that
            matters in a situation where waiting is dangerous, so it is set apart
            rather than left as the third paragraph of three.
          */}
          <div
            className="rounded-4.5 border border-ink-700 border-l-2 border-l-rose-400 bg-ink-900"
            style={{
              marginTop: 'clamp(22px, 2.6cqw, 28px)',
              padding: 'clamp(18px, 2.2cqw, 24px)',
              maxWidth: '34em',
            }}
          >
            <p className="text-base leading-[1.75] text-ink-100">
              {serious.body[serious.body.length - 1]}
            </p>
          </div>
        </section>

        {/* --------------------------------------------- 04 what we cannot do */}
        <section>
          <SectionHead number="04">{cannot.heading}</SectionHead>
          {/*
            Two refusals, each with its reasoning under it. The design marks the
            claim itself with a × and sets the explanation as ordinary prose,
            which keeps "we cannot" scannable without making the reasons look
            like more refusals.
          */}
          {[cannot.body.slice(0, 3), cannot.body.slice(3)].map((group) => {
            const [claim, ...reasons] = group;
            if (claim === undefined) return null;
            return (
              <div key={claim} className="mt-6 first:mt-0">
                <div className="flex items-start gap-3">
                  <X
                    className="mt-1 h-4 w-4 shrink-0 text-ink-400"
                    aria-hidden="true"
                  />
                  <p
                    className="text-[17px] leading-[1.6] text-ink-100"
                    style={{ maxWidth: '32em' }}
                  >
                    {claim}
                  </p>
                </div>
                {reasons.map((reason) => (
                  <p
                    key={reason}
                    className={`ml-7 mt-3 ${BODY_CLASS}`}
                    style={BODY_STYLE}
                  >
                    {reason}
                  </p>
                ))}
              </div>
            );
          })}
        </section>

        {/* ------------------------------------------------ 05 about email */}
        <section>
          <SectionHead number="05">{note.heading}</SectionHead>
          {note.body.map((paragraph, position) => (
            <p
              key={paragraph}
              className={position === 0 ? BODY_CLASS : `mt-[18px] ${BODY_CLASS}`}
              style={BODY_STYLE}
            >
              {paragraph}
            </p>
          ))}
        </section>

        <div className="flex flex-wrap gap-3">
          <StartChattingLink
            className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full bg-amber-400 px-6 py-[15px] text-[17px] font-semibold text-ink-950 transition-[transform,background,box-shadow] duration-200 hover:-translate-y-0.5 hover:bg-amber-300 hover:shadow-glow"
          />
          {emailConfigured ? (
            <a
              href={`mailto:${clientConfig.contactEmail}`}
              className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full border border-ink-700 px-6 py-[15px] text-[17px] font-medium text-ink-200 transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:text-ink-100"
            >
              Email us
            </a>
          ) : (
            /*
              No address, so no button that opens an empty mail client. The
              Rules are the next most useful thing to read from here.
            */
            <RouteLink
              to="/rules"
              className="flex min-h-[52px] flex-1 basis-[210px] items-center justify-center rounded-full border border-ink-700 px-6 py-[15px] text-[17px] font-medium text-ink-200 transition-[transform,border-color,color] duration-200 hover:-translate-y-0.5 hover:border-ink-500 hover:text-ink-100"
            >
              Read the rules
            </RouteLink>
          )}
        </div>

        {/*
          ---------------------------------------------------------------------
          THE BUTTON IS SELF-HOSTED, AND THAT IS THE WHOLE POINT
          ---------------------------------------------------------------------
          Buy Me a Coffee publishes this as an `<img>` pointing at
          `img.buymeacoffee.com/button-api/...`. Used that way it would be
          blocked outright — `img-src` is `'self' data:` plus the payment
          provider — and widening the policy to admit it would make a published
          claim false: the Privacy Policy says the site makes *no requests to
          any third party* from the browser.

          It would also be a real leak rather than a technicality. Every render
          hands Buy Me a Coffee the visitor's IP address and the page they were
          on, without them clicking anything, on a service whose entire premise
          is anonymity.

          So the rendered SVG is fetched once and served from this origin. It is
          self-contained — the Cookie face is a `data:font/woff2` inside the
          file and the cup is an internal reference — so nothing leaves the
          page. Identical artwork, no request, no policy change.

          Re-fetch it from the button-api URL if the branding ever changes;
          `docs/brand/README.md` records where it came from.
        */}
        {clientConfig.supportUrl !== '' && (
          <div className="flex flex-col items-start gap-3">
            <p className={BODY_CLASS} style={BODY_STYLE}>
              None of this is paid for by anybody. If it has been useful to you and
              you feel like helping with the bill, there is a page for that.
            </p>
            <a
              href={clientConfig.supportUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-block rounded-xl transition-transform duration-200 hover:-translate-y-0.5"
            >
              {/*
                Width and height are set so the row does not reflow as the image
                decodes, and the alt text is the button's own words — a screen
                reader should hear the link, not "image".
              */}
              <img
                src="/buymeacoffee-button.svg"
                width={235}
                height={50}
                alt="Buy me a coffee"
              />
            </a>
          </div>
        )}
      </div>
    </EditorialShell>
  );
}
