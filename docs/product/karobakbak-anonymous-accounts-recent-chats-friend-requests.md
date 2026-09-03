# Karobakbak — Anonymous Accounts, Recent Chats & Mutual Friend Requests

## Status

**Planned future feature — not for the initial text-chat launch.**

This document defines a future identity, continuity, abuse-prevention, recent-chat, and mutual-connection system for Karobakbak.

Core principle:

> **Anonymous to strangers, persistent enough for safety and optional mutual connections.**

The feature should not turn Karobakbak into a conventional social network.

---

# 1. Product Goals

The system should provide:

1. Anonymous platform accounts.
2. Better abuse prevention than a completely stateless anonymous session.
3. A lightweight history of recent conversations.
4. Mutual opt-in connections through **Friend Requests**.

It should not initially provide:

- mandatory real-name registration;
- mandatory email/phone registration;
- public profiles;
- searchable users;
- unilateral following;
- unilateral reconnection;
- automatic permanent relationships;
- user-visible transcript archives;
- invasive browser fingerprinting as the primary identity mechanism.

---

# 2. Core Product Model

Keep these three concepts separate.

### Anonymous account

A backend identity used for abuse prevention, rate limiting, reports, blocking, recent-chat ownership, friend-request state, and preferences. It does not reveal the user's real identity to strangers.

### Recent chat

A record that:

> "I talked to this anonymous stranger recently."

It provides continuity without automatically creating a relationship.

### Friend connection

A persistent relationship created only when both parties explicitly consent.

```text
Random chat
    ↓
Conversation ends
    ↓
User A sends Friend Request
    ↓
User B sees request
    ↓
User B accepts
    ↓
Friend connection created
```

A single user cannot unilaterally create a permanent connection.

---

# 3. Recommended Identity Architecture

Use a lightweight anonymous account rather than relying entirely on browser sessions.

```text
Browser
   ↓
Anonymous account creation
   ↓
Internal user ID
   ↓
Secure browser credential
   ↓
Session
   ↓
Random matchmaking
```

The user does not need to provide a name, email, phone number, or social account.

The backend still has a stable internal identity.

Example:

```text
Internal:
user_id = UUID

Public:
anonymous identity = Stranger #48291
```

The internal identifier must never be exposed unnecessarily.

---

# 4. Anonymous Identity Requirements

The anonymous identity should be:

- non-identifying;
- server-generated;
- non-user-controlled;
- unsuitable as a security credential;
- replaceable/rotatable where appropriate.

Do not expose database IDs directly if they reveal implementation details.

Do not use sequential IDs such as `User #1`, `User #2`, etc.

A public display identity may be a generated label such as `Stranger #48291` or a generated nickname/avatar system.

---

# 5. Browser Credential

Associate the anonymous account with a secure browser credential.

Prefer:

- HttpOnly;
- Secure;
- appropriate SameSite configuration;
- short-lived session/access tokens where appropriate;
- server-side session validation.

Do not place long-lived identity secrets in localStorage, URLs, WebSocket messages, analytics events, or logs.

Follow the existing Karobakbak session/security architecture.

---

# 6. Account Loss and Reset

Anonymous identity necessarily has weaker recovery than a registered account.

If a user clears browser data, changes browser/device, or loses their credential, the platform may be unable to recover the previous anonymous account.

That is acceptable for the initial anonymous model.

Do not introduce email/phone verification solely to solve this problem. Optional stronger recovery can be considered later.

---

# 7. Anti-Abuse Identity Strategy

Do not use IP address or browser fingerprint as the sole identity mechanism.

A user may legitimately:

- share an IP with many people;
- use a VPN;
- use a corporate network;
- use mobile networks;
- change devices;
- clear browser storage.

A malicious user may also rotate IPs or create new sessions.

Therefore combine multiple signals:

```text
Anonymous account
        │
        ├── session history
        ├── rate-limit history
        ├── report history
        ├── device/account signal
        ├── network signal
        └── behavioral signals
                │
                ▼
            Risk assessment
                │
       ┌────────┼────────┐
       ▼        ▼        ▼
     normal   limited   blocked
```

The system should primarily identify abusive behavior, not identify real people.

---

# 8. Device and Browser Signals

If device-level abuse prevention is introduced, use privacy-conscious signals.

