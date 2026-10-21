# Progress log

Running record of what each phase delivered, what was decided, and what the
next session should pick up. Newest phase last. Phase status also lives in
`PHASES.md`; this file carries the reasoning.

---

## Phase 0 — repo skeleton and design record ✅

**Commit:** `chore: scaffold repo structure and design record`

Delivered:

* Full monorepo folder tree (`backend/`, `frontend/`, `load-test/`,
  `monitoring/`, `scripts/`, `docs/`).
* `DESIGN.md` — written before any code. Invariants I1–I8, state machine,
  versioned WebSocket protocol, Redis data model, matchmaking algorithm,
  15-scenario concurrency analysis, cross-instance Pub/Sub design, 14 recorded
  design decisions with tradeoffs.
* `.env.example` with every variable documented.
* `.gitattributes` forcing LF (containers are Linux; CRLF breaks them).
* `scripts/verify-protocol.mjs` — fails the build if the backend and frontend
  copies of the protocol types drift.
* Git initialised on `main`, remote `github.com/akhiljoe/karobakbak`, pushed.

Decisions worth remembering:

* **Protocol types are duplicated, not shared via a workspace package.** Each
  package stays independently installable and Dockerisable (each Docker build
  context is its own directory). The drift checker is what makes duplication
  safe.
* **Redis will run with persistence disabled** (`--save "" --appendonly no`) as
  a second line of defence on the ephemerality requirement.

---

## Phase 1 — protocol, config, logging ✅

**Gate:** `tsc --noEmit` clean · 50 unit tests pass · protocol copies identical.

Delivered:

| File | Purpose |
|---|---|
| `backend/src/protocol/types.ts` | Wire contract, source of truth. Events, envelopes, payloads, error codes, close codes, type guards |
| `backend/src/protocol/validate.ts` | Inbound frame parsing. Never throws, never echoes user content, never reads identity from a frame |
| `backend/src/protocol/envelope.ts` | Outbound frame construction; server stamps `id`, `timestamp`, `version` |
| `backend/src/config.ts` | `loadConfig(env)` — pure, eagerly validated, with cross-field coherence checks |
| `backend/src/logger.ts` | Structured JSON logging with a chat-content field denylist |
| `backend/src/util/ids.ts` | All ids from `crypto.randomBytes`; salted IP hashing |
| `backend/src/util/time.ts` | Server-side timestamps and monotonic latency clock |
| `frontend/src/protocol/types.ts` | Generated copy |
| `backend/tests/unit/*.test.ts` | 50 tests across validation, config, logging, envelopes |

Decisions and non-obvious details:

* **Message length is checked before trimming.** A megabyte of whitespace is
  reported as `MESSAGE_TOO_LONG`, not `EMPTY_MESSAGE`, and the trimmed copy is
  never allocated.
* **Control characters are rejected via `charCodeAt`, not a regex.** Writing a
  regex literal containing raw control bytes turned the source file binary to
  git and grep. Tab, LF and CR are allowed; the rest of C0, DEL and C1 are not
  (terminal/log-injection vector).
* **Lone surrogates are rejected** rather than silently mangled into U+FFFD by
  UTF-8 encoding.
* **HTML in message text is explicitly allowed** and travels as plain text; the
  frontend renders text nodes, so no sanitisation library is introduced.
* **`ALLOWED_ORIGINS` empty means allow-any** and produces a startup warning.
  `IP_HASH_SALT` left at its default warns only in production.
* **Cross-field config checks** reject: heartbeat ≥ half the session TTL, frame
  limit too small for a max-length message, burst < one second of refill, match
  TTL < session TTL, janitor lock shorter than its interval, and a key prefix
  containing `:` or a space.
* `module: node16` + CommonJS output, `isolatedModules` in `tsconfig.json` (not
  in the ts-jest transform, which is deprecated).

---

## Design revision 2 — reconciled with `docs/` ✅

> **Partly superseded by revision 3 (below).** The application-level encryption
> described in this entry (old D15) was removed; message content is now stored
> as plaintext inside the trusted boundary. Everything else in this entry still
> stands. Kept unedited as a record of what was decided when.

Read all six product documents in `docs/` and reconciled them against the
original brief. `DESIGN.md` rewritten as revision 2; `PHASES.md` re-planned.

**The load-bearing conflict:** the original brief demanded complete
ephemerality; the security doc (§2.3, §25–30), the cost doc (§58 stack, §18 DB
growth) and the ads doc (§P2) all assume conversations are **retained**. Owner
decision on 2026-08-18: **full retention now**. Invariant I8 was rewritten
rather than deleted — message text still never reaches a Redis key, a log, a
metric, a file or a third party; its only resting place is an AES-256-GCM
encrypted column in PostgreSQL.

Eleven reconciliation decisions are recorded in `DESIGN.md` §1.2 (R1–R11), each
with its authority. Other owner decisions:

* Product name is **karobakbak** everywhere; the frontend spec's "BakBakBox" is superseded.
* MVP gains **report, block, typing indicator, live presence count, temporary
  stranger identities**.
* Filters get a **seam only** — queue keys are `chat:queue:{segment}` and every
  script takes a segment argument, but only `default` is implemented.

New design decisions worth remembering (full table in `DESIGN.md` §3):

* **D15** application-level AES-256-GCM on message bodies, so a leaked DB
  credential or stolen backup yields ciphertext. Costs content search — no
  feature needs it.
* **D16** retention is **write-behind** with a bounded queue and batched
  inserts. Chat delivery never waits on PostgreSQL, and a database outage
  cannot become a chat outage. The price is that retention is best-effort under
  overflow; drops are counted and alerted, never silent.
* **D17** `retention_expires_at` is stamped at write time, so changing the
  policy can never retroactively extend the life of stored data.
* **D18** blocks key on salted IP hash + client token hash, not session id (a
  session-id block would expire the instant the user reconnects). Both
  dimensions are evadable and the IP one can hit CGNAT bystanders — documented,
  TTL-bounded, individually disableable.
* **D20** moderation defaults to **flag-and-deliver**, not withhold. Local
  deterministic rules only; no paid classifier until abuse volume justifies it.
* **D22** advertising is frontend-only. The backend has no ad module, which
  makes "ads can never touch matchmaking" structurally true instead of merely
  intended.
* **D24** `id` is now **required** on `message` and deduplicated per match, in
  the same Lua script that resolves the partner — so two concurrent identical
  frames cannot both pass.

Five new race scenarios added to the concurrency analysis (§10 now has 20):
block racing matchmaking, duplicate message under retry, PostgreSQL unavailable
mid-conversation, deletion worker racing a report, concurrent-connection
counter leak after SIGKILL.

Retention defaults chosen as starting values, all configurable: conversations
and messages 30 days, reported conversations 90 days, reports/moderation/
enforcement 90 days, admin audit 365 days. These are an owner decision, not a
legal conclusion — child-safety policy, age assurance and grooming detection
remain unimplemented and block public launch pending legal review.

---

## Design revision 3 — application-level encryption removed ✅

Owner-directed architecture change: remove application-level message encryption
from the persistence and spool pipeline. Store message content as plaintext
application data inside an explicitly defined trusted boundary, and locate
confidentiality in infrastructure controls instead.

**Inspection finding that shaped the work:** there was no encryption code to
remove. Phases 7–8 were unbuilt — no `pg` dependency, no `storage/` directory,
no migrations, no spool. The only `node:crypto` usage is `util/ids.ts`
(`randomBytes` for ids, `createHash` for salted IP/client hashing), which is a
different mechanism and stays. So this was a design, configuration and
documentation change, plus one real code hardening.

**Second finding worth remembering:** the security document never mandated
application-level encryption. §27 requires encryption *at rest* and *in
transit*; §28 is explicitly conditional — "*If* application-level encryption is
used". The mandate came from `DESIGN.md` D15 in revision 2, not from the
requirements. Removing it therefore contradicts nothing in `docs/`; only two
ambiguous diagram labels needed disambiguating to "at rest".

What changed:

* **D15 replaced.** Plaintext inside the trusted boundary of the new §2.1, which
  enumerates each control and the specific attack it defeats.
* **I8 rewritten** around locations rather than cryptography, and extended to
  cover `reports.note`, exception messages, metric *values*, tracing spans and
  crash reports.
* **Schema:** `messages.ciphertext`/`nonce`/`key_id` → `body text not null`,
  plus `char_length` so telemetry never reads the body, and
  `moderation_action`. No dead encryption fields left behind. New §8.1 pins
  least-privilege roles, deploy-only migration role, and no public port.
* **New §18.2 threat model** stating plainly what is and is not protected. The
  honest line: the database security boundary is now doing work cryptography
  used to do, so it is a hard requirement rather than a nicety.
* **D25 circuit breaker** (CLOSED/OPEN/HALF_OPEN, single probe, exponential
  backoff, token-bucket paced drain) so a recovering database is not knocked
  over by its own backlog replay.
* **D26/D27 priority queue.** Per-class caps *plus* a per-session sub-quota
  inside each class. Caps alone are gameable: an attacker who deliberately
  trips a mild moderation rule promotes their own traffic into the flagged
  class and evicts other users' genuine evidence. Priority is server-assigned
  only, at enqueue time, with no retroactive promotion — which is also what
  keeps reports from duplicating message data.
* **D28 spool** — bounded file (0600/0700, non-root owner, size/count/age
  limits, trailing-partial-line discard, corrupt-record skip, rotate-and-unlink
  drain) or optional bounded Redis list. Explicitly documented as *not* durable
  storage in both forms.
* **Durability states** `RECEIVED → QUEUED → SPOOLED → PERSISTED`, internal
  only. The client protocol is unchanged: `message_ack` still means accepted
  and routed, never persisted.
* **P0-full behaviour defined:** the record is dropped, counted and alerted, and
  the originating client operation stops claiming success — a `report` that
  cannot be enqueued returns a retryable error instead of `report_ack`.
  Acknowledging a report the system failed to record would mislead a user
  asking for help. Chat itself continues.

**Code hardening (`backend/src/logger.ts`).** Removing encryption makes the
logger the primary leakage control, and it had real holes:

* the denylist was **shallow** — `{ ctx: { text } }` leaked silently. Now
  recursive through objects and arrays, with depth/breadth caps and the
  violating path reported in the error;
* denylist expanded from 8 to 26 names (`message`, `note`, `raw`, `frame`,
  `input`, `value`, `excerpt`, `preview`, `snippet`, `transcript`,
  `conversation`, `userAgent`, …), while keeping `ipHash`/`clientHash`/ids
  loggable;
* `errorFields()` now truncates message and stack;
* new `dbErrorFields()` — a `pg` error echoes parameter values on constraint
  violations and timeouts, so the raw object must never be logged. Emits
  code/constraint/table/routine only.

Tests: 50 → 62, including canary-string assertions that a stand-in for private
conversation text never appears in any log output, at any nesting depth, and
never survives a simulated PostgreSQL constraint violation.

One behaviour improvement surfaced by a failing test: depth limiting now
truncates circular structures instead of falling back to the "not
serialisable" line. Assertion updated; a BigInt case covers the genuine
fallback.

`tsc --noEmit` clean, 62/62 unit tests pass.

---

## Design revision 4 — future media extensibility ✅

Owner-directed: make the platform future-ready for optional images, voice and
video **without** implementing them and **without** provisioning any media
infrastructure.

**Inspection first, and it shrank the task.** Only phase 1 is built. The Redis
layer, WS server, moderation, PostgreSQL and the entire frontend are designed
but unwritten. So most of what looked like an "evolution" is really a
*constraint on code not yet written* — the right output is a corrected design,
not speculative scaffolding.

**Second finding:** the transport boundary was already enforced. `validate.ts`
rejects binary frames, which is exactly the "WebSocket is not a media
transport" control. It was written for protocol hygiene; it is now documented
as deliberate and load-bearing, and must not be relaxed.

**The only code change: a message content-type discriminator.** That is the one
media-related seam genuinely expensive to retrofit, because the protocol is
versioned and browsers cache old clients — adding it later means a version bump
plus a dual-stack window on both ends. Adding it now costs one optional field.

* `payload.type` optional inbound, defaults to `text`.
* `IncomingMessagePayload.type` always present outbound, so a renderer
  dispatches unconditionally instead of testing for a text field.
* `messages.type` in the schema with a `CHECK` listing only implemented types.
* New `UNSUPPORTED_CONTENT_TYPE` error code.

**Two security controls, because `type` is client-supplied and therefore a
spoofing surface:**

1. Unimplemented types are **rejected, never coerced**. Coercing `image` to
   `text` would let a sender believe an image was delivered when only text was.
2. Reserved media fields (`mediaId`, `media`, `attachment`, `attachments`,
   `blob`, `file`, `url`) are **rejected, not ignored**, so a fabricated media
   reference cannot be smuggled past a server with no concept of media.
   The error never names the rejected type, so the protocol is not a capability
   oracle.

**Deliberately rejected, each with a reason in `DESIGN.md` §23.3** — this was
the substance of the review, not the additions:

* `media_id` column — would reference a table that does not exist. A dangling
  field is exactly what revision 3 removed. PostgreSQL 11+ adds a nullable
  column with no rewrite, so it is cheap later.
* `metadata jsonb` — nothing would populate it.
* A media table — ships with the feature.
* `call.*` events in the enum — reserving them would make them parse and then
  fail deeper. `UNKNOWN_EVENT` is already the correct answer.
* A `MessageRenderer` component — the frontend does not exist yet. A dispatcher
  with one branch and nothing to dispatch to is ceremony.
* A moderation content-type router — the moderation module does not exist yet.
  Phase 6 will be built to the documented shape.

New `DESIGN.md` §23 covers: status table (implemented / prepared / not
implemented), the transport boundary, the message model, the frontend and
moderation dispatch shapes as constraints on phases 10 and 6, security, cost
and networking (explicitly: **no NAT Gateway**, and WebRTC does not inherently
require one — STUN/TURN is a separate concern from cloud egress topology), and
per-feature expansion triggers with video gated behind stable voice.

Zero infrastructure added. Zero cost added.

Tests 62 → 75: default/explicit/null discriminator, every spoofed type
rejected, non-string types rejected, each reserved media field rejected,
rejection is not an oracle, binary frames still rejected, `call.*` events still
`UNKNOWN_EVENT`, and all existing text behaviour unchanged.

`tsc --noEmit` clean, 75/75 pass, protocol copies identical.

---

## Phase 1b — protocol revision ✅

Phase 1 shipped protocol v1 before the product documents were read. Everything
those documents added to scope — safety, typing, presence, temporary identities
— touches the wire format, so the protocol was extended *before* the Redis layer
was built on top of it rather than after.

The version stays **1**. Nothing is deployed, so the new events are added to v1
instead of forking a v2 and paying for a dual-stack compatibility period.

### Protocol (`backend/src/protocol/types.ts`)

* New client events: `typing`, `report`, `block`.
* New server events: `presence`, `partner_typing`, `report_ack`.
* `REPORT_CATEGORIES` is a closed enum (harassment, spam, sexual_content,
  grooming, threats, hate, scam, other). Closed rather than free text because
  the category is the one part of a report that is safe on a metric label or a
  triage queue — it carries no user-authored content. The reporter's words go in
  `note`, which is protection-class I8, exactly like a message body.
* `Identity { nickname, colour }`, generated per match, carried on `matched` as
  `you` / `partner`. No session id and no stability across matches: an identity
  that persisted would be a deanonymisation primitive.
* `message_ack` gains `delivered`. A message that policy withheld is an ack with
  `delivered: false`, not an error — the frame was valid and there is nothing to
  retry, and an ack indistinguishable from delivery would teach users that
  "sent" means nothing (D20).
* `connected` gains `features`, so the UI hides disabled controls instead of
  inferring capability from a rejection.
* `presence` carries the literal `approximate: true`, so the UI is structurally
  unable to present cached Redis cardinalities as exact (D21, UI §5.1).
* New error codes `DUPLICATE_MESSAGE` and `MESSAGE_WITHHELD`; neither is
  retryable.
* `ServerLimits` gains `maxReportNoteLength` and `typingPerSecond`, so a client
  throttles its own typing indicator instead of discovering the bucket by
  getting rate-limited.

### Validation (`backend/src/protocol/validate.ts`)

* Envelope `id` is **required on `message`** and optional everywhere else. It is
  rejected as `BAD_ENVELOPE` before any payload check, and the structural error
  is reported first so a client that forgot the id is not sent chasing a content
  problem. A server-generated fallback id was rejected as an option: it would
  make every retry a new message and silently disable replay protection (I14).
* `typing.active` must be a strict boolean. `"false"`, `0` and `1` are exactly
  the values that would flip a stop into a start under coercion.
* `report.category` must be in the enum; the rejected value is never echoed.
  `note` is optional, length-checked before trimming, and absent / null /
  whitespace-only all normalise to a single `null` so persistence stores "no
  note" one way instead of three.
* An over-length note is `VALIDATION_FAILED`, not `MESSAGE_TOO_LONG` — the
  message code would send the client to check the wrong limit.
* The control-character and lone-surrogate checks were factored into
  `checkTextCharacters` and now apply to report notes as well. A note reaches a
  human moderator's console, so a terminal escape in it is the same injection
  vector as in a message body.

### Config (`backend/src/config.ts`)

* `MAX_MESSAGE_LENGTH` default 2000 → **500** (R3); `MAX_REPORT_NOTE_LENGTH`
  added at 500.
* The single message bucket became `limits.rates`, one `{ perSecond, burst }`
  per command (R7). The key type is `Exclude<ClientEventType, 'ping'>`, derived
  from the protocol, so adding a client event is a compile error until someone
  decides what rate it may be sent at. `ping` is excluded deliberately: it is
  already bounded by the heartbeat interval, and limiting it would let an idle
  client be reaped for keeping itself alive.
* **`RATE_LIMIT_TTL_SECONDS` default 120 → 3600, with a new coherence check.**
  A bucket key that expires before it could have refilled hands the sender a
  full bucket, which turns "10 per hour" into "10 per TTL" — at the old 120s
  default, `report` would have allowed 10 per two minutes. `assertCoherent` now
  fails startup when the TTL is shorter than `burst / perSecond` for any
  bucket. Recorded in `DESIGN.md` §17.
* The frame-size coherence check now bounds over the longest user-text field
  rather than over messages alone, since a report note travels on the same wire.
* **R9:** an empty `ALLOWED_ORIGINS` is now a startup failure under
  `NODE_ENV=production` — an empty allowlist accepts a WebSocket upgrade from
  any site, which is CSRF against a chat session. It stays a warning in
  development, where the dev server's port moves around.
* `PRESENCE_INTERVAL_MS` added.

### Verification

`tsc --noEmit` clean, **109/109 unit tests pass** (was 75), protocol copies
identical. New coverage: required message id and its ordering against payload
errors, strict-boolean typing, every report category accepted and every
non-category rejected, note limit independent of the message limit, note
character rules, no echo of note or category in any error, per-command bucket
parsing, the rate-limit TTL coherence rule, and production-fatal origins.

`npm run verify` still fails at its frontend typecheck step, because
`frontend/package.json` does not exist until phase 10. Pre-existing, unrelated
to this phase; the protocol-drift check and the backend typecheck and tests all
pass.

---


## Phase 2 — Redis layer ✅

All live matchmaking state now lives in Redis, and every transition is one Lua
script. Nothing in this phase talks to a socket: it is the layer the WebSocket
lifecycle in phase 3 sits on.

### Files

* `backend/src/redis/keys.ts` — one function per key and channel, built from the
  configured prefix. Components are asserted against `[A-Za-z0-9_-]{1,128}`;
  every id that reaches them is already server-generated, so the guard is there
  for the day a code path passes something client-derived. The error names the
  role, never the value.
* `backend/src/redis/client.ts` — command and subscriber connections. Separate
  by protocol necessity, not preference: a connection in subscriber mode refuses
  ordinary commands, so a shared one would break the first `EVALSHA` issued
  after the first subscribe. `keyPrefix` is deliberately unused — ioredis would
  rewrite key arguments and disagree with the keys the Lua derives.
* `backend/src/redis/scripts.ts` — 18 scripts plus a shared prelude, with an
  `EVALSHA` → `NOSCRIPT` → `EVAL` loader and asserted KEYS/ARGV arity.
* `backend/src/redis/store.ts` — typed wrappers returning discriminated unions,
  so an `ABORT` cannot be read as a success and a match id cannot be taken from
  a result that does not have one.

### Decisions this phase forced

* **Scripts read the clock from Redis (`TIME`), never from an argument.** Queue
  fairness compares `enqueuedAt` values written by *different* instances, and a
  rate-limit bucket is refilled from a timestamp another instance wrote. Passing
  each instance's own wall clock would make both fairness and rate limiting
  depend on NTP skew between hosts.
* **`chat:conn:{ipHash}` became a SET of session ids rather than a counter**
  (`DESIGN.md` §7, §10.20 revised). A leaked *count* from a SIGKILLed instance
  cannot be distinguished from a live one without scanning every session in the
  cluster, so the IP stays locked out until some global rebuild runs. Leaked
  *entries* are identifiable in place — a member with no session row is dead —
  so `connAcquire` prunes them, but only when the set is already over its limit.
  The repair is bounded by the limit and is paid only by an IP that has actually
  reached it.
* **The dedupe set fails closed at its cap** (`DESIGN.md` §10.17 extended).
  Accepting messages past the cap would mean a replay is deliverable, which is
  the one thing the set exists to prevent. At the default 5/s message rate the
  10,000-entry cap is over half an hour of continuous maximum-rate sending, so
  reaching it is an abuse signal rather than a long conversation.
* **`SADD` to the dedupe set happens after the partner is resolved**, so a
  message that could not be routed does not burn its id and stays retryable.
* **Keys that cannot be known before the script runs are derived inside it**
  from the prefix in `ARGV[1]` — a candidate's session row is not knowable until
  the queue has been sampled. Safe only because this is a single Redis, not a
  Cluster (D13); a unit test pins the Lua's key layout to `keys.ts` so the two
  cannot drift into separate, invisible namespaces.
* **Janitor scripts return survivors instead of notifying them.** A Lua script
  must not `PUBLISH`: its effects are replicated, and the publish would be
  replayed on a replica with no subscribers. A unit test asserts no script
  contains one.
* **`newInstanceId` now sanitises its result.** It feeds `chat:instance:{iid}`
  directly, and a hostname routinely carries dots.

### Bug found by the tests

`janitorSessions` could name a survivor that the *same* sweep then reaped — two
sessions of one crashed instance are exactly that case. The publish would have
been a harmless no-op, but the return value was misleading, so survivors are now
filtered at the end of the pass.

### Config added

`DEFAULT_QUEUE_SEGMENT` (validated as a key component), `MAX_CONNECTIONS_PER_IP`,
`DEDUPE_MAX_ENTRIES`, `BLOCK_TTL_SECONDS`, `BLOCK_DIMENSION_IP_ENABLED`,
`BLOCK_DIMENSION_CLIENT_ENABLED`. Both block dimensions disabled is legal and
now warns: the block button would end the match and record nothing.

### Verification

`docker-compose.test.yml` runs Redis on `:6380` with `--save "" --appendonly no`,
the same flags as production (D12), so the tests exercise the same durability
semantics.

**138 unit tests and 123 integration tests pass**, `tsc --noEmit` clean.
Integration coverage: one suite per script, plus `DESIGN.md` §10 scenarios 1, 2,
3, 4, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17 and 20 — including two-instance
races driven from two separate Redis connections, exactly-one-winner on
simultaneous `endMatch`, replay rejection under concurrent identical frames,
recovery from `SCRIPT FLUSH`, and connection-slot reclamation after a simulated
SIGKILL.

---

## Phase 3 — session and match lifecycle ✅

Everything a connected user can do to matchmaking state, expressed without
touching a socket. The WebSocket server in phase 4 parses frames and writes them
back; this layer decides what happens. Keeping the two apart is what makes the
lifecycle testable against a fake store, and what stops transport assumptions
leaking into matchmaking.

### Files

* `backend/src/ws/registry.ts` — `Map<sessionId, Connection>`. Answers one
  question, "is this socket attached to *this* process", and participates in no
  decision. A routing table would need invalidating and would be wrong for as
  long as it was stale; the per-session channel avoids the problem entirely.
* `backend/src/ws/identity.ts` — the per-match `{ nickname, colour }` pair.
* `backend/src/ws/events.ts` — the §11 bus contract: encode, decode, and the
  mapping from event to client frame.
* `backend/src/ws/dispatch.ts` — local-first delivery, publish otherwise,
  `local | remote | dropped` returned for the metric label.
* `backend/src/ws/lifecycle.ts` — open, join, leave, skip, block, heartbeat,
  close.

Every operation has the same shape: one Lua script commits the transition, then
the peer is notified **only if the script says this caller is the one that owes
them a notification**, then an outcome is returned. Notification is deliberately
after the commit and deliberately cannot fail the operation — the transition is
already in Redis, and rolling back a real match because a publish failed would
turn a cosmetic failure into a real one.

### Decisions this phase forced

* **`addBlock` was replaced by `blockPartner`, an atomic script.** The client
  never names who to block — it is never told a partner session id — so the
  server resolves the partner from `user_match` and the match record. Resolving
  and recording as two round trips leaves a window in which the match ends and
  another begins in between, and the user blocks somebody they were never
  talking to. The same script also ends the match, so the block is in place
  before the pair can be re-matched. It reports how many dimensions it actually
  recorded, which can be zero when the partner's session row has already
  expired: the caller must not claim protection that was not stored.
  `DESIGN.md` §16.2 updated.
* **The match-retry loop now has a reason to exist.** Revision 2 wrote a
  `for attempt in 1..MATCH_RETRY_ATTEMPTS` loop whose every branch returned, so
  it could never iterate. An `ABORT` is still never retried — matched by a peer,
  session gone and no longer searching are answers, not transient failures. A
  `WAITING` is retried exactly when the attempt learned its sample was not
  representative: it cleaned stale entries, or skipped candidates blocked
  relative to this searcher. Then a fresh `SRANDMEMBER` can contain someone the
  first sample did not. Otherwise the loop stops, because resampling an empty
  queue finds the same nothing. `DESIGN.md` §9 updated.
* **Identities are generated, not derived, and travel in the `matched` event.**
  The winning instance makes both and sends the partner theirs with the two
  swapped. Deriving a nickname from a session id would be cheaper but would make
  it a stable function of an identifier, and anything stable across matches is a
  correlation handle (§24.3). Distinctness is guaranteed by construction — the
  second identity draws from the lists with the first one's choices removed —
  rather than by redrawing until the two happen to differ.
* **The bus is versioned separately from the wire protocol.** An unrecognised
  version, event name or data shape is dropped rather than thrown on, because
  that is exactly what a rolling deploy looks like from the older instance's
  side. `DESIGN.md` §11 updated.
* **A skip from IDLE or SEARCHING reports state instead of erroring.** The user
  asked for "next stranger" and is already looking for one; an impatient
  double-tap must not become a visible failure.
* **Blocking leaves the blocker IDLE, not searching.** Someone who has just
  blocked a stranger has said something about wanting to stop, and dropping them
  straight into another conversation reads as the product ignoring them.
* **A refused connection slot rolls the session row back.** The TTL would
  eventually clear it, but "eventually" is a window in which it is a matchable
  ghost.

### Leak control

`EventDispatcher` logs the event **name** and never the event, because one arm
of that union carries message text. The exhaustiveness guard in `toClientFrame`
throws a constant for the same reason: `JSON.stringify(event)` in an error
message is a log line waiting to happen (I8). Two unit tests push a canary
string through both failure paths and assert it does not appear.

### Verification

**206 unit tests** (fake store, fake sockets, fake publisher — hermetic) and
**145 integration tests**, `tsc --noEmit` clean.

The integration suite drives two `SessionLifecycle` instances with separate
Redis connections, registries and dispatchers over one keyspace, and asserts on
what a real subscriber received: exactly one match when both join at the same
moment, `matched` arriving over Pub/Sub with the identities swapped, exactly one
`partner_skipped` when both sides skip at once, a block that ends the match and
then refuses the re-match, disconnect notifying the survivor once across two
close handlers, and a disconnect racing a match leaving neither side pointing at
a partner that is gone.

A unit test caught the reverse mistake in its own assertion: after a
simultaneous skip both sides re-queue and are free to pair with each other
again. That is `DESIGN.md` §12.6 working as intended — a cooldown list is not
the MVP remedy, blocking is — so the test now says so instead of forbidding it.

---

## Phase 4 — WebSocket server ✅

The transport. An HTTP server with three endpoints, one upgrade path, and the
per-socket concerns that only exist once there is a real socket: frame parsing,
strikes, backpressure, liveness, close codes. No framework (D10) — the routing
is short enough to read in full, which matters because the upgrade handler is
where every untrusted HTTP-level input is decided on.

### Files

* `backend/src/ws/upgrade.ts` — the security-relevant reads of the request, as
  pure functions: client address, origin, block token, cookie.
* `backend/src/ws/connection.ts` — one attached socket. Owns strikes,
  backpressure and liveness; touches no Redis and decides nothing about
  matchmaking.
* `backend/src/ws/subscriber.ts` — the receiving half of §11.
* `backend/src/server.ts` — HTTP routes, upgrade, command router, sweeps,
  shutdown.
* `backend/src/index.ts` — startup order and signals.

### Decisions this phase forced

* **`X-Forwarded-For` is read from the right, and only when `TRUST_PROXY_HOPS`
  says a proxy exists.** Each trusted proxy appends the address it saw, so the
  rightmost N entries are ours and everything left of them is whatever the
  client sent. Reading the leftmost entry — the usual shortcut — would let a
  client choose its own rate-limit and block identity. A chain shorter than the hop count is treated as absent rather than
  as partially trustworthy. New config, defaulting to 0.
* **The block token is server-generated and lives in an HttpOnly cookie.** The
  design named `clientHash` but never said how the token arrives. A query
  parameter would put a stable pseudonymous identifier into every proxy access
  log; `localStorage` would put it where page script can read it. Neither is
  justified for a value whose only job is to be hashed into a block dimension.
  A presented token that does not match the server-generated shape is discarded
  rather than hashed, so a client cannot aim its token at somebody else's block
  key. It stays a block dimension and not a credential (R14). `DESIGN.md` §6.5
  added.
* **Subscribe before the session row exists.** `lifecycle.open` gained a
  `beforeCreate` hook for exactly this. §11 already required the ordering; the
  phase-3 signature could not express it. Getting it backwards loses the
  `matched` event of precisely the users who were quickest — the hardest kind
  of bug to reproduce.
* **One sweep for all sockets, not a timer per connection.** At five thousand
  sockets the per-connection version is five thousand timers and five thousand
  live closures for no benefit. Liveness asks "has this client answered
  recently", not "did it answer the last ping": one dropped pong on a flaky
  mobile connection is not a reason to end a conversation.
* **`BACKEND_PORT=0` is now legal** and means "bind any free port". The socket
  tests need it so parallel runs do not fight over a fixed port; the bound port
  is returned by `listen()` and logged. The old config test asserting 0 was
  invalid has been replaced.
* **`/ready` reflects Redis and says so in its body.** A test asserts the
  response has no database field at all, so the §10.18 rule is enforced by
  something other than memory when phase 7 lands.

### Known gap, closed by phase 5

`message`, `typing` and `report` are answered with a retryable
`INTERNAL_ERROR`, and `connected.features` advertises `typing: false` and
`report: false` so a well-behaved client does not send them. This is a build
ordering artefact, not a design position: the pipeline lands in phase 5 and the
report path in phase 7. It is visible in the protocol rather than hidden — the
`features` map exists precisely so a client never has to infer a capability
from a rejection.

### Verification

**225 unit tests and 173 integration tests**, `tsc --noEmit` clean.

The socket suite runs a real server on an ephemeral port and drives real
clients: the handshake and its `connected` frame, origin refusal that does not
name the allowlist, an HttpOnly cookie issued once and reused on the next
connection, the session row holding hashes and never the token or the address,
refusals at the per-IP concurrency cap, the attempt-rate limit and the instance
capacity, binary frames rejected, malformed frames answered without dropping
the connection, a strike counter that closes with 4003, an oversized frame
closed with 1009 by the transport before this process allocates it, a canary
string absent from every error, matching and skipping and blocking and
disconnecting across two sockets, presence marked approximate, and a shutdown
that warns every client before closing with 1001.

---

## Phase 5 — message pipeline ✅

Messages and typing indicators, end to end, across two backend instances. The
parts this needed mostly existed already — the dedupe script from phase 2, the
dispatcher from phase 3, the socket from phase 4 — so the work was the ordering
between them, which is where the correctness lives.

### Files

* `backend/src/ws/messages.ts` — `MessagePipeline`: rate limit → resolve +
  dedupe → deliver → ack.
* `backend/src/redis/scripts.ts` — `resolveRouteInline` extracted into the
  prelude, plus a new `resolveRoute` script.
* `backend/src/server.ts` — per-command rate limiting at the edge, `message`
  and `typing` routed to the pipeline.

### Decisions this phase forced

* **`typing` gets its own resolve script, without dedupe.** Routing a keystroke
  through `resolvePartner` would consume one message id per keystroke and let a
  client exhaust its own replay protection by typing. Both scripts share
  `resolveRouteInline`, so "who is my partner" has one answer rather than two
  that drift.
* **The rate limit runs before the dedupe, and that is load-bearing.** A
  refused message must not burn its client id, or sending too fast would
  silently spend the sender's own replay protection. There is a test for
  exactly this: after a rate-limited send, the dedupe set still holds one entry,
  not two.
* **`route` is derived from the partner's instance id, not from the delivery
  attempt.** A publish that reached no subscriber still reports `remote`,
  because `route` describes which path was taken — the D9 split the label
  exists for — and `message_ack` has never meant "received" (D14). Reporting
  delivery failure here would invite clients to show a receipt the server does
  not promise.
* **Delivery failure cannot unwind a send.** By the time the frame is
  dispatched the dedupe entry is written; rolling back would burn an id for a
  message nobody has. The sender is acked, and the partner has lost one message
  they can no longer be shown — which is exactly what the ack refuses to
  promise.
* **`typing` is not acknowledged.** Acking an advisory indicator would double
  that command's traffic to confirm something nobody acts on.
* **A vanished partner is `not_matched` for a message and `no_partner` for
  typing.** For a message there is genuinely no conversation left to be in; for
  typing there is nothing the sender could fix or retry, so it is not an error.

### Superseded phase-4 assertions

Two socket tests asserted the phase-4 state of the world and were updated
rather than deleted: `features.typing` is now `true`, and the
"command this build does not serve" test moved from `typing` to `report`, which
still waits for the retention store. `features.report` stays `false` —
acknowledging a report the system could not record would be a lie to a user
asking for help (§14.3).

### Verification

**242 unit tests and 199 integration tests**, `tsc --noEmit` clean.

The gate is a two-instance socket suite: two servers, two Redis connections,
two registries, one keyspace. It covers a message crossing instances, the ack
echoing the client id with the remote route, the local path when both sockets
are on one instance, both directions, burst ordering, no session id anywhere on
the wire, a repeated client id rejected and not delivered twice, an identical
retry staying safe, ids scoped to a conversation, typing start and stop with no
ack and no dedupe cost, a message flood answered with `RATE_LIMITED` and no
limit internals, ping left unlimited, and a message refused after the partner
skips, disconnects or blocks.

---

## Phase 6 — moderation ✅

Local deterministic rules, a flag-by-default policy, and the content-type
dispatch that keeps the whole thing from hardening into `moderateText(text)`.

### Files

* `backend/src/moderation/normalise.ts` — the moderation view.
* `backend/src/moderation/rules.ts` — eight rules, each a pure predicate.
* `backend/src/moderation/policy.ts` — matches to an action.
* `backend/src/moderation/index.ts` — `moderate()`, dispatching on content type.

### Decisions this phase forced

* **The moderation view is allowed to be aggressive, and that is the point.**
  It joins words across dots, rewrites `(at)` to `@` and folds Cyrillic onto
  Latin — mangling that would be unacceptable if anyone saw it. It is safe
  because the view is discarded the moment the rules have run and is never
  delivered, stored or logged, and because a match **flags** by default. The
  cost of an over-eager fold is a signal a human may glance at, not a message
  somebody could not send.
* **The view deliberately does not lowercase.** A base58 crypto address is
  case-sensitive; lowercasing would make it indistinguishable from a long
  ordinary word. Rules that do not care ask for case-insensitivity themselves.
* **URL detection uses a TLD allowlist, not `\.[a-z]{2,}`.** Because the view
  closes spaces around dots, a generic pattern turns "ok.thanks" into a URL and
  floods the flag queue with ordinary sentences. Weak coverage of obscure TLDs
  is the accepted cost (D19), and there is a test holding five ordinary
  sentences to no URL flag.
* **A rule result never carries what it matched.** Flags are rule ids and a
  severity, nothing else. They travel into log lines, metric labels and
  `moderation_events` rows, and the matched fragment is the part of a message
  most likely to be personal — an address, a number, a name. The cheapest way
  to keep I8 true here is for the excerpt never to exist.
* **`MODERATION_HARD_BLOCK_RULES` is validated against the rules that exist.**
  A typo would silently disable a hard block an operator believed they had
  configured, which is the kind of failure discovered only by the abuse it did
  not stop. `config.ts` now imports `RULE_IDS` for that check.
