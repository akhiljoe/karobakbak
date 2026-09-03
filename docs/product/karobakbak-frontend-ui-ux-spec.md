# KaroBakBak --- Frontend UI/UX Design Specification

## Purpose

This document defines the frontend UI/UX direction for KaroBakBak, a
text-only, real-time random stranger chat platform.

The goal is not to build a generic messaging interface. The goal is to
make KaroBakBak feel like a living, polished consumer social product
where users can quickly meet someone new, start talking, and move to
another stranger with almost no friction.

The core loop is:

``` text
Open KaroBakBak
      ↓
See that people are online
      ↓
Start chatting
      ↓
Find a stranger
      ↓
Talk
      ↓
Next stranger
      ↓
Talk again
```

Everything in the UI should strengthen this loop without overwhelming
it.

------------------------------------------------------------------------

# 1. Product Experience Principles

## 1.1 The product should feel alive

A random-chat product has a psychological problem: a user does not know
whether anyone is actually there.

The interface should therefore communicate genuine platform activity
when reliable backend metrics are available.

Useful examples:

-   `🟢 1,533 online`
-   `247 conversations happening`
-   `42 countries represented`

Never fabricate activity numbers. If the backend does not provide a
trustworthy metric, do not display fake social proof.

## 1.2 The product should feel spontaneous

The experience should communicate:

> "I wonder who I'll meet."

It should not feel like:

> "I am filling out a matchmaking form."

The default experience should remain random.

Filters and preferences should be optional enhancements rather than
prerequisites.

## 1.3 The product should feel safe without feeling sterile

Users should understand that:

-   They are anonymous.
-   No profile is required for the core experience.
-   They can leave at any time.
-   They can report or block someone.

However, safety information should not dominate the interface.

## 1.4 The chat should disappear into the background

Once a match is established, the conversation becomes the product.

Navigation, metrics, advertisements, and secondary features should
become visually subordinate.

The user should be able to focus on the person they are talking to.

## 1.5 Speed matters

The application should feel instantaneous.

Important transitions:

``` text
Start
  ↓
Searching
  ↓
Matched
  ↓
Typing
  ↓
Message
  ↓
Next
  ↓
Searching again
```

Avoid unnecessary intermediate screens.

------------------------------------------------------------------------

# 2. Product Personality

KaroBakBak should feel:

-   Modern
-   Playful
-   Curious
-   Social
-   Lightweight
-   Anonymous
-   Friendly
-   Slightly unpredictable
-   Safe
-   Fast

It should not feel:

-   Corporate
-   Like an enterprise dashboard
-   Like a dating app
-   Like a generic SaaS template
-   Like a developer demo
-   Overly childish
-   Overly gamified
-   Aggressively monetized

The product should create a small sense of anticipation before the user
starts a conversation.

------------------------------------------------------------------------

# 3. Global Application Layout

On desktop, use a structure similar to:

``` text
┌────────────────────────────────────────────────────────────────────┐
│ Logo   🟢 Online   Filters   Friends             Notifications ... │
├───────────────────────────────────────────────────┬────────────────┤
│                                                   │                │
│                                                   │                │
│                PRIMARY EXPERIENCE                 │   AD / FUTURE  │
│                                                   │    CONTENT     │
│                                                   │                │
│                                                   │                │
└───────────────────────────────────────────────────┴────────────────┘
```

The right-hand rail is optional infrastructure for advertisements or
future secondary content.

It must never compromise the main interaction.

On mobile:

``` text
┌──────────────────────────────┐
│ Logo      🟢 Online       ⋯  │
├──────────────────────────────┤
│                              │
│        PRIMARY UI            │
│                              │
│                              │
└──────────────────────────────┘
```

Do not attempt to reproduce the desktop navigation literally on mobile.

------------------------------------------------------------------------

# 4. Global Header

The desktop header should provide lightweight access to important
platform functions.

Potential elements:

