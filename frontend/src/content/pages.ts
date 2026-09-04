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
import { FAQ } from './faq';
import { HOW_IT_WORKS } from './how-it-works';
import { LEGAL_PAGES } from './legal';

export interface PageSection {
  readonly heading: string;
  /** Paragraphs, in order, before any list. */
  readonly body: readonly string[];
  /**
   * Items the drafts set as a list — the prohibitions on Rules, the topics on
   * Contact.
   *
   * Held apart from `body` rather than as more paragraphs because the designs
   * set them as tiles, and a renderer cannot tell a one-line paragraph from a
   * list item by looking at it. `SitePage` renders them as an ordinary list, so
   * a page that never gets a bespoke layout still shows everything.
   */
  readonly bullets?: readonly string[];
  /** Paragraphs that come after the list. */
  readonly tail?: readonly string[];
  /**
   * A second list, after `tail`.
   *
   * ---------------------------------------------------------------------------
   * WHY A SECOND LIST EXISTS RATHER THAN "ONE LIST IS ENOUGH"
   * ---------------------------------------------------------------------------
   * One section in the Privacy draft has two: what deleting a Premium account
   * removes, and — after a "however" — what it does not. With only one list
   * available the transcription concatenated them, so the page told the reader
   * that deletion removes their tax, fraud-prevention and legal records, and
   * then said it might not. That is the opposite of what the draft says, and it
   * is the kind of error a data model produces rather than a writer: nothing was
   * misread, there was simply nowhere to put the second list.
   *
   * Renderers must show it. A template that silently drops it would reintroduce
   * exactly the failure it was added to fix.
   */
  readonly tailBullets?: readonly string[];
  /**
   * A two-column table: the first row is the header.
   *
   * ---------------------------------------------------------------------------
   * BECAUSE A TAB IS NOT A TABLE
   * ---------------------------------------------------------------------------
   * The retention schedule arrived from the draft as fourteen tab-separated
   * lines and was transcribed into `body` as fourteen paragraphs. HTML collapses
   * a tab to a single space, so the published page read "Ordinary conversations
   * 30 days" — fourteen times, with no columns, no header and no alignment. It
   * was legible only to somebody who already knew it was meant to be a table.
   *
   * Held as pairs so a renderer can put it in columns and a test can still read
   * the values back.
   */
  readonly rows?: readonly (readonly [string, string])[];
}

export interface StaticPage {
  readonly id: StaticPageId;
  /**
   * A standfirst under the summary, where a page has one.
   *
   * Only Rules does. It is the sentence that scopes everything below it — that
   * the rules bind anonymous users too — and it belongs to the page rather than
   * to any numbered section, which is exactly how the draft and the design set
   * it.
   */
  readonly intro?: string;
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
        'karobakbak pairs you with a stranger at random for a conversation.',
        'There is no signup, no account and no profile to build. Start a chat, talk to whoever ' +
          'you meet, and leave whenever you want. If the conversation is not going anywhere, ' +
          'skip and meet someone else.',
        'That simplicity is the point.',
      ],
    },
    {
      heading: 'Why it exists',
      body: [
        'Most of the internet is built around people you already know, people you follow, or ' +
          'people an algorithm thinks you might like.',
        'karobakbak is built around something different: talking to someone you have never met.',
        'There is no audience watching your conversation.',
        'No follower count.',
        'No feed to maintain.',
        'No reputation to build.',
        'Just two strangers and a conversation.',
        'Sometimes it will be interesting. Sometimes it will be awkward. Sometimes it will last ' +
          'thirty seconds.',
        'That is part of the idea.',
      ],
    },
    {
      heading: 'Text only, on purpose',
      body: [
        'karobakbak is currently built around text conversations.',
        'Keeping the experience focused on text makes the product simpler and gives us fewer ' +
          'types of content to deal with. It also means you can have a conversation without ' +
          'sharing your face, your voice or an image of yourself.',
        'We may add other ways to communicate in the future. If we do, we will explain what ' +
          'changes and what it means for you.',
      ],
    },
    {
      heading: 'Anonymous, with an important distinction',
      body: [
        'You do not need to give us your name, email address or phone number to use the free ' +
          'chat service.',
        'You can optionally choose a name, age, gender or country to share with the person you ' +
          'are matched with. Those details are self-declared — nobody verifies them.',
        'But anonymous does not mean invisible.',
        'Like any online service, karobakbak may process technical information and conversation ' +
          'data for purposes such as operating the service, preventing abuse and responding to ' +
          'reports.',
        'We would rather be precise about that than make a bigger promise than the product can ' +
          'keep.',
      ],
    },
    {
      heading: 'Some conversations are with automated accounts',
      body: [
        'Not every stranger you meet is a person. Some are automated accounts run by us, and ' +
          'they exist because a random chat service with nobody in it is not a service.',
        'They will never claim to be human. Ask one directly whether it is a bot and it will ' +
          'not tell you it is a person.',
        'What you type in one of those conversations is sent to the company whose model writes ' +
          'the replies. That happens in no other conversation, and the Privacy page sets out ' +
          'who that is and what they may do with it.',
        'We would rather say this here than let you find out.',
      ],
    },
    {
      heading: 'Adults only',
      body: [
        'You must be 18 or over to use karobakbak.',
        'We ask you to confirm your age, but that confirmation does not verify your identity or ' +
          'prove your age.',
        'If you are under 18, please do not use the service.',
      ],
    },
    {
      heading: 'What it is not',
      body: [
        'No feed.',
        'No followers.',
        'No streaks.',
        'No points.',
        'No pressure to stay.',
        'Nothing here is designed to make leaving difficult.',
        'The product is deliberately small: meet a stranger, have a conversation, and leave ' +
          'when you want.',
        'That is karobakbak.',
      ],
    },
  ],
};

