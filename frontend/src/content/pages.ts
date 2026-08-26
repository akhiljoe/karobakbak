/**
 * The static pages: About, FAQ, Safety, Rules — and, via `legal.ts`, Terms and
 * Privacy.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS DATA AND NOT SIX COMPONENTS
 * ---------------------------------------------------------------------------
 * There is nothing interactive on any of them. Held as data, the whole set can
 * be checked by a test that has no idea how it is rendered — that every page
 * has a title, that no section is empty, that nothing claims a safeguard the
 * product does not have. That last one is the reason: this copy makes factual
 * claims about retention, moderation and age, and those are the same claims
 * `docs/policies/` makes. If one moves and the other does not, the product is
 * lying in one of two places.
 *
 * ---------------------------------------------------------------------------
 * EVERY CLAIM HERE IS CHECKED AGAINST THE CODE
 * ---------------------------------------------------------------------------
 * Same discipline as the policy drafts, and for a stronger reason: this text
 * reaches every visitor, whereas the policies reach the few who open them.
 *
 *   30 and 90 days      `CONVERSATION_RETENTION_DAYS`, `REPORTED_RETENTION_DAYS`
 *   text only           DESIGN.md §23 — binary frames are rejected outright
 *   no account          there is no account table and no sign-in
 *   asked, not verified `minor-safety-policy.md` §3 chose "exclude and ask"
 *   automated accounts  privacy policy, Terms 3a — disclosed, never denied
 *   one cookie          strictly necessary, and only for blocking
 *   24h / 15 days       the report commitments in the Terms
 *
 * Where the honest answer is unflattering it is written unflattering. A page
 * that oversells a safeguard is worse than no page: it is a false promise made
 * to somebody deciding whether this is safe for them.
 */

import { CONTACT } from './contact';
import { HOW_IT_WORKS } from './how-it-works';
import { LEGAL_PAGES } from './legal';

export interface PageSection {
  readonly heading: string;
  readonly body: readonly string[];
}

export interface StaticPage {
  readonly id: StaticPageId;
  /** Shown in the footer link and as the sheet's title. */
  readonly title: string;
  /** One line under the title. */
  readonly summary: string;
  readonly sections: readonly PageSection[];
}

export type StaticPageId =
  | 'how-it-works'
  | 'about'
  | 'contact'
  | 'faq'
  | 'safety'
  | 'rules'
  | 'terms'
  | 'privacy';

const ABOUT: StaticPage = {
  id: 'about',
  title: 'About',
  summary: 'What karobakbak is, and what it deliberately is not.',
  sections: [
    {
      heading: 'The short version',
      body: [
        'karobakbak pairs you with a stranger at random for a text conversation. There is no ' +
          'signup, no account and no profile that follows you around. If a conversation is not ' +
          'going anywhere, you skip, and you get somebody else.',
        'That is the entire product. Everything below is a consequence of trying to do that ' +
          'one thing honestly.',
      ],
    },
    {
      heading: 'Why it exists',
      body: [
        'Most places online show you people you already know, or people an algorithm decided ' +
          'you should see. Talking to someone chosen at random is a different thing entirely: ' +
          'nobody is performing for an audience, nothing is being scored, and neither of you ' +
          'has a reputation to protect.',
        'Conversations like that used to be ordinary and are now surprisingly rare.',
      ],
    },
    {
      heading: 'Text only, on purpose',
      body: [
        'No photos, no video, no voice. This is not a feature waiting to be built — the server ' +
          'refuses anything that is not text, and that refusal is what keeps the product from ' +
          'becoming something that cannot be moderated properly.',
        'It also means far less can go wrong. Nobody can send you an image you did not ask to ' +
          'see, and nobody can record your face or your voice.',
      ],
    },
    {
      heading: 'Anonymous, and what that actually means',
      body: [
        'We never ask for your name, email address or phone number, and there is nothing to ' +
          'sign in to. The name, age, gender and country you can enter before a chat are a ' +
          'label you choose to show, typed by you and checked by nobody. They are not kept ' +
          'once your session ends — your browser re-sends them each time.',
        'To the person you are talking to, you are anonymous and unfindable afterwards. To us, ' +
          'not entirely: we hold the conversation for a limited period so abuse can be ' +
          'investigated. We would rather be exact about that than claim something warmer and ' +
          'less true.',
      ],
    },
    {
      heading: 'Some partners are automated',
      body: [
        'Occasionally the stranger you are matched with is one of our automated accounts ' +
          'rather than a person. They exist because a random chat service with nobody in it is ' +
          'not a service.',
        'They will never claim to be human. Ask one directly whether it is a bot and it will ' +
          'not tell you it is a person. What you say in those conversations is sent to the ' +
          'company that generates the replies, which does not happen in any other conversation.',
        'We would rather say this here than let you find out.',
      ],
    },
    {
      heading: 'Adults only',
      body: [
        'You must be 18 or over. We ask, and we do not verify — which is a real limitation and ' +
          'not one we are going to dress up as a safeguard. A gate that implied it had checked ' +
          'would be worse than no gate, because it would manufacture confidence in the person ' +
          'who passed it.',
        'If you are under 18, this is not for you.',
      ],
    },
    {
      heading: 'What it will not become',
      body: [
        'No feed. No followers. No streaks, no points, no reason to come back tomorrow other ' +
          'than wanting to. Nothing here is designed to be hard to leave.',
        'Some things may arrive later — they will arrive as this page changing, not as a ' +
          'surprise.',
      ],
    },
  ],
};

