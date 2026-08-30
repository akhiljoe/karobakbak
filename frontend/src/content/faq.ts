/**
 * The FAQ.
 *
 * ---------------------------------------------------------------------------
 * THE COPY IS THE OPERATOR'S
 * ---------------------------------------------------------------------------
 * Written in `docs/rewrite-wording/FAQs` and transcribed here rather than
 * paraphrased. If the two disagree, the draft is the source and this file is
 * the stale one — the same relationship `how-it-works.ts` has with its draft.
 *
 * ---------------------------------------------------------------------------
 * TWO ANSWERS DEPART FROM THE DRAFT, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Both are recorded here rather than fixed quietly, because a reader comparing
 * the two files should find the reason rather than a discrepancy.
 *
 *  1. **"Am I talking to a bot?"** The draft answers "No. karobakbak does not
 *     use bots." Terms §3a says the opposite in published text: automated
 *     accounts exist, and the Terms commit to never denying it. A page that
 *     denies something the service does is a false statement rather than a weak
 *     position, and this document set has already made one of those once. The
 *     draft is also internally inconsistent on the point — its own answer to
 *     "Who can read my conversation?" describes conversations with automated
 *     accounts.
 *
 *  2. **"Is my location shared with strangers?"** The draft answers "No", and
 *     describes country as a Premium preference the user supplies. Neither is
 *     what the code does: `server.ts` resolves the country from the connection
 *     at the upgrade (`clientCountry`, the CDN's `CF-IPCountry`), discards
 *     whatever the client sent, and puts it on the profile the partner sees. It
 *     is automatic, it is derived from the network address, and it is shown.
 *
 * The retention answer also keeps the concrete figures rather than deferring to
 * the Privacy Policy as the draft does. `pages.test.ts` asserts them against
 * `CONVERSATION_RETENTION_DAYS` and `REPORTED_RETENTION_DAYS`, which is what
 * keeps this copy honest when a default moves.
 */

import type { StaticPage } from './pages';

/**
 * The four groups, and which questions sit in each.
 *
 * Presentation, so it lives beside the copy rather than inside `FAQ` — the
 * generic `StaticPage` shape has no notion of a group, and giving it one would
 * mean every other page carrying a field only this one uses.
 *
 * Membership is by heading text. That is a string match, which is fragile in
 * general and safe here for one reason: `pages.test.ts` already forbids two
 * sections of a page sharing a heading, because headings are React keys. A
 * heading is therefore a unique id that happens to be readable, and
 * `faq.test.ts` fails if one named here stops existing.
 */
export interface FaqGroup {
  /** Set as a small mono rule above the questions. */
  readonly label: string;
  /** Headings from `FAQ.sections`, in the order the design sets them. */
  readonly questions: readonly string[];
  /**
   * The last group is amber rather than muted.
   *
   * Not decoration: it is the group somebody reaches when something has gone
   * wrong, and the design gives it the only accent on the page so it is
   * findable while scanning rather than only while reading.
   */
  readonly accent?: boolean;
}

export const FAQ_GROUPS: readonly FaqGroup[] = [
  {
    label: 'the basics',
    questions: [
      'Do I need an account?',
      'Is it free?',
      'Is there a minimum age?',
      'Can I send photos or videos?',
      'Do you use cookies?',
    ],
  },
  {
    label: 'anonymity & data',
    questions: [
      'Is it anonymous?',
      'How long are conversations kept?',
      'Who can read my conversation?',
      'Is my location shared with strangers?',
      'Can strangers see my IP address?',
      'Can I delete my information?',
    ],
  },
  {
    label: 'who you meet',
    questions: [
      'Am I talking to a bot?',
      'How does matching work?',
      'Can the other person find me again?',
      'Can I get back to a conversation I left?',
      'Why did nobody reply?',
    ],
  },
  {
    label: 'when something goes wrong',
    accent: true,
    questions: [
      'What should I do if someone makes me uncomfortable?',
      'How do I get rid of someone?',
      'What happens when I report someone?',
      'Something went wrong. Who do I tell?',
    ],
  },
];