-   KaroBakBak logo.
-   Live online count.
-   Filters.
-   Friends/connections.
-   Notifications.
-   Profile/settings.
-   Login/account.
-   Premium/upgrade entry point if monetization is introduced.

Example conceptual structure:

``` text
KaroBakBak    🟢 1,533 online    Filters    Friends       🔔   ⚙
```

The exact design should be original.

Do not copy another site's layout or branding.

## Header behavior

The header should:

-   Remain visually lightweight.
-   Avoid consuming excessive vertical space.
-   Stay available when useful.
-   Collapse intelligently on mobile.
-   Never compete with the message composer.
-   Use consistent iconography.
-   Have accessible labels/tooltips.

------------------------------------------------------------------------

# 5. Live Online Presence

A live online count is a strong psychological signal for a random-chat
product.

When supported by the backend:

``` text
🟢 1,533 online
```

Possible secondary metrics:

``` text
247 conversations happening
```

``` text
People chatting from 42 countries
```

Use these sparingly.

The number should not become the primary visual element.

## Important rule

Never fabricate:

-   Online counts.
-   Active conversations.
-   Country counts.
-   User activity.
-   "Someone just joined" events.

Only display metrics backed by real server data.

------------------------------------------------------------------------

# 6. Landing / Start Screen

The landing screen is responsible for getting a new user into their
first conversation quickly.

It should communicate:

1.  What KaroBakBak is.
2.  That the experience is anonymous.
3.  That there are real people online when such information is
    available.
4.  What the primary action is.

Conceptual composition:

``` text
                 🟢 1,533 people online

                         💬

                  Meet someone new.

             Random. Anonymous. Instant.

                  [ Start chatting ]

          🔒 No signup · No profile required
```

Do not use this exact copy.

Create concise, confident, natural product copy.

## Avoid

-   Long marketing paragraphs.
-   Multiple competing CTAs.
-   Excessive feature lists.
-   Fake testimonials on the core chat screen.
-   Large decorative illustrations.
-   Generic SaaS hero sections.

The user should understand the product within a few seconds.

------------------------------------------------------------------------

# 7. Anonymous Identity

Although users are anonymous, conversations should still feel human.

Consider temporary identities such as:

``` text
🟣 Curious Fox
   Stranger
```

or:

``` text
🟣 Stranger
   Connected · 03:42
```

Possible identity elements:

-   Generated nickname.
-   Generated avatar.
-   Abstract shape.
-   Temporary color.
-   Optional user-selected emoji.
-   Explicitly shared language/country.

Do not create realistic profile cards.

Do not reveal sensitive information.

The temporary identity should belong to the current session unless
persistent identity is introduced later.

------------------------------------------------------------------------

# 8. Matchmaking Screen

The waiting state is a major part of the product experience.

Do not show a generic spinner.

The waiting state should communicate that matchmaking is actively
happening.

Concept:

``` text
              Looking for someone...

                   ● ● ●

             People are online.
             Finding your match.

                  [ Cancel ]
```

Possible visual treatments:

-   Pulsing identity orb.
-   Animated dots.
-   Subtle radar/search animation.
-   Abstract network visualization.
-   Gentle ambient movement.
-   Rotating short status messages.

Examples:

``` text
Finding someone...
```

``` text
Looking for a conversation...
```

``` text
Seeing who's around...
```

Do not make the animation distracting.

The user should still be able to cancel.

------------------------------------------------------------------------

# 9. Match Found Transition

The transition from matchmaking to chat should feel meaningful.

Avoid instantly replacing the screen with the chat interface.

A short transition can communicate:

``` text
Searching...
    ↓
Someone's here.
    ↓
Chat
```

Possible visual treatment:

-   Identity appearing.
-   Small connection animation.
-   Message composer becoming active.
-   Brief "You're connected" system message.

Keep the transition extremely short.

The user should be able to type almost immediately.

------------------------------------------------------------------------

# 10. Chat Screen

The chat screen is the most important interface.

Primary structure:

