# Karobakbak — Advertising & Monetization Architecture

## 1. Purpose

This document defines how advertising will be incorporated into Karobakbak without compromising the core random-chat experience, privacy model, safety architecture, performance, or future premium monetization.

Karobakbak is a text-only anonymous random stranger chat platform. Advertising is a monetization layer around the product, not part of the conversation itself.

### Primary principle

> Ads should monetize the waiting and transition moments around conversations, not interrupt the conversations themselves.

The advertising architecture must remain independently controllable, measurable, and removable.

---

## 2. Monetization Goals

The advertising system should:

1. Generate revenue from free users.
2. Keep the core chat experience free.
3. Avoid disrupting active conversations.
4. Never use conversation text for advertising targeting.
5. Never expose conversation content to advertising providers.
6. Prevent advertising from becoming a safety/privacy liability.
7. Support frequency caps.
8. Support multiple ad providers.
9. Support disabling ads for premium users in the future.
10. Fail gracefully when an ad provider is unavailable.
11. Provide enough telemetry to measure revenue versus engagement impact.
12. Allow monetization to be enabled gradually after product validation.

Advertising is not the first product goal. Retention and healthy usage come first.

---

# 3. Core Advertising Principles

## P1 — Conversation Isolation

Advertising systems must be logically separated from the chat system.

An advertisement must never be inserted into the message stream.

Bad:

```text
You: hello

[ADVERTISEMENT]

Stranger: hey
```

Good:

```text
Conversation
    ↓
Conversation ends
    ↓
Finding next stranger
    ↓
Advertisement
    ↓
Next match
```

---

## P2 — No Conversation-Based Ad Targeting

Conversation content must never be used to:

- select advertisements;
- construct advertising profiles;
- determine advertiser audiences;
- personalize ads;
- create behavioral categories;
- send conversation text to an advertising provider.

This remains true even though conversations are retained for the platform's safety/retention system.

Advertising and moderation are separate purposes.

---

## P3 — No Ad Provider Access to Chat Data

Ad SDKs/scripts/providers must not receive:

- message text;
- conversation IDs;
- partner identity;
- report contents;
- moderation classifications;
- IP addresses from application payloads;
- internal session identifiers;
- safety scores.

Only the minimum advertising/consent information required by the chosen advertising platform should be exposed.

---

## P4 — Ads Must Never Block Chat

If advertising fails:

```text
Ad unavailable
      ↓
continue matchmaking
```

Never:

```text
Ad unavailable
      ↓
chat unavailable
```

The chat system must work normally when all advertising services are down.

---

## P5 — Ads Must Be Frequency Capped

Do not show an advertisement on every transition.

The initial implementation should use configurable controls such as:

```text
minimumTimeBetweenAds
minimumConversationsBetweenAds
maximumAdsPerSession
maximumAdsPerDay
```

These values should be configurable without redeploying the backend.

---

# 4. Recommended Ad Placements

## 4.1 Matchmaking / Waiting Screen

This is the preferred initial placement.

Example:

```text
┌──────────────────────────────┐
│                              │
│       Finding someone...     │
│                              │
│          ● ● ●               │
│                              │
│    Usually takes a moment    │
│                              │
│   ┌──────────────────────┐   │
│   │         AD           │   │
│   └──────────────────────┘   │
│                              │
└──────────────────────────────┘
```

Advantages:

- user is already waiting;
- no interruption to conversation;
- natural transition point;
- predictable placement;
- easy to frequency-cap.

---

## 4.2 Between Conversations

When the user presses `Next`:

```text
Conversation
    ↓
Next
    ↓
End current session
    ↓
Matchmaking
    ↓
Optional advertisement
    ↓
New match
```

This is another strong placement because the user has already ended the conversation.

Do not guarantee an ad after every `Next`.

---

## 4.3 Desktop / Large-Screen Side Rail

For sufficiently wide layouts:

```text
┌─────────────────────────────────────────────┐
│ Karobakbak                                  │
├──────────────────────────┬──────────────────┤
│                          │                  │
│      Conversation        │       AD         │
│                          │                  │
│                          │                  │
│                          │                  │
│                          │                  │
├──────────────────────────┴──────────────────┤
│ Message...                         Send     │
└─────────────────────────────────────────────┘
```

