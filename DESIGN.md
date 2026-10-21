# karobakbak — Design Document

Authoritative design record. Written before implementation and checked against
it in §22.

**Revision 4** — makes the platform future-ready for optional image, voice and
video without implementing any of them and without provisioning any media
infrastructure. One field changes on the wire and in the schema: a message
**content-type discriminator**. Everything else is a documented boundary. §23
is the full statement, including what is deliberately *not* built and why.

**Revision 3** — removes application-level message encryption. Message content
is now ordinary plaintext application data inside an explicitly defined trusted
boundary (§2.1), protected by transport encryption, network isolation,
least-privilege database credentials, storage encryption at rest, encrypted
backups and access control. The persistence path gains a circuit breaker, a
priority-aware bounded queue and an explicitly non-durable outage spool. §18.2
is the updated threat model; R12 in §1.2 records the decision.

**Revision 2** — reconciles the design with the six product documents in
`docs/`. The material change is that **conversations are now retained**, which
retires the original "nothing is ever persisted" invariant and adds a retention,
moderation and evidence subsystem. §1.2 records every reconciliation decision
and its source.

---

## 1. Scope

### 1.1 Document set

| Document | Role |
|---|---|
| `DESIGN.md` (this file) | Authoritative technical contract. Wins on conflicts of fact |
| `docs/product/karobakbak-security-safety-architecture.md` | Security, safety, privacy, moderation, retention requirements |
| `docs/product/karobakbak-frontend-ui-ux-spec.md` | Frontend UI/UX direction and product states |
| `docs/product/karobakbak-anonymous-accounts-recent-chats-friend-requests.md` | **Future** identity, recent chats and mutual connections. Not MVP; see §24 |
| `docs/product/karobakbak-advertising-architecture.md` | Advertising boundary and invariants |
| `docs/product/karobakbak-running-ads-and-monetization-plan.md` | Monetization staging |
| `docs/product/karobakbak-monetization-financial-plan.md` | Cost/revenue model |
| `docs/product/karobakbak-cost-calculation-and-feature-rollout-plan.md` | Infrastructure cost gates and rollout triggers |
| `PHASES.md` | Build order and status |
| `docs/PROGRESS.md` | Per-phase record of what shipped and why |

### 1.2 Reconciliation decisions

Conflicts between the original brief and the product documents, and how each was
resolved. **No requirement was silently weakened**; where a requirement was
overridden, the override is recorded here with its authority.

| # | Conflict | Resolution | Authority |
|---|---|---|---|
| R1 | Original brief: "chat history must be completely ephemeral, no message content persisted anywhere". Security doc §2.3/§25–30, cost doc §58, ads doc §P2: conversations are intentionally retained | **Retention wins.** Messages are stored with an explicit retention period, deletion worker, legal-hold state and audited access. Invariant I8 is rewritten (§4) — text still never reaches Redis at rest, logs, metrics or files; the PostgreSQL conversation store is its *only* resting place. *(Revision 3, R12: those rows are plaintext inside the trusted boundary of §2.1, not ciphertext — this row said "encrypted" when it was written and no longer does.)* | Owner decision, 2026-08-18 |
| R2 | Frontend spec names the product "BakBakBox"; every other document and the repository say "karobakbak" | **karobakbak** everywhere, including user-facing copy. The frontend spec's naming is treated as superseded | Owner decision |
| R3 | Security §11 suggests a 500-character message limit; the config default was 2000 | Default lowered to **500**, still configurable. 500 is ample for chat, quarters the storage footprint (cost doc §18) and shrinks the moderation and frame budget | Security §11 + cost §19 |
| R4 | Security §10 requires replay protection (reject duplicate message ids); revision 1 declared `message` non-idempotent with an opaque client id | `id` becomes **required** on `message` frames and is deduplicated per match in Redis with a TTL and a size cap. `message` becomes idempotent within the dedupe window | Security §10 |
| R5 | Cost doc §14/§26 says start with one Node instance and no load balancer; the compose file runs two backends behind nginx | Both. The architecture is instance-count agnostic; **compose runs two backends to prove cross-instance correctness locally**, and the README states production starts at one instance until the §27 scaling trigger fires | Cost §26–27 |
| R6 | UI spec wants filters (country/language/interests); thin early traffic matches worse when segmented | **Seam only.** Queue keys are segmented (`chat:queue:{segment}`) and every script takes a segment argument, but only the `default` segment is implemented. Filters later become configuration plus UI, not a rewrite of the matchmaking core | Owner decision |
| R7 | Security §12 requires per-command rate limits; revision 1 rate-limited only `message` | Every state-changing command gets its own Redis token bucket with independent limits | Security §12 |
| R8 | Security §14 requires per-IP *concurrent* connection limits; revision 1 had only a per-IP attempt rate | Both are enforced. Concurrent count is tracked cluster-wide in Redis with a TTL-guarded counter | Security §14 |
| R9 | Security §6 forbids an allow-any origin policy; revision 1 permitted an empty allowlist with a warning | Empty allowlist is a **startup failure** when `NODE_ENV=production`, and a warning otherwise | Security §6 |
| R10 | Security §36 warns against a second undocumented copy of message text in Redis. Cross-instance delivery publishes text over Redis Pub/Sub | Permitted and documented: Pub/Sub payloads are transient, never written to a key, and Redis runs with persistence disabled. Called out explicitly in §7.4 so it is not an undocumented copy | Security §36 |
| R11 | Ads docs require ad state; matchmaking must stay unpolluted | Advertising is **frontend-only** in this design. The backend exposes no ad endpoint, holds no ad state, and matchmaking cannot observe ad state. Invariant I13 | Ads §6, §20 |
| R12 | Revision 2 mandated application-level AES-256-GCM on message bodies (old D15). Security §28 only says *"**If** application-level encryption is used…"* — it is conditional, never required. §27 requires encryption **at rest** and **in transit**, which storage-layer encryption satisfies | **Application-level encryption removed.** Messages are stored as plaintext inside the trusted boundary of §2.1. This does not contradict the security document: nothing in it mandated column-level cryptography. Threat model updated in §18.2, which states exactly which attackers this stops protecting against | Owner decision, revision 3 |
| R13 | The accounts document (§20, §39) forbids per-user presence and exact last-seen as a stalking vector. The `presence` event reports live counts | **Presence stays aggregate, permanently.** `presence` carries cluster-wide `{ online, conversations }` and nothing per-user: no last-seen, no per-partner online state, no presence history. This is not a placeholder to be refined later — a per-user presence field is the stalking primitive the document names, and it must not appear even once connections exist. *Revised since, deliberately: saved connections see each other's online dot (§31), and since D65 roughly when each other were last here. The `presence` event itself is still aggregate.* | Accounts doc §20, §39 |
| R14 | The accounts document (§5) requires the account credential to be an HttpOnly cookie and forbids long-lived identity secrets in browser storage. The current design has a browser-persisted client token behind `clientHash` (D18) | **Both, kept strictly apart.** The client token is a *block dimension only*: it authorises nothing, is deliberately weak and rotatable, and is never read as identity (rule 3). When anonymous accounts land they get their own HttpOnly, server-validated credential; the block token is **not** promoted into it. Promoting it would turn a value the design describes as trivially rotated into an authentication secret | Accounts doc §5, D18 |
| R15 | The accounts document (§11, §12) forbids user-visible transcripts, while §8 of this design retains message bodies for 30 days | **Retention is not a history feature.** No client-facing endpoint, WebSocket event or admin convenience returns message content to a participant. Retention exists for abuse investigation under I11 (authenticated, role-checked, purpose-scoped, audited). "The database already has it" is explicitly not a reason to serve it | Accounts doc §11, I11 |
| R16 | `PHASES.md` deferred the moderation console behind "reports become frequent enough to need triage tooling" (cost §40). Building it early means the console exists before there is a queue to work | **Pulled in, and the trigger is retired.** The deferral assumed the console's value was throughput. It is not: it is the *only* thing that makes I11 real. Until phase 13 the `enforcement` table could be written and expired but was read by nothing, so a ban was a record of an intention — and any future triage tooling would have been built on top of a sanction that did nothing. Security §29's access ladder is also easier to honour before habits form around a database client. See §25 | Owner decision, 2026-08-20 |
| R18 | UI copy and §1 describe a product with "no profiles"; phase 14 lets a user declare a name, age, gender and country | **The feature wins and the copy changes.** A claim the interface visibly contradicts costs more than it buys, so the landing copy says "no signup" and, once something is declared, "nothing kept after you leave". What is *not* conceded: there is still no account, no credential, and nothing the server keeps between sessions (§26.2) | Owner decision, 2026-08-20 |
| R19 | Accounts doc §21 and §24.3 forbid anything stable across matches, because a stable handle is a correlation primitive. A user-chosen name is stable across matches by definition | **The rule binds the system, not the user.** The server generates nothing stable, stores nothing between sessions and offers no way to recognise a returning visitor; the *browser* holds the declaration and re-sends it. A person choosing to introduce themselves the same way twice is making their own disclosure, which is categorically different from the service maintaining a handle for them. Residual risk stated plainly: a distinctive declared name is a self-inflicted correlator, and the interface says every stranger sees it | Accounts §21, §24.3 |
| R17 | Security §29 describes a four-role access ladder (moderator, senior moderator, security administrator, infrastructure administrator). Phase 13 ships **one** role | **The ladder is in the schema, not in the code.** `admin_accounts.role` carries the full vocabulary and every `admin_audit` row records the acting role, so rows written today stay meaningful when the scopes separate. Only `moderator` is issued, and no route branches on role yet: a role check that nothing distinguishes is theatre that reads like a control. Adding a scope later is a route change, not a migration | Security §29 |

### 1.3 Explicitly out of MVP scope

Deferred with the trigger that would pull them in. None of these are silently
dropped — each is a named later phase in `PHASES.md`.

* External/AI content classifiers (cost §20–21 — local rules only until abuse volume justifies spend).
* Stronger child-safety measures (security §23–24): automated grooming detection and age assurance are on the roadmap. Today child safety relies on the age gate plus reporting and moderation.
* **Anonymous accounts, recent chats, friend requests and connections.**
  Specified in `docs/product/karobakbak-anonymous-accounts-recent-chats-friend-requests.md`
  and deliberately not built. §24 records what that document constrains about
  the code being written now, the seams that already exist, and the two
  questions it leaves open. Premium entitlements and mini-games stay deferred
  under the same trigger (UI §39).
* **Images, voice and video.** The product is text only. §23 defines the
  boundaries that keep these cheap to add later; none of the infrastructure —
  object storage, CDN, STUN, TURN, SFU, media servers, media moderation — is
  built or provisioned. Expansion triggers are in §23.8.
* Filters beyond the `default` segment (R6).
* Multi-region, Kubernetes, managed Redis/DB, read replicas (cost §39).
* Human moderation operations (cost §14).

---

## 2. Architecture overview

```
                     ┌───────────────────────────────────────────┐
                     │              Browser (React)              │
                     │  useChat() — WS client + local FSM        │
                     │  ad slots (frontend-only, no backend tie) │
                     └───────────────────┬───────────────────────┘
                                         │ wss:// (same origin, /ws)
                     ┌───────────────────▼───────────────────────┐
                     │   Edge: CDN / WAF / TLS termination        │  (production)
                     └───────────────────┬───────────────────────┘
                     ┌───────────────────▼───────────────────────┐
                     │        nginx (frontend container)          │
                     │  static SPA + CSP/security headers         │
                     │  reverse-proxies /ws, round-robin upstream │
                     └──────┬─────────────────────────┬──────────┘
                            │                         │
                  ┌─────────▼────────┐      ┌─────────▼────────┐
                  │   Backend A      │      │   Backend B      │
                  │ node http + ws   │      │ node http + ws   │
                  │ Map<sid, Conn>   │      │ Map<sid, Conn>   │
                  │ moderation (local)│     │ moderation (local)│
                  │ /health /ready   │      │ /health /ready   │
                  │ /metrics         │      │ /metrics         │
                  └───┬─────────┬────┘      └────┬────────┬────┘
                      │         │                │        │
        Lua (EVALSHA) │         │  Pub/Sub       │        │ write-behind
                      │         └────────┬───────┘        │ (bounded queue,
                      │                  │                │  batched, breaker)
                 ┌────▼──────────────────▼─────┐   ┌──────▼─────────────┐
                 │           Redis 7            │   │    PostgreSQL      │
                 │ authoritative live state     │   │ conversations      │
                 │ queue / sessions / matches   │   │ messages (plaintext│
                 │ rate limits / blocks / dedupe│   │   application data)│
                 │ ev:session:{sid} channels    │   │ reports / blocks   │
                 │ persistence DISABLED         │   │ moderation / audit │
                 └──────────────────────────────┘   │ retention + holds  │
                              ▲                     └──────┬─────────────┘
                   scrape     │                            │
                 ┌────────────┴───────────┐        deletion worker
                 │ Prometheus  →  Grafana │        (expiry, legal hold)
                 └────────────────────────┘

     ══════════════ trusted boundary (§2.1) ══════════════
     Node.js process memory · bounded queue · outage spool · PostgreSQL
     Message content is plaintext inside this boundary and is protected by
     transport encryption, network isolation, least-privilege credentials,
     storage encryption at rest, encrypted backups and access control —
     NOT by application-level encryption.
```

**Core statement, unchanged from revision 1:** a backend process holds no
authoritative matchmaking state. It owns file descriptors and a
`Map<sessionId, Connection>` used only to find a local socket. Every decision
about who is searching, who is matched with whom, and whether a match is alive
is a Redis Lua script.

**Added by revision 2:** the backend also owns a *write-behind* path to
PostgreSQL for retained conversation data. That path is deliberately
non-blocking — chat delivery never waits on the database (§14.3).

**Changed by revision 3:** application-level message encryption is removed.
Message content is ordinary application data inside the trusted boundary
defined in §2.1, and the security of that data is an infrastructure property,
not a cryptographic one implemented in this codebase.

### 2.1 Trusted security boundary

Everything inside this boundary handles message content as plaintext, by
design:

```
┌──────────────────────────── TRUSTED BOUNDARY ───────────────────────────┐
│                                                                          │
│  Node.js process memory                                                  │
│    · inbound frame buffers                                               │
│    · validation, moderation, rate limiting                               │
│    · bounded in-memory persistence queue                                 │
│                                                                          │
│  Outage spool (local file or Redis list)                                 │
│                                                                          │
│  PostgreSQL                                                              │
│    · messages.body — plaintext column                                    │
│                                                                          │
└──────────────────────────────────────────────────────────────────────────┘
        ▲                                                    ▲
        │ WSS/TLS only                                       │ TLS + auth +
        │ (no plaintext on the wire)                         │ private network
    ┌───┴────┐                                        ┌──────┴──────┐
    │ Client │                                        │  Operators  │
    └────────┘                                        │ (restricted,│
                                                      │  audited)   │
                                                      └─────────────┘
```

Message content is protected by, in order of the attack it defeats:

| Control | Defeats |
|---|---|
| WSS/TLS client ↔ edge ↔ backend | network interception, passive tapping |
| Private database networking; PostgreSQL never published to the internet | remote database access from outside the deployment |
| Authenticated connections with **least-privilege** credentials (app role has `SELECT/INSERT/UPDATE/DELETE` on its tables only — no `SUPERUSER`, no `CREATE`, no access to other databases) | credential blast radius, lateral movement |
| Storage/volume **encryption at rest** | stolen disks, stolen snapshots, decommissioned media |
| **Encrypted backups** with restricted access and defined retention | stolen or leaked backup archives |
| Filesystem permissions on the spool (`0600`, dedicated non-root owner, dedicated directory) | other local processes/users on the host |
| Infrastructure access controls, restricted administrative access, audited operator access | casual and opportunistic insider access |
| Logging/metrics field denylist (§18) | accidental leakage into observability systems |

Application-level encryption is **not** part of this architecture. §18.2 states
precisely what that does and does not protect against, without pretending
either that plaintext storage is inherently unsafe or that it is free.

---

## 3. Major design decisions and tradeoffs

Revision 1 decisions D1–D14 stand. D15–D24 are new.