/*
 * FAQ now lives in `content/faq.ts`.
 *
 * Moved out when it gained its own layout: the page renders as a grouped
 * accordion (`FaqPage.tsx`) and needs grouping, default-open and verdict
 * metadata that no other page has. Keeping that beside the copy is the same
 * arrangement `how-it-works.ts` already uses.
 *
 * It stays in `STATIC_PAGES` below, so the footer, the nav and the page tests
 * still see it as one of the documents.
 */

/*
 * Safety.
 *
 * The draft is the source; this file is the stale one whenever they disagree,
 * and `pages.test.ts` holds it to that.
 */
const SAFETY: StaticPage = {
  id: 'safety',
  title: 'Safety',
  summary: 'Talking to strangers can be interesting, funny and unexpected. It can also go wrong.',
  intro:
    'Here' + '’' + 's what we do to give you control, what you can do to protect ' +
    'yourself, and what we cannot guarantee.',
  sections: [
    {
      heading: 'Three controls, always available',
      body: [
      ],
      bullets: [
        'Skip ends the conversation and finds you someone else.',
        'Block ends the conversation and prevents that person from being matched with you again.',
        'Report sends the conversation to our team for review.',
      ],
      tail: [
        'You do not need to explain why you left. If a conversation makes you uncomfortable, leave it.',
      ],
    },
    {
      heading: 'You never owe a stranger an explanation',
      body: [
        'You can end a conversation at any time.',
        'There is no penalty for skipping, and you do not need the other person\'s permission to leave.',
        'If something feels wrong, that is enough. You can leave first and work out the reason later.',
      ],
    },
    {
      heading: 'Protect your personal information',
      body: [
        'Remember that you are talking to a stranger.',
        'Do not share things such as:',
      ],
      bullets: [
        'Your password or login details',
        'Bank or payment information',
        'Your home address',
        'Your phone number',
        'Your workplace or school',
        'Your precise location',
        'Private social-media accounts',
        'Personal information that could be used to identify or locate you',
      ],
      tail: [
        'Be careful with details that seem harmless individually. Your age, city, workplace and other small details can become identifying when put together.',
        'And once you send something, you cannot control what the recipient does with it. They can copy, save or screenshot what you send.',
      ],
    },
    {
      heading: 'Watch for common warning signs',
      body: [
        'Be cautious if someone:',
      ],
      bullets: [
        'Pushes you to move the conversation to another app immediately',
        'Asks for money, gift cards or financial information',
        'Tries to get personal information from you while revealing very little about themselves',
        'Becomes intensely affectionate or threatening very quickly',
        'Creates a crisis and pressures you to solve it',
        'Ignores your boundaries or keeps pushing after you say no',
        'Pressures you to send something you are uncomfortable sharing',
      ],
      tail: [
        'You do not need to prove that someone is dangerous before you leave. Skip or Block them and, if appropriate, Report the conversation.',
      ],
    },
    {
      heading: 'If somebody appears to be a child',
      body: [
        'Do not engage with them about sexual or otherwise inappropriate content.',
        'Report the conversation and leave it. Do not attempt to investigate, identify or confront the person yourself.',
      ],
    },
    {
      heading: 'If you are in immediate danger',
      body: [
        'karobakbak is not an emergency or crisis service.',
        'If you or someone else is in immediate danger, contact the appropriate emergency service where you live.',
        'If you are struggling or thinking about harming yourself, contact a crisis service or qualified professional in your area. A conversation with a stranger may feel helpful, but it is not a substitute for professional support.',
      ],
    },
    {
      heading: 'What we do — and what we cannot do',
      body: [
        'We provide tools to help you leave conversations, block people and report behaviour that concerns you.',
        'We also take reports seriously and use them to help us identify behaviour that violates our rules.',
        'But there are limits.',
        'We cannot guarantee that a stranger is who they say they are. We cannot verify everything someone tells you, including their age. We cannot prevent someone from copying or saving something you send them.',
        'We also cannot see or act on a conversation that is never reported to us.',
        'So treat every conversation accordingly:',
        'You are talking to a stranger. Share carefully. Trust your instincts. Leave when you want to.',
      ],
    },
  ],
};

