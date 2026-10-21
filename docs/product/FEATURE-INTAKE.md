# Feature intake — four proposals, triaged

Requested 2026-08-31. Each one is checked against the decisions it touches
before any of it is built, because two of the four are already specified
elsewhere in this repository and one collides head-on with the property the
whole product rests on.

**Build order: 4, 3, 2, 1.** It is close to the reverse of the order they were
asked for, and the reason is dependency rather than preference: 4 stands alone,
3 extends machinery that shipped this week, and 1 cannot exist before 2.

| # | Feature | Status | Blocked on |
| --- | --- | --- | --- |
| 4 | Double-tap to react | **Shipped** | — |
| 3 | Intent-driven matching | **Shipped** (D45, §30) | — |
| 2 | Anonymous friend saving | **Shipped** (D47, §31) | A Cognito pool, to turn sign-in on |
| 1 | Recent history reconnect | **Next** | A Cognito pool, and a review of the child-safety position |

---

## 4. Double-tap to react

*Like or heart a specific message.*

**The only one of the four with no architectural collision**, and the only one
that needs neither accounts nor premium. It ships to everybody.

### What it needs

* A client event and a server event. `CLIENT_EVENTS` and `SERVER_EVENTS` are
  lists and `connected.features` announces what is on, so this needs no protocol
  version bump (§23.3, §24.4).
* A rate limit. `RateLimitedCommand` is derived from `ClientEventType`, so a new
  client event **is a compile error until somebody decides what rate it may be
  sent at**. That is the seam working as intended.
* Addressing by `message_id`, which already exists on the wire.

### Decided: ephemeral

Not written to PostgreSQL, not in the retained transcript. A reaction rides
Pub/Sub the way `typing` does — delivered if the partner is there, gone if not.

The reasoning is D43's. A stored reaction is a new retained record type, a new
moderation surface and a new thing the console must render, for a feature whose
entire value is being lightweight.

The cost, stated plainly: a reaction sent while a partner is away is lost, and a
reaction never appears in the evidence a moderator reads. Neither matters for a
heart on a message, and both would matter for anything carrying content — which
is the line this stays on the right side of.

### What it must not become

A reaction is a pointer and a fixed symbol. It is not free text, it is not an
arbitrary emoji, and the set is closed for the same reason `GENDERS` and `VIBES`
are closed — an open set is a content field that would need moderating like a
message body, arriving through a path built to carry no content.

---

## 3. Intent-driven matching

*Lightweight intent — moods, interest tags — used to match better, never shown
to the other side.*

**Most of this shipped this week.** D44 and §29 built preference matching as a
weighted score inside candidate sampling: gender 4, country 2, vibe 1, highest
wins, longest-waiting breaks a tie, and a preference that finds nobody takes an
ordinary partner on the same pass. Adding a dimension is adding a term to that
score.

### Decided: intent replaces vibe — SHIPPED as D45, §30

One selector, **never shown to the other side**, used only for matching.

**Built with one thing decided that this triage did not anticipate: it is free,
not premium.** "One selector" turned out to settle it. A single control means
the value is matched by *equality* against the other person's own declaration
rather than by membership in a preference list — which makes it symmetric, and
symmetry is what D37's objections attach to the absence of. There is no
selected party, so there is nothing to sell. Gender and country stay premium.

Two consequences worth reading in §30: intent is excluded from the wide-sample
escalation, which is what makes free affordable; and `flirty` did not survive
the move, because a declaration nothing read is not the same object as a
free, default-on matching signal (§30.4).

`vibe` as a public declaration goes away. It was one of two things it could have
been and this picks the other: a private matching signal rather than a label on
a stranger. That removes the two-mood-selectors problem before it exists, and it
removes a field from what a partner sees — which is the direction this product
normally travels anyway.

**The UI carries the whole weight of that claim.** A user choosing "venting"
must be told, at the point of choosing, that it is used to find them somebody
and is not displayed. If that sentence is not next to the control, the feature
is indistinguishable from the public vibe it replaces and people will assume
they are broadcasting it.

Migration note: `pVibe` on the session hash and the `vibe` profile field already
ship. Replacing rather than adding means the profile loses a field and the
matching gains a private one — the wire type changes, `verify-protocol` will
catch the frontend copy, and `summariseProfile` stops mentioning it.

### One honest limit on "not shown to the other side"