| # | Decision | Rationale | Tradeoff accepted |
|---|---|---|---|
| D1 | All live state transitions are single Redis **Lua scripts** | Lua runs atomically in Redis; a transition cannot interleave with another instance's | Non-trivial logic outside TypeScript; covered by integration tests against real Redis |
| D2 | Waiting queue is a **SET**, not a LIST | Random pairing is required; a SET also makes "at most once in queue" structural | `SRANDMEMBER` is non-deterministic ⇒ needs effect replication (Redis ≥ 5) |
| D3 | Sample **K candidates**, prefer the oldest `enqueuedAt` | Pure `SPOP` can starve an unlucky waiter; sampling K bounds worst-case wait while staying random | K extra HGETs per attempt, bounded by config |
| D4 | **Enqueue self, then scan** | Lua serialises racers, so the second must see the first. "Both see an empty queue" is impossible | The scanning script must exclude and re-validate itself |
| D5 | `chat:user_match:{sid}` is the truth for "in a match" | One `GET` answers the hot-path authorisation question | Denormalised against the match record; reconciled in every script that touches both, plus the janitor |
| D6 | Termination winner = whoever's `DEL chat:match:{mid}` returns 1 | Exactly-one-winner with no extra lock | Loser must treat `ALREADY_ENDED` as success |
| ~~D7~~ | ~~Reconnect creates a **new session**; no resumption~~ | ~~No resumption token to steal, replay or leak~~ | **Reversed in phase 16 — see D42 and §28.** The threat it avoided needs script execution on this origin (where the live conversation is already readable) or an unlocked device (same); the cost was paid by everybody, on every refresh and every change of network |
| D8 | Cross-instance transport is Pub/Sub on a **per-session channel** | The channel name *is* the routing key, so no routing table can go stale | One SUBSCRIBE per connection; events to a closed socket are dropped (§11) |
| D9 | Local fast path when the partner's socket is on this instance | Removes a hop for the common case | Two delivery paths; both exercised via the `route` metric label |
| D10 | No Express/Fastify | Three HTTP endpoints and one upgrade path do not justify a framework | ~30 lines of manual routing |
| D11 | Protocol types are a **byte-identical duplicated file** | Each package stays independently installable and Dockerisable | Duplication, guarded by `verify:protocol` |
| D12 | Redis runs with `--save "" --appendonly no` | Live state is reconstructible; disabling persistence guarantees no Redis structure — including a Pub/Sub payload — can reach disk | Redis restart loses live state; handled via `SESSION_GONE` + client reconnect |
| D13 | Single Redis, not Cluster | A globally shared queue needs cross-slot scripts, and `tryMatch` computes which session keys it touches while it runs, so they cannot be declared the way a Cluster router requires; Cluster would be a redesign | Scale vertically, and survive a node with **Sentinel** — `REDIS_SENTINELS` + `REDIS_SENTINEL_NAME`, with every half-specified topology refused at startup rather than degraded to one node. Drilled: ~3 s promotion, state intact, `docs/operations/OPERATIONS.md` §17. The replica must be on a second host to be worth anything |
| D14 | `message_ack` means "accepted and routed", not "partner received" | An end-to-end receipt doubles latency and needs a correlation table | Stated in the protocol so the UI shows "sent", never "read" |
| **D15** | *(revision 3 — replaces the former application-level encryption decision)* Message content is stored as **ordinary plaintext application data** inside the trusted boundary (§2.1). Confidentiality comes from transport encryption, network isolation, least-privilege credentials, storage encryption at rest, encrypted backups and access control | Application-level encryption bought protection against exactly one attacker — someone holding valid database credentials or a raw backup **but not** the application's key material — while imposing a permanent cost on every other part of the system: unsearchable columns, a key-management and rotation lifecycle, an encrypt/decrypt hop on the hot path, and a moderation pipeline that would have to decrypt what it had just encrypted. The infrastructure controls in §2.1 already defeat the stolen-media and stolen-backup cases, which is where that attacker mostly lives | The residual gap is explicit in §18.2: an attacker with valid PostgreSQL credentials, a compromised app server, or a privileged insider reads message content. That makes the database security boundary a first-class operational requirement rather than a backstop |
| **D16** | Conversation persistence is **write-behind**: bounded in-memory queue, batched inserts | Security §62 and ads §P4 both require the chat to survive dependency failure. A synchronous insert makes PostgreSQL latency into chat latency and a PostgreSQL outage into a chat outage | Retention is best-effort under DB outage or queue overflow. Drops are counted and alerted (`chat_conversation_writes_dropped_total`), never silent |
| **D25** | Persistence is guarded by a **circuit breaker** (CLOSED → OPEN → HALF_OPEN → CLOSED) with a **rate-paced drain** on recovery | Without a breaker, a database outage turns every message into a slow failing insert, exhausting the pool and adding latency to the very path that must not slow down. Without paced draining, recovery replays the entire backlog at once and knocks the database over again — the outage repeats itself | Adds a state machine and a token-bucket drain. Both are small, and both are testable in isolation |
| **D26** | Queue capacity is divided into **priority classes with per-class caps and a per-session sub-quota inside each class** | Under pressure the system must shed ordinary chat before it sheds safety evidence. But naive per-class caps are gameable: an attacker who deliberately trips a mild moderation rule promotes their own traffic into the flagged class and evicts **other people's genuine evidence**. A per-session sub-quota bounds how much of any class one session can occupy | A second accounting dimension in the queue. Cheap: one counter per (class, session), bounded by the same caps |
| **D27** | Priority is assigned **only** by server-side logic, from the moderation result and the conversation's report state at enqueue time. No retroactive promotion of already-queued rows | Clients must never influence their own durability priority (§5). Retro-promotion would mean scanning and rewriting queued entries when a report arrives, and would duplicate data the report already references | A message enqueued before its conversation was reported keeps its original priority. Compensated by report/moderation rows themselves being P0, so the *report* survives even if some ordinary messages of that conversation do not |
| **D28** | The outage spool is **bounded, plaintext, and explicitly not durable storage** | Honest naming prevents the operational mistake of treating it as a guarantee. It buys hours of database-outage tolerance, not protection against host or storage loss | A host failure loses spooled records. Stated in §7.4 and §21 rather than hidden behind the word "queue" |
| **D42** | *(reverses D7)* A dropped socket **keeps its seat** for a grace window, and a returning browser reclaims it with a single-use token | D7 traded a constant, universal cost — every refresh, tunnel and network change ending a conversation — against a threat that requires script execution on this origin or an unlocked device, in both of which the attacker can already read the conversation. The block cookie could not be reused for this (R14): it is designed to be trivially rotated and to authorise nothing | A bearer credential now exists. Bounded: one session, 256 bits, stored only as a hash, rotated on every use, refused for a session that is still attached, and kept in `sessionStorage` so it dies with the tab. `RESUME_GRACE_SECONDS=0` restores D7 exactly |
| **D43** | Messages sent while a partner's seat is held are **not buffered**; the composer is disabled instead | Buffering would write message text to a Redis key, which is exactly what I8 forbids — the only Redis appearance content is allowed is a Pub/Sub payload in flight | A message typed during the gap cannot be sent. Preventing the loss is honest; accepting one that quietly reaches nobody is not |
| **D44** | *(narrows D37)* A premium preference over **gender, country and vibe** is a **weighted score inside candidate sampling, never a filter**: prefer a matching candidate, fall back to an ordinary match in the same pass, and widen the sample once before giving up | D37 refused a *filter*, and both of its objections attach to exclusivity rather than to preference. A filter reserves the scarce side of the pool for whoever paid — free users wait longer by construction and the filtered-for group is approached almost exclusively by people who paid to reach it. A preference that falls back in the same pass consumes exactly one partner per search whether or not it hit, so pool throughput is identical to today and no seat is ever held. The queue also stays one pool: segmenting on the preference would shatter it (D23, R6) and make two people with different preferences unmatchable even when both would have accepted | Sold as **"a higher chance of being matched with your preferred gender"** and never as a guarantee, because it is not one and because `gender` is a claim typed by a stranger (§26.4, D36). Preference applies to the searcher's **own** search only — no mutual-consent test, which would strand a premium user behind everyone who is not their preference. The misdeclaration incentive D37 names is real and unmitigated by this record: declaring a scarce gender acquires cash value the day this ships, aimed at users pre-qualified as spenders. The targeting objection is answered by rate, not by matching — see §29.4 |
| **D45** | *(replaces the `vibe` half of D44)* **Intent** is one selector, matched by **equality** against the candidate's own declaration, **never shown to a partner**, and **free rather than premium** — and it never triggers the wide sample | Gender and country are asymmetric: a list of what I want a stranger to be, where one party gets what they asked for and the other is selected. That asymmetry is what makes them worth charging for and what D37's objections attach to. Intent is symmetric — being matched on it is wanting the same thing as the person you are matched with — so there is no selected party, no misdeclaration incentive and nothing to sell. `vibe` was the same declaration pointed the wrong way: displayed to a stranger *and* charged for, which is the worst of both. Free is affordable only because intent is excluded from `anyPreference`: escalation is a second SRANDMEMBER plus up to PREFERENCE_WIDE_SAMPLE further HMGETs, and most of the population will declare an intent | Not a `Profile` field, structurally — `readProfiles`, the `matched` payload, `conversations.profile_a/_b` and the console column all build from `Profile`, so a value outside it cannot reach a screen (§30.1). Not *shown* is not *unknowable*: matching leaks it probabilistically and the copy claims only the former. `setIntent` is deliberately not gated on `preference.enabled` and is a separate store method, because folding it into `setPreferences` would put a free feature behind a paid flag with nothing in the types to notice. `flirty` survives the move and D46 records why (§30.4) |
| **D46** | *(answers §29.9)* **`flirty` is a declarable intent.** Symmetric like every other intent — it scores only against a candidate who declared it too — and personas are excluded from it | §29.9 refused it as a D44 preference *list*, where it meant "find me somebody flirty" and pointed outward at somebody who had not asked for it. That is targeting, and it is what the section objected to. Intent inverts the direction: it says what *you* are here for, so `flirty` can pair only with `flirty` and cannot be aimed at anybody. The objection is structurally gone rather than overruled. Routing also cuts the way nobody asks for — pairing flirty with flirty is what keeps it away from somebody who chose `venting`, which is the most common complaint about this category and something the pool has no mechanism against today. Removing the value would not remove the population, only the signal that sorts it | **Symmetry does not address child safety, and that is stated rather than argued away.** Child safety relies on the age gate plus reporting and moderation (§26.4, D36); stronger measures are on the roadmap. Reaches the s.79 argument and the payment processor's and ad networks' terms on dating and adult content; those are policy documents to update, not code. Personas never declare it (`SAFE_INTENTS`) on a **different** ground that symmetry does not answer — authorship, not targeting: persona speech is the operator's own (D-AI-11) and already outside s.79. Asserted across every character and 300 seeds, with the exclusion checked as narrow so it cannot pass by personas declaring no intent at all |
| **D51** | **The premium entitlement is enforced on the session row, and it shipped before payments could write one** | `accounts.premium_until` was written by the payment webhook and read by nothing: preferences were gated on `FILTERS_ENABLED`, which is process-wide, so turning payments on would have given the preference to everybody or to nobody and paying would have changed neither. That is `SPOOL_BACKEND=redis` accepted and ignored (F-006) wearing a different name, and the person who would have found it is the first person who paid. Splitting the column out of the staged `011_payments.sql` into `017_premium_entitlement.sql` means the gate is **provably closed before anything can be bought** — with no payments no account has a future deadline, and there is a test that says so. Payments then start writing a column something already reads, rather than the reverse | PostgreSQL is the truth (an entitlement that reset on restart is a refund nobody asked for — D12, the ban reasoning of D31); Redis caches it for five minutes, negatives included, because almost every account is a negative; and the value is copied onto the **session hash** when a connection binds an account, so `preferenceAllowance` reads it from the row it was already reading and a search touches neither PostgreSQL (D16) nor an extra key. Checked **before** the cooldown and the budget, so somebody without the entitlement never spends a budget belonging to a dimension they are not being given. **Fails closed**: a database that cannot answer resolves to not premium, which costs a preference and nothing else — the same invisible degradation §29.4 already produces — where failing open would hand the paid dimension to everybody for the length of an outage, exactly when nobody is watching. Session-scoped, so an entitlement bought mid-session takes effect on the next connection: that is the existing `reauthenticate` seam the client already uses after sign-in |
| **D63** | **A full instance holds a slice of its ceiling for sessions coming back**, and spends a reserved seat only on a resumption that actually happened (§28.7) | A resumption and a first-time visitor arrive through the same upgrade, so the ceiling refused them identically - and the two are not equally costly to refuse. A cold arrival turned away loses a chat that had not started; a resumption turned away destroys a live conversation, for two people. It is also the moment it is most likely to happen, because a busy instance is where both the drops and the arrivals are. The reserve is a **percentage of the derived ceiling**, since a fixed count right for one core reserves an eighth as much of an eight-core box (`connectionCeiling`), and it derives to zero under `RESUME_GRACE_SECONDS=0`, where there is no resumption to protect | **5% of what the box can serve is unavailable to new arrivals whether or not anybody is reconnecting.** Published as `chat_connections_reserved` rather than left to be inferred, so a dashboard's headroom is the real one. The reserve does **not** extend the ceiling: at `MAX_CONNECTIONS` everybody is refused, because a resumed session costs the same CPU as any other. Presenting a token is not what buys the seat - the handler runs the resume and refuses anything that resumed nothing, so a made-up subprotocol costs one Redis lookup and the same 503. Both bands return the identical refusal: telling a client that seats exist for resumptions tells it what to claim to be |
| **D64** | **A refused handshake is diagnosed over HTTP**, on failure only, and answered with a word rather than a number (§28.9) | A browser is given code 1006 and nothing else for a refused upgrade, so "the service is busy", "the backend is down" and "your wifi is gone" were the same event to page script and all three were reported as the last one. The 503 exists on the wire and the browser does not hand it over, so the only way to learn it is to ask again over ordinary HTTP | Answers **200 even when busy**, because a 503 would be indistinguishable from the outage the caller is ruling out. Carries no count, no ceiling and no instance id, and the copy never says "full": a number invites the guess D21 refuses, and "full" describes a door where the truth is a wait. Fetched from the close handler and never polled, so its traffic is bounded by the jittered backoff that already exists. Accepting the upgrade and closing with 1013 was rejected -- it spends a session id, a subscription and a connection slot at the moment the point is not to. `unknown` keeps the old copy rather than guessing |
| **D65** | **Friends see roughly when each other were last here** — a bucket ("3 hours ago", "2 weeks ago"), mutual, and only while both share presence (§31.7) | Reverses the "no last-seen, ever" line in R13, §24.3, `presence.ts` and `016_connection_labels.sql` on the operator's decision: a friends list that can only say *online* or nothing is one people stop opening. The objection it overrides is real — when somebody was last here is a history of their habits — so what remains of it is the shape: truncated to the hour in storage and sent only as a bucket, never the value; written only while sharing and erased in the same statement that turns sharing off; withheld from a viewer who hides their own; and at most one write per account per hour, never awaited by the heartbeat | Exact times ("10:42 pm") were offered and declined in favour of buckets. Hidden, never-seen and not-shown-to-you all arrive as the same null and render as the friendship date, so none is distinguishable. Blocking a friend now ends the friendship, or a blocked person would keep watching this one's last-active — except a late block (D38), which holds key hashes rather than a session and cannot name an account |
| **D66** | **An account is deleted a year after its last sign-in** (`AUTH_ACCOUNT_RETENTION_DAYS`), with its credentials, friendships, labels and block records; suspended accounts are kept | `010_accounts.sql` promised a deadline "extended on use" and a sweep, and shipped neither: the stamp was the payment records' seven years from creation and nothing read it. Every account was kept for ever, and adding only the sweep would have deleted every account — active or not — seven years after it was made. Sign-in now restamps the deadline; a credential lasts at most thirty days, so anybody still using the site signs in long before it can lapse and no write is needed on ordinary visits. The worker removes expired active accounts through `expire_accounts`, a `SECURITY DEFINER` function, because the chat role holds no delete on `accounts` (the `expire_admin_audit` shape) | Suspended accounts are excluded so dormancy cannot wash out a suspension. `assertCoherent` refuses a period no longer than a session. Existing accounts were restamped to a year after their last sign-in, never later than before — the direction D17 permits |
| **D50** | **The generated nickname is scoped to the session, not the match**; the colour stays per match | Reverses the §24.3 rule that nothing may be stable across matches, and the trade is stated rather than argued away. What §24.3 forbids is a handle somebody can accumulate against a person over time, and a session dies with the tab, so what a stranger can accumulate is bounded by one visit. **What is given up:** two people matched twice in one visit can now tell it is the same person, and two strangers who each met somebody during that session could compare notes and know it. Neither survives the tab closing, and nothing is derived from an identifier — a kept random value is not a computable one. **What it buys:** a stranger stays recognisable for the length of a visit, in Recent and across a skip that re-pairs the same two people, which a name redrawn every match made impossible for anybody who declared nothing. The colour deliberately did not follow: nickname plus colour is a markedly more distinctive handle than either alone, and the colour's job is contrast *inside* one conversation | Written by a plain `HSET` immediately after `createSession` — a fact about one connection that no transition branches on, the same category as the account and the segment — so `createSession`'s Lua is untouched. Read beside `tryMatch` by its own method, never folded into `readProfiles`, whose field list is exhaustive precisely so a value never read there cannot reach a stranger's screen. Being on the session hash is what scopes it: it lives exactly as long as a session and a resume re-attaches the same hash, so reconnecting inside the grace window keeps the name. **Collision:** the two sides now draw independently, so the by-construction distinctness the pair had is gone for the nickname (the colour keeps it). The **arriving** side redraws — the waiting side has been using that name with other people — and the redraw is never written back, or a stranger could change somebody's name for every other conversation by colliding with it. Both words are redrawn, so the result cannot read as a variant. A missing nickname is drawn fresh: degraded, not wrong |
| **D49** | **Asking to connect is announced to the other side** (`connection_request`); declining still sends nothing | Reverses half of D47 on product grounds, and the cost is stated rather than argued away: somebody who declines now learns that this particular stranger wanted to connect, which they previously did not. It was overruled because a silent request is indistinguishable from a broken button — the asker sees nothing happen and the person who might have agreed is never given the chance. Both are present in a live conversation, which is what makes the ask ordinary rather than a disclosure about somebody absent | Sent once, on the `pending` branch only: `already` sends nothing, or toggling off and on would ping the partner repeatedly for a request they have seen, and `self` is two tabs of one account. The route is resolved beside the Lua script rather than returned by it — widening a positionally-parsed reply means re-verifying every matchmaking race, and this path runs only when somebody presses the button. **Ignore produces no frame**, so a refusal stays private and the asker learns only what silence tells them |
| **D47** | **A saved connection needs both sides**, is never disclosed one-sidedly, carries no reference to the conversation, and is removed unilaterally | Mutual consent is the obvious half: one-sided saving would make a stranger future contactability they did not agree to. The half worth recording is that **no frame ever discloses a refusal** — `connection_state` answers the caller about the caller, `connection_made` is reachable only when both agreed, and declining sends nothing at all, so there is no state in which the protocol reports somebody saying no. **Amended (D49):** asking is now announced to the person being asked, which this row originally refused; the refusal half is unchanged and is the part that was load-bearing. The row carries no `conversation_id`, which is the line `010_accounts.sql` names as the one to defend in review, and no `created_by`, which looks harmless and turns a symmetric relationship asymmetric by answering who asked first | Stored as a canonical ordered pair with `check (lo < hi)`: two rows can disagree, one unordered row needs every query to try both orders. Both questions are answered in one Lua script (§10.17 reasoning) — as two round trips, simultaneous presses could each read the other as not-yet-saved and neither would complete. Removal is **unilateral and a hard delete**: consent to connect is mutual, consent to *stay* connected is not, and a `removed_at` tombstone would keep a record of a relationship one person ended. The residual inference is unfixable and stated: a chat ending with no connection tells a saver the other did not save |
| **D48** | **Sign-in is one OIDC provider, PKCE, exchanged server-side — and it is free**, gating connections, history and friend requests but never premium | Verification is the deciding requirement (`docs/product/FEATURE-INTAKE.md`) and a bearer token cannot supply it. Free because none of the three things it unlocks is a scarcity worth selling, and all three are the reason to hold an account; the `AuthModal` this replaces required `PAYMENTS_ENABLED`, which had it backwards. Server-side exchange keeps every vendor script out of the browser, so `img-src`/`script-src` are unchanged and the only third-party contact is one visible redirect | The account stores a subject and **nothing describing a person** — `openid email`, verified, then dropped — which keeps the policy data row one line and keeps no age stored (§26.4, D36). `accounts.external_id`, never the primary key: payments reference `accounts.id` and handing that key to a vendor defines a financial record on a system we do not control. No JWT library, because Node verifies a JWK natively — acceptable only because every check has a test for its **failing** case (alg none/HS256, wrong pool, wrong client, expired, future, replayed nonce, unknown kid). `SameSite=Lax` not `Strict`, or sign-in fails only for people who complete it. A database that cannot answer resolves to the anonymous path, because chat must not fail when accounts do |
| **D38** | A block that arrives **after the match ended still records**, using a short-lived note of the departed partner's hashes | Measured, not theorised: the swarm found that a block racing a teardown was silently lost, telling the user they were protected when they were not. The people most likely to leave first are the people most worth blocking | Each side's hashes sit against the other's session id for `BLOCK_LATE_WINDOW_SECONDS` (default 120, `0` disables). The record is spent when used — including on the live branch, or a blocker could re-block the same person for the whole window and burn their hourly budget |
| **D39** | Auto-search is **opt-in, cancellable, and never fires after a block** | Auto-advancing without being asked is the mechanic that turns chat into an endless feed, and the moment a person decides to stop is worth keeping. After a block it would contradict what blocking meant — the same reason `block` already lands in IDLE | An explicit "Block & next" button *does* advance, because the person asked. Only automatic behaviour needs protecting against |
| **D40** | Auto-search **backs off to respect the join limiter** rather than the limiter being widened for it | `join_queue` allows a burst of 5 refilling one per five seconds; a three-second advance outruns it. Raising the limit would make cycling through strangers cheaper, which is exactly what a spammer wants — the swarm measured labelled spammers reaching 4,852 people at the current limits | A run of abandonments shows a longer countdown instead of an error. Skipping spends no token, so ordinary use never touches it |
| **D41** | The match notification carries **no conversation content**, and permission is requested only on opt-in | A notification is rendered by the OS, lands in a notification centre, and may sit on a lock screen somebody else reads — outside the boundary §2.1 allows content to occupy (I8). And an unprompted permission dialog is the one everybody dismisses, costing the capability permanently | The desktop notification says only that a stranger is waiting. Every channel is gated on the tab being hidden |
| **D34** | The declared profile is **held by the browser and re-sent on every join**; the server keeps nothing between sessions | A profile the server kept against a durable identifier would be a stable record of a person across every conversation — the cross-chat correlator §24.3 forbids. Client-side means the person holds their own declaration and clearing site data actually erases it | Re-sent on each join, so a client that stops sending a field clears it. No partial update, and no way to recognise a returning visitor |
| **D35** | A declared **name is refused on any moderation flag**, not flagged-and-delivered like a message (D20) | A message is one utterance judged in context; a name is a label shown to everyone the user meets for the whole session, so a contact handle in it is unambiguously an advert rather than a signal to weigh later | A false positive costs a join and a retype. The refusal names no detail; rule ids are logged, the name never is |
| **D36** | A declared age below 18 is refused with its **own protocol code** and counted as a safety signal | The client can say what the service is instead of "invalid input", and the count is an input to child-safety work. Security §23 opens its grooming signals with "repeated attempts to establish age", so broadcasting a self-declared minor's age to strangers automates exactly that | **Not age assurance and not an age gate** (§26.4). Anyone can type 25. The value is never treated as a safety control anywhere in the code |
| **D37** | Profiles are **declared but not filterable**; no matchmaking path reads them | Filtering creates the incentive to misdeclare — the incentive comes from the filter, not the field — and a paid "match me with X" control is a targeting tool aimed at whichever group is filtered for | Premium filtering, if built, goes behind the queue-segment seam (D23) with its own recorded decision. Safer shapes that sell the same promise: language, interests, country, or mutual opt-in. **Narrowed by D44 (§29)**, which refuses a filter and ships a preference — this row is followed rather than overturned, and both objections below survive as constraints on it |
| **D29** | A **ban is not a block**, and the two live in separate Redis namespaces (`chat:ban:{key}` vs `chat:blocks:{key}`) | They answer different questions. A block is relative — a set of peers *one user* refuses, consulted inside `tryMatch`. A ban is absolute — the holder gets no session at all, so it is one key with a TTL read before a session exists. A shared namespace would let a moderator revoking a ban delete a user's own block, silently removing protection that user asked for | Two lookups instead of one on the connection path, folded into a single `MGET` |
| **D30** | The ban check sits in the **upgrade path, before any allocation**, and **fails closed** on a Redis error | Placed inside the session lifecycle, every banned reconnection would still cost a session id, a Pub/Sub subscription and a connection slot — a denial-of-service budget handed to the banned party. Failing *open* is the usual instinct and is wrong here: `/ready` already drops an instance with unhealthy Redis out of the load balancer, so failing open would not rescue a doomed connection, it would only un-ban every sanctioned user for the length of an outage | A Redis outage refuses new connections on that instance, which it was already going to do |
| **D31** | PostgreSQL is the **source of truth for sanctions**; Redis is a cache, replayed at startup and on an interval | Redis runs with persistence off (D12) so that no Redis structure — including a Pub/Sub payload carrying message text — can reach disk. Every ban key therefore dies with a Redis restart. Without the replay, every sanction is quietly temporary and nothing reports that it has gone | A background query per instance per interval. The replay recomputes the remaining life from `expires_at` rather than reissuing the original duration, so a restart cannot silently renew a ban |
| **D32** | The console is a **separate process on its own port**, connecting as its own database role, and is **off by default** | The chat backend and the console are different trust levels. The console holds the only credentials that read every retained conversation; the chat backend holds none and needs none. One process would put both in one address space, so compromising the internet-facing half hands over the other. A separate listener that is never published also cannot be reached by an nginx routing mistake, which makes authentication the second layer rather than the only one | A second service to deploy. `karobakbak_app` is denied `admin_accounts`; `karobakbak_console` cannot delete a conversation |
| **D33** | The audit row is written **first, in the same transaction as the read**, and a failure to write it fails the read | The natural order — fetch, return, then log — yields an audit trail that is complete *except* for the reads that failed halfway, which are the ones worth knowing about. The guarantee has to be "a read that was not logged did not happen", not "reads are usually logged" | One extra statement inside each disclosure transaction. Enforced by a test that breaks the audit insert and asserts no content is returned |
| **D17** | Retention deadline is stamped **at write time** (`retention_expires_at`), not computed at deletion time | Changing the retention config never retroactively extends the lifetime of already-stored data, which is exactly the "do not silently extend retention" rule | Shortening the policy does not shorten already-stored rows; the deletion tool must be run explicitly for that |
| **D18** | Blocks are enforced on **two coarse dimensions** (salted IP hash + client token hash), not on session id | Session ids are per-connection, so a session-id block expires the moment the blocked user reconnects — it would be theatre | Both dimensions are evadable (VPN) and the IP dimension can collateral-damage CGNAT/university users. TTL-bounded, individually disableable, documented in §16.2 |
| **D19** | Moderation is **local-only** in the MVP: normalisation, URL/contact detection, deterministic rules | Cost §20–21: routing every message to a paid classifier is the expensive default to avoid. Local rules catch the high-volume, low-sophistication abuse | Weak against novel or obfuscated abuse. Produces signals for later escalation, not verdicts |
| **D20** | Moderation default policy is **flag, not withhold**, except for an explicit hard-block rule set | Security §22: classifiers should produce risk signals rather than irreversible enforcement. False positives in a chat product are very visible | Some bad content is delivered and only flagged. Reports and enforcement are the compensating control |
| **D21** | Presence counts come from **real Redis cardinality**, cached, never synthesised. The UI **hides the counter entirely below `PRESENCE_MIN_TO_SHOW` (100 online)** rather than showing a small true number | UI §5.1 forbids fabricated social proof, and fabricated counts are a trust bug that is impossible to walk back. Withholding a true number says nothing false; a flattering invented one cannot be un-shown once somebody notices. "1 online" is also worse for the operator than silence — it tells a visitor to leave | Counts lag by up to the cache interval and are approximate under churn. Labelled as approximate in the UI. Early users see no count at all, which is the cost of not inventing one |
| **D22** | Advertising is **frontend-only**; the backend has no ad surface | Ads §6/§20 require that ad state never enter matchmaking state. The strongest way to guarantee that is for the backend not to know ads exist | Server-side frequency capping and server-verified impressions are not possible yet. Acceptable while ads are disabled/house-only |
| **D23** | Queue keys carry a **segment** from day one, with only `default` implemented | Retrofitting segmentation into eight Lua scripts and their race tests is far more expensive than carrying an unused argument | A dead parameter until filters ship |
| **D24** | Client `id` is **required on `message`** and deduplicated per match | Security §10 replay protection. Making the dedupe key the client id keeps the client's retry story simple: resend the same frame, get the same ack | A dedupe set per match in Redis; bounded by cap + TTL |

**D-AI-1 to D-AI-12 are decisions for the AI persona system.** Personas are
optional automated conversation partners that fill an empty queue. The system
is built (`backend/src/personas/`) and **off by default**: it runs only when the
deployment sets `PERSONAS_ENABLED` *and* the audited console switch in
`persona_control` (which ships disabled) allows it. The decisions are numbered
separately rather than continuing D44+ because they form one cluster that ships
together or not at all.