This should only appear when there is enough space.

Do not compress the conversation viewport simply to create an advertising slot.

---

# 5. Placements to Avoid

## Never place ads:

- between chat messages;
- inside chat bubbles;
- over the message composer;
- over the report/block controls;
- directly beside safety warnings;
- as fake system messages;
- in a way that looks like a message from the stranger;
- in a way that could be mistaken for platform UI;
- before the first interaction with the product.

Avoid forced full-screen video ads during an active conversation.

---

# 6. Advertising State Machine

Advertising should be represented as explicit application state.

Example conceptual state:

```text
AD_DISABLED
AD_NOT_ELIGIBLE
AD_REQUESTING
AD_READY
AD_DISPLAYING
AD_COMPLETED
AD_FAILED
```

The state must never become part of matchmaking state.

Bad:

```text
WAITING_FOR_MATCH
    ↓
AD_REQUIRED
    ↓
MATCH
```

Prefer:

```text
WAITING_FOR_MATCH
    │
    ├── matchmaking continues
    │
    └── ad opportunity is independent
```

The ad layer is ancillary.

---

# 7. Backend Architecture

Recommended structure:

```text
                    ┌───────────────────┐
                    │ React Frontend    │
                    └─────────┬─────────┘
                              │
                  WebSocket / HTTPS
                              │
                              ▼
                    ┌───────────────────┐
                    │ Node.js Backend   │
                    └───────┬───────────┘
                            │
             ┌──────────────┼──────────────┐
             │              │              │
             ▼              ▼              ▼
        Matchmaking      Safety       Analytics
             │
             ▼
           Redis

Advertising:
Frontend / approved ad integration
            │
            ▼
     Ad provider

No path:
Chat message → Ad provider
```

The backend should control eligibility and frequency rules where practical, while the ad provider controls the actual inventory/fill.

---

# 8. Ad Eligibility

Eligibility should consider platform state, not conversation content.

Potential inputs:

- user/session state;
- time since previous ad;
- number of conversations since previous ad;
- session duration;
- premium status;
- consent state;
- geographic availability where legally and technically required;
- provider availability;
- platform-wide ad enablement.

Do not use:

- message text;
- toxicity score;
- inferred interests from conversation;
- partner identity;
- report contents.

Safety events may suppress advertising for a session when appropriate, but must not become targeting signals.

---

# 9. Frequency-Cap Configuration

Use configuration such as:

```yaml
advertising:
  enabled: false

  frequency:
    minimumSecondsBetweenAds: 240
    minimumConversationsBetweenAds: 2
    maximumAdsPerSession: 5

  placements:
    matchmaking: true
    betweenConversations: true
    desktopSidebar: true
```

These are example starting values, not final product values.

The actual values should be determined experimentally.

---

# 10. Premium Readiness

Design the system so a premium user can be represented as:

```text
entitlements:
  ads: false
```

The application should not require a rewrite when premium subscriptions are introduced.

Potential future premium model:

```text
FREE
├── Random chat
├── Ads
└── Core features

PREMIUM
├── Random chat
├── No ads
└── Additional non-abusive features
```

Do not make premium functionality part of the initial implementation unless needed.

---

# 11. Privacy Boundary

Advertising telemetry and product telemetry must remain distinct.

### Product analytics may track:

```text
match_found
conversation_started
conversation_ended
next_clicked
session_duration
```

### Advertising analytics may track:

```text
ad_request
ad_impression
ad_fill
ad_error
ad_completion
```

Neither should contain chat text.

Avoid passing internal identifiers to advertising providers unless explicitly required and appropriately protected.

---

# 12. Consent and Privacy

Before enabling advertising in a jurisdiction where consent or disclosure requirements apply, establish:

- privacy policy;
- cookie/storage disclosure where applicable;
- consent mechanism where required;
- advertising provider disclosures;
- opt-out mechanisms where required;
- data retention rules;
- vendor/data-processing documentation.

Do not assume that an anonymous chat service is exempt from privacy obligations.

Advertising implementation must be reviewed against the jurisdictions in which the service is actually offered.

---

# 13. Ad Safety