Do not make invasive browser fingerprinting a foundational identity mechanism.

If a device/account abuse token is introduced:

- document exactly what it represents;
- minimize retained information;
- protect it from disclosure;
- define retention;
- define reset behavior;
- account for shared devices;
- account for false positives;
- do not use it for advertising profiling;
- do not sell or share it.

Purpose:

> abuse prevention, not real-world identification.

---

# 9. Progressive Abuse Controls

Do not require heavy verification from every user.

### Normal

```text
Anonymous account
    ↓
Immediate random chat
```

### Suspicious

Possible signals:

- unusually rapid account creation;
- extreme skip frequency;
- excessive message rate;
- repeated moderation violations;
- unusually high report rate;
- repeated reconnect/account cycling;
- automated behavior.

Possible responses:

- tighter rate limits;
- cooldowns;
- reduced matchmaking privileges;
- CAPTCHA;
- temporary restrictions.

### Severe/repeated abuse

Possible escalation:

- account restriction;
- device/account restriction;
- network-level controls;
- stronger verification;
- permanent ban where justified.

Avoid relying on one signal for permanent enforcement.

---

# 10. Recent Chats

Introduce a **Recent Chats** section.

It should answer:

> "Who did I recently talk to?"

without becoming a transcript archive.

Example:

```text
Recent Chats

Stranger #48291
Yesterday
18 min conversation

Stranger #83721
2 days ago
42 min conversation

Stranger #91273
Aug 14
Conversation ended
```

Potential metadata:

- anonymous stranger identifier;
- conversation start time;
- conversation end time;
- duration;
- end reason;
- whether the user skipped;
- whether the partner disconnected;
- friend-request status;
- block/report status.

Do not expose unnecessary internal identifiers.

---

# 11. Do Not Show Full Conversation History Initially

The initial product should **not** expose full historical transcripts to users.

A random anonymous conversation may contain information that the other participant expected to be ephemeral.

For example:

```text
Stranger:
"My name is Sarah."

User:
"Nice to meet you."
```

If the transcript remains user-accessible weeks later, the privacy model changes substantially.

The platform may retain messages for moderation/safety according to its retention policy without making those transcripts available to participants.

These are separate concepts:

```text
Platform retention
        ≠
User-visible history
```

---

# 12. Future Conversation History Decision

Full user-visible transcripts can be reconsidered later.

Before enabling them, evaluate:

- privacy expectations;
- abuse/stalking risks;
- retention duration;
- deletion requirements;
- whether both parties are notified;
- whether either participant can delete their local view;
- whether reported conversations require special handling;
- legal/privacy requirements;
- whether transcripts contain sensitive information.

Do not enable transcript history merely because the database already stores messages.

---

# 13. Friend Requests

The feature should be called:

> **Friend Request**

not "follow", "save user", or "automatic reconnect".

A Friend Request means:

> "I would like to stay connected with this person."

It does not immediately establish a connection.

---

# 14. Friend Request Flow

During or shortly after a conversation:

```text
Current Chat

[Skip]

[Send Friend Request]
```

When selected:

```text
Friend Request sent.

If they accept, you'll stay connected.
```

The other user receives:

```text
Someone from your recent chat
sent you a Friend Request.

[Accept] [Decline]
```

If accepted:

```text
You're now connected.
```

If declined:

```text
Friend Request declined.
```

Do not reveal unnecessary reasons for rejection.

---

# 15. Mutual Consent Requirement

A connection must require:

```text
User A → Friend Request → User B
                           │
                        Accept
                           │
                           ▼
                     Connection
```

Do not allow unilateral permanent reconnection.

---

# 16. Friend Request Eligibility

A Friend Request should normally only be possible when users have actually interacted.

Possible eligibility rules:

- both users participated in the same conversation;
- conversation exceeded a configurable minimum duration if desired;
- neither user has blocked the other;
- neither user has been restricted from connections;
- request is not already pending;
- users have not recently rejected/blocked one another.

Keep thresholds configurable rather than hard-coded.

---

# 17. Friend Request State Machine

Suggested states:

```text
NONE
  │
  ├── send request
  ▼
PENDING
  │
  ├── accept ───────→ CONNECTED
  │
  ├── decline ──────→ DECLINED
  │
  └── expire ───────→ EXPIRED
```

Possible additional state:

