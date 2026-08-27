/**
 * Support the project — the one warm, light surface in a dark product.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PAGE LOOKS NOTHING LIKE THE REST
 * ---------------------------------------------------------------------------
 * Everything else is `ink` on near-black. This is cream and brown, and the
 * break is the point rather than an inconsistency: a request for money wearing
 * the same chrome as the product reads as part of the product, and this is
 * explicitly not — nothing here is bought, unlocked or owed.
 *
 * Stepping fully out of the dark shell is also the honest signal that you have
 * left the thing you came for. The header carries one link back to it.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS DELIBERATELY ABSENT
 * ---------------------------------------------------------------------------
 * **No supporters wall.** It needs a stored list of who gave what — a durable
 * record of people attached to money, in a product whose whole claim is that it
 * keeps no durable record of people. It would also be the only place on the
 * site displaying names.
 *
 * **No third-party widget.** The Content Security Policy is `default-src
 * 'self'` and the Privacy page states the site makes no third-party requests
 * from the browser. Razorpay's script would break both, which is why
 * `PAYMENTS_ENABLED` and the CSP have to change together, in one commit.
 *
 * Until then the amounts are selectable and the confirm is not, with the reason
 * on screen. A button that opened nothing would be worse than an honest one
 * that is disabled.
 */
import { useState } from 'react';
import { ArrowLeft, Check, Heart } from 'lucide-react';

import { clientConfig } from '../config';
import { PAYMENTS_ENABLED } from '../features';
import { RouteLink, useDocumentTitle } from '../router';
import { secondaryNav } from './SiteNav';
import { LogoMark } from './Logo';

/**
 * Amounts, in rupees.
 *
 * Round numbers rather than converted dollars: a tier of ₹249 reads as a price,
 * and a price invites the question of what it buys. Nothing here buys anything.
 */
const TIERS: ReadonlyArray<{ amount: number; emoji: string; name: string; note: string }> = [
  { amount: 50, emoji: '☕', name: 'A coffee', note: 'The classic. Genuinely appreciated.' },
  { amount: 150, emoji: '☕☕', name: 'A few', note: 'Enough to notice. Thank you.' },
  { amount: 500, emoji: '🍰', name: 'Coffee and cake', note: 'That is a real chunk of the bill.' },
  { amount: 1000, emoji: '📦', name: 'A month of server', note: 'Absurdly kind of you.' },
];

const PROMISES: readonly string[] = [
  'The site stays free, and nothing moves behind a payment.',
  'No advertising anywhere.',
  'You get nothing extra — no badge, no perks, no faster matching.',
  'No supporters list. Your name is not shown anywhere.',
];