* **Deny-list terms are escaped.** An operator writing `.*` must not
  accidentally build a pattern that flags every message.
* **`withhold` and `block` differ in what the sender is told, not in what the
  partner sees.** Both stop the message. A withheld message is reported through
  `message_ack` with `delivered: false`, because the frame was valid and there
  is nothing to retry; a hard-blocked one gets `MESSAGE_WITHHELD`, which is not
  retryable. Neither names the rule that fired — that would tell someone
  probing the filter exactly which pattern to work around.
* **Moderation runs after the dedupe**, per §14.1, so a duplicate is never
  judged twice.

### Found while writing the tests

`hmu` did not fire: the pattern required it to be followed by "me", but `hmu`
already *is* "hit me up". Restructured into standalone alternatives. A second
test asserted a deny-listed `.*` would match the literal text `.*` — it does
not, because the view closes the space before the dot, and the test was
asserting an artifact rather than behaviour. Replaced with a term that survives
normalisation.

### Verification

**287 unit tests and 204 integration tests**, `tsc --noEmit` clean.

Unit coverage runs each rule against both what it should catch and what it must
not, the full policy table (allow / flag / withhold / block against
deliverability), severity escalation, the disabled path, and the boundary: an
unhandled content type fails closed, fails closed even with moderation switched
off, and is never coerced to text. Over real sockets: a flagged message still
arrives, a withheld one is acked with `delivered: false` and never reaches the
partner, a hard-blocked one returns a non-retryable `MESSAGE_WITHHELD`, the
conversation stays usable afterwards, and no frame ever names a rule.

### One unexplained flake

During one combined run of both suites a single integration test failed. It did
not reproduce in eleven consecutive runs afterwards and the failing name was not
captured. The likely candidates are the socket tests that wait a fixed 150ms for
an *absence* — "no message arrived" cannot be waited for, only slept through,
and those sleeps are the only timing assumptions in the suite. Recorded rather
than declared fixed. If it recurs, the fix is to assert the absence against a
positive signal — a following message that *does* arrive — rather than against a
clock.

---

## Phase 7 — PostgreSQL and the retention path ✅

The retained store, and the write-behind pipeline that fills it without chat
ever waiting on it.

### Files

`storage/`: `migrations/001_initial.sql`, `migrations/002_roles.sql`,
`migrate.ts`, `pool.ts`, `records.ts`, `queue.ts`, `breaker.ts`, `spool.ts`,
`repositories.ts`, `retention.ts`, `sink.ts`.

`enqueue` is synchronous, does no I/O and cannot throw. That is the whole
contract: if anything ever awaits a database insert on the message path, that is
the bug (D16).

### Decisions this phase forced

* **`RetentionSink` is a narrow interface with no `flush` and no way to ask
  whether a record was written.** The chat path depends on that, not on
  `RetentionWriter`. An answer to "did it persist" would tempt somebody to wait
  for it, and the whole point is that nobody can.
* **The queue reports *why* it evicted.** The caller cannot tell a quota
  eviction from an ordinary one by inspection, and the difference is the entire
  justification for the sub-quota (D26) — a flooding session displacing its own
  records rather than other people's evidence.
* **The spool refuses rather than evicts when full.** It is already the degraded
  path; discarding older evidence to make room for newer evidence is the worse
  failure.
* **`blockPartner` now returns the blocked party's hashes** so the `blocks` row
  records what was actually blocked instead of a value the caller inferred.
  They are the server's own derived values and never reach a client.
  `DESIGN.md` §16.2 updated.
* **A partner whose session expired is still reportable.** The report references
  the conversation, and refusing once the other person disconnects would make
  "they left" the way to become unreportable. `reported_session_id` is empty
  rather than guessed. `DESIGN.md` §16.1 updated.
* **`moderation_flags` is a JSON array, not an object.** Revision 2 wrote the
  default as `'{}'`. What a rule produces is a list of ids; an object keyed by
  rule id would have invited storing the matched fragment as its value, which is
  exactly what I8 forbids. `DESIGN.md` §8 corrected.
* **`retention_expires_at` is computed in the repository, never as a column
  default.** A database default would be re-evaluated against whatever the
  configuration said at insert time in a way nobody could audit; computing it in
  code is what makes D17 checkable, and there is a test asserting the stamp is
  within a second of `now + configured days`.
* **Report insertion extends the conversation and its messages in the same
  transaction**, using `greatest(...)` so a second report can never shorten a
  deadline the first one extended.

### Two bugs the tests found

* **The spool double-counted corruption.** `corrupt` and `expired` were
  incremented on every scan of the same file, so an undrained spool inflated its
  own metrics each cycle — reading as escalating corruption when nothing new had
  happened. Split into "what the last scan saw" plus "what a clear has since
  discarded".
* **A close handler could produce an unhandled rejection.** When Redis goes away
  while a socket is closing — a restart, a failover, a test tearing its server
  down — `lifecycle.close` rejected inside an event handler with nowhere to
  send it. Now caught and logged in both the server's `onClose` and
  `SocketConnection.cleanup`, and the heartbeat and presence sweeps re-check
  `draining` so a sweep in flight stops issuing commands once shutdown begins.
  This is very likely the phase 6 flake: it moved between tests, which is what
  an async rejection from a *previous* test's teardown looks like. Eight
  consecutive clean runs since, one earlier failure in six before the fix, so it
  is reduced rather than provably gone.

### `report` is now live

`features.report` flips to true. A report that cannot be enqueued returns a
retryable `INTERNAL_ERROR` instead of `report_ack` — acknowledging a report the
system could not record would be a lie to a user asking for help (§14.3).

### Verification

**330 unit tests and 233 integration tests**, `tsc --noEmit` clean.
`docker-compose.test.yml` gained PostgreSQL on `:5433`; each test context gets
its own schema, the way the Redis fixture gets its own key prefix.

Coverage includes: migrations applied once and safe to re-run, the `type` CHECK
refusing a content type the application does not implement, retention deadlines
stamped from configuration, a replayed batch not double-writing, `end_reason`
written once, report-triggered extension that never shortens, a message body
stored as data and not as SQL, priority assignment taking nothing a client could
choose, per-class capacity that a full class cannot borrow across, a flooding
session displacing only its own records while eight honest ones survive, the
breaker opening only on consecutive failures and attempting nothing while open,
exponential backoff to a cap and a reset after recovery, a paced drain that does
not replay a backlog at once, a spool that survives a restart, refuses at its
bounds, discards a trailing partial line and skips a corrupt one without
stranding what follows.

---

## Phase 8 — retention lifecycle and the deletion worker ✅

The thing that makes the retention policy real. Everything before this stamped
deadlines; this is what enforces them.

### Files

`migrations/003_legal_holds.sql`, `storage/holds.ts`, `storage/deletion.ts`,
`storage/backup.ts`.

### Decisions this phase forced

* **The boolean is not the hold.** `legal_hold` on a row is the predicate the
  deletion query reads; the hold is a `legal_holds` row with an owner, a case id
  and a mandatory justification, and the boolean is derived from whether any
  such row is still open. Anyone can set a flag — nobody can set this without
  saying who they are and why. `DESIGN.md` §15 updated.
* **Releasing clears the flag only when no other hold is open.** Two cases can
  hold the same conversation, and releasing one must not free data the other
  still needs.
* **A released hold row is kept.** The record that data *was* held, by whom and
  why, outlives the hold itself.
* **The cascade had to be guarded, and this is the real finding of the phase.**
  `messages.conversation_id` is `on delete cascade`, so deleting an expired
  conversation takes its messages with it — *including a message under a legal
  hold whose own deadline was extended past its parent's*. A hold placed on a
  message would have been silently defeated by the expiry of the conversation it
  belonged to, which is exactly the failure a hold exists to prevent. The
  conversation query now excludes any conversation with a held message or a held
  report, and there is a test that holds one message of an expired conversation
  and asserts both survive.
* **A hold on a subject that does not exist applies nothing and records
  nothing.** A hold row that suspends nothing would mislead whoever reviews the
  case later.
* **`admin_audit` expires too**, on its own much longer period. An append-only
  log that is never trimmed is just an unbounded one.
* **The deletion worker gets its own Redis lock**, separate from the janitor's.
  The two do unrelated work at very different intervals, and one lock would let
  the slower starve the other.
* **A failed pass alerts and returns; it never throws.** Deletion failing is an
  operational alert (I10) — data that should be gone is still there and nothing
  else in the process will notice — but it is not a reason to take down a
  process that is otherwise serving chat.
* **`BackupMonitor` reports `unknown`, not `ok`, before it has been told
  anything.** A process that has never seen a backup has no evidence any exist,
  and treating absence of news as good news is how the check comes to mean
  nothing. The observation is pushed in rather than discovered: giving this
  process credentials to a backup system would widen the blast radius of the
  very thing backups protect against.

### Verification

**330 unit tests and 254 integration tests**, `tsc --noEmit` clean.

Coverage: expiry deletes a conversation with its messages, leaves data inside
retention, deletes a message whose own deadline passed inside a live
conversation, deletes expired reports, moderation events, enforcement and audit
rows, batches and reports that more remains, does nothing when another instance
holds the lock, and alerts rather than throwing on failure. A hold suspends
deletion, survives its parent's expiry through the cascade guard, records
owner/case/justification with an audit row, restores the ordinary deadline on
release, keeps the released row, keeps the flag while another hold is open, and
refuses a double release. A reported conversation survives past the ordinary
deadline through the phase-7 extension, and backup staleness distinguishes
unknown from ok from stale.

---

## Phase 9 — metrics, janitor loop and graceful shutdown ✅

The operational surface. Nothing here changes what the product does; it changes
what an operator can see and what happens when the process leaves.

### Files

`metrics/registry.ts`, `metrics/retention.ts`, `ws/janitor.ts`, plus the
`/metrics` route, instrumentation and the drain sequence in `server.ts`.

### Decisions this phase forced

* **Every label value comes from a fixed enumerated set, and a test proves the
  scrape is clean.** The usual framing is that ids in labels are a cardinality
  problem. They are also an I8 problem: a scrape leaves the trusted boundary of
  §2.1 into a system with its own retention, access control and backups. The
  test drives real traffic through a real server and asserts that no session
  id, no message body, no 32-hex hash and nothing shaped like an address appears
  in the output. `DESIGN.md` §18 updated with both reasons.
* **Fixed label sets are zero-initialised.** "No data" and `0` look identical on
  a graph and mean very different things at 3am.
* **Metrics are sampled from the retention components, not pushed by them.** The
  writer's job is to not slow chat down; threading a registry through it would
  be one more thing on that path to get wrong. Cumulative counters are advanced
  by delta, because a counter that was `set` would go backwards and break every
  `rate()` over it.
* **The instance beacon is refreshed by every instance, not just the janitor
  leader.** A beacon only the leader refreshed would make every follower look
  crashed to `janitorSessions` — which reaps sessions of instances whose beacon
  expired. That would have been a spectacular failure the first time two
  instances ran.
* **The janitor gets its own lock and never throws.** A Redis blip during a
  sweep is not a reason to take a process down, and every operation it performs
  is idempotent, so a skipped pass costs nothing.
* **Shutdown closes sockets through the ordinary path**, so each session's match
  ends and each partner is released rather than left waiting for a TTL.
* **The drain does not hold the port open.** How long to wait for a load
  balancer to deregister is a property of the deployment, not the process, and
  it belongs in a `preStop` hook where an operator can see it. `/health` stays
  200 while draining — the process is fine and is leaving on purpose.
  `DESIGN.md` §20.1 added.

### Two things the tests caught

* **The suite hung for two minutes.** `httpServer.close()` waits for every open
  connection, and an idle keep-alive HTTP connection from a `/metrics` scrape
  counts. A draining instance would have sat there until its shutdown timeout
  on every deploy. Fixed with `closeAllConnections()` after the WebSockets are
  closed.
* **Process metrics kept the event loop alive**, so the suite could not exit
  without `--forceExit` — which would have masked a real leak in anything else.
  `createMetrics` now takes `processMetrics: false`, used by the test helper.

Two shutdown tests asserted a 503 from a draining server; the listener is
already closed by then, so the honest assertion is a refused connection. They
now assert that, and the drain state is checked through the flag the handlers
actually branch on rather than by racing a fetch.

### Verification

**338 unit tests and 270 integration tests**, `tsc --noEmit` clean, and the
suite exits on its own.

Coverage: the exposition parses and carries the §18 metric names, a real
connection and disconnect move the gauges, a refused upgrade is counted under
its reason, the scrape stays clean after real traffic, and `/metrics` is absent
when disabled. The janitor refreshes its beacon whether or not it wins the lock,
clears stale queue entries, ends a match that lost a participant and notifies
the survivor, reaps sessions of a crashed instance, prunes dead instance ids, is
idempotent, and survives Redis being unavailable. Shutdown warns clients,
releases their partners, closes with 1001, stops listening, and is safe to call
twice.

---

## Phase 10 — frontend ✅

React + Vite + TypeScript. The first non-backend work, and the first time the
protocol has a second implementation reading it.

### Files

`index.html` (CSP), `vite.config.ts`, `src/main.tsx`, `src/App.tsx`,
`src/state/machine.ts`, `src/hooks/useChat.ts`, `src/components/`
(`MessageList`, `Composer`, `ReportDialog`, `AdSlot`), `src/ads/provider.ts`,
`src/styles.css`.

### Decisions this phase forced

* **The state machine is a pure reducer, separate from the socket.** Every
  interesting decision this client makes is "a frame arrived, what should the
  screen say now" — exactly the thing worth testing without a browser. 25 tests
  cover it; the socket hook holds no logic worth testing.
* **The client state is a mirror, not a source.** It never decides it is
  matched, or that a message was delivered, or how many people are online. Where
  the two could disagree the server wins.
* **A message is shown as "Sent", never as read.** `message_ack` means accepted
  and routed (D14). A `delivered: false` ack shows "Not delivered" rather than
  quietly reading as sent — the sender would otherwise believe it landed.
* **A block is indistinguishable from a skip, because the server sends the same
  event for both** (security §32). The client must not invent a distinction it
  was deliberately not given, and a test pins that.
* **Controls are gated on `connected.features`.** Nothing is enabled before the
  frame arrives. A client that discovers a capability through a rejection is a
  client that then has to explain the rejection.
* **Limits come from the server, not from constants in the bundle.** A
  hardcoded 500 starts rejecting valid messages the day an operator raises the
  limit, and sending refused ones the day they lower it.
* **Errors are translated, never echoed.** The server's `message` field is
  developer-authored and terse. `DUPLICATE_MESSAGE` shows nothing at all,
  because the first copy was delivered and nothing went wrong from the user's
  side.
* **A frame this build does not know is dropped, not thrown on** — the same
  rolling-deploy rule the backend's bus follows.
* **Ads render on the landing and between-chats screens only**, and a provider
  receives a placement name and nothing else: no session, no match, no message.
  The backend has no ad surface at all, which is what makes I13 structural.
* **Direction chosen: dark and atmospheric with editorial restraint.** The UI
  spec offers three. Playful was wrong for a product whose most important
  controls are *report* and *block*; dark surfaces also let the two per-match
  identity colours carry all the colour in the room, which is where the eye
  needs to go — telling the two speakers apart is the only distinction that
  matters on that screen.
* **CSP ships in the document**, forbidding inline and remote script. React
  escapes message text, but a policy means a mistake anywhere in the pipeline
  still cannot execute. The nginx image in phase 11 sends the same policy as a
  header, which browsers honour more strictly; the tag is the floor.

### Two things worth recording

* **`npm run verify` passes end to end for the first time since phase 1b.** It
  has been failing at its frontend typecheck step because `frontend/package.json`
  did not exist. The root script now also runs the frontend tests.
* **The initial dependency install carried five advisories**, all from `vitest`
  2.x pulling an old `vite`. Upgraded the test runner to 4.x: `npm audit` reports
  zero. The build-time `vite` was already current.

### Verification

`tsc --noEmit` clean, `vite build` produces a 157 kB bundle (51 kB gzipped),
**25 frontend tests**, and the full repo gate — protocol drift, both
typechecks, 338 backend unit tests, 25 frontend tests — is green.

The gate's specific requirement is covered: `messageKindFor` dispatches on
`message.type`, and every type this build does not implement renders a neutral
placeholder rather than throwing.

---

## Phase 11 — Docker, compose, monitoring, load test ✅

The whole thing running at once, for the first time. Which is how it found two
bugs that eleven phases of tests had not.

### Files

`backend/Dockerfile`, `frontend/Dockerfile`, `frontend/nginx.conf`,
`frontend/security-headers.conf`, `docker-compose.yml`,
`monitoring/prometheus/{prometheus,alerts}.yml`, Grafana provisioning and one
dashboard, `load-test/websocket.js`.

### Three bugs, none of which a unit test could have found

* **The schema declared `uuid` columns for ids the system never generates.**
  `util/ids.ts` produces `m_Muz7kC9O7-lEyLDpU_9HsQ`; PostgreSQL rejected every
  row with `22P02 string_to_uuid`. The design said `conversation_id uuid --
  equals matchId` and the two were never compatible — the column type was
  written in revision 2, before the id format existed.

  The tests missed it because **they fabricated ids with `randomUUID()`**: the
  schema and the tests agreed with each other and both disagreed with the
  application. That is the deeper fix — the storage suites now use the real
  generators, so a test can no longer pass against a system nobody runs.
  Migration `004_identifier_columns.sql`; `DESIGN.md` §8 corrected.

  Worth noting what happened while it was broken: the breaker opened, records
  went to the spool, and **chat was completely unaffected**. The write-behind
  design did exactly what D16 says it is for.

* **A record the database will never accept stalled retention permanently.**
  Once the spool held messages whose conversation row did not exist, every
  drain failed the foreign key, opened the breaker, and blocked every record
  written afterwards — for good. The cause was treating a constraint violation
  as evidence the database was down. It is the opposite: a rejection proves the
  database is *available*, because it parsed the statement and refused the data.
  Permanent SQLSTATE classes (22, 23, 42) are now discarded, counted as
  `dropped{reason="rejected"}` and logged, without advancing the breaker.
  `DESIGN.md` §14.5 updated, with tests.

* **nginx served no CSP header at all.** `add_header` does not merge: a location
  that sets any header of its own drops every header inherited from the server
  block. `try_files` lands on `location = /index.html`, which sets
  `Cache-Control` — and so silently removed the CSP from exactly the response
  that carries the application. Now an include, repeated in every location that
  sets a header of its own, and verified by `curl`.

### Decisions

* **Two backends in compose, one in production.** The second exists to prove
  cross-instance correctness on a laptop (R5). The load test confirms it: both
  instances served 25 connections each.
* **PostgreSQL publishes no host port.** It holds plaintext conversation
  content; reaching it should require being inside the network (§8.1).
* **Migrations are their own service**, with credentials that are not the
  application's. The application role has no `CREATE` and could not run them.
* **nginx returns 404 for `/metrics`.** The scrape is for Prometheus on the
  private network, not for the internet.
* **The spool is a named volume, never a bind mount.** It holds plaintext
  message bodies, and a developer's home directory is not where they belong.
* **`least_conn`, not round robin.** These are long-lived sockets: what matters
  is how many each instance already holds.
* **The load test does not threshold matchmaking latency.** It is dominated by
  how many people happen to be waiting, not by the server. What is thresholded
  is what the server controls — connection acceptance, ack latency, and protocol
  correctness.
* **`NOT_MATCHED` under load is an expected refusal, not an error.** It is the
  §10.8 race: a message sent in the instant the partner skipped. The first run
  failed its own threshold on this, and the test was wrong, not the server.

### Verification

`docker compose up --build -d`: all seven services healthy, migrations applied,
both Prometheus targets up. Security headers verified on the document and on a
hashed asset. `/metrics` returns 404 at the edge and is scraped on the private
network.

k6 smoke run against the live stack through nginx, 20 VUs for 20s: **71 matches,
269 messages, zero protocol errors, ack p95 34ms, connect failures 0.00%** — all
thresholds green. Retention verified end to end: 32 conversations and 158
messages in PostgreSQL with real base64url ids, breaker closed, both spools
empty.

---

## Phase 12 — operator README and the §22 consistency pass ✅

The phase whose whole job is to check the previous eleven. It found five real
defects, which is the argument for having it.

### Files

`README.md` rewritten from a placeholder into the operator document (quick
start, local development, commands, configuration, operating it, production
hardening, troubleshooting, and the §22 checklist with results).
`DESIGN.md` §1.2 R1 corrected. `monitoring/grafana/` datasource pinned and every
panel wired to it. `docker-compose.yml` and `docker-compose.test.yml` hardened.
`load-test/websocket.js` resized and its refusals classified.
`backend/tests/integration/races.test.ts` and `deletion.test.ts` gained the
three missing concurrency scenarios.

### What the checklist caught

* **Three of the twenty §10 scenarios had no test.** 17 were covered and cited
  by section number; **10.5** (matched, then one side disconnects immediately),
  **10.9** (a message racing a partner disconnect) and **10.19** (the deletion
  worker racing a report) were argued in the design and never exercised. All
  three now have tests, and 10.9 turned out to assert something worth having in
  writing: in the window where the partner's session row is gone but the match
  record is not, `resolvePartner` returns `PARTNER_GONE` **without burning the
  message id**, because the dedupe `SADD` happens only after a partner has been
  resolved. An undeliverable message stays retryable. That was already true; it
  was not previously pinned down by a test.

  10.19 is tested from both sides deliberately. The race harness runs the report
  write and the deletion pass at each other and asserts self-consistency —
  either the report committed and the conversation is still here *and no longer
  expired*, or both are gone. Because the report usually wins that race, the
  other ordering is also forced explicitly: collect the conversation first, then
  attempt the report, and assert it is refused with `23503`. A rejection proves
  the database is available, so the pipeline discards it rather than opening the
  breaker (§14.5).

* **`DESIGN.md` still said messages were "stored encrypted".** The R1 row of the
  §1.2 reconciliation table was written in revision 2 and never revisited when
  revision 3 removed application-level encryption in R12 — so the contract
  contradicted itself, with the stale claim sitting in the table a reader
  consults *first*. Exactly what the "no stale encryption concepts" line of §22
  exists to catch. Corrected in place, with a marker saying what it used to say,
  because silently rewriting a decision record is how it stops being one.

* **The Grafana dashboard referenced no datasource at all.** Not one panel had a
  `datasource` field, and the provisioned datasource had no `uid`. It rendered
  only because Grafana fell back to whatever it considered default — behaviour
  this repository does not control and does not test. The datasource is now
  pinned to `karobakbak-prometheus` and all 34 references in the dashboard name
  it. Verified against a running Grafana through its own API, not by reading the
  JSON.

* **Production containers did not disable core dumps.** §22 required it and
  nothing implemented it. A core dump of the backend is a file full of plaintext
  message bodies — the queue, the spool buffers, every in-flight frame — which
  is the one artefact §2.1 says must not exist outside the boundary.
  `ulimits: core: 0` on every backend service, verified as `ulimit -c` = 0
  *inside* a running container. The image comment now also records that
  `NODE_OPTIONS` deliberately carries no `--inspect` and no
  `--heapsnapshot-signal`, for the same reason: there is no supported way to ask
  this process for a heap snapshot.

* **Both compose files shared a project name.** Each defaulted to the directory
  name, so `npm run down` on the development stack destroyed the integration
  test's Redis and PostgreSQL too — defeating, in the other direction, the
  isolation the test file's own header claims. The test stack is now project
  `karobakbak-test`.

### The load test could not pass its own threshold

`npm run loadtest` is in the README, so it has to work. It did not: 50 VUs for
30s produced **88.9% connection failures** and a crossed threshold.

The server was right and the test was wrong — the same shape as the phase 11
`NOT_MATCHED` finding. The backends recorded 300 `rate_limited` and 20
`too_many_connections` rejections, accounting for all 320 failures exactly. Every
k6 VU shares the generator's single IP, and both controls are per IP:
`CONN_RATE_LIMIT` attempts per window and `MAX_CONNECTIONS_PER_IP` concurrent
sockets. **A load generator is precisely the traffic shape those controls exist
to refuse.** Phase 11's run passed only because 20 VUs for 20s happened to fit
inside the budget; the file's committed defaults did not.

Weakening the shipped defaults to make a test pass was never an option. Instead:

* the defaults are the profile the shipped limits actually permit (20 VUs, 20s),
  with the header stating the arithmetic and how to raise the ceiling on the
  target stack for a genuine capacity run;
* a throttled upgrade (HTTP 429) is counted as `kbb_upgrade_throttled` rather
  than as a connect failure, because the server refusing it is correct;
* but it is thresholded at `rate<0.10`, so a run that spends most of its
  connections being throttled still fails — it has measured the limiter, not the
  system, and that must not read as a capacity number;
* and `kbb_matched: ['count>0']` was added, because a run that connects cleanly
  and never pairs proves nothing.

### Verification

`npm run verify` green: protocol copies byte-identical, both packages typecheck
clean, **338 backend unit + 25 frontend unit** tests pass. **281 integration
tests** pass against real Redis, real PostgreSQL and real sockets — seven of them
new.

Against a live `docker compose up --build -d`: all seven services healthy, both
Prometheus targets `UP`, the dashboard's 34 datasource references resolving to
the pinned uid, a query returning data through Grafana's datasource proxy,
`/metrics` 404 at the edge and `/health` 200, and `ulimit -c` = 0 inside the
backend container.

k6 through nginx, 20 VUs for 20s, **exit 0 with all five thresholds green**: 66
matches, zero protocol errors, ack p95 18.7ms, 0.00% connect failures, 0.00%
throttled upgrades.

### What is left

Nothing in the build plan. Everything remaining in `PHASES.md` is deferred
behind a stated trigger, and the one that blocks public launch is not a coding
task: **age assurance and minor-safety policy need legal counsel** before this
faces the internet.

---

## Frontend redesign — adopting an external UI ✅

A designed UI was produced separately (bolt.new) and had to be reconciled with a
working client. The two halves turned out to be almost disjoint: the new work
was **2,374 lines of presentation**; the existing client was **1,056 lines,
mostly logic** — `machine.ts` and `useChat.ts`, with 25 tests behind them.

So the port went one way only: **take the visuals, keep the state machine.**
The incoming `chatClient.ts` was a mock-shaped abstraction whose fake server
answered on timers; it had never met a race, an error frame or a heartbeat.
Rewriting the reducer around it would have thrown away the only part of the
client that had been tested.

### What the incoming UI assumed, and what is actually true

Its protocol was a different protocol. Flat frames (`{type:'chat', text}`)
against an envelope (`{type, version, id, payload}`); one `strangerSkipped`
event where there are two (`partner_skipped`, `partner_disconnected`); a
`presence.countries` counter that does not exist; `chat` echoed back with
`author: 'me' | 'stranger'`, where the server never echoes a sender's own
message and confirms it with `message_ack` instead.

It handled none of `connected`, `error`, `queue_status`, `report_ack`,
`server_shutdown` or `ping`/`pong` — so every `RATE_LIMITED`,
`DUPLICATE_MESSAGE` and `MESSAGE_WITHHELD` would have vanished silently, and
the socket would have been dropped after 60 seconds of no heartbeat.

Three of its details were not integration problems but product decisions, and
were taken as such:

* **Supabase email/password accounts, profiles and `is_premium`.** Removed
  rather than disabled. `DESIGN.md` §24 defers accounts until the minor-safety
  and age-assurance work is done, and a credential form pointed at a live
  external service is not a thing to leave one boolean away from working. The
  *design* survives in `AuthModal.tsx` behind `ACCOUNTS_ENABLED`, with no auth
  client behind it and an `onSubmit` seam where a real one would go.
* **Filters — language, gender, country, interests.** The modal ships visible
  and inert, saying plainly that everyone is matched from one pool. The option
  lists were deliberately *not* carried over: gender and country filtering on
  anonymous stranger chat is precisely what the minor-safety review has to rule
  on (security §23–24), and shipping the lists would prejudge it.
* **A "Friend" button** that reported "Friend request sent" and sent nothing.
  Cut. Connections are deferred behind the same review, and a control that lies
  is worse than a missing one.

### Decisions taken during the port

* **Fonts are self-hosted through `@fontsource`, not Google's CDN.** The CSP is
  `font-src 'self'`, so the original `@import` was already dead — but the
  stronger reason is that a remote font hands a third party every visitor's IP
  on every page load, which is a poor thing to build into an anonymity product.
  Verified: the built stylesheet references no external host at all.
* **`view/presentation.ts` holds the impedance.** `machine.ts` speaks protocol
  (`Screen` mirrors the session state); components describe a layout. Rather
  than growing the reducer fields that exist only because a component wanted
  them, the mapping is a handful of pure functions.
* **`SystemMessage` was ported narrowed, from eight lines to two.** Six of them
  announce events that *end* a conversation — and the reducer clears the
  transcript when that happens, so they would have been drawn into a list about
  to be emptied. The landing screen says those instead, which is where the user
  actually is. The two that are true while a conversation is open are kept, and
  both are derived from state rather than appended to the message list.
* **One field was added to the reducer:** `matchStartedAt`, from the `matched`
  frame, so the conversation timer has a server-supplied origin rather than
  guessing from when the client noticed.
* **The composer's limit comes from the `connected` frame**, not the constant
  the design shipped with, and counts by code point because the server counts
  code points — `String.length` disagrees with it on any emoji.
* **`og:image` and `twitter:image` were not carried over.** They pointed at
  `bolt.new`: an external host, and somebody else's branding on this product.

### What was kept from the original client, unchanged

`protocol/types.ts` (a generated copy — never hand-edited), `state/machine.ts`
apart from the one added field, `hooks/useChat.ts`, and `ads/provider.ts`. The
rendering boundary of §23.4 survived the restyle intact: `messageKindFor` still
dispatches on `message.type`, an unimplemented type still renders a neutral
placeholder, and the test that proves it still passes.

### Verification

`npm run verify` green: protocol copies byte-identical, both packages typecheck
clean, 338 backend and 25 frontend tests pass. `vite build` clean. The full
compose stack rebuilt and came up healthy, serving the new client with the same
CSP header as before and no external asset host in the bundle. Two WebSocket
clients from one host matched and exchanged messages in both directions.

The originating `ui/` directory was audited file by file — every one of its 29
sources either ported, deliberately dropped with a reason, or superseded — and
then deleted.

---

## Retention was losing most of its records under two instances ✅

Found while giving the load test its own stack — which is the argument for
having isolated it, since the run that proved the isolation is the run that
exposed this.

### The measurement

A 30-VU run against two backends: **432 records queued, 24 written, 408
dropped**, of which **75 were P0** — reports, blocks, moderation events. Every
rejection was the same constraint:

```
dbCode 23503, dbConstraint messages_conversation_id_fkey
```

Nothing crashed. `/ready` stayed 200, the breaker stayed CLOSED, chat was
completely unaffected. The only evidence was a counter nobody had looked at
after a load run.

### Two faults, compounding

* **A foreign-key violation was classified as permanent.** It is not, in this
  architecture. §11 is explicit that the `conversations` row is written by
  whichever instance won `tryMatch`, while each participant's messages are
  flushed by whichever instance owns their socket, on its own timer. So an
  instance routinely holds a valid message whose parent row is still sitting in
  another instance's queue. The row was refused, classified as unwritable, and
  binned — a second before it would have succeeded.

* **A rejected batch was discarded whole.** A batch is one transaction, so the
  refused message rolled back every record beside it. That is where the 75 P0
  records went: they were never refused by anything, they were merely adjacent.
  Losing abuse evidence to a neighbouring row's ordering problem is not a
  failure mode worth keeping.

### The fix

`23503` is now treated as transient and deferred for up to
`RETENTION_MISSING_PARENT_RETRIES` cycles (default 5). Every other class-23
violation stays permanent — unique, check and not-null describe the row itself,
and waiting will not change them.

A permanent error now triggers a salvage pass rather than a discard: the batch
is rewritten **per table, in dependency order, each in its own transaction**,
and only a table that still fails is narrowed further, down to individual rows.
What gets dropped is what the database actually refused.

Deferred records go to the **back** of their lane. The first version put them at
the front, and the existing test `does not block the records queued behind it`
failed immediately — at a batch size of one, a waiting record starved every
record that was ready. `queue.defer()` exists for that distinction: a record
waiting on someone else has no claim on the next batch.

### Result

The same run, after:

| | before | after |
|---|---|---|
| queued | 432 | 525 |
| written | 24 | **525** |
| dropped | **408** | **0** |

56 conversations and 413 messages stored, no dropped series on either instance.

### Load testing is isolated now

`npm run loadtest` runs against its own compose project (`karobakbak-loadtest`,
port 8090, its own volumes), so its traffic never reaches the development
database. Retention stays **enabled** there deliberately: the write-behind path
is where load actually hurts, and a run that skipped it would have skipped this
bug too. The per-IP abuse limits are raised in that override only — a single
generator is one address, which is exactly the shape those controls refuse.

The alternative considered and rejected was tagging load-test rows for later
deletion. That leaves cleanup one crashed run away from never happening, and
puts a "recognise the test traffic" concept into production data.

### Also

`docker-compose.dev-ports.yml` publishes PostgreSQL and Redis on 127.0.0.1 only
(5434 / 6381) for inspection with a database client, as an opt-in override
rather than a default — the base file publishes neither on purpose (§8.1).

---

## Frontend adoption, environments, and two bugs found by using the thing ✅

A long session of ordinary work, in which most of the value came from running
the system rather than from writing it.

### The new UI became the frontend

A separately designed UI (bolt.new) was reconciled with the working client:
2,374 lines of presentation against 1,056 lines of mostly logic. The port went
one way only — visuals in, state machine kept — because the incoming client was
a mock-shaped abstraction that had never met a race, an error frame or a
heartbeat. Full reasoning is in the commit.

Accounts kept but disabled (`ACCOUNTS_ENABLED`, with Supabase removed rather
than switched off); filters visible and inert, without their gender and country
lists, which the minor-safety review has to rule on first; the "Friend" button
cut, since it reported success and sent nothing.

### leave_chat, because the back button could not be fixed without it

The back button did nothing, silently: it sent `leave_queue`, which the server
refuses while matched, and the reducer ignores that error code. The obvious
client-side repair does not work either — `skip` re-queues by design, so
`skip` + `leave_queue` loses the race whenever the skip re-matches first, which
with anyone waiting is the *normal* interleaving rather than a rare one.

The gap was in the protocol: nothing could end a match and stop. `leave_chat` is
`skip` without the re-queue, and the reasoning was already in the codebase —
`block` deliberately returns the blocker to IDLE because "someone who just
blocked a stranger has said something about wanting to stop". Leaving is the
same gesture without the accusation. `DESIGN.md` §12.1 records it.

### Retention was losing most of its records under two instances

Found by giving the load test its own stack and then actually reading the
metrics afterwards: **432 records queued, 24 written, 408 dropped**, 75 of them
P0 safety records. Two compounding faults — a foreign-key violation classified
as permanent when it is transient across instances, and a rejected batch
discarded whole. After the fix: 525 queued, 525 written, zero dropped. Detail in
its own entry above.

### Environments, and then the bug that hid in them

Six compose files became three: development (the default), production (an
override where every secret is required), and the throwaway test dependencies.
The load-test profile became an env file. Backends became replicas of one
service, so they are `karobakbak-backend-1` and `-2` rather than the
`backend-2-1` that a second *service* produced; that forced anonymous spool
volumes per replica, DNS discovery in Prometheus, and a DNS-resolved upstream in
nginx.

Making values env-driven then produced two faults of the same shape, both found
by running the stack rather than reading it:

* **`NODE_ENV: production` on the laptop.** `logger.ts` sets
  `strict: !isProduction`, so the message-content denylist **throws** outside
  production and quietly redacts inside it. Development was running the loudest
  safety control in its lenient mode, in the one environment where new code is
  written. Now `development` locally, `production` in the override.

* **`DATABASE_URL` read from the environment.** `.env.example` documents the
  values for running the backend *outside* Docker, so a `.env` copied from it
  pointed the container at `localhost:5432`, where nothing listens. The failure
  was silent in exactly the way the architecture promises: chat kept working,
  `/ready` stayed 200, and the only evidence was a spool filling and a breaker
  cycling OPEN to HALF_OPEN and back for ever. A restart did not fix it, because
  nothing was stale — it was simply dialling the wrong host.

  The lesson is the same both times: **a value that is a fact about the compose
  topology is not a deployment variable.** The service name `postgres`, and
  whether the local database speaks TLS, are now fixed in the development file.
  Being able to override something is not free; it is another way for the wrong
  value to arrive.

### Configuration and preferences

`frontend/src/config.ts` is now the only file reading `import.meta.env`, and
holds the timings that were literals in four components. Most are deliberately
not environment variables: Vite inlines `VITE_*` at build time, so each costs a
Dockerfile build arg and a rebuild — worth paying when a value genuinely differs
per deployment, not for a product decision that is identical everywhere.

`frontend/src/preferences.ts` is the other half and is *not* configuration:
configuration is how a deployment is built, a preference is what the person at
the keyboard wants. Conversation starters are the first, defaulting to **off**.
The store is bounded to presentation settings on purpose — never conversation
state, message content or identifiers, because `localStorage` long outlives the
socket.

