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
  title: 'Terms of Service',
  summary: 'The agreement between you and this service.',
  sections: [
    {
      heading: 'Overview',
      body: [
        'Last updated: 7 September 2026',
        'Effective from: 7 September 2026',
        'These Terms of Service (“Terms”) govern your access to and use of karobakbak (“karobakbak”, “we”, “us” or “our”).',
        'Please read them carefully. They explain what the service is, what you can expect from us, what we expect from you, and the circumstances in which we may restrict or end your access.',
        'By accessing or using karobakbak, you agree to these Terms, our Rules, and our Privacy Policy. If you do not agree to them, you must not use the service.',
        'These Terms are written in plain language, but they are intended to be legally binding.',
      ],
    },
    {
      heading: 'Who operates karobakbak',
      body: [
        'karobakbak is operated by:',
        /*
          The registered enterprise, never the individual (register row 19, and
          the operator's instruction of 2026-09-04).

          This replaced "Operator: [operator name — not published yet]", which
          was a blank waiting for a person's name — the one fact that is not
          going to be filled in here. What waits in the gap now is a
          registration number, which is verifiable by anyone with standing to
          ask and printed on nobody's screen.

          It keeps the `[...]` shape deliberately: `pages.test.ts` skips a
          rendered gap when it checks that this page transcribes the draft
          rather than paraphrasing it, and a line without one would have to be
          added to the legal draft first. This says no more than the draft's own
          opening sentence already does.
        */
        'Legal name: ***REMOVED*** C Joe, sole proprietor, trading as karobakbak',
        'Udyam Registration Number: ***REMOVED***',
        'Business structure: Sole proprietorship registered in India',
        'Country: India',
        `Email: ${contact}`,
        'Phone: ***REMOVED***',
        'Principal place of business: not published while karobakbak is free to use. Our email address and phone number above are the contact details for all purposes.',
        'If any of these details change, we may update this section without changing the substance of these Terms.',
      ],
    },
    {
      heading: 'About the service',
      body: [
        'karobakbak is an online service that allows users to have conversations with strangers.',
        'The core service allows you to:',
      ],
      bullets: [
        'Start a conversation without creating an account.',
        'Be matched with another available user at random.',
        'Exchange text messages.',
        'End a conversation and move on to another match.',
        'Block another user.',
        'Report a conversation or user to us.',
      ],
      tail: [
        'The service may change over time. We may add, remove, modify or discontinue features.',
        'We do not guarantee that every feature will always be available or that the service will always operate without interruption.',
      ],
    },
    {
      heading: 'Eligibility',
      body: [
        'You must be at least 18 years old to use karobakbak.',
        'By using the service, you represent that:',
      ],
      bullets: [
        '1. You are at least 18 years old;',
        '2. You are legally capable of entering into these Terms; and',
      ],
      tail: [
        '3. Your use of the service does not violate any law or restriction applicable to you.',
        'We ask users to confirm their age before starting a conversation. That confirmation is a self-declaration. It is not an identity or age-verification process.',
        'If you are under 18, you must not use karobakbak.',
        'If we have reason to believe that a person using the service is under 18, we may terminate the session, restrict access and take other appropriate measures.',
      ],
    },
    {
      heading: 'Accepting these Terms',
      body: [
        'You accept these Terms when you access or use karobakbak.',
        'Before starting a conversation, you may also be required to confirm your age and acknowledge our Terms, Privacy Policy and Rules.',
        'If you do not agree with any of these documents, you must leave the service and stop using it.',
      ],
    },
    {
      heading: 'Random matching',
      body: [
        'karobakbak is designed around random matching.',
        'When you start a conversation, you are matched with another available user according to the matching system used by the service.',
        'You do not select the person you are matched with, and the other person does not select you.',
        'Information a user provides about themselves, including their name, age, gender or country, is self-declared and should not be assumed to be accurate or verified.',
        'You should treat people you meet on karobakbak as strangers.',
      ],
    },
    {
      heading: 'Optional information',
      body: [
        'You may be able to provide optional information such as:',
      ],
      bullets: [
        'Name;',
        'Age;',
        'Gender; and',
        'Country.',
      ],
      tail: [
        'You do not need to provide these details to use the core chat service.',
        'Any information you provide about yourself should be treated as information you have chosen to disclose to another person.',
        'You should not provide personal information that you are not comfortable sharing with a stranger.',
        'Our Privacy Policy explains how information provided to karobakbak is collected, used, retained and deleted.',
      ],
    },
    {
      heading: 'Your responsibility when communicating with strangers',
      body: [
        'You are responsible for deciding what information to share with another user.',
        'You should not assume that another user is who they claim to be.',
        'Do not share information such as:',
      ],
      bullets: [
        'Passwords;',
        'Banking or payment information;',
        'Security codes;',
        'Home addresses;',
        'Precise location;',
        'Private contact details;',
        'Workplace or school details;',
        'Information that could be used to identify or locate you; or',
        'Any other information you would not want a stranger to have.',
      ],
      tail: [
        'Anything you voluntarily send to another user may be copied, saved, recorded, photographed, screenshotted or shared by that person.',
        'We cannot control what another user does with information you voluntarily provide to them.',
      ],
    },
    {
      heading: 'Skip, Block and Report',
      body: [
        'karobakbak provides three primary controls for dealing with conversations.',
      ],
    },
    {
      heading: 'Skip',
      body: [
        'Skip ends your current conversation and allows you to find another match.',
        'You do not need to explain why you skipped someone.',
      ],
    },
    {
      heading: 'Block',
      body: [
        'Block ends the current conversation and prevents the blocked person from being matched with you again, subject to the technical operation of the service.',
        'Blocking is not a guarantee against every possible form of contact outside karobakbak.',
      ],
    },
    {
      heading: 'Report',
      body: [
        'Report allows you to submit a conversation or user behaviour to us for review.',
        'Reports may be used to investigate potential violations of these Terms or our Rules and to determine whether further action is appropriate.',
        'You should use Report where you believe someone has violated the Rules, threatened or harassed you, attempted to exploit you, or otherwise engaged in behaviour that requires our attention.',
      ],
    },
    {
      heading: 'Our Rules',
      body: [
        'Our Rules form part of these Terms.',
        'They explain the behaviour that is prohibited on karobakbak and provide practical guidance for using the service responsibly.',
        'You must comply with both these Terms and the Rules.',
        'If there is a conflict between these Terms and the Rules, these Terms will control unless the relevant section expressly states otherwise.',
      ],
    },
    {
      heading: 'Prohibited conduct',
      body: [
        'You must not use karobakbak to:',
      ],
    },
    {
      heading: 'Harm or threaten people',
      body: [
      ],
      bullets: [
        'Threaten another person with physical or other serious harm.',
        'Harass, intimidate, bully or repeatedly target another person.',
        'Stalk or attempt to monitor another person.',
        'Encourage another person to harm themselves or someone else.',
        'Use the service to facilitate real-world harm.',
      ],
    },
    {
      heading: 'Sexual exploitation and abuse',
      body: [
      ],
      bullets: [
        'Sexually exploit or abuse a child.',
        'Request, create, distribute, possess or solicit child sexual abuse material.',
        'Sexualise children or encourage sexual activity involving children.',
        'Use the service to facilitate sexual exploitation or trafficking.',
        'Share intimate material involving another person without appropriate consent.',
      ],
    },
    {
      heading: 'Privacy and identification',
      body: [
      ],
      bullets: [
        'Attempt to identify another user against their wishes.',
        'Attempt to discover another user\'s private identity or location.',
        'Publish or distribute another person\'s private information maliciously.',
        'Use information obtained from karobakbak to stalk, threaten, harass or harm another person.',
        'Attempt to circumvent another user\'s Block.',
      ],
    },
    {
      heading: 'Fraud and financial abuse',
      body: [
      ],
      bullets: [
        'Scam or defraud another user.',
        'Impersonate another person for fraudulent or harmful purposes.',
        'Solicit money through deception or manipulation.',
        'Request passwords, financial credentials, security codes or similar sensitive information for fraudulent purposes.',
        'Use karobakbak as part of a fraudulent scheme.',
      ],
    },
    {
      heading: 'Spam and commercial abuse',
      body: [
      ],
      bullets: [
        'Send unsolicited advertising or promotional messages.',
        'Repeatedly send substantially identical messages.',
        'Use the service primarily to recruit users for unrelated services or businesses.',
        'Distribute malicious, deceptive or abusive links.',
        'Use the service for unauthorized commercial solicitation.',
      ],
    },
    {
      heading: 'Technical abuse',
      body: [
      ],
      bullets: [
        'Attempt to gain unauthorized access to the service or its systems.',
        'Probe, scan or test systems for vulnerabilities without authorization.',
        'Circumvent technical restrictions or access controls.',
        'Attempt to bypass a block, ban or other enforcement measure.',
        'Introduce malware or other harmful code.',
        'Interfere with, overload or disrupt the service.',
        'Use automated systems to access the service in ways that are not authorized.',
        'Attempt to reverse engineer or extract protected parts of the service except where applicable law expressly permits it.',
      ],
    },
    {
      heading: 'Illegal activity',
      body: [
      ],
      bullets: [
        'Use the service to facilitate unlawful activity.',
        'Encourage another person to commit a serious offence.',
        'Use the service in a manner that violates applicable law.',
      ],
      tail: [
        'This list is not intended to permit conduct merely because it is not specifically listed. We may take action against behaviour that materially threatens users, the service or the integrity of the platform.',
      ],
    },
    {
      heading: 'Content you submit',
      body: [
        'You retain whatever rights you have in the content you submit through karobakbak.',
        'By submitting content, you grant us the limited rights necessary to operate the service.',
        'This includes the right to:',
      ],
      bullets: [
        'Receive and transmit your messages to the intended conversation participant;',
        'Store and process messages where necessary to operate the service;',
        'Review reported content where necessary for safety, moderation, abuse prevention or enforcement;',
        'Preserve information where necessary for legitimate safety, legal or security purposes; and',
        'Process content as otherwise described in our Privacy Policy.',
      ],
      tail: [
        'This permission does not transfer ownership of your content to us.',
        'We do not claim ownership of ordinary messages merely because you send them through karobakbak.',
      ],
    },
    {
      heading: 'Content you encounter',
      body: [
        'You may encounter content that is:',
      ],
      bullets: [
        'Offensive;',
        'Disturbing;',
        'Inaccurate;',
        'Unwanted;',
        'Deceptive;',
        'Sexually explicit;',
        'Abusive; or',
        'Otherwise inappropriate.',
      ],
      tail: [
        'We do not guarantee that you will never encounter prohibited or harmful content.',
        'If you encounter content that violates our Rules, you should leave the conversation and use Report where appropriate.',
      ],
    },
    {
      heading: 'Moderation and enforcement',
      body: [
        'We may use technical systems, reports and human review to identify and address behaviour that violates these Terms or the Rules.',
        'No moderation system is perfect.',
        'We do not guarantee that every violation will be detected, every report will result in enforcement, or every harmful interaction will be prevented.',
        'Depending on the circumstances, we may:',
      ],
      bullets: [
        'End a conversation;',
        'Restrict a user\'s ability to use particular features;',
        'Prevent a user from being matched with another user;',
        'Temporarily suspend access;',
        'Permanently restrict access;',
        'Remove or restrict content where technically and legally appropriate;',
        'Preserve information for safety, legal or enforcement purposes; or',
        'Make disclosures to authorities or other parties where required or permitted by applicable law.',
      ],
      tail: [
        'We may consider reports, technical signals, available information and other relevant circumstances when deciding whether action is appropriate.',
        'We do not have to disclose every detail of our moderation or security systems, because doing so could make those systems easier to evade.',
      ],
    },
    {
      heading: 'Reports',
      body: [
        'When you submit a report, you should provide accurate information and use the reporting system in good faith.',
        'Do not knowingly submit false or malicious reports.',
        'A report does not guarantee that we will agree with the report, take a particular enforcement action, or disclose the outcome to you.',
        'We may limit or take action against users who repeatedly abuse the reporting system.',
        'Where a report involves serious or potentially unlawful conduct, we may take additional steps that we consider appropriate or that applicable law requires.',
      ],
    },
    {
      heading: 'Investigations and access to reported content',
      body: [
        'Where necessary to investigate a report, enforce our Terms or Rules, protect users, or comply with legal obligations, authorized personnel may access relevant information.',
        'Access to sensitive information is subject to our internal controls and applicable policies.',
        'We may retain information relating to a report for as long as reasonably necessary for investigation, enforcement, legal, security or other legitimate purposes, subject to applicable law.',
        'Our Privacy Policy explains our general data-retention practices.',
      ],
    },
    {
      heading: 'Conversation retention',
      body: [
        'Conversations may be retained for a limited period.',
        'Retention exists in part so that reports and abuse can be investigated rather than disappearing before there is an opportunity to review them.',
        'Ordinary conversations are kept for 30 days and then deleted automatically.',
        'Reported conversations are kept for 90 days.',
        'We may retain information for longer where necessary to:',
      ],
      bullets: [
        'Comply with a legal obligation;',
        'Respond to a lawful request;',
        'Investigate abuse or security incidents;',
        'Establish, exercise or defend legal claims;',
        'Preserve evidence;',
        'Protect users or the service; or',
        'Otherwise comply with applicable law.',
      ],
      tail: [
        'Deletion may be performed through automated systems. However, deletion may not be instantaneous in every case, and information may remain in backups or other systems for a limited period subject to the applicable retention and deletion procedures.',
        'The Privacy Policy contains the detailed information about retention and deletion.',
      ],
    },
    {
      heading: 'Privacy',
      body: [
        'Our Privacy Policy explains how we collect, use, disclose, retain and protect information associated with your use of karobakbak.',
        'The Privacy Policy forms part of these Terms.',
        'You should read it before using the service.',
        'Where applicable law gives you rights concerning your personal information, those rights are described in the Privacy Policy.',
      ],
    },
    {
      heading: 'Third-party services',
      body: [
        'karobakbak may rely on third-party service providers to operate parts of the service.',
        'These may include providers for infrastructure, hosting, security, communications, payments, analytics or other technical functions, depending on the services we actually use.',
        'Where third parties process personal information on our behalf, the applicable processing arrangements are described in our Privacy Policy where required.',
        'Third-party services may have their own terms and policies. Where applicable, your use of those third-party services may also be subject to their terms.',
      ],
    },
    {
      heading: 'Intellectual property',
      body: [
        'The karobakbak name, branding, website, software, interface, design, original text, graphics and other materials provided by us are owned by or licensed to us, unless otherwise stated.',
        'We grant you a limited, non-exclusive, non-transferable and revocable right to access and use the service for its intended purpose.',
        'You must not, except where applicable law expressly permits it:',
      ],
      bullets: [
        'Copy or reproduce substantial parts of the service;',
        'Sell, sublicense or commercially exploit the service;',
        'Modify or create derivative works from our software or protected materials;',
        'Attempt to extract source code or protected technical information;',
        'Remove proprietary notices; or',
        'Use our branding in a way that suggests an affiliation or endorsement that does not exist.',
      ],
    },
    {
      heading: 'Your feedback',
      body: [
        'If you voluntarily provide suggestions, ideas or feedback about karobakbak, you agree that we may use that feedback without restriction or payment to you.',
        'You retain ownership of any underlying intellectual property rights you have in the feedback, but you grant us a perpetual, worldwide, royalty-free right to use it to improve, operate or develop the service.',
      ],
    },
    {
      heading: 'Service availability',
      body: [
        'We aim to keep karobakbak available and functioning, but we do not guarantee uninterrupted availability.',
        'The service may occasionally be unavailable because of:',
      ],
      bullets: [
        'Maintenance;',
        'Software or infrastructure failures;',
        'Security incidents;',
        'Network problems;',
        'Third-party service failures;',
        'Changes to the service;',
        'Events outside our reasonable control; or',
        'Other technical or operational reasons.',
      ],
      tail: [
        'We may suspend or restrict access temporarily where necessary to protect users, the service or our infrastructure.',
      ],
    },
    {
      heading: 'No guarantee about other users',
      body: [
        'karobakbak connects you with strangers.',
        'We do not guarantee:',
      ],
      bullets: [
        'A user\'s identity;',
        'A user\'s age;',
        'A user\'s location;',
        'The accuracy of information a user provides;',
        'A user\'s intentions;',
        'A user\'s behaviour;',
        'The quality of a conversation;',
        'That a user will follow our Rules; or',
        'That another user will not copy, save or share something you send.',
      ],
      tail: [
        'You are responsible for deciding whether and how much you want to communicate with another person.',
        'If you are uncomfortable, leave the conversation.',
      ],
    },
    {
      heading: 'No professional or emergency service',
      body: [
        'karobakbak is not a:',
      ],
      bullets: [
        'Crisis service;',
        'Emergency service;',
        'Medical service;',
        'Mental-health service;',
        'Legal service;',
        'Financial advisory service; or',
        'Professional advice service.',
      ],
      tail: [
        'Nothing communicated through the service should be treated as professional advice.',
        'If you or another person is in immediate danger, contact the appropriate emergency service or qualified professional in your area.',
      ],
    },
    {
      heading: 'Suspension and termination by you',
      body: [
        'You can stop using the service at any time.',
        'For the free chat service, you can generally do so simply by leaving the service or closing the browser.',
        'If you have a Premium account or another paid service, separate cancellation terms may apply.',
        'Stopping your use of the service does not necessarily cause information that we are legally or legitimately permitted or required to retain to be deleted immediately.',
      ],
    },
    {
      heading: 'Suspension and termination by us',
      body: [
        'We may suspend, restrict or terminate your access to karobakbak if we reasonably believe that:',
      ],
      bullets: [
        'You have violated these Terms;',
        'You have violated our Rules;',
        'You have engaged in abusive or harmful conduct;',
        'You have attempted to evade an enforcement action;',
        'Your use creates a security or operational risk;',
        'Your use may expose other users or us to legal risk;',
        'You have misused the reporting or blocking systems; or',
        'Restriction is otherwise reasonably necessary to protect users, the service or our legal interests.',
      ],
      tail: [
        'We may also restrict access where required by law or by a lawful order or request.',
        'Where appropriate and legally permissible, we may provide an explanation for an enforcement decision. We are not required to disclose information that would compromise safety, security, privacy, investigations or our ability to enforce these Terms.',
      ],
    },
    {
      heading: 'Appeals and enforcement review',
      body: [
        'If we provide an appeals process for account or access restrictions, the applicable process will be described on the Support or Contact page.',
        'Where no formal appeals process is available, you may contact us using the published contact information if you believe an enforcement decision was made in error.',
        'We may request information necessary to evaluate an appeal.',
      ],
    },
    {
      heading: 'Paid services and Premium',
      body: [
        'The core chat service does not require a paid subscription.',
        'If Premium or another paid feature becomes available, additional terms may apply to that purchase.',
        'Those terms will explain, as applicable:',
      ],
      bullets: [
        'Price;',
        'Billing frequency;',
        'Payment method;',
        'Renewal;',
        'Cancellation;',
        'Refunds;',
        'Features included;',
        'Changes to Premium; and',
        'What happens when a subscription ends.',
      ],
      tail: [
        'Nothing in these Terms should be interpreted as making Premium available before it is actually launched.',
      ],
    },
    {
      heading: 'Payments and refunds',
      body: [
        'Where paid services are offered, payments may be processed by a third-party payment provider.',
        'Payment information may therefore be processed directly by that provider according to its applicable policies.',
        'Any mandatory rights you have under applicable consumer or payment law remain unaffected.',
      ],
    },
    {
      heading: 'Disclaimer of warranties',
      body: [
        'To the maximum extent permitted by applicable law, karobakbak is provided on an “as available” and “as is” basis.',
        'We do not warrant that:',
      ],
      bullets: [
        'The service will always be available;',
        'The service will be error-free;',
        'The service will meet every user\'s expectations;',
        'Matching will always be available;',
        'Information provided through the service will be accurate;',
        'All harmful or prohibited behaviour will be detected;',
        'Every report will result in enforcement; or',
        'The service will be free from security incidents or technical failures.',
      ],
      tail: [
        'Nothing in this section excludes a warranty, right or protection that applicable law does not allow us to exclude.',
      ],
    },
    {
      heading: 'Limitation of liability',
      body: [
        'To the maximum extent permitted by applicable law, we will not be liable for indirect, incidental, special, consequential or punitive losses arising from or related to your use of, or inability to use, karobakbak.',
        'This includes, where legally permitted, losses arising from:',
      ],
      bullets: [
        'The conduct of another user;',
        'Content submitted by another user;',
        'Your decision to share information with another user;',
        'Interruption or unavailability of the service;',
        'Loss or corruption of data;',
        'Security incidents;',
        'Reliance on information obtained through the service; or',
        'Interactions occurring outside karobakbak.',
      ],
      tail: [
        '[This clause has not been reviewed by a lawyer and is not final.]',
        'Nothing in these Terms excludes or limits liability that cannot lawfully be excluded or limited.',
        'Nothing in these Terms limits mandatory consumer rights or other protections that cannot legally be waived.',
      ],
    },
    {
      heading: 'Indemnity',
      body: [
        '[This clause has not been reviewed by a lawyer and is not final.]',
        'To the extent permitted by applicable law, you may be responsible for losses, claims, liabilities and reasonable costs arising from your material breach of these Terms, your unlawful use of the service, or your misuse of the service.',
        'This section does not require you to indemnify us for matters caused by our own unlawful conduct or for liabilities that cannot legally be transferred to you.',
        '[This clause has not been reviewed by a lawyer and is not final.]',
      ],
    },
    {
      heading: 'Governing law',
      body: [
        'These Terms are governed by the laws of India, except to the extent that mandatory laws applicable to you provide otherwise.',
        '[This clause has not been reviewed by a lawyer and is not final.]',
        'Nothing in this section is intended to remove or restrict mandatory rights you may have under the laws that apply to you.',
      ],
    },
    {
      heading: 'Disputes',
      body: [
        'If you have a dispute with us, we encourage you to contact us first so that we have an opportunity to understand and resolve the issue.',
        'You can contact:',
        `Email: ${contact}`,
        '[This clause has not been reviewed by a lawyer and is not final.]',
        'Nothing in this section prevents you from exercising rights that cannot lawfully be restricted.',
      ],
    },
    {
      heading: 'Complaints and grievances',
      body: [
        'For problems involving another user or a specific conversation, the in-product Report function is generally the appropriate channel.',
        'For technical problems, account or Premium matters, privacy requests, legal matters or other service complaints, contact us using the published contact details.',
        'We will handle complaints in accordance with our applicable policies and legal obligations.',
      ],
    },
    {
      heading: 'Changes to the service',
      body: [
        'We may change, improve, suspend or discontinue features of karobakbak.',
        'Changes may be necessary because of:',
      ],
      bullets: [
        'Technical development;',
        'Security requirements;',
        'Changes in user needs;',
        'Changes in law;',
        'Changes to third-party services;',
        'Operational requirements; or',
        'Other legitimate business reasons.',
      ],
      tail: [
        'We do not guarantee that a particular feature will remain available indefinitely.',
      ],
    },
    {
      heading: 'Changes to these Terms',
      body: [
        'We may update these Terms from time to time.',
        'When we make changes, we will update the “Last updated” date at the beginning of the document.',
        'For material changes, we will take reasonable steps to notify users where appropriate and where required by applicable law.',
        'If a change requires your express agreement under applicable law, we will seek that agreement.',
        'Your continued use of the service after revised Terms take effect constitutes acceptance of the revised Terms only to the extent permitted by applicable law.',
        'If you do not agree with revised Terms, you must stop using the service.',
      ],
    },
    {
      heading: 'Privacy Policy and other documents',
      body: [
        'The following documents form part of the rules governing your use of karobakbak:',
      ],
      bullets: [
        'These Terms of Service;',
        'Privacy Policy; and',
        'Rules.',
      ],
      tail: [
        'Additional terms may apply to specific features, including Premium or other paid services.',
        'Where additional terms apply, we will make them available before you use the relevant feature or make the relevant purchase.',
      ],
    },
    {
      heading: 'Severability',
      body: [
        'If any provision of these Terms is determined to be invalid, unlawful or unenforceable, that provision will be enforced to the maximum extent permitted by law.',
        'If it cannot be enforced, it will be treated as removed to the extent necessary.',
        'The remaining provisions will continue to apply.',
      ],
    },
    {
      heading: 'No waiver',
      body: [
        'If we do not immediately enforce a provision of these Terms, that does not mean that we waive our right to enforce it later.',
        'Any waiver must be made in accordance with applicable law.',
      ],
    },
    {
      heading: 'Assignment',
      body: [
        'You may not transfer or assign your rights or obligations under these Terms without our prior written consent, except where applicable law permits otherwise.',
        'We may transfer or assign our rights and obligations in connection with a restructuring, sale, merger, acquisition or transfer of the service, subject to applicable law.',
      ],
    },
    {
      heading: 'Entire agreement',
      body: [
        'These Terms, together with the Privacy Policy, Rules and any applicable feature-specific terms, constitute the agreement between you and us concerning your use of the service, except where applicable law requires otherwise.',
        'They replace earlier versions of the same terms concerning the service.',
      ],
    },
    {
      heading: 'Contact',
      body: [
        'If you have a question about these Terms, contact:',
        'karobakbak',
        // The third of these, and the easiest to miss: a contact block asking
        // for an operator's name beside an email address that already reaches
        // them. The enterprise and its registration answer "who is this",
        // which is the question a reader of a contact block is actually asking.
        'Operator: ***REMOVED*** C Joe, sole proprietor, trading as karobakbak',
        `Email: ${contact}`,
        'Phone: ***REMOVED***',
        'Address: not published while karobakbak is free to use — please use the email address or phone number above.',
        'For privacy-related requests, please see the contact information in the Privacy Policy.',
        'For a specific conversation or user-safety issue, please use the in-product Report function where possible.',
      ],
    },
    {
      heading: 'Effective date',
      body: [
        'Effective from: 7 September 2026',
        'Last updated: 7 September 2026',
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
      heading: 'Overview',
      body: [
        'Privacy Policy',
        'Last updated: 7 September 2026',
        'Effective from: 7 September 2026',
        'karobakbak is designed to let you talk to strangers without creating a conventional account for the free chat service.',
        'Premium is different. A Premium subscription requires an account, and we need an email address to create and manage that account and associate your subscription with you.',
        'This Privacy Policy explains what information we collect, why we collect it, how long we keep it, who may receive it, and the choices and rights available to you.',
      ],
    },
    {
      heading: 'Who is responsible for your data',
      body: [
        'karobakbak is operated by:',
        // Same rule as the Terms above: the enterprise and its registration,
        // not a person. "Legal name: [operator name — not published yet]" was
        // the sharper version of the problem, because it asks by name for
        // exactly the thing that is not going to be published.
        'Legal name: ***REMOVED*** C Joe, sole proprietor, trading as karobakbak',
        'Role: Data Fiduciary under the Digital Personal Data Protection Act, 2023',
        'Business structure: Sole proprietorship registered in India',
        'Country: India',
        `Email: ${contact}`,
        'Phone: ***REMOVED***',
        'Address: not published while karobakbak is free to use — please use the email address or phone number above.',
        'In this Privacy Policy, “karobakbak”, “we”, “us” and “our” refer to the operator of the service.',
      ],
    },
    {
      heading: 'The short version',
      body: [
        'There are two different ways you can use karobakbak.',
        'Free chat',
        'You can use the free chat service without creating an account or providing an email address.',
        'We nevertheless process certain technical information necessary to operate and protect the service, including your IP address.',
        'We also use your IP address to estimate your approximate country or region. A broad location may be shown to the person you are chatting with.',
        'Premium',
        'Premium requires an account.',
        'To create a Premium account, we collect your email address and use it to identify your Premium account, authenticate you, manage your subscription and communicate with you about your subscription where necessary.',
        'Your Premium account is separate from the anonymous identity you use when chatting.',
        'Your email address is not shown to people you chat with.',
        'Your Premium account does not turn the free chat service into a profile-based social network.',
      ],
    },
    {
      heading: 'Information we collect',
      body: [
        'The information we process depends on how you use karobakbak.',
      ],
    },
    {
      heading: 'Information required for free chat',
      body: [
        'When you use the free chat service, we process information necessary to establish the connection and operate the conversation.',
        'This may include:',
      ],
      bullets: [
        'Messages you send and receive;',
        'IP address;',
        'Connection information;',
        'Session information;',
        'Security and abuse-prevention information;',
        'Information associated with blocks and reports; and',
      ],
      tail: [
        'Optional information you choose to provide.',
        'You do not need to provide an email address to use free chat.',
      ],
    },
    {
      heading: 'Premium account information',
      body: [
        'Premium requires an account.',
        'When you create a Premium account, we collect:',
      ],
      bullets: [
        'Email address;',
        'Authentication information necessary to operate the account;',
        'Account creation and login information;',
        'Subscription status;',
        'Subscription-related dates and events; and',
      ],
      tail: [
        'Other information necessary to provide Premium.',
        'We may also receive information from the payment provider necessary to determine whether your subscription is active, cancelled, expired or otherwise changed.',
        'We do not need to receive or store your full payment-card details if payment processing is handled by a third-party payment provider.',
        'There is no payment provider today, because nothing is for sale. This section will name the provider before anything can be bought.',
      ],
    },
    {
      heading: 'Why Premium requires an email address',
      body: [
        'Premium is the one part of karobakbak that requires an account.',
        'We need an account identifier so that we can:',
      ],
      bullets: [
        'Create your Premium account;',
        'Let you sign in again;',
        'Recognize your subscription;',
        'Associate Premium entitlements with your account;',
        'Process subscription changes;',
        'Help recover access to your account;',
        'Send essential account or subscription communications; and',
      ],
      tail: [
        'Respond to account-related requests.',
        'We use your email address for these purposes.',
        'Your email address is not required to start or continue using free chat.',
      ],
    },
    {
      heading: 'Your Premium account is separate from your chats',
      body: [
        'The email address associated with your Premium account is not displayed to the people you chat with.',
        'Premium account information is also not intended to become a public profile.',
        'Your subscription account and your conversation identity serve different purposes:',
        'Premium account',
      ],
      bullets: [
        'Email address;',
        'Authentication;',
        'Subscription;',
        'Conversation;',
        'Optional information you choose to show;',
      ],
      tail: [
        'Billing-related status.',
        'Chat',
        'Technical information necessary to operate and protect the service.',
        'We do not need to display your email address to another user in order to provide Premium matching.',
        '7. Is Premium completely disconnected from your conversations?',
        'We should be precise here.',
        'Your email address is not shown to your conversation partner, and we do not use your email as your public chat identity.',
        'However, because Premium and chat are both services operated by us, technical systems may necessarily be able to associate certain activity with your Premium account where required to provide Premium features, prevent abuse, enforce restrictions, maintain security, or comply with law.',
        'We therefore do not promise that Premium creates an absolute technical separation between every piece of information we hold.',
        'What we can promise is that your email address is not exposed to strangers as part of ordinary chat.',
      ],
    },
    {
      heading: 'IP address and connection information',
      body: [
        'When you connect to karobakbak, our servers receive your IP address as part of normal internet communication.',
        'We may use your IP address for purposes including:',
      ],
      bullets: [
        'Operating the service;',
        'Establishing connections;',
        'Preventing abuse;',
        'Detecting suspicious activity;',
        'Enforcing blocks and bans;',
        'Protecting the service against attacks;',
        'Investigating security incidents; and',
      ],
      tail: [
        'Estimating your approximate geographic location.',
        'We do not show your IP address to the person you are chatting with.',
      ],
    },
    {
      heading: 'Approximate location',
      body: [
        'karobakbak may show the person you are chatting with a broad indication of where your connection appears to originate.',
        'We determine this using your IP address.',
        'For example, another user may see:',
        'India',
        'or another approximate country or region.',
        'The displayed location is an estimate.',
        'It is not:',
      ],
      bullets: [
        'GPS data;',
        'A precise location;',
        'A street address;',
        'Your home address;',
        'Your exact coordinates; or',
      ],
      tail: [
        'A verified statement about where you live.',
        'IP-based geolocation can be inaccurate because of VPNs, proxies, mobile networks, corporate networks, internet-service-provider infrastructure and other factors.',
        'We therefore treat the displayed location as approximate.',
      ],
    },
    {
      heading: 'What the other user can see',
      body: [
        'Depending on the features you use, another user may see:',
      ],
      bullets: [
        'Messages you send;',
        'Optional information you choose to provide;',
        'Your approximate country or region derived from your IP address; and',
        'Email address;',
        'IP address;',
        'Password;',
        'Premium account details;',
        'GPS coordinates;',
        'Precise location; or',
      ],
      tail: [
        'Other information intentionally displayed by the chat interface.',
        'They do not receive your:',
        'Payment information.',
        'Remember that anything you deliberately type into a conversation can be read and retained by the person receiving it.',
      ],
    },
    {
      heading: 'Information you voluntarily provide',
      body: [
        'You may choose to provide information about yourself.',
        'This may include:',
      ],
      bullets: [
        'Name or nickname;',
        'Age;',
        'Gender;',
        'Country;',
        'Language; and',
      ],
      tail: [
        'Anything else you type into a conversation.',
        'These details are self-declared.',
        'We do not verify that a user is telling the truth about their name, age, gender, country or other personal characteristics.',
        'You should therefore treat information provided by strangers as unverified.',
      ],
    },
    {
      heading: 'What we do not require',
      body: [
        'Free chat does not require:',
      ],
      bullets: [
        'Name;',
        'Email address;',
        'Phone number;',
        'Password;',
        'Government identification; or',
      ],
      tail: [
        'Social-media account.',
        'Premium does require an email address and an account.',
        'We do not require you to provide your real name simply because you subscribe to Premium.',
      ],
    },
    {
      heading: 'Conversation content',
      body: [
        'We process your messages so that they can be delivered to the person you are chatting with.',
        'We also retain conversations for a limited period so that we can:',
      ],
      bullets: [
        'Investigate reports;',
        'Respond to abuse;',
        'Enforce our Rules;',
        'Investigate safety incidents; and',
      ],
      tail: [
        'Address legal or security issues.',
        'Ordinary conversation retention: 30 days',
        'Reported conversation retention: 90 days',
        'A conversation may be retained for longer where necessary to comply with law or preserve evidence relating to a serious incident, subject to applicable law.',
      ],
    },
    {
      heading: 'Reports and moderation',
      body: [
        'When you report a conversation or user, we may retain and review information necessary to investigate the report.',
        'This may include:',
      ],
      bullets: [
        'The reported conversation;',
        'Relevant messages;',
        'Report information;',
        'Technical information;',
        'Time and date information;',
        'Moderation decisions; and',
      ],
      tail: [
        'Information about enforcement actions.',
        'Report retention: 90 days',
        'Moderation-record retention: 90 days',
        'We use this information to investigate abuse and enforce our Rules.',
      ],
    },
    {
      heading: 'Blocking and bans',
      body: [
        'Blocking needs to continue working even though free chat does not require an account.',
        'We may therefore process technical information associated with your connection to:',
      ],
      bullets: [
        'Enforce blocks;',
        'Enforce bans;',
        'Prevent ban evasion;',
        'Prevent repeated abuse;',
        'Detect suspicious activity; and',
      ],
      tail: [
        'Protect other users.',
        'Where appropriate, technical identifiers may be transformed or protected before being stored for these purposes.',
        'Block and ban identifiers are stored as a salted hash of the address rather than as the address itself. A salted hash is not reversible by inspection, but we do not claim it is impossible to reverse: given the address, the same hash can be recomputed and matched.',
      ],
    },
    {
      heading: 'Premium subscription information',
      body: [
        'When you subscribe to Premium, we process information necessary to manage your subscription.',
        'This may include:',
      ],
      bullets: [
        'Premium account identifier;',
        'Subscription status;',
        'Subscription start date;',
        'Renewal information;',
        'Cancellation information;',
        'Expiration information;',
        'Product or subscription tier;',
        'Transaction or payment reference;',
        'Payment-provider customer identifier; and',
      ],
      tail: [
        'Other information supplied by the payment provider that we need to administer the subscription.',
        'Your payment provider may independently process payment information under its own privacy policy.',
      ],
    },
    {
      heading: 'Payment information',
      body: [
        'If you purchase Premium, payment processing may be performed by a third-party payment provider.',
        'Where the payment provider handles your card or other payment credentials directly, we do not need to store the complete payment credentials ourselves.',
        'We may receive information such as:',
      ],
      bullets: [
        'Payment status;',
        'Transaction identifier;',
        'Subscription identifier;',
        'Amount paid;',
        'Currency;',
        'Payment date;',
        'Refund status; and',
      ],
      tail: [
        'Other information necessary to administer your subscription.',
        'The payment provider\'s own terms and privacy policy will also apply to its processing of your payment information.',
      ],
    },
    {
      heading: 'Authentication provider',
      body: [
        'Premium authentication may be provided using a third-party identity or authentication service.',
        'We currently expect to use a managed authentication provider for this purpose.',
        'The specific provider may change over time.',
        'We therefore describe the processing by function rather than naming a particular vendor in this Privacy Policy.',
        'The authentication provider may process information such as:',
      ],
      bullets: [
        'Email address;',
        'Account identifier;',
        'Authentication credentials or authentication tokens;',
        'Login events;',
        'Verification status;',
        'Password-reset information, where applicable; and',
      ],
      tail: [
        'Security information necessary to protect the account.',
        'If the provider changes in a way that materially changes how personal information is processed, we will update this Privacy Policy where required.',
      ],
    },
    {
      heading: 'Emails',
      body: [
        'We may send emails relating to your Premium account.',
        'These may include:',
      ],
      bullets: [
        'Email verification;',
        'Login or security notifications;',
        'Password or account recovery;',
        'Subscription confirmation;',
        'Payment confirmation;',
        'Subscription renewal;',
        'Cancellation;',
        'Expiration;',
        'Changes to Premium; and',
      ],
      tail: [
        'Important service or legal notices.',
        'We will not treat your Premium email address as permission to send unrelated marketing merely because you created an account.',
        'If we introduce marketing emails, we will provide any legally required notice, consent mechanism or unsubscribe option.',
      ],
    },
    {
      heading: 'Who can access your information',
      body: [
        'Information may be accessible to the following categories of recipients where necessary for legitimate purposes.',
        'The operator',
        'The operator may access information where necessary to:',
      ],
      bullets: [
        'Operate the service;',
        'Investigate reports;',
        'Handle account issues;',
        'Address abuse;',
        'Respond to legal requests;',
        'Maintain security; or',
      ],
      tail: [
        'Resolve technical problems.',
        'Authorized reviewers',
        'Authorized people may access reported conversations or related information where necessary for moderation or safety.',
        'Infrastructure providers',
        'Third-party providers may process information required to host and operate the service.',
        'Authentication providers',
        'Your Premium account information may be processed by the authentication provider we use.',
        'Payment providers',
        'Payment and subscription information may be processed by the payment provider used for Premium.',
        'Security and technical providers',
        'We may use providers for security, monitoring, error handling, infrastructure and related technical functions.',
        'Authorities',
        'We may disclose information where required or permitted by applicable law.',
      ],
    },
    {
      heading: 'We do not sell your information',
      body: [
        'We do not sell:',
      ],
      bullets: [
        'Your email address;',
        'Your conversations;',
        'Your IP address; or',
      ],
      tail: [
        'Your Premium account information',
        'to advertisers or data brokers.',
        'We do not use your conversations to build an advertising profile about you.',
      ],
    },
    {
      heading: 'Cookies and similar technologies',
      body: [
        'karobakbak may use cookies, local storage or similar technologies necessary to operate the service.',
        'For example, these may be used to:',
      ],
      bullets: [
        'Maintain sessions;',
        'Support blocking;',
        'Keep necessary service state;',
        'Authenticate Premium users;',
        'Protect accounts; and',
      ],
      tail: [
        'Prevent abuse.',
        'We do not use third-party advertising cookies as part of the ordinary service.',
        'When you follow a link to another website, that website may use its own cookies and tracking technologies.',
      ],
    },
    {
      heading: 'Analytics and monitoring',
      body: [
        'We do not use third-party analytics services to build profiles of your activity for advertising purposes.',
        'We use no analytics provider, no error-reporting service and no product telemetry service. Nothing about your use of karobakbak is sent to an outside logging or analytics company.',
        'Our pages make no requests to any third party from your browser — no analytics, no trackers, no advertising, not even external fonts.',
        'Signing in is the one exception, and it is a deliberate one: you are taken to the provider’s own page, you can see it in the address bar, and you chose to go there. Your profile picture is relayed by us rather than loaded from them, so browsing this site never tells them you were here.',
        'Moderation of what users send runs on our own servers, on rules rather than on an outside service.',
        'If we ever introduce an analytics provider, a content delivery network, an outside moderation service or any other third party that receives information about you, this section becomes false and will be updated before that change ships.',
      ],
    },
    {
      heading: 'Data retention',
      body: [
        'We retain different information for different periods.',
      ],
      rows: [
        ['Information', 'Intended retention'],
        ['Ordinary conversations', '30 days'],
        ['Reported conversations', '90 days'],
        ['Premium account', 'While account remains active, subject to deletion/retention requirements'],
        ['Premium email address', 'While account remains active and for any required post-account period'],
        ['Subscription records', 'Not applicable while nothing is for sale'],
        ['Payment records', 'Not applicable while nothing is for sale'],
        ['Reports', '90 days'],
        ['Moderation records', '90 days'],
        ['IP addresses', 'Retained while needed for security and abuse prevention'],
        ['Derived block/ban identifiers', 'Retained while needed for security and abuse prevention'],
        ['Security logs', 'Retained while needed for security and abuse prevention'],
        ['Authentication logs', 'Retained while needed for security and abuse prevention'],
        ['Backups', 'Retained while needed for security and abuse prevention'],
      ],
      tail: [
        'Different information may have different retention requirements.',
        'For example, deleting a Premium account does not necessarily mean that transaction records that we are legally required to retain can be deleted immediately.',
      ],
    },
    {
      heading: 'Deleting your Premium account',
      /*
        Two lists, and they were transposed.

        The draft removes four things and withholds seven. Rendered through a
        section that had only one list, the seven withheld items were appended
        to the four removed ones — so the page promised to delete the reader's
        tax, fraud-prevention, security, abuse-enforcement and legal records,
        and then said in the next sentence that it might not. Both halves were
        wrong: the promise is one no operator can keep, and the contradiction
        made the section unreadable as a statement of anything.

        `tailBullets` exists for this. See `PageSection`.
      */
      body: [
        'You may request deletion of your Premium account.',
        'Account deletion may result in the removal of:',
      ],
      bullets: [
        'Your Premium account;',
        'Your email address associated with that account;',
        'Authentication information associated with the account; and',
        'Other account information that is no longer necessary.',
      ],
      tail: [
        'However, deletion may not immediately remove information that we are required or permitted to retain, including:',
      ],
      tailBullets: [
        'Transaction records;',
        'Tax or accounting records;',
        'Fraud-prevention records;',
        'Security records;',
        'Abuse-enforcement records;',
        'Legal records; or',
        'Information preserved in backups until their normal deletion cycle.',
      ],
    },
    {
      heading: 'Deleting conversations',
      body: [
        'Free chat does not have a conventional account-based chat history.',
        'Conversations are automatically deleted according to the applicable retention schedule.',
        'Ordinary conversations: 30 days',
        'Reported conversations: 90 days',
        'If you request deletion, we will handle the request according to applicable law and the limitations created by the anonymous design of the service.',
      ],
    },
    {
      heading: 'The limitation created by anonymous chat',
      body: [
        'The anonymous nature of free chat creates an unusual privacy trade-off.',
        'We deliberately do not require you to identify yourself before chatting.',
        'That means we may not always be able to determine which conversation or technical record belongs to a particular person who contacts us.',
        'For example, if someone asks:',
        '“Delete everything you have about me.”',
        'we may not have enough information to reliably determine which records belong to that person.',
        'We will not ask you to provide unnecessary personal information simply to make a privacy request.',
        'Where we cannot reasonably identify the relevant data, however, we may be unable to fulfil a request because doing so could require us to guess which records belong to you.',
        'This limitation does not remove rights that applicable law gives you.',
      ],
    },
    {
      heading: 'Premium changes this limitation',
      body: [
        'Premium is different because your account contains an email address.',
        'If you have a Premium account, we can generally identify your Premium account from the email address associated with it.',
        'That makes certain account-related privacy requests easier to process than requests concerning anonymous free-chat activity.',
        'It does not necessarily allow us to determine which historical anonymous conversations were yours.',
        'We will not assume that every conversation technically associated with a Premium account belongs to that person unless our systems actually establish that relationship.',
      ],
    },
    {
      heading: 'Security',
      body: [
        'We take reasonable technical and organizational measures to protect personal information.',
        'Depending on the system, these may include:',
      ],
      bullets: [
        'Encryption in transit;',
        'Encryption at rest;',
        'Authentication controls;',
        'Restricted administrative access;',
        'Secrets management;',
        'Access logging;',
        'Monitoring;',
        'Rate limiting;',
        'Abuse prevention;',
        'Backup controls; and',
      ],
      tail: [
        'Incident-response procedures.',
        'No online service can guarantee absolute security.',
        'If we experience a personal-data breach requiring notification under applicable law, we will follow the applicable notification requirements.',
      ],
    },
    {
      heading: 'Children',
      body: [
        'karobakbak is for people aged 18 and over.',
        'We do not knowingly permit people under 18 to use the service.',
        'The age confirmation is self-declared. It is not identity or age verification.',
        'If we become aware that someone under 18 is using the service, we may terminate access and take appropriate action concerning the associated information.',
      ],
    },
    {
      heading: 'International data processing',
      body: [
        'karobakbak is operated from India.',
        'The actual location of data processing depends on the infrastructure, authentication provider, payment provider, email provider and other service providers we use.',
        'Where personal information is stored or processed outside India, we will identify the countries concerned and describe the applicable safeguards in this section.',
      ],
    },
    {
      heading: 'Third-party providers',
      body: [
        'We may change infrastructure and service providers over time.',
        'For that reason, this Privacy Policy describes categories of providers rather than promising that a particular vendor will always be used.',
        'Depending on the services you use, providers may include:',
      ],
      bullets: [
        'Hosting and cloud infrastructure;',
        'Authentication;',
        'Payments;',
        'Email delivery;',
        'Security;',
        'Monitoring;',
        'Error reporting;',
        'Data storage; and',
      ],
      tail: [
        'Other infrastructure necessary to operate the service.',
        'We expect providers processing personal information on our behalf to process that information only for appropriate purposes and under appropriate contractual and security arrangements where required.',
      ],
    },
    {
      heading: 'Legal disclosures',
      body: [
        'We may disclose information where required or permitted by law.',
        'This may include disclosure necessary to:',
      ],
      bullets: [
        'Comply with a valid legal process;',
        'Respond to a lawful government request;',
        'Investigate serious unlawful activity;',
        'Protect someone\'s safety;',
        'Prevent fraud;',
        'Prevent abuse;',
        'Protect the service;',
        'Investigate security incidents; or',
      ],
      tail: [
        'Establish, exercise or defend legal claims.',
        'Where legally permitted, we will consider whether notifying the affected person is appropriate.',
      ],
    },
    {
      heading: 'Your privacy rights',
      body: [
        'Depending on the law applicable to you, you may have rights concerning your personal information.',
        'These may include:',
      ],
      bullets: [
        'Accessing information about processing;',
        'Requesting access to personal information;',
        'Requesting correction;',
        'Requesting deletion;',
        'Withdrawing consent where applicable;',
        'Requesting restriction of processing;',
        'Objecting to certain processing;',
        'Requesting portability where applicable;',
        'Raising a grievance; and',
      ],
      tail: [
        'Other rights provided by applicable law.',
        'The precise rights available to you depend on the applicable legal framework.',
      ],
    },
    {
      heading: 'How to make a privacy request',
      body: [
        'Contact:',
        `${contact}`,
        'For Premium account requests, contacting us from the email address associated with the account may help us verify the request.',
        'For anonymous free-chat requests, we may not have enough information to identify the relevant data.',
        'Please do not send passwords, payment-card numbers, government identification or other unnecessary sensitive information when making a privacy request.',
      ],
    },
    {
      heading: 'Verification of requests',
      body: [
        'We may need to verify a request before providing, changing or deleting personal information.',
        'This is necessary to prevent one person from obtaining or deleting another person\'s information.',
        'We will use proportionate verification and will not intentionally collect more information than reasonably necessary for that purpose.',
        'For Premium accounts, the email address associated with the account may be one method of verification.',
      ],
    },
    {
      heading: 'Data protection and legal compliance',
      body: [
        'We will process personal information in accordance with applicable data-protection and privacy laws.',
        'Because karobakbak is operated from India, Indian data-protection requirements are particularly relevant to the service.',
        'The Digital Personal Data Protection Act, 2023 and the Digital Personal Data Protection Rules, 2025 establish requirements concerning the processing of digital personal data, including notice, consent, security safeguards, retention and data-subject rights. The Rules\' commencement has been phased, so the exact obligations applicable to the service depend on the effective date of the relevant provisions.',
        'We check this Privacy Policy against the provisions actually in force, and update it when they change.',
      ],
    },
    {
      heading: 'Changes to this Privacy Policy',
      body: [
        'We may update this Privacy Policy when:',
      ],
      bullets: [
        'We introduce new features;',
        'Our data practices change;',
        'We introduce Premium functionality;',
        'We change authentication or payment providers;',
        'We change infrastructure;',
        'Applicable law changes; or',
      ],
      tail: [
        'We need to clarify our practices.',
        'We will update the “Last updated” date whenever the policy changes.',
        'If a change materially affects how we process personal information, we will provide appropriate notice where required by applicable law.',
      ],
    },
    {
      heading: 'Contact',
      body: [
        'For privacy questions, account-related privacy requests or concerns about this Privacy Policy:',
        'karobakbak',
        // The fourth and last. Four blanks for the same fact, in two documents,
        // each of which would have been filled in by hand on launch day — which
        // is how a decision not to publish something gets undone by a chore.
        'Operator: ***REMOVED*** C Joe, sole proprietor, trading as karobakbak',
        `Email: ${contact}`,
        'Phone: ***REMOVED***',
        'Address: not published while karobakbak is free to use — please use the email address or phone number above.',
        'For problems involving another user or a particular conversation, use the Report function inside the service where possible.',
      ],
    },
    {
      heading: 'Grievance contact',
      /*
        This section named nobody while the Contact section directly above it
        already named the operator, and closed on an instruction to the drafter.

        The clocks are the ones `docs/policies/terms-of-service.md` commits to
        and are stated there rather than invented here: acknowledgement within
        24 hours, resolution aimed at 15 days. The asymmetry is deliberate and
        recorded in that draft — an acknowledgement can be automated and a
        resolution cannot, so one is a machine's promise and the other is a
        person's.
      */
      body: [
        'Grievance Officer: ***REMOVED*** C Joe',
        `Email: ${contact}`,
        'Phone: ***REMOVED***',
        'We aim to acknowledge a grievance within 24 hours of receiving it.',
        'We aim to resolve a grievance within 15 days.',
      ],
    },
  ],
};

/** The two legal pages, in footer order. */
export const LEGAL_PAGES: readonly StaticPage[] = [TERMS, PRIVACY];
