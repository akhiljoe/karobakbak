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
 * ---------------------------------------------------------------------------
 * THE CONTRACTIONS ARE THE DRAFT'S, AND THEY WERE LOST ONCE
 * ---------------------------------------------------------------------------
 * An earlier transcription expanded every contraction and flattened the curly
 * quotes: "you'll" became "you will", "isn't" became "is not", and the quotes
 * around "Start chatting" became straight ones. Nothing failed and the meaning
 * survived, but the voice did not — the draft is deliberately spoken, and the
 * expanded version reads like terms of service.
 *
 * The header above is not decoration: the draft is the source, so a mismatch
 * means this file is stale. Copy edits belong in `docs/rewrite-wording/`.
 *
 * ---------------------------------------------------------------------------
 * COUNTRY
 * ---------------------------------------------------------------------------
 * Country was briefly dropped from the list of optional details, on the belief
 * that it was resolved from the connection rather than typed. It is not:
 * `profile.ts` accepts a declared `country` and `ProfileFields` renders it
 * beside the name and age, which makes it the fourth declared field and no
 * different from the other three. The draft was right and the word is back.
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
        'Press “Start chatting”.',
        'You’ll first be asked to confirm your age and agree to the Terms, Privacy Policy and Rules. Once you’re ready, you’re in.',
        'You can optionally add a name, age, gender or country before you start. You don’t need to provide any of them to chat.',
      ],
    },
    {
      heading: '02 — Get matched',
      body: [
        'You’re matched with a stranger at random.',
        'There’s no profile to browse and no one to choose. You simply meet whoever is available next.',
        'If the conversation isn’t for you, you can leave and find someone else. You don’t need to explain why.',
      ],
    },
    {
      heading: '03 — Talk',
      body: [
        'Have a conversation in real time.',
        'You can keep it casual, ask questions, disagree, joke around or simply see where the conversation goes. You’re talking to a stranger, so share only what you’re comfortable sharing.',
        'You can Skip at any time. You can also Block someone or Report a conversation if something crosses a line.',
      ],
    },
    {
      heading: 'Three controls, always there',
      body: [
        'Skip ends the conversation and finds you someone else.',
        'Block ends the conversation and prevents that person from being matched with you again.',
        'Report sends a conversation for review when something needs our attention.',
        'These controls give you a way out when a conversation isn’t right. They can’t guarantee that every stranger will behave well — no service can make that promise.',
      ],
    },
    {
      heading: 'What about anonymity?',
      body: [
        'You don’t need an account or a profile to start chatting. Optional profile details are just that: optional.',
        'That doesn’t mean you should assume a stranger knows nothing about you or that everything you say is completely untraceable. Your conversations are with strangers, so treat them that way. Don’t share passwords, financial information, your precise location or anything else you wouldn’t want a stranger to have.',
        'For more on what information the service collects and how it is handled, see our Privacy Policy.',
      ],
    },
    {
      heading: 'What it costs',
      body: [
        'Nothing.',
        'Chatting is free. There’s no signup required to start a conversation.',
      ],
    },
  ],
};