Three advertising variables were removed from `.env.example`: nothing read them
and nothing passed them to the build, which is worse than no configuration
because it reads as a guarantee.

### docs/operations/OPERATIONS.md

A complete command reference — docker, Redis, PostgreSQL, Prometheus, Grafana,
what to clear and how, and a section on things that look broken and are not.
Every command in it was run before it was written down, which is how the
`DATABASE_URL` bug surfaced: the alert-listing one-liner showed
`DatabaseCircuitOpen` firing.

### Where this leaves things

All green: 338 backend unit, 39 frontend unit, 289 integration. The stack cold
starts clean.

Known and unresolved, for next time:

* **The IP dimension of blocks is coarse.** Blocking someone behind the same
  public address blocks everyone behind it — on a home network that is your own
  devices, and behind CGNAT it could be thousands of strangers for thirty days,
  experienced only as "this app never finds anyone".
  `BLOCK_DIMENSION_IP_ENABLED` and `BLOCK_TTL_SECONDS` exist; the judgement
  belongs with the safety review.
* **Around 40 user-facing strings** are inline in components. Worth a
  `strings.ts` when a second language or a copy pass needs one, not before.
* **`proxy_read_timeout` must stay above the heartbeat interval** and nothing
  checks that it does.
* **Nothing takes backups.** `BackupMonitor` reports staleness and
  `BackupsStale` sits pending for ever until something external does the work
  and reports success.
* **No alertmanager.** Alerts evaluate and show in the UI; nothing sends them
  anywhere.

---

## Swarm — a population load test, stage one

**Commit:** `test(load): a swarm of scripted strangers, and oracles that judge the run`

`load-test/websocket.js` (k6) measures throughput: every virtual user runs the
same loop, and the answer is a percentile. It cannot answer the questions this
product actually fails on — was a message delivered twice, did a queue entry
outlive its session, did a body reach a log line, would anyone notice a bot
saying the same thing to four hundred people.

Those need a *population*: personas with state that survives across matches,
both halves of every conversation under one controller, and a verdict at the
end rather than a graph. That is `load-test/swarm/`.

### The catalogue came first

`docs/testing/LOADTEST-SCENARIOS.md` — every scenario worth running, grouped N
(conversation), S (matchmaking), A (abuse), M (moderation response), L
(lifecycle), P (protocol and state machine), R (races), C (chaos), D (data
integrity), E (load shapes). Each row says what it proves and how the run
decides it passed. Writing it first paid immediately: three entries turned out
not to be expressible against this design, and finding that out on paper cost
nothing.

* **P24, "report another conversation"** — not expressible. `ReportPayload` is
  `{category, note}` and the conversation is resolved server-side. The test is
  that the field does not exist to abuse.
* **C11 and C12, "kill the matchmaking worker" and "kill the retention
  worker"** — there are no such processes. Matchmaking is a Lua script run by
  whichever instance received the frame; the retention and deletion workers are
  leader-locked inside a backend process. Both were reframed as killing the
  lock holder, which is the failure that actually exists.

### What stage one ships

Seeded and reproducible from one integer: `--seed` fixes the mix, every bot's
persona, its synthetic address, and every think-time it will ever draw.

* `bot.ts` — the protocol client. Cookie persistence, heartbeat, ack
  correlation, and a local mirror of the server token buckets, so a persona is
  throttled only when it means to be.
* Twenty personas across N, S and L, speaking lines from a plain-text corpus.
* Three of the five oracles: pair reconstruction, metric conservation, and the
  log-leak check. The other two appear in every report as **not run**, which is
  deliberate — an oracle nobody can see is missing is worse than one that says
  so.

### The corpus lint, which is not optional

Benign corpora are checked against the *real* `RULES` imported from the
backend, and a match refuses the run. One line reading "add me on insta" in
`smalltalk.txt` would flag a few hundred bots and turn every precision number
in the report into an artefact of a typo.

### Two infrastructure findings, both real

**Every bot needs its own address, or blocks kill the swarm.** `blockPartner`
records `SADD chat:blocks:{blockerIpHash} {blockedIpHash}`. Bots share a host,
so the first block any bot issues writes one address into its own block set,
and `tryMatch` then refuses *every pair in the run*. It does not error;
matching simply stops. Fixed with `TRUST_PROXY_HOPS=2` in `.env.loadtest` and a
per-bot `X-Forwarded-For` drawn from the RFC 2544 benchmarking range — which
also let the per-IP limits go back to their shipped defaults, so a run measures
the product people actually get.

**The edge capped concurrent conversations at roughly 512 per worker.**
`worker_connections` lives in the nginx main config, in the `events` block,
which no site config can reach — and a proxied WebSocket costs two connections,
one downstream and one upstream. The stock 1024 is reached long before any
backend limit, and it fails as refused upgrades that look like a backend fault.
It is now set from the environment by an entrypoint script in the frontend
image (`NGINX_WORKER_CONNECTIONS`, default unchanged at 1024; the load stack
uses 32768). This is a production-relevant limit, not only a test one.

### What the runs taught, in order

Every one of these was a red run first.

1. **`MESSAGE_TOO_LONG` is a protocol strike.** Deliberately
   (`connection.ts:216`), and `INVALID_MESSAGE_STRIKES` is 10 — so the N5
   persona, trying one over-length message in every conversation, was closed
   with 4003 after ten matches. The server was right: N5 was a protocol-abuse
   persona in disguise. It now probes once per bot lifetime.
2. **The server trims before storing and delivering.** N5 padding ended in a
   space, so the sender hashed one string and the partner received another, and
   the pair oracle reported a delivery bug that was entirely the harness.
   `Bot.sendMessage` now trims and records a `harness_error` when it has to, so
   the next instance of this is loud rather than mysterious.
3. **Ack correlations must outlive the match.** An ack can arrive after a skip:
   the message was accepted and delivered, and teardown raced the
   acknowledgement. Clearing `pending` at match end lost the hash and produced
   "the partner received a message the sender was never acked for".
4. **Counters are cumulative and the stack is warm.** Reading them only at the
   end attributed the previous run to this one. There is now a baseline scrape
   before the first socket opens, and only the difference is judged.
5. **`chat_active_matches` and `chat_queue_depth` are cluster-wide gauges,
   written only by the janitor lock holder.** The follower copy freezes at
   whatever it last held. Summing across instances adds a live value to a stale
   one and reports a leak that is not there — the shipped Grafana dashboard
   already reads both with `max()`, and the harness now agrees with it.
6. **Lazy cleanup needs a settle window, not an assertion.** Queue entries are
   repaired by whatever scans them, so "depth is not zero one second after the
   last socket closed" is the design working. The oracle scrapes twice, 40s
   apart — two janitor passes — and fails only on state that has *stopped*
   shrinking.
7. **A dying worker must not kill the report.** `child.send` on a closed IPC
   channel threw out of a timer during the drain and destroyed the results for
   every healthy worker. Guarded; an incomplete population now fails the run
   loudly instead of quietly reporting smaller numbers.

### Results

5,000 bots, two backend replicas, 150s, seed 47:

* 10,806 conversations, 45,433 messages delivered, **zero** delivery
  disagreements across every reconstructed conversation.
* Matched frames exactly twice matches created. Queue depth returns to 0.
* Ack latency p50 4ms, p95 50ms, p99 60ms. Time to match p50 6ms, p99 60ms.
* Delivery split almost evenly local and remote, so cross-instance Pub/Sub
  carried half the run rather than being incidental to it.
* Harness event-loop lag p99 22.9ms — below the threshold at which the report
  refuses to publish latency at all, so the numbers are about the server.

### Where this leaves things

Next, in order of value:

* **The Redis and PostgreSQL oracles.** They are the two that would catch a
  retention or cleanup bug, and both are currently `SKIP` lines in every report.
* **The A and M personas, with the labelled roster.** The roster field exists
  and is empty. This is the work that answers "would we identify the bots", and
  §6 of the scenarios document already states the expected answer: not live,
  because nothing compares a message to what the same sender said in another
  conversation.
* **The log-leak oracle needs something to read.** The backend emits about five
  log lines per run, which is excellent hygiene and leaves the check almost no
  surface. It reports its own coverage rather than passing quietly, but a
  deliberately chatty run mode would make it worth more than it is today.
* **The chaos group is unimplemented.** C1 — pause PostgreSQL and prove chat
  does not notice — is the one that would validate D16 directly.

---

## Swarm stage two — the A and M groups, and a labelled roster

**Commit:** `test(load): labelled adversaries, and a measured answer to "would we notice"`

Stage one could say a message was delivered exactly once. It could not say
whether a bot saying the same thing to four hundred strangers would ever be
noticed. That needs adversaries whose behaviour is declared *before* the run, so
the answer has a key to be scored against.

### The roster carries ground truth

Every persona declares `labels`, and `buildRoster` copies them onto the bot:
`spammer` for a pattern adversary, `abusive` for one a rule or a limiter should
catch, and `benign` stated explicitly rather than left implicit — "everything
unlabelled is innocent" is the assumption that turns a false positive into a
silent one.

Thirteen A personas and nine M personas, plus an `adversarial` profile where a
third of the population is hostile and an eighth reacts to it. The benign
majority is not decoration: without it there is nobody to spam, no control group
for precision, and every conversation is between two bots that were both trying
to leave.

### The finding that rewrote a document

`docs/testing/LOADTEST-SCENARIOS.md` claimed that grouping messages by the
server's normalisation view would catch a campaign that mutates itself, where
exact hashing fails. Measured against labelled pattern spammers, it did no
better than exact hashing. That is not a defect in `moderationView`: it prepares
**one message for one rule pass**, and its normalisation choices are right for
that job and wrong for cross-message identity.

`load-test/swarm/src/campaign.ts` is a harness-side canonical form built for
the other job, and it did much better with no false positives on ordinary users
in that run. It lives in the harness because it is a **proposal**. The design
input is that a serial-spam detector cannot reuse the moderation view; it needs
a second canonical form whose only job is cross-message identity, kept separate
from the one rules read.

### What the live signals are worth

Per-message moderation cannot see a campaign spread across many messages and
conversations, and the run confirmed it: the live controls did not stop the
labelled pattern spammers. Blocks and reports arrived quickly, but a block
protects the blocker and nobody else, so being blocked costs a spammer one
partner and changes nothing about its rate. Reporting and blocking are
per-victim controls being asked to solve a per-sender problem.

The harness owes one caveat: the M personas decide what to report with
`looksAbusive`, which recognises the adversarial corpora directly. Real users
are slower and less accurate, so the measured time to first report is an
optimistic bound.

### Five corrections, every one of them the harness being wrong

1. **A block is an intent until the server confirms it.** The durability check
   reported ten D18 violations. Every one was real behaviour: A13 fires `block`
   and `skip` in the same tick, and the block bucket is 3 burst / 20 per hour —
   so most attempts came back `NOT_MATCHED` or `RATE_LIMITED` and **wrote
   nothing**. The pairs then met again legitimately. Blocks now bind only on
   confirmation, and the refusals are reported as their own number, because "a
   user pressed Block and no block exists" is a real product question.
2. **Precision must be measured against benign bots only.** Counting every
   non-spammer put A5, A6 and A9 in the false-positive column — bots that are
   labelled `abusive` and genuinely do repeat themselves. Flagging them is the
   query working on a different adversary, not an error.
3. **A3 and A4 are payload adversaries, not pattern spammers.** A link dropper
   is caught by the `url` rule on its first message; scoring it against the
   cross-conversation query measured the wrong detector against the wrong bot.
4. **The message conservation law is `received == accepted + rejected`, read
   entirely from the server.** Deriving refusals from ledger error codes
   over-counted, because `RATE_LIMITED` is also returned for `skip`, `block`,
   `report` and `join_queue`. Reading `chat_messages_rejected_total` avoids
   having to guess which command provoked a client-side code.
5. **A dead worker must fail the verdict.** A crashed run printed `PASS` on
   eleven conversations out of an intended thousand: every oracle read the
   truncated ledger as a smaller, self-consistent population and was happy.

### The Redis oracle, promoted from SKIP

The queue-depth gauge could not settle an argument it was being asked to settle.
`chat_queue_depth` and `chat_active_matches` are cluster-wide values written
only by the janitor's lock holder, so the follower's copy freezes: summing
invents leaks and `max` returns the stale number whenever the frozen one is
larger. Neither can tell an abandoned entry from an instance that last looked a
while ago.

So the oracle now asks Redis, through `docker exec ... redis-cli` — no client
library, no published port, the same shape as the metrics scrape. It counts
queue members whose session hash is gone, which is the only definition of an
abandoned entry that survives lazy GC. It has passed cleanly on every run since,
including the ones where the gauge read 3.

It also prints the block-set count, with the reason: blocks live 30 days and bot
addresses are derived from bot index, so adversarial runs poison later ones
unless `npm run unblock` is run between them.

### Where this leaves things

* **The database oracle is the last SKIP.** `conversation_id` is `text` and
  equals the ledger's `matchId` (migration 004), so the join key is already
  there.
* **P and R groups, and the chaos conditions.** C1 — pause PostgreSQL and prove
  chat does not notice — validates D16 directly.
* **A live spam detector is now a costed decision rather than an open
  question.** The canonical form exists in the harness, its recall and false
  positive rate are measured, and §6.1 records what it would take.

## Phase 13 — the moderation console ✅

Pulled in from the deferred list (`DESIGN.md` R16). The deferral said "when
reports become frequent enough to need triage tooling", which assumed the
console's value was throughput. It is not.

### The thing that was actually broken

`enforcement` has existed since phase 7. Rows could be written, the deletion
worker expired them on schedule, and nothing in the backend ever read the table.
A ban was a record of an intention with no effect on anybody.

Everything else in the phase depends on that being fixed first. A review queue
whose verdict button writes a row and changes nothing is worse than no console,
because it reports success — and any triage tooling built later would have sat
on top of a sanction that did nothing.

So the phase started at the upgrade path (`server.ts:234`), not at the UI.

### Ban is not block, and the namespaces are separate

`chat:ban:{key}` and `chat:blocks:{key}`. They answer different questions: a
block is relative — a set of peers *one user* refuses, consulted inside
`tryMatch` — and a ban is absolute, read before a session exists.

The concrete disaster a shared namespace allows: a moderator revoking a ban
deletes a user's own block, silently removing protection that user asked for.
There is a test asserting the two cannot reach each other.

Three placement decisions, all in D29–D30:

* **Before any allocation.** Inside the session lifecycle instead, every banned
  reconnection would still cost a session id, a Pub/Sub subscription and a
  connection slot — a denial-of-service budget handed to the banned party.
* **Fails closed.** A Redis error refuses the connection. Failing open is the
  instinct and is wrong here: `/ready` already drops an instance with unhealthy
  Redis out of the load balancer, so failing open would not rescue a doomed
  connection, only un-ban every sanctioned user for the length of an outage.
* **Says nothing.** A bare 403, same shape as a disallowed origin. Naming the
  dimension that matched tells a banned client exactly what to change.

The Redis value is the `enforcement_id`, so a refusal seen in production traces
to the row that ordered it and through it to the audit row that justifies it.

### Bans were quietly temporary, and nothing would have said so

Redis runs with persistence off (D12) so that no Redis structure — including a
Pub/Sub payload carrying message text — can reach disk. Every ban key therefore
dies with a Redis restart.

Without the reconciler this ships a sanction system where every ban expires at
the next restart with nothing reporting that it had gone. It would have looked
like it worked, indefinitely.

PostgreSQL is the durable record and Redis is a cache of it (D31). Every
instance replays live sanctions at startup and on `ENFORCEMENT_RELOAD_INTERVAL_MS`.
Two details that mattered: the remaining life is recomputed from `expires_at`
rather than reissued from the original duration, so a restart cannot silently
renew every ban; and it is deliberately **not** leader-locked, unlike the
deletion worker, because a pass only the leader ran would leave every other
instance enforcing nothing.

### Two database roles, not one

`admin_accounts` holds the only credentials in the system. The chat backend has
no reason to read them, and with the grant it would have one: a compromised chat
process could mint itself an operator session and then read every conversation
through the *audited* path, writing plausible audit rows on its way.

So the console connects as `karobakbak_console` and the chat role is denied
outright — asserted by a test in `storage.test.ts`, not left to the migration
being read carefully. The console in turn cannot delete a conversation: one that
could would be able to destroy the evidence in the case it was opened for.

That is also why the console is a separate **process** (D32). Two trust levels
in one address space means compromising the internet-facing half hands over the
other. It listens on its own port, bound to loopback, off by default, and
`assertCoherent` refuses a console port equal to `BACKEND_PORT`.

### scrypt and TOTP on the standard library

argon2 and otplib both sit directly on the authentication path, which is the
worst place in this system to widen the supply chain — and the backend has kept
to four runtime dependencies. The argon2 binding is also a native module, so it
would mean a compiler in the Alpine image.

Neither file invents cryptography: scrypt is RFC 7914 from `node:crypto`, and
TOTP is HMAC-SHA1 over a clock counter plus a truncation rule RFC 4226 spells
out byte by byte. That is only defensible because both RFCs publish test
vectors, so `tests/unit/totp.test.ts` runs the full RFC 4226 Appendix D and RFC
6238 Appendix B tables — including the vector at Unix time 20000000000, which
exists to catch a 64-bit counter written as two 32-bit halves.

One detail worth keeping: the decoy hash used when a username does not exist is
**generated once per process**, not written as a literal. A hand-typed hash
constant is a plausible-looking value nothing verifies — one wrong base64
character and `verifyPassword` rejects it as malformed and returns early,
silently removing the timing defence, with no test able to see it.

### A read that was not logged did not happen

I11 says no path returns retained content without an audited request. The
natural implementation — fetch, return, then log — produces an audit trail that
is complete *except* for the reads that failed halfway, which are the ones worth
knowing about.

So the audit row is written first, in the same transaction, and a failure to
write it rolls the whole thing back (D33). There is a test that breaks the audit
insert and asserts the caller gets an error rather than a transcript.

The queue deliberately carries no user text. `reports.note` is the reporter's own
words and carries a message body's protection class (I8); a queue containing it
would render user content on every page load, which would mean an audit row per
page load, which drowns the log that matters.

### The privilege-escalation hole that nearly shipped

The replay screen knows the reported party's hashes, so the obvious ban endpoint
takes them from the request body. That would let any console session ban an
identity it observed or guessed — including one belonging to somebody never
reported — and the `admin_audit` row would faithfully record a well-formed
decision with nothing in it to show the subject was chosen by the caller.

`issueBanForReport` resolves the subject on the server from the report being
acted on. No route accepts an identity hash. Same rule the chat protocol applies
to every frame, and it matters more here.

### Two bugs only running it could find

* **`hidden` loses to any rule that sets `display`.** `.console { display: grid }`
  rendered the report queue and a sign-out button on the sign-in screen. Not
  cosmetic: the point of a gate is that nothing behind it is on the page. Fixed
  with an explicit `[hidden] { display: none !important }`.
* **The first real login returned 403**, because the allowlist said
  `localhost:8088` and the browser said `127.0.0.1:8088`. Same machine,
  different origin, exact match required. The CSRF check working as designed —
  and much better found here than during a deploy.

Driven end to end against the development database: opening a case, banning one
reported party and dismissing another produced two enforcement rows, two Redis
ban keys and five audit rows, each naming the actor, the case and the reason.
The dismissal wrote no sanction.

### A test that punished its own documentation

The scanner asserting `console.js` contains no `innerHTML` failed on the comment
*explaining* why `innerHTML` is banned. The fix was to strip comments before
scanning, not to delete the explanation — a check that penalises documenting the
rule it enforces is backwards.

### Where this leaves things

* **The console is auditable, not fast.** Every case costs a typed reason and a
  read of the actual conversation. That is right for the volume there is, and it
  is the first thing that will feel wrong if reports ever arrive faster than one
  person can read them.
* **It is fed by reports only.** The measured spam detector
  (`load-test/swarm/src/campaign.ts`) would feed it proactively, but that widens
  *who gets read* from "people somebody complained about" to "people a heuristic
  suspects" — an expansion of I11 purpose scope with its own false-positive
  budget, not a wiring job. `DESIGN.md` §25.7 records what it needs.
* **The swarm does not exercise a banned reconnection.** The refusal has
  integration coverage and has never been seen under load, where it would look
  like a capacity problem rather than a safety bug.
* **One role is issued.** The vocabulary is in the schema and in every audit row
  so today's rows stay meaningful when scopes separate (R17); no route branches
  on role, because a role check nothing distinguishes reads like a control and
  is not one.

## Phase 14 — self-declared profiles ✅

An optional name, age, gender and country, so a conversation starts faster than
"asl". Owner-requested; the shape of each field was not.

### The three fields that are not free text, and why

Only `name` is free text. `country` is a code from a fixed list, `gender` is a
closed list, `age` is a bounded integer — because a free-text "location" field
is somewhere to type a street address, a free-text gender is somewhere to write
a slur or a contact handle, and a free-text age is somewhere to write a
sentence. Each free-text field is a field that needs moderating like a message
body, and there is exactly one.

The owner asked for full country names rather than codes. The dropdown shows
"India"; `IN` is still what travels, because a code is stable when an English
name changes, exact to filter on, and identical in every language. The names map
ships *in the protocol file* rather than the frontend, because the moderation
console renders country names too and two copies would drift. A unit test fails
if a code is ever added without a name — the symptom otherwise is a raw `MF` in
a chat header that nobody notices until a user asks about it.

Display labels are `F`, `M`, `NB`; the wire value stays `female`/`male`. Short
forms read at a glance in a header beside an age and a country, and the full
word keeps the stored evidence unambiguous for somebody reading a case months
later, where a bare `F` is worse than useless.

### The server keeps nothing between sessions

The profile rides on `join_queue`, lands on the session hash, and dies with the
session. The browser holds it and re-sends it every time.

That is the design, not a shortcut. A profile the *server* kept against a
durable identifier — the block token, an IP hash — would be a stable record of a
person across every conversation they ever have, which is exactly the cross-chat
correlator §24.3 forbids. Recorded as R19, including the residual: a distinctive
declared name is a self-inflicted correlator, and the interface says plainly
that every stranger sees it.

No partial update, either. A join carries the whole profile and a missing field
is `HDEL`ed rather than left behind, or clearing a name would leave the old one
visible to the next partner.

Profiles are read *beside* `tryMatch`, not inside it. That script is the most
race-tested code in the system and its reply is parsed positionally; widening it
to carry eight display fields would mean re-verifying every matchmaking race in
order to ship a nickname.

### A name is moderated harder than a message

Any rule firing on a declared name refuses the join, where D20's default policy
flags and delivers. A message is one utterance judged in context; a name is a
label shown to everyone the user meets for the whole session, so a Telegram
handle in it is unambiguously an advert rather than a signal for a moderator to
weigh later.

### The age floor, and what it is not

18, refused below with its own protocol code and counted as
`chat_profiles_refused_total{reason="age_below_minimum"}`.

Its own code so the client can say what the service is instead of "invalid
input", and so the count becomes an input to the minor-safety policy that
already blocks launch. Security §23 opens its grooming-signal list with
"repeated attempts to establish age" — a field broadcasting a self-declared
minor's age to every stranger automates the first step of the thing that section
exists to detect.

**It is not age assurance and not an age gate.** Anyone can type 25. The value
is never treated as a safety control anywhere in the code, and §26.4 says so.

### Declared, not filterable — recorded as a decision (D37)

The owner plans premium gender and age filters. Nothing in matchmaking reads a
profile today, deliberately.

Filtering creates the incentive to misdeclare: lying about your age buys nothing
right now, and buys entry to a pool the moment a filter reads it. And a paid
"match me with X" control is a targeting tool aimed at whichever group is
filtered for — on anonymous stranger chat the filtered-for group receives
dramatically more unwanted contact.

Not a refusal, a recorded position with the cheaper alternatives named: language,
interests, country, or mutual opt-in where both sides agree to be filtered on.
The queue-segment seam (D23) is where it goes if it is built.

### Stored as evidence

`conversations.profile_a` / `profile_b`, `jsonb`, stamped at match time because
the declaration lives on the session and the session is gone by the time anyone
investigates. A report is frequently *about* the declaration and none of it
appears in the transcript.

**No index, deliberately** — an index would exist to search *by declaration*,
which is the query this data should not make easy. A null declaration is a SQL
null, not the JSON string `"null"`, which would read as a declared value in
every later query.

### Two interface claims that had to change

The landing copy said "no profiles". That stops being true the moment somebody
fills one in, so it says "no signup", and switches to "nothing kept after you
leave" once a declaration exists. A claim the interface visibly contradicts
costs more trust than it ever bought.

The same reasoning added "Changes apply to your next conversation, not this
one." to the editor when it is opened mid-chat. The profile is sent at join, so
an edit cannot reach the current partner — without the line, someone corrects a
typo, watches it update on their own screen, and reasonably assumes the other
person sees it too.

### The Windows scroll bug, fixed on the way past

Reported while this phase was in flight: the composer sat below the fold and
reaching it meant scrolling the page.

`App.tsx` used `min-h-[100dvh]` — a *minimum*, which lets the document grow past
the viewport. Every inner pane sizes with `h-full`, which resolves against a
**definite** parent height and silently does nothing without one, so the
transcript grew the page instead of scrolling itself. Now the shell is exactly
one viewport tall with the panes scrolling internally. Measured after the fix:
document height 799, viewport 799, composer bottom 799, page does not scroll.

`dvh` rather than `vh` deliberately: on mobile `vh` keeps the pre-collapse
number when browser chrome hides, which is the same bug wearing a different hat.

### Where this leaves things

* **Nothing enforces the age floor beyond the form**, and nothing can. The
  counter gives the minor-safety work real data; the field is not a control.
* **The swarm declares nothing.** No persona sets a profile, so the moderation
  path for names and the `AGE_BELOW_MINIMUM` refusal have unit and integration
  coverage but have never run under load.
* **Filters remain unbuilt and now have a recorded reason** (D37), which is the
  thing most likely to be revisited when premium is costed.

## Phase 15 — getting away from someone ✅

Three changes with one theme: the safe action should not be the slow one.

### The block that was silently lost

The swarm found this and wrote it down in `testing/SWARM-HANDOFF.md` §7 as an open
product question. It was a defect, not a question.

`blockPartner` resolved the partner from the live match. An abuser who sent
something and immediately skipped left no match behind, so the block returned
`NOT_MATCHED` and recorded nothing — and the user was told nothing had gone
wrong. They believed they had blocked somebody they had not, and remained
matchable with them.

The people most likely to leave first are exactly the people most worth
blocking, so this failed in precisely the case it existed for.

**The fix** is a short-lived note. `endMatchInline` — the one shared teardown
used by `endMatch`, `blockPartner` and both janitor scripts — now writes each
side's two salted hashes against the *other* side's session id under
`chat:last_partner:{sid}`, TTL `BLOCK_LATE_WINDOW_SECONDS` (120, `0` disables).
A block that finds no match reads that instead.

Touching that helper meant changing a shared function inside the most
race-tested scripts in the system, which `CLAUDE.md` warns about. Two things
made it safe: the extra argument is passed **explicitly** to every caller rather
than read as "the last ARGV" — an implicit convention across five scripts is a
trap for whoever adds the sixth — and the whole integration suite including the
race tests was re-run.

**An existing test caught a real mistake.** The first version left the record for
the *blocker* too. Blocking ends the match, that teardown writes records for both
sides, so blocking somebody let you block them again for the next two minutes:
recording twice and spending two of the twenty hourly blocks on a person already
blocked. The record is now consumed when used, on both branches. The blocked
party keeps theirs — they may want to block back, which is a different decision
by a different person.

A late block ends nothing and notifies nobody: `endedByUs` false,
`partnerSessionId` empty, so no `partner_skipped` can be sent about a match that
ended minutes ago to whoever now holds that session id. The database row carries
a **null** `conversation_id`, not an empty string.

### Two backtick characters cost a build

The Lua lives inside a TypeScript template literal. A comment written as
``lateBlockTtl`` in backticks terminated the string and produced a syntax error
several lines away from the cause. Same family as the control-character trap
already in `CLAUDE.md`: the Lua is a string, and anything that is syntax in the
host language must not appear in it.

### One tap, not five

Getting away from somebody unpleasant was: Safety → Block → Find someone else.
Five taps across three screens while the person is still typing. Most people
will not do it — they press **Next stranger**, one tap, and the block never
happens. The safe action was the slow one.

**Block & next** does all three in one action, and shrinks the race window
§27.1 covers from seconds of tapping to a few hundred milliseconds.

### Auto-search, and the exclusions that are the point

Opt-in, off by default, available both in Settings and inline under the
composer — where the decision is actually made, by somebody three skips into a
bad run.

It fires only when the *partner* left. Never after a block, because that
contradicts what blocking meant; not after a skip, because the server re-queues
those itself; not after leaving, because a person who chose to stop is the last
one to re-match.

Note the asymmetry with **Block & next**, which does advance: an explicit
request and an automatic behaviour are different things, and only the automatic
one needs protecting against somebody who did not ask.

**The rate limiter shaped this, and was not widened for it.** `join_queue` is a
burst of 5 refilling one per five seconds; a three-second advance outruns it.
Raising the limit would make cycling strangers cheaper, which is what a spammer
wants. The countdown backs off after a refusal instead. Skipping spends no
token, so ordinary use never touches it.

### Telling someone they matched

Matching takes long enough that people tab away and return to a conversation
the partner already abandoned. On by default: it prevents a loss rather than
adding something.

Everything is gated on the tab being hidden. The chime is synthesised, so there
is no audio file to request, cache, widen a CSP for, or fail to load; the audio
context is unlocked on the click that starts a search, the one gesture
guaranteed to precede a match. Permission for desktop notifications is requested
on opt-in and never on page load — an unprompted dialog is the one everybody
dismisses, and a denial is permanent.

The notification carries no conversation content. It is rendered by the OS and
may sit on a lock screen somebody else reads, which is outside the boundary
content is allowed to occupy (I8), and "a stranger is waiting" is the whole
message anyway.

A small correctness detail: the title to restore to is read from `document.title`
rather than hardcoded, because a hardcoded string silently *renames* the tab the
first time an alert clears, and drifts the moment `index.html` changes.

### Where this leaves things

* **`npm run unblock` now clears late-block records too.** It is the "let me
  test blocking again" command, and clearing half the block state would leave
  confusing behaviour on the next test.
* **The swarm does not exercise any of this.** No persona blocks a departed
  partner, none has auto-search, and notifications are a browser concern the
  harness has no equivalent for. The late-block path has integration coverage
  and has never run under load.
* **Auto-search makes cycling strangers faster**, for a bored user and equally
  for somebody working through the population. Not a blocker — fast skippers
  already exist — but worth remembering when reading spam numbers after it
  ships.

## Phase 16 — session resumption ✅

A refresh or a dropped connection no longer ends a conversation. **This reverses
D7**, which said the opposite deliberately, and the reversal was an owner
decision taken with the trade in front of them.

### Why D7 was worth reversing

D7 avoided one thing: a token that could be stolen. Examined properly, that
threat needs script execution on this origin — where the attacker can already
read the live conversation, so the token adds nothing — or an unlocked device,
where the same is true. The cost was paid by everybody, constantly: a refresh, a
tunnel, a phone changing networks, all ended a conversation that had done
nothing wrong.

There was no cheap version. A returning browser must prove it is the same
person, or anyone could claim any conversation, and the obvious shortcut — the
block cookie, already sent on every connection — is forbidden by R14 precisely
because it is designed to be trivially rotated and to authorise nothing.

### The seat, and one expiry mechanism

`closeSession` marks the session detached and gives the row the grace window as
its TTL, instead of deleting it. Nothing new sweeps it: if the window passes the
row expires, and `janitorMatches` already ends a match whose side has vanished
and returns the survivor to notify. Two sweepers would eventually disagree.

### Three things that were nearly wrong

**`instanceId` cleared on detach.** The first version cleared it, which reads as
`PARTNER_GONE` in `resolveRoute`, which the message pipeline turns into "not
matched" and ends the conversation. One message sent during the gap would have
destroyed the very thing the window exists to protect. Caught by a socket test
that expected an ack and got an error.

**Shutdown held seats.** Draining closes every socket, so every session
detached and every partner was left waiting out a grace window for a server that
was going away. `draining` was already in scope at the close handler, so the fix
was one flag — but the symptom was the whole integration suite hanging, not a
clear failure.

**A failed resume left the old conversation on screen.** Clearing on
`socket_closed` was removed so the transcript survives a blip; the clear has to
happen on the `connected` frame that comes back with no `resumed` payload, which
is the first moment the server has actually said it is over. A unit test caught
it.

### The token

256 bits, stored only as a SHA-256, rotated on every redemption, refused for a
session that is still attached, and kept in `sessionStorage` so it dies with the
tab — a credential must not outlive the thing it unlocks.

It travels as a WebSocket subprotocol, the only value a browser can attach to a
handshake, and unlike a query string it does not land in an access log. Clients
offer `kbb.v1` beside it and the server selects that: a server must echo a
protocol the client offered, and echoing the resume entry would repeat the token
in the response headers.

A failed resume opens a fresh session rather than erroring. A stale token after
a long tab suspension is the common case, not an exception.

### Messages during the gap are lost, deliberately

Not buffered, because buffering means writing message text to a Redis key, which
is exactly what I8 forbids. The composer is disabled instead: preventing the
loss is honest, accepting a message that quietly reaches nobody is not.

### The tests that had to change, and why that was the interesting part

Six existing tests encoded "a dropped socket ends the conversation". They were
not wrong — they described D7 — so most now run against a context with
`RESUME_GRACE_SECONDS=0`, which is that behaviour exactly. The §10.9 disconnect
races in particular still matter: the window they are about still exists when
resumption is off, and still has to be safe.

That is also the honest reason to keep the switch: the old path is not dead
code, it is a supported configuration with tests on it.

One near-miss worth recording: a blanket find-and-replace across the §10.9 block
ran to end-of-file and rewrote two later suites that need two *distinct*
instances. The tests failed immediately, which is the only reason it was caught.

### The backtick trap, again

A Lua comment written with backticks terminated the TypeScript template literal
holding the script — the exact trap added to `CLAUDE.md` two commits earlier, in
a comment written while that entry was already in the file.

### Where this leaves things

* **Twenty seconds is a guess.** `chat_session_resumes_total{outcome="expired"}`
  is the measurement that should replace it: a high expired ratio means the
  window is shorter than the reconnections people actually make.
* **A conversation can now be paused with nobody talking**, which the partner
  experiences as a wait they did not choose. The countdown makes it bounded and
  visible; whether twenty seconds is too long to ask somebody to wait is a
  product question the metric will inform.
* **The swarm does not exercise any of it.** No persona drops and resumes, so
  the detach path, the rotation and the expiry have integration coverage and
  have never run under load — where a leaked seat would look like a capacity
  problem.

---

## The swarm catches up: profiles, resumption and a bug that made every run look clean

`load-test/swarm/` was written against the server as it was three phases ago.
Since then a `join_queue` carries a declared profile, a dropped socket no longer
ends a conversation, and a block can arrive after the partner has left. None of
that had ever run under load — and the last entry in this file said so.

### What the harness was missing

* **Every bot now declares a profile.** Not one persona: the whole population,
  on every join, because a field only one scenario exercises is a field whose
  interaction with everything else is untested. `names.txt` joins the linted
  benign corpora, and that lint matters more here than anywhere else — a name
  that fires a moderation rule is *refused* (D35), so a single bad line would
  quietly remove every bot that drew it from the population.
* **Four personas for §28** (L3 refresher, L13 gap talker, L14 late returner,
  L15 token replayer), and L9 now resumes: a mobile network flapping in the same
  tab is precisely the case the grace window exists for.
* **M10 blocks a partner who has already left** (D38), twice, because the record
  is spent when used and a second block must be refused.
* **G1–G4 for the declared profile**: the null path, the two refusals, and the
  churn that proves a join carries the whole profile rather than a patch.

### The bug the catch-up found

**No bot in this harness had ever reconnected.** `reconnect()` scheduled the new
connection through the same timer set everything else used, and the close its
own teardown produced ran `clearTimers()` on the next tick and cancelled it.

It had been that way since the first swarm commit, through 5,000-bot runs that
all passed. The signature was there to read — `connect_attempt` equalled the bot
count exactly in every ledger ever written — but a number that never moves does
not look like a failure. Four personas were doing nothing, and the runs got
greener for it.

D42 is what exposed it. When a dropped socket ended the conversation, a bot that
never came back was just a bot that left. Now the seat is *held* for twenty
seconds for somebody who is never coming back, so the first lifecycle run after
the change froze: sixty bots, twenty-nine conversations, no skips, nothing
moving.

The lesson is worth more than the fix: **a harness bug that removes behaviour
looks like a clean run.** When a persona group stops producing failures, check
that it is still producing events.

### An ack that means less than it says

The L13 persona sends into the gap on purpose, and the first run it survived
failed the pair oracle. The sequence was correct at every step: bot A's seat is
held, bot B sends, the server accepts it, resolves the route, publishes to a
channel with no subscriber, and acks `delivered: true`. Nothing is buffered
(D43). A never sees it. B is never told.

