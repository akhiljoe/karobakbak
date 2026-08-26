/**
 * Terms and Privacy, as pages inside the product.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS TEXT COMES FROM, AND WHAT IT IS NOT
 * ---------------------------------------------------------------------------
 * `docs/policies/terms-of-service.md` and `privacy-policy.md` are the source of
 * truth. They are **not** publishable as they stand, and not because they are
 * unfinished: they interleave the operative text with `DRAFTED POSITION` blocks
 * that are notes addressed to the operator — arguments for and against a
 * position, and the triggers that would reopen it. Shipping them verbatim would
 * publish internal deliberation to every visitor.
 *
 * So this is the operative half, rewritten for somebody who is about to talk to
 * a stranger rather than for somebody deciding policy. **Every position here is
 * one the drafts already took.** Nothing new is decided in this file, and if a
 * position changes it changes in `docs/policies/` first and here second.
 *
 * ---------------------------------------------------------------------------
 * THE GAPS ARE DELIBERATE AND MUST STAY VISIBLE
 * ---------------------------------------------------------------------------
 * Some facts are the operator's and are not known yet: a contact address, a
 * publication date. The drafts hold them as `{{TEMPLATE_VARIABLES}}` on the
 * rule that plausible-looking false detail in a legal document is worse than an
 * obvious gap — an invented support address is a promise to answer mail nobody
 * is reading, and the Privacy Policy separately commits to a 24-hour
 * acknowledgement.
 *
 * `unset()` renders those as a visible marker rather than a fake. It looks
 * wrong on the page **on purpose**: it is meant to be noticed before launch,
 * not to pass for finished. Anything driven by configuration fills in as soon
 * as the environment has it.
 *
 * ---------------------------------------------------------------------------
 * NOT LEGAL ADVICE, AND SECTIONS 10 AND 11 ARE UNREVIEWED
 * ---------------------------------------------------------------------------
 * `PHASES.md` records the trade deliberately: liability and governing law are
 * drafted and marked unreviewed rather than left empty, because an unreviewed
 * clause a court strikes out leaves the operator where an empty one would have,
 * and an empty one gets there with certainty. That reasoning is the operator's
 * to revisit with counsel; this file only renders it.
 */

import { clientConfig } from '../config';
import type { StaticPage } from './pages';

/** A fact only the operator holds, and does not hold yet. */
function unset(what: string): string {
  return `[${what} — not published yet]`;
}

const contact = clientConfig.contactEmail !== '' ? clientConfig.contactEmail : unset('contact address');

const TERMS: StaticPage = {
  id: 'terms',
  title: 'Terms',
  summary: 'The agreement between you and this service. Plain language, deliberately.',
  sections: [
    {
      heading: 'Who you are agreeing with',
      body: [
        `karobakbak is run by one person, as a sole proprietor in India. There is no company ` +
          `behind it and no support department. You can reach the operator at ${contact}.`,
        'By using the service you accept these terms. If you do not, do not use it.',
      ],
    },
    {
      heading: 'You must be 18 or over',
      body: [
        'This service is for adults. We ask you to confirm your age and we do not verify it — ' +
          'a self-declared age is a requirement, not a check, and we would rather say that ' +
          'plainly than let the gate imply something it does not do.',
        'If you are under 18, you are not permitted to use this service. If we have reason to ' +
          'believe an account is being used by a minor, we end the session and preserve the ' +
          'conversation for review.',
      ],
    },
    {
      heading: 'Some conversation partners are automated',
      body: [
        'Not every stranger you are matched with is a person. Some are automated accounts run ' +
          'by us. They will never claim to be human, and if you ask them directly whether they ' +
          'are a bot they will not tell you they are a person.',
        'What you type in one of those conversations is sent to the company whose model ' +
          'generates the replies. That does not happen in any other conversation. The Privacy ' +
          'page sets out who that is and what they are permitted to do with it.',
      ],
    },
    {
      heading: 'What you agree not to do',
      body: [
        'Do not send sexual content involving minors, or anything that sexualises a child, in ' +
          'any form. This is the one rule with no tolerance and no warning, and it is reported ' +
          'to the authorities.',
        'Do not harass, threaten, stalk or impersonate anyone. Do not send content that is ' +
          'unlawful where you are or where we are. Do not use the service to advertise, ' +
          'recruit, scam, or solicit money.',
        'Do not attempt to identify, track or re-find another user outside the service. Do not ' +
          'attempt to break, overload or work around the technical limits of the service.',
      ],
    },
    {
      heading: 'Reporting, blocking and enforcement',
      body: [
        'You can skip, block or report anyone, at any time, with no explanation. The other ' +
          'person is never told which of the three you chose — a block is indistinguishable ' +
          'from a skip on their side.',
        'When something is reported we may read that conversation. Every read is recorded ' +
          'before the content is retrieved. If we find a breach of these terms we may end ' +
          'sessions and block access, temporarily or permanently.',
      ],
    },
    {
      heading: 'How quickly we respond',
      body: [
        'We acknowledge a report within 24 hours and aim to resolve it within 15 days. ' +
          'Acknowledgement is automated; resolution is a person, and that person is the ' +
          'operator.',
        'These are commitments, not aspirations, and they follow from the rules that apply to ' +
          'a service operated from India.',
      ],
    },
    {
      heading: 'What you write stays yours',
      body: [
        'You keep whatever rights you have in what you type. You give us permission to ' +
          'transmit it to the person you are talking to, and to store it for the limited ' +
          'period described on the Privacy page so that abuse can be investigated.',
        'We do not sell it, publish it, or use it to train anything.',
      ],
    },
    {
      heading: 'The service comes as it is',
      body: [
        'There is no guarantee of availability, of finding a match, or that any particular ' +
          'conversation will be pleasant. This is a free service run by one person; it will ' +
          'sometimes be down, and features may change or disappear.',
        'We do not screen people before they are matched with you. Automated rules catch some ' +
          'things and miss others.',
      ],
    },
    {
      heading: 'Ending access',
      body: [
        'You can stop using the service at any time by closing the tab. There is no account to ' +
          'delete, because there is no account.',
        'We may end a session or block access where these terms have been broken.',
      ],
    },
    {
      heading: 'Liability',
      body: [
        'To the extent the law allows, our liability to you is limited to the greater of what ' +
          'you have paid us — which is nothing, as the service is free — or ₹1,000.',
        'Nothing here limits liability that cannot lawfully be limited, including under ' +
          'consumer protection law.',
        'This clause has not been reviewed by a lawyer.',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        'These terms are governed by the law of India, and the courts of India have ' +
          'jurisdiction. If mandatory consumer protection law where you live gives you rights ' +
          'that this cannot override, it does not override them.',
        'This clause has not been reviewed by a lawyer.',
      ],
    },
    {
      heading: 'Changes',
      body: [
        'If these terms change materially we will say so in the product at least 14 days ' +
          'before the change takes effect. Continuing to use the service after that means you ' +
          'accept the new version.',
      ],
    },
    {
      heading: 'Grievance officer',
      body: [
        `Grievance Officer: ***REMOVED***, reachable at ${contact}. Complaints are acknowledged ` +
          'within 24 hours and we aim to resolve them within 15 days.',
      ],
    },
  ],
};

