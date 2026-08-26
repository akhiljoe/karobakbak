/**
 * "How it works".
 *
 * ---------------------------------------------------------------------------
 * THE COPY IS THE OPERATOR'S
 * ---------------------------------------------------------------------------
 * Written in `docs/rewrite-wording/how_it_works.md` and transcribed here rather
 * than paraphrased. If the two ever disagree, the draft is the source and this
 * file is the stale one.
 *
 * One deliberate divergence: the draft offers "a name, age, gender or country"
 * as optional details. Country stopped being one of those — it is resolved from
 * the connection at the upgrade and cannot be set by hand — so the word is
 * dropped here rather than published as an instruction nobody can follow.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PAGE AND NOT A SCROLL
 * ---------------------------------------------------------------------------
 * This material briefly lived as stacked sections below the homepage hero,
 * which turned the one screen this product needs into a long page and buried
 * the only thing the homepage is for.
 *
 * Somebody who wants to understand before pressing anything has a *question*,
 * and a question is answered by a page they chose to open. The homepage answers
 * the other case — somebody who is ready — and those two want opposite layouts.
 */

import type { StaticPage } from './pages';

export const HOW_IT_WORKS: StaticPage = {
  id: 'how-it-works',
  title: 'How it works',
  summary:
    "Talk to someone you've never met. No account, no profile to build, no commitment to stay.",
  sections: [
    {
      heading: '01 — Start',
      body: [
        'Press "Start chatting".',
        'You will first be asked to confirm your age and agree to the Terms, Privacy Policy and ' +
          'Rules. Once you are ready, you are in.',
        'You can optionally add a name, age or gender before you start. You do not need to ' +
          'provide any of them to chat.',
      ],
    },
    {
      heading: '02 — Get matched',
      body: [
        'You are matched with a stranger at random.',
        'There is no profile to browse and no one to choose. You simply meet whoever is ' +
          'available next.',
        'If the conversation is not for you, you can leave and find someone else. You do not ' +
          'need to explain why.',
      ],
    },
    {
      heading: '03 — Talk',
      body: [
        'Have a conversation in real time.',
        'You can keep it casual, ask questions, disagree, joke around or simply see where the ' +
          'conversation goes. You are talking to a stranger, so share only what you are ' +
          'comfortable sharing.',
        'You can Skip at any time. You can also Block someone or Report a conversation if ' +
          'something crosses a line.',
      ],
    },
    {
      heading: 'Three controls, always there',
      body: [
        'Skip ends the conversation and finds you someone else.',
        'Block ends the conversation and prevents that person from being matched with you again.',
        'Report sends a conversation for review when something needs our attention.',
        'These controls give you a way out when a conversation is not right. They cannot ' +
          'guarantee that every stranger will behave well — no service can make that promise.',
      ],
    },
    {
      heading: 'What about anonymity?',
      body: [
        'You do not need an account or a profile to start chatting. Optional profile details are ' +
          'just that: optional.',
        'That does not mean you should assume a stranger knows nothing about you, or that ' +
          'everything you say is completely untraceable. Your conversations are with strangers, ' +
          'so treat them that way. Do not share passwords, financial information, your precise ' +
          'location or anything else you would not want a stranger to have.',
        'For more on what information the service collects and how it is handled, see the ' +
          'Privacy Policy.',
      ],
    },
    {
      heading: 'What it costs',
      body: [
        'Nothing.',
        'Chatting is free. There is no signup required to start a conversation.',
      ],
    },
  ],
};