That is the documented contract — `message_ack` has always meant "accepted and
routed" — so the oracle was what needed to change, not the server. The
comparison used to assume the receiver's list was a *prefix* of the sender's.
Under §28 it can be the sender's list with a **hole in the middle**, and index
alignment turns one missing message into a whole conversation of reported
delivery bugs.

It now walks both lists with two pointers and may skip only an unconfirmed
send — one whose ack cannot be read as proof of arrival, either because the
partner's seat was held or because the socket died holding it. Everything else
is still held to strict order with no tolerance. The report separates *provably
never delivered* from *no proof either way*, because they are different facts.

The first version of that fix was not enough, and the reason is worth keeping.
The sender marks a message unconfirmed when it *knows* the partner is away — and
it learns that from a `partner_reconnecting` frame that takes a round trip. The
next run failed on three matches where a message had been acked **ten
milliseconds before** its partner recorded the close: sent in good faith, into a
socket that was already dying, with no flag anyone could have set.

So the oracle reads the partner's own ledger instead. Each bot's `closed` and
`connected` events bound the stretches when it had no socket, and anything acked
inside one could not have been delivered. That needs 500 ms of lead tolerance,
because a recorded close is when the *bot* noticed rather than when the socket
became unusable — the only tolerance in the oracle, and it buys the difference
between a red run per reconnect and a check that still holds everything outside
those windows to strict order.

The product question that falls out is in `docs/testing/SWARM-HANDOFF.md` §7: should the
ack distinguish "routed to a live socket" from "routed to a held seat"? Today
the composer being disabled is the entire defence, which is a UI guarantee
protecting a protocol property — an arrangement that survives exactly until the
second client.

### A seventh oracle, and a first-run failure worth keeping

**Profile agreement.** For every match: what a bot declared must be what the
server echoed to it as `you`, and must be what the other side was shown as
`partner`. A break in the first leg is validation or the session hash losing a
field. A break in the second means a profile reached the wrong conversation —
and in a product where the declaration is the only thing one stranger knows
about another, that is the serious one. Hashes throughout, so the ledger never
holds a declared name.

Its first run failed six times out of fifty-eight, and the harness was wrong:
`profileFromFields` collapses an all-empty profile to `null`, so a bot that
declared nothing sent an object and was shown a null, and a hash that told those
apart accused the server of losing every anonymous profile. Recorded as a trap,
because the next person to hash a wire type will meet the same asymmetry.

### Two N6 bots accused of running a spam campaign

The `human` mix is full of rapid turn-takers, and the first run of it failed the
spam oracle on two of them: ordinary talkers the offline campaign query would
have accused.

The query is not wrong. It calls five identical lines across five distinct
conversations a campaign, and a bot sending twenty to fifty messages a
conversation from a forty-line corpus repeats itself into five conversations
within a couple of minutes. The false positive was manufactured by the harness's
own vocabulary.

`replies.txt` went from 40 lines to 124 and `smalltalk.txt` from 50 to 98, and
the next 150-second run came back clean. That looked like the end of it, and it
was not: the first full twenty-five minute run flagged **251 of 381 benign
bots**.

Which is the actual finding, and it is a better one than the fix.

| Run length | Conversations per benign bot | Benign bots the query would accuse |
|---|---|---|
| 150 s | 4 | 0 of 381 |
| 1,500 s | 35 | 251 of 381 |

Nothing about the query or the server changed between those rows. "The same line
in five distinct conversations" is not a campaign definition — it is a
vocabulary-size measurement, and everyone fails it eventually, including real
users, who say the same greeting to far more than five strangers in a week. The
zero-false-positive column in `testing/LOADTEST-SCENARIOS.md` §6.1, which is the number
that made the proposed canonical form look free, was measured over four
conversations per user.

So two changes, one to the harness and one to what the harness claims.

**The oracle stopped gating on it.** A spam false positive now reports; only a
**block durability violation** fails the run, because that is the part that is a
property of the server rather than of a detector nobody has built. The old
behaviour meant this oracle could not pass an endurance run (E10) however
correct the product was, which is the definition of a bad test — and it took a
long run to notice, because every run before this one was short enough to hide
it.

**The recall figure keeps its caveat now.** The campaign canonical form's recall
is real. The precision beside it is not a property of the form; it is a
property of how long you watched. Anything built on `campaign.ts` needs a second
axis — volume, rate, or what share of a sender's output the repeated line is —
before it is pointed at an account.

### For the person who wants to be in the run

`--profile human` is a mix shaped for somebody sitting at the browser rather
than for statistics: prompt repliers dominate, declared profiles are heavy
because that is what a person looks at first, and the abusive fraction is small
but not zero — without somebody worth blocking, Block and Report go untried.
`--human` puts a caveat in the report, since a person is invisible to the ledger
and shows up only as its consequences.

The browser needs no special treatment, which is worth stating because it looks
like it should: it sends no `X-Forwarded-For`, so with `TRUST_PROXY_HOPS=2` the
chain is shorter than the hop count and `clientAddress()` falls back to the peer
address. The person gets nginx's address, every bot keeps its own, and they
cannot collide.

One thing that only shows up when a person actually tries it: opening
`http://127.0.0.1:8090` instead of `http://localhost:8090` is refused. They are
different origins to an allowlist that matches scheme, host *and* port, and the
load stack listed only one of them.

What makes it worth writing down is how it presents. The upgrade returns 403,
the client retries the way it would after any dropped connection, and the UI
sits on "connecting" — identical to the backend being down. Nothing is logged,
because a refused origin is not an error the server has any reason to report.
The only evidence is `chat_connections_rejected_total{reason="origin"}`, and it
was found by noticing that counter was the only non-zero one while bots — which
always send a matching Origin — were connecting perfectly.

`.env.loadtest` lists both loopback spellings now, and this machine's LAN
address, with the reasoning next to them.

### Adding that origin cost 244 bots, which is how the next bug was found

The allowlist is read once at startup, so the LAN entry needed the backends
recreated. Two minutes later the run had 400 bots connected and 148
conversations, down from 375.

nginx answers **502** while it has no upstream. Every bot that reconnected into
that window hit `unexpected-response`, which called `finish()` — and a finished
bot never tries again. 244 of 400 were gone for the rest of the run.

The progress line said "400 connected" throughout, because it counted bots with
a session id rather than bots with a socket, and a session id outlives the
socket it was issued for. The one number that would have made the loss obvious
was the one being printed wrong.

This is the third instance of the same shape in one sitting — the reconnect
timer, the spam oracle's precision gate, and now this. **A harness bug that
removes population looks like a clean run**, and the smaller population passes
every oracle it is measured against.

Both halves are fixed. A refusal a real client would retry — 429, 502, 503 — is
retried with jittered backoff and a ten-attempt cap; 403 stays terminal, because
a banned client that kept hammering would be the bug. The progress count reads
live sockets. Verified against a server that refuses every upgrade: 502 produced
five backed-off attempts and no death, 403 produced exactly one attempt.

It matters beyond this incident: pausing or restarting a backend is the *point*
of the C group, and without this the harness would lose most of its population
every time one of those scenarios ran.

Two smaller things came out of setting that up. `RESUME_GRACE_SECONDS` and
`BLOCK_LATE_WINDOW_SECONDS` were not passed through `docker-compose.yml` at all,
so the D7 comparison run `.env.loadtest` describes was not actually possible.
And `npm run unblock` talks to the *development* project — against a load run it
fails, or, if the dev stack happens to be up, clears the wrong database and
reports success. There is an `unblock:loadtest` now.

### A fourth one, found by the oracle it broke

The last run of the day failed metric conservation: 14,781 matches created
against 28,379 matched frames where 29,562 were expected, and 853 conversations
with one side missing from the ledger.

None of it was the server. The previous run had been stopped from outside, and
stopping the orchestrator did not stop the **worker** it forked — that process
kept 156 bots alive for 179 seconds into the next run, and the two swarms
matched with each other. Half of each of those conversations sat in a ledger the
other run had never heard of.

The worker had no way to notice. Its progress timer wrote into a closed IPC
channel and the failure was swallowed, so it carried on holding sockets against
a stack that now belonged to somebody else. It exits on `disconnect` now, which
fires however the parent died, and flushes its ledger on the way out so a killed
run still leaves its evidence.

Worth saying plainly: the oracle was **right**, and what it reported was real —
the population was not what the run believed it was. A conservation check that
had been tuned until it stopped complaining would have said nothing here.

The other half of that verdict was a two-record overshoot: retention flushed
plus dropped exceeded queued by two. That identity is exact over a process
lifetime and only approximate over a slice of one, because the counters are
diffed against a baseline taken before the first socket opened — anything
already in the queue at that moment is flushed inside the window and queued
outside it. The slack is bounded by queue depth rather than by run size, so it
is a small constant rather than a percentage.

### Where this leaves things

* Verified green at 400 bots on `human` for 1,500 seconds — 12,057
  conversations, 96,400 message positions compared, 24,114 declarations agreeing
  on both sides, four messages provably lost to the gap and no delivery
  disagreement anywhere — plus 1,000 on `realistic`, 200 on `adversarial` and 60
  on `lifecycle`. The 5,000-bot number predates the change and should be
  repeated: held seats are a standing population of unreaped sessions, which is
  new pressure on exactly the state a large run exists to stress.
* Grafana gained the panels for what the last three phases added — resumes by
  outcome, profiles refused by reason, delivery latency by route, enforcement.
  `expired` is the one to watch: every one of those was a conversation that
  ended when it did not have to.
* L15 proves a *spent* token buys nothing. It does not present a token while the
  session holding it is still attached — that needs two live sockets for one
  bot, and this harness is built on one bot, one socket.
* One worker died unexplained: an earlier 1,500-second run lost its only process
  at 88 seconds with `0xC0000409` and no stderr, and did not reproduce in three
  later runs, one of them the same length. The orchestrator caught it — a dead
  worker fails the verdict and says the population was incomplete — which is the
  only reason it is a note here rather than a quietly greener report.


## Chaos, an adversarial policy review, and the pre-launch floor

Three strands, and they turned out to be one: each found things the others could
not, and two of them found mistakes in my own work.

### C1 — a database outage is not a chat outage, watched rather than argued

`D16` is the design's central reliability claim, and until this it was a claim
the code argued for. The chaos scenario pauses PostgreSQL mid-run — `pause`, not
`stop`, because a stopped container refuses connections instantly while a paused
one accepts them and never answers, which is the nastier failure and the only
one that tests timeouts.

Delivery held at **82.9 msg/s with the database frozen** against 80.5 after it
resumed, and client lag p99 did not move off 23ms across the pause *or* the
recovery. The claim holds.

The scenario then found two product bugs, and the second was only reachable
because of the first.

**F-031 — the breaker could not open fast enough to reach its own spool.** The
first run ended with the breaker still CLOSED after sixty seconds, the retention
queue grown from 30 records to 3,320, and the outage spool untouched. The cause
was arithmetic, visible once the failure log was lined up per instance: every
failure was exactly twenty seconds after the last, against a
`DATABASE_STATEMENT_TIMEOUT_MS` of ten. Each one cost *two* deadlines — the
statement hung until the driver gave up, then `transaction()` sent a `ROLLBACK`
down the same unanswered connection, where it queued behind the hung statement
and waited out the deadline again. The breaker wants five consecutive failures,
so it needed 5 × 20s = 100 seconds of downtime before it could open at all.

A rollback down a connection nobody is answering was never going to succeed, so
the second deadline bought nothing. The fix distinguishes the two kinds of
failure by whether PostgreSQL answered at all: every server error carries a
five-character SQLSTATE, including `57014`, its own statement timeout, which
arrives on a live connection. An error without one was manufactured by the
driver, and that connection's state is *unknown* rather than merely failed.

The same six lines held a second defect with no symptom yet: the cleanup called
`client.release()` bare while the comment directly above claimed it was
"releasing it with an error" — which is what would have destroyed the client. It
did not, so a connection that timed out mid-transaction went back into the pool
with a transaction still open on the server.

**F-032 — one orphan message destroyed the batch it travelled in.** Fixing F-031
made the spool reachable for the first time, and the next run lost **1,350 P0
records** in ninety seconds. P0 is the most protected class, the one a
per-session sub-quota exists to defend and an alert pages on. The kinds were
`conversation_started`, `conversation_ended`, `moderation_event` — not messages,
but the rows every message depends on.

Not capacity, either. Every rejection was the same single error: a `23503` on
`messages_conversation_id_fkey`, a message whose conversation row had not been
written yet. Which the design already treats as *normal* — the conversation row
is written by whichever instance won `tryMatch`, the messages by whichever owns
each socket — and is why `deferForParent` exists.

Two amplifications turned one late parent into hundreds of losses. `writeGroup`
never narrowed on the missing-parent path: its generic permanent-error branch
carefully re-writes a batch a row at a time so one bad row cannot take the
innocent rows with it, and the branch directly above deferred, retried and
finally discarded the *whole group*. And `drainSpool` had no salvage at all, so
one 23503 discarded up to a hundred spooled records including the conversation
parents beside it.

Both now hold the principle the live path already had: **refusing a batch is not
refusing every record in it.**

A third, smaller defect fell out of the same run. `reportDrop` logged every P0
loss as "retention capacity exhausted" whatever the cause, although the caller
had always passed the real reason to `countDrop` beside it — so the run produced
357 page-worthy lines blaming capacity for records the database had *refused*.
Opposite causes wanting opposite responses, one of which no amount of capacity
would fix.

### C2 — losing an instance is not losing the service

`docker kill`, not `stop`: SIGKILL, no drain, no `server_shutdown`, no chance to
hand seats back. The likelier event by far, since a backend dies on every deploy
and every OOM.

The product came through it. The survivor absorbed the whole population with no
step in client lag — p99 at 22.7–23.0ms across the kill *and* the restart — and
591 of 591 connections came back. Cross-instance routing is Pub/Sub on a
per-session channel, so there is no table to go stale, and half the sessions
changing host at once is the condition that would have exposed it if that were
untrue.

**All three bugs C2 found were in the measurement, not the thing measured**, and
that is the more useful lesson.

A dead instance stops reporting rather than reporting zero, so a sum across
"whatever answered" *falls* when an endpoint disappears — which reads as
delivery collapsing, the exact conclusion C2 exists to test for, reached by
arithmetic instead of evidence. Samples now carry their target and the oracle
compares only instances alive in every phase.

A bot whose socket died without its persona asking was finished for good.
Correct for every scripted close, wrong for the only kind the C group creates:
the first run ended with 282 of 586 connections and read exactly like a product
refusing to let clients back in. A real browser reconnects after a drop — that
is the whole of §28 — so `reconnectOnDrop` is set for chaos runs and off
everywhere else.

And a killed process makes conservation *unprovable*: it takes its counters,
which restart at zero, and its in-memory retention queue, whose records were
acknowledged to clients and will now never be written **or counted as dropped**,
because the counter that would have counted them died in the same instant.
Neither oracle was relaxed — conservation names the identities it could not
check and says why, and the database oracle quantifies the loss instead of
calling it silent.

> An oracle that reports a harness limitation as product data loss is worse than
> no oracle. It gets believed once, and ignored for ever after.

### The policy review, and seven false statements

The G1/G2 drafts carried 31 `[[DECIDE:]]` markers. Markers were the right output
when they were written, but they make a document unreviewable — nobody can argue
with a hole. Every question now has a **drafted position** with its reasoning and,
where it carries risk, the triggers that would reopen it. Facts only the operator
holds stayed as `{{TEMPLATE_VARIABLES}}`, because plausible-looking false detail
in a legal document is worse than an obvious gap, and Terms §10/§11 stayed
deliberately empty.

`REVIEW-PROMPT.md` was written to be adversarial by construction, since a model
asked to review a policy will call it comprehensive and well-structured. It
carries a verified factual description of the system so a reviewer never has to
guess, forbids filling in the template variables, and demands output keyed to the
decision register.

It worked. The review rejected five positions and refused to launch — and its
most valuable section was not the legal argument but a list of **seven places
where the documents described a system that is not the one that was built**. That
category matters more than any position: a weak argument is arguable, a false
factual statement is simply false, in a document handed to users and eventually
to a regulator. These drafts had claimed every factual statement was checked
against the code.

"We never ask for your name" sat forty lines above "you can optionally enter a
name". "No location beyond what an IP address implies" was listed under what is
deliberately *not* collected, while the profile lets a user declare a country.
**"Our moderation team" appeared four times** — there is no team, there is one
person, and that is the one that most changes what a user understands. "Nobody
outside this service can connect a conversation back to you" is stronger than the
facts support. The Terms promised every report would be acknowledged while the
safety policy deliberately withholds acknowledgement when one could not be
recorded. "Fully gone within seven days" ignored legal holds — **my error, added
in the same session**. And the §2258A note implied 90 days was the preservation
period when the statute provides for one year.

The review also reported "Nothing kept after you leave" as a live false statement
on the landing screen. It is not: the product fixed F-016 and `age-gate.md` had
not noticed. **Stale documentation generates phantom findings**, and a reviewer
given only documents cannot tell the difference.

### India, which changed two answers

The operator is in India, and two positions had been drafted without knowing it.
The CSAM escalation table now leads with the Indian route under POCSO rather
than with US and UK bodies, and the service publishes a grievance mechanism with
an automated acknowledgement, because acknowledgement can be automated and
resolution cannot.

`JURISDICTIONS.md` records the geography decision.

### The floor, built

Four things, chosen because they are cheap, correct under any later decision, and
each closes something that was simply missing.

**The age gate.** The policy settles on "exclude minors, and ask"; child
safety relies on this gate plus reporting and moderation. "We do not check anyone's age" is on the screen
rather than in the Terms, because a gate that implies verification manufactures a
false sense of safety in the person who passes it. It is deliberately harder to
dismiss than anything else — no Escape, no backdrop, no close button — since
those gestures exist to back out of something opened by accident. The
acknowledgement is **versioned rather than dated**: re-asking on a schedule is
theatre, and re-asking when the wording changes tracks what was agreed to.
Storage failures show the gate rather than skip it.

**Policy links in the footer**, because the gate is shown once per browser and
every returning user could otherwise never reach the documents again.

**Geo-blocking at the edge**, on a country header rather than a GeoIP database.
Two things were got wrong first and found by running it: `error_page` does not
intercept a `return` from an `if` in the *server* block, so the first version
shipped a 451 with an empty body; and the block has to cover `/ws`, because
refusing the page while leaving the socket open restricts nothing.

**Off-host backups.** A dump beside the database it protects guards against
somebody deleting rows and nothing that takes the host with it. Each encrypted
dump is copied to a configured remote and a failed copy fails the run — the
opposite of the inward report, because a dump that never left the machine has not
achieved what a backup is for. Verified against the live database: the copy
**decrypts and `pg_restore --list` reads 11 tables out of it**, which is the
check that matters, since an encrypted backup you cannot decrypt is not a backup.

### Where this leaves things

* The engineering risk is low. 32 audit findings closed, C1 and C2 demonstrating
  survival of a database outage and an instance kill, 418 unit + 77 frontend +
  436 integration green.
* **What blocks launch is not code.** It is twelve template variables, of which
  hosting location and the jurisdiction set unblock most of the rest.
* The seven factual contradictions the review found were worth more than its
  rejections.

## AI personas, and the decisions that shaped them

Seven phases, A0 to A6. Optional automated conversation partners, off by
default. Twelve decision records, three migrations, a separate process, 197 tests. Off by
default and off again in the database, so enabling it takes a deployment change
*and* a deliberate audited act.

### The shape that made the rest cheap

A persona is an ordinary client. It opens a real socket, joins the ordinary
queue and is matched by the ordinary path — no branch in `tryMatch`, no new Lua,
no virtual peer. The alternative was tempting and would have meant re-verifying
every matchmaking race for a feature that is off by default.

What it bought is best seen in the tests nobody wrote code for: a persona can be
blocked, can be reported, waits out a partner drop rather than treating it as
goodbye, and has its own output moderated by the server. All four fall out of
being a client.

The second half of the shape was asked for rather than designed: no static
name, age or location. Splitting the persona into a durable **character** and a
**surface generated per conversation** means the surface is literally a
`Profile` (the same shape a real user declares), so it rides the mechanism that
already exists, with no new storage and nothing durable held against an
identity.

### Where the plan was wrong, twice

**"Built on `load-test/swarm/src/bot.ts`"** was wrong about the file while right
about the approach. That file is 1,266 lines and imports the ledger, the corpus
and the campaign phases; importing it from `backend/` would have made the load
test a production dependency and put chaos-injection code on the path a real
user talks to. The production client was written fresh and is a third the size,
because it needs none of what makes `bot.ts` large.

**A0 said to rewrite the policy documents.** Doing that before the feature
existed would have made them false in the other direction — a Terms of Service
announcing automated accounts on a service that has none. So A0 produced the
exact replacement text in a staging file with a script asserting it still
matched the documents it patched, and the swap happened once personas could
actually join.

### The guarantee the fill policy owes

Never take a conversation a human was going to have with another human. It
dispatches only when exactly one non-persona searcher has waited past a
threshold, and it counts its own personas **by identity rather than by
estimate** — an undercount makes the queue look emptier than it is, which is
precisely when a bad dispatch happens.

The race it cannot close from the client side is stated rather than denied: a
second human can arrive between the decision and the join. Closing that would
mean teaching `tryMatch` what a persona is. Instead a searching persona
withdraws within a tick once humans can pair, and the residual is counted.

### Money is a ceiling, not an alert

In PostgreSQL, because a Redis counter resets to zero on restart — which is not
a budget but a budget that silently refills exactly when something has gone
wrong enough to restart the process. The check runs before every model call and
fails closed. Column-level grants mean the persona process can add to the
counter and **cannot raise its own ceiling**, because a process that can raise
its own limit does not have one.

The prompt splits into a cacheable half and a volatile half, and that split is
worth more than anything else in the cost model. Getting it backwards has no
error case; the bill is simply several times larger. Hence the counterintuitive
line in the adapter: **trimming the character sheet to save tokens can raise the
bill**, because below the minimum cacheable prefix the whole block stops caching
and goes from a tenth of the input price to full price. Roughly ₹0.75 a
conversation on Haiku with the cache working, and a test pins the number rather
than leaving it in prose.

### The limits, and where D-AI-4 moved

The six limits sit between the model and the socket rather than in prompt text,
because a limit the model can be argued past is the failure the companion-app
cases turned on. Their tests are written to get *past* them, and two gaps are
left open and tested as open — pattern matching is a floor, and a test implying
otherwise would stop anybody looking.

D-AI-4 moved during the work. The enforced rule is that a persona **never
claims to be human and never asserts something false** about what it is, and
the guard layer enforces it rather than prompt text. The published Terms
describe automated accounts and were written to match what the code does,
because a promise the code does not keep would be a false statement in a
published document.

### Three bugs that only running it found

* **A `message` frame without an envelope id is refused** — the replay token
  (D24). The unit tests passed because a fake socket accepts anything; only the
  real server caught it.
* **The identity check sat after the voice**, so its behaviour depended on
  what the voice returned. It moved before generation, so the guard layer
  handles identity questions and the model never sees them.
* **Sixteen metrics were declared and dead.** `metrics-wiring.test.ts` caught
  every one, which is exactly what it is for: a charted metric that reads zero is
  believed.

### What is deliberately not built

* **No sexual content**, under any framing. Flirtation is built; that is where
  it stops, and it is the one limit in D-AI-5 not open to a risk judgement.
* **No UI label on an AI partner.** Described in the Terms rather than in the
  interface; a persona never claims to be human.
* **No persistent user-persona relationship.** Recognising a returning user
  needs a durable per-user identifier, which is the correlator §24.3 forbids.

### Where this leaves things

The policy patch is applied and the staged patch file is gone. Publishing
those documents is a **material change** under their own 14-day notice clauses,
and that notice runs before personas reach production — which is the last thing
standing between this feature and a live deployment, and it is not a coding
task.

Four template variables remain, and `{{MODEL_PROVIDER}}` only binds if personas
ship with a model behind them. On the scripted voice they hold real
conversations, exercise every control, and spend nothing.

## Payments — porting a working prototype onto this codebase's contracts

A Razorpay integration arrived as a folder of finished files (`payment-files/`):
two routes, a migration, a checkout helper, and six modified copies of existing
files. It worked. It was also written against a generic Node skeleton rather
than this one, so almost none of it could be applied as a patch — the parts that
were wrong were wrong in ways that do not fail loudly.

### What the prototype got right, and was kept

Server-side pricing, an amount re-check at capture, idempotency through
`on conflict (payment_id) do nothing`, and an HMAC over the raw request body.
Those are the load-bearing ideas and they survived the port unchanged in spirit.

### What was replaced, and why each one is quiet

* **A fallback webhook secret.** `process.env.RAZORPAY_WEBHOOK_SECRET ||
  'dummy_webhook_secret'` means a deploy that forgets the variable accepts
  webhooks signed with a string published in this repository — and the symptom
  is not an error, it is a stranger granting themselves premium. `assertCoherent`
  now refuses to start, the way it does for the persona provider triple.
* **A test-mode key in production.** Added while writing the checks above,
  because it is the sharpest silent failure available here: everything works,
  the entitlement is granted, and no money moves. Nothing at runtime reports it.
* **`INTERVAL '${duration}'`.** A string interpolated into SQL whose safety
  rested entirely on one file being its only source. Products now carry a number
  of days and it goes through `make_interval()` as a bound parameter.
* **`premium_until = now() + interval`.** Renewing early deleted whatever time
  was left. It is `greatest(premium_until, now()) + …` now, and the person who
  would have found the bug is one who paid twice.
* **No refund handling at all.** The money goes back and the deadline stays
  where it was. `refund.processed` now subtracts what it granted — and reads the
  *refund* entity's amount, because a partial refund reports the full payment
  amount one level up.
* **`userId` from the request body.** Echoed into the provider's `notes` and
  read back off the webhook to decide who gets premium. That is protocol rule 3
  and §25.3 in a new place: the subject of a state change arriving from outside.
  `payment_orders` now holds the binding, written by us at order creation, and
  the webhook resolves the account by joining to it.
* **`'unsafe-inline'` in `script-src`.** Disables the strongest control this
  origin has, on a page that renders text written by a stranger, for a script
  two pages use. The checkout runs in an iframe under Razorpay's own policy, so
  it buys nothing here.
* **A CSP widened in `index.html` only.** `security-headers.conf` is the policy a
  browser actually enforces, and it was untouched — so the integration would
  have worked in `npm run dev` and been blocked in every deployed build.
* **A `users(email, password_hash)` table.** A second identity model beside the
  `accounts` table already staged in `migrations-pending/`, contradicting the
  reasoning written into it. Payments hang off `accounts`.
* **Unbounded body reads on an unauthenticated route**, no rate limit on order
  creation, `!==` on the HMAC, `console.log` in place of the logger — including
  raw `pg` error objects, which echo statement parameters.
* **Two Razorpay orders created on every page view**, before anyone clicked.
* **`requestAnimationFrame` forcing inline `!important` styles onto the vendor's
  DOM.** A stylesheet written in the wrong language: it cannot be reviewed as
  CSS and breaks silently when a class is renamed. Three properties on one
  selector do the same job, and if the selector stops matching the result is the
  vendor's own backdrop — ugly, not broken.

### The one that had to be run to be found

`new URL(req.url, 'http://' + req.headers.host)`, which the prototype used to
replace the existing path split. It reads better. `handleHttp` has no try/catch,
the URL constructor throws on a malformed `Host`, and a throw inside a request
handler takes the process down — with every WebSocket on it. A header anybody
can set must not be able to do that. The original `split('?')[0]` stayed.

### Where this leaves things

Complete and switched off, in both halves: `PAYMENTS_ENABLED` is false in
`features.ts` and defaults false in the backend, and `011_payments.sql` sits in
`migrations-pending/` beside the accounts migration it depends on.

Three things block the flip and none of them is code. The retention period for a
financial record is statutory, so nothing sweeps `payment_orders` yet. Terms §15
already recommends a **merchant of record** over a bare payment processor —
Razorpay is the latter, which leaves the operator personally owning cross-border
tax and invoicing, and that note was written before anything was built. And
there is no refund policy, which India's consumer rules expect published.

Flipping the flag also makes two published claims false — "no requests to any
third party at all" and "there is no payment provider, because nothing is for
sale". `PENDING-PAYMENTS.md` holds the exact replacement text, and
`verify-pending-policy.mjs` (generalised to handle more than one staged patch)
now asserts its eleven anchors on every build.

## The site chrome, two pages, and the things a pinned footer broke

### A header that had never worked

`EditorialShell` wrote `sticky top-0` on its header and it had never once held.
`overflow-x-hidden` sat on the flex column *inside* the scroller, and when one
axis is `hidden` the other computes to `auto` — so that column became the
nearest scrollport and the header pinned to a box that never scrolls.

Measured rather than argued about: header top ran 0 to -2306 across a full
scroll on `/premium`, tracking the content exactly. Nothing errored, which is
why it survived so long. `/premium`, `/about`, `/how-it-works` and `/rules` were
affected; the two `SitePage` documents never had the extra wrapper and were
fine. The clip moved to the element that already scrolls.

### Pinning the footer changed what it *is*, and two things quietly broke

This is the part worth carrying forward. Making the footer persistent turned it
from the end of a column of prose into chrome — and two decisions that were
correct for the first thing stopped being correct for the second.

* **Alignment.** The design put the links at the left edge of the 680px measure,
  because a footer at the end of prose belongs to the prose. Pinned, that became
  a full-width bar with a 344px huddle of links ending at x=958 and most of a
  screen of empty bar to their right. Each footer now takes its own header's
  gutter — 32/32 on the editorial pages, 530/530 on the documents, because their
  headers differ.
* **The menu button.** The panel had held the secondary links; when those moved
  to the footer its only content was the primary set, already `md:hidden`
  because the header shows them inline. Nothing hid the *button*. On desktop it
  opened a 50px box containing a close control and nothing else. Two places knew
  the breakpoint and one was updated.

Both are the same failure: a change of context that no test could see, because
nothing was broken in a way code can assert.

### FAQ and Safety

Built from the `wordings-ui` designs. FAQ is twenty questions in four groups as
native `<details>`, and the reason is find-in-page: a browser expands a closed
one to reveal a match inside it, so Ctrl+F reaches all twenty answers. A
state-driven accordion hides them, which would make the page's whole job
impossible for anyone who searches instead of scrolls.

Safety puts Skip, Block and Report above every paragraph of advice — somebody
opening it mid-conversation needs the controls, not the essay — and gives
sections 05 and 06 no entrance animation and no hover, because those are the two
somebody reaches on the worst day they will have here.

**Two FAQ answers depart from the operator's draft**, and `faq.test.ts` holds
them there so a later transcription pass cannot restore either:

* *"Am I talking to a bot?"* is not answered "No". Terms §3a discloses automated
  accounts and commits to never denying them. The draft also contradicted
  itself — its own answer to "Who can read my conversation?" describes them.
* *"Is my location shared with strangers?"* is not answered "No". `server.ts`
  resolves the country from the connection at the upgrade, discards whatever the
  client sent, and puts it on the profile the partner sees.

### Hidden, never deleted

Premium, `/support` and the filter control are behind flags rather than removed,
because they come back. `FILTERS_AVAILABLE` is derived — `FILTERS_ENABLED &&
PAYMENTS_ENABLED` — so payments alone cannot expose a filter the queue has no
segment to honour, and filters alone cannot give the paid tier away. The chat
header used to carry a filter button whose only function was to open a modal
saying "Part of Premium": an invitation followed by a refusal.

### The mark, the domain, the addresses

The mark is redrawn from `docs/brand/new-logo.png` as hand-built arcs rather
than a raster trace, so it stays clean at 16px and the `mono` variant still
works. It now differs from the old one in **size** as well as opacity, and that
matters: opacity alone nearly vanishes in greyscale, taking the "two voices"
reading with it.

`karobakbak.com` replaced the placeholder throughout. Five role addresses were
mapped, and `{{CONTACT_EMAIL}}` was *split* rather than substituted — it had
appeared seven times in three roles, written as one variable only because there
was one address.

### The coffee button, and why the vendor's snippet is not used

Buy Me a Coffee ships an `<img src="https://img.buymeacoffee.com/...">`. It
would have been blocked by `img-src` outright — and widening the policy to admit
it would have made a published claim false, because the Privacy Policy says the
browser makes no third-party requests.

That is a real leak rather than a technicality: the footer renders on every
page, so a remote image there hands the vendor every visitor's IP address and
referring page, on every render, without a click, on a service whose premise is
anonymity. The rendered SVG is fetched once and served from this origin; it is
self-contained, and the live page afterwards makes zero remote requests. The
re-fetch command and the condition that would end the arrangement — a future
button that pulls something remote — are in `docs/brand/README.md`.

### Where this leaves things

`main` has everything, and every product flag is still false. What blocks launch
is in `PHASES.md`: `www` must redirect rather than serve, `{{PUBLICATION_DATE}}`
on the day, and somebody actually reading `abuse@` and `contact@`, which now
carry a statutory window and a 24-hour promise respectively.

## Three reported bugs, a preference that is not a filter, and one shape under both

Three findings arrived as a report — F-033, F-034, F-035, continuing the audit's
numbering in `docs/testing/BUGS.md`. Each was verified against the code before being
written down, and one of the three turned out to be a different bug than the one
described. What followed them was D44, and what the two together kept producing
was a single recognisable failure, recorded at the end.

### F-035 — three indexes, and a measurement rather than an assumption

The console's triage queue, `openReport`'s block lookup and the five-minute
`reapplyActiveBans` pass each read a table by a column nothing indexed. Nothing
was incorrect; the answers were right and only the cost moved, which is exactly
why it survived a full audit with no test able to notice.

Measured on PostgreSQL 16 with 20k conversations, 60k moderation events, 40k
blocks and 30k enforcement rows of which 40 were live:

| Query | Before | After |
| --- | --- | --- |
| Triage queue | 167.963 ms | 3.284 ms |
| `openReport` blocks | 3.273 ms | 0.119 ms |
| `reapplyActiveBans` | 3.501 ms | 0.066 ms |

The triage queue was the one that mattered and it was superlinear in the wrong
direction: the flags subquery scanned every moderation event once per report
listed, so the cost was reports × events retained.

`CONCURRENTLY` was considered and the runner settles it — `migrate.ts` applies
each file inside a transaction so the schema change and its ledger row cannot
disagree, and `CONCURRENTLY` is refused inside one. Numbered 012 because
`migrations-pending/` reserves 010 and 011 and a guard script watches that
staged patch.

One expectation did not survive the measurement. The second query in the ban
reload asks for `expires_at is null or expires_at > $2` and was expected to fall
back to a scan; the planner splits the disjunction into a BitmapOr over two
scans of the partial index. The migration records what was measured.

### F-034 — a record rescued into somewhere worse

`salvage` is shared by the live queue flush and the spool drain, and it handed
everything it rescued to the in-memory queue regardless of where the record came
from. On the live path that is right. On the drain it took a record that was on
disk **because the database was down**, moved it into the memory of a process
that had just survived a database outage, and then cleared the file.

The window is not small: a container restart is the *likely* event straight
after an outage, and the records involved are the P0 safety evidence the spool
exists to protect.

`RetryTarget` is the seam. `flush` passes the queue and behaves exactly as
before; `drainSpool` passes a collector and writes what it collects back to the
file. `requeue` was routed as well as `defer` — the same transfer on a shorter
window is still the same transfer, and an implicit destination across five call
sites is a trap for whoever adds the sixth.

The regression test builds a second writer over the same spool directory,
because that is what a restart actually is: a fresh queue and the same file.
Confirmed to fail without the fix, with the record gone from disk.

One existing test changed, and the reason is worth stating: it asserted the
spool was empty after two flushes, which was true **because of the bug** — the
record left the spool on the first drain by going into memory.

### F-033 — the reported bug was not the bug

Reported as: the Lua scripts derive keys from a prefix instead of declaring them
in `KEYS`, so Redis Cluster is impossible. True, and it is D13 — `tryMatch`
computes which session keys it touches while it runs, so they cannot be declared
in advance, and one shared queue is the opposite of a sharded keyspace.

The actual gap was the other half of D13, which already promised "vertical +
replica failover" and had never been built. `createRedisClients` took one URL;
ioredis reaches a Sentinel set through a different constructor shape entirely,
so **no value of `REDIS_URL` could ever have produced failover** — while
`reconnectOnError` sat in the same file matching the `READONLY` a promoted
replica sends, failover handling in a system that could not fail over.

Every half-specified topology now refuses to start. That is the feature more
than the connection is: a topology that quietly used one address would look
configured, pass every health check for months, and reveal itself on the one
night it was bought for.

**The first drill failed, and that is the most useful thing here.** The rig
monitored the primary by container name with `sentinel resolve-hostnames yes`.
It formed a quorum, reported the topology correctly, and then failed over *not
at all* — forty seconds, quorum satisfied, replica still a replica. The logs:

```
# Failed to resolve hostname 'redis-primary'
# +tilt #tilt mode entered
```

Stopping a container removes it from Docker's DNS. Sentinel's lookup blocks, the
latency spike reads to Sentinel as its own clock jumping, and it enters TILT — a
mode where it deliberately stops acting because it no longer trusts its timing.
It never votes, and the symptom is silence rather than an error. It never
recovered either: TILT lasts 30 s and the retry re-triggered it every ~7 s,
measured off the log timestamps.

