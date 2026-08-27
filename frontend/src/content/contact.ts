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
  summary: 'How to reach us, and what happens when you do.',
  sections: [
    {
      heading: 'Reporting a conversation? Use Report instead',
      body: [
        'If something happened in a conversation that needs our attention, use the Report button inside that conversation.',
        'It is the fastest and most reliable way to report something because it sends the relevant conversation to us with the report. Reported conversations are retained for 90 days instead of the normal 30-day period, giving us something to review.',
        'An email describing a conversation may not contain enough information for us to identify it, and an unreported conversation may already have been deleted according to our normal retention schedule.',
        'If something is happening now, report it now. You can contact us afterwards if you need to provide additional information.',
      ],
    },
    {
      heading: 'What you can contact us about',
      body: [
        'You can email us about:',
      ],
      bullets: [
        'A problem with the service',
        'A question about how karobakbak works',
        'Privacy or data requests',
        'Premium account or subscription issues',
        'Safety concerns',
        'Legal notices',
        'Accessibility issues',
        'Feedback or suggestions',
        'Anything else concerning how the service is operated',
      ],
      tail: [
        'Feedback is welcome, including criticism. If something is confusing, broken or unnecessarily difficult, tell us.',
      ],
    },
    {
      heading: 'Privacy and data requests',
      body: [
        'For questions about your personal information, including requests to access, correct or delete information, contact us.',
        'If you have a Premium account, contacting us from the email address associated with that account may help us verify your request.',
        'For anonymous free chat, we may not always be able to identify which information belongs to you. That is an intentional consequence of operating the service without requiring an account.',
      ],
    },
    {
      heading: 'If you need to report something serious',
      body: [
        'Use Report inside the conversation whenever possible.',
        'For urgent safety concerns that cannot be reported through the service, email us with enough information for us to understand what happened.',
        'If you believe someone is in immediate physical danger, contact the appropriate emergency service in your location rather than waiting for a response from us.',
      ],
    },
    {
      heading: 'What we cannot do',
      body: [
        'We cannot reconnect you with someone you previously chatted with.',
        'There is no conversation history that lets us find a stranger you talked to, and there is no mechanism for another user to find you again after a conversation ends.',
        'That is intentional. It is part of how the service protects the anonymity of the people using it.',
        'We also cannot tell you what action was taken against another user following a report.',
        'We may investigate a report and take action where appropriate, but we will generally not disclose the outcome or enforcement details to the person who submitted the report. This protects the privacy of everyone involved and helps prevent retaliation.',
      ],
    },
    {
      heading: 'A note about email',
      body: [
        'Email is not required to use free chat.',
        'An email address is required for Premium because Premium requires an account. Your Premium email address is not shown to people you chat with and is not used as your public chat identity.',
        'For free chat, if you want to contact us, you can do so by email without that email becoming part of your chat profile.',
      ],
    },
  ],
};

/**
 * The two commitments the Terms make about a message, as data.
 *
 * They are the reason this page exists in the shape it does — an
 * acknowledgement inside 24 hours and a substantive response inside 15 days —
 * and `pages.test.ts` asserts the Terms and this page still agree. The design
 * puts them at the top as two cards, before anything else, because they are
 * what somebody wants to know before deciding to write at all.
 */
export const CONTACT_SLA: ReadonlyArray<{
  readonly step: string;
  readonly title: string;
  readonly detail: string;
}> = [
  {
    step: 'step one',
    title: 'Acknowledged within 24 hours',
    detail:
      'You will receive an acknowledgement confirming that your message was ' +
      'received. This may be automated and does not mean someone has reviewed ' +
      'it yet.',
  },
  {
    step: 'step two',
    title: 'Response within 15 days',
    detail:
      'Where a response or resolution is required, we aim to respond within ' +
      '15 days. A person handles these requests.',
  },
];