| # | Decision | Rationale | Tradeoff accepted |
|---|---|---|---|
| **D-AI-1** | Automated partners are **described in the Terms** and are not labelled per conversation in the interface. A persona **never claims to be human** | The Terms state that an automated account may be matched when nobody else is available. A published document that denied what the service does would be a false statement rather than a weak position | Users are not told in the chat itself which partner is automated. The commitment enforced in code, with an adversarial test, is the narrower one: no persona output may claim to be human (D-AI-4) |
| **D-AI-2** | Message content **leaves the trusted boundary** for conversations that have a persona in them, and only those | A persona cannot reply without reading what the user wrote. Splitting on conversation type keeps I8 intact where it can be kept and makes the exception legible rather than general | The Privacy Policy names the model provider as a processor. `logger.ts` and its denylist are untouched: this is a deliberate egress path, not a relaxation of the rule that content never reaches logs, metrics or traces |
| **D-AI-3** | A persona is a **durable character** with a **declared profile generated per conversation** | Generating the profile per conversation reuses the declared-profile mechanism exactly: it rides on `join_queue`, lives on the session hash and dies with the session (D34) | No new storage and no new code path for identity. Consistency holds **within** a conversation, which is the scope session memory already has. One character can serve many concurrent conversations |
| **D-AI-4** | A persona **never asserts that it is human**. An identity question is answered by the guard, not by the model | A system that states a falsehood to somebody who asked a direct question is not defensible. Answering in the guard means the model never sees the question and cannot be talked into the claim | The reply to an identity question is **substituted, not inspected**, because letting model-written text through whenever it failed to match a word list would rest the guarantee on that list being complete. Every outgoing draft is also checked for a claim to be human, and a test asserts that no substituted reply can contain one |
| **D-AI-5** | Six limits sit **between the model and the socket** (`backend/src/personas/guard.ts`): no sexual content; a minor signal ends the romantic register for the rest of the session; no escalation under pressure; a crisis signal breaks character with helpline information; never solicit personal information or off-platform contact; never claim to be human | A limit written into a system prompt is one the thing generating text can be talked around. The prompt still carries the instructions, and nothing depends on them | The limits are not persona configuration and not overridable by a user request. The guard fails closed: if analysis cannot run, nothing is sent. `PERSONA_GUARD_TERMS_FILE` lets an operator add terms: detection lists **extend** the built-in ones (a file can never lower the floor) and reply pools **replace** them, checked against the same claim-to-be-human list. Every limit carries an adversarial test; a happy-path test does not count |
| **D-AI-6** | Personas are **ordinary WebSocket clients**, never a special case in matchmaking: no AI branch in `tryMatch`, no new Lua | `tryMatch` is the most race-tested code in this repository and its reply is parsed positionally. `load-test/swarm/` already runs thousands of scripted clients over real sockets, so the substrate exists | Every invariant applies to personas unchanged: server authority, blocks, bans, rate limits, moderation, retention. A persona costs a real socket and a real session. If the persona service dies, chat is unaffected, which is D16's principle applied to a second dependency |
| **D-AI-7** | A **hard monthly spend cap**, counted from real token usage, checked before the request and failing closed | An alert tells you after the money is gone, so the cap ships with the first model call rather than with the metrics | Personas stop joining at the cap and in-flight conversations finish. Cheaper limits ride with it: caps on concurrent sessions overall and per character |
| **D-AI-8** | Observability **splits in two**: Prometheus and Grafana carry counts, costs, latencies and limit trips and **never** carry content; the moderation console is the only surface that shows what was said | Rule 1 (§18) names Prometheus labels *and values* and Grafana annotations explicitly, so a live persona feed panel cannot exist | Persona transcripts are browsable in the console (D-AI-12), which makes the audit trail the control on reading a stranger's messages and makes the D33 guarantee load-bearing |
| **D-AI-9** | One **control plane** (global, per persona, per provider) that **drains rather than cuts** and fails closed | Ending a live conversation mid-sentence looks like a bug; the distinction already exists in the close handler as `holdSeat: !draining`. An unreadable flag must never mean "carry on spending money" | State lives in PostgreSQL cached in Redis with a reconciler, the ban pattern (D12, D31), because Redis persistence is off. A separate hard stop exists for when cutting *is* the point. Every change is audited |
| **D-AI-10** | Model access sits behind **one narrow provider interface**; no vendor SDK is imported outside its own adapter | Retrofitting an abstraction after the call sites exist is far more expensive than carrying one from the start | Caching semantics, refusal shapes and token counts must be re-measured per vendor. Each additional vendor is an additional **named processor**, so adding one is a Privacy Policy change before it is a config change. A vendor that may train on what is sent to it is not eligible |
| **D-AI-11** | Persona output is **first-party speech**, and the operator accepts that it sits outside IT Act s.79 | s.79 protects an intermediary in respect of *third-party* information. Everything a persona says is published by the operator rather than hosted for a user | A significant increase in legal exposure, accepted explicitly rather than discovered. It is the reason D-AI-5's limits are enforced in code rather than asked for in a prompt |
| **D-AI-12** | Persona conversations are **browsable in the console without a report**, unlike every other conversation | Reading conversations for quality is a real early-stage need. One side of the conversation belongs to the operator; the other does not, and both ride in one transcript | The Privacy Policy describes this exception. With no report gating access, the audit log becomes the safeguard: the D33 guarantee and the one-year audit retention are not negotiable while browsing is unrestricted |

---

## 4. State invariants

I1–I7 unchanged. **I8 is rewritten** (R1). I9–I14 are new.

* **I1 — Single state.** A session record has exactly one `state ∈ {IDLE, SEARCHING, MATCHED}`.
* **I2 — Pairs only.** `chat:match:{mid}` exists ⇒ it has `a` and `b`, `a ≠ b`, both non-empty.
* **I3 — Queue ⇔ SEARCHING.** `sid ∈ chat:queue:{segment}` ⇒ session exists ∧ `state = SEARCHING` ∧ no `chat:user_match:{sid}`.
* **I4 — Match ⇔ MATCHED.** `chat:user_match:{sid}` exists ⇒ `state = MATCHED` ∧ `session.matchId` agrees ∧ the match record lists `sid`.
* **I5 — No dual matches.** `chat:user_match:{sid}` is a single string key; both sides are written in the one script that creates the match.
* **I6 — No resurrection.** Once `chat:match:{mid}` is deleted, `mid` can never deliver: delivery resolves `user_match → match`, and both are cleared by the terminating script.
* **I7 — No stale eligibility.** A session whose socket is gone stops being matchable within `SESSION_TTL_SECONDS`, usually immediately.
* **I8 — Bounded locations for message content.** *(rewritten in revision 3)* Message content exists **only** inside the trusted boundary of §2.1: Node.js process memory, the bounded persistence queue, the outage spool, PostgreSQL `messages.body`, and a Redis Pub/Sub payload in flight (§7.4). It is **never** written to an application log, an error log, an exception message, a Prometheus label or value, a Grafana annotation, a tracing span, an analytics event, a crash report, or any other persistent system. Report notes (`reports.note`) are user-generated content and carry exactly the same protection class as message bodies.
* **I9 — Everything retained has an expiry.** Every `conversations`, `messages`, `reports` and `moderation_events` row carries a non-null `retention_expires_at` stamped at insert time.
* **I10 — Expiry is enforced, not intended.** The deletion worker removes rows past `retention_expires_at` unless `legal_hold = true`. Deletion failures raise an operational alert; they never fail silently.
* **I11 — Retained content is access-controlled and audited.** No application code path returns message content without an authenticated, role-checked, purpose-scoped request that writes an `admin_audit` row. There is no "browse all conversations" path and no client-facing history endpoint. This is an *application* control; it does not constrain someone with direct database credentials, which is why §2.1 and §12 treat database access as a first-class boundary. *(Implemented in phase 13, §25. The purpose scope is a **report id**: a conversation is reachable only through a report naming it. The audit row is written before the content is selected, in the same transaction, so a failed disclosure leaves no unlogged read — D33.)*
* **I12 — Blocked pairs never match.** If either direction of a block exists between two candidates' block keys, `tryMatch` will not pair them.
* **I13 — Advertising cannot touch chat.** No matchmaking, session or message code path reads advertising state, and no advertising code path reads conversation data. Structurally guaranteed: the backend has no ad module.
* **I14 — Replay is rejected.** A `message` whose client `id` was already accepted for the current match is rejected, not delivered twice.

Transient violations of I3/I4 are possible only between a crash and the next
janitor pass, and are never observable to a client because every read path
re-validates before acting.

---

## 5. State machine

Server-authoritative session states in `chat:session:{sid}.state`:

```
              (ws upgrade accepted, session row created)
                              │
                              ▼
                          ┌────────┐
        leave_queue ──────│  IDLE  │◄────────────── partner_skipped
        (from SEARCHING)  └────┬───┘                partner_disconnected
        leave_chat             │                    partner_blocked
        (from either)          │  join_queue
                               ▼
                        ┌────────────┐
                        │ SEARCHING  │──── join_queue (idempotent no-op)
                        └─────┬──────┘
                              │  try_match wins a pair
                              ▼
                        ┌────────────┐
                        │  MATCHED   │──── message / typing (no transition)
                        └─┬───┬────┬─┘
                  skip    │   │    │   ws close / TTL / janitor
                          │   │    └──────────────┐
                          │   │ block            │
                          ▼   ▼                  ▼
                     SEARCHING / IDLE      (session row deleted)
```

There is no stored `DISCONNECTED` state: absence *is* disconnected. This removes
a class of stale-tombstone bug and lets TTL be the safety net.

`report` does not change session state (a user may report and keep talking).
`block` ends the match and returns the blocker to IDLE. `leave_chat` does the
same without recording a block — it is the "I am done for now" gesture, and it
exists because `skip` cannot express it (§12).

### Allowed transitions

| From | Event | To | Notes |
|---|---|---|---|
| IDLE | `join_queue` | SEARCHING | then immediately attempt a match |
| SEARCHING | `join_queue` | SEARCHING | idempotent, replies `queue_status` |
| SEARCHING | match won (self or peer) | MATCHED | peer-won matches arrive via Pub/Sub |
| SEARCHING | `leave_queue` | IDLE | |
| SEARCHING | `leave_chat` | IDLE | same as `leave_queue` from here |
| SEARCHING | close | *deleted* | removed from queue first |
| MATCHED | `message` / `typing` | MATCHED | no state change |
| MATCHED | `report` | MATCHED | evidence recorded; conversation continues |
| MATCHED | `skip` | SEARCHING | end match atomically → re-queue → try match |
| MATCHED | `block` | IDLE | end match, persist block, notify partner as a skip |
| MATCHED | `leave_chat` | IDLE | end match, **no** re-queue, notify partner as a skip |
| MATCHED | peer `skip` / peer `block` / peer close | IDLE | `partner_skipped` / `partner_disconnected` |
| MATCHED | close | *deleted* | match ended, peer notified |

### Rejected or ignored transitions

| From | Event | Result |
|---|---|---|
| IDLE / SEARCHING | `message`, `typing`, `report`, `block` | `error NOT_MATCHED`; state unchanged |
| IDLE | `skip` | ignored, replies `queue_status{IDLE}` (idempotent) |
| SEARCHING | `skip` | ignored, replies `queue_status{SEARCHING}` (already satisfied) |
| MATCHED | `join_queue` | `error ALREADY_MATCHED` |
| MATCHED | `message` with a repeated `id` | `error DUPLICATE_MESSAGE`, not delivered (I14) |
| *any* | unknown type / bad version / bad JSON | `error`, strike counter++ |
| *deleted* | anything | `error SESSION_GONE`, then close 4001 |

---

## 6. WebSocket protocol specification

Protocol version stays **1** — nothing is deployed, so the revision-2 events are
added to v1 rather than forking a v2.

### 6.1 Envelope

```json
{
  "type": "message",
  "version": 1,
  "id": "c_9f2a",
  "timestamp": "2026-08-18T12:00:00.000Z",
  "payload": { "text": "hi" }
}
```

* `type` — required; must be a known event for the direction.
* `version` — required integer; must equal `PROTOCOL_VERSION`.
* `id` — **required on `message`** (dedupe key, R4/D24), optional elsewhere. ≤ 64 chars, `[A-Za-z0-9_-]`. Never an identity or authorisation token.
* `timestamp` — inbound: **ignored entirely**. Outbound: always server-generated ISO-8601 UTC.
* `payload` — object; absent is treated as `{}` for zero-argument events.

The server reads **no** session id, user id, partner id, match id, sender,
recipient, sequence or authorisation field from any client frame. All are
resolved from Redis using the identity bound to the socket at upgrade time.

Frames larger than `MAX_FRAME_BYTES` are rejected by `ws` (`maxPayload`); the
connection closes with 1009.

### 6.5 Identity bound at upgrade (phase 4)

Two values are derived from the HTTP request, once, and held on the socket for
its lifetime. Neither can be changed by anything a client sends afterwards.

* **`ipHash`** — the client address, salted and hashed. The address is the peer
  address unless `TRUST_PROXY_HOPS > 0`, in which case it is read from
  `X-Forwarded-For` **counting from the right**: each trusted proxy appends the
  address it saw, so the rightmost N entries are the ones our own
  infrastructure wrote and everything to their left is whatever the client
  chose to send. Reading the leftmost entry — the usual shortcut — would let
  any client pick its own rate-limit bucket and shed its blocks with a header.
  A header shorter than the configured hop count is treated as absent rather
  than as partially trustworthy.
* **`clientHash`** — the browser's block token, salted and hashed. The token
  is **server-generated and carried in an HttpOnly cookie**, minted on the
  first upgrade that arrives without a valid one. A query parameter would put a
  stable pseudonymous identifier into every proxy access log, and
  `localStorage` would put it where page script can read it; neither is
  justified for a value whose only job is to be hashed into a block dimension.
  A presented token that does not match the server-generated shape is discarded
  rather than hashed, so a client cannot aim its token at someone else's block
  key. It remains a block dimension and **not** a credential (R14): losing the
  cookie costs the user nothing and costs the dimension its precision, which is
  what the IP dimension is there to backstop.

Origin is checked before either: an empty allowlist accepts any origin and is
fatal in production (R9), and a request with **no** Origin header is accepted —
that is a non-browser client, and the header exists to stop another site's page
opening a socket in a user's browser, not to authenticate a caller.

### 6.2 Client → server

| Event | Payload | Validation | State? | Idempotent? | Errors |
|---|---|---|---|---|---|
| `join_queue` | `{}` | envelope; own bucket | IDLE→SEARCHING | yes | `ALREADY_MATCHED`, `SESSION_GONE`, `RATE_LIMITED`, `SERVER_SHUTTING_DOWN` |
| `leave_queue` | `{}` | envelope; own bucket | SEARCHING→IDLE | yes | `SESSION_GONE`, `RATE_LIMITED` |
| `message` | `{ type?, text }` | `id` required; `type` optional, defaults to `text`, and any other value is rejected (§23.6); reserved media fields rejected; `text` a string; trimmed length ≥ 1; length ≤ `MAX_MESSAGE_LENGTH`; no forbidden control chars; no lone surrogates; dedupe; own bucket | no | **yes**, within the dedupe window | `VALIDATION_FAILED`, `EMPTY_MESSAGE`, `MESSAGE_TOO_LONG`, `UNSUPPORTED_CONTENT_TYPE`, `DUPLICATE_MESSAGE`, `RATE_LIMITED`, `NOT_MATCHED`, `MESSAGE_WITHHELD` |
| `typing` | `{ active: boolean }` | envelope; own bucket (cheapest limit) | no | yes | `NOT_MATCHED`, `RATE_LIMITED` |
| `skip` | `{}` | envelope; own bucket | MATCHED→SEARCHING | yes | `SESSION_GONE`, `RATE_LIMITED`, `SERVER_SHUTTING_DOWN` |
| `leave_chat` | `{}` | envelope; own bucket | MATCHED→IDLE, SEARCHING→IDLE | yes | `SESSION_GONE`, `RATE_LIMITED` |
| `report` | `{ category, note? }` | category ∈ fixed enum; `note` ≤ 500 chars; strict bucket (security §12; default in `backend/src/config.ts`) | no | no | `NOT_MATCHED`, `VALIDATION_FAILED`, `RATE_LIMITED` |
| `block` | `{}` | envelope; own bucket | MATCHED→IDLE | yes | `NOT_MATCHED`, `RATE_LIMITED` |
| `ping` | `{}` | envelope | no (refreshes TTLs) | yes | — |

`report.category ∈ { harassment, spam, sexual_content, grooming, threats, hate, scam, other }` (UI §26, security §31).

### 6.3 Server → client

| Event | Payload | When |
|---|---|---|
| `connected` | `{ sessionId, protocolVersion, serverTime, limits, features }` | after the session row is created. `sessionId` is the client's own id, for log correlation only; it grants nothing. `features` lets the UI hide controls the server has disabled |
| `queue_status` | `{ state, waiting }` | after `join_queue` / `leave_queue` / no-op `skip` |
| `presence` | `{ online, conversations, approximate: true }` | on connect and every `PRESENCE_INTERVAL_MS`. Real Redis counts, cached (D21) |
| `matched` | `{ matchId, startedAt, you: Identity, partner: Identity }` | on pairing. **Partner's session id is never sent**; `Identity` is `{ nickname, colour }`, generated per match |
| `message` | `{ matchId, messageId, type, text, sentAt, from: "partner" }` | inbound stranger message. `type` is always present outbound so the renderer dispatches unconditionally (§23.4) |
| `message_ack` | `{ clientMsgId, messageId, matchId, acceptedAt, route, delivered }` | server accepted and routed. `delivered:false` when policy withheld it (D20) |
| `partner_typing` | `{ matchId, active }` | partner's typing state changed |
| `partner_skipped` | `{ matchId }` | partner skipped or blocked. **Blocks are indistinguishable from skips to the blocked user** (security §32) |
| `partner_disconnected` | `{ matchId }` | partner's socket closed or their session was reaped |
| `report_ack` | `{ reportId, acceptedAt }` | report recorded. Carries no moderation detail (security §31) |
| `error` | `{ code, message, retryable }` | protocol / state / limit violation. Never Redis state, stack traces or message text |
| `pong` | `{ serverTime }` | reply to `ping` |
| `server_shutdown` | `{ reason: "shutdown" }` | before a graceful 1001 close |

### 6.4 Error codes

`BAD_JSON`, `BAD_ENVELOPE`, `UNSUPPORTED_VERSION`, `UNKNOWN_EVENT`,
`VALIDATION_FAILED`, `EMPTY_MESSAGE`, `MESSAGE_TOO_LONG`,
`UNSUPPORTED_CONTENT_TYPE`, `DUPLICATE_MESSAGE`, `MESSAGE_WITHHELD`,
`RATE_LIMITED`, `NOT_MATCHED`, `ALREADY_MATCHED`, `SESSION_GONE`,
`SERVER_SHUTTING_DOWN`, `TOO_MANY_INVALID_MESSAGES`, `INTERNAL_ERROR`.

Close codes: `1000` normal, `1001` going away, `1009` frame too large, `1011`
internal, `1013` slow consumer, `4001` session gone, `4002` policy/abuse,
`4003` too many invalid frames.

---

## 7. Redis data model

Prefix from `REDIS_KEY_PREFIX` (default `chat`). All ids are 128-bit random,
base64url, server-generated — no client string ever becomes part of a key.

| Key | Type | Contents | TTL |
|---|---|---|---|
| `chat:session:{sid}` | HASH | `sid`, `state`, `instanceId`, `segment`, `ipHash`, `clientHash`, `createdAt`, `lastSeenAt`, `enqueuedAt?`, `matchId?` | `SESSION_TTL_SECONDS` |
| `chat:sessions` | SET | every known `sid` | — (janitor) |
| `chat:queue:{segment}` | SET | `sid` of every SEARCHING session in that segment | — (janitor) |
| `chat:segments` | SET | active segment names | — (janitor) |
| `chat:match:{mid}` | HASH | `a`, `b`, `segment`, `createdAt` | `MATCH_TTL_SECONDS` |
| `chat:matches` | SET | live `mid` | — (janitor) |
| `chat:user_match:{sid}` | STRING | `mid` | `MATCH_TTL_SECONDS` |
| `chat:dedupe:{mid}` | SET | accepted client message ids for this match (capped) | `MATCH_TTL_SECONDS` |
| `chat:rl:{command}:{sid}` | HASH | token bucket `t`, `ts` | `RATE_LIMIT_TTL_SECONDS` |
| `chat:rl:conn:{ipHash}` | STRING | connection-attempt counter | `CONN_RATE_WINDOW_SECONDS` |
| `chat:conn:{ipHash}` | SET | session ids currently connected from this IP hash (R8) | `SESSION_TTL_SECONDS` refresh |
| `chat:blocks:{blockKey}` | SET | block keys this key refuses (D18) | `BLOCK_TTL_SECONDS` |
| `chat:instance:{iid}` | STRING | liveness beacon | `INSTANCE_HEARTBEAT_TTL_SECONDS` |
| `chat:instances` | SET | `iid` | — (janitor) |
| `chat:janitor:lock` | STRING | holder `iid` | `JANITOR_LOCK_TTL_SECONDS` |
| `chat:ev:session:{sid}` | channel | cross-instance events | n/a |

`ipHash = sha256(IP_HASH_SALT | ip)[:32]`; `clientHash = sha256(IP_HASH_SALT | clientToken)[:32]`.
Raw IPs are never stored in Redis, never in PostgreSQL, never logged.

### 7.4 The one place message text touches Redis

Cross-instance delivery publishes `{ messageId, text, sentAt }` on
`chat:ev:session:{sid}`. This is documented rather than hidden (R10, security
§36) because:

1. Pub/Sub payloads are never written to a Redis key or data structure.
2. Redis runs with `--save "" --appendonly no`, so nothing Redis holds can reach disk.
3. Delivery to a same-instance partner skips Redis entirely (D9).

This is transit, not storage. It is not a second copy of the conversation.

---

## 8. PostgreSQL data model

The retained store. Every table has an explicit purpose, retention period and
access rule (security §54).

```sql
conversations (
  conversation_id       text primary key,          -- equals matchId (see note)
  session_a             text not null,
  session_b             text not null,
  segment               text not null,
  started_at            timestamptz not null,
  ended_at              timestamptz,
  end_reason            text,                      -- skip|block|disconnect|reap|shutdown
  message_count         integer not null default 0,
  retention_expires_at  timestamptz not null,      -- I9
  legal_hold            boolean not null default false
);

messages (
  message_id            text primary key,
  conversation_id       text not null references conversations on delete cascade,
  sender_session_id     text not null,
  server_timestamp      timestamptz not null,      -- server authority, never client
  type                  text not null default 'text'
                          check (type in ('text')), -- content-type seam (§23.3)
  body                  text not null,             -- plaintext application data (D15)
  char_length           integer not null,          -- for cost/telemetry without reading body
  moderation_action     text not null default 'allow', -- allow|flag|withhold|block
  moderation_flags      jsonb not null default '[]',   -- rule ids, never text or excerpts
  retention_expires_at  timestamptz not null,
  legal_hold            boolean not null default false
);
create index on messages (conversation_id, server_timestamp);
create index on messages (retention_expires_at) where legal_hold = false;

reports (
  report_id             uuid primary key,
  conversation_id       uuid not null references conversations,
  reporter_session_id   text not null,
  reported_session_id   text not null,
  category              text not null,
  note                  text,                      -- reporter's own words, ≤500
  created_at            timestamptz not null,
  state                 text not null default 'OPEN', -- OPEN|TRIAGED|ACTIONED|DISMISSED
  resolution            text,
  retention_expires_at  timestamptz not null,
  legal_hold            boolean not null default false
);

blocks (
  block_id              uuid primary key,
  blocker_key           text not null,             -- ipHash or clientHash (D18)
  blocked_key           text not null,
  dimension             text not null,             -- 'ip' | 'client'
  conversation_id       uuid,
  created_at            timestamptz not null,
  expires_at            timestamptz not null
);
create index on blocks (blocker_key, blocked_key);

moderation_events (
  event_id              uuid primary key,
  conversation_id       uuid,
  message_id            uuid,
  rule                  text not null,             -- which local rule fired
  action                text not null,             -- allow|flag|withhold|block
  severity              text not null,
  created_at            timestamptz not null,
  retention_expires_at  timestamptz not null
);

admin_audit (                                      -- append-only, I11
  audit_id              uuid primary key,
  actor                 text not null,
  role                  text not null,
  action                text not null,             -- viewed_conversation|issued_ban|...
  subject_type          text not null,
  subject_id            text not null,
  case_id               text,
  justification         text not null,             -- "why" is mandatory
  created_at            timestamptz not null
);

enforcement (
  enforcement_id        uuid primary key,
  subject_key           text not null,             -- ipHash/clientHash
  action                text not null,             -- warn|ratelimit|quarantine|suspend|ban
  reason                text not null,
  source                text not null,             -- automated|moderator
  created_at            timestamptz not null,
  expires_at            timestamptz,
  revoked_at            timestamptz,
  revoked_by            text
);
```