Static addresses now. Measured after: ~3 s promotion, state intact because the
replica held it in memory, and the demoted primary answering
`READONLY You can't write against a read only replica.` — the exact string
`reconnectOnError` was already matching.

Two limits are recorded rather than smoothed over (§17.3): a returning node is
briefly a primary again and a write landing on it is discarded by the resync
(verified by watching the key vanish from both nodes), and a failover still
costs 5–15 s of failing commands plus whatever Pub/Sub events were published
inside it.

Still only half the fix, and the docs say so in four places: on one host the
replica and all three Sentinels die with the machine.

### D44 — a preference, and the arithmetic that shaped it

D37 refused a *filter* and its consequence column already said premium
filtering, if built, arrives behind the queue-segment seam with its own recorded
decision. D44 is that row being followed, so D37 keeps its reasoning rather than
being struck through.

The distinction is behavioural and nothing in the type system expresses it:

```
filter      wait until a matching partner exists       -> holds a seat
preference  take a matching partner if one is in view  -> holds nothing
```

Three designs were tried and two were discarded in the building.

**Segmenting on the preference** would shatter one pool into a combination per
preference and make two people with different preferences unmatchable even where
both would have accepted.

**A boolean test** worked for gender alone and collapsed at three dimensions:
15% of one gender × 70% of one country × 20% of one vibe is two people in a
hundred waiting, and under one in forty. The failure would have been invisible,
because the fallback still works — a paying user simply has a preference that
never applies. Scoring replaced it: gender 4, country 2, vibe 1, highest wins,
longest-waiting breaks a tie, and zero *is* the ordinary candidate, so the
fallback stopped needing a special case at all.

**Passing the preference per attempt** survived one merge and then went. A skip
re-enters the queue carrying no profile and no preference, because nothing the
user asked for changed — so a per-attempt preference would have stopped applying
the instant somebody pressed next, which is the first thing they do. It lives on
the session hash now and `tryMatch` reads it in the `HMGET` it was already
issuing for the caller's own row.

Two things the tests caught rather than review. The wide sample overlaps the
ordinary one, so a blocked candidate walked by both passes was counted twice —
in the very counters §29.6 uses to decide whether the sample size is right. And
`,male,` matching inside `,female,` is why the list is comma-wrapped, with a
test named after it.

Country needed no new storage: it had already stopped being a declaration and is
resolved from `CF-IPCountry` at the upgrade with the client's value discarded,
which makes it the one dimension that cannot be misdeclared without a VPN.

`flirty` ships in the vibe list and is flagged in four places. The other three
describe a tone; that one declares an intent, and preferring on it means the
server pairing people on sexual intent with no age assurance anywhere in this
system. Personas never declare it (D-AI-11).

The cooldown and hourly budget are deliberately unbuilt: two weeks of real
numbers should set them. `assertCoherent` refuses a production start with the
preference enabled while `PREFERENCE_LIMITS_ENFORCED` is false, because the flag
is one environment variable and the person most likely to set it is the least
likely to remember two limits deferred a fortnight earlier.

### Measuring the product rather than the servers

Four series, and the reason they shipped before the feature they inform is that
none of them is recoverable after the fact.

`chat_conversation_duration_seconds{reason}` is the one that is not about
filtering at all. A three-second skip and a twenty-minute conversation were the
same event until now — one increment of `chat_matches_created_total` each — and
duration is the only number that separates them. Measured from the match row's
`createdAt`, returned by `endMatchInline` because after its `DEL` the row is gone
for everyone. An unknown start records nothing: a zero would land in the fastest
bucket and read as the strongest possible evidence the product is failing.

`chat_queue_composition` and `chat_profiles_declared_total` answer deliberately
different questions. The gauge is who is *waiting*, biased by how long each group
waits; the counter is who *arrives*, which nothing distorts. Their divergence is
the harm signal — a group matching far faster than it arrives is the first
evidence a preference is degrading the experience of the people it selects for,
and it is the number nobody instruments because it is not about the paying
customer.

### Four things found by working rather than by looking

* **CI had been red for a day.** `git ls-files --eol | grep -v 'w/lf' | grep -v
  'w/none'` means "anything that is not one of these two", and a binary file is
  neither — it reports `w/-text`. The first PNG committed with the new mark
  turned the step red and kept it red across three merges, printing an error
  that was true of a PNG and meaningless as a finding.
* **A fixture inherited a deadline meant for the code under test.**
  `pool.test.ts` sets a one-second statement timeout because that is what it
  tests, and `createPostgresContext` ran every migration on that connection.
  Three new index builds pushed it over on CI while it still passed locally, and
  the failure named the wrong thing: "Query read timeout" from inside `migrate`.
* **Two docblocks described a system that no longer existed.** The `GENDERS`
  note still said no matchmaking path reads it; `features.ts` still said filters
  were deferred because only the `default` segment exists. Both were made false
  by commits in this session, and both were fixed as their own commits — a false
  statement next to the code is the version a reader trusts most.
* **The prod compose would have refused to boot a correct Sentinel config.** It
  always injected `REDIS_URL`, so an operator who did the right thing would have
  been told to unset a variable the file was re-supplying underneath them.
  `${VAR:-default}` versus `${VAR-default}`, checked with `compose config`
  rather than reasoned about.

### The shape underneath all of it

Writing the nine new entries in `CLAUDE.md` together made something visible that
was not obvious one bug at a time. Nearly every failure here was the same thing
wearing different clothes: **something that looks configured, reports healthy,
and silently does not work.**

Sentinel forming a quorum and refusing to act. A CRLF check green-lighting
nothing. `SPOOL_BACKEND=redis` accepted and ignored, which this codebase already
knew about. Rate limits that parse and are read by nothing. A preference that
would have applied to nobody while the fallback kept every number looking
healthy. A spool record rescued into memory with no counter moving.

None of them throws. Each is discovered late, by someone who cannot connect the
symptom to the setting. That is what nearly every guard in this codebase exists
to convert into a startup failure, and three more were added here:
`PREFERENCE_WIDE_SAMPLE` must be wider, a half-specified Sentinel topology is
refused, and the preference cannot ship without its limits.

## Intent, flirty, saved connections, and a sign-in that is not for sale

Four features from `docs/product/FEATURE-INTAKE.md`, built in the order that document
set — 4, 3, 2 — plus the sign-in feature 2 needs. Everything here is off by
default and every flag refuses to start half-configured.

### D45 — intent replaces vibe, and "one selector" decided more than the UI

The brief was: intent replaces vibe, one selector, never shown, used only for
matching. The second clause turned out to settle a question the intake had not
asked, which is whether it is a premium dimension.

Two shapes were possible and they are not the same feature:

```
gender, country   asymmetric   a list: what I want a stranger to be
                               one party gets what they asked for,
                               the other is selected            -> premium

intent            symmetric    one value: what we are both here for
                               matched by EQUALITY against the
                               candidate's own declaration      -> free
```

One control means equality rather than list membership, which makes it
symmetric, and symmetry is what D37's objections attach to the absence of.
There is no selected party, so there is nothing to sell. `vibe` was the same
declaration pointed the wrong way: displayed to a stranger *and* charged for.

**Never shown is structural rather than promised.** `Profile` is defined as the
thing sent to the other side, so keeping intent out of it closes every path at
once — `readProfiles` reads a fixed field list, the `matched` payload is built
from `Profile`, `conversations.profile_a/_b` serialises one, the console column
renders one, and `validateProfile` cannot produce the key. A test sends
`{ name, intent, vibe }` and asserts the parsed profile has exactly four keys.

**Free is affordable only because intent never triggers the wide sample.**
Escalation is a second `SRANDMEMBER` plus up to `PREFERENCE_WIDE_SAMPLE` further
`HMGET`s. Most of the population will declare an intent, so counting it in
`anyPreference` would put that second pass on nearly every search in the system
to chase a dimension worth 1. There is a test named after it.

`setIntent` is deliberately not gated on `preference.enabled` and is its own
store method. Folding it into `setPreferences` is the obvious simplification and
would put a free feature behind a paid flag with nothing in the types to notice.
Every test in the symmetric-and-free block runs with no preference set, so that
simplification cannot pass review.

### D46 — flirty, and a correction worth recording

`flirty` was removed in the first pass and put back in the second, and the
reason is worth writing down because the mistake was mine and structural rather
than a change of appetite.

§29.9 refused `flirty` as a matching signal without its own decision. That
section was written against D44, where the third dimension was a preference
**list**: a user named what they wanted in a *stranger*, so `flirty` meant "find
me somebody flirty" and pointed outward at people who had not asked for it. That
is targeting, and it is what the section objected to.

Intent inverts the direction. `flirty` says what *you* are here for and scores
only against somebody who declared the same:

```
old (D44)   flirty-seeker  ->   anyone           targeting
now (D45)   flirty        <->   flirty only      routing
```

The objection is structurally gone rather than overruled — and I removed the
value on reasoning my own redesign had already invalidated, without noticing.

Routing also cuts the way nobody asks for: pairing flirty with flirty is what
keeps it *away* from somebody who chose `venting`, which is the most common
complaint about this category and something the pool has no mechanism against
today. Removing the value would not remove the population, only the signal that
sorts it.

**The residual risk is stated rather than argued away.** There is no age
assurance in this system yet; child safety relies on the age gate plus
reporting and moderation, and symmetry changes neither. Personas stay excluded
on a different ground (D-AI-11).

### D47 — a connection needs both sides, and no frame reports a refusal

Mutual consent is the obvious half. The half worth building carefully is that
nothing ever discloses a decision not to save:

```
you press          -> connection_state { saved: true }     to you only
both have pressed  -> connection_made                      to both, together
```

`connection_made` is the only frame that reveals anything about the partner, and
it is reachable only when that decision was to agree. The residual inference — a
conversation ending with no connection tells a saver the other side did not save
— is inherent to mutual consent, bounded to "they did not", and recorded rather
than discovered later.

**Both questions in one Lua script**, for the reason routing and dedupe are
(§10.17). As two round trips, both sides pressing at once could each read the
other as not-yet-saved and neither would see it complete. The field holds the
account id rather than a boolean, so a completed pair carries both ids out of
the script — no second read of two session hashes, and no window in which one
expires between the agreement and the lookup of who agreed. The script reads
before writing, so a repeat of the completing press returns `AGAIN` rather than
`MADE`; without that, every retry announces and both people are told they
connected several times.

**The table is the line `010_accounts.sql` named as the one to defend in
review**, and it is the table most likely to grow a `conversation_id` because
the natural description of the feature is "we met in conversation X". It has
none, and a test asserts the column list against the live schema. `created_by`
is absent for a subtler reason: it looks harmless, and it turns a symmetric
relationship asymmetric by answering who initiated.

Stored as a canonical ordered pair with `check (lo < hi)`. Two rows can
disagree; one unordered row needs every query to try both column orders. The
sort happens inside the Lua — the one place holding both ids at once — and the
repository re-checks it, because the constraint refuses an unsorted pair with a
message naming a column, which is a worse thing to read at three in the morning
than an error naming the invariant.

**Removal is unilateral and a hard delete.** Consent to connect is mutual;
consent to *stay* connected is not. Requiring agreement to leave would mean
somebody cannot stop being contactable by a person they no longer want to hear
from. A `removed_at` tombstone would keep a record of a relationship one person
explicitly ended, which is worse to hold than the connection was.

This write is allowed to wait on PostgreSQL and it is not a D16 violation.
Retention is a side effect of every message and a dropped record costs evidence;
a connection is a discrete act by two people who both pressed a button, at most
once per conversation, and a lost one is a broken promise they watched succeed.
It takes `report`'s shape, not `message`'s.

### D48 — sign-in, free, and one vendor behind one seam

Free was a decision, not a default. Signing in unlocks saved connections, recent
history and friend requests; none is a scarcity worth selling and all three are
the reason to hold an account. The `AuthModal` this replaces checked
`ACCOUNTS_ENABLED && PAYMENTS_ENABLED`, so sign-in required a subscription —
backwards, and it would have gated three free features behind a payment
integration that is switched off.

**`accounts.external_id`, never the primary key.** The obvious shape is to use
the provider's `sub` as `accounts.id`. Refused on the intake's own words —
"Cognito is the credential, not the account" — and on the fact that payments
reference `accounts.id`. Handing that key to a vendor defines a financial record
on a system this project does not control, and a provider migration rewrites
every foreign key rather than one column. The unique index is partial, or every
account without an external id collapses into one row.

**No JWT library**, because Node has verified a JWK natively since 16 and a
library would add a dependency tree and a CVE feed to save about forty lines.
That is also exactly where authentication bugs live, so what makes it acceptable
is that every check has a test for its **failing** case: `alg: none`, `HS256`,
another pool's issuer, another client's audience, expired, issued-in-the-future,
a replayed nonce, an unknown kid, no subject, four malformed shapes. A validator
nobody has watched reject a bad token is a validator nobody knows is running.