```text
BLOCKED
```

Blocking overrides normal connection behavior.

---

# 18. Friend Request Expiration

Friend Requests should not necessarily remain pending forever.

Use a configurable expiration period:

```text
Friend Request
    ↓
pending for N days
    ↓
expires
```

The duration should be configurable.

---

# 19. Connections

Once accepted:

```text
User A
   ↕
Friend connection
   ↕
User B
```

The connection may provide:

- ability to see the connection;
- ability to initiate a future chat if supported;
- connection status;
- remove connection;
- block;
- report.

Do not automatically expose:

- real names;
- email;
- phone;
- location;
- IP;
- device information.

---

# 20. Connection Privacy

Do not expose live presence by default.

Avoid:

```text
Stranger #48291
Online 3 minutes ago
```

which can enable tracking.

Prefer generic availability only when there is a legitimate UX reason.

Presence should be deliberately designed rather than automatically derived from connection state.

---

# 21. Public Identity Rotation

Consider rotating or changing anonymous public identifiers to prevent an unconnected stranger from tracking a user across multiple random chats.

For example:

```text
Random Chat #1
Stranger #48291

Random Chat #2
Stranger #91327
```

while:

```text
Friend connection
    ↓
stable connection identity
```

The exact behavior should be evaluated against UX and abuse risks.

Do not expose a stable public identifier to everyone merely because the backend has a stable user ID.

---

# 22. Blocking

Blocking must be available from:

- active chat;
- Recent Chats;
- Friend Requests;
- Connections.

A block should prevent, where technically feasible:

- future random matching;
- Friend Requests;
- connection interactions;
- direct reconnect attempts.

Do not reveal the blocker's identity.

Prefer generic behavior such as:

> "This connection is no longer available."

---

# 23. Reporting

Reporting remains independent of Friend Requests.

A user should be able to:

```text
Report
Block
```

without accepting or creating a friendship.

A reported user must not gain access to the reporter's identity.

Reports remain tied to internal anonymous account/session/conversation records required by the existing safety architecture.

---

# 24. Recent Chats + Friend Requests

Recommended UX:

```text
My Chats

Recent
────────────────────────

Stranger #48291
Yesterday
18 min
[Friend Request Sent]

Stranger #83721
2 days ago
42 min
[Send Friend Request]

Connections
────────────────────────

Stranger #19482
Connected Aug 18
[Chat] [Remove]
```

Avoid turning the UI into a traditional social network.

The primary product remains:

> meet strangers and have conversations.

Connections are an optional continuity layer.

---

# 25. Recommended Navigation

Possible structure:

```text
Chat
Recent Chats
Friend Requests
Friends
Settings
```

However, do not add all navigation permanently before validating the feature.

A compact initial version may instead be:

```text
Chat
History
```

with Friend Requests and Connections inside History.

---

# 26. Notification Strategy

Friend Requests may require notifications.

Start with subtle in-product notifications:

```text
You have 1 new Friend Request
```

Do not introduce email/push notifications by default unless the product later supports persistent account/recovery.

Notifications should not leak information on shared devices.

---

# 27. Friend Request Abuse Prevention

A malicious user must not be able to spam Friend Requests.

Implement:

- per-user request rate limits;
- per-target request limits;
- duplicate-request prevention;
- pending-request limits;
- rejection cooldowns;
- block-aware checks;
- abuse scoring.

Example:

```text
User A
  │
  ├── request → B
  ├── request → C
  ├── request → D
  ├── request → E
  └── request → F

Too many requests
        ↓
rate limit / cooldown
```

Do not allow unlimited requests merely because accounts are anonymous.

---

# 28. Friend Request Discovery

Do not initially implement:

- global user search;
- "people nearby";
- random friend discovery;
- suggested strangers;
- friend-of-friend discovery.

The discovery path should be:

```text
You actually chatted with this person
        ↓
Friend Request
```

This preserves the random-chat nature of the product.

---

# 29. Data Model

Conceptual model:

```text
users
-----
id
created_at
status
risk_state
...

anonymous_identities
--------------------
user_id
public_identifier
created_at
...

conversations
-------------
id
created_at
ended_at
...

conversation_participants
-------------------------
conversation_id
user_id
...

friend_requests
---------------
id
sender_user_id
recipient_user_id
conversation_id
status
created_at
expires_at
responded_at

friendships
-----------
id
user_a_id
user_b_id
created_at
status
removed_at
```