/**
 * The two questions that start open.
 *
 * Twenty answers open at once is a wall, and twenty closed is a page that looks
 * like it says nothing. The design opens the most-asked question and the one
 * that matters most — so somebody who arrives frightened does not have to find
 * the right row before they get an answer.
 */
export const FAQ_OPEN_BY_DEFAULT: readonly string[] = [
  'Do I need an account?',
  'What should I do if someone makes me uncomfortable?',
];

/**
 * The verdict line, where an answer has one.
 *
 * The draft answers several questions with a word before it qualifies —
 * "No.", "Yes. Chatting is free." — and the design sets that first line large
 * so the answer lands before the caveat. Listed by heading rather than guessed
 * from the text: a heuristic like "short first paragraph" would catch answers
 * that are merely brief, which reads as shouting.
 */
export const FAQ_VERDICT_FIRST: readonly string[] = [
  'Do I need an account?',
  'Is it free?',
  'Can I send photos or videos?',
  'Am I talking to a bot?',
  'Can I get back to a conversation I left?',
  'Is there a minimum age?',
  'Can strangers see my IP address?',
  'What should I do if someone makes me uncomfortable?',
];

export const FAQ: StaticPage = {
  id: 'faq',
  title: 'FAQ',
  summary: 'The questions people actually ask.',
  sections: [
    {
      heading: 'Do I need an account?',
      body: [
        'No.',
        'You can start chatting without creating an account or signing in. Just press Start and ' +
          'follow the age and terms confirmation.',
        'Premium is different: Premium requires an account to manage the subscription.',
      ],
    },
    {
      heading: 'Is it free?',
      body: [
        'Yes. Chatting is free.',
        'You do not need a subscription to use the core service.',
        'Premium features, when available, are optional and do not change the free experience.',
      ],
    },
    {
      heading: 'Is there a minimum age?',
      body: [
        'Yes. You must be at least 18 to use karobakbak.',
        'We ask you to confirm your age, but we do not claim that this confirmation verifies ' +
          'your age or identity.',
      ],
    },
    {
      heading: 'Can I send photos or videos?',
      body: [
        'No.',
        'The chat currently supports text messages only. Photos, videos and other file uploads ' +
          'are not supported.',
      ],
    },
    {
      heading: 'Do you use cookies?',
      body: [
        'The service may use cookies, local storage or similar browser technologies where ' +
          'necessary to operate features such as blocking or maintaining your session.',
        'We do not want to imply that the service uses no technical storage at all. For the ' +
          'complete list of technologies used and their purposes, see our Privacy Policy.',
      ],
    },
    {
      heading: 'Is it anonymous?',
      body: [
        'You do not need to give us your name or create a profile to chat.',
        'The person you are talking to only knows what you choose to tell them. They are not ' +
          'given your account details or other information about you through the chat.',
        'That does not mean you should assume that nothing about your use of the service can ' +
          'be associated with you. We may collect technical information and retain conversation ' +
          'data for purposes such as operating the service, safety and abuse prevention.',
        'See our Privacy Policy for exactly what we collect and how long we keep it.',
      ],
    },
    {
      heading: 'How long are conversations kept?',
      body: [
        'Thirty days, then deleted automatically. If somebody reports a conversation, that one ' +
          'is kept for ninety days instead so there is time to review it.',
        'We retain conversation data for a limited period so that reports and abuse can be ' +
          'investigated.',
        'If you report a conversation, additional retention may apply where necessary for ' +
          'review or other legitimate purposes.',
      ],
    },
    {
      heading: 'Who can read my conversation?',
      body: [
        'Conversations are not routinely read by people.',
        'Access may be necessary when a conversation is reported or otherwise requires review ' +
          'for safety, moderation or abuse-prevention purposes.',
        'Conversations with our automated accounts are different: messages are sent to the ' +
          'provider whose model generates the replies. See our Privacy Policy for more ' +
          'information about how those conversations are handled.',
      ],
    },
    {
      /*
       * Departs from the draft. See the note at the top of this file: the
       * country is resolved from the connection and shown to the partner, so
       * "no location is shown" would be false.
       */
      heading: 'Is my location shared with strangers?',
      body: [
        'Your country is, and nothing more precise than that.',
        'When a country is shown beside your partner it is worked out from the network you are ' +
          'connecting through, not from anything you typed. Yours is worked out the same way ' +
          'and shown to them. There is no setting for it, and it is never more specific than ' +
          'the country.',
        'Nothing else about where you are is shared. You should still avoid telling strangers ' +
          'where you live, work or are currently located.',
      ],
    },
    {
      heading: 'Can strangers see my IP address?',
      body: [
        'No. Your IP address is not displayed to the person you are chatting with.',
        'Like most internet services, technical information may still be processed by the ' +
          'service to operate and protect the platform. See the Privacy Policy for details.',
      ],
    },
    {
      heading: 'Can I delete my information?',
      body: [
        'You do not need an account to use the free chat service.',
        'Some information is retained for limited periods for purposes such as safety, abuse ' +
          'prevention and legal obligations. The applicable retention and deletion rules are ' +
          'described in our Privacy Policy.',
        'If you have a specific privacy or data request, contact us using the details on the ' +
          'Contact page.',
      ],
    },
    {
      /*
       * Departs from the draft, which answers "No". Terms §3a discloses
       * automated accounts and commits to never denying them.
       */
      heading: 'Am I talking to a bot?',
      body: [
        'Sometimes.',
        'When nobody is available to match you with, we may match you with an automated account ' +
          'that we run. It will never claim to be a person, and it will never ask you for your ' +
          'real name, your photograph, your contact details, or to meet or talk somewhere else.',
        'Everyone else you meet here is another user. Someone may claim to be a bot or use a ' +
          'bot of their own, and that is something they are telling you about themselves rather ' +
          'than something we have done.',
      ],
    },
    {
      heading: 'How does matching work?',
      body: [
        'You are matched with someone at random from the people currently available to chat.',
        'There is no profile browsing and no requirement to choose someone before you start.',
        'Premium may allow you to narrow your matching pool by options such as gender, country ' +
          'and language. Those details are self-declared and are not verified.',
      ],
    },
    {
      heading: 'Can the other person find me again?',
      body: [
        'There is no friends list or profile search.',
        'Blocking also prevents the person you blocked from being matched with you again.',
        'You should still avoid sharing information that could allow someone to identify or ' +
          'contact you elsewhere.',
      ],
    },
    {
      heading: 'Can I get back to a conversation I left?',
      body: [
        'No.',
        'There is no conversation history for you to browse or search, and there is no feature ' +
          'for reconnecting with someone you previously chatted with.',
      ],
    },
    {
      heading: 'Why did nobody reply?',
      body: [
        'They may have skipped, closed the chat, lost their connection or simply stopped ' +
          'responding.',
        'Conversations between strangers often end without explanation. It is usually not worth ' +
          'taking personally.',
      ],
    },
    {
      heading: 'What should I do if someone makes me uncomfortable?',
      body: ['Leave the conversation.'],
      bullets: [
        'Skip if you simply want to move on.',
        'Block if you do not want to be matched with that person again.',
        'Report if their behaviour violates the Rules or needs our attention.',
      ],
      tail: ['You never owe a stranger an explanation for leaving.'],
    },
    {
      heading: 'How do I get rid of someone?',
      body: ['You have three options:'],
      bullets: [
        'Skip ends the conversation and finds you someone else.',
        'Block ends the conversation and prevents that person from being matched with you again.',
        'Report sends the conversation to us for review.',
      ],
      tail: ['You do not need to explain why you chose any of them.'],
    },
    {
      heading: 'What happens when I report someone?',
      body: [
        'The conversation is submitted for review and may be retained as necessary for that ' +
          'review.',
        'We use reports to investigate behaviour that may violate our Rules and to take ' +
          'appropriate action where the service allows it.',
        'If there is an immediate threat of real-world harm, contact the appropriate emergency ' +
          'service in your area rather than relying on a report to us.',
      ],
    },
    {
      heading: 'Something went wrong. Who do I tell?',
      body: [
        'If the problem involves another person or something that happened in a conversation, ' +
          'use Report inside the chat.',
        'For technical problems, privacy requests, Premium or other support matters, use the ' +
          'contact details provided on the Contact page.',
      ],
    },
  ],
};