Three secrets cross the redirect and each stops one attack — `state` stops login
CSRF (an attacker's code in a victim's browser, ending with the victim's
connections in the attacker's account), `nonce` stops replay of a token captured
from any other sign-in on the same pool, and the PKCE verifier never leaves the
server. `SameSite=Lax` rather than `Strict`, because Strict is dropped on the
provider's redirect back and would break sign-in **only for the people who
completed it**, which is the worst possible distribution of a bug.

Scope is `openid email`, the email is verified and then dropped. The account
holds a subject and nothing describing a person, which keeps the Privacy
Policy's new data row one line.

### Verifying the wrong build, three times

The most useful thing in this session was not a feature.

Three separate rounds were spent debugging code that was correct, because the
thing being looked at was not the thing that had been built: a backend six
commits behind rejecting `react` as an unknown event; a vite dev server on
`:5173` reported as verification of a container on `:8081`; a container rebuilt
before the last two commits landed, serving copy that had already been deleted.

Every time the symptom read as "the code is wrong". Every time a grep of the
served bundle settled it in seconds. Both commands are now written into
`CLAUDE.md` rather than left to be re-derived, along with the reason a value
added to a closed protocol list is a **backend** change: the old validator
refuses the value and the refusal fails the whole `join_queue`, so it is not a
cosmetic mismatch that can wait for the next deploy.

The same underlying shape as everything else in that file — a stale bundle
reports healthy and passes its health check while serving last week.

### Four enumeration guards fired, and all four were answered

The script registry, the per-command rate-limit table, the migration table list,
and the metrics wiring check. Each one is the codebase demanding that a new
thing be declared deliberately rather than appearing. None was widened to pass.

Two design records were written after the code cited them: §31, §32, D47 and
D48 were referenced throughout the comments and did not exist. Dangling
references in exactly the place a reader goes to check whether a comment is
telling the truth.


## Phase 21 — the sign-in interface, and the port it hangs off

Phase 20 shipped the four `/auth` routes and nothing that could reach them. This
connects them, and most of the work was not the interface.

### Three gaps between "the routes exist" and "sign-in works"

None of them would have produced an error anybody could act on.

**nginx had no `/auth` location.** All four routes fell into `location /` and
were answered with `index.html` — a **200 carrying the SPA**, which is the worst
available failure for a route the browser is following a redirect into. A prefix
location now proxies them, geo-blocked with everything else on the reasoning
already written for `/ws`: signing in is a visitor action, so leaving it open
restricts nothing.

**Compose forwards environment explicitly and has no `env_file`.** `AUTH_*` in
`.env` alone is invisible to the container, and the failure is that the routes
are simply never registered. The comment above the payment block already stated
this rule; the auth block sits directly beneath it for that reason.

**`AUTH_*` was in neither `.env` nor `.env.example`**, though `config.ts` had
read it since phase 20. Documented now, empty, with the redirect URI's one
counter-intuitive fact stated where somebody will be standing when they need it:
it is **the origin the browser sees**, which is nginx on `FRONTEND_PORT`, never
the backend's own address — the backend publishes no host port in either compose
file.

That last point is why a local port change was a whole-origin change.
`FRONTEND_PORT` is what `AUTH_REDIRECT_URI` and the provider's registered
sign-out URL are built from, and every `ALLOWED_ORIGINS` entry has to carry the
same port or the upgrade is refused with a 403. Three things that must move
together, now noted in the README beside the table that used to imply the port
was cosmetic.

### `ACCOUNTS_ENABLED` is on, and the reasoning changed rather than being overruled

The deferral was written against §24's *anonymous accounts with premium
entitlements*, where the account was the thing being sold. §31 rebuilt it as the
opposite: signing in is free, it is OIDC so no credential is ever held here, and
what it gates is saved connections and recent history — things a person opts
into one at a time about somebody they already met.

The minor-safety position is unchanged and is **not** answered by this flag.
Child safety still relies on the age gate plus reporting and moderation, there
is no age assurance yet, and an account adds none: the provider returns a subject identifier and
nothing about who it belongs to.

### What the interface refuses to do

**Sign-in is a navigation, not a fetch.** `/auth/start` answers 302 to another
origin; `fetch` would follow it and hand back an opaque response, leaving the
person on our page while their browser quietly loaded somebody else's login form
into nothing. They have to *arrive* at the provider and look at the address bar.

**A sign-out is reported only when the server confirmed it.** A network failure
keeps the signed-in state and says so. Clearing it optimistically tells somebody
on a shared machine they have signed out while their credential is still live —
the one lie the client must not tell, and it now has a test named after it.

**`readSession` checks `=== true`, not truthiness.** A loose check reads
`"signedIn": "no"` as signed in, and the realistic route to that response is not
a malicious server but a proxy or an error page answering 200 with a body shaped
like something else — which is precisely what the missing nginx location was
producing an hour earlier.

**The header renders nothing until the first answer arrives.** Showing "Sign in"
and swapping it to "Account" is a flicker that states something false in
between.

**The `?signin=ok` marker is stripped as it is read.** Left in place it survives
a refresh, a bookmark and a shared link, so the page would announce a sign-in
that happened last week — or announce one to whoever was sent the link.

### The old modal was wrong in both halves

It was a magic-link email form gated on `ACCOUNTS_ENABLED && PAYMENTS_ENABLED`,
captioned "Only for premium subscriptions". The protocol is OIDC, so there is no
address to collect; and sign-in is free, so the payment flag would have hidden a
free feature behind a paid one — silently, since the surface would simply never
appear and the natural diagnosis is "sign-in is broken".

That coupling is now a **source** check rather than a value check, because the
property has to keep holding after payments are turned on, and at that point no
assertion over the constants can tell the two situations apart. It reads
`AuthModal.tsx` and `AppHeader.tsx` through a `?raw` import and strips comments
first, so the paragraph explaining the rule does not trip it — the shape the
`console.js` innerHTML guard already uses.

The copy names saved connections and recent history and **not** friend requests,
which are specified and not built. A list of benefits is a claim, and one
aspirational item makes the whole list untrustworthy.

## Phase 22 — connections become a product, and reconnect

Sign-in existed and unlocked almost nothing. This is the session that gave it
something to unlock, and most of it was found by using it rather than by
planning it.

### What shipped

* **Google sign-in in a popup**, straight past Cognito's hosted form via
  `identity_provider`, on the custom domain `<cognito-domain>`. The account
  chooser is forced every time — otherwise the provider silently reuses whoever
  is signed in on the device, which on a shared machine signs you in as the last
  person who used it.
* **A profile picture**, relayed by this origin and stored nowhere: the URL is
  cached in Redis under the session TTL, the bytes are streamed through
  `/auth/avatar`, and the browser never contacts the vendor.
* **Saved connections** with a list, removal, one-sided nicknames and online
  dots — plus a durable opt-out for appearing online at all.
* **Account-scoped blocks**: a signed-in person can see what they blocked and
  lift one, from any network, because an account id is the one stable identity
  and both block keys change.
* **Recent** — who you met this session, in `sessionStorage`, never on a server.
* **Reconnect**: ask somebody from Recent to talk again, answered with Chat,
  Ignore or Block.

### The decisions worth keeping

**Reconnect pairs people through the queue segment seam.** `chat:queue:{segment}`
had existed since day one with only `default` in it (R6, D23). A reconnect
writes a random `pair-…` lane on both sessions and ordinary `tryMatch` does the
rest — so blocks, bans and rate limits all apply with no reconnect-specific
code. The alternative, a bespoke pairing script, would have had to
re-implement the block check, and the failure mode of getting that subtly wrong
is somebody matched with a person they blocked.

**Asking is announced; refusing never is.** D47 said neither was. That half was
reversed deliberately (D49) because a silent request is indistinguishable from a
broken button, and the cost is written down: somebody who declines now learns
that this particular stranger wanted to connect. Ignore still sends nothing, and
there is no decline route at all, so a refusal cannot be disclosed by accident.

**Opting out means not being remembered.** Presence tokens are refused outright
for anybody who turned sharing off — no token, nothing stored, no dot, no way to
be asked. And a signed-out person's token resolves to a *session* rather than an
account, so it dies when they close the tab. Nobody signed out agreed to be
findable; that is the narrowest version of findable that still works.

**The child-safety position on re-finding a partner had to be restated.**
Accounts and friend requests shipped, which removed the premise it rested on. It
was restated rather than left standing: a specific
person can now be found again, but only by mutual agreement, and — the mechanic
carrying most of the weight — there is still no way to start a conversation with
a chosen person except through a request they can refuse.

### Four bugs that only two real clients could find

Each was invisible to unit tests because every piece was individually correct
and the pieces disagreed with each other.

**The searcher never got a presence token.** The two people are told about a
match by two different pieces of code — `lifecycle` publishes to the side
already waiting, `server.ts` builds a frame for the side that pressed Start —
and only the first carried the token. So half of every conversation recorded a
Recent row it could never act on, and which half depended on who had been
waiting.

**Signing in never reached the socket.** `accountId` is read from the cookie at
the handshake and nowhere else, and sign-in happens in a popup that deliberately
does not reload the page. An open socket therefore stayed anonymous forever:
friend requests pended, no token was minted, and the paths needing no account
kept working — which made it look like the feature rather than the session.

**The ask route trusted the client for routing.** It took a `from` field naming
the asking session, the client had nothing to put there and sent `"me"`, and
accepting set a lane on a session that did not exist. It was also a protocol
rule 3 violation: a caller who could name the asking session could have pushed
two other people into a conversation.

**A width clamp that produced no CSS.** `calc(100vw-1.5rem)` is invalid — the
minus needs spaces — so the declaration was dropped and the popover was never
clamped. The class was in the markup and in the bundle the whole time, which is
what made grepping the bundle so convincing. The lesson is one layer below the
stale-bundle trap already in `CLAUDE.md`: check the compiled stylesheet.

## Phase 23 — a stranger you can recognise, and four things found by using it

Nothing here was planned. Every item is something that only shows up once two
real browsers are talking to each other, which is why the section reads as a
list of small wrongnesses rather than a feature.

### What shipped

* **The generated nickname is scoped to the session, not the match** (D50). It
  was drawn per match, so two strangers who met twice saw different names for
  each other, and Recent filed everybody under a label its owner never used.
  Anyone who declared no name was unrecognisable by construction. The colour is
  still drawn per match, deliberately: nickname plus colour is a markedly more
  distinctive handle than either alone.
* **Recent shows the declared name.** It read `profile?.country` and never
  `profile?.name`, while the chat header has always read
  `profile?.name ?? nickname`. So the panel filed a conversation under a name
  its partner never saw. It renders by the same rule now, so the two cannot
  disagree again.
* **Auto-search keeps you in the chat shell.** It ended a conversation by
  returning to the landing screen and counting down there — the front door,
  heading, tagline and footer, between every pair of strangers.
* **The stranger menu is three actions and no prose**, and closes on a tap
  anywhere else, which it did not: it demanded a second tap on the same
  control.

### The reversal worth reading

D50 reverses the §24.3 rule that nothing may be stable across matches, and the
argument is not that the rule was wrong. What §24.3 forbids is a handle
somebody accumulates against a person over time. A session dies with the tab,
so what a stranger can accumulate is bounded by one visit — and nothing is
*derived* from an identifier, which is the property the original reasoning was
actually about. A kept random value is not a computable one.

What is given up is stated rather than argued away: two people matched twice in
one visit can now tell it is the same person. That is real, it is the whole
cost, and it does not survive the tab closing.

The collision case is where the design work went. Both sides now draw
independently, so the pair's by-construction distinctness is gone for the
nickname. The **arriving** side redraws — the waiting side has been using that
name with other people — and the redraw is **never written back**, or a
stranger could change somebody's name for every other conversation by colliding
with it on purpose. Both words are redrawn, so the answer to "Gentle Otter" is
never "Gentle Panda", which would imply a relationship between two strangers
that does not exist.

### Signing in ended the conversation, and nothing failed

Reported as "I signed in and lost the chat". The backend was innocent and was
proved so before anything was changed: a probe through nginx with two matched
sockets resumed the same session *and* restored the conversation.

`signIn(allowRedirect)` falls back to a full-page redirect when the popup is
blocked, and `AuthModal` gated that on `reason === null` — which asks *why the
dialog opened*, not *what navigating would destroy*. The two agree from Add
friend and disagree in exactly the case that costs somebody their conversation:
signing in from the header while talking to a stranger sets no reason, so the
redirect was allowed, the socket died with the page, and `RESUME_GRACE_SECONDS`
is 20, which does not cover a round trip through the provider.

The shape is the one this file keeps recording: a condition that is *correlated*
with the thing it should test, standing in for it, and being right often enough
that the gap only appears in one path.

### Copy that overclaimed, twice in the same slot

The landing screen's reassurance line has now been wrong twice. "Your profile
stays on this device" was plainly false against `conversations.profile_a/_b`.
Its replacement — "nothing you declare follows you from one conversation to the
next" — overstated more quietly: the browser re-sends the same declaration to
every stranger, so what does not follow you is anything the *server* keeps,
which is not what the sentence said.

A tagline holds the slot now, and the reasoning generalises. A claim in a
one-line slot has to survive every reading of it, and the privacy properties
here are true but need more room than that. Two other lines went for the
adjacent reason — they were the second or third statement of a fact already on
screen, placed after the point where they could change what anybody did.

### A vite dev server and a container, at the same time

Two builds were serving this repo at once — the container on 3001 and a
`vite` dev server on 5173 — while a report of stale copy was being diagnosed.
Both were current, and the answer was a cached page. The trap in `CLAUDE.md`
about verifying the served artifact has a second half: verify *which* artifact
the person reporting is looking at, before concluding anything about the code.

## Phase 24 — the two things that were configured and enforced nothing

Both halves of this session found the same defect twice, in different features,
and the shape is the one this file keeps recording: **a value that is written,
parsed, defaulted and read by nobody.** It is `SPOOL_BACKEND=redis` accepted and
ignored (F-006) each time, wearing different clothes.

### The preference limits (§29.4)

`PREFERENCE_COOLDOWN_MS` and `PREFERENCE_HOURLY_BUDGET` parsed, had defaults and
were read by nothing. They are what answers D37's targeting objection — the
existing limiters bound *flooding*, and a preference plus fast re-rolling is
*hunting*, which none of them touch. `assertCoherent` refused a production start
while `PREFERENCE_LIMITS_ENFORCED` was false, which is why they were never
quietly shipped.

`preferenceAllowance` is one Lua script: cooldown, then an hourly token bucket.
It has to be a script rather than a read and a write from TypeScript, because
two instances asking at once would each see room in the budget and each spend the
last token.

Three decisions inside it:

* **Keyed on the IP hash, read from the session's own row.** Every other limiter
  here keys on the session id, which is one connection — free to replace, and
  replacing it is the first thing somebody hunting would do without thinking
  about it. That is the dimension a block already uses (D18), and reading it from
  the row rather than taking it as an argument means no caller can name a bucket
  but its own. A session-keyed version would look identical, pass every test that
  does not reconnect, and bound nothing. `survives a new session on the same
  address` is the test that says so.
* **It degrades, it never refuses.** A refusal writes no preference, so `tryMatch`
  scores every candidate at zero and takes the longest-waiting — which is what a
  preference matching nobody already does (D44). Nothing reaches the client, and
  there is no frame that could carry it.
* **The cooldown runs from the last grant, and §29.4 said from a match ending.**
  The literal reading drops the preference for somebody who talked for twenty
  minutes and then pressed next, contradicting the same sentence's claim that it
  costs nothing in ordinary use. Grant to grant bounds a scan identically. §29.4
  was updated rather than left disagreeing with the code.

### The premium entitlement (D51)

The same defect, one layer up and worse: `accounts.premium_until` was written by
the payment webhook and read by **nothing**. Preferences were gated on
`FILTERS_ENABLED`, which is process-wide — so turning payments on would have
given the preference to everybody or to nobody, and paying would have changed
neither. The first person to find it would have been the first person to pay.

The fix that makes it verifiable rather than merely written: the column moved out
of the staged `011_payments.sql` into an applied `017_premium_entitlement.sql`.
With nothing purchasable, no account has a future deadline, so **the gate is
provably closed before anything can buy one** — and a test asserts exactly that.
Payments will start writing a column something already reads, rather than the
reverse.

PostgreSQL is the truth, Redis caches it for five minutes including negatives
(almost every account is a negative), and the value is copied onto the session
hash when a connection binds an account — so `preferenceAllowance` reads it from
the row it was already reading and a search touches neither PostgreSQL (D16) nor
an extra key. Checked **before** the two limits, or somebody without the
entitlement would spend a budget belonging to a dimension they are not being
given. It **fails closed**, because failing open would hand the paid dimension to
everybody for the length of a database outage — exactly when nobody is reading
the metric that would show it.

### What is still missing, and it is the matching half

**Nothing tells the client.** `/auth/session` returns `{ signedIn, avatar }`, and
`FILTERS_AVAILABLE` is compile-time. Once payments flip, a free user will see the
filter control, set a gender and a country, press Start, and have the preference
silently dropped — correctly, by the gate above, and invisibly, by design. The
server half is enforced and the client half does not know it exists. That is the
next piece of work and it is independent of every payment decision still open.

### Operations, all found by using it

* **Signing in from the header ended the conversation.** The backend was innocent
  and was proved so before anything changed: a probe through nginx with two
  matched sockets resumed the same session and restored the conversation.
  `AuthModal` allowed a full-page redirect when `reason === null`, which asks
  *why the dialog opened* rather than *what navigating would destroy*. The two
  agree everywhere except the one path that costs somebody their chat.
* **A stale tunnel hostname was a 403 on the WebSocket upgrade** with the page
  loading fine — a UI stuck on "Connecting". Quick tunnels mint a new hostname
  every start; a named tunnel on a fixed development hostname makes the four
  edits it used to need into a one-time change.
* **`www` now redirects to the apex**, because the two are different origins and
  the block token is host-only: somebody arriving on the other hostname is a
  different person as far as every block they have made is concerned.
* **Backups go to Cloudflare R2**, which reversed the India-only position: the
  free off-host destinations are not in the country. The cross-border transfer
  is disclosed in the privacy policy.

## Phase 25 — logs in Grafana, and the leak that was found on the way

`docs/testing/OBSERVABILITY-AND-TESTING.md` is the contract for this and the eight
phases after it. The short version of why it exists: the operator's questions
were answered well and the founder's were not answered at all, and two of the
three observability pillars did not exist.

This phase is the first: log lines that outlive the container that wrote them.

**What shipped.** Loki 3.5.1 and Grafana Alloy v1.10.0 in `docker-compose.yml`,
a provisioned Loki datasource pinned to `karobakbak-loki`, and a
`karobakbak — logs` dashboard with volume, level, edge status, edge latency
percentiles and two log panels. Alloy reads container stdout through the Docker
API rather than through the Loki logging driver, because that driver sits in the
container start path and a Loki that is down would become containers that will
not start. `service` and `level` are labels; `msg` deliberately is not.

Alloy rather than Promtail because Promtail is end-of-life.

**Retention is 7 days, and shorter than the conversation window on purpose.**
Conversations are kept 30 days because an investigation needs them; logs are
kept 7 because an outage is diagnosed in hours and a log store is not evidence.
It matches `PROMETHEUS_RETENTION` so the two halves of an incident do not expire
at different times. `compactor.retention_enabled` is set, without which the
period is a number nothing acts on.

**F-036, found by running it.** Before shipping anything into Loki it was worth
asking what was on stdout. `frontend/nginx.conf` set no access log format, so
the container used the stock `main` — which writes `$remote_addr` and
`$http_x_forwarded_for` (the visitor's IP, twice) and `$request` (the raw
request line **including the query string**). `location /auth/` proxies the OIDC
callback, so every completed sign-in had been writing an authorization code and
its CSRF state into an access log.

Verified rather than reasoned about, against the running stack, and the log line
is quoted in `docs/testing/BUGS.md`. The privacy policy says of the raw address that "it
never appears in our logs" — the application honours that scrupulously and the
edge in front of it did not. No `logging:` block is set anywhere in
`docker-compose.yml`, so those lines were already on disk under the default
`json-file` driver with no rotation. Shipping them would have turned a latent
problem into a queryable one.

The fix is at the source: a `kbb_access` JSON format using `$uri` rather than
`$request` — so the credential cannot be expressed by the format at all — and no
client-address variable in it, absent rather than redacted. `$upstream_addr` is
kept, because which replica answered is the most useful thing an access log
carries here. User-Agent, Referer and `CF-IPCountry` are dropped, each for a
stated reason; `$geo_blocked` replaces the last of those, answering the
operational question without recording where anybody was.

**The second control is a detector, not a redactor**, and that is the decision
worth remembering. `scripts/verify-log-hygiene.mjs` reads back what reached
Loki and fails on an address literal, a credential-shaped `name=value`, or any
of `logger.ts`'s denied field names as a JSON key. A redaction stage in the
shipper was rejected because it would make a future failure of `logger.ts` or of
the nginx format *invisible* — the lines would arrive clean and the broken
control would go undiscovered. It reports findings as a truncated SHA-256 rather
than quoting them, because a tool that reports a leak by printing it has copied
the leak into CI output.

**Three things got written wrong first, all caught by running them.** Alloy's
`stage.replace` replaces the *captured group*, not the whole match, so the first
scrub emitted `${1}REDACTEDLEAKEDCODE9` — redacted at a glance, secret intact.
The detector's first run reported the WSL2 kernel version `6.6.87.2` as two
leaked addresses, because a four-part version number and an address are the same
shape. And `| json` in the latency panel promoted every field to a label
including the per-request `conn`, splitting one percentile into seven useless
series.

A fourth was the control-character trap in `CLAUDE.md` firing on new code: the
grouping key in the detector reached the file as literal NUL bytes, which turned
the script into a binary file to git and grep — and made a space-splitting bug
work by accident. The key is JSON now, with no separator to choose wrongly.

## Phase 26 — the product deck, and the metrics that were never there

Phase 2 of `docs/testing/OBSERVABILITY-AND-TESTING.md`. The founder's questions — is
anybody using it, does the product work — had no instruments at all.
`backend/src/accounts/` wrote **no metrics**, and neither did `payments/`, so
phases 20 to 24 shipped entirely unlit: sign-in, connections, presence,
reconnect, avatars and the premium entitlement were unobservable from the
running system.

Fifteen series drafted, thirteen shipped. Two were removed during the work and
the reasons are the useful part.

**The funnel is per search, not per session or per socket.**
`chat_funnel_total{step}` covers `searched`, `matched`, `spoke`, `conversed`.
The first draft opened with `connected`, which was wrong in exactly the way the
design document complained about: `chat_connections_total` counts a socket
(including a resumption), `chat_matches_created_total` counts a *match* — one
per pair, so half the people — and a ratio across those is a ratio across three
denominators. All four steps are now one unit, so the funnel is monotonic on one
population.

**Conversation quality is measured per side, and that was a real design fork.**
Counting a *conversation's* messages needs either an `HINCRBY` on the message
hot path or a wider positional reply from `endMatch`, which is shared machinery
around the most race-tested code here. Neither is worth it for a metric. Each
instance counts the sessions it holds, so `chat_conversation_messages` is exact
under summing — and it is the better measurement anyway: the two sides apart say
something the total cannot, because one side at zero is somebody being ignored.

`metrics/conversation.ts` holds the tally. It is flushed when a session matches
again or when its socket closes, **not** when the conversation ends — a
conversation ends once, reported by whichever side won the race (D6), so hanging
the observation there would record one side of some conversations and neither
side of others.

**`chat_preference_applied_total` needed no Lua change**, which was the
pleasant surprise. `tryMatch` already returns the score, and the score is a
bitfield by construction — gender 4, country 2, intent 1 — so the dimensions
decompose out of a number the script already hands back. This is the honest
answer to "does premium do anything": §29 warns that a preference matching
nobody is invisible because the fallback still works, so a paying customer would
simply have a preference that never applies. `preference_limited` says it was
refused; this says it was applied and won.

`product-metrics.test.ts` reads the weights **out of the Lua source** and
asserts they match. Without it, re-tuning the weights — which §29.8 explicitly
anticipates, calling them a decision rather than a constant — would leave the
decomposition running and attributing matches to the wrong dimension, with
nothing failing. Confirmed to fail on a deliberate one-digit drift rather than
assumed to.

**Two metrics were removed rather than shipped, and both removals are the
phase's actual content.**

`chat_connection_requests_total{outcome}` was in the design document and is not
here. The `connectionsMade` comment in the registry already recorded the
decision, written before this phase existed: a count of one-sided saves is a
measure of how often somebody was not saved back, and publishing it turns a
private refusal into an operational statistic. The design document proposed
exactly what the code had already refused. The same reasoning removed
`declined`/`ignored` from the reconnect labels, and then removed `blocked` too —
a request stopped by a block is the block working, blocks are already counted,
and a per-attempt count of them is a refusal statistic wearing a technical name.
What is counted is successes and faults, never the space between them.

`chat_accounts_online` was dropped for a duller reason: visibility lives in
`chat:online:{account}`, one key per account with its own TTL, so counting it
means a `SCAN` of the keyspace every janitor tick. `chat_connections_active`
already answers the neighbouring question. The gap is documented in the registry
so the next person to notice it finds the reasoning rather than the hole.

`rate_limited` came off the reconnect failure list on the same principle applied
to a smaller thing: nothing rate-limits those routes, so the label could never
fire, and a label permanently at zero is a small lie on a graph.

## Phase 27 — cost, and the harness that had been lying for six days

Phase 3 of `docs/testing/OBSERVABILITY-AND-TESTING.md`. Nine cost categories in the
plan, exactly one instrumented (persona LLM spend). This covers four more and
makes the arithmetic live rather than a spreadsheet.

**cAdvisor, `redis_exporter` and `postgres_exporter`** answer what the
infrastructure is doing. `chat_ws_bytes_total{direction}` answers egress from
inside the application, because cAdvisor's interface counters would bill every
Redis round trip and every Pub/Sub publish as though it had left the host — and
on this architecture that is most of the bytes.

**The price model is exported as gauges and multiplied by recording rules**
(D62), the pattern `chat_report_response_target_seconds` already uses: a rate
that lives in a dashboard query drifts the first time somebody changes one of
nine copies. `kbb:cost_dollars_per_conversation` and
`kbb:cost_dollars_per_month:projected` come out of the same expression as the
usage they divide, so they cannot disagree with either the running system or
the pricing decision.

**One unit throughout: micro-cents of US dollars.** Not a preference.
`MODEL_PRICES` is written with a `dollars()` helper, so persona spend is USD
micro-cents whatever else happens, and an infrastructure price in any other
currency would be summed with it by a recording rule, silently, producing a
number that is neither. Prices are read as decimal dollars — how an invoice is
written — and converted once in `loadConfig`.

**Every price defaults to zero, and zero means unpriced rather than free.** A
plausible default is the same mistake as plausible-looking detail in a policy
document: believed, wrong, and nothing says so. `chat_cost_model_configured` is
published beside them so a panel can say "no prices configured" instead of
rendering a confident $0.00/hour, which is the same lie reached from the other
direction.

**Two things were wrong and running the stack found both.**

The rules multiplied *used* CPU by a vCPU-hour price. That is wrong for the
deployment this project actually describes — the cost plan's Scenario A is "1
modest VM", which costs its full vCPU count whether the process is busy or idle,
so the figure would have dropped overnight while the invoice did not move. It
uses `machine_cpu_cores` now, with utilisation kept as a separate series that is
never multiplied by a price. The modelling error surfaced because cAdvisor on
Docker Desktop sees only the root cgroup and emits no per-container series at
all, so the original selector returned nothing.

`chat_ws_bytes_total{direction="in"}` read a flat zero while `out` showed 133kB.
`ws` delivers a **Buffer** unless the socket is created with `{ binary: false }`,
and the first version guarded on `typeof raw === 'string'`. A counter that is
present, plausible and permanently zero is precisely what
`metrics-wiring.test.ts` exists to prevent — and it cannot see this one, because
it checks that something *writes* the metric, not that the write is reachable.

**F-037, found by accident and the most useful thing in the phase.** A swarm run
failed the profile oracle on 80 of 184 declarations. Bisecting to `6072f7a`
reproduced it before either of this session's phases, and the last passing run
predates `c043479` — *"country comes from the connection, not from a dropdown"* —
by two days. The product is correct: it discards a client-declared country and
resolves it from `CF-IPCountry`, which is the entire point of that change. The
swarm declared a country 48% of the time and sent no such header.

So the harness had been two days out of date, red for six days, and reporting a
product bug with a plausible count attached. The fix sends the header rather
than dropping country from the hash — excluding it would have gone green and
made a genuine country-crossing bug invisible. 80 failures became 1, and a
30-bot rerun passed outright. The remaining one is recorded in `docs/testing/BUGS.md`
rather than chased.

This is exactly the gap §2.5 of the observability design names: 130 run
directories, no baseline, no comparison, and nothing that would notice. Phase 33
is where that stops being true.

## Phase 28 — four decks, and a safety label that was written by nothing

Phase 4 of `docs/testing/OBSERVABILITY-AND-TESTING.md`. Phases 26 and 27 built the
metrics; this is where they become something to look at. Four dashboards,
because four different questions want four different default ranges and four
different readers, and one dashboard serving all of them serves none.

**Product** (7d), **cost** (30d), **safety** (24h), and the **health** deck
completed with the database, spool and persona rows it never had. Coverage went
from 23 of 89 declared metrics to **89 of 89** — every declared series now
appears on a deck or in a rule, and every one of the 79 dashboard targets was
executed against a live Prometheus rather than assumed to parse.

Five alert rules were added: three product, two cost. The cost pair fire on
**rate of change and never an absolute figure** (D56) and are gated on
`chat_cost_model_configured`, so an unpriced deployment — which is the default —
can never fire them.

**F-038, and it is the reason this phase was worth doing carefully.** The
registry describes `chat_profiles_refused_total{reason="age_below_minimum"}` as
"people who told this service they are under 18", calls it a safety signal and
an input to the minor-safety work security §24 requires before launch. Nothing
wrote it. `AGE_BELOW_MINIMUM` is raised inside `parseClientFrame`, so every
under-18 declaration was landing in
`chat_invalid_frames_total{reason="invalid"}` pooled with malformed JSON.

A documented dead *label* is worse than a dead metric. A dead metric is an empty
graph; this was a comment asserting that a number the policy work depends on was
being collected. It is counted now, at the one place the refusal is visible to
anything that can count it, and it remains a protocol strike — that part is
unchanged and deliberate.

`metrics-wiring.test.ts` grew a guard for it. The first version passed with the
write site deleted, because the value also appears in a **type annotation** —
`profileRefused(reason: 'age_below_minimum')`. A guard a type satisfies proves
nothing, which is the same mistake as the dead label one level up. It matches a
complete call argument now, and it was watched failing before being kept.

**Four safety series did not exist at all until the thing they count happened.**
`chat_profiles_refused_total`, `chat_blocks_total`, `chat_rate_limited_total`
and every `chat_retention_dropped_total{class}` were absent from a live scrape —
the exact failure `REJECT_REASONS` records about `'banned'`, repeated across
most of what a safety dashboard is made of. `retention_dropped` mattered most: a
`p0` series appearing for the first time is safety evidence being lost, and
until then the panel showed no data, which is indistinguishable from a healthy
run. All are zero-initialised now.

**One series is deliberately *not* zero-initialised**, and the panel says so.
`publishBacklog` refuses to publish a sample that has never succeeded, because a
zero backlog from a monitor that could not read the database is the most
reassuring thing this process could wrongly claim. Empty means "never sampled",
not "nothing overdue".

**`le="0"` is stored as `le="0.0"`.** The bounce panel — matched, nobody spoke —
returned nothing while the raw scrape plainly showed `le="0"` with a count of 9.
Prometheus normalises the bucket boundary on ingestion, so an exact match on
what the scrape emits is silently empty. A regex fixes it and PromQL rejects the
escape (`\.` is not a valid string escape), so the panel carries an `or` across
both spellings. Same family as the stale-bundle trap: the artifact that was
served and the artifact that was stored are different things, and only one of
them answers the query.

The swarm's spurious Windows worker death (handoff trap 35) appeared for the
**third** time during this phase and again did not reproduce on re-run.

## Phase 29 — traces, and three ways the safety control was wrong before it was right

Phase 5 of `docs/testing/OBSERVABILITY-AND-TESTING.md`, and the one the design document
called the highest I8 risk in the plan. It earned that description: three
findings came out of it, and two of them were mistakes in the control itself
rather than in the thing it was guarding.

**What shipped.** OpenTelemetry with four chosen instrumentations rather than
the auto bundle, a `ScrubbingSpanProcessor` sharing `logger.ts`'s field list
(D52), `db.statement` disabled at the instrumentation (D53), Tempo with 48-hour
retention, a pinned Grafana datasource, and `tracing.test.ts`. `TRACING_ENABLED`
ships **false**.

**`FORBIDDEN_FIELDS` moved to `redaction.ts`, unchanged**, and both the logger
and the span processor import it. The check that the move was mechanical is that
`logger.test.ts` passes untouched — it does.

The span check is segment-wise rather than exact, because span attributes are a
flat map of dotted keys while the logger walks a nested object: the same field
names arrive in a different shape, and a check written for one does not catch
the other. `chat.message.body` and `report.note` are caught without anybody
predicting the namespace.

**F-039 — the instrumentation-level control did not cover the attribute the
library actually sets.** `enhancedDatabaseReporting: false` governs
`db.statement`; `instrumentation-pg@0.74` also writes `db.query.text`, on every
span, and that option does not suppress it. Nothing failed and nothing warned.
The only reason it is in `docs/testing/BUGS.md` rather than in a tracing backend is that
the second control caught it — which is the argument for D52 and D53 being two
controls rather than one, made by events instead of by reasoning.

Being exact about severity: `db.query.text` is the *parameterised* statement,
not the parameter values, so it was the shape of the query leaving the boundary
rather than message content. Denied anyway — a query built without parameters
would carry values in that same attribute.

**F-040 — the scrubber crashed the service it was protecting.** It copied the
logger's throw-outside-production rule. `SpanProcessor.onEnd` is called
synchronously from `span.end()`, inside the operation being measured, so the
throw propagated into the database call. Combined with F-039, which meant every
query carried a denied attribute, the backend went into a restart loop on its
first query and the thing crashing it was the safety control.

A log call is application code and a test can wrap it. A span processor is a
callback a vendor invokes from inside somebody else's call stack. Redact always,
report loudly, never throw in a running process — and `strict` survives only
because the test asserts refusal directly.

Underneath that, a second problem: the violation was reported per span, an error
line per database operation. Deduplicated by attribute key now. An operator
needs to know *that* an attribute is denied, not how many times; the verifying
run logged it exactly once.

**F-041 — tracing started from `index.ts` instrumented nothing.**
`registerInstrumentations` patches a module by replacing its exports, and `pg`
and `ioredis` are already imported by the time an async `main()` runs. The
comment written at the time claimed the cost was "a small number of early
spans". It was every span. Tempo received zero from a stack that logged no
error, was reachable, and accepted OTLP when poked by hand.

The fix keeps the original property — a process with tracing off never loads the
SDK — by *ordering* rather than by placement: `preload.js` reads
`TRACING_ENABLED` from the raw environment and only then `require`s anything
OpenTelemetry. A top-level `import` would be hoisted and defeat it.

**One design correction found while verifying.** `requireParentSpan: true` on
`pg` traces only queries inside an already-traced request, which sounds like
noise control and removes the only thing worth watching: the write-behind
retention path runs on a timer with no parent, so the subsystem `DESIGN.md`
makes its strongest claims about produced no spans at all. It is `false` for
`pg` and stays `true` for `ioredis`, which is on every heartbeat.

**What is not traced, stated rather than papered over:** the WebSocket message
path. A socket is one HTTP request that never ends, and instrumenting the hot
path of a chat server for observability is a cost this phase did not take. So
tracing answers the HTTP routes and the retention path; the cross-instance
conversation flow is still read from metrics and logs.

Verified end to end: Grafana queries Tempo through its own proxy and returns
`pg.query:BEGIN / INSERT / COMMIT` traces from the write-behind path, with both
backends healthy and the scrubber's single log line naming `db.query.text` and
no value.

## Phase 30 — payments proved against a real database, and the gate watched being closed

Phase 6 of `docs/testing/OBSERVABILITY-AND-TESTING.md`. The paid tier had unit coverage
on three files and had never touched a database, so the thing the money is
actually for — an order becoming a row, a capture becoming an entitlement, and
`accounts.premium_until` becoming the deadline matchmaking reads — had never
been executed.

**`tests/integration/payments-e2e.test.ts`, eleven cases against real
PostgreSQL.** The grant, the renewal that must *extend* rather than reset (the
bug that gives away a year to whoever pays twice), the refund that takes the
time back without driving the deadline into the past, and the abuse set: a
capture delivered five times granting once, an order that does not exist, a
short amount, an over-amount, and a body signed with the wrong secret. A payment
webhook is an unauthenticated endpoint that grants entitlements, so those are
not extras.

**The schema is staged, and the test says so rather than working around it.**
`011_payments.sql` lives in `migrations-pending/` because turning payments on is
a commit with document changes in it, so the suite applies it itself in
`beforeAll`. Its number looks wrong beside an applied set that runs to 017 and
is not: it depends only on `accounts`, which `010` creates, and `migrate()`
tracks by filename rather than by ordinal — checked rather than assumed, and
then left alone.

**Two things the catalogue taught by failing.** The product is
`premium_1_month`, not `premium_month`; and `verifyWebhookSignature` returns a
*verdict* (`valid` / `invalid` / `malformed` / `unconfigured`) rather than a
boolean, because "no secret configured" is not the same answer as "this
signature is wrong" — collapsing them is how a deployment that forgot the
variable ends up accepting anything. An unknown product also returns
`amount_mismatch`, which is what made the first failure read as a pricing bug.

**The entitlement gate was watched being closed, at scale.** `FILTERS_ENABLED`
is on in the load stack now and payments are off, so a 40-bot run produced:

| | |
|---|---|
| `chat_preference_limited_total{reason="not_premium"}` | **101** |
| `chat_preference_applied_total` (all three dimensions) | **0** |
| `chat_preference_widened_total` | **0** |

CLAUDE.md claims the gate "is provably closed while nothing can be bought".
That was a unit assertion; it is now a measurement under load. The positive half
— a live entitlement granting a preference — is
`preference-limits.test.ts` → *grants one that is still live*, so the pair is
covered without the load stack needing an OIDC provider it does not have.

**Payments stay off in the load stack and the reason is written down where
somebody will hit it.** Turning them on needs Razorpay test keys, which are
deliberately absent from a committed file, *and* the staged migration —
`npm run payments:migrate:loadtest`. Without the second the routes exist and
every order fails, which reads as a broken integration rather than a missing
table.

**`features.ts` was not touched.** Its two constants are compiled in and ship to
production, and the comment on them says turning one on is a commit. Flipping
them here would have put payments into any production build of `main` while
`docs/policies/PENDING-PAYMENTS.md` is still unapplied — which is precisely the
half-applied state `verify-pending-policy.mjs` exists to catch. The browser
purchase path therefore remains unexercised, and that is stated rather than
quietly skipped.

**F-037's open residual got much better characterised**, by accident. Seed 33
returns **exactly 8 failures out of exactly 130 declarations** on three
consecutive runs — with filters on, with filters off, and with tracing off. So
it is deterministic per seed rather than a race, neither of this session's
features causes it, and it now has a one-line reproduction. A race would have
varied across those three runs; this picks the same bots every time.

## Phase 31 — the security suite, and what it found by measuring rather than asserting

Phase 7 of `docs/testing/OBSERVABILITY-AND-TESTING.md`. Three of the four axes shipped;
the fourth is deliberately partial and said so below.

**`security-test/` — eleven live probes against a running stack.**
`npm run security:probe`. Nine pass, one measures, one skips without a console
origin. It is not a scanner and does not try to be: it asks the short list of
questions this system's own design documents say matter, which a generic tool
cannot know to ask.

**The flagship probe measures rather than asserts, and that is the design.**
`upgrade.test.ts` already proves `clientAddress()` counts hops correctly at
every value. What no unit test can prove is that the *configured* count matches
the *deployed* chain — that is a fact about topology. IDENT-1 asks it through
`MAX_CONNECTIONS_PER_IP`, which is the cheapest observable keyed on the derived
address, and the load stack answered precisely:

```
one forged address x60:        40 opened, 20 refused
distinct forged addresses x60: 60 opened,  0 refused
```

40 is exactly `MAX_CONNECTIONS_PER_IP`. So the header is trusted there — which
is **correct** in the load stack, because that is how each bot gets its own
identity, and would be a serious hole in a deployment where nothing in front
overwrites it. The probe reports the measurement and leaves the judgement to
whoever knows the topology; an `INFO` verdict never fails the run, because
turning a measurement into a verdict is how a check ends up behind `|| true`.

Production was then checked against it and is consistent, and
`docker-compose.prod.yml` refuses to start without `TRUST_PROXY_HOPS` *by name*.
Every proxy added in front, Cloudflare included, changes the right value, so it
is measured on the deployed chain rather than derived.

**Nine passes, including four that had never been checked from outside**: the
five security headers present on three different paths (nginx replaces rather
than merges `add_header`, so a location added without the include loses all of
them silently); the CSP forbidding inline script, framing, objects and a base
tag; `/metrics` returning 404 at the edge; and the sign-in callback not
reflecting its own authorization code into the body — the response half of
F-036, whose log half `verify-log-hygiene.mjs` already covers.

**`validate-fuzz.test.ts` — six properties over about 13,000 generated
frames**, seeded so a failure is a reproduction rather than something that
happens once on CI and never again. The property is deliberately weak and
absolute: `parseClientFrame` **returns**. A throw there is not a refusal, it is
an exception on the frame path, and `connection.ts` calls it inside
`handleFrame` — so a throw is an unhandled rejection on a socket belonging to
somebody who did nothing wrong.

Control characters are built from `String.fromCharCode` and never typed, which
is the same defence `hasForbiddenControlChar()` uses and for the same recorded
reason.

**Supply chain in CI, as its own job.** `npm audit` gated at `high` and
`--omit=dev`; a full audit reported without gating; gitleaks over full history;
and a lockfile-drift check. The thresholds are chosen so the gate stays read: a
vulnerability in a test runner does not ship and cannot be reached by a request,
and treating it like something in the process holding every WebSocket file
descriptor is how an audit gate gets disabled within a month.

**The fourth axis is partial, and this is the honest accounting.** ZAP and
nuclei were not added. What they are actually for here is stock
misconfiguration and header hygiene, and EDGE-1 through EDGE-4 cover that
surface directly with checks that know what this system's headers are supposed
to say. What is genuinely missing is the breadth a scanner brings — the checks
nobody here thought of — and that remains open rather than being claimed.

Also still unexercised: the console authorisation matrix, which skips without a
`--console` origin because the console does not run in the load stack. The probe
exists and is ready for the first run that starts one.

## Phase 32 — the P group, all 28 rows, and two discrepancies it was built to find

Phase 8 of `docs/testing/OBSERVABILITY-AND-TESTING.md`, partially. This closes the
protocol-abuse group and states plainly what it does not touch.

**`tests/integration/protocol-abuse.test.ts` — 27 tests covering all 28
catalogued P rows.** The group had been catalogued since the load-test document
was written and had **zero** implemented rows.

They run against a live server rather than against `parseClientFrame`, and the
split is why: about half are validator decisions and the other half are
interactions the validator cannot see — an oversized frame never reaches
`handleFrame` because `ws` closes with 1009 before the payload is allocated, the
strike counter lives on the connection, `NOT_MATCHED` versus `ALREADY_MATCHED`
is session state in Redis, and message-id dedupe is scoped to a match by the
pipeline. Splitting them by mechanism would have organised the tests by
implementation detail rather than by the thing being defended.

They are also **integration tests rather than swarm rows**, which is a
deliberate move away from where the catalogue put them. These need one client
each and a specific expected refusal — no load at all — so they belong somewhere
that runs on every push rather than when somebody remembers to start a stack.

**Two catalogue-vs-code discrepancies, which is what the group exists for.**

*F-042*: `{"hello":"world"}` is answered `UNSUPPORTED_VERSION`, not
`BAD_ENVELOPE`. The object check passes — it *is* an object — so it reaches the
version check with `version` undefined. A client sending structural garbage is
told to fix its protocol version.

*F-043*: `join_queue` while already matched produces **no frame at all**. The
branch is right for the case it was written for (a peer won a race, so a
`matched` frame is already inbound) and wrong for a deliberate re-join, where
nothing is inbound and the client waits forever.

Both are asserted as they behave and recorded rather than changed. An error code
is part of the wire contract, and inventing or reordering one is a protocol
decision, not a test fix.

**Five of the seven initial failures were the test, and each taught something
about the protocol**: the content-type field is `type`, not `contentType` (so
`contentType: 'image'` exercises P26's ignore-unknown-fields rule and is
correctly delivered as text); `typing` requires `active`; `abuse` is not a
report category; the state check runs before content-type dispatch, so P10
cannot be tested from an idle session; and P22 needs the skip's own reply
awaited or the message races the teardown it is supposed to follow.

**What this phase does not cover, stated rather than implied.** The R group
(races, 0 of 15), the D group (data integrity, 0 of 10, including the D17
retention-deadline check that defends a privacy-policy claim), the E load
shapes, and the remaining chaos rows — Sentinel failover under load, C3
graceful shutdown, C4 partition, clock skew, memory pressure. Sentinel is the
most valuable of those by a distance: every matchmaking transition lives in
Redis and a failover with traffic on it has never been watched.

## Phase 32b — Redis failover, with the application on it

The most valuable thing left in the plan, and the one `DESIGN.md` makes the
largest unverified claim about. Every matchmaking transition lives in Redis and
`/ready` is derived from Redis health alone, so D13 rules out Cluster and names
replica failover as the answer. `docker-compose.sentinel.yml` and
`operations/OPERATIONS.md` §17 have drilled that since it was built — and drilled **Redis
alone**. Nothing had ever put traffic on it and watched.

**`docker-compose.sentinel-app.yml`** puts the application on the Sentinel set,
kept separate so the rig stays a rig: somebody drilling Redis on its own gets
the same three containers they always did. `npm run sentinel:up`,
`sentinel:status`, `sentinel:failover`, `sentinel:restore`, `sentinel:down`.

**The result, 60 bots over 120 seconds with the primary stopped at about 50.**

| | |
|---|---|
| Sentinel promoted the replica | yes, master moved to `172.31.240.12` |
| Backend restarts | **0**, both instances |
| Redis unavailable for | **~11.2s** |
| Conversations | 113, **346 message positions agreed** across all of them |
| Conversations reclaimed by resume | 2 |

**Conversations survived a Redis failover.** The pair-reconstruction oracle
compares both sides of every conversation, and it passed. That is what D13
claims and it had never been demonstrated.

The ~11 seconds is the number to plan around and is roughly what the
configuration asks for: `down-after-milliseconds` is 2000, so a primary must be
unreachable for two seconds before anything is declared down, and promotion plus
client rediscovery follow. During that window `/ready` reports not-ready on
**every** instance at once — correct, and it means a load balancer sees the whole
service leave and return rather than one node failing over.

Two log lines to expect and not panic at, both transient:
`connect ECONNREFUSED` on the old primary's address, and `All sentinels are
unreachable. Retrying from scratch` — which reads far worse than it is. That is
ioredis during the promotion window, not a topology that has lost quorum.

**One compose limitation left visible rather than worked around.** An override
can add and change services but cannot remove one, so the single-node `redis`
from `docker-compose.yml` still starts and nothing talks to it. The alternative
was a fourth compose file duplicating every application service, which would be
a copy of the deployment that drifts from the real one — a worse problem than an
idle container.

**The only oracle failure was F-037's residual**, 9 declarations, unrelated to
failover and already known to be deterministic per seed.

Still open from phase 32: the R group, the D group including D17, the E load
shapes, and C3/C4/clock skew/memory pressure.

## Phase 32c — D17, and the rest of the retention rows

The D group's most important row, because it is the one that defends a
*published* claim rather than an internal invariant.

The privacy policy says conversations are kept thirty days and then deleted.
`DESIGN.md` D17 says the deadline is stamped at insert time and never computed
at deletion time. `repositories.ts` opens with a comment saying the same. **None
of it had ever been executed.**

The difference is not academic. If expiry were derived at deletion time from
whatever configuration currently says, editing one environment variable would
silently extend the life of every conversation already stored — including the
ones belonging to people who were told thirty days. A promise broken by a
deploy, with nothing anywhere reporting it.

**`tests/integration/retention-integrity.test.ts`, six cases.**

*D10 / D17* writes a row, then builds a second `Repositories` over the **same
database** with a ten-year window — which is exactly what a deploy that edited
one variable does, since the repository is the only thing that knows the window.
The new row gets the new window; the old row is untouched.

*The structural half*: `retention_expires_at` has no column default. A
`default now() + interval '30 days'` would satisfy every other assertion here
and would move the moment somebody altered the table, so the absence of a
default is what makes the value provably the application's.

*D5* — a report extends retention and, because of the `greatest`, a second
report can never pull a deadline back in. Two people reporting the same stranger
is the ordinary case, not an edge one.

*D9* — the boundary. `retention_expires_at < now()` means a row at its deadline
survives and one a second past it does not. Off by one deletes evidence a day
early or keeps it a day late, and both are things somebody would eventually have
to explain. And a row on legal hold is past its deadline and still present,
which is the mechanism §8 depends on and is one `and` away from not existing.

**The D10 assertion was watched failing before it was kept.** A temporary
`update messages set retention_expires_at = now() + interval '3650 days'`
inserted into the test made it fail and nothing else; removing it made it pass.
A test that has never rejected the thing it exists to reject proves nothing.

Still open from phase 32: the R group, the remaining D rows (D1-D4, D6-D8), the
E load shapes, and C3/C4/clock skew/memory pressure.

## Phase 32d — the R group, and a coverage table that was wrong

Four catalogued race rows that had no test, plus a correction to the record.

**The catalogue said the R group had "0 dedicated" coverage and that was not
true.** R1 (both sides skip in the same tick), R4 (a partner disconnecting
during `tryMatch`), R13 (two instances racing `tryMatch`) and R14 (a Pub/Sub
event after teardown) were already in `races.test.ts`, under names that describe
the behaviour rather than the row number. Six of fifteen, not zero.

Worth stating plainly because the same table also said P was 0 of 28 and D was 0
of 10, and those *were* true. A hand-maintained coverage number is right until
somebody adds a test without updating it, and there is nothing to catch that.

**Four rows that genuinely had nothing**, chosen for invariant weight:

*R10 — block and skip issued together.* Exactly one teardown, and the block is
recorded **whichever one won**. The second half is what matters: somebody who
pressed Block while their partner skipped in the same instant must still be
protected, and the losing path must not quietly discard the protection they
asked for.

The race was checked for being a real race rather than a fixed winner: across
twelve attempts the block won the teardown nine times and the skip three. Both
directions are exercised, which is what makes "whichever won" an assertion
rather than a hope.

*R12 — join and leave together.* The queue and the session row agree however it
resolves. A coin flip that left them disagreeing is the bug — a queue entry with
no session behind it is a candidate every searcher walks past and cleans up.

*R5 — two sessions skipping into each other.* Two alone in the queue re-match
each other, which is correct because there is nobody else. What must not happen
is a cycle ending with neither matched and neither queued, which is what a
teardown that loses a re-queue looks like.

*R15 — a delayed message from a previous match.* The match id is what makes this
decidable. Sessions are reused across matches — that is the whole of §28 — so
the session id cannot answer "is this still the current conversation" and the
match id has to.

Still open: R3, R6, R7, R8, R9, R11; D1-D4, D6-D8; the E load shapes; and
C3/C4/clock skew/memory pressure.

## Phase 34 — the record

`docs/testing/`, four documents. The thing that was asked for at the start of
this work and the reason the eight phases before it were worth writing down.

**`REGISTER.md`** — what is covered and what is not, with the counts and where
each thing lives. It opens by saying it is maintained by hand and has already
been wrong once, because it has: the swarm handoff recorded the R group as
having no coverage while four of its rows were already tested.

**`RESULTS.md`** — chronological and append-only. Every measurement from the
5,000-bot run onward, with the numbers from `report.json` and live queries
rather than from recollection.

**`FINDINGS.md`** — every F-number, split into open-needs-a-decision,
open-needs-work, fixed, and **accepted**. The accepted section is the valuable
one: a bug that was found, understood and deliberately not fixed is the thing
most likely to be rediscovered from scratch, and rediscovered without the
reasoning that made it acceptable.

**`LAUNCH-GATE.md`** — every public claim against the thing that demonstrates
it, in four states: Demonstrated, Asserted, Open, and Not-a-code-question.

That last document is the point, and its shape is a response to something that
already happened here. A review of the policy documents found seven places where
they described a system that was not the one built. Every one would have
survived a task list, because a task list records what somebody intended to do.
A mapping does not — a claim with an empty evidence column is visible.

It ends with three blocking items, all of them decisions rather than code, and
five things the operator would be choosing to ship without. The most honest line
in it is that the browser purchase path has never been run: the server side is
proven and the checkout has not been opened by a person.

**Phase 32 also picked up C3 for free.** Graceful shutdown turned out to be
covered already — `server_shutdown` asserted in two integration suites, the
`holdSeat: false` drain across eight rounds in `lifecycle.test.ts`, and draining
health in `operations.test.ts`. Not by the swarm, and not labelled as C3
anywhere, which is why the register now says where each row actually lives.

## Phase 33 — a baseline, so a run can be compared to the one before it

The single-host half of phase 33. Distributed workers stay parked.

**The gap this closes.** `runs/` holds over a hundred directories and every one
is an anecdote. The oracles judge a run against its own internal consistency and
are very good at it; what none of them can see is the run *before* this one. So
a change that halves throughput, doubles the time to find somebody, or quietly
stops a persona group producing events passes every oracle, the verdict says
PASS, and the product is worse.

`--record-baseline` freezes a run, `--compare` checks against it, and a
regression fails the verdict and the exit code exactly as a failed oracle does.

**A baseline is recorded deliberately and never learned.** The obvious design
updates it from each green run, and that is a ratchet in the wrong direction: a
regression arriving in small enough steps is absorbed one run at a time and the
file ends up describing whatever the system currently does. The file carries the
commit it was taken at and a free-text note saying why that run was worth
freezing; a `--record-baseline` with no note says so.

**Tolerances are wide and that is not laziness.** Time to match depends on who
else is waiting, not on server speed. Throughput on a laptop depends on what
else the laptop is doing. These catch a step change — twice as slow, a third of
the conversations gone — and a check that fails on a busy afternoon is one that
gets run with `|| true` inside a month.

**One design flaw, found by running it.** The first version used
`conversationsPerBot`, which normalises for population and not for duration — so
a healthy 30-second run read as a 0.5x regression against a 60-second baseline,
because half the wall clock is half the conversations. A baseline that only
holds at one duration is one nobody can use; the first thing anybody does is
shorten the run. It is per bot **per minute** now, and a 20-bot 30-second run
compares at 0.96x against a 40-bot 60-second baseline.

**Both directions were watched.** A deliberately broken baseline produced
`[FAIL] 2 metric(s) moved past tolerance` with the two offenders marked and the
within-tolerance ones left alone, and exit code 1. A restored baseline passes.

## Phase 32f — E6, and what a connected user actually costs

The catalogue names E1, E6 and E10 as the shapes to run before believing any
capacity number: "a capacity figure taken from a shape nobody experiences is a
number about the load generator's preferences". Every capacity figure this
project had came from a population where **everybody was searching**, which is
not what a live service looks like.

**E6 turned out to need no new machinery.** The catalogue calls a shape
something a persona cannot express, and that is true of the arrival shapes —
E2's steps, E3's stampede — and not true of this one. L6 already exists:
connects, never joins the queue, fiddles with the typing indicator the way an
abandoned text box does. Proportion is exactly what a mix expresses, so E6 is
`--profile idle`: 80% L6, 20% doing something.

**The number nobody had**, measured with 1,500 bots against two replicas:

| | Idle stack | 1,449 connections | Marginal |
|---|---|---|---|
| Resident memory, both backends | 206.1 MB | 219.3 MB | **13.2 MB** |
| Open file descriptors | — | 1,498 | ~1 per socket |
| CPU, both backends | — | 0.25 cores | — |
| Queue depth | 0 | 1 | — |

**An idle connection costs roughly 9 KB of resident memory and one file
descriptor.** Ten thousand is about 93 MB, so memory is not the constraint —
file descriptors are, and before them nginx's `worker_connections`, which a
proxied WebSocket consumes two of. That is a materially different capacity story
from the one a search-heavy run tells.

It also confirmed at scale what L6 asserts and nothing had checked: 1,449
connected sockets and a queue depth of 1. Idle sockets are counted in presence
and appear in no queue.

**`--profile endurance` exists for E1 and E10 and has deliberately not been
claimed.** It is a dull mix on purpose — long conversations, low churn, nothing
that trips a limit — because a leak has to be attributable to time rather than
to whatever the adversaries happened to do. It has not been run for long enough
to mean anything, and the register says so: a leak is what an hour shows, and a
two-minute run cannot.

**One wart found on the way.** The process metrics are
`chat_process_process_resident_memory_bytes` — doubled, because the registry
prefix is `chat_process_` and prom-client's own name already starts `process_`.
The overview dashboard uses the correct name; the first query written by hand
here did not, and returned nothing rather than erroring.

## Phase 32g — the Sentinel questions 32b did not ask

32b demonstrated that conversations survive a Redis failover, which is the
product claim. Three questions it left open, all of them the kind that only
matter on the night it goes wrong.

**Does a promotion lose acknowledged writes?** Redis replication is
asynchronous and persistence is off (D12), so the replica's memory is the only
other copy of every session and match in the system. Measured by writing
sequential keys at the master as fast as one `redis-cli` loop manages, killing
it mid-write, and counting survivors: **6,934 acknowledged, 6,934 survived,
zero lost.**

The replica was 5,866 bytes behind when sampled and still lost nothing, because
`down-after-milliseconds` is 2000 — the primary goes on streaming for two
seconds after it stops being useful, and the buffer drains. Read that as "zero
at ~300 writes/sec on a Docker bridge network", not as "zero". F-033 requires
the replica on a second machine, and on a real network the lag is larger.

**Failback exposed a window worth knowing about.** A returning primary
advertises `master` for a few seconds before Sentinel reconfigures it — measured
at under five. No split brain survived and replication came back immediately,
but anything connecting *directly* to that node in the window would have written
to a server about to be demoted, and the resync discards those writes.

That is the argument for `REDIS_SENTINELS` over a `REDIS_URL` pointing at a
fixed address, and it is now a measurement rather than a principle: a client
holding an address does not learn about a promotion, and a returning node
accepts its writes for several seconds.

**Repeated failover works**, which the original drill never checked. Four
transitions in one session — `.11` to `.12`, `.11` back as a replica, `.12` to
`.11`, `.12` back as a replica — none needing longer than the 10s
`failover-timeout`. A set that promotes once and cannot promote again looks
identical to a healthy one until the second incident.

**One measurement was thrown away before it was believed.** The first loss run
reported *negative* loss — more surviving keys than acknowledged writes — because
an earlier aborted writer had left its own keys behind. A contaminated
measurement that happens to look impossible is lucky; one that happens to look
plausible is how a wrong number gets published.

## Phase 32h — Redis memory pressure, and a total outage that passes every health check

CLAUDE.md calls Redis memory pressure "the failure mode with the worst blast
radius given persistence is off". It had never been run.

**The precondition is already wrong.** `docker-compose.yml` sets
`--maxmemory-policy noeviction` and no `--maxmemory`, so the policy is inert:
with no limit Redis can grow until the host reclaims the memory, and with
persistence off a restart loses live state.

`noeviction` is the right *policy* — evicting a session key at random would
silently break matchmaking for whoever owned it — and without a number it does
nothing.

**And the bounded failure is worse than it looks.** With a `maxmemory` set and
reached, Redis refuses writes: in the test the service could not open a
session, match anybody or deliver a message, while `/ready` and the swarm
verdict both still reported success. Every instance would have stayed in the load balancer
for the whole outage.

`/ready` is derived from Redis health and nothing else, which is right — a
backend whose database is down still serves chat (§10.18). But the check is
*reachability*, and Redis answers `PING` perfectly well under OOM because only
writes are refused. It answers "can I reach Redis" when the question is "can I
serve a conversation".

**The swarm's PASS is the same failure wearing the harness's clothes.** The
oracles are consistency checks, and a run in which nothing happened is perfectly
consistent. Handoff trap 18 records the general form — a harness bug that
removes behaviour looks like a clean run — and this is the product doing it.

**I misread the evidence once and corrected it.** The first pass reported that
the backend logged nothing, because grepping for `OOM` found zero lines. It had
logged 202 error lines; the message was simply absent from them. `server.ts`
logged `errName` alone, so an operator saw `failed to open a session —
ReplyError` two hundred times with no indication that Redis was out of memory.
That call site uses `errorFields(err)` now, which truncates and denylist-scans
the message — the reason that helper exists.

Two alerts added: `SessionsFailingToOpen` on
`chat_connections_rejected_total{reason="error"}`, the one series that moved and
which nothing watched, and `RedisApproachingMaxMemory` on the precondition.

**One capacity number came out of it:** roughly **2.6 KB of Redis per live
session** — 600 concurrent sessions took `used_memory` from 1.81 MB to 3.35 MB.
So 100,000 sessions is about 260 MB, and Redis memory is not a near-term
constraint. Choosing the actual `maxmemory` is still the operator's.

## Phase 32i — clock skew, and the two clocks that decide how long data is kept

The catalogued chaos row is "clock skew on one instance", and the sharp version
of it here is narrower and more interesting than a general clock question.

**`retention_expires_at` is stamped from the application's clock and checked
against the database's.** `expiryFrom(nowMs, days)` in `repositories.ts` uses
`Date.now()`; every deletion statement says `where retention_expires_at <
now()`, which is PostgreSQL's. The two are coupled and nothing checked they
agree — while OIDC and TOTP both carry explicit, documented skew tolerances.

On one host with the database in a container beside it they are the same clock
and the question does not arise. On a managed database (§16) they are two
machines, and the difference moves **every** retention deadline by exactly that
much. A process running an hour fast keeps conversations an hour longer than the
privacy policy says, and nothing anywhere would have reported it.

**Measured rather than engineered around.** NTP normally makes this a
non-issue, which is precisely the argument for a detector: the failure is rare,
silent, and directly contradicts a published claim.

`chat_clock_skew_seconds` is this process's clock minus the database's, sampled
by the deletion worker's existing periodic pass — the reading rides along on a
query that was happening anyway, because a round trip of its own would be a
second thing to fail for a number that is only interesting when it is large. It
publishes nothing until a sample has succeeded, the same rule the backlog gauge
follows: a zero from a read that never happened would claim the two clocks agree,
which is the one thing this metric must not say without evidence.

`ClockSkewAgainstDatabase` fires above five minutes for ten — far beyond
anything NTP allows and far below anything that breaches a thirty-day promise on
its own. It catches a clock that has come loose, not jitter.

Reads `0s` on both instances on this host, which is the correct answer and the
one that would have been assumed.

**Two tests document the coupling** rather than complaining about it: a writer
whose clock is an hour fast stamps deadlines an hour later as measured by the
database, and the deletion predicate reads the database's clock — which is what
makes the difference matter rather than cancel out.

## Phase 32j — C4 resolved as a no-op, and D6

**C4 was a claim I had already written down without evidence.** The register
said a partition between backends was "close to a no-op by design"; that was
reasoning, not a check, which is exactly what `LAUNCH-GATE.md` exists to catch.

It is true: every cross-instance notification goes through Redis Pub/Sub on a
per-session channel, the channel name *is* the routing key, and no instance ever
holds another's address. The only outbound HTTP in the whole tree is to the
identity provider — its signing keys and the token exchange — both inside the
one seam allowed to know a vendor exists.

So the useful artefact is not a chaos run but a guard.
`no-instance-addressing.test.ts` asserts no `fetch` outside `oidc.ts` and that
routing is by session channel with no instance-named key builder. **A run would
have passed today and would also have passed on the day somebody added a direct
call between instances** — right up until the partition it was written for. If
this test ever fails, C4 stops being a no-op and has to be run for real.

**D6 — a block outlives the conversation it was made in.** A block keys on
identity hashes rather than on a conversation row (D18), and the conversation is
deleted long before the block expires. If deletion took the block with it,
somebody's protection would quietly end on a schedule they were never told
about, and the person they blocked would become matchable again — with nothing
reporting it, because the block simply would not be there next time `tryMatch`
looked.

**My first assertion was wrong and the schema was right.** I asserted `blocks`
has no foreign key at all; it has one, `blocker_account_id references accounts
on delete cascade`, and `015_account_blocks.sql` argues for it at length — the
column is "a durable negative record about another person tied to a name that
persists" and must not outlive the account that made it.

Narrowed to what D6 actually claims — no foreign key from a block to a
*conversation* — and the account cascade is now pinned as the deliberate choice
it is, with its cost stated: the protection goes too. That is right for a
deletion somebody asked for, and worth re-reading if account deletion ever
becomes something retention does *to* them rather than something they do.

## Phase 32k — the D and R tails, and a regression I had been carrying

The last catalogued rows in both groups. **D is 10 of 10 and R is 15 of 15.**

**R3** — a block while the partner is mid-send: the block records *and* the
in-flight message is refused. The second half is what a user would notice, since
a message arriving after Block was pressed is the block appearing not to work.

**R6** — a report filed as the match ends resolves the conversation it was in or
nothing at all, never the one that replaced it. An orphaned report is evidence
attached to the wrong conversation.

**R7** — two instances presenting a resume token for the same session: at most
one may succeed, and a forged one never does.

**R9** — a route resolved in the same tick as a teardown names the live match or
nothing. A route that resolved to the *ended* match would be an ack the client
could correlate to a conversation that is gone.

**D7 and D2** — cross-instance delivery is by session channel, so a publish to a
session nobody is listening to reaches zero, and an ack aimed at a replaced
session cannot reach the one that replaced it.

**D4** — a conversation ending mid-batch leaves a complete row, and `coalesce`
keeps the *first* end reason: without it a janitor `reap` could overwrite a
`block`, and the console would show the wrong reason for the one kind of ending
anybody investigates.

**D1** — dedupe is scoped to the match in storage as well as on the wire, and
the insert is idempotent on the server's message id, so a replayed batch stores
once. `salvage` retries individual rows after a failure, so a non-idempotent
insert would turn one retry into two copies.

**D3, D8 and R11 reduce to one property** and are tested as one:
`queue-conservation.test.ts` asserts every record the queue accepted is still
accounted for — taken, evicted, or refused, never vanished. That is what makes
"lossy by design" defensible: the loss is counted. D8's in-flight depth is
reported per class, so "which evidence would a restart lose" is answerable and
not merely "how much".

**R8 is credited to the swarm rather than to a new test.** "Each message
delivered exactly once, per-sender order preserved" is exactly what the
pair-reconstruction oracle checks across every conversation in a run — 96,400
message positions in the 400-bot run. A unit test would be a weaker version of
something that already runs at scale.

**And a regression I had been carrying since phase 26.** Adding `created` to
`accountForSubject` broke `accounts.test.ts`, which pins the return shape with
`toEqual`. The integration suite had been red for six phases and I had not
noticed, because I was running `npm run verify` — which is unit only — plus
targeted integration runs on whatever I had just touched.

`CLAUDE.md` says in as many words that **`npm run verify` is not the whole
build**. I wrote a register that tells other people to run the integration suite
and did not run it myself. The test was right to fail: it was pinning a contract
I changed. Fixed by asserting the new field, which is more informative than the
old assertion — the first call reports `created: true` and the second `false`,
which is the distinction the metric counts.

Full suites now: **877 unit, 624 integration, all green.**

## Phase 32l — N9, the S and L tails, and the rows worth naming rather than counting

**L5 — the slow consumer — had no test at all**, and it is the one that
mattered most here. A client that stops reading does not error and does not
close; it simply stops draining, and every frame the server writes accumulates
in that connection's buffer. A suspended tab, a dead mobile radio and a
deliberate attacker all look identical, and the attacker's cost is nothing.

`SocketConnection.send` checks `bufferedAmount` against `MAX_BUFFERED_BYTES` and
closes with 1013. That was the whole defence, it is one comparison, it is easy
to remove while tidying, and nothing would have failed. `backpressure.test.ts`
asserts it — including that `send` **returns false rather than throwing**,
because its callers are usually transitions already committed to Redis and a
throw would unwind an operation the rest of the system believes happened.

Watched failing before it was kept: replacing the condition with `false` turns
two of the five red.

**N9 and S6** are the two rows about *waiting* rather than about doing
something. S6 joins once and does nothing while everybody else churns past it —
a queue entry belonging to a live searcher must not be collateral damage of
somebody else's garbage collection, and the symptom of getting that wrong is
somebody never being matched rather than an error. N9 arrives 45–90 seconds in,
long after the ramp, when the queue is nearly empty and the only candidates are
mid-skip.

Both appear in the roster at 120 bots — 21 S6, 13 N9 — and the Redis residue
oracle finished with **0 queue members**, which is S6's property stated as a
number.

**L11 is an integration test rather than a persona**, and the reason is
structural: every accounting assumption in the swarm is "one bot, one socket",
which is the same thing that keeps L15's concurrency half out of it. Two
connections presenting one cookie get two sessions, and one of them searching
does not drag the other into a queue — because the client token is half a block
identity (D18) and deliberately not a session key. If it were, a copied block
token would be a session hijacking primitive.

**Seven rows are left, and the register now names each one and why** rather than
carrying a count that implies they are the same size of task. Three are shapes
that already exist under another name (S10 and L7 are `--ramp`; S11 is S1 run
longer). Two need a setup phase the harness does not have (S8's pre-blocked
roster; L8's arrival shape). Two need wall clock rather than machinery — S3's
fairness band, and L12's dead socket held past the session TTL.

Saying which is which is more useful than "4 of 11", because the four are not
interchangeable and somebody picking one up should know whether they are writing
a persona or waiting twenty minutes.

Full suites: **882 unit, 626 integration, 188 frontend, all green.**

---

## Phase 35 — the machine being bought, and the first number that is about it

This phase has one theme: every capacity figure this project carried was taken
on an 8 vCPU / 31 GB development machine or derived by arithmetic, and the
deployment target is a VPS costing about a thousand rupees a month. Those are
different questions and the answers were not close.

### The edge was giving away the source and shipping it uncompressed

`sourcemap: true` meant nginx served `/assets/index-*.js.map` — HTTP 200,
1,246,040 bytes, the entire annotated frontend with comments intact, to anyone
who asked. Not a credential leak: a frontend build cannot contain secrets. What
it leaks is the reading, and it lowers an attacker's cost rather than granting
access. `'hidden'` was rejected because the file would still sit in the image
and still answer a request from anybody who guessed the name, which is security
through not-linking; nginx also returns 404 for any `.map` now, so a future
build flag flipped back cannot silently republish it.

There were also **no gzip directives at all**, and the bundle is the dominant
thing this origin sends. Measured after: 392,547 bytes becomes 113,975. Level 5
rather than 9 because the curve is nearly flat past 5 while CPU keeps climbing,
and `gzip_proxied any` because the default is `off` — behind Caddy every request
is proxied, so the default would have made the whole block do nothing in
production.

### A rig shaped like the VPS

`docker-compose.vps.yml` constrains the application path to a cheap VPS. It is a
rig, never a deployment, and holds the same status as the Sentinel compose.

**`cpuset` and not `cpus`,** which is the whole design. A 1 vCPU VPS is not
"each service gets a fraction of a core"; it is one core that every process
contends for, including the ones that are not the bottleneck until suddenly they
are. `cpus: 0.25` per service caps each container independently, so four of them
can still consume four cores in the same instant. `cpuset` pins them to the same
physical core so they queue behind one another. Verified rather than assumed:
`nproc` reads 1 inside the container, so nginx's `worker_processes auto`
resolves to a single worker and the edge ceiling is exactly `worker_connections`.

Measured on 1 vCPU / 2 GB, `realistic`, seed 101, six harness workers:

| Concurrent | ack p99 | match p99 |
|---:|---:|---:|
| 1,000 | 150ms | 428ms |
| 2,000 | 598ms | 1,617ms |

**The bottleneck is CPU, by elimination.** At 2,000 the four containers demanded
125.6% of one core and only 100% exists. Nothing was OOM-killed, nothing
restarted, nginx never reported exhausting `worker_connections`, and the
ephemeral port range was never approached.

**Memory is nowhere near binding, and the edge figure this project carried was
wrong by an order of magnitude.** nginx idles at 4.1 MiB, not 114 MB. The whole
stack idles at 118 MiB and reaches ~222 MiB under 2,000 users — about 36 KB per
active user, so ten thousand users would fit the 1 GB tier. CPU stops this
service long before memory does.

### Two hypotheses tested and both wrong, which is the point of having a rig

**The idle mix does not rescue the number.** The obvious hope was that a real
population, mostly idle, would be much cheaper than one where everybody is
chatting. Apples to apples at 2,000 with identical config: idle demanded 111.7%
of the core against realistic's 144.7%. Only Postgres moved much
(6.7% to 27.6%, since retention writes scale with messages); backend went 60.0
to 67.5, frontend 23.9 to 25.9, redis 21.0 to 23.7. **Roughly 85% of the CPU
cost is connection maintenance rather than conversation.** An idle user is cheap
on memory and nearly as expensive as an active one on CPU.

**Doubling the heartbeat interval does nothing.** If connections cost CPU while
idle, the heartbeat looked like the lever — 2,000 users generate 100 Redis
round-trips per second doing nothing but existing. Measured at 40s against 20s:
idle went 111.6% to 117.3%, realistic 144.7% to 146.4%. Redis alone dropped
(1.8 and 2.1 points), which is the predicted effect, but Redis was a fifth of
the total. Peak-of-samples is a crude statistic and run-to-run variance reached
9 points on the same seed, so the honest reading is **no difference**, not
"slightly worse". Left at 20s, where dead-socket detection and the friends'
online dots are twice as fresh for free.

The capacity band that falls out, scaled to an 80% CPU target: roughly
**1,100 to 1,400 concurrent on one core**, depending on how talkative the
population is. The uncertainty is now closed rather than optimistic.

### Three faults the rig found in itself

Each produced a confident, wrong reading, which is why they are recorded.

**A compose overlay can add a service and cannot remove one.** The first version
carried a comment listing the observability stack as "deliberately absent" and
started every one of it. The comment was the whole of the mechanism.

**A pass over an empty run is not a pass.** The first run reported
`VERDICT: PASS` over 500 bots, zero conversations and zero messages —
`ALLOWED_ORIGINS` had been copied from the 8090 stack and refused all 500
upgrades with 403. Every oracle that could have failed needed a conversation to
judge, and there were none.

**A saturated harness reports a server problem.** Swarm workers default to
`min(cpus, ceil(bots/1000))`, two for a 2,000-bot run. The same 2,000 bots gave
5,008 messages at ack p99 1261ms on the default and 12,245 at 598ms on six —
the first reading was more than twice as bad as the truth and it named the
server. Above roughly 2,500 bots the harness dies before the server degrades,
which is the honest limit of what this rig currently measures from a laptop.

### F-045 — 109 settings that are documented, settable, and reach nothing

Found by trying to run the heartbeat experiment. `HEARTBEAT_INTERVAL_MS=40000`
was written to the env file the stack was started with, the backend recreated,
and the process still reported 20000. `docker compose --env-file X` populates
variable substitutions **in the YAML**; it does not put anything into a
container, and there is no `env_file:` in any compose file here.

167 environment names are read by `config.ts`; 97 are passed by some compose
file; **109 are read and passed by nothing, and 99 of those are written down in
`.env.example` or `.env.prod.example` as supported settings.** That second
number is what makes it a defect rather than an absence. `SESSION_TTL_SECONDS`,
`MAX_CONNECTIONS`, `BREAKER_FAILURE_THRESHOLD`, every `RETENTION_QUEUE_MAX_*`,
the whole `SPOOL_*` group and the entire admin-console block are all absent from
the container's environment — confirmed by asking the container, not the regex.

`SPOOL_BACKEND` being on that list is the sharpest part. F-006 was *one* setting
that looked applied and was not, and it is cited three times elsewhere here as
the reason to distrust an unexercised constant. It is still unreachable and it
now has a hundred companions.

The experiment would otherwise have compared 20s against 20s and concluded the
heartbeat interval does not affect capacity — which happens to be the true
answer. A wrong method produced the right number and nothing would have said so.

### The connection ceiling derives, and the headroom is charted

`MAX_CONNECTIONS` was a flat 5000 and unreachable. 5000 is about four times what
one core serves and comfortably under what eight could: a cap wrong in both
directions never binds before the machine is collapsing.

It is now cores multiplied by `CONNECTIONS_PER_CORE`, default 1400, with
`MAX_CONNECTIONS` still winning when set. **`availableParallelism()` and not
`os.cpus().length`** — the second returns the host core count and ignores the
cgroup, reporting 8 inside a container pinned to one core, which would have
authorised 11,200 sockets on a box that saturates near 2,000. On an
unconstrained machine the two agree, so the wrong one looks correct everywhere
except the VPS where it matters. `loadConfig` takes `cores` as a parameter with
the host lookup as its default, so it stays a pure function of its arguments.

**The ceiling had to become a metric.** `chat_connections_active` existed and
nothing exposed the limit, so a panel would have baked in 5000 and been silently
wrong on every box once the value derived — wrong in the reassuring direction,
showing headroom that is not there. `chat_connections_limit` is published at
`listen()`, and the new Capacity row plus both alerts are written against the
ratio, never a literal count.

Verified live rather than reasoned about, because a division that matches
nothing returns `success` with an empty result (the F-038 shape): the ceiling
resolved to 1400 on one core, both gauges scraped, and the headroom expression
climbed from 0% to 17.7% to 56.5% under 900 bots.

### What is left, for whoever picks this up

The overload plan has two of four steps done. The remaining two, in the order
they are worth doing:

1. **Reserve ceiling headroom for resumptions.** A reconnecting user arrives
   through the same upgrade path as a cold arrival and hits the same cap, so
   somebody whose train enters a tunnel mid-conversation is refused and loses a
   conversation the resume token existed to save — and under load is exactly
   when it happens. The resume token is presented at the handshake, so the
   information needed to admit it preferentially is already there. This matters
   more than the screen does.
2. **The capacity screen, which needs an HTTP probe rather than the socket.**
   A browser cannot see the 503: a rejected WebSocket handshake reaches JS as a
   generic close, code 1006, with no status and no body. So the frontend
   currently cannot distinguish "we are busy" from "server down" from "your wifi
   died". The fix is a small HTTP endpoint fetched **on failure only**, carrying
   the reason and a retry hint. Accepting the upgrade and closing with 1013
   would also work and is a worse trade: it spends the handshake at exactly the
   moment the point is not to. Jittered backoff already exists in `useChat.ts`,
   so the stampede problem is handled. Copy should say "busier than usual",
   never "full" — the D21 reasoning, that hiding a true number says nothing
   false while inviting a guess does not.

Separately, the user has asked for a **dedicated session** to resolve F-045
rather than fixing it piecemeal: three distinct failures needing three different
fixes (read-but-unpassed, hard-coded-with-no-name, passed-but-unread), and a
guard afterwards. The guard matters more than the fix — a test diffing what
`config.ts` reads against what compose passes, failing on a documented but
unreachable name. Same shape as `metrics-wiring.test.ts`, and for the same
reason: a documented-and-dead setting is worse than an absent one, because it is
set, it is believed, and it is not there.

Full suites: **887 unit, 188 frontend, all green.**


---

## Phase 36 — the last seats belong to the people coming back

Phase 35 measured the ceiling. This phase asks who is standing at it when it
binds, and the answer was that the ceiling could not tell the difference between
somebody arriving for the first time and somebody whose train had gone into a
tunnel thirty seconds ago.

### Both arrive through the same upgrade, and only one of them has something to lose

A resumption is an ordinary WebSocket handshake carrying a subprotocol (§28), so
`registry.size >= config.limits.maxConnections` refused it exactly as it refused
a first-time visitor. What was refused was not a chance to start chatting: it
was the resume token, which exists so that a blip does not destroy a
conversation. And a busy instance is where both the drops and the arrivals are,
so the failure was concentrated at the moment the token was most needed.

The asymmetry is what makes this worth spending capacity on. A cold arrival
turned away loses a chat that had not started. A resumption turned away destroys
a live conversation **and takes the partner's with it** — one refusal, two
people, one of whom did nothing at all.

So the ceiling has three bands now (`admission()` in `ws/upgrade.ts`, D63,
§28.7): open below `MAX_CONNECTIONS - reserve`, reserved above it, full at the
ceiling. `RESUME_RESERVE_PERCENT` defaults to 5 — 70 seats at the derived
1400/core — and it is a **percentage rather than a count** for the same reason
the ceiling is derived rather than a constant: a count right for one core
reserves an eighth as much of an eight-core box.

### The seat is spent by a resumption, not by claiming to be one

The obvious implementation admits anything presenting a token, and a subprotocol
is the cheapest thing in the world to invent. The refusal therefore sits *after*
`lifecycle.resume`: a connection in the reserved band that resumed nothing is
refused rather than falling through to a fresh session, which is what it does
everywhere else. An invented token costs one Redis lookup and gets the same 503.

Both bands return the **identical** refusal. Telling a client that seats exist
for resumptions tells it what to claim to be.

Two more properties, both deliberate. The reserve comes **out of** the ceiling
and never extends it — a resumed session costs the same CPU as any other, and
the ceiling is what the box can serve. And it derives to **zero** when
`RESUME_GRACE_SECONDS=0`, because seats held for a resumption that can never
succeed would refuse arrivals to protect capacity nothing can use; that is one
setting, not two, so it cannot be left half-configured.

### The cost is charted, not inferred

Cold arrivals are now refused at 95% of what the instance could serve whether or
not anybody is reconnecting. `chat_connections_reserved` is published beside
`chat_connections_limit` and the headroom panel charts a second series against
`limit - reserved`, because that is where a first-time visitor actually meets
the wall — read against the limit alone the graph is 5% more generous than the
system.

`chat_connections_rejected_total{reason="at_capacity_reserved"}` is a separate
label rather than more `at_capacity` for the reason the `'banned'` label records
two hundred lines up: an operator reading one number cannot tell an instance
that is genuinely full from one holding its last 5%, and those want opposite
responses. It is zero-initialised with the rest.
`chat_resume_reserve_admissions_total` is the other half of the trade — the
conversations the reserve actually saved. Sustained refusals with no admissions
beside them is the reserve being larger than the drop rate needs, and that is
the only evidence that will ever say so.

### Two things found by writing the test

**A held seat needs a conversation.** The first version of the integration test
opened a session, closed the socket and tried to resume it, and got a brand-new
session — `closeSession` holds a seat only when the row has a match, and deletes
an idle session outright. The test had to pair two clients before dropping one,
which is not an inconvenience of the test: it is precisely the case the reserve
exists for, and a version that did not pair would have passed while proving
nothing.

**A regex is a string before it is a pattern.** The helper reading the scrape
used ``new RegExp(`...(\d+)`)``, and the string literal ate the backslash,
leaving a pattern that matched nothing and a helper that reported `-1` — read as
"that metric does not exist" rather than "this test is broken". It reads the
line by prefix now. Same family as every other trap in `CLAUDE.md` where one
layer of quoting silently rewrites what the next layer sees.

### One unrelated fix, in the same run

`connections.test.ts` asserted the table's column list against
`information_schema.columns` **without filtering on the schema**. Every
integration context migrates its own copy into one database, so the assertion
passed when run alone and failed in a full suite with each column reported three
times — which reads as somebody having added a column to the table
`010_accounts.sql` names as the line to defend. It is scoped to the context's
schema now, like the equivalent queries in `retention-integrity.test.ts` already
were.

That closes item 1 of the two picked at the end of phase 35. Item 2 — the
"busier than usual" screen — is untouched and still needs an HTTP probe,
because a browser cannot see a 503 on a rejected handshake: it arrives as a
generic close, code 1006, with no status and no body. The reserve does not
change that; it changes who gets the 1006.

Full suites: **897 unit, 188 frontend, 628 integration, all green.**


---

## Phase 37 — the 503 the browser is not allowed to see

Phase 36 decided **who** gets refused when an instance fills. This one is about
what the person refused is told, and the answer was: the same sentence somebody
gets when their wifi dies.

### Three failures, one event

The server refuses an upgrade with **503 and a reason**. Page script receives a
`close` with code **1006** — no status, no body, nothing. It is byte for byte
what arrives when the backend is down and when a laptop loses its network, so
"we are busy", "we are broken" and "your wifi is gone" were indistinguishable
from inside the client, and it called all three "Connection lost. Reconnecting…".

`GET /api/capacity` is the only place that difference exists. It answers one
word — `ok`, `busy`, `unavailable` — and the client adds a fourth, `unknown`,
for a probe that could not get through either.

### The decisions inside a very small endpoint (D64, §28.9)

**200 even when busy.** A 503 here would be ambiguous with the outage the caller
is trying to rule out: from page script, a fetch that fails and a fetch that
says "busy" are the same thing. The endpoint that exists to remove an ambiguity
must not reintroduce it.

**No numbers, and never the word "full".** Not the count, not the ceiling, not
the instance id. This is the D21 reasoning applied to a different surface:
"busier than usual" is true at any load and describes a wait, where "full"
describes a door and invites the question of how full. A refusal is not a
verdict — the client is still retrying on its own backoff, and the copy says so.

**On failure only, never polled.** It is fetched from the close handler, and
only for a socket that never opened: a close *after* an open is a dropped
connection and the client already knows what to say. One probe per failed
attempt inherits the jittered backoff for free, so a service refusing a crowd
does not then get a second crowd asking why.

**`unknown` keeps the old copy.** If the probe could not get through either, the
network is the problem — which is exactly what the ordinary reconnecting line
says. Guessing would caption a broken laptop with a claim about the service.

Accepting the upgrade and closing with **1013 (try again later)** was the
alternative and is worse: it spends a session id, a Pub/Sub subscription and a
connection slot at the precise moment the point is not to.

### A false sentence, found by looking at it rather than testing it

With the copy in place and a one-connection ceiling, a third tab showed the new
line **and**, above it, a toast reading "Connection lost. Reconnecting…". Two
messages, and the more alarming one was false: nothing was lost, because nothing
had ever been held. It had been wrong since long before this phase — a first
visit to a dead backend has always said it — and no test could have caught it,
because every test that constructs a `socket_closed` was written about a
conversation that dropped.

`socket_closed` now carries `everOpened`, absent meaning "it was up", and a
refused handshake suppresses the toast and leaves the landing screen to explain
itself. That is where somebody watching a button say "Connecting…" is actually
looking.

### Verified in a browser, on the artifact that was served

The suite cannot see either of those things. With `MAX_CONNECTIONS=1` per
instance and two instances, a third tab showed the busy line and no toast; the
served bundle was confirmed to contain the string before believing the screen;
`curl` through nginx confirmed the route reaches the backend rather than falling
through to the SPA. Raising the ceiling back to the default cleared the line
**without a refresh**, which is the behaviour the copy promises.

Full suites: **897 unit, 208 frontend, 631 integration, all green.**


---

## Phase 38 — one file, and everything in it arrives

F-045 was recorded as a counting exercise: 109 settings `config.ts` reads that
no compose file passes. This phase is the fix, and the operator's framing was
wider than the finding — every value, string, number and URL that can live
outside the code should live outside it, in one file, so the system can be tuned
without a rebuild.

`docs/operations/CONFIGURATION.md` is the standing answer to "where do I change X" and
carries the audit, the plan and what shipped against it.

### The mechanism, which nobody had checked

`docker compose --env-file X` populates `${VAR}` substitutions in the YAML and
puts **nothing** into a container. A service receives a variable only from an
explicit `environment:` entry or an `env_file:` directive, and there was no
`env_file:` anywhere in this repository. So an env file listing eighty settings
configured exactly the ones the YAML interpolated by hand, and was inert for the
rest — silently, because an undeclared variable is not an error and the process
starts cleanly on its compiled-in default.

`backend` and `personas` now read `env_file: ${APP_ENV_FILE:-.env}`. Three
details, each of which could have gone wrong quietly:

**The path follows the profile.** Every profile is invoked with its own
`--env-file` — `.env.loadtest`, `.env.vps`, `.env.prod` — so a hardcoded `.env`
would have served development values to all of them. That failure would have
presented as the load stack being mysteriously hard to tune, which is a symptom
nobody would have attributed to compose. Each env file names itself in
`APP_ENV_FILE`: self-referential on purpose, so a profile that forgets the line
falls back to `.env` rather than to nothing.

**`required: false`**, because `.env` is not tracked and a fresh clone must
still be able to `docker compose up`.

**`environment:` still wins**, which keeps the topology authoritative — the
service hostnames, and the per-replica instance id that two containers must
never share.

Verified the way this project verifies anything: `HEARTBEAT_INTERVAL_MS=25000`
in `.env`, restart, and the running process reported 25000 against a compiled
default of 20000. That is the exact setting whose inertness started this, and
the backend's environment went from 47 entries to 152.

### The guard, and the guard on the guard

`scripts/verify-config.mjs` runs inside `npm run verify` and fails when a
service that runs this code has no `env_file:`, when a readable setting is
undocumented, or when a `VITE_` name is missing from any of the three places it
has to appear.

The trap it had to survive is why it is more than a grep. Ten rate-limit buckets
are built by `rateLimit(env, 'MESSAGE', …)`, so `MESSAGE_RATE_PER_SEC` is a
literal nowhere in `config.ts`. A checker that greps for names reports all
twenty as dead and gets deleted the first time somebody trusts it, so the
extractor knows about composed names — and `EXPECTED_COMPOSED` asserts that it
still finds them, because a silently-empty extractor passes every other
assertion in the file. It was watched failing three ways before being kept: a
removed `.env.example` entry, a removed `env_file:`, and a deliberately broken
extractor.

Its first run found 29 settings that were readable and entirely undocumented —
the whole persona group, both preference limits, the Sentinel topology,
`FILTERS_ENABLED` and `CONNECTIONS_PER_CORE`.

### Forty-three constants that were never settable

Correct, commented, and impossible to change without a rebuild. The OIDC clock
skew and its three timeouts; the avatar relay's byte ceiling, fetch timeout and
cache lifetime; the premium entitlement cache; the console's body cap and the
login window its per-minute budget was counted against; Redis reconnection and
the boot deadline; the preference bucket TTL and the queue-composition sample;
the pool's idle timeout and the retention histogram's bound; the product
catalogue; and the persona cadence.

Every default is the number that was in the source, so a deployment that sets
none of them behaves exactly as before.

Two of those deserve their own note.

**The product catalogue is now a function.** `PRODUCTS` was frozen at module
scope; it is `buildProducts(config.payments)` now, and `findProduct` takes the
catalogue. Price is a business value that should not need a rebuild. The cost is
stated at all three sites, because nothing can check it: the Premium page states
"₹99 / month" **in prose**, so moving `PREMIUM_PRICE_PAISE` without changing the
copy advertises a price the checkout does not charge.

**The cadence introduced a drift hazard and closed it in the same commit.**
`DEFAULT_CADENCE` is what a test gets and what `humanCadence` falls back to;
`config.personas.cadence` is what production runs. Fifteen numbers in two places
look identical until one is edited in only one of them — and nothing would fail,
personas would simply be paced one way in production and another in every test.
Config reads its defaults *from* `DEFAULT_CADENCE`, and a test asserts both that
they are equal and that the environment still overrides them. The second half
matters: the equality alone would pass if config had stopped reading the
environment entirely.

### The client's three places

Seven values the browser waits on were constants, three of them not even in
`frontend/src/config.ts`. A `VITE_` value has to appear in the compose
`build.args`, as a Dockerfile `ARG`, and as the `ENV` that hands the ARG to the
build — an ARG alone is invisible to vite — so dropping any one of the three
ships the default with nothing to show for it.

The readers refuse rather than clamp, which is the part worth arguing about. A
build-time value cannot be corrected without another build, so a `0` from a typo
would turn the backoff into a spin and every timeout into an instant failure,
and both present as a broken server rather than as a bad setting.
`readNumberList` falls back to the whole backoff curve rather than a
partially-parsed one, because the shape is the point: the last entry repeats for
every attempt after it.

Verified on the served artifact, which is the only thing a build-time value can
be checked against: `VITE_TOAST_VISIBLE_MS=7777` appears in the container's
bundle after a rebuild and is gone after reverting.

### What deliberately did not move

A setting is a promise that changing it is safe, so the list of what stayed is
part of the work rather than an omission: protocol values and closed lists,
where one deployment widening a list fails the whole frame; the preference
weights, which a metric decomposes and a test reads out of the Lua; `logger.ts`'s
denylist and truncation limits, which are the primary I8 control; the scrypt
parameters, where a change invalidates every stored hash and is a migration
rather than a tunable; histogram buckets, which dashboards and recording rules
are written against; moderation regexes; and cookie names, storage keys and unit
conversions, where a changed value silently orphans state rather than tuning it.

### The trade, stated

An env file is delivered whole, so the application container's environment now
contains every secret in it — including the Postgres superuser password and the
Grafana admin password, neither of which the application reads. That is the
price of one file. It is documented in `.env.prod.example` with the mitigation
for a deployment that cares, and it is a real cost rather than a footnote.

### One near-miss

Checking whether the production overlay inherited the new build args returned
zero matches, which read as "prod is missing them". The command had failed on an
unrelated missing variable and printed nothing at all. Supplying the required
values showed all fifteen present. Empty output from a failed command reading as
a real answer is the stale-bundle trap wearing different clothes, and it is now
in `CLAUDE.md` beside it.

Full suites: **897 unit, 211 frontend, 631 integration, all green**, and
`verify:config` reports 217 backend settings documented and delivered with 15
`VITE_` names wired through all three places.


---

## Phase 39 — the pending list, and what each item turned out to be

Six items were carried as "pending". Working through them in order found that
**three were not what the label said**, which is the reason this entry is worth
reading rather than skimming.

### F-037 was the harness, and the same field as last time

Six percent of declared profiles appeared not to round-trip, deterministically:
`--seed 33 --bots 40` returned exactly 8 of 130, every time, with filters and
tracing off. The swarm had been red on it since 26 August.

Reproduced before theorising, which is the standing rule and which paid. The
failures **clustered on individual bots** rather than scattering, and tracing one
through the ledger showed the same declared hash against the same echoed hash
across seven matches. Deterministic, not a race — which is precisely why it read
as a product bug, because a race looks random and this did not.

The obvious suspect was wrong and is worth recording. The failing bots run G1,
"declares nothing, ever", so the empty-profile collapse in `profileHash` looked
like the cause. It was not: `null` and "every field declined" hash identically,
exactly as the comment there claims. That left "the server echoed something
non-empty to a bot that declared nothing", and hashing every country-only
profile named it on the first try — the echo was `{ country: 'PH' }`, the country
that bot's *connection* carries.

`server.ts` builds the join profile as
`{ ...command.profile, country: connection.country }`, so country always comes
from `CF-IPCountry` and never from the declaration — including when nothing was
declared. The ledger hashed what the bot sent rather than what the server would
build, so the comparison was wrong by exactly one field, for every bot whose
declaration and connection disagreed, in every match. G1 overwrites `declared` in
`onConnected`, *after* the header has been set from the generated profile.

`bot.ts` now records the hash the server will produce. Modelling the rule rather
than dropping country out of the hash, because dropping it would make a genuine
country-crossing bug invisible. 0 of 136 on the documented repro, 0 of 1,926 at
500 bots on another seed.

### The last SKIP was a missing flag, not a missing oracle

The database-agreement oracle — the only check that looks at PostgreSQL, and so
the only one that can catch a retention bug — was finished the whole time.
`--postgres` was absent from every command in the documentation, so it skipped
out of every run anybody copied, and the verdict said
`PASS (2 oracle(s) did not run)`, which reads as a complete run with a footnote.

Invoked, it earns its place: at 1,000 bots, 9,095 messages stored against 9,093
acked with zero dropped, every stored body matching a sent hash, every
conversation ended, and every retention deadline stamped at insert with a worst
lag of 1.3s — **D17 demonstrated rather than asserted**.

`npm run swarm:full` makes the complete run one command. The verdict now
separates an oracle that skipped **for want of a flag** from one the run
deliberately did not ask for: `--chaos` stays quiet, a forgotten `--postgres` is
named, with the line "a pass that skipped them is a weaker claim than a pass that
did not". `needsConfiguration` is set by the oracles that know why they skipped
rather than inferred from summary text in the report.

That is F-045's shape in a different subsystem: built, documented as available,
reaching nothing, and reported in language mild enough that nobody read it as a
problem.

### The premium gate, and a promise the client was about to make

`FILTERS_AVAILABLE` is process-wide, so the day payments are switched on every
visitor gets the filter control — free or not — sets a preference, and has it
dropped by the D51 gate. **Silently, and silence is correct**: §29.4 requires a
refused preference to be invisible, because telling a paying user "you have run
out this hour" is worse than quietly giving them an ordinary match. Right for
somebody who paid and spent their budget; exactly wrong for somebody who never
paid, who would watch the setting be accepted and never learn it did nothing.

`/auth/session` now answers `premium`. It is **not a second gate** — the server's
is the only gate — it is what stops the client promising on the server's behalf.
On the session endpoint rather than the `connected` frame because
`stampEntitlement` is deliberately fire-and-forget, so a frame built at connect
time would race the stamp and a paying user would watch the control vanish and
return.

Every failure answers false. The integration test covers the throwing case
explicitly, because failing open on a database blip would show the paid control
to everybody who loaded the page during it. Verified against the running stack
with a real credential: false, then true after a grant with the cache cleared,
false again once the deadline passed, false with PostgreSQL stopped.

### Payment orders were stamping a deadline nobody enforced

`payment_orders` wrote `retention_expires_at` at insert like every other retained
table, and no pass ever deleted it. Left that way deliberately — a worker
pointed at financial records before anybody had named the period would have been
the wrong kind of decisive — and the operator has now named it: **seven years**,
the existing default rather than a new number. Two years was considered and
rejected as below the periods usually cited for Indian tax and GST records.

The guard matters more than the sweep. The payments migration is staged, so
today there is no such table, and `delete from` a missing relation raises 42P01 —
which would fail the whole pass and stop six other tables being swept because of
a feature nobody enabled. `to_regclass` answers null rather than raising. Both
shapes are tested, and the absent case asserts the table really is missing before
asserting the pass survives it.

### Who this service says it is

The Terms now identify the operator as the Indian rules require, and the
Grievance Officer is named with a designation and contact details. Two clauses that were missing entirely arrived with it:
the **GAC appeal route** added by the 2023 amendment, and the **24-hour removal
commitment** for Rule 3(2)(b) content — on an anonymous stranger-chat service,
the clause most likely to be needed.

The postal address is absent while the service is free, and is added before
`PAYMENTS_ENABLED`.

Along the way the **shipped pages were found carrying four blanks reading
`[operator name — not published yet]`** — the drafts had taken the
enterprise-only position long before, and the pages a visitor reads had not.
Each would have been filled in by hand on launch day, which is how a decision
not to publish something gets undone by a chore.

### Two placeholders that had started to read as decisions

**₹99 was never a price anybody chose**, and `products.ts` described it as one
the copy review had signed off. It had not. That is the plausible-false-detail
failure this project treats as worse than an obvious gap, and it was in a comment
written earlier the same day. Corrected in three places; `PENDING-PAYMENTS.md`
already held it as a template variable and needed nothing.

**Premium will renew by default** — decided, unbuilt. A refund policy had
already been drafted around "Premium does not automatically renew", true of the
code and false of the product. It is **deferred rather than drafted**, because
publishing it and then reversing would repeat the ordering mistake this document
set names elsewhere. What renewal drags in — e-mandate rules, pre-debit
notification, affirmative consent under Rule 4(9), a cancellation control that
exists, renewal-aware entitlement arithmetic — is written down so the
implementation inherits it.

₹50 as the donation minimum *is* decided: the support page and
`DONATION_MIN_PAISE` agree. Two places that corroborate, unlike ₹99, which was
several places repeating one placeholder.

### A launch checklist that holds no reasoning

Four registers already bore on whether this can launch. A fifth summarising them
would drift, and then two documents would disagree about the same fact.
`docs/LAUNCH-CHECKLIST.md` names the document holding the reasoning for each row
and states that where the two disagree, the source wins and the checklist is
stale. Status keys separate decided-but-unbuilt from outstanding, which matters
immediately: Premium renewing is decided and unbuilt, and a plain unticked box
would invite somebody to build the wrong thing.

### Publication date, and a folder that had stopped being navigable

**7 September 2026**, set in the two drafts, the two wording sources and the
shipped pages — four places that must agree, with the transcription guard
proving they do.

`docs/` held twenty-seven loose files sorted by nothing. Seven folders now,
grouped by the kind of question each answers. `rewrite-wording/` deliberately did
not move: `pages.test.ts` imports those files by path, so moving them breaks the
build rather than a link. References were rewritten across thirty-six files and
then checked rather than assumed. `ui-integration/` is deleted — forty files of
mockups referenced once.

Two claims the move would have quietly falsified were corrected rather than
left: `docs/testing/README.md` opened with "Four documents" and now holds nine.

### The pattern across all six

Three of the six were not what their label said. F-037 was the harness. The last
SKIP was a missing flag. The premium gate was a promise the client had not yet
made. In each case the label had been carried forward for weeks and believed.

Full suites: **897 unit, 213 frontend, 640 integration, all green.**

### Postscript — CI had been red for two days and was accusing the wrong command

The first push after all of the above turned CI red with "a lockfile changed
during a clean install — it is out of step with its package.json", naming
`frontend/package-lock.json` and 42 deletions.

The lockfile was correct. An earlier step in the same job rewrote it: the audit
step ran `npm install --package-lock-only --omit=dev` before auditing, which was
belt-and-braces — `npm audit --omit=dev` reads the committed lockfile and filters
dev dependencies itself — and which **writes to the working tree**. The check
that followed diffed a tree a previous step had modified, and blamed `npm ci`,
the one command in the job that had not touched it.

What it rewrote looks like a dependency problem and is not one. The committed
lockfile is written by npm 11, which records `"libc": ["glibc"]` on optional
native packages. npm 10 does not know that field and drops it: exactly 42 lines.

**The obvious fix was wrong and was tested before being believed.** CI pinned
Node 20 while both Dockerfiles ship `node:22-alpine`, so "the Node version is
stale" was the natural diagnosis. Node 22's image ships npm **10.9.8** — still
npm 10 — and strips the same 42 lines. Verified by replaying the job in
`node:20-alpine` and `node:22-alpine` containers against clean clones.

Three earlier attempts at reproduction all came back clean, and each was
unfaithful in a way worth naming: they ran only the frontend, on a tree that
already had `node_modules`, without the audit step that was actually responsible.
A reproduction that does not reproduce is evidence about the reproduction.

Two commits, deliberately separate so the history says which fixed what. The
mutating install is gone, and the lockfile check now asserts the tree is clean
*before* it runs, so a future step that writes to a lockfile is named rather than
inferred. Then, separately, CI moved to Node 22 to match the images, with
`engines` following from `>=20` to `>=22` — every check had been passing on a
runtime the product never executes on, and `openai@7.5.0` had been warning
`EBADENGINE` on every run against a pin nobody connected to it.

**The rule this leaves:** a CI step may read the working tree or write to it, and
a step that does both while a later step audits the difference will eventually
accuse the wrong command. Green again on all three jobs, integration included.

### Postscript 2 — an audit that skipped, a backstop that was switched off, and a comment that broke the build

The frontend `npm audit` timed out on the bulk advisory endpoint on two
consecutive runs. Both builds went green with a warning nobody was going to
read. It had been written into the launch checklist as accepted an hour before
it happened again, which is a better argument for fixing it than for watching
it: a control that is present, visible and reaching nothing is this
repository's most-repeated failure, and this one was in the step whose whole
job is to notice.

The audit now retries three times with a widening pause and raised npm fetch
timeouts, and **fails** if it still could not run. Whether to break out of the
retry is decided on the *report* rather than on npm's exit code, because a
non-zero exit means either "advisories exist" or "the call failed" and only the
file tells them apart — retrying a tree that genuinely has advisories would
burn three attempts and then fail for the wrong reason.

**Writing down the justification is what found the real gap.** The argument for
letting the build go red is that npmjs.com availability should not decide
whether a merge is allowed, and it does not have to, because Dependabot watches
the committed lockfiles server-side. Enabling `.github/dependabot.yml` to make
that true revealed that **Dependabot alerts were disabled on the repository
entirely** — the backstop being cited did not exist, and nothing anywhere said
so. Alerts and automated security fixes were enabled the same day; zero open.

They are repository settings, so no test here can assert them, which is worth
stating rather than papering over: `gh api repos/<owner>/<repo>/dependabot/alerts`
returns 403 when they are off. That is the check.

The file also taught the difference between the two products sharing the name.
*Security* updates are a control. *Version* updates are housekeeping, and they
opened fourteen major-version pull requests within a minute — typescript 5 to 7,
ioredis 5 to 6, `@types/node` 22 to 26, `actions/checkout` v4 to v7 — each
costing two CI runs, three days before launch. Every limit is `0` now, which is
the documented way to stop routine upgrades while leaving security updates
running. Blanket-ignoring majors was considered and rejected: `ignore`
conditions are honoured by security updates too, so an advisory whose only fix
is a major bump would be silently suppressed, which is the same mistake in a
different place.

### The backtick trap, wearing a third disguise

The first version of the fix failed on the runner with

```
syntax error near unexpected token `` `::error::${pkg}: npm audit ...` ``
```

The gate was a `node -e '...'` inside the shell step. A comment *inside that
JavaScript* said "CI's network"; the apostrophe closed the shell string, and
every template literal after it became command substitution. A prose comment
broke a shell script. It is the trap already recorded twice — a backtick in Lua
ending the TypeScript template literal holding it, a backtick in a Python
docstring being run by the shell — and the rule it keeps proving is that
nothing which is syntax in the *host* language may appear in a string the host
is parsing. Nobody looks for that in prose.

The gate lives in `scripts/ci-audit-report.mjs` now. A file has no host, and it
runs locally, which is how all five of its outcomes were checked — clean, gated,
registry error, unparseable, absent — instead of being discovered one push at a
time.

`npm run verify:workflows` is the guard, and it is the part worth keeping. It
extracts every `run:` block from every workflow and hands it to `bash -n`, which
is exactly what the runner does before executing a step, in a tenth of a second
instead of a push. It was watched failing on the real bug before being kept, and
it carries the guard-on-the-guard this repository has now needed three times: an
extractor that matches nothing would pass every workflow ever written, so fewer
than five blocks is itself a failure.

Both retry paths were then re-tested end to end against the real step text with
a stubbed npm under `bash -e`, because `set -e` inside a retry loop is precisely
where this kind of thing stops looping without saying so: recovers on the third
attempt, fails after three.

## Phase 40 — the deployment, and what following your own runbook finds

The stack is on a box and serving. `https://karobakbak.com` answers over TLS,
sixteen migrations are applied, sign-in completes through Cognito to Google, and
two people have held a conversation on it.

The engineering was done. What this phase produced is a corrected runbook, and
the correction is the interesting part: **almost nothing that broke was the
product.** Seven defects, six of them configuration or documentation, and every
one presented as a broken build.

### The three that stopped the deployment

**`migrate` never received the env file.** Phase 38 gave `backend` and
`personas` an `env_file:` and stopped there. `migrate` calls the same
`loadConfig` over the same `assertCoherent`, so it saw the compiled-in
`IP_HASH_SALT`, refused production, and exited 1 — before a single migration
ran. `verify-config.mjs` exists to catch precisely this and did not, because
`OWN_SERVICES` listed the two services that had already been fixed. A guard
whose subject list omits a service is indistinguishable from a service that
complies.

What made it expensive is that the error is nowhere near the symptom. The stack
comes up looking healthy: postgres healthy, redis healthy, frontend healthy,
Caddy serving on 443 — and the backend healthy too, because its healthcheck is
liveness only and deliberately does not ask about the database (§10.18). The
only evidence is one `Exited (1)` line that `docker compose ps` does not show
without `-a`. It surfaces two steps later as `role "karobakbak_app" does not
exist`, which reads as a wrong command.

**The prod overlay required TLS from its own database.** It was written for a
managed PostgreSQL — `DATABASE_SSL: "true"` hardcoded, no comment — and then
also starts `postgres:16-alpine`, which ships with TLS off and no certificate.
So the file demanded of the database something the same file made it unable to
provide, and `assertTlsWhereRequired` refused to start: the check working
correctly against a configuration that was wrong. Both flags are false for a
container on this host's private bridge, with the comment naming the day they go
back — which is the day the database moves off the host, and that is a
sub-processor decision before it is a connection-string one.

**Production served a sign-in button and no sign-in.** `ACCOUNTS_ENABLED` in
`features.ts` is a compiled-in `true`, so every bundle renders the control.
`AUTH_ENABLED` is an environment variable, and `.env.prod.example` carried no
auth block at all — not the flag, not the six settings that must accompany it.
The four `/auth/*` routes were never registered and `/auth/start` answered 404.
The comment above that constant predicts this exactly: "the header offers a
button into a 404 — the failure the asymmetry below exists to avoid, so the two
ship together." They could not ship together, because one is compiled and the
other was in a file that forgot it.

### What the pages were actually saying

`content/legal.ts` transcribes long documents, and the documents it transcribed
were **templates**. Alongside the operative text they carried instructions to
whoever was filling them in, and the transcription was faithful. The published
Privacy Policy told visitors:

> If you use analytics, error monitoring or product telemetry, list those
> providers here.

followed by "For each provider, explain:" and seven bullets, and

> Do not describe the service as having "no third-party requests" if Premium
> authentication, payments, email, CDN, analytics or other third-party services
> make browser or server requests.

Three more sat elsewhere. None of them trips a placeholder check: they are
ordinary English sentences, correctly spelled, in the right register. What gives
them away is the addressee.

Worse was a section that stated the reverse of its meaning. The draft removes
four things when a Premium account is deleted and withholds seven; `PageSection`
allowed one list, so the transcription concatenated them — and the page promised
to delete the reader's tax, fraud-prevention, security, abuse-enforcement and
legal records, then said in the next sentence that it might not. Nothing was
misread. There was nowhere to put the second list. `tailBullets` is that place.

The retention schedule had a matching defect: fourteen tab-separated lines
transcribed into `body`, and HTML collapses a tab, so it published as fourteen
paragraphs reading "Ordinary conversations 30 days" with no columns and no
header. `rows` holds it as pairs.

Terms and Privacy were also the last two pages still on `SitePage` while the
other seven had moved to `EditorialShell`, so their header and footer no longer
matched anything around them.

### Deleting the guard that caught it, and replacing it

`docs/rewrite-wording/` was a mock, and `pages.test.ts` bound six shipped pages
to it — so a throwaway folder was the record of what the pages were allowed to
say. It is deleted.

But that guard was doing real work under a misleading name: what it caught was
the drafter-instruction class above. So it is replaced rather than removed, with
a check that reads the content directly and rejects a sentence addressed to
whoever is writing the page. A denylist, deliberately — "detect prose aimed at
an author" is not something a test can do, and these are the phrasings that
actually shipped.

Watched failing before being kept, which found three **false positives**: "we do
not claim ownership of ordinary messages", "we do not claim that this
confirmation verifies your age". Reader-facing sentences the guard would have
blocked. The tell is the imperative, so that pattern is anchored to the start of
a line — same words, opposite addressee, and only position separates them.

### Backups, and a restore that has been rehearsed

R2, daily, encrypted, `reported ok=true`, and restored end to end: fetched back
from the bucket, decrypted, 18 tables and 29 rows. Four traps, all now in
`GOING-LIVE.md` step F:

* **`0640` with the container's gid.** Both obvious answers are wrong in
  opposite directions. `cp passphrase.example passphrase` inherits `0644`, so it
  works first time and leaves the key that decrypts every retained conversation
  readable by every account on the host. `0600` fails the other way — the
  container runs as `postgres`, and reports `gpg: can't open ...: Permission
  denied` followed by `dump or encryption failed`, which reads as a bad
  passphrase rather than a permission.
* **Docker creates a directory for a missing bind mount, and puts it back.**
  Deleting them is not enough while the container restarts, and `up` then reuses
  the existing container with its old mount type and fails with `not a
  directory`. The container has to be removed, not stopped.
* **`restore.sh` does not create its target database**, and the failure reads as
  a connection fault.
* **A second restore into a populated database reports 83 errors that mean
  "already there"** — read after a successful run, `decrypted to a valid
  custom-format archive` followed by `83 error(s)` looks like a corrupt backup
  while the restore has in fact already succeeded.

`ops/restore-production.sh` is the recovery path as one command, and it exists
for the ordering rather than the restore. It stops `backup` **first**: a
scheduled run firing mid-restore dumps a half-loaded database, uploads it, and
`BACKUP_KEEP` prunes the good archive to make room — turning a recoverable
outage into an unrecoverable one while every log line reports success. It stops
`backend`, creates the target, and brings the stack back on every exit path. It
does not set the `karobakbak_app` password: a restored database has that role
unable to log in exactly as a fresh one does, and for the same reason.

The drill is the default and takes no arguments. `--production` types-to-confirm.

### One product change

A flaky integration test, red on a commit that changed a single markdown file
and green on the next push. `produces exactly one match when both join at the
same moment` required the loser to return `matched_elsewhere`, when `searching`
is equally correct — the loser finished its own scan and queued first, and the
winner matched it afterwards. It asserts the invariant now: one winner, one
match in Redis, and the loser is not also a winner.

### The lesson

Every verification step in `GOING-LIVE.md` that could report a false result did,
at least once:

* `security:probe` with no `--origin` connected to the load-test stack's port
  and reported eight connection refusals as failures — and, worse, two passes.
  `IDENT-1` said the forged header bought no fresh bucket over `0 opened, 60
  refused`. Nothing connected, so the assertion had nothing to be true of.
* The geo-block check told you to forge `CF-IPCountry` against the public
  origin. Cloudflare sets that header itself and overwrites what the caller
  sent, so the documented 451 is unobtainable from outside — and the run that
  "failed" proved the more valuable thing, that the header cannot be forged.
* Step E5's command contained a literal placeholder where a real string
  belonged. Run as written it returns nothing, and an empty result is that
  check's failure signal.
* The quick reference said `prod:up` rebuilds after a `git pull`. It has no
  `--build`, so it restarts the previous images while every container reports
  healthy.

Read the population before the verdict. Ask the running process, never the file
you set it in. And when a check passes, ask what it would have taken to fail.

## Phase 41 — three defects the deployment was already carrying

Phase 40 ended with the stack serving and the runbook corrected. This is the
first week of it being *used*, and the pattern from phase 40 held exactly:
three defects, none in the product, and **every one of them reported as
something else**.

### A missing profile picture that was a missing line

The report was that signing in showed no photo and that earlier commits had
had one. `git log -S AVATAR_URL` returns a single commit — the one that added
it. Nothing had been removed.

The answer came from outside the box, with no shell on it:

```bash
curl -sD - -o /dev/null https://karobakbak.com/auth/start | grep -o 'scope=[^&]*'
```

`scope=openid+email`. No `profile`, so Google never sends a picture, no
`picture` claim reaches the token, `/auth/session` answers `avatar: false`, and
the account control renders its glyph — which is an ordinary state that four
separate pieces of code handle correctly. The whole chain is silent by design,
and that is why it is invisible.

`AUTH_AVATARS` was not false. It was **absent**: `.env.prod.example` ended at
`AUTH_IDENTITY_PROVIDER`, the `.env.prod` on the droplet was written from it,
and `config.ts` defaults the setting to false. It is documented in
`.env.example` and in `SIGNIN-SETUP.md`'s table — in neither of the two places
a production deployment is actually built from. F-045 again, one phase after
phase 38 fixed the delivery mechanism: the file now reaches the container, and
this setting was never in the file.

Worth keeping: the diagnosis is a **public probe answering a private
configuration question**. The authorize redirect is visible to anyone, and it
states what the deployment asked for. That is a better instrument than reading
an env file, because it cannot be out of date.

### A redirect loop that blames your cookies

Grafana had never been opened. Through the documented tunnel it answered
`ERR_TOO_MANY_REDIRECTS`, and the browser's own advice — delete your cookies —
is a false lead.

`.env.prod.example` shipped `GRAFANA_ROOT_URL=https://karobakbak.com/grafana`,
which is wrong twice. Nothing serves that path: `ops/caddy/Caddyfile` has
exactly one route, `reverse_proxy frontend:80`, and the prod overlay binds
Grafana to `127.0.0.1` with a comment saying to reach it over an SSH tunnel
rather than publish a dashboard with an admin login to the internet. So the
template pointed at a public URL for a service the compose file deliberately
does not publish, and the two shipped together saying opposite things.

The loop itself is the sub-path. Without `GF_SERVER_SERVE_FROM_SUB_PATH=true`,
Grafana serves content at `/` and builds every redirect under `/grafana`:
`/` to `/grafana` to `/` until the browser stops. It fails identically at every
origin, which is what makes the tunnel look innocent.

The correct value is `http://localhost:3000`, because **the tunnel is the
origin the browser really sees** — the same rule `AUTH_REDIRECT_URI` follows
eighty lines above it in the same file. It is written down as that rule rather
than as a value, because the next person to read it will otherwise "fix" it
back to the real domain.

### What was left of `ui-integration`

The forty tracked files went in the phase 39 docs reorg. What stayed on disk
was the part git had been told to ignore: a 69 KB generated `dc-runtime`
bundle, a 148 KB lockfile with no `package.json` beside it, and a `.env` of
Supabase keys — dead since Supabase accounts were removed, with the only
remaining mention of that vendor anywhere being the log line recording their
removal. Deleted, and the ignore rules with it: an ignore rule for a path that
cannot exist reads as a statement that the thing is still around and
deliberately untracked.

`DEPLOYMENT.md`'s hygiene inventory still billed the directory as forty tracked
files awaiting a disposition. That row had been false since the reorg emptied
it — a table of work to do that lists work already done is read once and then
distrusted.

### Two gaps found and deliberately left open

Neither is a defect in something built; both are things never built, found by
asking what happens next.

**Alert delivery is unverified.** `alertmanager.yml` sends both receivers to
`url_file: /etc/alertmanager/webhook-url`, a gitignored file the operator
writes once. Only `webhook-url.example` is in the repository. If that file is
absent on the box, twenty-odd well-written rules fire into nothing — including
`AlertNotificationsFailing`, which is delivered through the thing that is
broken. Checked with `ls`, not assumed, and not from here: this session had no
SSH access to the droplet.

**The moderation console has no compose service.** It runs as
`npm run console` via `tsx`, from source. That was correct while nobody could
file a report. It stops being correct the moment strangers can:
`ReportsWaitingTooLong` can page about a report there is no deployed tool to
read, and persona transcripts (D-AI-12) are unreadable on the box for the same
reason. Before the traffic push, not after.

### What the persona work found without changing anything

The reported symptom, personas sending long messages, is not a prompt problem.
The guard layer applies a length limit only to the opening turns, so later
turns have no length cap and the splitter discards overflow that was generated
and paid for. An instruction in a prompt is a request; a limit belongs in the
guard layer, and one scaling with conversation depth is the shape of the fix.
It is not written yet.

### The pattern, again

Three defects, three symptoms, none of which named its cause: "the code lost my
photo", "delete your cookies", and a directory listing that had been wrong for
a week. Phase 40 said to ask the running process rather than the file you set
it in. This phase adds the cheaper version of the same idea — **ask the running
system from outside**, where a public endpoint states what a private file
configured.

---

## Phase 42 — production moves to a single host behind a Cloudflare Tunnel

The first host was retired on 2026-10-10 and production restarted from an empty
database on a single host behind a Cloudflare Tunnel. The overlay and its env
template still carry the `laptop` name in the repository.

### What was built

* **`docker-compose.laptop.yml`**, layered on base + prod, never instead of it.
  Four changes: its own project name, cloudflared in place of Caddy, no host port
  that collides with development, and a CPU and memory ceiling on every service.
* **`.env.laptop.example`**, a whole copy of the prod template rather than a diff,
  because compose takes one `--env-file` and a missing value is not inherited —
  it falls to the compiled-in default.
* **`laptop:*` scripts** and start/stop scripts (since replaced, see below). Start asks
  the *public* origin whether it is ready, because a healthy container behind a
  dead tunnel is an outage; stop keeps the data and has no way to delete it.
* **`verify-config` section 4**: every env template names itself in
  `APP_ENV_FILE`; every setting in the prod template exists in the laptop one;
  and the laptop overlay has a project name that is not the development one.
  Each check was watched failing before being kept.

### Decisions, and the reasons that are not obvious

**The project name is the safety property.** Without `name:` the overlay's
project is named after the directory — `karobakbak` — which is exactly what
`npm run up` uses for development. A development `up` would have recreated the
live containers with development configuration, and a development `down -v`
would have deleted the live database, with nothing asking first. The existing
`prod:*` scripts have the same property, which was harmless on a box that ran
nothing else and is a trap on a shared one.

**`MAX_CONNECTIONS` is set explicitly, because a CPU quota is invisible to Node.**
`availableParallelism()` honours a cpuset and not a CFS quota, so a backend with
a CPU quota still sees every host core and derives too high a ceiling. Past an
explicit ceiling, newcomers get the "busy" path rather than everybody getting a
slow site.

**Caddy is parked, not removed** — an overlay cannot remove a service. And its two
required variables still have to be set, to placeholders, because compose
interpolates every `${VAR:?}` in every file *before* it applies profiles. Found by
rendering the config rather than reading it.

**HSTS came from Caddy and nothing else.** nginx does not send it, so moving TLS to
Cloudflare drops it silently unless it is enabled in the dashboard. It is a step in
the procedure for that reason.

**`TRUST_PROXY_HOPS` changes with the topology**: Caddy was a hop and cloudflared
passes `X-Forwarded-For` through. The procedure measures it from nginx's access
log rather than trusting the derivation, because `security:probe` cannot tell a
correct count from one that is too *low*.

### What the move made better

The origin is now reachable only through the tunnel, with no inbound port, so
every request passes through Cloudflare and its `CF-IPCountry` header.

### Addendum — development and production are different projects everywhere

The first cut put `name: karobakbak-live` in the laptop overlay only. The
operator asked for the separation to be general, so it now lives in the files
every stack is built from: the base compose file is **`karobakbak-dev`** and
`docker-compose.prod.yml` overrides it with **`karobakbak-live`** (compose takes
the last file's `name:`; `-p` still beats both, which keeps the load-test, rig
and Sentinel stacks as they were). The laptop overlay inherits rather than
repeating it. Production containers are `karobakbak-live-<service>-1` on any
host, so every deployment document now names the same containers.

Three things the rename turned up:

* **Alloy shipped every compose container on the engine**, on the assumption
  that this stack was the only one. On a shared engine each stack's Loki would
  have held the others' logs — development traffic on the live dashboards. It
  now filters on its own project, read from `COMPOSE_PROJECT_NAME`, which
  compose fills for interpolation from the file's name or `-p` (checked for all
  three). `alloy validate` passed a deliberately misspelled function, so the
  change was checked by running Alloy against the Docker socket instead — clean
  with the real config, a loud failure with the broken one.