Because Karobakbak contains unpredictable user-generated content, advertisements should be context-independent.

Do not create a system where:

```text
Conversation content
      ↓
content classification
      ↓
advertiser category selection
```

Instead:

```text
User reaches eligible ad placement
      ↓
consent / provider rules
      ↓
generic ad request
      ↓
advertisement
```

Moderation and advertising remain separate.

---

# 14. Failure Handling

Advertising failures must be non-fatal.

Examples:

```text
Provider timeout
Provider unavailable
No fill
Script blocked
Consent unavailable
Ad rendering failure
Network failure
```

All should produce:

```text
log/metric
+
continue product flow
```

Never:

```text
ad failure → matchmaking failure
```

---

# 15. Advertising Metrics

Track:

### Supply

- ad opportunities;
- ad requests;
- filled requests;
- impressions;
- completed ads where relevant.

### Revenue

- estimated revenue;
- realized revenue;
- revenue per 1,000 impressions;
- revenue per active user.

### Product impact

- session duration;
- matches/session;
- Next rate;
- return rate;
- abandonment during ad opportunity.

### Reliability

- ad request latency;
- provider errors;
- rendering failures;
- fill rate.

---

# 16. Revenue Metrics

Core calculations:

```text
ARPU =
monthly advertising revenue / monthly active users
```

```text
Revenue per session =
monthly advertising revenue / monthly sessions
```

```text
Revenue per 1,000 impressions =
advertising revenue / impressions × 1000
```

Do not optimize for impressions alone.

A higher impression count is not necessarily better if it materially reduces retention.

---

# 17. Advertising Experimentation

Start with one placement.

Example experiment:

```text
Control:
No advertisements

Treatment:
Matchmaking advertisement
```

Compare:

- average session duration;
- conversations/session;
- next-match rate;
- return rate;
- revenue.

Only introduce additional placements if the first experiment is economically and experientially acceptable.

---

# 18. Provider Abstraction

Do not hard-code the application around one provider.

Conceptually:

```typescript
interface AdvertisingProvider {
  requestAd(context: AdContext): Promise<AdResult>;
  isAvailable(): boolean;
}
```

Possible providers:

```text
Provider A
Provider B
Direct sponsor
House advertisement
No-op provider
```

A no-op provider is useful:

```text
NoOpAdvertisingProvider
```

for development and testing.

---

# 19. House Ads

Before external monetization is available, the same placement system can display:

- Karobakbak announcements;
- premium promotions;
- feedback requests;
- product experiments.

Example:

```text
[ AD SLOT ]

Help us improve Karobakbak
→ Give feedback
```

This allows the placement system to be tested without requiring a live advertising account.

---

# 20. Architectural Invariants

These must remain true:

1. Chat never depends on advertising.
2. Advertising never receives chat text.
3. Ads never appear as chat messages.
4. Advertising does not control matchmaking.
5. Advertising failures do not break the application.
6. Ad frequency is capped.
7. Premium can disable advertising.
8. Advertising providers can be replaced.
9. Advertising telemetry is separated from conversation data.
10. User safety takes priority over monetization.

---

# 21. Recommended Implementation Order

### Phase 1

Implement the UI slots and abstraction.

Ads disabled.

### Phase 2

Implement:

- eligibility;
- frequency caps;
- telemetry;
- no-op provider.

### Phase 3

Run controlled monetization experiments.

### Phase 4

Add the selected provider after verifying its current policies.

### Phase 5

Optimize placement and frequency only after enough traffic exists to produce meaningful data.

---

# 22. Definition of Done

Advertising architecture is complete when:

- [ ] Ads can be globally disabled.
- [ ] Ads can be disabled per placement.
- [ ] Ads cannot interrupt active messages.
- [ ] Frequency caps are enforced.
- [ ] Premium/no-ad entitlement is supported.
- [ ] Ad provider failure cannot break matchmaking.
- [ ] Conversation text never reaches advertising systems.
- [ ] Ad metrics are available.
- [ ] Revenue metrics are available.
- [ ] Consent/privacy requirements are addressed.
- [ ] Provider integration is replaceable.
- [ ] Advertising can be tested with a no-op/house provider.