``` text
┌──────────────────────────────────────────────────────────────┐
│  🟣 Curious Fox                 ● Connected · 03:42       ⋯  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│        Stranger: Hey!                                       │
│                                                              │
│                            You: Hey, what's up?              │
│                                                              │
│        Stranger: Not much 😄                                 │
│                                                              │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│  Type a message...                              [ Send ]    │
└──────────────────────────────────────────────────────────────┘
```

The exact layout can vary, but the hierarchy should remain:

1.  Who am I talking to?
2.  What has been said?
3.  Where do I type?
4.  How do I send?
5.  How do I move on?
6.  How do I report/block if necessary?

------------------------------------------------------------------------

# 11. Chat Header

The chat header should contain:

-   Temporary stranger identity.
-   Connection status.
-   Optional conversation duration.
-   Next action.
-   Safety/overflow menu.

Example:

``` text
🟣 Curious Fox
● Connected · 03:42

                                      Next →   ⋮
```

Do not make the stranger's identity too prominent.

The conversation should remain the focus.

------------------------------------------------------------------------

# 12. Conversation Duration

A subtle conversation timer can create continuity.

Examples:

``` text
Connected · 03:42
```

or:

``` text
03:42
```

The timer should never feel like a productivity metric.

Do not show it if it adds clutter.

------------------------------------------------------------------------

# 13. Message Bubbles

Message design should be clean and readable.

Requirements:

-   Comfortable line height.
-   Reasonable maximum width.
-   Correct wrapping.
-   Good spacing between message groups.
-   Clear incoming/outgoing distinction.
-   Optional timestamps.
-   Subtle entrance animation.
-   Strong readability on mobile.

Avoid:

-   Oversized bubbles.
-   Excessive rounding.
-   Every message looking like a separate card.
-   Excessive shadows.
-   Huge gaps between messages.

Consecutive messages from the same participant should visually group
together.

------------------------------------------------------------------------

# 14. Message Timestamps

Timestamps should not dominate the conversation.

Possible behavior:

-   Show the time on message hover.
-   Show timestamps when message groups change.
-   Show subtle inline time labels.
-   On mobile, use a lightweight grouping approach.

Example:

``` text
Stranger · 9:41 PM
Hey!

You
Hey, what's up?

Stranger
Not much 😄
```

Avoid putting a large timestamp beside every message.

------------------------------------------------------------------------

# 15. Message Input

The message composer should be one of the highest-quality components in
the product.

It should support:

-   Enter to send.
-   Shift+Enter for newline if multiline is supported.
-   Mobile keyboard behavior.
-   Disabled state.
-   Empty-message prevention.
-   Character limits if needed.
-   Sending state where appropriate.
-   Clear focus state.
-   Accessible label.

Concept:

``` text
┌──────────────────────────────────────────────────────────────┐
│ Type a message...                                      ➤    │
└──────────────────────────────────────────────────────────────┘
```

The send action should not overpower the text field.

The composer should remain accessible while the conversation scrolls.

------------------------------------------------------------------------

# 16. Typing Indicator

Implement a subtle typing indicator.

Examples:

``` text
Stranger is typing...
```

or:

``` text
● ● ●
```

Requirements:

-   Animate gently.
-   Do not reserve a large block of space.
-   Disappear immediately when no longer relevant.
-   Respect reduced-motion preferences.

------------------------------------------------------------------------

# 17. Next / Skip Interaction

Moving to another stranger is a core product action.

The UI language should feel positive.

Prefer:

``` text
Next →
```

or:

``` text
Next stranger →
```

rather than relying exclusively on:

``` text
Skip
```

The underlying protocol can still use `skip`.

## Interaction

``` text
Current conversation
        ↓
       Next
        ↓
Searching...
        ↓
New stranger
```

The user should never have to return to the landing page.

The transition should be fast.

## Accidental activation

Because Next ends a conversation, it should be visually distinct from
Send and should not be too easy to hit accidentally.

A confirmation may be appropriate in certain contexts, but do not add
unnecessary friction to normal use.

------------------------------------------------------------------------

# 18. Conversation End States