* **Git Bash rewrites any argument beginning with `/`** into a Windows path.
  Every `docker exec <c> grep ... /usr/share/...` in the procedure would have
  found nothing — which is precisely the stale-bundle signal — and the restore
  script's `--entrypoint /usr/local/bin/restore.sh` would have failed to start.
  The procedure exports `MSYS_NO_PATHCONV=1`; the script sets it itself.
* **The restore script hard-coded `.env.prod` and the two-file stack**, so on the
  tunnel host it would have refused to start for want of a file. It now picks the env
  file that exists and adds the laptop overlay when that file is `.env.laptop`.

Existing development data sits in volumes named `karobakbak_*` from before the
rename and is no longer attached to anything; `npm run up` starts with fresh
`karobakbak-dev_*` volumes.

### Addendum — the launcher

The start and stop scripts are replaced by a launcher built from
`ops/laptop/launcher/` (gitignored output). It runs about twenty-five
pre-checks (any FAIL stops it before anything starts, and each names the fix),
starts the stack, and calls it live only when `/ready` answers through
Cloudflare.

The required-settings check reads every `${NAME:?}` out of the three compose
files rather than keeping its own list, so a variable added later is checked
without anybody remembering this program exists.

It also gives `karobakbak_app` its password on a fresh database, because that is the step whose omission looks like a broken
build. The password goes to `psql` over stdin, never on a command line or in
the app's log, and it is applied only when the role cannot log in or the backend
reports the password wrong.

