/**
 * The actionable half of the Contact page: the address, and what happens after
 * you use it.
 *
 * ---------------------------------------------------------------------------
 * THE COMMITMENTS ARE PUBLISHED BECAUSE THEY ARE OWED
 * ---------------------------------------------------------------------------
 * 24 hours to acknowledge, 15 days to resolve. These are not marketing numbers
 * — they are the grievance commitments in the Terms and the Privacy page, and
 * they follow from the rules that apply to a service operated from India. They
 * are shown here because the place somebody actually writes to you is the place
 * they should learn what to expect back.
 *
 * ---------------------------------------------------------------------------
 * THE UNCONFIGURED STATE IS A REAL STATE
 * ---------------------------------------------------------------------------
 * Until there is a domain there is no address, and this renders that plainly
 * instead of a `mailto:` pointing nowhere. An address that bounces is worse
 * than an absent one: the Privacy page promises acknowledgement within a day,
 * and a promise answered by a delivery failure is the version somebody
 * screenshots.
 *
 * It deliberately looks unfinished. It is meant to be noticed before launch.
 */
import { Clock, Mail, ShieldAlert } from 'lucide-react';

import { clientConfig } from '../config';

export function ContactCard(): JSX.Element {
  const address = clientConfig.contactEmail;
  const configured = address !== '';

  return (
    <div className="mb-9">
      {configured ? (
        <a
          href={`mailto:${address}`}
          className="flex items-center gap-3.5 rounded-xl border border-ink-700 bg-ink-900 px-4 py-4 transition-colors hover:border-amber-400/40"
        >
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-amber-400/15 text-amber-400">
            <Mail className="h-5 w-5" aria-hidden="true" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-xs uppercase tracking-wider text-ink-500">Write to us</span>
            <span className="block truncate text-base font-medium text-ink-50">{address}</span>
          </span>
        </a>
      ) : (
        <div className="rounded-xl border border-dashed border-amber-400/40 bg-amber-400/5 px-4 py-4">
          <p className="text-sm font-medium text-amber-300">No contact address published yet.</p>
          <p className="mt-1 text-sm leading-relaxed text-ink-400">
            This site has not launched. There is no address to write to, and we would rather say
            that than publish one nobody is reading.
          </p>
        </div>
      )}

      <dl className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-3 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3.5">
          <Clock className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden="true" />
          <div>
            <dt className="text-sm font-medium text-ink-100">Acknowledged in 24 hours</dt>
            <dd className="mt-0.5 text-xs leading-snug text-ink-500">
              Automated. It confirms your message arrived, nothing more.
            </dd>
          </div>
        </div>

        <div className="flex items-start gap-3 rounded-xl border border-ink-800 bg-ink-900/40 px-4 py-3.5">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-ink-500" aria-hidden="true" />
          <div>
            <dt className="text-sm font-medium text-ink-100">Resolved within 15 days</dt>
            <dd className="mt-0.5 text-xs leading-snug text-ink-500">
              A person, and there is one of them. Usually much sooner.
            </dd>
          </div>
        </div>
      </dl>
    </div>
  );
}