Design explicit UI for every termination state.

## Stranger leaves

``` text
Your stranger left the conversation.

Looking for someone new?

[ Find someone ]
```

Or automatically transition to matchmaking if that is the intended
product behavior.

## User selects Next

Immediately transition into matchmaking.

## Connection failure

``` text
Connection lost.

Trying to reconnect...
```

## No match available

``` text
No one is available right now.

We'll keep looking.

[ Cancel ]
```

Do not show a dead screen with a spinner.

------------------------------------------------------------------------

# 19. Reconnection UX

Connection lifecycle:

``` text
CONNECTED
    ↓
CONNECTION LOST
    ↓
RECONNECTING
    ↓
CONNECTED
```

Display this clearly but unobtrusively.

Example:

``` text
🟡 Reconnecting...
```

After recovery:

``` text
🟢 Connected
```

If the current conversation cannot be recovered, explain what happened
and provide a clear next action.

Never expose:

``` text
ECONNRESET
WebSocketError
NetworkError
```

to the user.

------------------------------------------------------------------------

# 20. System Messages

System messages should look different from user messages.

Examples:

``` text
You are now chatting with a stranger.
```

``` text
Your stranger left the conversation.
```

``` text
Looking for someone new...
```

``` text
Connection restored.
```

Use subtle inline treatments.

Avoid modal dialogs for ordinary status changes.

------------------------------------------------------------------------

# 21. Icebreakers

One of the biggest UX risks in random chat is dead conversation.

A common pattern is:

``` text
Hi
Hi
What's up?
Nothing
Same
```

An optional icebreaker system can improve this.

After matching, consider showing:

``` text
✨ Break the ice

"What is something you could talk about
for hours?"

[ Use this question ]
```

The user should be able to dismiss it.

## Categories

Possible categories:

-   Funny.
-   Random.
-   Deep.
-   Hypothetical.
-   Travel.
-   Movies.
-   Music.
-   Gaming.
-   Food.
-   Would You Rather.
-   Pop culture.

The icebreaker should never force scripted conversation.

------------------------------------------------------------------------

# 22. Mini-Games --- Future Feature

Leave space in the architecture for optional conversation games.

Possible games:

-   Tic-tac-toe.
-   Would You Rather.
-   Quick trivia.
-   Guess the word.
-   Emoji challenge.
-   This-or-that.

A future chat toolbar might look like:

``` text
[ + ]   Type a message...                          [ Send ]
```

Opening:

``` text
Things to do

🎲 Question
🎮 Tic-tac-toe
🧠 Trivia
😂 Would You Rather
```

Do not implement these simply to make the MVP look feature-rich.

The core chat experience comes first.

------------------------------------------------------------------------

# 23. Filters

Filters should be optional.

Potential filters:

-   Country/region.
-   Language.
-   Interests.
-   Topics.

Concept:

``` text
┌────────────────────────────────────┐
│ Who would you like to meet?        │
│                                    │
│ 🌎 Location                        │
│ [ Anywhere ▾ ]                     │
│                                    │
│ 🗣 Language                        │
│ [ Any language ▾ ]                 │
│                                    │
│ Interests                          │
│ [ Gaming ] [ Movies ] [ Music ]    │
│ [ Tech ]   [ Travel ] [ Sports ]   │
│                                    │
│              [ Apply ]             │
└────────────────────────────────────┘
```

Do not make the interface resemble dating-app preference selection.

The default remains:

> Anyone, anywhere.

------------------------------------------------------------------------

# 24. Country / Language Matching

If implemented, country and language controls should be explicit and
privacy-conscious.

Possible display:

``` text
🌍 Anywhere
```

or after an explicitly shared preference:

``` text
🇯🇵 Japan
```

Do not infer or reveal a user's precise location.

Do not expose private geographic information.

------------------------------------------------------------------------

# 25. Safety Controls

Random stranger chat requires easy access to safety controls.

Provide:

-   Report.
-   Block.
-   End conversation.