/*
 * The Rules.
 *
 * This page used to be six paraphrased sections. The draft has fourteen, and
 * `RulesPage.dc.html` lays out all fourteen. The short version was dropping the
 * specific prohibitions — advertising, de-anonymisation, service misuse — and
 * the whole enforcement half, which is the part somebody reads when they are
 * deciding whether to report. `pages.test.ts` checks it against the draft.
 *
 * The draft ends section 14 with a `[CONTACT EMAIL]` placeholder, and it is
 * deliberately not reproduced: the address is configuration
 * (`VITE_CONTACT_EMAIL`), and `RulesPage` renders that, or a link to Contact
 * when it is unset. A literal placeholder here would ship an address that
 * bounces, which is worse than none.
 */
const RULES: StaticPage = {
  id: 'rules',
  title: 'Rules',
  summary: 'Short enough to read. Clear enough to enforce.',
  intro:
    'karobakbak is a place to talk to strangers, not a place where anything ' +
    'goes. These rules apply to everyone, including people using the service ' +
    'anonymously.',
  sections: [
    {
      heading: 'No sexual content involving anyone under 18',
      body: [
        'This is the one rule with no second chance.',
        'Do not create, request, send, solicit, encourage or facilitate sexual content involving a person under 18, including sexualized text or attempts to sexualize a minor.',
        'If we become aware of conduct involving suspected child sexual exploitation or abuse, we may preserve relevant information and make reports to the appropriate authorities where required or permitted by law.',
        'We may also immediately end the session and permanently restrict access.',
        'There is no warning for this category.',
      ],
    },
    {
      heading: 'Do not harass, threaten or abuse people',
      body: [
        'Do not:',
      ],
      bullets: [
        'Threaten someone with violence or harm.',
        'Stalk, intimidate or repeatedly target another person.',
        'Continue contacting someone after they have clearly asked you to stop.',
        'Direct unwanted sexual content at someone.',
        'Use slurs or targeted hateful abuse.',
        'Deliberately humiliate, degrade or intimidate someone.',
        'Encourage others to target or harass someone.',
      ],
      tail: [
        'Flirting between consenting adults is allowed.',
        'Continuing after someone says no, asks you to stop, or clearly indicates they are uncomfortable is not flirting.',
        'You do not have to justify leaving a conversation, and neither does anyone else.',
      ],
    },
    {
      heading: 'Do not exploit, scam or deceive people',
      body: [
        'Do not use karobakbak to:',
      ],
      bullets: [
        'Scam or defraud people.',
        'Solicit money, gifts or financial assistance through deception.',
        'Promote fraudulent investments or financial schemes.',
        'Impersonate someone for the purpose of deceiving another person.',
        'Phish for passwords, payment information or account credentials.',
        'Run advance-fee, romance or other scams.',
        'Distribute malicious links or software.',
        'Manipulate someone into giving you access to their accounts or property.',
      ],
      tail: [
        'If someone asks you for money, financial credentials or valuable personal information, treat that as a warning sign.',
      ],
    },
    {
      heading: 'Do not advertise or recruit',
      body: [
        'Do not turn random conversations into a marketing channel.',
        'This includes:',
      ],
      bullets: [
        'Advertising products or services.',
        'Spam.',
        'Referral schemes.',
        'Promotional links.',
        'Recruiting customers.',
        'Recruiting employees or participants.',
        'Recruiting people for financial schemes.',
        'Recruiting for organizations, campaigns or causes.',
      ],
      tail: [
        'A genuine conversation is fine. Using the service primarily to reach strangers for promotional or recruitment purposes is not.',
      ],
    },
    {
      heading: 'Do not try to identify, locate or expose another user',
      body: [
        'Do not use information obtained through karobakbak to identify or locate another person.',
        'Do not:',
      ],
      bullets: [
        'Try to discover their real name.',
        'Look for their social-media accounts.',
        'Track their physical location.',
        'Investigate their identity outside the service.',
        'Publish their personal information.',
        'Share their personal information with someone else.',
        'Pressure them into revealing identifying information.',
      ],
      tail: [
        'The approximate country or region displayed by the service is not an invitation to determine someone\'s actual location.',
        'What someone tells you in a conversation belongs to that conversation.',
        'Do not use it to follow them elsewhere.',
      ],
    },
    {
      heading: 'Do not misuse the service',
      body: [
        'Do not interfere with the operation or security of karobakbak.',
        'This includes:',
      ],
      bullets: [
        'Flooding or spamming the service.',
        'Deliberately creating excessive load.',
        'Using unauthorized automation or bots.',
        'Scraping users or conversations.',
        'Circumventing technical restrictions.',
        'Attempting to bypass rate limits.',
        'Circumventing blocks or bans.',
        'Creating methods to evade enforcement.',
        'Attempting to gain unauthorized access.',
        'Testing or exploiting vulnerabilities without permission.',
        'Interfering with another user\'s connection or session.',
      ],
      tail: [
        'If you find a security vulnerability, report it rather than exploiting it.',
      ],
    },
    {
      heading: 'Do not send prohibited or unlawful content',
      body: [
        'Do not use the service to distribute content that is unlawful or that you do not have the right to distribute.',
        'This includes content used to facilitate:',
      ],
      bullets: [
        'Serious criminal activity;',
        'Fraud;',
        'Exploitation;',
        'Extortion;',
        'Malware or unauthorized access;',
        'Non-consensual sexual abuse;',
        'Child sexual exploitation; or',
        'Other unlawful conduct.',
      ],
      tail: [
        'We may remove content or restrict access where necessary to comply with law or protect users and the service.',
      ],
    },
    {
      heading: 'Do not pretend the rules do not apply because the chat is anonymous',
      body: [
        'Being anonymous does not make you exempt from the rules.',
        'We may take action based on conduct even if we do not know your real-world identity.',
        'We may use technical information reasonably available to us to enforce restrictions and prevent repeated abuse.',
      ],
    },
    {
      heading: 'Use the controls when you need them',
      body: [
        'You have three simple options:',
      ],
      bullets: [
        'Skip — leave the conversation and move on.',
        'Block — leave the conversation and prevent that person from being matched with you again.',
        'Report — send the conversation to us for review.',
      ],
      tail: [
        'You do not need to prove that someone broke a rule before reporting them. If something is seriously wrong or you are unsure what to do, report it.',
        'Do not attempt to punish, expose or investigate the other person yourself.',
      ],
    },
    {
      heading: 'What happens when a rule is broken',
      body: [
        'Depending on what happened, we may:',
      ],
      bullets: [
        'End the conversation;',
        'Remove access temporarily;',
        'Permanently block access;',
        'Restrict particular features;',
        'Preserve relevant information;',
        'Investigate related activity; or',
        'Take other action reasonably necessary to protect the service and its users.',
      ],
      tail: [
        'The response depends on the seriousness of the conduct, the available evidence, previous enforcement history and applicable law.',
        'We do not promise that every violation will be detected. Automated systems, user reports and human review all have limitations.',
      ],
    },
    {
      heading: 'Serious safety matters',
      body: [
        'For particularly serious conduct, including suspected child sexual exploitation or other serious unlawful activity, we may preserve relevant information and report it to appropriate authorities where required or permitted by law.',
        'We may do this without warning the person involved.',
        'We may also be unable to tell you exactly what action was taken against another user. Protecting the privacy and safety of the person who reported something may require us to keep that information confidential.',
      ],
    },
    {
      heading: 'Reports are not a popularity contest',
      body: [
        'Do not misuse the reporting system to deliberately target people simply because you dislike them.',
        'False, malicious or abusive reports may themselves result in enforcement action.',
        'At the same time, you will not be punished simply because someone reports you. A report is a reason to review something, not automatic proof that a rule was broken.',
      ],
    },
    {
      heading: 'Enforcement is not a promise of perfect safety',
      body: [
        'These rules describe what is prohibited. They are not a guarantee that nobody will break them.',
        'We cannot screen every person before they enter a conversation, and no moderation system catches everything.',
        'You should still use your judgment.',
        'If a conversation feels wrong, you can leave. You do not owe a stranger an explanation.',
      ],
    },
    {
      heading: 'Appeals',
      body: [
        'If you believe we made a mistake in restricting your access, you may contact us to request a review.',
        'We may not reverse every decision, particularly where doing so could compromise safety, reveal information about another user, undermine an investigation, or create a risk of repeated abuse.',
        'For serious enforcement decisions, we will review the relevant information available to us and make a decision in accordance with our policies and applicable law.',
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