Notes:

* `messages.type` is the content-type seam (§23.3). The `CHECK` constraint lists
  exactly the types the application implements, so a bug or a direct database
  write cannot introduce a type the code cannot render or moderate. Adding a
  type is a two-line migration: extend the check, drop `NOT NULL` on `body`.
  There is deliberately **no** `media_id` or `metadata` column yet — see §23.3
  for why dead schema is worse than a later migration.
* **Identifier columns are `text`, not `uuid`** *(corrected in phase 11)*.
  Revision 2 declared them `uuid` and said `conversation_id` equals `matchId`;
  the two were never compatible, because `util/ids.ts` generates 128 bits of
  `crypto.randomBytes` as base64url with a type prefix — `m_Muz7kC9O7-lEyLDpU_9HsQ`,
  not a UUID. The id format stays: base64url is safe in a Redis key, a channel
  name and JSON, it is shorter than a UUID at the same entropy, and the prefix
  makes a match id distinguishable from a message id in a log line. Ids remain
  validated by `keys.ts` before they can reach a Redis key. Migration
  `004_identifier_columns.sql` carries the change.
* `messages.body` is plaintext. It is ordinary application data protected by the
  boundary in §2.1, not by column-level cryptography (D15).
* `char_length` exists so telemetry, cost modelling and abuse heuristics never
  need to read `body`.
* `sender_session_id` is an ephemeral per-connection id — it identifies *which
  side of this conversation* spoke, not a person. There is no user table.
* No IP addresses, no user agents, no fingerprints. `blocks`/`enforcement` hold
  salted hashes only (data minimisation, security §57).
* `moderation_flags` holds **an array of rule ids**. Never excerpts, never text.
  *(Corrected in phase 7: revision 2 wrote the default as `'{}'`, an empty
  object. What a rule produces is a list of ids, and the severity belongs on the
  `moderation_events` row where it can be indexed — an object keyed by rule id
  would have invited storing the matched fragment as its value, which is exactly
  what I8 forbids.)*
* `reports.note` is user-generated free text and is treated as message content
  for every logging, metrics and access-control purpose (I8).

### 8.1 Database access control

* The application connects as a dedicated role with `SELECT`, `INSERT`,
  `UPDATE`, `DELETE` on its own tables and nothing else — no `SUPERUSER`, no
  `CREATE`, no access to other databases, no `pg_read_server_files`.
* Migrations run as a **separate**, higher-privileged role used only at deploy
  time, never by the running application.
* The deletion worker uses the application role; it needs no extra privilege.
* PostgreSQL listens on a private network. In the production compose profile it
  publishes no host port. Direct public exposure requires an explicit, recorded
  justification.
* Storage volumes use encryption at rest. Backups are encrypted, access
  restricted, retention defined, and backup failures alert (§10 of the change
  brief; §15 here).
* Connection strings live in secret management, never in an image or in git.
* Retention defaults, all configurable (security §25 requires exact values):
  conversations and messages **30 days**; reported conversations and their
  messages extended to **90 days** at report time; reports, moderation events
  and enforcement **90 days**; `admin_audit` **365 days**. These are starting
  values, an owner decision, not a legal conclusion.

---

## 9. Matchmaking algorithm

```
join_queue(sid, segment):
  ── Lua joinQueue ─────────────────────────────────────────────
  session missing        -> SESSION_GONE
  user_match exists      -> ALREADY_MATCHED
  state == SEARCHING     -> SADD queue (idempotent); ALREADY_SEARCHING
  state := SEARCHING; enqueuedAt := now; SADD chat:queue:{segment}
  ──────────────────────────────────────────────────────────────
  for attempt in 1..MATCH_RETRY_ATTEMPTS:
      r = try_match(sid, segment, newMatchId())
      MATCHED -> notify self + publish `matched` to partner; return
      ABORT   -> return  (a peer already matched us; `matched` is inbound,
                          or this session is gone / no longer searching)
      WAITING -> retry ONLY if r.cleaned > 0 or r.blockedSkipped > 0,
                 else send queue_status and return
```

**What the retry is for** *(clarified in phase 3; revision-2 wrote a loop whose
every branch returned, which could never iterate)*. An `ABORT` is never retried:
all three reasons — matched by a peer, session gone, no longer searching — are
answers, not transient failures, and retrying any of them would either duplicate
a match or spin.

A `WAITING` is worth retrying exactly when the attempt learned that its sample
was not representative. `SRANDMEMBER` returns K candidates; if some of them were
stale entries this attempt has now removed (`cleaned`), or were skipped because
a block applies to *this* searcher (`blockedSkipped`), then a fresh sample can
contain someone the first one did not. If neither happened, the queue is
genuinely without a partner for this searcher and resampling it finds the same
nothing, so the loop stops. Each attempt uses a **fresh match id**: reusing one
across attempts would let a retry write into the key a previous attempt had
already committed.

```
try_match(sid, segment, mid):   ── one Lua script, atomic ───────
  validate self: exists ∧ SEARCHING ∧ no user_match
      else SREM self; return ABORT(reason)
  myIp, myClient = HGET session:sid ipHash, clientHash
  cands = SRANDMEMBER chat:queue:{segment} (K+1)
  for c in cands, c ≠ sid:
      valid(c) = exists ∧ SEARCHING ∧ no user_match
      if not valid(c): SREM c; cleaned++            ← stale-entry GC
      elif blocked(myIp,myClient, cIp,cClient):     ← I12, either direction
          skip c (leave queued; it is only blocked for ME)
      else: track c with smallest enqueuedAt
  no candidate -> return WAITING(cleaned)
  SREM queue sid, best
  SET user_match:sid = mid EX matchTtl
  SET user_match:best = mid EX matchTtl
  HSET match:mid a=sid b=best segment=... createdAt=now; EXPIRE; SADD matches
  HSET both sessions state=MATCHED matchId=mid; HDEL enqueuedAt; EXPIRE
  return MATCHED(mid, best)
──────────────────────────────────────────────────────────────────
```

`blocked(a, b)` is four `SISMEMBER` calls (each dimension, each direction)
inside the script. A blocked candidate is **skipped, not removed** — it is
blocked only relative to *this* searcher and must stay matchable for everyone
else.

Fairness: uniform random sample of K, then oldest-first among the valid,
unblocked candidates. With K ≥ 2 this is provably not FIFO while bounding
starvation.

---

## 10. Concurrency and race-condition analysis

Revision-1 scenarios 1–15 are unchanged and still hold; "serialised" means the
operations are distinct Lua invocations and Redis executes scripts one at a time.