const PRIVACY: StaticPage = {
  id: 'privacy',
  title: 'Privacy',
  summary: 'What is collected, how long it is kept, and who can see it.',
  sections: [
    {
      heading: 'The short version',
      body: [
        'We do not know who you are. We never ask for a name, an email address, a phone ' +
          'number or a password, and there is no account to create.',
        'We do keep the conversation itself for a limited period, so that abuse can be ' +
          'investigated. That is the honest trade and the rest of this page explains it.',
      ],
    },
    {
      heading: 'Who is responsible',
      body: [
        `The service is operated by one person as a sole proprietor in India, reachable at ` +
          `${contact}.`,
      ],
    },
    {
      heading: 'What we actually hold',
      body: [
        'The messages in your conversation, for a limited period.',
        'A one-way fingerprint of your network address. It cannot be turned back into your ' +
          'address, and it exists so that blocking and banning work — without it, anyone you ' +
          'blocked would reach you again on their next connection.',
        'Anything you chose to type into the optional profile — a name, age, gender, country. ' +
          'None of it is verified, none of it is kept once your session ends, and your browser ' +
          're-sends it each time.',
        'Nothing else. No GPS, no contacts, no device fingerprint, no advertising identifier.',
      ],
    },
    {
      heading: 'Conversations with automated accounts',
      body: [
        'When your partner is one of our automated accounts, what you send in that ' +
          'conversation is transmitted to the company whose model writes the replies, along ' +
          'with a description of the character it is playing.',
        'This happens only in those conversations. We require terms that forbid that company ' +
          'training on what we send.',
      ],
    },
    {
      heading: 'How long things are kept',
      body: [
        'Conversations: 30 days, then deleted automatically.',
        'Conversations that were reported: 90 days, so there is time to review them.',
        'Reports and moderation records: 90 days. Records of access by a reviewer: one year.',
        'Encrypted database backups: seven daily copies, with the oldest removed as a new one ' +
          'is taken.',
        'Deletion is a scheduled job, not a promise. If it fails, an alert fires.',
      ],
    },
    {
      heading: 'Who can read your conversation',
      body: [
        'Nobody, unless it was reported — with one exception, which is a conversation with an ' +
          'automated account.',
        'Every read is written to an audit record before the content is fetched, in the same ' +
          'transaction. The system is built so that a read which was not recorded does not ' +
          'happen at all.',
      ],
    },
    {
      heading: 'Cookies and third parties',
      body: [
        'One cookie, and only so that blocking works.',
        'The site makes no requests to any other company from your browser. No analytics, no ' +
          'trackers, no advertising, not even external fonts. If you follow a link away from ' +
          'the site — to a donation page, for example — you are then on their site under their ' +
          'terms.',
      ],
    },
    {
      heading: 'Your rights, and an honest limitation',
      body: [
        'You have rights over personal data about you, including asking for a copy or asking ' +
          'for it to be deleted.',
        'The limitation is real: we hold nothing that identifies you, so we usually cannot ' +
          'find "your" data on request. Asking us to delete your conversations would require ' +
          'you to prove which ones were yours, and there is nothing you could show us that ' +
          'would. This is a consequence of the anonymity, not an excuse for avoiding the ' +
          'obligation.',
        'Conversations delete themselves on the schedule above whether or not anybody asks.',
      ],
    },
    {
      heading: 'Where the data is',
      body: [
        'Hosted in India, with encrypted backups kept in India as well. There is no ' +
          'cross-border transfer of conversation data to disclose.',
        'We do not serve the EEA or the UK.',
      ],
    },
    {
      heading: 'Changes to this page',
      body: [
        'If this changes materially we will say so in the product at least 14 days before it ' +
          'takes effect.',
      ],
    },
    {
      heading: 'Contact',
      body: [
        `Privacy questions and anything about this page: ${contact}.`,
        `Grievance Officer: ***REMOVED***. Complaints acknowledged within 24 hours, resolution ` +
          `aimed at within 15 days.`,
      ],
    },
  ],
};

/** The two legal pages, in footer order. */
export const LEGAL_PAGES: readonly StaticPage[] = [TERMS, PRIVACY];
