/**
 * Premium.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS PAGE ONLY EXISTS WHEN A CONSTANT SAYS SO
 * ---------------------------------------------------------------------------
 * `ACCOUNTS_ENABLED` gates the route in `Root.tsx`, so with the flag off this
 * is not reachable and `/premium` is a 404. That is the same rule `features.ts`
 * already sets out: turning this on is a commit, not a deploy, because it is a
 * product and legal decision rather than a configuration one.
 *
 * `PAYMENTS_ENABLED` is a second, narrower gate. Accounts can exist before
 * Razorpay is wired up, and in that window the page is honest about it rather
 * than showing a button that opens nothing.
 *
 * ---------------------------------------------------------------------------
 * WHAT PREMIUM IS ALLOWED TO BE
 * ---------------------------------------------------------------------------
 * Gender, country and language — every one of them read from the declared
 * profile, and not one of them verified.
 *
 * Gender was excluded first and then included. The argument against it is worth
 * keeping next to the code rather than deleting with the decision: filtering a
 * self-declared field is nearer to targeting than to preference, and on a
 * service with no age assurance that is the harm D37 was written about.
 *
 * What follows is a constraint on the copy rather than on the feature. Nothing
 * on this page may suggest a filter has checked anything, because none of them
 * has — which is why "Nothing verified" is listed among what filtering does not
 * do, immediately under the list of what it does.
 *
 * The free product does not get worse. Nothing that exists today moves behind
 * this, which is the only version of paid matching that does not make the
 * unpaid experience an advert for itself.
 *
 * ---------------------------------------------------------------------------
 * THE ACCOUNT IS THE UNCOMFORTABLE PART, SO IT IS STATED PLAINLY
 * ---------------------------------------------------------------------------
 * Every other page says there is no account. This one introduces one, and the
 * honest framing is that the email belongs to the *subscription* rather than to
 * the person chatting — conversations are not linked to it. That separation is
 * the thing that has to stay true; if it ever stops being true, this copy is a
 * lie and the whole anonymity claim goes with it.
 */
import { Check, Globe, Languages, Mail, ShieldCheck, Users } from "lucide-react";

import { PAYMENTS_ENABLED } from "../features";
import { RouteLink, useDocumentTitle } from "../router";
import { Button } from "./Button";
import { Logo } from "./Logo";
import { SiteFooter } from "./SiteFooter";

interface PremiumPageProps {
  readonly onSignIn: () => void;
}

const INCLUDED: ReadonlyArray<{
  icon: typeof Globe;
  title: string;
  detail: string;
}> = [
  {
    icon: Users,
    title: "Match by gender",
    detail: "Whatever people have said about themselves. Nobody has checked it.",
  },
  {
    icon: Globe,
    title: "Match by country",
    detail: "Anywhere, or a country you pick. Nobody is shown your location.",
  },
  {
    icon: Languages,
    title: "Match by language",
    detail: "Talk to people who speak what you speak.",
  },
  {
    icon: ShieldCheck,
    title: "Everything free already has",
    detail:
      "Skip, block, report and the same retention. None of it moves behind this.",
  },
];