The actual schema should follow existing project conventions.

Do not duplicate information unnecessarily.

---

# 30. Friend Request Invariants

The backend must enforce:

- sender and recipient are different users;
- both participated in the referenced conversation;
- conversation is legitimate;
- sender is not blocked;
- recipient is not blocked;
- only one active request exists for a pair;
- request cannot be accepted twice;
- request cannot be created after the connection already exists;
- user cannot accept a request they did not receive;
- state transitions are atomic.

Do not rely on frontend checks.

---

# 31. Pair Ordering

For friendship records, use canonical pair ordering where appropriate.

Conceptually:

```text
user_a = min(user1, user2)
user_b = max(user1, user2)
```

This prevents:

```text
A → B
B → A
```

from creating duplicate friendship records.

Use database uniqueness constraints where appropriate.

---

# 32. Redis vs PostgreSQL

Use Redis for ephemeral operational state where appropriate.

Use PostgreSQL as the source of truth for persistent:

- anonymous accounts;
- Friend Requests;
- Connections;
- recent-chat metadata where persistence is required.

Do not rely on Redis alone for Friend Requests or Connections.

Redis may be used for:

- rate limits;
- short-lived request state;
- caching;
- matchmaking;
- online/presence state.

PostgreSQL remains authoritative for persistent relationships.

---

# 33. Recent Chat Retention

Recent-chat metadata should have its own retention policy.

Do not automatically retain it forever.

Example:

```text
Recent chat metadata
    ↓
retained for configurable period
    ↓
automatically deleted
```

Connected friendships can have a longer retention period.

Define separately:

- message-content retention;
- safety/report retention;
- recent-chat retention;
- friendship retention;
- account retention;
- log retention.

Do not use one global retention period for everything.

---

# 34. Deletion

Eventually support:

- remove recent chat;
- remove friend;
- block friend;
- delete anonymous account;
- clear user-visible history.

Distinguish:

```text
User-visible data
        vs
Safety/legal retention
```

Removing a Recent Chat entry must not necessarily delete safety records required by the platform's retention policy.

---

# 35. Privacy Model

The intended model is:

```text
Anonymous to strangers
        +
Known internally as an anonymous account
        +
Optional mutual connection
        +
Minimal persistent identity
```

Do not claim:

> "We know nothing about you."

The platform necessarily processes technical and safety metadata.

Instead, accurately explain what is collected, why, and for how long.

---

# 36. User Experience Principle

The user should never feel that they accidentally joined a social network.

Random chat remains the primary action:

```text
[ Start Chat ]
```

Friend Requests should feel like an optional reward for a good conversation:

```text
Had a good conversation?

[ Send Friend Request ]
```

rather than a social-growth mechanism.

---

# 37. Suggested Conversation-End UX

When a conversation ends:

```text
Conversation ended

You talked for 24 minutes.

[Find Another Stranger]

────────────────────

Enjoyed talking to them?

[Send Friend Request]
```

If sent:

```text
Friend Request sent.

If they accept, you'll stay connected.
```

If accepted later:

```text
Friend Request accepted!

You're now connected with this stranger.
```

Keep this lightweight and avoid interrupting the primary chat flow.

---

# 38. Friend Request After Conversation Ends

Allow a short configurable period after a conversation to send a Friend Request from Recent Chats.

This helps when:

- the user forgot to request during the conversation;
- the connection dropped unexpectedly;
- the user decided afterward that they enjoyed the interaction.

The request must still be tied to the actual conversation.

---

# 39. Anti-Stalking Design

Avoid:

- global search;
- stable public identifiers across every random chat;
- automatic reconnect;
- exact last-seen timestamps;
- precise presence history;
- location sharing;
- exposing account creation date;
- exposing network/device information;
- allowing repeated requests after rejection;
- unlimited Friend Requests;
- showing blocked users as discoverable.

Mutual connection should be the boundary at which persistent identity becomes useful.

---

# 40. Analytics

Measure usefulness without collecting unnecessary content.

Useful metrics:

- percentage of conversations where Friend Request is offered;
- request-send rate;
- acceptance rate;
- rejection rate;
- expiration rate;
- connections per active user;
- repeat conversations;
- Friend Request spam rate;
- blocks following connection;
- reports following connection;
- connection removal rate.