The intent is not displayed, and the matching still leaks it probabilistically:
two people paired on "venting" are more likely than chance to share it. That is
weak and it is not nothing, and the copy should say the intent is not *shown*
rather than that it is not *knowable*.

### What it does not need

No new storage shape. Intent rides the session hash beside `prefG`/`prefC`/
`prefV`, dies with the session, and is re-sent on every join — the same rules as
the profile and the preference, so no cross-chat correlator appears (D34, §24.3).

---

## 2. Anonymous friend saving

*Both click "Save Connection" → they become friends and can talk later. Sign-in
required to see friends. No past conversation stored.*

**Already specified.** `docs/product/karobakbak-anonymous-accounts-recent-chats-friend-requests.md`
covers this, `DESIGN.md` §24 records the deferral, and
`backend/src/storage/migrations/010_accounts.sql` is written and applied.

The migration is phase 1 of four: the account entity, then credentials, then
connections, then recent-chat metadata. Its own header says what it deliberately
excludes and names the line to defend in review — *if a foreign key from
`accounts` to a conversation ever appears, the separation is gone and so is the
anonymity claim*.

### What is right about the proposal as described

**Mutual consent is the correct shape** and matches the specification. One-sided
saving would make a stranger's future contactability something they did not
agree to.

**"No past conversation stored" is already the rule**, not a concession. §24.3
records that retention is not a history feature: no participant-facing path
returns message content in any phase, by any route.

### What it costs, precisely

Child safety relies on the age gate plus reporting and moderation, and stronger
measures are on the roadmap. Part of the reasoning for that position is
structural: pairing is random, there is no search, no profile browsing, and
declared profiles are not filterable (D37).

This feature builds a friend list, and Feature 1 builds a way to ask a specific
earlier partner to talk again. Both rest on mutual consent, so a person still
cannot be *selected*, only re-contacted by agreement, but the child-safety
reasoning has to be revisited deliberately as they ship rather than found in
review.

---

## 1. Recent history reconnect

*A history list of recent partners, and a request to talk again. The other side
sees a notification with accept, reject and block. The requester is told whether
it succeeded, not what the other person chose.*

**The furthest from buildable, and the collision is worth understanding before
any of it is designed.**

### What the proposal gets right

**Not revealing the choice is the correct design** and it should survive into
whatever gets built. Reject and "not online" and "never saw it" must all look
identical to the requester, or the acknowledgement becomes a probe.

### The collision

A "recent connections" list is a durable, per-person record of who talked to
whom. That is the cross-chat correlator §24.3 and D34 exist to prevent, and the
reason the declared profile is re-sent by the browser on every join rather than
stored against anything.

This is not fatal — the accounts document specifies exactly this as phase 4, so
there is a designed way to have it. It is fatal to bolting it onto the anonymous
path, which is what "a history link" sounds like. It requires an account on both
sides, and two people who both chose to be re-contactable.

### The sharper problem: the hovering notification

Delivering a request to somebody *right now* requires knowing they are online
right now. §24.3 forbids exactly that:

> Presence is aggregate and stays aggregate. Never a per-user online flag, never
> a last-seen timestamp, never presence history — for a stranger *or* for a
> future connection. Accounts doc §20 and §39 name this as a stalking primitive.

A live "X wants to connect" popup is a per-user presence read in everything but
name, and the feature that makes it feel natural is exactly the one §24.3
predicted would make it feel natural.

**The resolution is the requester's own instinct, extended.** The request is
sent, not targeted at a live session: it is delivered if the recipient happens to
be connected, waits if not, and expires. The requester is told "sent" and
nothing else — no delivered receipt, no read receipt, no online indicator.
That satisfies the feature and leaks no presence.

### Dependency

Feature 2 first. There is no list of past partners to show until there is an
account to hang it on, and no way to re-contact somebody who never agreed to be
re-contactable.

It also carries the same §6 rewrite feature 2 does, and the larger half of it:
"no way to request a specific partner" is this feature's entire description.

---

## Sign-in: Cognito, decided

**BUILT 2026-09-01 (D48, §32), against plain OIDC rather than a Cognito SDK.**
Everything below still holds, with one thing decided during the build that this
section had not settled: **sign-in is free.** It gates connections, history and
friend requests, none of which is a scarcity worth selling. The `AuthModal` on
disk gates itself on `PAYMENTS_ENABLED`, which had it backwards, and it is a
magic-link form predating the redirect decision — it needs replacing, not
enabling. One other departure, recorded in §32.3: the provider's `sub` is
`accounts.external_id` rather than `accounts.id`, on this section's own words
that Cognito is the credential and not the account.