A three-dot menu in the chat header is appropriate:

``` text
⋮
├── Report
├── Block
└── End conversation
```

Safety controls should be:

-   Easy to find.
-   Fast to use.
-   Visually unobtrusive.
-   Accessible by keyboard.
-   Available on mobile.

------------------------------------------------------------------------

# 26. Reporting Flow

The reporting experience should be simple.

Concept:

``` text
Why are you reporting this person?

○ Harassment
○ Spam
○ Sexual content
○ Hate or abuse
○ Other

[ Report ]
```

Do not make the report form unnecessarily long.

Do not expose internal moderation details.

After submission:

``` text
Report submitted.

Thanks for helping keep KaroBakBak safe.
```

------------------------------------------------------------------------

# 27. Block Flow

Blocking should end the current conversation and prevent further
interaction according to backend rules.

Use clear confirmation when necessary.

Example:

``` text
Block this stranger?

You won't be matched with them again.

[ Cancel ]   [ Block ]
```

Do not create confusing multi-step flows.

------------------------------------------------------------------------

# 28. Anonymous Safety Reassurance

On the landing screen or near the start CTA, provide a concise
reassurance.

Examples:

``` text
🔒 Anonymous · No signup required
```

``` text
No profile. No camera. Just conversation.
```

Avoid large safety banners unless there is a specific safety event.

------------------------------------------------------------------------

# 29. Desktop Advertising Architecture

Reserve a desktop advertising area without making advertising part of
the product identity.

Concept:

``` text
┌─────────────────────────────────────────────┬───────────────┐
│                                             │               │
│                                             │      AD       │
│               MAIN EXPERIENCE               │               │
│                                             │               │
│                                             │               │
└─────────────────────────────────────────────┴───────────────┘
```

Requirements:

-   Fixed maximum width.
-   No overlap with primary UI.
-   No layout instability when ads load.
-   No intrusive popups.
-   No advertisements inside message bubbles.
-   Hide or relocate on small screens.
-   Reserve layout space to prevent content jumping.

The chat should remain usable if the ad provider fails.

------------------------------------------------------------------------

# 30. Mobile Experience

Mobile is not merely a smaller desktop.

The mobile interface should be designed as a messaging application.

Priorities:

1.  Conversation.
2.  Message composer.
3.  Next.
4.  Connection state.
5.  Safety.

Consider:

-   Browser viewport changes.
-   Virtual keyboard.
-   Safe-area insets.
-   Touch targets.
-   Sticky composer.
-   Scroll position.
-   Mobile browser chrome.
-   Landscape orientation.

Avoid placing too much UI above the conversation.

------------------------------------------------------------------------

# 31. Mobile Keyboard Behavior

The message composer must behave correctly when the virtual keyboard
opens.

Requirements:

-   Composer remains visible.
-   Conversation can scroll.
-   Latest messages remain visible.
-   Keyboard does not cover the composer.
-   Focus is preserved.
-   Layout responds to viewport changes.

Test on both iOS-style and Android-style browser behavior.

------------------------------------------------------------------------

# 32. Responsive Breakpoints

Support at least:

-   Small phones.
-   Large phones.
-   Tablets.
-   Laptop screens.
-   Large desktop monitors.

Do not simply scale the desktop layout.

Adapt:

-   Header.
-   Ad rail.
-   Chat width.
-   Message density.
-   Controls.
-   Navigation.
-   Filters.
-   Menus.

------------------------------------------------------------------------

# 33. Accessibility

Accessibility is a core requirement.

Implement:

-   Semantic HTML.
-   Keyboard navigation.
-   Visible focus states.
-   Appropriate ARIA labels.
-   Accessible live regions for important status changes.
-   Screen-reader-friendly connection state.
-   Sufficient color contrast.
-   Reduced-motion support.
-   Correct heading hierarchy.
-   Accessible form labels.
-   Accessible icon buttons.
-   Touch targets of appropriate size.

Never rely solely on color.

For example, do not communicate only:

``` text
🟢
```

Also provide:

``` text
Connected
```

Respect:

``` css
@media (prefers-reduced-motion: reduce)
```

------------------------------------------------------------------------

# 34. Animation System

Animation should make the interface feel alive, not busy.

Good candidates:

-   Match found.
-   Searching.
-   New message.
-   Button press.
-   Input focus.
-   Next transition.
-   Connection recovery.
-   Temporary identity appearance.

Animation principles:

-   Fast.
-   Subtle.
-   Purposeful.
-   Interruptible.
-   Never blocking.

Avoid:

-   Constant bouncing.
-   Excessive particle effects.
-   Long transitions.
-   Animation on every element.
-   Motion that delays interaction.

------------------------------------------------------------------------

# 35. Visual Design System

Create a consistent design system before implementing individual
screens.

Define:

## Color

Specify:

-   Primary brand color.
-   Primary hover/active states.
-   Background colors.
-   Surface colors.
-   Text colors.
-   Muted text.
-   Success.
-   Warning.
-   Error.
-   Focus ring.

## Typography

Define:

-   Font family.
-   Display scale.
-   Heading scale.
-   Body.
-   Small text.
-   Button text.
-   Message text.

## Spacing

Use a consistent spacing scale.

## Radius

Define:

-   Small radius.
-   Medium radius.
-   Large radius.
-   Pill radius.

## Elevation

Use shadows sparingly.

## Icons

Use one consistent icon family.

Do not mix arbitrary icon styles.

------------------------------------------------------------------------

# 36. Visual Direction

Explore three directions before implementation:

### Direction A --- Minimal / Editorial

Characteristics:

-   Clean typography.
-   Restrained color.
-   Lots of whitespace.
-   Strong content hierarchy.

### Direction B --- Playful / Social

Characteristics:

-   Brighter accents.
-   More personality.
-   Temporary identities.
-   More expressive micro-interactions.

### Direction C --- Dark / Atmospheric

Characteristics:

-   Dark surfaces.
-   Strong accent color.
-   Ambient visual effects.
-   More mysterious "meet someone new" feeling.

Evaluate each against:

-   Chat readability.
-   Mobile usability.
-   Brandability.
-   Long-session comfort.
-   Emotional tone.
-   Accessibility.

Choose one final direction.

Do not ship three unfinished themes.

------------------------------------------------------------------------

# 37. Do Not Overdesign

Do not add features merely because they look impressive.

Avoid:

-   Social feeds.
-   Follower counts.
-   Likes.
-   Stories.
-   Profile browsing.
-   Unnecessary dashboards.
-   Excessive gamification.
-   Large hero illustrations.
-   Fake activity feeds.
-   Decorative statistics.
-   Empty navigation items.
-   Unimplemented controls.

Every element must have a reason to exist.

------------------------------------------------------------------------

# 38. Product Chrome vs Chat UX

Treat the product as two layers.

## Product Chrome

Includes:

-   Header.
-   Online count.
-   Filters.
-   Friends.
-   Notifications.
-   Settings.
-   Ads.
-   Account controls.

Purpose:

> Make the service feel like a real platform.

## Chat UX

Includes:

-   Stranger identity.
-   Messages.
-   Typing.
-   Composer.
-   Next.
-   Connection state.
-   Safety.

Purpose:

> Make the conversation excellent.

When a match begins, the second layer should dominate.

------------------------------------------------------------------------

# 39. Future-Ready Features

The frontend architecture should allow these to be introduced later
without redesigning the application:

-   Accounts.
-   Friends.
-   Notifications.
-   Country matching.
-   Language matching.
-   Interest matching.
-   Premium matching.
-   Mini-games.
-   Voice chat.
-   Persistent connections.
-   Conversation history for authenticated users.

However, do not implement these prematurely.

The MVP remains:

``` text
Find stranger
     ↓
Chat
     ↓
Next
     ↓
Find another stranger
```

------------------------------------------------------------------------

# 40. WebSocket UI Integration

The frontend must treat the server as the authority on application
state.