export function PremiumPage({ onSignIn }: PremiumPageProps): JSX.Element {
  useDocumentTitle("Premium · karobakbak");

  return (
    // Own scroll container — see the note in SitePage.tsx.
    <div className="h-full overflow-y-auto bg-ink-950">
      <div className="flex min-h-full flex-col">
        <header className="safe-pt sticky top-0 z-30 border-b border-ink-800 bg-ink-950/85 backdrop-blur-md">
          <div className="mx-auto flex h-14 w-full max-w-4xl items-center justify-between px-5 sm:px-6">
            <RouteLink
              to="/"
              aria-label="karobakbak — home"
              className="rounded-lg hover:opacity-80"
            >
              <Logo size={24} />
            </RouteLink>
            <button
              onClick={onSignIn}
              className="rounded-lg border border-ink-700 bg-ink-900 px-3 py-1.5 text-sm text-ink-200 transition-colors hover:border-ink-600 hover:text-ink-50"
            >
              Sign in
            </button>
          </div>
        </header>

        <main className="mx-auto w-full max-w-2xl flex-1 px-5 py-12 sm:px-6 sm:py-16">
          <p className="font-mono text-xs uppercase tracking-widest text-amber-400">
            Premium — optional
          </p>
          <h1 className="mt-3 font-display text-3xl font-semibold leading-tight tracking-tight text-ink-50 sm:text-4xl">
            Random by default.{" "}
            <span className="italic text-amber-300">Yours to narrow.</span>
          </h1>
          <p className="mt-4 text-base leading-relaxed text-ink-300">
            Free matching stays free and stays fully random. Premium lets you
            choose the country and language of the people you are matched with,
            instead of taking whoever is next.
          </p>

          <div className="mt-8 flex items-baseline gap-2">
            <span className="font-display text-4xl font-semibold text-ink-50">
              ₹99
            </span>
            <span className="text-sm text-ink-400">
              / month · cancel any time
            </span>
          </div>

          <div className="mt-6 max-w-xs">
            {PAYMENTS_ENABLED ? (
              <Button size="lg" className="w-full" onClick={onSignIn}>
                Get Premium
              </Button>
            ) : (
              <div className="rounded-xl border border-dashed border-amber-400/40 bg-amber-400/5 px-4 py-3.5">
                <p className="text-sm font-medium text-amber-300">
                  Not open yet.
                </p>
                <p className="mt-1 text-sm leading-relaxed text-ink-400">
                  Subscriptions are not live. Nothing here can be bought today.
                </p>
              </div>
            )}
            <p className="mt-3 text-sm text-ink-500">
              Already premium?{" "}
              <button
                onClick={onSignIn}
                className="text-ink-300 underline underline-offset-4 transition-colors hover:text-amber-300"
              >
                Sign in
              </button>
            </p>
          </div>

          <ul className="mt-10 grid gap-3">
            {INCLUDED.map(({ icon: Icon, title, detail }) => (
              <li
                key={title}
                className="flex items-start gap-3.5 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-4"
              >
                <Icon
                  className="mt-0.5 h-5 w-5 shrink-0 text-amber-400"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <div>
                  <p className="text-sm font-medium text-ink-100">{title}</p>
                  <p className="mt-1 text-sm leading-relaxed text-ink-400">
                    {detail}
                  </p>
                </div>
              </li>
            ))}
          </ul>

          <section className="mt-10 rounded-xl border border-ink-800 bg-ink-900/40 px-5 py-5">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold text-ink-100">
              <Mail className="h-4 w-4 text-ink-500" aria-hidden="true" />
              The one place an email is involved
            </h2>
            <p className="mt-2.5 text-sm leading-relaxed text-ink-400">
              A subscription has to belong to somebody, so premium is the only
              part of karobakbak with an account. The address identifies the
              subscription — it is not attached to your conversations, and
              nothing you say is linked back to it.
            </p>
            <p className="mt-2.5 text-sm leading-relaxed text-ink-400">
              Chatting still needs no account. If you cancel, the account goes
              and the free product is exactly what it was.
            </p>
          </section>

          <section className="mt-6">
            <h2 className="font-display text-base font-semibold text-ink-100">
              What filtering does not do
            </h2>
            <p className="mt-2.5 text-sm leading-relaxed text-ink-400">
              Country and language are self-declared and unverified, the same as
              everything else somebody types about themselves here. A filter
              narrows the pool; it does not check that anybody told the truth,
              and it is not a safety feature.
            </p>
            <ul className="mt-3 space-y-1.5">
              {[
                "No age filtering",
                "No location beyond a country you choose",
                "Nothing verified — every field is self-declared",
              ].map((item) => (
                <li
                  key={item}
                  className="flex items-center gap-2 text-sm text-ink-400"
                >
                  <Check
                    className="h-3.5 w-3.5 shrink-0 text-ink-600"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </section>
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