Its first run against the real checkout found two things. `ops/backup/rclone.conf`
defines `[drill]` — the MinIO rehearsal — and no `[r2]`, so with the shipped
`BACKUP_REMOTE=r2:<backup-bucket>` every upload would have failed and backups
would have stayed on the host. That check began as a warning and is now a
failure, matched against whichever remote `BACKUP_REMOTE` names.

### Addendum — the deletion worker had never finished a pass

The first alert to reach the operator through a working pipeline was
`RetentionDeletionFailing`: `42501` (permission denied) from the deletion worker.
It runs as `karobakbak_app`, which `002_roles.sql` gives select and insert on
`admin_audit` and nothing more — the audit log is append-only by grant (I11) —
and it issued `delete from admin_audit`. PostgreSQL checks privileges before it
examines a row, so the step failed on every pass, expired rows or not, from the
first deployment in September.

The steps before it ran, so expired messages, conversations, reports, moderation
events and enforcement records were deleted on time. Audit expiry never ran, and
neither would the payment-order sweep after it. The staged `011_payments.sql`
says of the chat role "it may not delete from either table", so the same failure
was waiting for the day payments launched.

**Fix: a function, not a grant.** `018_audit_expiry.sql` adds
`expire_admin_audit(batch)` — `SECURITY DEFINER`, search path pinned to the schema
then `pg_temp`, EXECUTE revoked from PUBLIC and granted to the chat role only —
which deletes rows whose own `retention_expires_at` has passed and nothing else.
`011_payments.sql` gains `expire_payment_orders` on the same pattern. A delete
grant would have fixed the pass and let the chat process erase the record of who
read which conversation, which is the only control left on browsing persona
transcripts (D-AI-12).

**Why the suite never saw it:** every integration test connects as a superuser.
`deletion.test.ts` now runs whole passes as `karobakbak_app` through `set role`,
and those tests were watched failing against the old worker before being kept.
The console role is asserted unable to call the function.

## Phase 43 — personas that answer what was said

A live conversation: "hi" got "haan and you?", and replies landed against the
wrong message. Decision record D-AI-13.

### What was wrong

* **The model voice kept a history the stranger never saw.** Every generated
  reply was recorded, including ones the client abandoned when the stranger
  typed again, and whole replies the client had cut to a sentence. The model
  continued from lines that were never delivered.
* **The prompt was eighty rules with no example**, several pulling against
  each other, and nothing told the model what kind of turn it was answering.

### What was built

* **The client owns the transcript** (`VoiceTurn.transcript`), written as each
  bubble is sent. The voice keeps nothing. A burst is answered once, after
  `PERSONA_COALESCE_MS` (1.8s) of quiet.
* **Jev, TypeSafe's decision model** (`personas/jev.ts`): hosts in order, one
  attempt each, a per-host breaker, and `null` for every failure.
* **The judge** (`personas/judge.ts`): the turn kind, four incoming safety
  flags, and an outgoing relevance and safety check — from Jev when it answers,
  from rules (`ruleKind`) when it does not.
* **The guard** ORs Jev's flags onto its word lists, never instead of them, and
  regenerates a draft once when Jev is confident it does not answer the
  stranger.
* **The prompt** is five ordered rules, worked examples including a Hinglish
  one, and a list of what bad looks like — "hi" / "haan and you?" first.
* **Metrics:** `chat_persona_judge_calls_total{host,outcome}`,
  `chat_persona_judge_latency_seconds`, `chat_persona_regenerated_total`. Jev
  spend rides the existing token and cost series as provider `typesafe`.

### To turn it on

Set `JEV_API_KEY` in the live env file and restart the personas service. With
no key, everything above except Jev itself is live: the transcript fix, burst
coalescing, the rewritten prompt and the rule-based turn reading.

## Phase 44 — reported conversations get an urgency, in shadow

Reports queued by arrival, so an urgent one waited behind older ones. Decision
record D-AI-14.

* **`admin/triage.ts`** — the console process reads open, untriaged reports'
  conversations, audits each read first (`system:jev-triage`), and asks Jev for
  urgency, category and a possible-minor signal.
* **`019_report_triage.sql`** — the verdict as columns on `reports`, so it
  shares the report's retention, hold and deletion.
* **Console** — an urgency chip per report, labelled `jev` with its confidence
  or `rules` when only the reporter's category is known, plus a possible-minor chip.
* **Shadow mode** — `JEV_TRIAGE_SORT=false` keeps the queue oldest-first. Turn
  it on after a week of comparing verdicts with your own reading.
* **Config** — Jev's settings moved from `personas` to a top-level `jev`, since
  two processes use it now. Variable names are unchanged.

Only reported conversations are sent. Ordinary chats never leave the server.

## Phase 45 — the profile picture survives a restart

Reported: signed in, refreshed, no picture. The sign-in credential is in
PostgreSQL and survived the stack restart ten minutes after sign-in; the
picture URL was cached only in Redis, which has persistence off (D12), and did
not. Every host restart lost everybody's picture.

* **`020_credential_picture.sql`** — `account_credentials.picture_url`, https
  and at most 2,048 characters by constraint. On the credential, not the
  account: it is one browser's sign-in, already expires on its own, and
  `accounts` still holds nothing describing a person. The chat role gains
  `update (picture_url)` and nothing else.
* **Mint, resolve, revoke** — the URL is written with the credential, read back
  by `resolveAccount`, and cleared by sign-out. `mintCredential` drops a URL
  the constraint would refuse rather than letting it fail the sign-in.
* **Expiry** — the deletion worker clears the URL from expired or revoked
  credentials each pass, as the chat role. Not a `DeletionCounts` entry: nothing
  is deleted, and `chat_retention_deleted_total` would say otherwise.
* **Redis** — `chat:avatar:{accountId}` is gone, with its write on sign-in and
  delete on sign-out.
* **Console healthcheck**: the image's check probes the backend's port, not the
  console's, so it reported unhealthy while working. Overridden in compose, as
  `personas` already was.

A browser signed in before this has no URL until it signs in once more.

## Phase 46 — dev and prod are two directories, and prod deploys by a button

Production ran from the working copy, deployed by hand with `laptop:up`, with
no record of what was live and no way back but memory. Development edited the
same directory the live bind mounts read.

* **Two directories.** The working copy is development (`karobakbak-dev`); the
  live checkout (for example `%USERPROFILE%\karobakbak-live`) is a clone nobody
  edits, holding the live secrets and checked out at whatever was deployed.
* **`deploy` workflow** (`workflow_dispatch`, ref `main` / SHA / `live-*` /
  `previous`) on a self-hosted runner that long-polls GitHub outbound, so
  nothing connects in. The runner is registered only to a private deployment
  repository, never to a public one.
* **`ops/laptop/deploy.mjs`** refuses a dirty live checkout and any commit
  `verify.yml` has not passed, warns when a rollback crosses a migration,
  rebuilds with the profiles already running, waits for health, checks the
  public origin, and tags `live-YYYY-MM-DD-HHMM` (IST).
* Merging to `main` still deploys nothing. Manual on purpose: an unchosen
  restart mid-conversation costs more than a wait.

`DEPLOY.md` is the runbook.

## Phase 47 — a Friends drawer, last-active, and Chat with a friend

Friends were a popover above the composer, visible only while chatting or
searching, and could say "online" or nothing. Now:

* **Header button** beside the avatar (signed in only) with a green count of
  friends online, opening a **drawer from the left** on every screen.
* **Last-active** (D65, reverses "no last-seen, ever"): `021_last_active.sql`
  adds `accounts.last_active_at`, stamped to the hour from the heartbeat at most
  once an hour, unawaited. Sent only as a bucket ("3 hours ago" … "1 year ago"),
  only while the friend shares presence, and only to a viewer who shares their
  own. Turning sharing off erases it.
* **Chat** on an online friend: `/auth/reconnect/ask` takes a connection handle,
  resolves it against the caller's list, reaches the friend only through the
  visibility key, and limits one ask per friend per minute. The request names
  the asker with the recipient's own label for them.
* **Blocking a friend removes the friendship** (live block and Block on a
  request; a late block cannot name an account).
* Rename and **Remove friend** sit behind a labelled ⋯ menu on each row, and
  removing asks once, inline in the row (§31.4). Block is still unconfirmed.
* The presence toggle now says that it hides last-active too and that hiding
  is mutual. `storage.test.ts` now pins the exact `accounts` columns the chat
  role may update — it was described as asserted and was not.

## Phase 48 — link previews and the basics of search

Nobody was visiting, and the site did nothing to help the links that would
bring them: a shared link was bare text, the tab said only "karobakbak", every
page had the same title, and `robots.txt` and `sitemap.xml` answered with the
app's HTML.

* **Preview card** in `index.html` (Open Graph and Twitter tags, canonical)
  with `public/og-image.png`, rendered from `docs/brand/og-card.html`. Static,
  because the crawlers that build cards do not run script.
* **Per-page title, description and canonical** from one table, `src/meta.ts`,
  applied by `Root` on every navigation; a 404 — and Premium and Support while
  nothing can be bought — get `noindex`.
* **`public/robots.txt` and `public/sitemap.xml`**. `meta.test.ts` holds the
  sitemap to exactly the indexable pages in `meta.ts`, every static page to an
  entry there, and the shipped image to the size the tags declare.

## Phase 49 — dormant accounts are deleted

`010_accounts.sql` described an account deadline "extended on use" and a sweep
that read it; neither existed. The deadline was the payment records' seven
years from creation, never moved, and nothing deleted anything — so accounts
lived for ever, and a sweep alone would have removed every account seven years
after it was made, active or not.

* **`AUTH_ACCOUNT_RETENTION_DAYS`** (default 365), restamped on every sign-in.
  A session lasts at most thirty days, so active users always sign in again
  first; `assertCoherent` refuses a period no longer than a session.
* **`expire_accounts`** (`022_account_expiry.sql`), a `SECURITY DEFINER`
  function the deletion worker calls as the chat role, which may not delete
  from `accounts`. Credentials, friendships, labels and block records cascade.
  Suspended accounts are kept.
* Existing accounts restamped to a year after their last sign-in, never later.
* Tested as the chat role: an expired account goes with everything hanging off
  it, a current one and a suspended one stay, and a plain delete is still 42501.

## Phase 50 — the public copy stops promising text only

The operator plans to add photos and voice calls, so the site no longer sells
itself as text only. Page title, meta and Open Graph descriptions, the link
preview card (re-rendered from `docs/brand/og-card.html`), the About section
"Text only, on purpose" (now "Just the conversation"), its specimen label and
the FAQ answer on photos ("Not yet.") all changed. The product is still text
only and nothing here changes that; `DESIGN.md` §23 and the protocol are
untouched.