1. **Two users queue simultaneously.** Both reach SEARCHING and the SET. Both run `tryMatch`; the first to execute sees the other and creates the match, the second sees its own `user_match` and returns `ABORT/ALREADY_MATCHED`. Exactly one match. Enqueue-before-scan (D4) makes "both see an empty queue" impossible.
2. **Three or more.** Same argument pairwise; with an odd count exactly one is left `WAITING` and is matched by the next arrival. `user_match` is written for both sides in the one creating script, so nobody lands in two matches.
3. **Disconnect while queued.** `closeSession` removes it; a concurrent `tryMatch` re-validates the candidate, finds the session gone, `SREM`s it and moves on.
4. **Selected exactly as it disconnects.** Either `tryMatch` commits first (the match exists; the disconnecting side's cleanup wins `endMatch` and the survivor is released and notified) or `closeSession` commits first (the candidate is skipped). No third order — both are single scripts.
5. **Matched then immediately disconnects.** Identical to 4(a).
6. **Repeated skip.** The first ends the match and re-queues; later ones find no `user_match`, see SEARCHING, and reply `queue_status`. No duplicates, no error storm.
7. **Simultaneous skip.** `DEL match:mid` returns 1 for exactly one caller (D6), and that caller notifies the peer. The winning script already cleared **both** `user_match` keys and reset both sessions, so neither user stays attached; each side's own handler then re-queues it. Two independent searchers, zero duplicate matches.
8. **Message while partner skips.** If `resolvePartner` runs first the message is routed to a match about to end (harmless — the client drops frames whose `matchId` is not current). If it runs after, `user_match` is gone ⇒ `NOT_MATCHED`. A *deleted* match can never deliver (I6).
9. **Message right after partner disconnects.** As 8; the local path also checks `readyState === OPEN` and the remote path is fire-and-forget by design.
10. **Duplicate queue entries.** Structurally impossible: a SET keyed by a server-generated `sid`.
11. **Stale queue entries.** GC'd inside every `tryMatch` and proactively by `janitorQueue`.
12. **Stale match state.** `janitorMatches` drops matches whose record expired and ends matches with a missing session, releasing and notifying the survivor. `MATCH_TTL` is the outer backstop.
13. **Backend restart.** Sockets die, clients reconnect into new sessions. The dead instance's beacon expires within `INSTANCE_HEARTBEAT_TTL_SECONDS`, after which `janitorSessions` on a surviving instance closes its sessions and ends their matches. Graceful shutdown does this immediately and synchronously.
14. **Redis restart.** All live state is lost (persistence is off). Every script returns `SESSION_GONE`, sockets close with 4001, clients reconnect fresh. `ioredis` reconnects with backoff; `/ready` reports 503 while Redis is down so the load balancer stops sending new connections, while `/health` stays 200 because the process is fine.
15. **Multiple instances matchmaking at once.** The default assumption throughout: every transition is a server-side atomic script and no decision reads process-local state. Compose runs two backends so this is exercised, not merely claimed.

New scenarios introduced by revision 2:

16. **Block racing matchmaking.** A block is written to Redis before `endMatch` returns, so the very next `tryMatch` sees it. If the pair were *already* re-matched in the microseconds before the write, the block still applies from the next match onward and the current one can be skipped normally. Blocks are a matching filter, not a retroactive undo — stated so the UI does not promise otherwise.
17. **Duplicate `message` id under retry.** `SADD chat:dedupe:{mid}` returns 0 for a repeat, inside the same script that resolves the partner. The second copy is rejected with `DUPLICATE_MESSAGE` and never reaches delivery or persistence (I14). Because the check and the resolve are one script, two concurrent identical frames cannot both pass. The `SADD` happens **after** the partner is resolved, so a message that could not be routed does not burn its id and stays retryable. The set is capped by `DEDUPE_MAX_ENTRIES`; at the cap the script **refuses** further messages rather than accepting them undeduplicated, because accepting would mean a replay is deliverable. At the default message rate the cap represents over half an hour of continuous maximum-rate sending, so reaching it is an abuse signal rather than a long conversation.
18. **PostgreSQL unavailable during a conversation.** Delivery is unaffected (D16). The write-behind queue fills, then drops with a counted, alerted metric. Redis and matchmaking are untouched. `/ready` reflects Redis, not PostgreSQL, because a backend with a dead database can still serve chat correctly.
19. **Deletion worker racing a report.** The report sets `legal_hold`/extends `retention_expires_at` in the same transaction that inserts the report row. The deletion worker selects `where retention_expires_at < now() and legal_hold = false`, so a row being reported either is not yet selected or is re-protected before the next pass. Deletion is idempotent and re-runnable.
20. **Concurrent connection slot leak.** *(revised in phase 2)* `chat:conn:{ipHash}` is a **SET of session ids**, not a counter: a session id is added at upgrade and removed at close. A SIGKILL leaks entries either way, but a leaked *count* cannot be told apart from a live one without scanning every session in the cluster, which would lock the IP out until a global rebuild ran. Leaked *entries* can be identified in place — a member whose `chat:session:{sid}` no longer exists is dead — so `connAcquire` prunes them when, and only when, the set is over its limit. The repair cost is bounded by the limit itself and is paid solely by an IP that has actually reached it. The key also carries a TTL as a backstop.

---

## 11. Cross-instance communication

* **Channel:** `chat:ev:session:{sessionId}` — one per live session.
* **Publisher:** whichever instance performs the transition.
* **Consumer:** the single instance owning that socket. It `SUBSCRIBE`s *before* the session row is created (so no event can be missed by a subscribe race) and `UNSUBSCRIBE`s on close.
* **Local resolution:** channel name → `sessionId` → `Map<sessionId, Connection>`. No routing table, so nothing can go stale.
* **Payload:** `{ v: 1, event, matchId, at, data }` with `event ∈ { matched, message, partner_typing, partner_skipped, partner_disconnected, session_evicted }`. `v` versions the internal bus and is independent of `PROTOCOL_VERSION`: a client-visible protocol change must not force a bus change, and vice versa. A payload whose version, event name or data shape is not recognised is **dropped, not thrown on** — that is what a rolling deploy looks like from the older instance's side.
* **Match identities travel in the `matched` event** *(phase 3)*. The instance that won `tryMatch` assembles both, sends the partner theirs with the two swapped, and keeps the other. Neither side *derives* them: a nickname computed from a session id would be a stable function of an identifier, which is the property §24.3 is about. The **colour** is drawn per match. The **nickname is drawn once per session** and read from the session hash here (D50), so every stranger one session meets sees the same name.
* **Recipient gone:** the event is dropped. Correct, because every one of these events reports state already committed in Redis; a lost notification costs at most one UI update, and the client's next action re-reads authoritative state.
* **Persistence:** not required, not used. **Tradeoff stated plainly:** Redis Pub/Sub is a transient bus, not a durable log. If a subscriber is disconnected from Redis at publish time the event is lost with no replay. Streams would add durability at the cost of trimming policy, consumer-group lifecycle and per-session cursors — unjustified for notifications about ephemeral state whose worst failure is a stale label that self-corrects.

---

## 12. Skip semantics

1. `endMatch(mid)` atomically deletes the match record, clears both `user_match` keys, resets both sessions to IDLE, removes both from the queue, and drops the dedupe set.
2. The old match cannot deliver: `resolvePartner` starts from `user_match`, which is gone (I6).
3. The `DEL` winner publishes `partner_skipped{matchId}` to the peer.
4. Cleanup is symmetric — both sides are cleaned by the winning script.
5. The initiator then runs the ordinary `join_queue` + `tryMatch` flow.
6. It is immediately eligible, including for re-pairing with the same partner if they also re-queue. A cooldown list is deferred; blocking is the user-facing remedy.

Idempotent: a second `skip` returns `ALREADY_ENDED` and becomes "ensure I am
searching". The conversation's `ended_at`/`end_reason` are written once, by the
winner.

### 12.1 Leaving, which is not skipping *(added after phase 12)*

`skip` means "next stranger" and step 5 above is the whole point of it: it
re-queues. That makes it the wrong command for "I am done", and until this was
added the protocol could not express the difference — a client wanting to go
back to the landing screen had to send `skip` followed by `leave_queue`, and
**lose the race whenever the skip re-matched before the second frame was read**.
With anyone waiting, that is not a rare interleaving; it is the normal one, and
the user lands in a new conversation instead of on the screen they asked for.

`leave_chat` is `skip` without step 5:

1. Steps 1–4 exactly as above — the same `endMatch`, the same symmetric
   cleanup, the same `partner_skipped` to the peer.
2. The leaver stops at IDLE. From SEARCHING it removes them from the queue
   instead, so the command means "stop" wherever it is sent from.

The partner is told `partner_skipped`, identical to a skip or a block. A
distinct "they left rather than skipped" event would be a behavioural detail
about another user that nothing needs, and §32 of the security document is
explicit that these outcomes stay indistinguishable.

This is the same reasoning that already put `block` in IDLE rather than back in
the queue: **a user who has said stop is not asking for the next stranger.**
`block` had it because blocking is obviously that gesture; leaving is the same
gesture without the accusation.

Idempotent: leaving when not matched reports IDLE rather than erroring (rule 4).

---

## 13. Disconnect semantics

Close/error handler, guarded by a `cleanedUp` flag and safe to run twice:

1. Unsubscribe the session channel.
2. `closeSession` Lua: SREM queue, SREM sessions, decrement `chat:conn:{ipHash}`, DEL the session row, return any `user_match`.
3. If a `mid` came back, `endMatch(mid)`; the `DEL` winner publishes `partner_disconnected` and closes the conversation row.
4. Remove from the local `Map`, update gauges.

TTL is the backstop for anything the process never got to run (SIGKILL, OOM),
plus the janitor for cross-instance cleanup.

---

## 14. Message pipeline

### 14.1 Order of operations

```
frame
 → size check (ws maxPayload)
 → binary frame rejected           BAD_ENVELOPE      (transport boundary, §23.2)
 → JSON parse                      BAD_JSON
 → envelope validation             BAD_ENVELOPE / UNSUPPORTED_VERSION / UNKNOWN_EVENT
 → content type + reserved fields  UNSUPPORTED_CONTENT_TYPE            (§23.6)
 → payload validation              VALIDATION_FAILED / EMPTY_MESSAGE / MESSAGE_TOO_LONG
 → per-command rate limit (Redis)  RATE_LIMITED
 → resolve partner + dedupe (Lua)  NOT_MATCHED / DUPLICATE_MESSAGE
 → normalise (moderation view)
 → local moderation policy         MESSAGE_WITHHELD (or flag and continue)
 → deliver (local socket or Pub/Sub)
 → ack sender
 → enqueue for retention (write-behind, never blocking)
```

The client never specifies sender or recipient; both come from the match record.

**Advisory traffic skips the dedupe step** *(phase 5)*. `typing` resolves its
recipient through `resolveRoute`, which answers the same question as
`resolvePartner` — who is my partner, and where is their socket — without
touching the replay-protection set. Routing a keystroke through the dedupe path
would consume one message id per keystroke and let a client exhaust its own
replay protection by typing. Both scripts share one `resolveRouteInline` helper,
so "who is my partner" has a single answer rather than two that can drift apart.

**A rate-limited message never reaches the dedupe step.** The limit is checked
first (§14.1), so a refused message does not burn its client id; otherwise
sending too fast would silently spend the sender's own replay protection.

**`route` reports where the partner's socket is, not whether the frame
arrived.** It is derived from the partner's instance id, not from the delivery
attempt, so a publish that reached no subscriber is still `remote`. This is the
D9 local/remote split, and it does not weaken D14: `message_ack` means accepted
and routed, never received.

### 14.2 Normalisation and moderation (D19, D20)

Two representations, deliberately (security §19):

* **Displayed/stored text** — the user's own words, trimmed only. Never mutated, because mutating text that is then retained as evidence corrupts the evidence.
* **Moderation view** — a derived, throwaway normalisation (Unicode NFKC, zero-width stripped, confusables folded, whitespace collapsed, common URL obfuscation undone) used *only* to evaluate rules. Never delivered, never stored.

MVP rule set: URL/domain/IP/onion detection, email, phone, social handles,
invite links, crypto addresses, "DM me"/"add me" patterns, and a configurable
deny list. Each rule yields `allow | flag | withhold | block` with a severity.
Default policy is flag-and-deliver except for an explicit hard-block set.

Moderation is entered through a content-type dispatch, not a direct
`moderateText` call (§23.5). Today there is exactly one branch. The invariant
that matters: **no content type reaches delivery or persistence without passing
through it**, and an unhandled type fails closed.

Moderation runs on plaintext inside the trusted boundary. There is no
encrypt-then-decrypt hop: the message is validated, moderated and delivered as
plaintext, then handed to the persistence queue as plaintext. This is a direct
consequence of D15 and is the main simplification revision 3 buys.

### 14.3 Persistence path (D16, D25, D26, D27)

```
delivered message  (state: RECEIVED)
   → assign priority from server-side signals only          (D27)
   → bounded in-memory queue, per class + per-session quota (D26)   state: QUEUED
   → circuit breaker                                        (D25)
        ├── CLOSED     → batch (N rows or T ms) → multi-row INSERT  state: PERSISTED
        └── OPEN       → outage spool                               state: SPOOLED
                              └── on recovery → paced drain → INSERT → PERSISTED
```

No encryption step. Rows are inserted as ordinary application data.

#### Priority classes (D26, D27)

Priority is derived entirely from server-side signals. **No client input
contributes to it**, directly or indirectly — a client cannot set a field, a
header, or a message property that raises its own durability priority.

| Class | Contents | Assigned from |
|---|---|---|
| **P0** | reports, moderation events, enforcement actions, admin audit rows, conversation open/close rows | the fact that the server generated this record at all |
| **P1** | messages whose moderation action is `flag`, `withhold` or `block` | the moderation engine's own output |
| **P2** | messages in a conversation that already has an open report **at enqueue time** | the conversation's report state, read server-side |
| **P3** | ordinary messages | default |

Each class has a hard capacity (`RETENTION_QUEUE_MAX_P0..P3`). Capacity is
**not** shared: a full P3 cannot consume P0's budget, and a full P0 cannot
consume P3's. Within each class, a single session may occupy at most
`RETENTION_QUEUE_SESSION_QUOTA_PCT` of that class's capacity (D26). That quota
is what stops an attacker from deliberately tripping a mild moderation rule to
flood P1 and evict other users' genuine evidence.

Eviction order when a class is at capacity: drop the **oldest** entry *of that
class from the offending session first*; if the session is within its quota,
drop the oldest entry of the class. Ordinary messages are therefore always shed
before safety records, because they live in a separate class that fills first
and independently.

**When P0 itself is full** — which requires a sustained database outage *and* a
report flood exceeding the per-session report limit — the system does not
silently drop safety evidence:

1. the record is dropped, counted (`chat_retention_dropped_total{class="p0"}`) and logged at `error` with a page-worthy alert;
2. **the originating client operation stops claiming success.** A `report` whose row cannot be enqueued returns a retryable `INTERNAL_ERROR` instead of `report_ack`. Acknowledging a report we could not record would be a lie to a user asking for help;
3. chat itself continues. Refusing to carry conversations because the evidence pipeline is saturated would convert a storage incident into an outage.

#### Message durability states (§7 of the change brief)

Internal states, distinguished by the backend:

| State | Meaning | Survives process crash? | Survives host loss? |
|---|---|---|---|
| `RECEIVED` | validated and moderated, in process memory | no | no |
| `QUEUED` | accepted into the bounded in-memory queue | no | no |
| `SPOOLED` | written to the outage spool | file spool: yes · Redis spool: no | no |
| `PERSISTED` | committed to PostgreSQL | yes | yes (subject to backups) |

The client protocol deliberately exposes **none** of these. `message_ack` means
what D14 has always said it means — *the server accepted this message and routed
it to the partner* — and it explicitly does **not** mean the message is stored.
Making persistence visible to the client would either force a synchronous
database write onto the chat path or invite the client to retry on a signal it
cannot act on.

Behaviour under failure:

| Event | Outcome |
|---|---|
| process crashes right after receiving | `RECEIVED`/`QUEUED` records are lost. Delivery already happened, so the *conversation* was not affected; the retention record is missing |
| database unavailable | breaker opens, records go to the spool, chat unaffected |
| queue full | evict per class and quota, count, alert; P0 additionally fails the client operation (above) |
| spool full | stop spooling, drop by the same priority policy, count, alert |
| host fails | spooled records are lost. The spool is bounded outage tolerance, **not** durability (D28) |
| application restart | a **file** spool is re-opened and drained on boot; a **Redis** spool survives a backend restart but not a Redis restart |
| database permanently unavailable | breaker stays open, spool fills and drains to nothing, retention degrades to zero while chat keeps working. This is an alerting condition, not a self-healing one |

### 14.4 Outage spool (D28)

Bounded, plaintext, protected by the storage boundary of §2.1 — **not** durable
storage, and never described as such.

**File implementation (default).** Append-only records, one JSON object per
line, in a dedicated directory owned by the non-root application user, mode
`0600` on the file and `0700` on the directory, on a volume with encryption at
rest where the platform supports it. Bounded by `SPOOL_MAX_BYTES`,
`SPOOL_MAX_RECORDS` and `SPOOL_MAX_AGE_SECONDS`, whichever binds first.
Crash-safety: each record is a single line terminated by `\n`, appended with one
`write` and flushed; on startup the reader **discards a trailing partial line**
rather than attempting to repair it, and skips any line that fails to parse,
counting it as `chat_spool_corrupt_records_total`. Drained records are removed
by rotating to a new segment file and unlinking the drained one — never by
rewriting in place. Records past `SPOOL_MAX_AGE_SECONDS` are dropped on read
and counted.

**Redis implementation (optional).** A bounded `LIST`. Redis runs with
persistence disabled (D12), so **a Redis restart loses the entire spool**. It
survives a backend process restart and nothing more. It must never be published
publicly and must require authentication in any deployment beyond a private
Docker network. It is not durable storage and is not documented as such.

Neither implementation protects against host or storage failure.

### 14.5 Circuit breaker (D25)

```
CLOSED ──[ N consecutive write failures ]──► OPEN
  ▲                                            │
  │                                     [ cooldown elapses ]
  │                                            ▼
  └──[ probe write succeeds ]──── HALF_OPEN ───┘
                                   │
                            [ probe fails ] → OPEN (cooldown backs off)
```

* **CLOSED** — normal batched writes.
* **A rejected write is not an outage** *(phase 11)*. A SQLSTATE in class 22, 23
  or 42 — a bad value, a constraint violation, a syntax error — is proof the
  database is *available*: it parsed the statement and refused the data. It does
  **not** count as a breaker failure, and only transient classes (connection,
  resource, operator intervention, serialisation) advance the breaker.
* **A rejected batch is salvaged, not discarded** *(revised after phase 12)*.
  The original rule discarded the whole batch. A batch is one transaction, so a
  single refused row rolls back every record beside it — and a load run made the
  cost of that plain: **408 of 432 records dropped, 75 of them P0 safety
  records**, because ordinary messages in the same batches were refused. Reports
  and blocks are the evidence retention exists to keep; losing them to a
  neighbouring row's problem is not an acceptable failure mode.

  A permanent error now triggers a salvage pass: the batch is rewritten **per
  table, in dependency order, each in its own transaction**, and only a table
  that still fails is narrowed further, down to individual rows. What is dropped
  is what the database actually refused.
* **A missing parent is transient in this architecture** *(added after phase
  12)*. `23503 foreign_key_violation` is the one member of class 23 that is not
  permanent here, and the reason is §11: the `conversations` row is written by
  whichever instance won `tryMatch`, while each participant's messages are
  flushed by whichever instance owns their socket, on its own timer. An instance
  can therefore hold a perfectly valid message whose parent row is still in
  another instance's queue.

  Such records are **deferred to the back of their lane** and retried for up to
  `RETENTION_MISSING_PARENT_RETRIES` cycles — the back, not the front, because a
  record waiting on someone else has no claim on the next batch and would
  otherwise starve records that are ready. Only once the parent has genuinely
  never arrived is the record dropped and counted as
  `chat_retention_dropped_total{reason="rejected"}`. Every other class-23
  violation (unique, check, not-null) stays permanent: those describe the row
  itself, and waiting will not change them.
* **OPEN** — no writes are attempted at all. Incoming records go straight to the spool. This is the point: a dead database must stop consuming connections, timeouts and latency budget.
* **HALF_OPEN** — after `BREAKER_COOLDOWN_MS` (exponential backoff, capped), **one** probe batch is attempted. Success closes the circuit; failure returns to OPEN with a longer cooldown.
* **Draining** — on close, the backlog is drained through a token bucket at `BREAKER_DRAIN_BATCHES_PER_SEC`, highest priority class first. The database must never be hit with the entire backlog at once; recovery that re-breaks the database is the classic failure of an unpaced retry queue.
* Transient single failures do not open the circuit — `BREAKER_FAILURE_THRESHOLD` consecutive failures do — so one deadlock or timeout does not divert traffic to the spool.

---

## 15. Retention lifecycle

```
conversation created ──► retention_expires_at = now + CONVERSATION_RETENTION_DAYS   (I9)
        │
        ├── report filed ──► extend to now + REPORTED_RETENTION_DAYS, state OPEN
        │
        ├── legal hold placed ──► legal_hold = true, audited, narrowly scoped
        │                          (deletion suspended, never open-ended)
        │
        └── deletion worker (leader-locked, batched)
                 delete where retention_expires_at < now() and legal_hold = false
                        │
                        ├── success ──► chat_retention_deleted_total
                        └── failure ──► alert (I10). Never silent
```

Legal holds are explicit rows with an owner, a case id and a justification, and
releasing one restores the normal expiry. There is no "retain everything
forever because someone might ask" path.

**The boolean is not the hold** *(phase 8)*. `legal_hold` on a retained row is
the predicate the deletion query reads; the hold itself is a `legal_holds` row,
and the boolean is derived from whether any such row is still open. Anyone can
set a flag; nobody can set this without saying who they are and why. Two cases
may hold the same subject, so releasing one clears the flag **only** when no
other hold is still open, and a released row is kept — the record that data was
held, by whom and why, outlives the hold. Placing and releasing each write an
`admin_audit` row (I11).

**The cascade is guarded** *(phase 8)*. `messages.conversation_id` is
`on delete cascade`, so deleting an expired conversation would take its messages
with it — including messages under a hold whose own deadline was extended past
the conversation's. The conversation query therefore excludes any conversation
that still has a held message or a held report. Without that exclusion, a hold
placed on a message would be silently defeated by the expiry of its parent,
which is precisely the failure a hold exists to prevent.

`admin_audit` expires too, on its own much longer period: an append-only log
that is never trimmed is just an unbounded one.

---

## 16. Safety subsystem

### 16.1 Report

Recorded with conversation id, both session ids, category, optional note,
timestamp and the moderation signals already attached to that conversation. The
reporter gets only `report_ack` — no moderation detail, no indication of what
happens next (security §31). The reported user is told nothing.

A partner whose session has already expired is still reportable *(phase 7)*:
the report references the conversation and its messages, and refusing once the
other person disconnects would make "they left" the way to become unreportable.
`reported_session_id` is empty in that case rather than guessed.

A report **references** the conversation that is already retained; it never
copies message rows into itself (change brief §5). What a report does change is
the retention deadline of that conversation and its messages (§15).

`reports.note` is user-generated free text and is handled exactly like message
content everywhere: never logged, never a metric label, never in an error
message (I8).

The report row is priority **P0** (D27). If it cannot be enqueued, the client
receives a retryable error rather than `report_ack` — see §14.3. Acknowledging
a report the system failed to record would mislead a user asking for help.

Reports are signals, not verdicts. A report count alone never triggers
enforcement (security §34); mass-report abuse is countered by weighing unique
reporters, reporter history and independent moderation signals at triage time.

### 16.2 Block (D18)

Ends the current match and records a two-dimensional block:

* `clientHash` — a random token the browser persists. Rotatable by the user, so it is weak, but it is precise: no collateral damage.
* `ipHash` — coarser and evadable by VPN, and it can catch bystanders behind CGNAT, university and corporate NAT (security §14). TTL-bounded and individually disableable via config.

Neither dimension is a real identity, and the design does not pretend
otherwise. To the blocked user a block is indistinguishable from a skip
(security §32).

**Resolving the partner and recording the block are one script**
(`blockPartner`, added in phase 3). The client never names who to block — it
cannot, because it is never told a partner session id — so the server resolves
the partner from `user_match` and the match record. Doing that as a separate
round trip from the write would leave a window in which the match ends and a new
one begins in between, and the user blocks somebody they were never talking to:
rare, silent, and impossible to explain to whoever got blocked. The same script
ends the match, so the block is in place before the pair can be re-matched
(§10.16).

The script reports **how many dimensions it actually recorded**, which can be
zero: a partner whose session row has already expired has no hashes left to
store, and both dimensions can be disabled by configuration. The caller must not
report protection that was not written.

It also returns the blocked party's salted hashes *(phase 7)*, so the `blocks`
row records what was actually blocked rather than a value the caller inferred.
Those hashes are the server's own derived values and never reach a client.

### 16.3 Enforcement

Progressive and auditable (security §33): warn → rate limit → reduced
matchmaking eligibility → quarantine → suspension → ban. Every automated action
writes an `enforcement` row with its source, and every action is reversible with
`revoked_at`/`revoked_by`. Nothing becomes permanent automatically.

---

## 17. Rate limiting (R7)

Redis token buckets, one per `(command, session)`, so cheap protocol commands
cannot be abused to dodge the message limit (security §12). Shipped defaults,
all configurable (`backend/src/config.ts` is the source of truth, and a
deployment sets its own):

| Command | Sustained | Burst |
|---|---:|---:|
| `message` | 3/s | 8 |
| `typing` | 4/s | 8 |
| `join_queue` | 10/min | 4 |
| `skip` | 15/min | 5 |
| `leave_queue` | 20/min | 6 |
| `leave_chat` | 20/min | 6 |
| `block` | 12/hour | 3 |
| `report` | 6/hour | 2 |

Connection-level, keyed by `ipHash`: attempts per window, and concurrent
connections (R8). Every bucket key carries a TTL so the limiter cannot become an
unbounded memory problem. Limit internals are never exposed to clients — the
`error` frame carries only `RATE_LIMITED` and `retryable: true`.

`RATE_LIMIT_TTL_SECONDS` must be **at least `burst / perSecond` for every
configured bucket** — the time an empty bucket needs to refill completely.
A shorter TTL deletes a partly-spent bucket and hands the next request a full
one, which turns the hourly limits into "N per TTL": at the revision-1 default
of 120s, `report` would have refilled every two minutes rather than every hour.
`assertCoherent` fails startup when any bucket violates this, and the default
moved to 3600s so the slowest default bucket (`report`, about 1200s to refill)
is covered. Rates are
configured per second even for the hourly commands, so the refill arithmetic in
Lua never has to know which command it is refilling.

---

## 18. Observability

Metric names and label sets are fixed and low-cardinality. **Never** used as a
label: message text, any user content, session id, match id, message id, IP,
or any client-supplied string.

Existing: connections active/total, queue depth, active matches, messages
received/delivered/rejected, rate-limit violations, match attempts, matches
created, matchmaking failures, disconnects, skips, WebSocket errors,
matchmaking latency, delivery latency.

Added for revision 2 (security §48): connections rejected (by reason), origin
rejections, oversized frames, invalid protocol frames, reports, blocks,
enforcement actions, moderation flags by action, event-loop lag, process memory,
Redis command latency and memory, conversation writes queued/flushed/dropped,
retention rows deleted, deletion failures.

Added for revision 3: `chat_retention_queue_depth{class}`,
`chat_retention_dropped_total{class,reason}`,
`chat_retention_session_quota_evictions_total`,
`chat_spool_records`, `chat_spool_bytes`, `chat_spool_writes_total`,
`chat_spool_drained_total`, `chat_spool_corrupt_records_total`,
`chat_spool_expired_total`, `chat_db_breaker_state` (0 closed, 1 half-open,
2 open), `chat_db_breaker_transitions_total{to}`, `chat_db_write_latency_seconds`,
`chat_db_write_failures_total{code}`, `chat_backup_last_success_timestamp`,
`chat_backup_failures_total`.

`class` is one of `p0..p3` — four fixed values. No metric carries a session id,
conversation id, message id, IP or any user content, as a label **or as a
value**.

Two reasons, and the second is the one people forget *(stated in phase 9)*. A
scrape leaves the trusted boundary of §2.1 — it lands in a system with its own
retention, access control and backups, none of which are the ones described
there (I8). And every distinct label value is a separate time series: a session
id as a label is not a privacy problem that also happens to be a cardinality
problem, it is an outage. Every label value in the registry comes from a fixed
enumerated set, and `metrics.test.ts` scrapes the registry after real traffic and
asserts nothing shaped like an id, a hash or an address appears in the output.

Fixed label sets are **zero-initialised** at startup, so a dashboard shows `0`
rather than "no data" for something that has genuinely not happened. The two look
identical on a graph and mean very different things during an incident.

### 18.1 Plaintext leakage controls (critical after D15)

With no application-level encryption, the observability pipeline is the most
likely path for message content to escape the trusted boundary. Controls:

1. **Field-name denylist in the logger**, applied recursively to nested objects
   and arrays, not just top-level keys. Throws outside production, redacts in
   production. Covers content-shaped names (`text`, `body`, `content`, `message`,
   `note`, `raw`, `frame`, `input`, `value`, `excerpt`, `preview`, `snippet`,
   `sample`, `payload`, `data`) and personal data (`ip`, `remoteAddress`,
   `clientIp`).
2. **Error scrubbing.** `err.message` and `err.stack` are developer-authored
   strings that could interpolate user text. Errors raised on any path that has
   touched message content must be constructed from constants; the logger's
   error helper truncates and denylist-scans what it emits.
3. **Database error handling.** A PostgreSQL driver error can echo parameter
   values on constraint violations and timeouts. The persistence layer logs
   `error.code`, `error.constraint` and `error.table` only — never the error
   object, never the failing row.
4. **Protocol error paths never echo input.** A `BAD_JSON` failure logs the byte
   length and the parse position, never the frame.
5. **No core dumps or heap snapshots** in production containers: process memory
   contains plaintext messages. `ulimit -c 0`; no `--heapsnapshot-signal`; no
   `--inspect`.
6. **No third-party error tracker, APM or session-replay tool** receives message
   content. None is currently integrated; adding one requires re-reading this
   section.
7. **Tests assert the guarantee** rather than trusting convention (§14 of the
   change brief): a canary string is pushed through the logger, the metric
   registry and error paths, and the test fails if it appears in any output.

---

## 18.2 Threat model for message confidentiality (revision 3)

Removing application-level encryption changes *which* attackers are stopped by
cryptography and which are stopped by access control. Stated explicitly so the
tradeoff is visible rather than implied.

### Protected against

| Threat | Control |
|---|---|
| Passive network interception between client and backend | WSS/TLS; HTTP redirected to HTTPS; HSTS |
| Interception between backend and PostgreSQL | TLS on the database connection; private networking |
| Unauthorised database access from the internet | PostgreSQL not publicly published; private network; firewall |
| Unauthorised filesystem access to the spool by other local users/processes | `0600` file, `0700` directory, dedicated non-root owner |
| Stolen disks, snapshots, decommissioned media | storage encryption at rest |
| Leaked or stolen backup archives | encrypted backups, restricted access, defined retention |
| Accidental leakage into logs, metrics, traces, crash reports | §18.1 controls, enforced by the logger and asserted by tests |
| Message content reaching advertising or analytics systems | no backend ad module (I13); no third-party telemetry integrated |
| A client reading another user's conversation | server-authoritative routing; no history endpoint; no client-facing read path (I11) |

### NOT automatically protected against

Plainly, without hedging:

| Threat | Consequence |
|---|---|
| An attacker who obtains **valid PostgreSQL credentials** | reads message content directly. Application-level encryption would have blunted this specific case; it no longer does |
| A **compromised application server** | plaintext is in process memory and in the queue by design. Application-level encryption would not have helped here either, since the key would be on the same host |
| An **administrator or DBA with legitimate database access** | can read conversations outside the audited application path. Mitigated by restricting and auditing who holds those credentials — an operational control, not a technical one |
| A **malicious insider with sufficient privilege** | same as above |
| An **application vulnerability allowing unrestricted database reads** (SQL injection, an unauthenticated internal endpoint, an SSRF reaching the DB) | reads message content. Mitigated by parameterised queries everywhere, least-privilege credentials limiting blast radius, and no unauthenticated internal surface |
| **Backups restored into an unprotected environment** | plaintext conversations in a place with weaker controls. Mitigated by treating restore targets as production-class |

The honest summary: **the database security boundary is now doing work that
cryptography was previously doing.** That boundary — private networking,
least-privilege credentials, encryption at rest, encrypted backups, restricted
and audited administrative access — is therefore a hard requirement of this
architecture, not a deployment nicety. If those controls are not in place, this
design is weaker than the one it replaced.

This is not a claim that plaintext storage is insecure. It is a claim that its
security is located in the infrastructure, and that the infrastructure must
actually be configured accordingly.

---

## 19. Advertising boundary (D22, I13)

Advertising lives entirely in the frontend: reserved slots on the landing and
matchmaking screens and a desktop side rail, behind a provider interface with a
no-op default and a house-ad implementation. The backend has no ad module, no ad
endpoint and no ad state, which makes ads-doc invariants 1, 3, 4 and 9
structurally true rather than merely intended. Frequency capping is client-side
until server-verified impressions are actually needed.

---

## 20. Deployment topology (R5)

| Environment | Topology |
|---|---|
| Development | `docker compose up`: 2 backends behind nginx, Redis, PostgreSQL, Prometheus, Grafana. Two backends exist to *prove* cross-instance correctness |
| Early production | Edge/CDN → **one** backend, Redis on the same VM, small managed PostgreSQL, automated backups. No load balancer (cost §26) |
| Scaled production | Add instances only when CPU, memory, event-loop lag, connection count or deployment availability demands it (cost §27) — never because user count crossed a number |

The architecture is instance-count agnostic by construction, so scaling is a
deployment change and not a rewrite.

---

### 20.1 Draining (phase 9)

`stop()` sets the drain flag, stops the janitor and the periodic sweeps, sends
`server_shutdown` to every attached socket and closes each one **through the
ordinary path** — so every session's match is ended and every partner released,
rather than left waiting for a TTL. It then waits up to `SHUTDOWN_TIMEOUT_MS`
for the close handlers to finish their Redis work, drops idle keep-alive HTTP
connections, and closes the listener.

Holding the port open for a grace period while `/ready` reports 503 is
deliberately **not** done in the process. How long to wait for a load balancer
to deregister is a property of the deployment, not of the code, and it belongs
in a `preStop` hook or a deregistration delay where an operator can see and
change it. `/health` stays 200 while draining: the process is fine and is
leaving on purpose, and an orchestrator restarting it mid-drain would be the
wrong response.

---

## 21. Known limitations

Stated plainly rather than papered over:

* Redis Pub/Sub can drop an event; the design tolerates loss but does not prevent it (§11).
* Retention is best-effort under database outage or write-queue overflow (D16).
* **Message content is plaintext inside the trusted boundary.** An attacker with valid database credentials, a compromised application host, or privileged insider access can read conversations. §18.2 enumerates this precisely (D15).
* **The outage spool is not durable storage.** It provides bounded tolerance for a database outage. A host or volume failure loses spooled records; a Redis-backed spool additionally loses everything on a Redis restart (D28).
* **A message acknowledged to the client is not necessarily stored.** `message_ack` means accepted and routed, never persisted (§14.3, D14).
* Blocks are coarse and evadable, and the IP dimension can affect bystanders (D18).
* Local-only moderation is weak against novel or obfuscated abuse (D19).
* Presence counts are approximate and cached (D21).
* Single Redis **primary**: no Cluster support without a matchmaking redesign
  (D13). A Sentinel topology is supported and removes the node as a single point
  of failure, at the cost of 5-15 seconds of failing commands per promotion and
  the Pub/Sub events published inside that window. It is off by default, and on a
  single host it protects against a Redis process crashing and nothing more.
* Session resumption is bounded: a blip or refresh is survivable for
  `RESUME_GRACE_SECONDS`, and beyond that the conversation ends (§28, D42).
  Messages sent while a partner is away are lost rather than buffered (D43).
* Child safety relies on the age gate plus reporting and moderation; stronger measures (age assurance, automated grooming detection) are on the roadmap (§1.3).
* TLS, WAF, DDoS protection, origin firewalling, secret management and container hardening are deployment concerns outside the compose file.

---

## 22. Verification checklist

Executed and recorded in `README.md` § Verification at phase 9.

**Code** — every local import resolves; `tsc --noEmit` clean for both packages;
no placeholder implementations; no TODOs for required functionality.

**Protocol** — frontend and backend `protocol/types.ts` byte-identical; event
names, payload shapes and error codes agree on both sides; server-generated
fields never read from client frames.

**Redis** — key names consistent; every Lua script's KEYS/ARGV arity matches its
call site; queue and session state agree; match cleanup symmetric; TTLs applied;
duplicate queue entries cannot create duplicate matches.

**PostgreSQL** — migrations apply cleanly from empty; every retained table has
`retention_expires_at`; the deletion worker respects `legal_hold`; no table
stores raw IPs, user agents or fingerprints; the application role holds no
privilege beyond DML on its own tables; the database publishes no host port in
the production profile.

**Persistence pipeline** — the queue is bounded per class; a session cannot
exceed its per-class quota; priority is never influenced by client input; the
breaker opens on repeated failure and drains at a paced rate; the spool is
bounded by size, count and age, survives a partial trailing write, and skips
corrupt records.

**Concurrency** — the 20 scenarios in §10 each have a test.

**Infrastructure** — images build; compose service names match every reference;
health checks hit real endpoints; Prometheus scrapes both backends; Grafana's
datasource uid matches the dashboard; Redis and PostgreSQL are not published to
the host in the production compose profile.

**Data handling** — grep-verified and test-asserted: no log line, metric name,
metric label, metric value, error message or tracing span receives message
content or a report note; no `dangerouslySetInnerHTML` anywhere in `frontend/`;
database errors are logged by code and constraint only, never as the raw error
object; production containers disable core dumps and heap snapshots.

**No stale encryption concepts** — grep for `encrypt|ciphertext|decrypt|nonce|
AES|GCM|key rotation` returns only (a) infrastructure/storage/backup encryption
and TLS, (b) `util/ids.ts` hashing for IDs and salted IP hashes, which is a
distinct mechanism. No dead column, config variable, phase entry or prose refers
to application-level message encryption.

---

## 23. Future media extensibility

**Revision 4.** The product is and remains **text only**. This section defines
the boundaries that let images, voice and video be added later without
rewriting the conversation model, matchmaking, session management, the
WebSocket protocol, reporting, moderation, persistence or the frontend
rendering architecture — while deploying **none** of that infrastructure now
and incurring **none** of its cost.

The governing rule is §23.7: infrastructure is provisioned when a feature
launches, never because it might launch.

### 23.1 Status, stated unambiguously

| Implemented now | Architecturally prepared | Not implemented |
|---|---|---|
| Text messages | Content-type discriminator on the wire and in the schema | Image upload, storage, CDN |
| WebSocket real-time transport | Content-type-aware validation and rejection | Audio capture or streaming |
| Redis matchmaking and session state | Content-type-aware moderation dispatch (design; §23.5) | Voice calls |
| PostgreSQL retention | Content-type-aware rendering boundary (design; §23.4) | Video calls |
| Local moderation, reporting, blocking | Extensible WebSocket event model | WebRTC, STUN, TURN, SFU, media servers |
| The security architecture of §2.1, §17, §18 | Room for future signalling on the existing socket | Media moderation, media processing, object storage, signed URLs |

Nothing in the "prepared" column ships behaviour. There is no partially working
media feature, no dead UI, no stub service and no unused table.

### 23.2 The transport boundary

An architectural rule, already enforced in code:

```
WebSocket  =  application events + chat messages + (future) signalling
WebSocket  ≠  image / audio / video byte transport
```

`parseClientFrame` rejects **binary frames** outright. That check was written
for protocol hygiene, and it is also the control that makes this boundary real:
media bytes cannot enter through the chat socket even by accident. It is
deliberate, tested, and must not be relaxed.

Media, when it exists, travels beside the WebSocket, never through it:

```
future image:   client → object storage → validation → moderation
                       → media reference → WebSocket event → partner

future voice:   client ←──── WebRTC media ────→ client
                     ↖ WebSocket signalling ↗
                             Node.js
```

Node.js stays a control plane. It never becomes a media relay.

### 23.3 Message model

One change is made now, because it is the one that is genuinely expensive to
retrofit: a **content-type discriminator**.

```
Message
 ├── message_id
 ├── conversation_id
 ├── sender_session_id
 ├── type              ← 'text' today; the extension point
 ├── body              ← text content
 ├── char_length
 ├── moderation_action / moderation_flags
 ├── retention_expires_at / legal_hold
 └── server_timestamp
```

Wire format: `payload.type` is optional inbound and defaults to `text`.
`IncomingMessagePayload.type` is always present outbound, so a renderer can
dispatch unconditionally instead of testing for the presence of a text field.

**Why this field and nothing else.** The protocol is versioned and browsers
cache old clients, so introducing a discriminator later means a version bump
plus a dual-stack compatibility window on both ends. Adding it now costs one
optional field. Everything else on the media path can be added later with a
cheap migration, so adding it now would only create dead schema.

Deliberately **not** added now:

| Rejected | Why |
|---|---|
| `media_id` column | It would reference a table that does not exist — a dangling field, exactly what revision 3 removed. PostgreSQL 11+ adds a nullable column with no table rewrite, so this is cheap when media lands |
| `metadata jsonb` column | Nothing would populate it |
| A `media` table | No media exists. It ships in the same migration as the feature |
| `call.*` events in the client event enum | Reserving them would make them parse and then fail deeper in the stack. Unknown events already return `UNKNOWN_EVENT`, which is the correct answer |
| A `MessageRenderer` dispatcher component | The frontend does not exist yet (phase 10). A dispatcher with one branch and nothing to dispatch to is ceremony |
| A moderation content-type router | The moderation module does not exist yet (phase 6). It will be built to the shape in §23.5 |

When media lands, `messages.body` becomes nullable
(`ALTER COLUMN body DROP NOT NULL` — instant, metadata-only) and `media_id`
arrives together with its table.

### 23.4 Frontend rendering boundary (built in phase 10)

Phase 10 must build the message list as a dispatch on `message.type`, not as a
test for the presence of a text field:

```
MessageList
  └── MessageRenderer(message.type)
        ├── TextMessage      ← the only implementation
        ├── ImageMessage     [future]
        ├── VoiceMessage     [future]
        └── VideoMessage     [future]
```

Only `TextMessage` is built. An unrecognised type renders a neutral
"unsupported message" placeholder rather than throwing or rendering nothing — a
client can receive a type it does not know if a newer server ships one first.
This is a constraint on phase 10, not a component to write today.

### 23.5 Moderation boundary (design; built in phase 6)

Phase 6 must expose moderation as a dispatch on content type, so it does not
harden into `moderateText(message.text)`:

```
moderate(content) ──► switch (content.type)
                        ├── 'text'  → text rules  ← the only implementation
                        ├── 'image' → [future] image classification
                        ├── 'voice' → [future] transcription + text rules
                        └── 'video' → [future] sampled frames + audio
```

Today there is exactly one branch, using the local deterministic rules of D19
and the flag-by-default policy of D20. No external classifier is added to make
this extensible — the shape is the extensibility.

Invariant: **no content type may reach delivery or persistence without passing
through `moderate()`**. A future type that is not yet handled must fail closed,
not fall through the switch.

### 23.6 Security

A client-supplied `type` is a spoofing surface. Both controls are implemented
and tested now, not deferred:

1. **Unimplemented types are rejected, never coerced.** A client sending
   `type: "image"` receives `UNSUPPORTED_CONTENT_TYPE`. Coercing to text would
   let a sender believe an image was delivered when only text was.
2. **Reserved media fields are rejected, not ignored.** A payload carrying
   `mediaId`, `media`, `attachment`, `attachments`, `blob`, `file` or `url` is
   refused, so a fabricated media reference cannot be smuggled past a server
   that has no concept of media.
3. The rejection message never names the rejected type, so the protocol does
   not become a capability oracle.

Everything in §2.1, §17 and §18 is preserved unchanged: server-authoritative
state, strict schema validation, length limits, per-command rate limiting,
moderation, reporting, heartbeats, logging restrictions, database access
control, private Redis and PostgreSQL networking.

**Future media must not bypass any of it.** When images arrive they require, as
new work: MIME and magic-byte type verification, size limits, malware scanning,
image moderation, storage access control, signed time-limited URLs, upload rate
limiting and abuse quotas, retention and deletion parity with `messages`, and
EXIF/metadata stripping. None of that is implemented now and none of it is
pre-built.

### 23.7 Cost and networking

```
text     → current cost: compute + Redis + a small PostgreSQL
images   → + object storage + egress bandwidth + moderation per upload
voice    → + TURN relay bandwidth whenever peer-to-peer fails
video    → + substantially more TURN, possibly SFU + regional media infra
```

**Nothing beyond the first line is provisioned.** No object storage, no CDN, no
STUN, no TURN, no SFU, no media server, no image-processing dependency.

Networking, explicitly — this restates §20 and cost §26–31 rather than changing
them:

* A **NAT Gateway is not required** for the current text-only platform and is not deployed.
* Future WebRTC **does not inherently require a NAT Gateway**. STUN/TURN requirements are a separate concern from cloud egress topology; the two must not be conflated.
* No ALB, no multi-AZ, no private application tier, no Kubernetes, no dedicated media networking.
* Media infrastructure is evaluated when the corresponding feature is actually introduced, against measured demand — never provisioned in advance.

### 23.8 Expansion triggers

"Technically possible" is not a trigger.

**Images** — product requirement justifies sharing; demonstrated user demand;
image moderation capability ready; storage and bandwidth cost modelled; abuse
controls (quotas, upload rate limits, malware scanning) implemented.

**Voice** — validated demand; browser and device compatibility tested; WebRTC
signalling implemented over the existing socket; TURN requirement and cost
understood; safety handling defined *before* launch, because live audio leaves
no reviewable artefact and is materially harder to moderate and retain than
text.

**Video** — strong product justification; **voice already stable in
production**; infrastructure cost understood; media-server architecture
selected; moderation and safety architecture ready; expected concurrency
justifies the operational complexity.

Video is the expansion most likely to be pursued for the wrong reason. Gating it
behind stable voice is deliberate.

---

## 24. Future identity and connections

`docs/product/karobakbak-anonymous-accounts-recent-chats-friend-requests.md` specifies a
future anonymous-account system: a persistent internal user identity, a Recent
Chats list, mutual-consent Friend Requests, and Connections. It states its own
status plainly — **not for the initial text-chat launch**.

This section exists for the same reason §23 does. A deferred feature is only
cheap to defer if the decisions it constrains are written down *before* the code
that would violate them is written, and the seams it needs are identified while
they are still free.

### 24.1 Status

Not built, not scheduled, no schema, no endpoint, no protocol event. The MVP has
no user table, no account credential, no friend request, no connection, and no
Recent Chats view. `chat:session:{sid}` remains per-connection and reconnect
still creates a new session (D7).

### 24.2 What that document ratifies

Most of it describes decisions this design already made, which is the useful
outcome — it is external authority for choices that were previously local:

| Accounts doc | Already true here |
|---|---|
| §21 rotate the public identity per random chat | `Identity { nickname, colour }` is generated per match and is explicitly not stable across matches (§6.3) |
| §4 server-generated, non-sequential, non-identifying public labels | every id comes from `util/ids.ts` via `crypto.randomBytes` |
| §11 platform retention ≠ user-visible history | I11, and no client-facing history path exists |
| §30, §44 server-authoritative, atomic, idempotent, replay-protected state | every transition is one Lua script (D1); replay is I14 |
| §32 PostgreSQL authoritative for relationships, Redis for ephemeral state | §7 / §8 split |
| §9 progressive, reversible enforcement | §16.3 |

### 24.3 What it constrains about current work

Recorded as R13–R15 in §1.2, and repeated here because these are the ones that
are easy to violate by accident while building phases 3–10:

1. **Presence is aggregate and stays aggregate.** `{ online, conversations }`,
   cluster-wide, cached, approximate. Never a per-user online flag, never a
   last-seen timestamp, never presence history — for a stranger *or* for a
   future connection. Accounts doc §20 and §39 name this as a stalking
   primitive, and the point of writing it here is that it must not appear even
   once there are connections that would make it feel natural.
   *Since revised for saved connections only: per-friend online dots (§31) and a
   coarse, mutual last-active (D65, §31.7). Strangers still see nothing per-user.*
2. **The client token is a block dimension, never a credential.** D18 describes
   it as precise but trivially rotated, which is exactly right for a matching
   filter and exactly wrong for authentication. When accounts arrive they get a
   separate HttpOnly, server-validated credential (accounts doc §5). Promoting
   the block token into an account credential is prohibited.
3. **Retention is not a history feature.** No participant-facing path returns
   message content, in any phase, by any route. Access stays under I11.

### 24.4 Seams that already exist

Nothing needs to be pre-built:

* **Protocol events.** `CLIENT_EVENTS` and `SERVER_EVENTS` are lists, and
  `connected.features` announces what the server has enabled, so
  `friend_request.*` and `friend_connection.*` can be added without a version
  bump or a dual-stack period — the same property §23.3 relies on for content
  types.
* **Per-command rate limits.** `RateLimitedCommand` is derived from
  `ClientEventType`, so a new client event is a compile error until someone
  decides what rate it may be sent at. The accounts doc's §27 request-spam
  controls land in that structure rather than beside it.
* **Retention periods are already per-table and stamped at insert (D17).** The
  document's §33 requirement — separate retention for recent-chat metadata,
  friendships, accounts and message content — is the existing model, not a
  change to it.
* **Enforcement and blocks** already exist as their own subsystems (§16), which
  is where the document's block-aware eligibility checks (§16, §22) belong.

No `user_id` column is added to `conversations` in advance. It would be
speculative, and the document itself (§45) says historical conversations must
not be migrated into user-visible history, so an unattributed backlog is the
intended outcome rather than a problem to pre-solve.

### 24.5 Two questions the document leaves open

Both must be resolved by whoever implements this. Neither blocks MVP work.

1. **§21 rotation versus §29's stable `anonymous_identities.public_identifier`.**
   §21 requires the public identifier to rotate per random chat so a stranger
   cannot correlate a user across conversations; §29 models it as one stable
   column. These contradict. The resolution is almost certainly a stable
   *internal* user id plus a per-conversation public handle, but the document
   does not say so.
2. **§10 Recent Chats versus §21.** Recent Chats shows a past partner days later
   and offers a Friend Request to them, which needs a durable handle for that
   partner — the cross-chat correlator §21 forbids. A handle scoped to the
   *conversation* rather than to the *user* satisfies both, and it must be
   opaque and non-enumerable, but this needs deciding explicitly rather than
   falling out of an implementation.

### 24.6 Expansion trigger

Same standard as §23.8: "technically possible" is not a trigger.

Anonymous accounts and connections are pulled in when product retention is
validated on the random-chat product itself (UI §39) — not before, because the
feature's own success criteria (§46) require that random-chat anonymity remains
intact and that abuse does not become easier, and neither can be judged against
a product that has not yet been used at scale. The document's own five-stage
rollout (§41) is the build order when that happens, and child-safety work is
a prerequisite, not a parallel track: persistent identity plus mutual
connections raises the grooming-risk profile rather than lowering it.

---

## 25. The moderation console (phase 13, R16, I11)

The console is what makes I11 a control rather than a sentence. Before phase 13
the `enforcement` table could be written and expired on schedule but was read by
nothing, so a ban was a record of an intention with no effect on anybody — and
there was no audited path to conversation content at all, only the statement
that there would be one.

### 25.1 Two processes, two roles

The console runs as its own process (`src/admin/main.ts`) on its own port,
**off by default** (`ADMIN_CONSOLE_ENABLED=false`), bound to loopback. It is
never proxied by the public edge. `assertCoherent` refuses a console port equal
to `BACKEND_PORT`, because a shared listener defeats the separation entirely.

| | chat backend | console |
|---|---|---|
| Database role | `karobakbak_app` | `karobakbak_console` |
| `admin_accounts` / `admin_sessions` | **no access** | full lifecycle |
| `conversations`, `messages` | insert, update, delete | **select only** |
| `reports` | insert, update | select, update |
| `enforcement` | select, insert | select, insert, update |
| `admin_audit` | select, insert | select, insert |

Two properties fall out of that table, and both are asserted by tests in
`tests/integration/storage.test.ts`:

* A compromised chat process **cannot mint an operator session**. If it could,
  it would then be able to read every conversation through the *audited* path,
  writing plausible audit rows on its way.
* The console **cannot delete a conversation**. A console that could would be
  able to destroy the evidence in the case it was opened for. Deletion belongs
  to the retention worker, driven by deadlines stamped at insert time (D17).

`admin_audit` is insert-and-select for both roles, so neither can rewrite what
it wrote. Enforced by the grant, not by convention.

### 25.2 Authentication

Password (`scrypt`, RFC 7914) plus TOTP (RFC 6238), both on Node's standard
library rather than dependencies — the authentication path is the worst place in
the system to widen the supply chain, and both RFCs publish test vectors, so
`tests/unit/totp.test.ts` proves the implementation against the specification's
own numbers rather than against a belief that it works.

What a failed login reveals is deliberately flat. No-such-account, wrong
password, wrong code and replayed code all return one message, and the password
is verified against a decoy hash even when the username does not exist —
otherwise the unknown-account path returns ~100ms faster and the response time
alone enumerates accounts. A disabled account takes the same path as a missing
one. `locked` is the single exception and is returned **only after both factors
were correct**: reported earlier it would confirm an account exists to someone
guessing usernames; reported later it tells the real operator why their correct
credentials were refused.

Replay is bounded by `admin_accounts.totp_last_counter`. A code is valid for a
whole step and one step of drift either side is accepted, so without the stored
counter an observed code works for up to ninety seconds. The consume is
`update ... where totp_last_counter < $2`, which is also what makes two logins
racing on the same code safe: both read the old counter, the database decides
which write lands, and the loser is refused.

Sessions are 256-bit bearer tokens stored **only as SHA-256**, with an absolute
expiry that activity does not extend — a sliding window keeps a stolen cookie
alive exactly as long as it is being used, which is the case it most needs to
expire in. Disabling an account ends its live sessions rather than only stopping
new logins.

Two throttles, because they bound different things: a per-account lockout after
`ADMIN_MAX_FAILED_ATTEMPTS`, and a per-address budget refused before any
database work, since each attempt otherwise buys an scrypt verification. The
per-address counter is in memory rather than Redis on purpose — a Redis
dependency would take the moderation tool down with the chat cache, which is
exactly when somebody needs to read a report.

### 25.3 What a request body is allowed to decide

A report id, a duration, and words a human typed. **No route accepts an identity
hash.** Which party is sanctioned is derived on the server from the report being
acted on (`issueBanForReport`).

This is the same rule the chat protocol applies to every frame — the server is
authoritative, identity never arrives from the client — and it matters more
here. A console session that could name its own subject could ban a hash it
observed or guessed, including one belonging to somebody never reported, and the
`admin_audit` row would faithfully record a well-formed decision with nothing in
it to show the subject was chosen by the caller.

### 25.4 The queue carries no user text

`reports.note` is the reporter's own words and carries the same protection class
as a message body (I8). A queue containing it would render user content on every
visit to the console, which would mean an audit row per page load, which drowns
the log that matters. The queue therefore answers "what needs attention and in
what order" from structural facts only: category, age, message count, which
rules fired, whether anything was withheld.

Opening a case is the moment content is disclosed and the moment that is
audited. It is a `POST`, not a `GET` — not because it changes the report, but
because it writes a permanent record, and a browser, proxy or link prefetcher
will repeat a `GET` on its own.

Replay labels each message `reported` or `reporter` rather than showing a session
id. The id is ephemeral and identifies nobody, but displaying an identifier
invites treating it as a handle for a person.

Reports are worked **oldest first**: the oldest open report is the one closest to
its retention deadline, after which the conversation is deleted and the case
cannot be decided at all.

`TRIAGED` exists in the schema and is not offered as a verdict: a human who read
a conversation reached a conclusion, and a state meaning "seen, decided nothing"
is where a queue accumulates. A second verdict on an already-closed report is a
409, so two moderators cannot each believe theirs was the decision that landed.

### 25.5 The decision and the effect

The `enforcement` row is the decision; the Redis ban key is the effect.
PostgreSQL is the source of truth and Redis is a cache of it (D31), so the row
and its audit row commit first and the key is written after. The other order
would let a database failure leave a live ban with no record — an unexplained
refusal nobody can trace, revoke through the console, or justify.

If applying the key then fails, the row is revoked with
`revoked_by = 'system:apply_failed'` so the record matches reality, and the
caller is told the sanction did not take effect rather than being shown a
success.

Both dimensions are sanctioned together or neither is, in one transaction: a
partial ban — address banned, cookie not — is a decision nobody made. When
neither hash is known, because the reported party's session had expired and no
block recorded them, the console says so rather than offering a button that
writes a row with no effect.

Revocation updates rather than deletes: a ban that vanishes from the table takes
with it the evidence that it was issued, and the reason someone lifted it, which
is the more interesting half.

### 25.6 The browser surface

Three static files, no build step, no framework, no third-party script. They are
served from an explicit three-key map rather than a directory keyed by URL, so
there is no path traversal to get wrong.

`console.js` contains no `innerHTML`, and a test fails if one appears. This
origin holds a session that can read every retained conversation, so a script
smuggled in through a message body could walk the whole queue. The CSP
(`script-src 'self'`, no inline) is the second line of defence; `textContent` is
the first, and it does not stop working if a header is lost in a refactor. The
same reasoning is why the console carries no bundler: a toolchain is a supply
chain, attached to the origin with the most to lose.

### 25.7 What is deliberately not built

* **Role scopes.** One role is issued (R17). The vocabulary is in the schema and
  in every audit row; no route branches on it yet.
* **A proactive queue.** The console is fed by reports only. A detector that
  nominates repeat-content senders exists as a load-test experiment
  (`load-test/swarm/src/campaign.ts`), but promoting it widens *who gets read*
  from "people somebody complained about" to "people a heuristic suspects". That
  is a deliberate expansion of I11 purpose scope and needs its own decision, its
  own false-positive budget, and a case model pinning the exact conversation ids
  a nomination permits. It has only been evaluated on synthetic data.
* **Appeals.** There is no channel, which is why a permanent ban is not
  expressible: an indefinite sanction against a salted hash is one nobody can
  ever lift on evidence, because nobody can work out whose it is. Long sanctions
  are re-issued, which forces a second look.
* **Rate-limit, quarantine and warn actions.** The `enforcement.action`
  vocabulary carries them; only `ban` is issued and only `ban`/`suspend` are
  read at the upgrade. Shipping an action the upgrade path ignores would be a
  button that reports success and changes nothing.

---

## 26. Self-declared profiles (phase 14, R18, R19)

A name to be called, an age, a gender and a country, all optional, so a
conversation can start faster than "asl". Every value is typed by an anonymous
stranger and **none of it is verified**.

### 26.1 What the fields are, and why each has the shape it has

| Field | Shape | Why |
|---|---|---|
| `name` | free text, ≤ 24 chars | The only free-text field, and therefore the only one needing character validation and moderation |
| `age` | integer, 18–99 | A bounded integer cannot hold a sentence. The floor is §26.4 |
| `gender` | closed list: `female`, `male`, `nonbinary`, `other` | A free-text identity field is somewhere to write a slur or a contact handle |
| `country` | ISO 3166-1 alpha-2 from a fixed list | A free-text "location" is somewhere to type a street address |

Omitting a field *is* "prefer not to say", so no field has an explicit option
for it — a second way of saying nothing invites two representations of the same
state.

`COUNTRY_NAMES` ships beside `COUNTRY_CODES` in the protocol file. The code is
what travels and what anything ever matches on; the name is only how it is
spelled for a human. Both the chat client and the moderation console render
country names, so one map in the protocol beats two that drift. A unit test
fails if a code is ever added without a name, because the symptom otherwise is a
raw `MF` in a chat header that nobody notices until a user asks about it.

Gender display labels are the client's business and are short — `F`, `M`, `NB` —
because they sit inline beside an age and a country. The wire value stays the
full word, so the stored evidence and the console are unambiguous to somebody
reading a case months later, where a bare `F` is worse than useless.

### 26.2 The server keeps nothing between sessions

The profile rides on `join_queue`, is written to the session hash, and dies with
the session. The browser holds it and re-sends it on every join.

That is the whole design, not an implementation convenience. A profile the
*server* kept against a durable identifier — the block token, an IP hash — would
be a stable record of a person across every conversation they ever have, which
is precisely the cross-chat correlator §24.3 and accounts §21 forbid. Keeping it
client-side means the person holds their own declaration and clearing site data
genuinely erases it, with no server-side trace to delete.

There is no partial update. A join carries the whole profile, and a field the
client stops sending is deleted from the session hash rather than left behind —
otherwise clearing a name would leave the old one visible to the next partner.

Profiles are read *beside* `tryMatch`, not inside it. The match script is the
most race-tested code in the system and its reply is parsed positionally;
widening it to carry eight display fields would mean re-verifying every
matchmaking race in order to ship a nickname. The read costs one pipelined
round trip per conversation and none on the message path.

### 26.3 A declared name is moderated harder than a message

Any rule firing on a name refuses the join. This is deliberately stricter than
D20, which flags and delivers.

A message is one utterance judged in context, and a false positive there is
visible and recoverable. A name is a label shown to *everyone* the user meets
for the whole session, so a contact handle in it is unambiguously an advert
rather than something a moderator should weigh later. The refusal names no
detail beyond "that name cannot be used"; the rule ids are logged, the name
itself never is (I8).

### 26.4 The age floor is not an age gate

`MIN_DECLARED_AGE` is 18. A lower number is refused with its own protocol code,
`AGE_BELOW_MINIMUM`, and is not stored as a profile value.

Its own code rather than `VALIDATION_FAILED` for two reasons: the client can say
what the service is instead of "invalid input", and the server can count the
declaration — `chat_profiles_refused_total{reason="age_below_minimum"}` — as a
safety signal. That counter records only that it happened, never who or what
age.

**This is a floor on what may be declared. It is not age assurance and it does
not make the service safe for or closed to minors.** Child safety relies on
the age gate plus reporting and moderation, and stronger measures are on the
roadmap (security §24). The counter exists to give that work data.

The reasoning for the floor is §23's own list of grooming signals, which opens
with *"repeated attempts to establish age"*. A field that broadcasts a
self-declared minor's age to every stranger they meet automates the first step
of the thing that section exists to detect.

### 26.5 Declared, not filterable

No matchmaking path reads a profile. That is a decision, not an unfinished
edge.

Filtering would make these values worth lying about: the incentive to
misdeclare is created by the filter, not by the field. It would also turn a
paid "match me with X" control into a targeting tool aimed at whichever group
is filtered for — and on an anonymous stranger-chat product the filtered-for
group receives dramatically more unwanted contact, which is the dynamic §23
describes rather than one it tolerates.

If filtering is built it belongs behind the queue-segment seam (D23), needs its
own recorded decision, and should be evaluated against the safer shapes that
sell the same promise: language, interests, or country. Mutual opt-in — both
sides agreeing to be filtered on — changes the dynamic substantially and is the
version worth costing first.

### 26.6 Stored as evidence, labelled as a claim

`conversations.profile_a` / `profile_b`, one `jsonb` per side, stamped at match
time because the declaration lives on the session and the session is gone by the
time anyone investigates.

A report is frequently *about* the declaration — "they said they were 19", "the
name was a phone number" — and none of that is answerable from the transcript,
because a declaration is never a message. Without these columns a moderator
reads a conversation and cannot see the thing being complained about.

One column per side rather than six columns, because the declaration is read and
rendered whole and never queried field by field. **No index, deliberately**: an
index here would exist to search *by declaration*, which is exactly the query
this data should not make easy. A null declaration is a SQL null rather than the
JSON string `"null"`, which would read as a declared value in every later query.

The console renders both sides under "What each side said about themselves" with
the caveat stated in the interface. `name` is user-generated content and carries
a message body's protection class throughout (I8).

### 26.7 What the interface may not claim

The landing copy said "no profiles". That stops being true the moment somebody
fills one in, so it now says "no signup", and switches to "nothing kept after
you leave" once a declaration exists.

Small, and worth stating as a rule: a claim the interface visibly contradicts
costs more trust than the claim ever bought. The same reasoning puts "Changes
apply to your next conversation, not this one" in the editor when it is opened
mid-conversation — the profile was sent at join, so an edit genuinely cannot
reach the current partner, and without that line the control appears to work
when it has not.

---

## 27. Getting away from someone (phase 15)

Three changes with one theme: the safe action should not be the slow one.

### 27.1 A block that arrives late still lands

**The defect.** `blockPartner` resolved the partner from the live match. An
abuser who sent something and immediately skipped left no match behind, so the
block returned `NOT_MATCHED`, recorded nothing, and the user was told nothing
had gone wrong. They believed they had blocked somebody they had not, and could
be matched with them again.

This was measured before it was fixed — the swarm's own finding, recorded in
`docs/testing/SWARM-HANDOFF.md` §7: *"A block racing a teardown is silently lost."* The
people most likely to leave first are exactly the people most worth blocking.

**The fix.** `endMatchInline` — the single shared teardown used by `endMatch`,
`blockPartner` and both janitor scripts — now writes each side's two salted
hashes against the *other* side's session id, under `chat:last_partner:{sid}`,
with a short TTL (`BLOCK_LATE_WINDOW_SECONDS`, default 120, `0` disables it).
A block that finds no match reads that record instead.

**What it costs.** For two minutes after a conversation ends, each participant's
session id is associated with the departed party's hashes. That pairing was
already implied by the match row it replaces, it is bounded by a TTL, and it
exists only to honour an intent the user has already formed. Setting the window
to `0` restores the previous behaviour exactly.

**The record is spent when used**, on both branches, and the live branch is the
one that is easy to miss: blocking *ends* the match, and that teardown writes a
late record for both sides — including the blocker, who could then block the
same person again for the whole window, recording twice and spending two of
their twenty hourly blocks on somebody already blocked. The blocked party keeps
theirs: they may want to block back, and that is a different decision by a
different person.

A late block ends nothing and notifies nobody. `endedByUs` is false and
`partnerSessionId` is empty, so the server cannot send a `partner_skipped` about
a match that ended minutes ago to whoever now holds that session id. The
database row carries a **null** `conversation_id` rather than an empty string.

### 27.2 One tap, not five

Getting away from somebody unpleasant previously took five taps across three
screens — Safety, then Block, then Find someone else — while the person was
still sending messages. Most people will not do that. They press **Next
stranger**, which is one tap, and the block never happens.

**Block & next** does all of it in one action. It also shrinks the window §27.1
exists to cover, from several seconds of tapping to a few hundred milliseconds.

Note the deliberate asymmetry with §27.3: auto-search refuses to fire after a
block, but this button advances. That is not a contradiction. An explicit
request and an automatic behaviour are different things, and only the automatic
one needs protecting against a user who did not ask for it.

### 27.3 Auto-search, and what it refuses to do

An opt-in toggle — in Settings and inline below the composer — that looks for
the next stranger a few seconds after the current one leaves. **Off by
default**: auto-advancing puts somebody into a conversation with a new stranger
without them asking, which is the mechanic that turns a chat product into an
endless feed, and the moment where a person decides to stop is worth preserving
unless they have said otherwise.

It fires **only** when the partner left. The exclusions are the design:

* **after you block** — never. Blocking says "not this, and not again"; a fresh
  conversation three seconds later contradicts it, and it is the same reasoning
  that already makes `block` land in IDLE rather than back in the queue;
* **after you skip** — the server re-queues a skip itself, so there is nothing
  to advance;
* **after you leave** — a person who chose to stop is the last one to re-match;
* **during shutdown** — joining a queue on a closing socket achieves nothing.

The countdown is visible and cancellable. A countdown that cannot be stopped is
not a convenience.

**It respects the rate limiter rather than widening it.** `join_queue` allows a
burst of 5 refilling one token per five seconds, so a three-second advance is
faster than the refill and a run of abandonments would be refused. Raising the
limit was the wrong fix — a cheaper way to cycle through strangers is precisely
what a spammer wants, and the swarm measured labelled spammers reaching 4,852
people at the current limits. The countdown backs off after a refusal instead.

Skipping spends no `join_queue` token, so the ordinary rhythm of skipping never
touches this at all.

### 27.4 Telling someone they matched

Finding a stranger takes long enough that people switch tabs, and they return to
a conversation the partner already abandoned — which reads as a dead product
when it was working perfectly. **On by default**, because it prevents a loss
rather than adding something.

Every channel is gated on `document.hidden`. Somebody watching the screen is
never interrupted: a sound then is noise, and a desktop notification is one
about something already visible.

* **Tab title** — no permission, no sound, visible where people scan for tabs.
* **A synthesised chime** — no audio file, so no request, no cache entry, no
  `media-src` to widen, and nothing that can fail to load. The audio context is
  unlocked on the click that starts a search, the one gesture guaranteed to
  precede a match.
* **A desktop notification**, only if permission was granted. Permission is
  requested when the setting is turned on and **never on page load**: an
  unprompted dialog from a site somebody has used for ten seconds is the one
  everybody dismisses, and a denial is permanent.

The notification carries **no conversation content** — not the partner's
declared name, not a message. It is rendered by the operating system, lands in a
notification centre, and may sit on a lock screen a stranger can read. None of
that is inside the boundary §2.1 allows conversation content to occupy (I8), and
"a stranger is waiting" is the whole message anyway.

---

## 28. Session resumption (phase 16, reverses D7)

A refresh or a dropped connection no longer ends a conversation. The seat is
held for a grace window, and the returning browser proves it is the same person
with a token.

**This reverses D7**, which read: *"Reconnect creates a new session; no
resumption. No resumption token to steal, replay or leak. A blip loses the
conversation. Intended: connection lost ⇒ new stranger."*

### 28.1 Why the original reasoning no longer holds

D7 avoided one thing: a token that could be stolen. That threat is real but
smaller than it looks, and the cost was larger.

Stealing the token needs script execution on this origin — where an attacker
can already read the live conversation, so the token adds nothing — or physical
access to an unlocked device, where the same is true. Meanwhile the cost was
paid by everybody, constantly: a tab refresh, a tunnel, a phone changing
networks, all ended a conversation that had done nothing wrong.

What genuinely rules out the cheap version is that a returning browser must
prove it is the same person, or anybody could claim any conversation. The block
cookie is already sent on every connection and is the obvious shortcut; R14
forbids it, because that value is designed to be trivially rotated and to
authorise nothing, and promoting it to an authentication secret would undo the
reasoning that makes blocking safe. So it is a purpose-made token or nothing.

### 28.2 The seat, and how it expires

On a socket close with a live match, `closeSession` does **not** tear the
conversation down. It marks the session detached, leaves the row in place with
the grace window as its TTL, and returns `DETACHED`. The queue entry and the
connection slot are released, because there is no socket.

Nothing new sweeps it. If the window passes the row expires, and
`janitorMatches` already ends a match whose side has vanished and hands back the
survivor to notify. One expiry mechanism, not two that can disagree.

`instanceId` is deliberately **not** cleared on detach. `resolveRoute` reads an
empty one as `PARTNER_GONE`, which the message pipeline turns into "not
matched" and ends the conversation — so one message sent during the gap would
have destroyed the very thing the window exists to protect.

A **deliberate shutdown does not hold seats**. Draining tears sessions down and
releases partners, because a shutdown is not a blip and leaving every partner to
wait out a grace window for a server that is going away helps nobody.

### 28.3 The token

Issued at session creation, 256 bits, stored **only as a SHA-256** — a read of
Redis must not hand somebody a way into a live conversation. Unsalted is correct
here rather than lazy: the input is `crypto.randomBytes`, so there is no
dictionary to slow an attacker down over.

**Rotated on every redemption.** The presented token is deleted and a
replacement indexed, so a captured token is good for one use and only until its
owner reconnects.

**A live session is not transferable.** `resumeSession` refuses anything that is
not *detached*, so a second tab — or somebody holding a captured token — cannot
walk into a conversation in progress while the original participant watches.

**A failed resume is a new conversation, never an error.** An unknown token, an
expired window, a reaped session: all fall through to opening a fresh session,
which is the pre-§28 behaviour. A stale token after a long tab suspension is the
common case, not an exception.

It travels as a **WebSocket subprotocol** — the only value a browser can attach
to a handshake, and unlike a query string it does not land in an access log.
Clients offer `kbb.v1` beside it and the server selects that, because a server
must echo a protocol the client offered and echoing the resume entry would
repeat the token in the response headers.

The browser keeps it in **`sessionStorage`**, not `localStorage`: scoped to the
tab and cleared when the tab closes, which is exactly the life of a
conversation. A credential must not outlive the thing it unlocks.

### 28.4 What the partner sees

`partner_reconnecting`, carrying the deadline, not `partner_disconnected`. The
difference decides behaviour: told "they left", a person moves on; told "they
are reconnecting", they wait — and most of the time the conversation resumes.
`partner_returned` ends the wait, and is a real frame rather than an inference,
because without it the countdown runs to zero while the stranger is already back
and typing.

Both sides see a countdown rather than a spinner. A spinner says "something is
happening"; a countdown says how long the wait is and that it is bounded, which
is what somebody staring at a paused conversation wants to know.

### 28.5 Messages sent during the gap are lost, on purpose

They are not buffered. Buffering would mean writing message text to a Redis key,
which is precisely what invariant I8 forbids — the only Redis appearance content
is allowed is a Pub/Sub payload in flight.

So the partner's composer is **disabled** while the seat is held. Preventing the
loss is honest; accepting a message that quietly reaches nobody is not.

The send still succeeds if a client tries anyway, and `message_ack.delivered`
stays true, because that flag has always meant *accepted and routed*, never
*received* (§14.3, D14).

### 28.6 The client keeps the conversation on screen

`socket_closed` no longer clears the transcript. The server is holding the seat,
so discarding it would throw away something still live and be visibly wrong the
moment the resume lands.

The conversation is cleared on the **`connected` frame that carries no
`resumed`** — the first moment the server has actually said it is over. An
ending belongs after the server says so, not on the guess that it will.

### 28.7 A full instance keeps seats for the people coming back (phase 36, D63)

A resumption arrives through the same upgrade as a first-time visitor, so until
phase 36 it hit the same ceiling. The moment an instance filled up, the person
whose wifi dropped mid-conversation was refused — and what was refused was not a
chance to start chatting but the token this whole section exists to honour. It
is also the moment it is most likely: a busy instance is where both the drops
and the arrivals are.

The two refusals are not equally costly. Turning away a cold arrival loses a
chat that had not started. Turning away a resumption destroys a live
conversation, and the partner loses it too — one refusal, two people.

So the ceiling has three bands rather than two, decided by `admission()` in
`ws/upgrade.ts`:

| Attached | Cold arrival | Resumption |
|---|---|---|
| below `MAX_CONNECTIONS - reserve` | admitted | admitted |
| inside the reserve | **503 `at_capacity`** | admitted |
| at `MAX_CONNECTIONS` | 503 | **503** |

Three things make it a reserve rather than a wider ceiling:

* **The seat is spent only by a resumption that actually happened.** Presenting
  a token is not enough — a subprotocol is the cheapest thing in the world to
  invent. The handler runs `lifecycle.resume` and refuses the connection if it
  resumed nothing, so a made-up token costs one Redis lookup and ends in the
  same 503. Everywhere else a failed resume silently becomes a fresh session
  (§28.3); inside the reserve it cannot, because the seat was withheld from
  somebody for this.
* **The ceiling still binds.** The reserve comes out of `MAX_CONNECTIONS`, it
  does not extend it. A resumed session costs the same CPU as any other, and the
  ceiling is what the box can serve (§20).
* **It is 5% of a ceiling that is itself derived from the box**, not a count:
  a count right for one core reserves an eighth as much of an eight-core
  instance. It derives to **zero** when `RESUME_GRACE_SECONDS=0`, since seats
  held for a resumption that can never succeed would refuse arrivals to protect
  capacity nothing can use.

**The cost, stated:** cold arrivals are refused at 95% of what the instance
could serve, whether or not anybody is reconnecting. That is visible rather than
inferred — `chat_connections_reserved` is published beside
`chat_connections_limit`, so a dashboard's headroom is the real one, and
`chat_resume_reserve_admissions_total` counts the conversations the reserve
actually saved. `chat_connections_rejected_total{reason="at_capacity_reserved"}`
is kept apart from plain `at_capacity` because the two want opposite responses:
one says add capacity, the other says the reserve is working (or is too big).

The refusal a caller sees is **identical** in both bands. Telling a client that
seats exist for resumptions tells it what to claim to be.

### 28.8 What this costs

* A bearer credential exists where none did. Bounded: one session, short-lived,
  single-use, tab-scoped.
* `RESUME_GRACE_SECONDS=0` restores the original D7 behaviour exactly, and the
  teardown tests run against it so that path stays covered.
* A conversation can now be paused for up to the grace window with nobody
  talking, which the partner experiences as a wait they did not choose. Twenty
  seconds is a guess; `chat_session_resumes_total{outcome="expired"}` is the
  measurement that should replace it.

---

### 28.9 A browser cannot see a refused handshake (phase 37, D64)

The server answers an upgrade it will not accept with **503 and a reason**. Page
script gets none of it: a `close` event with code **1006**, no status, no body.
That is byte for byte what it gets when the wifi dies, when the backend is down,
and when a proxy times out — so "we are busy", "we are broken" and "your network
is gone" were one event, and the client called all three a lost connection.

`GET /api/capacity` is the only place that difference exists. It is fetched **on
failure only**, from the close handler, and only for a socket that never opened
— a close *after* an open is a dropped connection, and the client already knows
what to say about that.

| Answer | Means | What is said |
|---|---|---|
| `ok` | the service would have taken the connection | nothing new; the fault is local |
| `busy` | a cold arrival is being refused right now | "It is busier than usual…" |
| `unavailable` | draining, or Redis is unhealthy | "We cannot reach the chat service…" |
| `unknown` | the probe itself did not get through | the ordinary reconnecting line |

Five decisions inside that, each of which could plausibly have gone the other
way:

* **200 in every case, including `busy`.** A 503 here would be ambiguous with
  the outage the caller is trying to rule out: a fetch that fails and a fetch
  that says "busy" look identical from page script, which is the exact
  confusion the endpoint exists to remove.
* **No numbers.** Not the count, not the ceiling, not the instance id. The
  caller needs to know whether waiting is worth it, and a number invites the
  guess D21 refuses to hand out. It is also why the copy never says **"full"**:
  "busier than usual" is true at any load and describes a wait, where "full"
  describes a door and provokes the question of how full.
* **The probe answers about the service, not about the instance that refused.**
  It goes through the load balancer and may well land elsewhere. That is the
  more useful question, and the only one a browser can act on.
* **`unknown` is a real answer and keeps the old copy.** If the probe could not
  get through either, the network is the problem — which is what the ordinary
  reconnecting line already says. Guessing would caption a broken laptop with a
  claim about the service.
* **A refused handshake no longer says "connection lost".** Nothing was lost;
  nothing was ever held. The toast is suppressed for a socket that never opened
  and the landing screen carries the explanation, which is where somebody
  staring at a button that says "Connecting…" is actually looking.

Accepting the upgrade and closing with **1013 (try again later)** was the
alternative, and it is worse: it spends the handshake — a session id, a Pub/Sub
subscription, a connection slot — at exactly the moment the point is not to.
Polling was never on the table: the client already has jittered backoff, and one
probe per failed attempt inherits that spread for free.

**What it costs:** one HTTP request per failed connection attempt, and a public
endpoint that reports whether the service is busy. Both are bounded, and the
second says nothing an attacker could not learn by opening a socket.

---

## 29. Preference matching (phase 18, D44, narrows D37)

Premium's one functional benefit: a gender preference that is honoured when it
can be and silently abandoned when it cannot.

**This section describes the mechanism. It ships disabled** (`FILTERS_ENABLED`),
and `FILTERS_AVAILABLE` in the client is derived from it *and* `PAYMENTS_ENABLED`,
so neither half can be switched on alone.

### 29.1 What it is not

Not a filter. The distinction is the whole record, so it is worth stating in the
form the code takes:

```
filter      wait until a matching partner exists       -> holds a seat
preference  take a matching partner if one is in view  -> holds nothing
```

A filter reserves the scarce side of the pool for whoever paid. Free users then
wait longer by construction, and the filtered-for group is approached almost
exclusively by people who paid to reach it. Neither follows from a preference,
because a preference that misses falls through to an ordinary match **in the same
pass**. Every search removes exactly one partner from the pool whether it hit or
not, so throughput is arithmetically identical to today's.

It is also not a queue segment. Segmenting on the preference would shatter one
pool into a combination per preference (D23, R6) and make two people with
different preferences unmatchable even where both would have accepted.

### 29.2 Where it lives

Inside the existing candidate loop in `tryMatch`, which already:

* samples `sampleK` candidates with `SRANDMEMBER` (D2/D3),
* reads `state`, `ipHash`, `clientHash` and `enqueuedAt` for each in one `HMGET`,
* **skips** blocked candidates rather than removing them, because a block is
  relative to this searcher and the candidate must stay matchable for everyone
  else (D18),
* and picks the longest-waiting survivor.

The preference is the same shape as the block check — a reason to pass over a
candidate this searcher does not want, leaving them queued for everybody else —
and the fallback is the absence of a special case: a score of zero *is* the
ordinary candidate, so one slot holds both.

```
if sc > bestScore or (sc == bestScore and at < bestAt) then ... end
local chosen = best
```

The `HMGET` widens from four fields to seven. No extra round trip, no new key, no
new state, and no change to any transition: **what changes is which candidate is
selected, not what selecting one does.** The set of interleavings the script must
be correct under is unchanged, which is the property the "never widen `tryMatch`"
rule exists to protect.

### 29.3 Widening the sample instead of measuring the pool

Preference strength is sample size. With 15% of the pool matching, a sample of 8
contains no match about a quarter of the time; a sample of 32 almost never does.

The obvious design is to size the sample from the pool's composition. It is
rejected: the queue is a Redis set of session ids with no per-gender breakdown,
so composition would have to be a maintained counter, and that counter drifts —
a session hash reaching its TTL removes a member with nothing to decrement it.
A sample sized from a counter that is quietly wrong is worse than a fixed one,
because it looks adaptive.

So the sample escalates instead of being computed:

1. sample `sampleK` — the ordinary path, unchanged for everyone,
2. if the searcher has a preference and nothing in that sample matched, sample
   `PREFERENCE_WIDE_SAMPLE` once,
3. if that also misses, take the ordinary best already found.

This needs no knowledge of the pool at all and self-corrects: a pool rich in the
preferred gender almost never reaches step 2, and a poor one almost always does,
which is exactly when the wider look is worth paying for. `SRANDMEMBER` returns
the whole set when asked for more than it holds, so a small pool degrades to
"consider everyone", which is the best any design could do.

**The cap is a latency decision, not a statistical one.** Redis executes one
script at a time and this loop runs inside it, so the ceiling is how long the
matchmaker may block every other user's traffic, and it belongs to whoever has
measured it on the hardware in use.

### 29.4 Rate is what answers the targeting objection

D37's second objection — that a paid "match me with X" is a targeting tool — is
not answered by making the preference soft. A preference plus fast re-rolling is
a scan.

The existing limiters do not cover this. At the shipped defaults `join_queue`
allows 10/min and `skip` 15/min, which bounds flooding and not hunting: at those rates a searcher passes
every member of a small scarce group many times an hour. Two limits are therefore
part of this decision rather than a later hardening:

* a **cooldown** between preference-applied searches, which costs nothing in
  ordinary use and removes the tight cycle entirely;
* an **hourly preference budget**, after which searches continue **without** the
  preference.

Both degrade the way the preference itself degrades — to an ordinary match, never
to an error. A premium user is never told they have run out of something.

**Both are built.** `preferenceAllowance` is a single Lua script — cooldown
first, then an hourly token bucket — and `joinQueue` writes the preference only
when it grants. A refusal writes nothing, so `tryMatch` scores every candidate at
zero and takes the longest-waiting one, which is what a preference matching
nobody already does. `PREFERENCE_LIMITS_ENFORCED` is true, and the guard that
made it a startup failure stays in place pointing the other way: reaching it now
means the limits were removed.

**The cooldown runs from the last grant, not from a match ending, and this
section said the latter.** The change is recorded rather than made quietly,
because the original wording is stricter and costs the wrong person. Ending a
twenty-minute conversation and pressing next would silently drop the preference,
which contradicts the same sentence's claim that it "costs nothing in ordinary
use". Measuring grant to grant bounds a scan identically — a scan needs a
preference-applied match every cycle — while somebody who actually talked has
long since paid it.

**They key on the IP hash, read from the session's own row.** Every other limiter
here keys on the session id, which is one connection: free to replace, and
replacing it is the first thing somebody hunting would do. That is the dimension
a block uses (D18), and no caller can name a bucket other than its own, which is
protocol rule 3 applied to a limiter.

Both are observable only through `chat_preference_limited_total`, by reason.
Nothing reaches the user by design, which means that without the metric "the
preference matched nobody" and "the preference was never applied" are
indistinguishable from outside — and they call for opposite responses.

### 29.5 Fairness is unchanged, deliberately

Within both the preferred and the fallback candidates, the longest-waiting still
wins. That is the rule that stops a session being passed over indefinitely, and
it is not weakened here.

Weighted or randomised selection among preferred candidates was considered and
deferred. The concern it addresses — predictability — is already largely handled
one level up: `SRANDMEMBER` means the loop sees a *random* handful, so it picks
the oldest of a random sample rather than the globally oldest session. Changing
the tie-break is a change to a documented fairness property and wants evidence
from real usage rather than a hunch.

### 29.6 Measured before it is tuned

The sample sizes above are arithmetic, not observation: this service has never
recorded what its pool is made of. The metrics therefore ship **before** the
preference is enabled, so there is a baseline that predates the feature.

| Series | Why it is needed |
|---|---|
| queue composition by declared gender | The denominator. A fallback rate means nothing without knowing whether the pool was 5% or 40% preferred |
| preferred candidate seen in sample | Whether the sample size is adequate — the number that decides 8 vs 16 vs 32 |
| preferred selected / fell back | What the buyer actually receives |
| time to match, by whether a preference was set | Whether the preference costs the searcher anything |
| time to match and skip rate **for the preferred-for group** | The harm signal. If their wait collapses and their skip rate climbs, the feature is degrading the people it selects for, and nobody instruments this because it is not about the paying customer |

`tryMatch` already returns diagnostic counters to its caller — how many stale
entries it cleaned, how many blocked candidates it passed over — so the first
three follow a path that exists. Its reply is parsed **positionally**, so adding
to it means updating the store's parser in the same commit.

Labels stay coarse. A declared gender is a closed list and safe as a label; a
`conversation_id` never is (unbounded cardinality, and half a content leak).

### 29.7 What this does not make true

`gender` remains a claim typed by an anonymous stranger and verified by nothing,
exactly as `age` is not age assurance (§26.4, D36). Preference matching does not
upgrade it, and no copy may imply that it does — hence "a higher chance of being
matched with your preferred gender" rather than any sentence containing "women"
or "men".

The misdeclaration incentive D37 names is created by this decision and is **not**
mitigated by it. The day a preference can be bought, declaring a scarce gender
acquires cash value, and it is aimed at users who have been pre-qualified as
people who spend money. Detection is a later, separate problem; this record notes
the debt rather than pretending the fallback pays it.

### 29.8 Three dimensions, and why they are scored rather than combined

> **Superseded in part by D45 (§30).** The third dimension is no longer `vibe`
> but `intent`, which is symmetric, free, matched by equality rather than list
> membership, and excluded from the escalation. The arithmetic below is why
> scoring exists and is unchanged; read "vibe" as "intent" throughout, and §30.2
> for what differs.

Gender, country and vibe. Requiring all three to match is the obvious design and
it does not survive contact with the arithmetic.

Take a hundred people waiting, someone wanting one gender at 15%, one country at
70% and one vibe at 20%. Two people satisfy all three. At forty waiting it is
under one. So an all-or-nothing test misses almost always at the volumes this
service will actually have — and because the fallback still works, the symptom
is not an error. It is a paying user whose preference silently never applies,
which is the hardest kind of failure to notice and the easiest to refund.

So a candidate is **scored** rather than tested:

```
gender   +4
country  +2
vibe     +1
```

Highest score wins; longest-waiting breaks a tie, so fairness (D2/D3) is applied
within each score rather than discarded. Zero is the ordinary candidate, which
is why the fallback needs no special case at all.

**Gender outweighs the other two combined, deliberately.** 2 + 1 < 4, so a
candidate matching country and vibe can never displace one matching gender. It
is the dimension being paid for and the one a partial match is least useful
without. There is a test named after that, because the weights are a decision
and not a tuning constant.

The escalation widens only when the score is **zero** — never to chase a better
partial score. Looking again for a 7 when a 4 is in hand is the all-or-nothing
behaviour this scoring exists to avoid, paid for one extra pass through the pool
at a time.

**Country is the derived value, not a declaration.** `pCountry` is resolved from
`CF-IPCountry` at the upgrade and whatever the client sent in the frame is
discarded (protocol rule 3), so unlike gender and vibe this dimension cannot be
misdeclared without a VPN. It is also the dimension D37 already listed as a safe
shape. It stays session-scoped like the rest of the profile: stored against a
block token or an IP hash it would become the cross-chat correlator §24.3 and
D34 forbid.

### 29.9 `flirty` is not the same kind of value as the other three

> **Answered by D45 (§30.4), and the answer is yes.** This section asked for a
> recorded decision before `flirty` could become a matching signal. It has one.
>
> The objection below is specific to the D44 shape it was written against: a
> preference *list*, where `flirty` named what you wanted in a **stranger** and
> pointed outward at somebody who had not asked for it. Intent is symmetric —
> it says what *you* are here for and scores only against somebody who declared
> the same — so the targeting this section describes is structurally impossible
> rather than merely disallowed.
>
> What survives unchanged: the paragraph below on the age gate and D36 is still
> exactly true, and child-safety measures stronger than the gate are on the
> roadmap rather than in this section. The persona exclusion also
> survives, on a different ground — authorship, not targeting (§30.4).

`chill`, `deep` and `funny` describe a tone. `flirty` declares an intent to
engage sexually or romantically, and once it is a matching signal the server is
actively pairing people on that intent.

Child safety here relies on the age gate plus reporting and moderation, with
stronger measures on the roadmap, and `age` is a self-declared claim, which is
exactly why D36 refuses a declared age
below 18 with its own protocol code, reasoning that broadcasting a self-declared
minor's age to strangers automates a grooming signal that security §23 opens its
list with. Matching on declared sexual intent is nearer that line than matching
on "funny" is.

It is also not only a safety question. It changes what this product *is*, which
reaches the child-safety position, the s.79 safe-harbour argument, and the payment
processor's and the ad networks' terms on dating and adult content — the same
monetisation this feature exists to serve.

**The value is accepted and stored, and nothing reads it while `FILTERS_ENABLED`
is false.** Enabling a `flirty` preference needs its own recorded decision
before that flag is ever true. This section is the note that stops it being
switched on as a side effect of enabling the other three.

Personas never declare it (`SAFE_VIBES` in `personas/surface.ts`). Everything a persona says is the operator's own speech rather
than a user's (D-AI-11), already outside the s.79 safe harbour, and declaring
sexual intent on the operator's behalf to a stranger of unverified age is the
one piece of realism not worth having.

## 30. Intent (phase 19, D45, replaces `vibe`)

A single selector answering "what are you here for", used to find a partner and
**never shown to one**. It replaces the `vibe` profile field, which was the same
declaration pointed the other way: displayed to a stranger and, until this,
matched on as a third premium dimension.

### 30.1 Not a profile field, and the separation is structural

`Profile` is defined as *the thing sent to the other side*. Intent is declared
by the same client on the same frame and is deliberately not a member of it.

That is a type, not a convention, and it closes the paths one at a time:

| Path | Why intent cannot travel it |
| --- | --- |
| `matched` payload | Built from `Profile`; intent is not a field |
| `readProfiles` | Reads a fixed, exhaustive field list; `intent` is not in it |
| `conversations.profile_a/_b` | Serialises a `Profile` |
| Console profile column | Renders a `Profile` |
| `validateProfile` | Cannot produce the key, so a client sending `profile.intent` gets nothing |
| `PersonaSurface` | Carries `profile` and `intent` as siblings, mirroring the wire |

The last two matter more than they look. A value that could arrive *through* the
profile parser could be displayed by anything that renders a profile, and the
first test in `validateIntent`'s block sends `{ name, intent, vibe }` and asserts
the parsed profile has exactly four keys. It is the guarantee stated as an
assertion rather than as a comment.

**The honest limit.** Not *shown* is not *unknowable*. Matching on a value leaks
it probabilistically — two people paired on `venting` are likelier than chance
to share it. The UI copy says the value is never shown and stops there; it does
not claim a partner cannot guess it. Same discipline as §26.4 on declared age.

### 30.2 Symmetric, and therefore free

This is the decision that separates intent from D44's two dimensions, and it
follows from "one selector" rather than being an addition to it.

```
gender, country   asymmetric   a list: what I want a stranger to be
                               one party gets what they asked for,
                               the other is selected            -> premium

intent            symmetric    one value: what we are both here for
                               matched by EQUALITY against the
                               candidate's own declaration      -> free
```

Wanting to be matched on intent is wanting the same thing as the person you are
matched with, so there is nothing for a second control to express and no
selected party. D37's objections — the misdeclaration incentive, the targeting
surface — attach to the asymmetry, and intent carries neither.

**It does not trigger the wide sample, and that is what makes free affordable.**
Escalation (§29.3) is a second `SRANDMEMBER` plus up to `PREFERENCE_WIDE_SAMPLE`
further `HMGET`s. Most of the population will set an intent, so counting it in
`anyPreference` would put that second pass on nearly every search in the system
to chase a dimension worth 1. Intent is scored in whatever sample is drawn and
never asks for a bigger one. There is a test named after it.

Weight 1, below country's 2 — so a paid preference is never displaced by a free
one, and `PreferenceOutcome.score` gains a reading it did not have before: a
score of 1 is an ordinary user getting the one dimension everybody has, not a
paying user getting almost nothing.

`setIntent` is deliberately **not** gated on `preference.enabled`, and is a
separate store method rather than a field on `setPreferences` for exactly that
reason. Folding the two together is the obvious simplification and it would put
a free feature behind a paid flag with nothing in the types to notice — the
failure shape this codebase keeps finding: configured, healthy, silently doing
nothing. Every test in the `intent, which is symmetric and free` block runs with
no preference set, so that simplification cannot pass review.

### 30.3 Declining is not a wildcard

A searcher who declared nothing scores 0 against everybody, including a
candidate who declared. Treating an absent value as matching everything would
make the one non-answer the strongest signal in the system.

Cleared the same way the profile is: a join carries the whole declaration, there
is no partial update, and `setIntent(null)` issues an `HDEL`. An intent somebody
switched off has to stop steering their matches, not linger on the session hash.

### 30.4 The values, and the two that are not obvious

```
chat      Just chatting
deep      Something deeper
funny     Something funny
venting   I need to vent
```

Closed for the reason `GENDERS` is: a free-text mood field is somewhere to write
a sentence, a slur or a contact handle, and it would need moderating like a
message body. Declining *is* "no intent", so there is no option for it.

**`venting` is the one value that is not obviously symmetric.** Two people who
both want to be heard is not two people listening. It ships because the
alternative pairing is worse — somebody wanting to vent put with somebody
wanting jokes — and because a preference can only ever improve on the random
partner it replaces, never hold a seat waiting for a better one. Worth
revisiting against real numbers rather than assuming either way.

**`flirty` is in the list, and symmetry is what unlocked it.**

§29.9 asked for a recorded decision before `flirty` could become a matching
signal. This is that decision, and it is a yes. The reasoning is a shape change
rather than a change of appetite, and it is worth being exact about, because an
earlier draft of this section removed the value on reasoning that no longer
applied.

§29.9 was written against D44, where the third dimension was a preference
**list**: a user named the values they wanted in a *stranger*, so `flirty` meant
"find me somebody flirty" and pointed outward at people who had not asked for
it. That is a targeting tool, and it is what the section objected to.

Intent is symmetric. `flirty` means "I am here to flirt" and scores only against
a candidate who declared the same:

```
old (D44)   flirty-seeker  ->   anyone           targeting
now (D45)   flirty        <->   flirty only      routing
```

It cannot be aimed at anybody, and the objection §29.9 raised is structurally
gone rather than accepted.

**Routing also works in the direction nobody asks for.** Pairing flirty with
flirty is what keeps it *away* from somebody who chose `venting`. An unwanted
opener is the most common complaint about this category of product and the pool
has no mechanism against it today; this is that mechanism. Removing the value
does not remove the population — it removes the only signal that would have
sorted them.

**What this does not fix, stated plainly.** Symmetry is not a child-safety
measure. Child safety relies on the age gate plus reporting and moderation
(§26.4, D36), and stronger measures are on the roadmap.

It also reaches the s.79 safe-harbour argument and the payment processor's and
ad networks' terms on dating and adult content. Those are policy documents to
update, not reasons the code cannot carry the value.

**Personas never declare it** (`SAFE_INTENTS` in `personas/surface.ts`), and
that exclusion is *not* softened by symmetry, because it rests on a different
objection. The user-facing worry was targeting, which intent removes. The
persona worry is **authorship**: everything a persona says is the operator's own
speech (D-AI-11), already outside the s.79 safe harbour, so declaring sexual
intent on the operator's behalf to a stranger of unverified age is the operator
doing it, not a user. A test asserts it across every character and 300 seeds,
and asserts the exclusion is narrow — that personas still declare other intents,
so it cannot pass by their having stopped declaring at all.

### 30.5 What it is not

Not a filter, not a segment, not stored between sessions. Intent rides
`join_queue`, lives on the session hash as `intent`, dies with the session, and
is re-sent by the browser every time — the same rules as the profile and the
preference (D34, §24.3), so no cross-chat correlator appears.

Not gated behind a flag either, and that is a considered absence rather than an
oversight. A flag exists to turn something off, and there is nothing here to
turn off: intent cannot hold a seat, cannot make anyone wait, and cannot widen a
search. The one cost it could have imposed is the escalation, and §30.2 removes
that by construction rather than by configuration.


## 31. Saved connections (phase 20, D47)

Two strangers who both press "Save" become connected and can talk again later.
One-sided saving does nothing, is never revealed, and leaves no trace.

### 31.1 The leak the design exists to avoid

Mutual consent is not the interesting part; not disclosing a refusal is.

```
you press          -> connection_state { saved: true }     to you only
they press         -> connection_state                     to them only
both have pressed  -> connection_made                      to both, together
```

`connection_made` is the only frame in the protocol that reveals anything about
the partner's decision, and it is reachable **only when that decision was to
agree**. There is no state in which the protocol discloses a refusal.

One-sided saving would make a stranger's future contactability something they
did not agree to. Telling A that B saved them would be worse: it hands A a fact
B disclosed only on condition of reciprocity.

**The residual inference, recorded rather than discovered.** A conversation that
ends with no `connection_made` tells a saver that the other side did not save.
That is inherent to mutual consent — every system of this shape has it — and it
is bounded to "they did not", never to when or why.

### 31.2 One script, because two round trips lose the race

Both questions — *record my consent* and *did that complete a pair* — are
answered in one Lua script, for the reason routing and dedupe are (§10.17). As
two round trips, both sides pressing at the same moment could each read the
other as not-yet-saved, and neither would ever see it complete.

The field holds the caller's **account id rather than a boolean**. It costs
nothing and means a completed pair carries both ids out of the script — no
second read of two session hashes, and no window in which one expires between
the agreement and the lookup of who agreed.

The script reads the field before writing it, so a repeat of the completing
press returns `AGAIN` rather than `MADE`. Without that, every retry announces
and both people are told they connected several times.

### 31.3 The table, and the column it must never grow

`010_accounts.sql` names the line to defend in review: *if a foreign key from
here to a conversation ever appears, the separation is gone and so is the
claim.* `connections` is the table most likely to grow one, because the natural
description of the feature is "we met in conversation X and saved each other".

It has no `conversation_id`, no `match_id`, and a test asserts the column list
against the live schema rather than trusting review.

```
no conversation_id   where they met
no created_by        who asked first
no last_talked_at    an activity trail, and half a presence signal
no nickname          a label one person applies to another, unmoderated
```

`created_by` is the subtle one. It looks harmless, and it turns a symmetric
relationship into an asymmetric one by answering a question neither party agreed
to answer.

**Stored as a canonical ordered pair** with `check (account_lo < account_hi)`.
Two rows can disagree — one deleted and not the other leaves a half-connection
with no meaning. One unordered row needs every query to try both column orders.
Sorted, the primary key does the work, a duplicate is a constraint violation
rather than a silent second row, and "are these two connected" is one index
probe with no `OR` in it. The sort happens inside the Lua, the one place holding
both ids at once, and the repository re-checks it: the constraint would refuse
an unsorted pair with a message naming a column, which is a worse thing to read
at three in the morning than an error naming the invariant.

### 31.4 Removal is unilateral, and the asymmetry is the point

**Consent to connect is mutual. Consent to stay connected is not.** Requiring
agreement to leave would mean somebody cannot stop being contactable by a person
they no longer want to hear from, which is the opposite of what the control is
for. The other side is not notified, because a notification turns "I quietly
left" into an event addressed at somebody.

A hard delete, not a tombstone. A `removed_at` column would keep a record of a
relationship one person explicitly ended, which is a worse thing to hold than
the connection was.

**It asks the remover once** (phase 47). Unilateral means the other side is not
asked; it never meant the person removing is not. A bare icon beside the pencil
was unclear, and a mistaken tap cost a friendship that only another chance
meeting could restore. The question is inline in the row, one extra tap. Block
stays unconfirmed: it is a safety control, and friction there protects nobody.

### 31.5 Why this write may wait on PostgreSQL

D16 says chat must never wait on the database, and the retention path is
write-behind and lossy under overflow because of it. This write is direct and
synchronous, and the distinction is what the rule is actually about.

| | retention | a connection |
| --- | --- | --- |
| Frequency | every message | at most once per conversation |
| Trigger | a side effect | two people pressing a button |
| A lost record costs | evidence | a promise two users watched succeed |

So it takes `report`'s shape, not `message`'s. What it must not do is block
message delivery, and it does not: nothing on the message path calls into it.

### 31.6 What is counted

`chat_connections_made_total` counts created rows, never presses — the
repository reports whether the insert created anything, and a repeat does not
increment. There is deliberately **no counterpart for one-sided saves**: that
number measures how often somebody was not saved back, and publishing it turns a
private refusal into an operational statistic.

---

### 31.7 The friends drawer, and last-active (D65)

Friends moved from a popover above the composer — reachable only while chatting
or searching — to a drawer opened from the header, beside the avatar, on every
screen. Online friends first, then the most recently active, then the rest in
the server's newest-first order.

**Last-active.** `accounts.last_active_at` (`021_last_active.sql`) holds the
start of the last hour the account was online *while sharing presence*. The
heartbeat that already publishes presence stamps it, gated by
`chat:active:{account}` so PostgreSQL sees at most one write per account per
hour, and the write is never awaited: the heartbeat loop walks every socket in
turn, and a slow database there would time out healthy connections. Turning
sharing off nulls the column in the same statement, so there is no moment at
which somebody is hidden and still remembered.

`/auth/connections` sends `lastActive` as a bucket — `{ unit, count }`, measured
from the end of the stored hour, coarser the further back — and never the
timestamp. It is null when the friend hides, when nothing was recorded, and for
every friend when the *viewer* hides (mutual). The three are indistinguishable
on purpose, and the drawer renders all of them as the friendship date.

**Chat.** An online friend has a Chat button. `/auth/reconnect/ask` accepts a
connection `handle` as well as a presence token, resolves it against the
caller's own list, and reaches the friend through the *visibility* key, so a
friend who hid answers "away" exactly as one who left. One ask per friend per
minute (`FRIEND_ASK_COOLDOWN_SECONDS`), answered "wait" to the asker only. The
`reconnect_request` frame gains an optional `friend.label`: the *recipient's*
own name for the asker, read from the recipient's list — never a name the asker
chose. Pairing is the existing private lane, so blocks still refuse it.

**Blocking a friend ends the friendship.** A live block, and Block on a chat
request, remove the connection when both sides are signed in. A late block
(D38) cannot: the record it spends holds the departed partner's key hashes, not
their session, so there is no account to name. Remove covers that case.

**Not done.** Online dots are not mutual — they shipped without the rule and
say nothing about the past. The badge is polled (60s closed, 30s open, never in
a background tab) rather than pushed, because a push is a per-user presence
stream on the socket, which R13 keeps off the wire.

## 32. Sign-in (phase 20, D48)

One OIDC provider, authorization-code flow with PKCE, exchanged server-side.
Cognito is the intended provider (`docs/product/FEATURE-INTAKE.md`) and no file outside
its own configuration values names it.

### 32.1 Free, and not coupled to payments

Signing in unlocks **saved connections, recent history and friend requests**.
None of those is a scarcity worth selling, and all three are the reason to hold
an account at all. Premium is `PAYMENTS_ENABLED` plus `FILTERS_ENABLED` — the
asymmetric matching preferences (D44) — and neither gates this.

The `AuthModal` this replaces had it backwards: its live check was
`ACCOUNTS_ENABLED && PAYMENTS_ENABLED`, so sign-in required a subscription.

### 32.2 The account holds a subject and nothing describing a person

Scope is `openid email`. The email is verified by the provider, read from the
token, and **dropped**. No name, no age, no picture.

That is an achieved property rather than an absence: it keeps the Privacy
Policy's new data row a single line with one retention period, and it keeps "we
know almost nothing about you" true even for users who sign in. It is also why
no age is collected — the age gate already does that job (§26.4, D36), and a
stored self-declared age *looks* like age assurance while being durable and
attached to an identity, which the gate deliberately is not.

### 32.3 `external_id`, not the primary key

The obvious shape is to use the provider's `sub` as `accounts.id`: one less
column, one less index, no join. It is refused, on the intake's own words —
*"Cognito is the credential, not the account."*

`accounts.id` is generated by `util/ids.ts` and **payments reference it**.
Handing that key to a vendor means the identifier a financial record is built on
is defined by a system this project does not control, and a provider migration
would rewrite every foreign key rather than one column.

The unique index is **partial**, because the column is null for every account
that predates sign-in — a plain unique index would collapse all of them into
one. There is no `provider` column: a second provider is a policy change before
it is a schema change, since the Privacy Policy names each processor
individually and requires a 14-day notice.

### 32.4 Three secrets cross the redirect, and each stops one attack

| | Without it |
| --- | --- |
| `state` | Login CSRF: an attacker's authorization code delivered into a victim's browser, ending with the victim's saved connections in the attacker's account |
| `nonce` | Replay of an id token captured from any other sign-in against the same pool and client |
| PKCE verifier | Anyone holding the code can redeem it, not only the party that started the flow |

They ride one short-lived httpOnly cookie rather than server-side state, which
would need a store, a TTL and a sweep to hold something already bound to one
browser for ten minutes.

`SameSite=Lax`, not `Strict`. Strict is dropped on the provider's cross-site
redirect back, producing a sign-in that fails **only for the people who actually
completed it** — the worst possible distribution of a bug.

Cleared on the callback whatever the outcome, so state is single-use. Replayable
state is state that is not doing its job.

`__Host-` where cookies are Secure, dropped on local HTTP rather than left to
fail: the prefix is a browser-enforced guarantee, and a `__Host-` cookie without
`Secure` is rejected silently — which reads as "sign-in does nothing".

### 32.5 No JWT library, and what makes that acceptable

Node has verified a JWK natively since 16, so a library would add a dependency,
a transitive tree and a CVE feed to save about forty lines.

It is also true that hand-written token validation is where authentication bugs
live. What makes the trade acceptable is that every check has a test for its
**failing** case — the happy path proves the signature check works and proves
nothing about whether `iss`, `aud`, `nonce` or `alg` are looked at:

```
alg      RS256 only. `none` is the oldest JWT vulnerability; HS256 is the
         second, because the signing key would be the public key, which is
         public.
kid      Must name a key in the live JWKS. Rotation refetches once, rate
         limited, so forged kids cannot make this an amplifier.
sig      Over the exact `header.payload` bytes as received. Canonicalising
         first is how signature checks get bypassed.
iss      Stops a token from a different user pool, which is otherwise valid.
aud      Stops a token minted for another client of the same pool.
exp/iat  Small skew, in one direction only.
nonce    Stops replay. `sub` is read only after all of the above passes.
```

### 32.6 The anonymous path is never affected

Chatting never requires an account. A database that cannot answer resolves the
credential to null, which is the anonymous path — the same line
`010_accounts.sql` draws from the other direction, and the reason `/ready`
reflects Redis rather than PostgreSQL.

`accountForRequest` lives with the routes so the socket and the HTTP routes
share one credential resolution. Two copies would drift, and the sharper risk is
that only one checks account status, leaving a suspended account able to do over
a socket what it is refused over HTTP.

### 32.7 Half-specified configuration is refused at startup

`AUTH_ENABLED=true` with a missing issuer produces a sign-in control that
renders, navigates, and lands on a provider error page the user cannot act on —
which reads as "sign-in is broken" rather than "sign-in is not configured".

`assertCoherent` names the missing variable. It also refuses
`AUTH_SECURE_COOKIES=false` in production, because the session cookie is a
bearer credential and a cleartext one is a credential in transit. The same shape
as every other guard in this file: something that looks configured, reports
healthy, and silently does not work.