const FAQ: StaticPage = {
  id: 'faq',
  title: 'FAQ',
  summary: 'The questions people actually ask.',
  sections: [
    {
      heading: 'Do I need an account?',
      body: ['No. There is nothing to sign up for and nothing to sign in to. Press start and talk.'],
    },
    {
      heading: 'Is it free?',
      body: [
        'Yes, entirely. Nothing is paywalled and there is no subscription. If a donation link ' +
          'is shown anywhere it is optional and changes nothing about the service.',
      ],
    },
    {
      heading: 'Is it really anonymous?',
      body: [
        'To the person you are talking to, yes — they are told nothing about you that you did ' +
          'not type yourself, and they cannot find you again afterwards.',
        'To us, not entirely. We hold your conversation for a limited period so that abuse can ' +
          'be investigated, and we keep a one-way fingerprint of your network address so that ' +
          'blocks and bans work. Neither of those is a name, and neither can be turned back ' +
          'into one.',
      ],
    },
    {
      heading: 'How long are my messages kept?',
      body: [
        'Thirty days, then deleted automatically. If somebody reports a conversation, that one ' +
          'is kept for ninety days instead so there is time to review it.',
        'Deletion is a scheduled job rather than a promise — and if it fails, an alert fires.',
      ],
    },
    {
      heading: 'Who can read my conversation?',
      body: [
        'Nobody, unless it is reported — with one exception, which is a conversation with one ' +
          'of our automated accounts.',
        'Every read is written to an audit record before the content is fetched. The system is ' +
          'built so that a read which was not recorded does not happen at all.',
      ],
    },
    {
      heading: 'Can I send photos or video?',
      body: [
        'No. Text only, and the server rejects anything else outright. There is no upload ' +
          'button because there is nothing behind it.',
      ],
    },
    {
      heading: 'How do I get rid of someone?',
      body: [
        'Skip moves you on immediately. Block does that and makes sure you are never matched ' +
          'with them again. Report sends the conversation to be reviewed.',
        'The other person is never told which you chose — a block looks exactly like a skip ' +
          'from their side.',
      ],
    },
    {
      heading: 'Can I get back to a conversation I left?',
      body: [
        'No, and that is deliberate. There is no history, no way to search for somebody you ' +
          'talked to, and no way for them to find you. Once a conversation ends it is over.',
      ],
    },
    {
      heading: 'Am I talking to a bot?',
      body: [
        'Sometimes. Our automated accounts never claim to be human, and if you ask directly ' +
          'they will not tell you they are a person.',
      ],
    },
    {
      heading: 'Why did nobody reply?',
      body: [
        'Usually because the other person skipped, closed the tab, or lost their connection. ' +
          'It is not personal — most conversations here end quickly and that is normal.',
      ],
    },
    {
      heading: 'Do you use cookies?',
      body: [
        'One, and only so that blocking works. No analytics, no advertising identifiers, and ' +
          'nothing loaded into your browser from any other company — not even fonts.',
      ],
    },
    {
      heading: 'Why can I not use it from Europe or the UK?',
      body: [
        'We do not serve the EEA or the UK. That is a deliberate choice about which rules a ' +
          'one-person service can properly meet, not a technical limitation.',
      ],
    },
    {
      heading: 'Is there a minimum age?',
      body: [
        'Eighteen. We ask and we do not check, which we say plainly rather than implying ' +
          'otherwise.',
      ],
    },
    {
      heading: 'Something went wrong. Who do I tell?',
      body: [
        'Use Report inside the conversation — that is the fastest route and it preserves the ' +
          'conversation for review. For anything else, the contact address is in the footer.',
      ],
    },
  ],
};