export function SupportPage(): JSX.Element {
  useDocumentTitle('Buy me a coffee · karobakbak');

  const [amount, setAmount] = useState<number>(150);
  const [custom, setCustom] = useState('');
  const [note, setNote] = useState('');

  const chosen = custom.trim() !== '' ? Number(custom) : amount;
  const valid = Number.isFinite(chosen) && chosen > 0;
  const external = clientConfig.supportUrl;

  return (
    <div className="h-full overflow-y-auto bg-coffee-50 text-coffee-900">
      <header className="sticky top-0 z-30 border-b border-coffee-100 bg-coffee-50/90 backdrop-blur-md">
        <div className="safe-pt mx-auto flex h-14 w-full max-w-3xl items-center justify-between px-5 sm:px-6">
          <RouteLink
            to="/"
            aria-label="karobakbak — home"
            className="inline-flex items-center gap-2 rounded-lg transition-opacity hover:opacity-80"
          >
            <LogoMark size={24} />
            <span className="font-display text-base font-semibold tracking-tight text-coffee-900">
              karobakbak
            </span>
          </RouteLink>

          <RouteLink
            to="/"
            className="inline-flex items-center gap-1.5 rounded-full border border-coffee-200 bg-white px-3.5 py-1.5 text-sm font-medium text-coffee-700 transition-colors hover:border-coffee-300"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            Back to chatting
          </RouteLink>
        </div>
      </header>

      <main className="relative overflow-hidden pb-16 pt-12 sm:pt-16">
        {/* Warmth, at the edges, well away from anything readable. */}
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
          <div className="absolute -left-20 top-4 h-72 w-72 rounded-full bg-cream-200/50 blur-3xl" />
          <div className="absolute -right-24 bottom-0 h-96 w-96 rounded-full bg-coffee-200/40 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-2xl px-5 text-center sm:px-6">
          <div className="mb-6 inline-flex animate-float items-center justify-center">
            <span className="relative flex h-20 w-20 items-center justify-center rounded-full bg-gradient-to-br from-coffee-500 to-coffee-700 text-4xl shadow-lg ring-4 ring-coffee-50">
              ☕
            </span>
          </div>

          <p className="mb-4 inline-flex items-center gap-1.5 rounded-full border border-coffee-200 bg-coffee-100 px-3 py-1 text-xs font-semibold text-coffee-700">
            <Heart className="h-3.5 w-3.5" aria-hidden="true" />
            Entirely optional
          </p>

          <h1 className="font-display text-3xl font-extrabold tracking-tight text-coffee-900 sm:text-4xl">
            Buy me a coffee
          </h1>
          <p className="mx-auto mt-3 max-w-md text-base leading-relaxed text-coffee-600">
            karobakbak is free and has no advertising. Servers still cost money — if you have
            enjoyed talking to a stranger here and want to chip in, this is the place.
          </p>
        </div>

        <div className="relative mx-auto mt-9 max-w-2xl px-5 sm:px-6">
          <div className="rounded-3xl border border-coffee-100 bg-white p-6 shadow-xl shadow-coffee-900/5 sm:p-8">
            <fieldset>
              <legend className="text-sm font-semibold text-coffee-800">Pick an amount</legend>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {TIERS.map((tier) => {
                  const active = custom.trim() === '' && amount === tier.amount;
                  return (
                    <button
                      key={tier.amount}
                      type="button"
                      aria-pressed={active}
                      onClick={() => {
                        setAmount(tier.amount);
                        setCustom('');
                      }}
                      className={`rounded-2xl border-2 p-4 text-center transition-all ${
                        active
                          ? 'scale-[1.02] border-coffee-500 bg-coffee-50 shadow-md'
                          : 'border-coffee-100 bg-white hover:border-coffee-300'
                      }`}
                    >
                      <span className="block text-2xl">{tier.emoji}</span>
                      <span className="mt-1.5 block font-display text-lg font-bold text-coffee-900">
                        ₹{tier.amount}
                      </span>
                      <span className="mt-0.5 block text-xs font-medium text-coffee-500">
                        {tier.name}
                      </span>
                    </button>
                  );
                })}
              </div>

              <p className="mt-3 text-center text-sm text-coffee-500">
                {custom.trim() === ''
                  ? (TIERS.find((t) => t.amount === amount)?.note ?? '')
                  : 'However much you like.'}
              </p>

              <label
                htmlFor="support-custom"
                className="mt-5 block text-sm font-semibold text-coffee-800"
              >
                Or choose your own
              </label>
              <div className="relative mt-1.5">
                <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-semibold text-coffee-400">
                  ₹
                </span>
                <input
                  id="support-custom"
                  inputMode="numeric"
                  value={custom}
                  onChange={(event) => setCustom(event.target.value.replace(/[^0-9]/g, ''))}
                  placeholder="250"
                  className="h-12 w-full rounded-2xl border-2 border-coffee-100 bg-white pl-8 pr-4 text-base font-medium text-coffee-900 placeholder:text-coffee-300 focus:border-coffee-400 focus:outline-none"
                />
              </div>
            </fieldset>

            <label
              htmlFor="support-note"
              className="mt-5 block text-sm font-semibold text-coffee-800"
            >
              Say something <span className="font-normal text-coffee-500">— optional</span>
            </label>
            <input
              id="support-note"
              value={note}
              onChange={(event) => setNote(event.target.value.slice(0, 140))}
              placeholder="Anything you like"
              className="mt-1.5 h-12 w-full rounded-2xl border-2 border-coffee-100 bg-white px-4 text-base text-coffee-900 placeholder:text-coffee-300 focus:border-coffee-400 focus:outline-none"
            />
            <p className="mt-1.5 text-xs text-coffee-500">
              Goes to the payment provider with the payment. We do not store it, and it is never
              shown on the site.
            </p>

            <div className="mt-6">
              {PAYMENTS_ENABLED ? (
                <button
                  type="button"
                  disabled={!valid}
                  className="inline-flex h-13 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-coffee-500 to-coffee-700 px-6 py-3.5 text-base font-bold text-white shadow-lg shadow-coffee-900/20 transition-all hover:brightness-110 active:scale-[0.99] disabled:opacity-50"
                >
                  <Heart className="h-4 w-4" aria-hidden="true" />
                  Send ₹{valid ? chosen : 0}
                </button>
              ) : (
                <>
                  <div className="rounded-2xl border-2 border-dashed border-coffee-300 bg-coffee-50 px-4 py-4 text-center">
                    <p className="text-sm font-bold text-coffee-800">Not connected yet</p>
                    <p className="mt-1 text-sm leading-relaxed text-coffee-600">
                      Payments are not live, so nothing can be sent from this page today.
                    </p>
                  </div>
                  {external !== '' && (
                    <a
                      href={external}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="mt-3 block rounded-2xl border-2 border-coffee-100 bg-white px-4 py-3 text-center text-sm font-medium text-coffee-700 transition-colors hover:border-coffee-300"
                    >
                      There is a page elsewhere, if you would rather
                    </a>
                  )}
                </>
              )}
            </div>
          </div>

          <ul className="mx-auto mt-7 max-w-md space-y-2">
            {PROMISES.map((line) => (
              <li key={line} className="flex items-start gap-2.5 text-sm text-coffee-600">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-coffee-400" aria-hidden="true" />
                {line}
              </li>
            ))}
          </ul>

          <nav
            aria-label="More"
            className="safe-pb mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-sm text-coffee-500"
          >
            {/*
              The same links the footer carries everywhere else, in this page's
              own palette rather than its component.

              `SiteFooter` is dark by construction, and this is the one surface
              in the product that is deliberately not (see the `coffee` note in
              `tailwind.config.js`): asking for money in the chat's chrome reads
              as part of the product, and it is not. So the *list* is shared and
              the colours are local — which is the half worth sharing, since the
              bug this page would otherwise repeat is a link set that quietly
              falls out of step with the rest of the site.

              "Buy me a coffee" is dropped because it points here.
            */}
            {secondaryNav()
              .filter((item) => item.to !== '/support')
              .map((item) => (
              <RouteLink
                key={item.to}
                to={item.to}
                className="rounded py-1 underline underline-offset-4 transition-colors hover:text-coffee-800"
              >
                {item.label}
              </RouteLink>
            ))}
          </nav>
        </div>
      </main>
    </div>
  );
}
