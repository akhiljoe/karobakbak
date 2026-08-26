/**
 * "How it works" — the page the homepage used to be.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A PAGE AND NOT A SCROLL
 * ---------------------------------------------------------------------------
 * This material — the three steps, what is different about it, the safety
 * controls — briefly lived as stacked sections below the homepage hero. That
 * turned the one screen this product needs into a long scroll, and it buried
 * the only thing the homepage is for, which is the button.
 *
 * A visitor who wants to understand the product before pressing anything is a
 * visitor with a *question*, and a question is answered by a page they choose
 * to open. The homepage answers the other case — somebody who is ready — and
 * those two audiences want opposite layouts.
 *
 * So: hero on the homepage, everything else one click up in the header.
 */

import type { StaticPage } from './pages';

export const HOW_IT_WORKS: StaticPage = {
  id: 'how-it-works',
  title: 'How it works',
  summary: 'What happens when you press the button, and what it costs you.',
  sections: [
    {
      heading: '01 — Start',
      body: [
        'Press "Start chatting". There is nothing to sign up for, nothing to install, and no ' +
          'permission to grant. It runs in the browser you already have.',
        'You can add a name, age, gender or country first if you want to. All four are optional, ' +
          'none is checked, and they are gone when your session ends.',
      ],
    },
    {
      heading: '02 — Match',
      body: [
        'You are paired with another person at random. Not an algorithm choosing who you should ' +
          'meet, not somebody who saw your profile — whoever is next.',
        'Sometimes it is one of our automated accounts rather than a person. They never claim to ' +
          'be human, and what you say in those conversations is sent to the company whose model ' +
          'writes the replies. That happens in no other conversation.',
      ],
    },
    {
      heading: '03 — Talk',
      body: [
        'Text only, in real time. No photos, no voice, no video — the server refuses anything ' +
          'that is not text.',
        'When you are done, or if it is not going anywhere, you skip and get somebody else. You ' +
          'never owe a stranger an explanation.',
      ],
    },
    {
      heading: 'What makes it different',
      body: [
        'No signup and no account. There is nothing to create and nothing to delete.',
        'Nothing to install — it runs in the browser you already have.',
        'You can leave at any time. One tap, and no explanation owed to anyone.',
        'Conversations delete themselves: 30 days, or 90 if somebody reports one.',
      ],
    },
    {
      heading: 'Three controls, always there',
      body: [
        'Skip ends the conversation now and finds you somebody else.',
        'Block ends it and makes sure that person is never matched with you again.',
        'Report sends the conversation to be reviewed, and keeps it for 90 days so there is ' +
          'something to look at.',
        'These are controls you hold. They are not a promise that a stranger will behave — no ' +
          'site can make that promise, and we are not going to pretend otherwise.',
      ],
    },
    {
      heading: 'What it costs',
      body: [
        'Nothing. The whole product is free and nothing that exists today will move behind a ' +
          'payment.',
      ],
    },
  ],
};