const SAFETY: StaticPage = {
  id: 'safety',
  title: 'Safety',
  summary: 'What we do, what you can do, and where the limits are.',
  sections: [
    {
      heading: 'Three controls, always available',
      body: [
        'Skip ends the conversation now. Block ends it and prevents that person being matched ' +
          'with you again. Report sends it to a reviewer.',
        'Block sits in the conversation header rather than behind a menu, because a safe ' +
          'action buried three taps deep is one most people never take.',
      ],
    },
    {
      heading: 'You never owe a stranger an explanation',
      body: [
        'Leaving is free and nobody is told why. There is no penalty for skipping, no ' +
          'reputation to protect, and nobody sees a record of how many conversations you ' +
          'ended.',
        'If something feels off, that feeling is enough. Go.',
      ],
    },
    {
      heading: 'What we check automatically',
      body: [
        'Messages pass through rules that run on our own servers — not an outside service. ' +
          'They catch some things and miss others, and they are a floor rather than a ceiling.',
        'Automated accounts have additional limits applied between the model and the ' +
          'connection, so they cannot be talked around by anything a user types.',
      ],
    },
    {
      heading: 'Things worth doing',
      body: [
        'Do not share your real name, phone number, address, workplace, school, social handles ' +
          'or anything that identifies where you are. Nobody here needs them.',
        'Be careful with details that seem harmless on their own. A city, a job and an age ' +
          'together are often enough to find somebody.',
        'Nobody legitimate will pressure you to move the conversation to another app, and ' +
          'nobody legitimate will ask you for money, a gift card, or a photo.',
      ],
    },
    {
      heading: 'Common patterns worth recognising',
      body: [
        'Someone who wants to leave the platform immediately, before any real conversation has ' +
          'happened.',
        'Someone who escalates quickly — unusually intense affection, urgency, or a crisis ' +
          'that needs your help right now.',
        'Someone who asks a lot about you and answers almost nothing about themselves.',
        'Someone who reacts to a boundary by pushing harder. A person who takes "no" badly the ' +
          'first time will take it worse the second.',
      ],
    },
    {
      heading: 'If somebody appears to be a child',
      body: [
        'Report it. Reports of this kind are treated as the most serious thing this service ' +
          'receives, and the conversation is preserved before anything else happens to it.',
        'Do not try to handle it yourself, and do not warn the other person.',
      ],
    },
    {
      heading: 'If you are struggling',
      body: [
        'A stranger on a chat site is not a crisis service, and neither are we. If you are in ' +
          'danger or thinking about harming yourself, please contact your local emergency ' +
          'number or a crisis line where you live.',
        'Talking to somebody random can help. It is not a substitute for help that is actually ' +
          'trained.',
      ],
    },
    {
      heading: 'What we cannot do',
      body: [
        'We cannot verify that anybody is who they say they are, including their age. We ' +
          'cannot see a conversation that was never reported. Anything you send can be copied ' +
          'or screenshotted by the person receiving it, and nothing here prevents that.',
        'Assume anything you type could be kept by the other person for ever, because it can.',
      ],
    },
  ],
};

const RULES: StaticPage = {
  id: 'rules',
  title: 'Rules',
  summary: 'Short, and all of it enforced.',
  sections: [
    {
      heading: 'The one with no second chance',
      body: [
        'Nothing sexual involving anyone under 18, in any form, including text. This is ' +
          'reported to the authorities and the conversation is preserved. There is no warning ' +
          'and no appeal.',
      ],
    },
    {
      heading: 'Do not harass anyone',
      body: [
        'No threats, no stalking, no sexual content aimed at somebody who has not welcomed it, ' +
          'no slurs, no pile-on after somebody has said stop.',
        'Flirting is fine between adults who are both enjoying it. Continuing after a no is ' +
          'not flirting.',
      ],
    },
    {
      heading: 'Do not use this to sell, recruit or scam',
      body: [
        'No advertising, no links to your shop, no crypto, no investment tips, no "I can make ' +
          'you money". No recruiting for anything, including causes you believe in.',
      ],
    },
    {
      heading: 'Do not try to identify or track anyone',
      body: [
        'Do not attempt to work out who somebody is, find them elsewhere, or share anything ' +
          'about them outside this service. The whole product rests on the fact that a ' +
          'conversation here cannot follow you.',
      ],
    },
    {
      heading: 'Do not break the service',
      body: [
        'No automation, no flooding, no attempts to work around rate limits, blocks or bans.',
      ],
    },
    {
      heading: 'What happens when a rule is broken',
      body: [
        'Sessions are ended and access is blocked, temporarily or permanently depending on ' +
          'what happened. The most serious category is reported to the authorities and the ' +
          'evidence is preserved first.',
        'You will not usually be told that somebody reported you, and the person who reported ' +
          'you is never told what happened. That protects them.',
      ],
    },
  ],
};

/** Every static page, in the order the footer lists them. */
export const STATIC_PAGES: readonly StaticPage[] = [
  HOW_IT_WORKS,
  ABOUT,
  FAQ,
  SAFETY,
  RULES,
  CONTACT,
  ...LEGAL_PAGES,
];

export function pageById(id: StaticPageId): StaticPage {
  const found = STATIC_PAGES.find((page) => page.id === id);
  if (found === undefined) throw new Error(`no static page "${id}"`);
  return found;
}