Create a clean WebSocket/client layer.

The UI should consume state such as:

``` text
connectionState
sessionState
matchState
messages
errors
```

Do not scatter raw WebSocket calls across components.

Avoid patterns such as:

``` typescript
socket.send(...)
```

inside many UI components.

Instead, expose an application-level API.

Conceptually:

``` typescript
startMatching()
sendMessage(text)
nextStranger()
cancelMatching()
reportStranger()
blockStranger()
```

The underlying WebSocket protocol remains an implementation detail.

------------------------------------------------------------------------

# 41. Server-Authoritative State

The frontend must not invent matchmaking state.

For example, the client should not decide:

> "I think we are matched now."

The server should send the authoritative state.

The UI should render:

``` text
SEARCHING
MATCHED
DISCONNECTED
RECONNECTING
```

based on server/client connection events.

This prevents inconsistent UI during races and reconnects.

------------------------------------------------------------------------

# 42. UI State Model

At minimum, model:

``` text
connectionState
    CONNECTING
    CONNECTED
    RECONNECTING
    DISCONNECTED

sessionState
    IDLE
    SEARCHING
    MATCHED

messages

strangerIdentity

typingState

conversationDuration

errorState

uiState
    filtersOpen
    reportOpen
    settingsOpen
    etc.
```

Keep protocol state separate from purely visual UI state.

------------------------------------------------------------------------

# 43. Loading and Empty States

Every major state must be deliberately designed.

Required states:

-   First visit.
-   Searching.
-   Match found.
-   Active conversation.
-   Empty conversation.
-   Stranger disconnected.
-   User skipped.
-   No users available.
-   Reconnecting.
-   Offline.
-   Server error.
-   Report submitted.
-   Blocked.
-   Filters open.
-   Filters applied.

Do not leave states as generic browser loading screens.

------------------------------------------------------------------------

# 44. Error UX

Never expose implementation details.

Bad:

``` text
Redis connection failed.
```

Good:

``` text
Something went wrong.

Try reconnecting.
```

Better where useful:

``` text
We lost the connection.

We're trying again...
```

Errors should always have an understandable next step when recovery is
possible.

------------------------------------------------------------------------

# 45. No Dead UI

Do not include:

-   Fake buttons.
-   Fake notification badges.
-   Fake online counts.
-   Placeholder statistics.
-   Unimplemented menu items.
-   Empty profile sections.
-   Decorative controls.

If a feature does not exist, either omit it or clearly treat it as
future functionality during design work.

------------------------------------------------------------------------

# 46. Performance

Optimize perceived responsiveness.

Requirements:

-   Fast initial render.
-   Reasonable bundle size.
-   Minimal unnecessary dependencies.
-   Efficient message rendering.
-   Avoid unnecessary React re-renders.
-   Avoid layout thrashing.
-   Avoid expensive animation loops.
-   Keep the composer responsive.
-   Maintain smooth scrolling.

Do not prematurely optimize everything.

Prioritize measurable user-facing bottlenecks.

------------------------------------------------------------------------

# 47. SEO / Public Landing Considerations

If the landing screen is also the public website entry point, keep
public informational content separate from the actual chat application.

Potential public areas:

-   What KaroBakBak is.
-   How random chat works.
-   Safety.
-   Privacy.
-   Terms.
-   FAQ.

Do not place a large marketing website around the actual chat screen.

The application should remain focused once the user starts chatting.

------------------------------------------------------------------------

# 48. Monetization Readiness

If monetization is planned, the UI should support it without destroying
the free experience.

Potential future areas:

-   Upgrade.
-   Premium filters.
-   Ad-free experience.
-   Advanced matching.
-   Additional personalization.

Avoid making the primary "Start chatting" action feel paywalled.

Do not make ads or premium prompts appear during emotionally sensitive
conversation moments.

------------------------------------------------------------------------

# 49. Suggested Component Architecture

A reasonable frontend component structure:

