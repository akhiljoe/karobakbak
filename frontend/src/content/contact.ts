/**
 * The Contact page's prose.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FIRST THING IT SAYS IS "DO NOT EMAIL US ABOUT ABUSE"
 * ---------------------------------------------------------------------------
 * An email about a bad conversation arrives with no conversation attached. The
 * in-product Report button sends the transcript, extends its retention from 30
 * days to 90, and puts it in the review queue — an email does none of that, and
 * by the time anybody reads it the conversation it describes may already have
 * been deleted on schedule.
 *
 * So the page leads with the faster route and explains why it is faster. A
 * contact page that quietly accepts abuse reports it cannot act on is worse
 * than one that redirects them.
 *
 * The address itself, the response commitments and the "no address yet" state
 * live in `ContactCard.tsx`, because they are the actionable part and this file
 * is only text.
 */

import type { StaticPage } from './pages';

export const CONTACT: StaticPage = {
  id: 'contact',
  title: 'Contact',
  summary: 'How to get in touch, and what to expect back.',
  sections: [
    {
      heading: 'Reporting a conversation? Use Report instead',
      body: [
        'The Report button inside a conversation is the fastest route and the only one that ' +
          'works properly. It sends the conversation itself for review and keeps it for 90 days ' +
          'instead of 30, so there is something to look at.',
        'An email describing a conversation arrives with no conversation attached, and the one ' +
          'it describes may already have been deleted on schedule. If it is happening now, ' +
          'report it now — you can write to us afterwards.',
      ],
    },
    {
      heading: 'What to write about',
      body: [
        'Something broken. A question this site did not answer. A privacy request. A legal ' +
          'notice. Anything about how the service is run.',
        'Feedback is genuinely welcome, including the blunt kind.',
      ],
    },
    {
      heading: 'What we cannot help with',
      body: [
        'We cannot reconnect you with somebody you were talking to. There is no way to find ' +
          'them, by design — no accounts, no history, and nothing that links one conversation ' +
          'to the next. That is the product working as intended, and it is not reversible on ' +
          'request.',
        'We cannot tell you what happened to a report you filed. The person reported is never ' +
          'told who reported them, and that protection only holds if it works in both ' +
          'directions.',
      ],
    },
  ],
};