Do not record message contents as analytics.

Do not use Friend Request data for advertising profiling without separately defining the privacy implications.

---

# 41. Rollout Plan

## Phase 1 — Anonymous Account Foundation

Implement:

- anonymous user entity;
- secure session/browser credential;
- account lifecycle;
- abuse signals;
- rate-limit association.

No Friend Requests yet.

## Phase 2 — Recent Chats

Implement:

- recent-chat metadata;
- retention;
- History UI;
- deletion/clear behavior.

Do not show transcripts.

## Phase 3 — Friend Requests

Implement:

- send;
- receive;
- accept;
- decline;
- expiration;
- rate limiting;
- notifications;
- state machine.

## Phase 4 — Connections

Implement:

- persistent connection;
- Connections UI;
- reconnect/chat initiation if supported;
- remove connection;
- block/report.

## Phase 5 — Evaluate

Measure:

- engagement;
- repeat users;
- request acceptance;
- abuse;
- stalking/harassment reports;
- infrastructure/storage cost;
- privacy complaints.

Only then consider additional social functionality.

---

# 42. What NOT to Build Initially

Do not build:

- full social profiles;
- profile photos;
- usernames searchable by everyone;
- followers/following;
- public friend lists;
- public activity feeds;
- full transcript history;
- contact importing;
- email-based friend discovery;
- phone-based friend discovery;
- location-based discovery;
- friend recommendations;
- friend-of-friend recommendations;
- live public presence;
- social feeds.

These would substantially change Karobakbak's product identity.

---

# 43. Architectural Integration

Integrate with the existing architecture:

```text
                         Karobakbak
                             │
          ┌──────────────────┼──────────────────┐
          │                  │                  │
      Matchmaking        Conversations       Identity
          │                  │                  │
        Redis             PostgreSQL          PostgreSQL
                             │                  │
                             └────────┬─────────┘
                                      │
                              Friend Requests
                                      │
                                  Connections
```

Future WebSocket events can include:

```text
friend_request.send
friend_request.received
friend_request.accept
friend_request.decline
friend_request.expired
friend_connection.created
friend_connection.removed
```

These events must be server-authoritative.

Clients must never directly mutate friendship state.

---

# 44. Security Requirements

All Friend Request operations must be:

- authenticated to the anonymous platform account;
- authorized server-side;
- rate-limited;
- validated;
- safe to retry/idempotent where appropriate;
- protected against replay;
- protected against duplicate requests;
- protected against race conditions.

Do not put sensitive information in WebSocket error responses.

Do not expose internal IDs unnecessarily.

Do not log message content while implementing this feature.

---

# 45. Migration Strategy

When implementing later:

1. Add anonymous account schema.
2. Associate existing sessions with anonymous accounts.
3. Preserve current random matchmaking behavior.
4. Add recent-chat metadata.
5. Add retention jobs.
6. Add Friend Request schema.
7. Add server-side state machine.
8. Add UI.
9. Add abuse controls.
10. Add Connections.
11. Roll out gradually.

Do not migrate historical conversation content into user-visible history merely because the platform already retains it.

---

# 46. Success Criteria

The feature is successful if:

- users can return and see meaningful recent-chat context;
- users can request friendship after a good conversation;
- the recipient has complete control over acceptance;
- connections are mutual;
- random-chat anonymity remains intact;
- abuse does not become significantly easier;
- Friend Request spam is controlled;
- users do not gain a stalking mechanism;
- the UI remains centered on random conversation;
- infrastructure cost remains predictable;
- privacy expectations remain clear.

---

# 47. Final Product Philosophy

Karobakbak should sit between two extremes:

```text
Completely ephemeral anonymous chat
              │
              │
              ▼
        Karobakbak
              │
              │
              ▼
Traditional social network
```

The intended position is:

> **Meet strangers anonymously. Keep the conversations that matter through mutual consent.**

A user should be able to have a great conversation and think:

> "I'd actually like to talk to this person again."

The mechanism is simple:

```text
Send Friend Request
        ↓
They choose
        ↓
Accept
        ↓
Stay connected
```

No forced registration.
No public social graph.
No unilateral tracking.
No automatic reconnection.

Just mutual consent.