``` text
App
├── AppShell
│   ├── Header
│   │   ├── Logo
│   │   ├── OnlineCount
│   │   ├── FiltersButton
│   │   ├── FriendsButton
│   │   ├── NotificationsButton
│   │   └── AccountMenu
│   │
│   └── MainLayout
│       ├── MainContent
│       └── AdRail
│
├── LandingScreen
│   ├── OnlinePresence
│   ├── StartCTA
│   └── SafetyHint
│
├── MatchmakingScreen
│   ├── SearchingAnimation
│   ├── MatchmakingStatus
│   └── CancelButton
│
└── ChatScreen
    ├── ChatHeader
    │   ├── StrangerIdentity
    │   ├── ConnectionStatus
    │   ├── ConversationTimer
    │   ├── NextButton
    │   └── ChatMenu
    │
    ├── MessageList
    │   ├── MessageGroup
    │   ├── MessageBubble
    │   ├── TypingIndicator
    │   └── SystemMessage
    │
    ├── Icebreaker
    └── MessageComposer
```

This is a starting point, not a requirement to create dozens of tiny
components.

------------------------------------------------------------------------

# 50. Recommended UX Priority

Not every feature has equal importance.

## Tier 1 --- Core

Must be excellent:

-   Landing screen.
-   Start CTA.
-   Matchmaking.
-   Match-found transition.
-   Chat screen.
-   Message composer.
-   Next.
-   Connection state.
-   Mobile behavior.
-   Report/block.
-   Error/reconnection handling.

## Tier 2 --- Strong product features

Highly valuable:

-   Live online count.
-   Temporary stranger identity.
-   Typing indicator.
-   Icebreakers.
-   Filters.
-   Country/language.
-   Conversation duration.
-   Desktop ad architecture.

## Tier 3 --- Retention

Later:

-   Friends.
-   Notifications.
-   Persistent anonymous identity.
-   Conversation reconnection.
-   Mini-games.

## Tier 4 --- Expansion

Much later:

-   Voice.
-   Premium matching.
-   Advanced personalization.
-   Larger social features.

------------------------------------------------------------------------

# 51. UX Walkthrough Checklist

Before declaring the UI complete, perform this walkthrough.

## First visit

Can a completely new user understand the product within seconds?

## Start

Is there one obvious action?

## Searching

Does waiting feel intentional and alive?

## Match

Does meeting someone feel like a small event?

## Chat

Can the user focus on conversation?

## Typing

Is sending effortless?

## Next

Can the user quickly move to another stranger?

## Disconnect

Is it obvious what happened?

## Reconnect

Does the UI recover gracefully?

## Safety

Can the user report/block someone quickly?

## Mobile

Does it feel like a high-quality messaging app?

## Desktop

Does the layout make good use of space?

## Accessibility

Can the core flow be completed with a keyboard and screen reader?

## Failure

Does every important failure have a clear recovery path?

------------------------------------------------------------------------

# 52. Final Quality Bar

The finished UI should not feel like:

> "A React application connected to a WebSocket server."

It should feel like:

> "A real place where people are hanging out and I can meet someone
> right now."

The user should feel:

``` text
There are people here.
        ↓
I wonder who I'll meet.
        ↓
Let's start.
        ↓
Oh, someone is here.
        ↓
Let's talk.
        ↓
Not clicking?
        ↓
Next.
        ↓
Who will I meet now?
```

That feeling is the product.

The interface should make that loop fast, clear, safe, and enjoyable.

------------------------------------------------------------------------

# 53. Reference / Inspiration

For product-pattern research, review established random-chat products
such as AirTALK.

Use them to study interaction patterns such as:

-   Random text/voice entry points.
-   Anonymous onboarding.
-   Next/skip behavior.
-   Friends.
-   Country selection.
-   Shared interests.
-   Safety controls.
-   Icebreakers/games.
-   Persistent platform activity.
-   Premium feature placement.

Do not copy their visual identity, branding, exact layouts, wording, or
assets.

The goal is to learn from established product patterns and build an
original KaroBakBak experience.