**Decided 2026-08-31: AWS Cognito, not a self-built credential.** The deciding
requirement is **verification** — users are to be verified for sign-in and for
premium — and that is the one thing a bearer token cannot supply.

The earlier draft of this section argued the other way on the grounds that
losing an account costs only a friends list, so "we cannot recover this for you"
was acceptable. **Premium makes that false.** An unrecoverable paid account
produces a chargeback, and recovery needs an identifier that survives a cleared
browser. That is Cognito's home ground and it is a fair reason to take it.

### Cognito authenticates an email. Nothing more is expected of it

Decided, and worth writing down because the opposite assumption is the common
one: **Cognito proves somebody controls an email address.** It is not asked to
verify a person, an age, or a payer.

Premium binding is ours. A Razorpay payment is tied to the account, and there is
deliberately **no requirement that the payer and the account holder be the same
party** — somebody paying for a friend is a normal thing to do and refusing it
would cost more than the fraud it prevents.

**Tie the payment to `accounts.id`, not to the email string.** Two reasons, and
both bite later rather than now: an email address in Cognito can be changed by
its owner, which would silently orphan the payment record; and an email in the
payments table puts personal data in a place whose retention is set by financial
record-keeping law rather than by this product's own policy. `accounts.id` is a
stable opaque key and belongs in both.

### How to adopt it without giving up more than the decision costs

* **OAuth2 authorization-code flow with PKCE, exchanged server-side.** The backend exchanges the code and
  validates against the JWKS endpoint; **no Cognito SDK in the browser**. That
  keeps `img-src`/`script-src` unchanged and the browser's only third-party
  contact is one visible redirect, rather than a script on every page load.
  `form-action` gains the Cognito domain.
* **`ap-south-1`.** The user pool holds Indian users' email addresses and the
  operator is in India; a US region would add a cross-border transfer question
  under the DPDP Act for no benefit.
* **Cognito's `sub` maps to `accounts.id`.** Migration 010 still applies
  unchanged — the account entity, its status, its risk state and its retention
  deadline stay in this database. Cognito is the credential, not the account.
* **The anonymous path never touches it.** Chatting must keep working while
  Cognito is unreachable; only sign-in and premium may fail. This is the line
  migration 010 already names, from the other direction.
* **Collect the email, and stop there unless a field has a named use.** Every
  attribute collected becomes a row in the Privacy Policy's data table with its
  own retention period, on a service whose central claim is that it holds
  nothing about anybody. "Whatever we need" is the wrong default here; "what is
  this for, and when is it deleted" is the question each field has to answer.

### Decided: no age at sign-up, and no attestation either

Not asked, not stored. An attestation was drafted as the middle option and is
not needed.

The age gate already does this job (with reporting and moderation behind it).
Anybody reaching a
sign-in has passed it, so an account-level age would restate an answer already
given — while being durable and attached to an identity, which the gate
deliberately is not (D34, §24.3).

It also avoids the failure the middle option only reduced: a stored age **looks
like** age assurance, and §26.4 is explicit that none of this is. Holding a
self-declared age you relied on is a weaker position than holding none.

**The account therefore stores an email address and nothing else about a
person.** That is worth stating as an achieved property rather than an absence:
it makes the Privacy Policy's new data row a single line with one retention
period, and it keeps "we know almost nothing about you" true even for users who
sign in.

### What this costs, as tasks rather than objections

1. The Privacy Policy names each processor individually. Cognito becomes one,
   which is a **14-day notice** on the persona precedent.
2. Email address is a new category of personal data for a service whose policy
   currently describes none. The data table in the policy gains a row, with its
   own retention period.
3. `docs/policies/JURISDICTIONS.md` records where data sits; a user pool in
   `ap-south-1` belongs in it.
4. The CSP gains a `form-action` entry, and the Privacy Policy's "the browser
   makes no third-party requests" sentence becomes false as written — it needs
   amending to except the sign-in redirect.

None of these blocks the build. All four are cheaper to do while the code is
being written than to discover in a policy review, which has already happened
once on this project.
