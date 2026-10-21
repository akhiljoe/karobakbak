# Deep Codebase Audit

Status: **complete**. Ten batches, 32 findings, Phases 0-10.

**Remediation in progress.** The eleven findings marked **Fixed** below were addressed
in the quick-wins pass and verified against the full suite — 404 unit, 48 frontend,
401 integration, all passing. See `## Remediation Log` at the end of this document
for what changed and what running the tests turned up. Thirty-two findings now: F-030 was found by the remediation
itself, and F-031 and F-032 by the chaos scenario built afterwards. This audit creates documentation only; no source, Git state, commits, branches, or remotes are changed.

## Repository Map — Phase 0

```text
karobakbak
├── frontend/                 React 18 + TypeScript/Vite single-page client
│   ├── src/                  UI, chat hook, client state machine, protocol copy
│   └── nginx.conf            Static edge and WebSocket reverse proxy
├── backend/                  Node.js/TypeScript WebSocket service
│   ├── src/ws/               Connection, upgrade, dispatch, lifecycle, matchmaking
│   ├── src/protocol/         Shared WebSocket envelope/types/validation
│   ├── src/storage/          PostgreSQL migrations, queue, retention, deletion
│   ├── src/redis/            Redis state, Lua scripts, keys and client
│   ├── src/admin/            Admin authentication and review/enforcement console
│   ├── src/moderation/       Content-normalisation and policy rules
│   ├── src/metrics/          Prometheus registry and retention monitoring
│   └── tests/                Jest unit and integration suites
├── load-test/swarm/          TypeScript scenario/load-test framework and reports
├── monitoring/               Prometheus configuration, alerts and Grafana dashboard
├── scripts/                  Cross-package protocol verification
├── docker-compose*.yml       Local, test and production topology
└── docs/                     Product, security, operations and audit documentation
```

### Initial architecture understanding

- Product: anonymous, real-time stranger chat, using a WebSocket client/server path.
- Stateful coordination: Redis is described as authoritative for live matchmaking/session state; PostgreSQL retains moderated conversation data and administrative data.
- Deployable units: an Nginx frontend edge, a horizontally scalable Node backend, PostgreSQL, Redis, Prometheus, Grafana, and a separate migration container.
- Security-sensitive paths: WebSocket upgrade/origin and client-IP handling, anonymous identity and resume tokens, Redis Lua state transitions, moderation, retention/deletion, and privileged admin console authentication/authorization.
- Highest-priority review order: backend bootstrap/configuration → WebSocket lifecycle/identity/authorization → Redis scripts/store → persistence/retention/deletion → admin console → frontend state/protocol → infrastructure/monitoring/load tests.

### Inventory observations

- The production topology deliberately overrides development defaults and has dedicated health checks, metrics, database migrations, and a substantial test suite.
- `frontend/dist` and many recorded load-test artifacts are present; they are treated as generated/runtime evidence, not primary source for the code review.
- The checked-in `.env` file has not been opened during this review to avoid exposing any credential material; configuration behavior will be assessed from code and example files instead.

## Reviewed Files

| Batch | Files | Status |
| --- | --- | --- |
| 0 | Root/backend/frontend manifests; Compose, Docker, Nginx configuration | Inventory complete |
| 1 | `backend/src/index.ts`, `server.ts`, `config.ts`, `logger.ts`, `ws/upgrade.ts`, `ws/connection.ts`, `util/ids.ts` | Complete; lifecycle and store behavior deferred to Batch 2 |
| 2 | `backend/src/ws/lifecycle.ts`, `subscriber.ts`, `dispatch.ts`, `registry.ts` | Complete; Redis-script atomicity deferred to Batch 3 |
| 3 | `backend/src/redis/keys.ts`, `scripts.ts`, `store.ts`, `ws/janitor.ts` | Complete; message delivery/moderation and retention deferred to Batch 4 |

## Findings Ledger

| ID | Severity | Category | Location | Finding | Status |
| --- | --- | --- | --- | --- | --- |
| F-001 | MEDIUM | Security / Privacy | `backend/src/config.ts:662,806` | Production accepts a public default used to hash IPs and client tokens; it only logs a warning. | **Fixed** |
| F-002 | HIGH | Reliability | `backend/src/server.ts:474-491` | An unhandled async reconnect task can terminate the Node process when Redis fails. | **Fixed** |
| F-003 | HIGH | Reliability / Resource Management | `backend/src/redis/store.ts:344-346` | A post-match `HSET` can resurrect an already-ended match without TTL or janitor membership. | **Fixed** |
| F-004 | HIGH | Safety / Correctness | `backend/src/ws/messages.ts:125-135` | Hard-blocked messages and their moderation evidence are never retained. | **Fixed** |
| F-005 | HIGH | Safety / Reliability | `backend/src/storage/queue.ts:82-99` | A P0 record from an under-quota session evicts another session's acknowledged P0 and still returns `accepted`. Confirmed in Batch 9; see F-023. | **Fixed** |
| F-006 | MEDIUM | Privacy / Configuration | `backend/src/index.ts:47-50` | `SPOOL_BACKEND=redis` is accepted but ignored; the service always writes a plaintext file spool. | **Fixed** |
| F-007 | HIGH | Privacy / Legal hold correctness | `backend/src/storage/deletion.ts:150-215` | A conversation hold protects only the conversation row: messages, reports, moderation events and enforcement all expire underneath it, and two of those tables have no `legal_hold` column at all. Widened in Batch 9. | **Fixed** |
| F-008 | CRITICAL | Authorization / Correctness | `backend/src/admin/enforce.ts:252,275` | Ban revocation treats an unvalidated enforcement ID as a SQL `LIKE` pattern and can revoke many or all bans. | **Fixed** |
| F-009 | HIGH | Correctness / Reliability | `frontend/src/state/machine.ts:342` | `partner_left` clears the resume token for the whole session, disabling §28 resumption for every later conversation, and does so even for stale frames. | **Fixed** |
| F-010 | HIGH | Correctness / UX | `frontend/src/view/presentation.ts:63-65`; `frontend/src/App.tsx:86` | A dropped socket routes the user to the landing screen, so the conversation UI, the reconnect banner and the connection pill are unreachable during a reconnect. | **Fixed** |
| F-011 | MEDIUM | Correctness / UX | `frontend/src/components/ReconnectBanner.tsx:4-7,25`; `frontend/src/hooks/useChat.ts:9-14` | Copy and file headers still state the D7 rule that reconnecting ends the conversation, which D42 reversed. | **Fixed** |
| F-012 | MEDIUM | Correctness / UX | `frontend/src/App.tsx:68` | Escape closes an open dialog *and* skips the conversation, because the global handler is not suppressed while a modal is open. | **Fixed** |
| F-013 | MEDIUM | Security / Privacy | `frontend/security-headers.conf:8` | `connect-src 'self' ws: wss:` permits a WebSocket to any host, leaving an unblocked exfiltration channel for retained plaintext. | **Fixed** |
| F-014 | MEDIUM | Reliability / Scalability | `frontend/src/hooks/useChat.ts:126-129` | Reconnect backoff has no jitter, so every client dropped by one event retries in lockstep. | **Fixed** |
| F-015 | MEDIUM | Operational | repository root (no `.github/workflows`) | Nothing mechanically enforces `npm run verify`, the protocol drift check, or the tests. | **Fixed** |
| F-016 | LOW | Privacy / Accuracy | `frontend/src/components/LandingScreen.tsx:129` | "Nothing kept after you leave" contradicts the retention notice in the footer of the same screen. | **Fixed** |
| F-017 | LOW | Maintainability | `frontend/src/state/machine.ts:190,342`; `frontend/src/hooks/useChat.ts:28` | A reducer documented as pure performs `sessionStorage` I/O, and `saveResumeToken` is imported into `useChat` but never used. | **Fixed** |
| F-018 | HIGH | Observability / Reliability | `monitoring/prometheus/alerts.yml:9-15` | `BackendDown` cannot fire when the backend vanishes, because DNS discovery removes the target and `up == 0` matches nothing. | **Fixed** |
| F-019 | HIGH | Observability | `backend/src/metrics/registry.ts:156-227` | Ten declared metrics are never incremented, including `chat_matchmaking_latency_seconds`, which drives three dashboard panels. | **Fixed** |
| F-020 | MEDIUM | Observability / Operational | `monitoring/prometheus/alerts.yml:44,58` | Alert thresholds hardcode configuration defaults, and the spool's byte ceiling has no alert at all. | **Fixed** |
| F-021 | LOW | Observability | `backend/src/metrics/registry.ts:133` | The application's `instance` label is renamed to `exported_instance` by the scrape, contradicting the comment that relies on it. | **Fixed** |
| F-022 | LOW | Security | `backend/src/server.ts:160-165`; `frontend/nginx.conf:84-92` | `/health` is publicly proxied and reports the instance id and draining state. | **Fixed** |
| F-023 | HIGH | Testing / Safety | `backend/tests/integration/retention.test.ts:401-422` | The P0-capacity test asserts a refusal the code never performs; its disjunctive assertion is satisfied by the other branch. Masks F-005. | **Fixed** |
| F-024 | MEDIUM | Testing / Privacy | `backend/tests/integration/deletion.test.ts:218-231` | The conversation-hold test counts only the parent row, so it passes on a run that deleted the whole transcript. Masks F-007. | **Fixed** |
| F-025 | MEDIUM | Testing / Architecture | `backend/tests/unit/messages.test.ts:9` | The message pipeline's unit suite uses `NullRetentionSink` throughout, so the retention half of `send()` is untested on every branch. Masks F-004. | **Fixed** |
| F-026 | HIGH | Correctness / UX | `frontend/src/state/machine.ts:422-434`; `backend/src/server.ts:507-516,580-589` | A refused `join_queue` (rate limit or name moderation) sends no `queue_status`, so the client shows the search overlay forever. | **Fixed** |
| F-027 | MEDIUM | Observability / Correctness | `backend/src/ws/janitor.ts:113-133`; `backend/src/server.ts:104-110` | `chat_active_matches` and `chat_queue_depth` are written only by the janitor lock holder; followers' series freeze and the dashboard's `max()` reads them. | **Fixed** |
| F-028 | MEDIUM | Protocol / UX | `backend/src/ws/messages.ts:149-190` | `message_ack.delivered` reports the moderation verdict only, so a message sent into the resume grace window is acked delivered and rendered "sent". | **Fixed** |
| F-029 | HIGH | Privacy / Data retention | `backend/src/storage/deletion.ts:81-88,137` | The deletion worker runs one 500-row-per-table pass per hour and discards its own `more` flag, so expired data accumulates without bound and no alert can see it. | **Fixed** |
| F-030 | LOW | Observability | `backend/src/storage/deletion.ts:246-249` | `chat_retention_deleted_total{table="messages"}` counts only explicit deletions; rows removed by `on delete cascade` are invisible, so the dashboard understates message deletion. | **Fixed** |
| F-031 | HIGH | Reliability | `backend/src/storage/pool.ts:163-180` | A failed transaction always issues a `ROLLBACK`, including down a connection whose statement already timed out with no answer. The rollback waits out the same deadline again, so every failure during a database hang costs two timeouts instead of one and the circuit breaker needs twice the outage before it can open. The same block releases the timed-out client bare instead of destroying it, returning a connection with an open transaction to the pool. | **Fixed** |
| F-032 | HIGH | Data retention / Safety | `backend/src/storage/retention.ts:369-375,463-478` | One record whose parent conversation had not landed yet destroyed every record sharing its batch. The missing-parent branch deferred, retried and discarded the *whole group*, never narrowing to the offending row the way the branch beside it does; and the spool drain discarded its entire batch on any permanent error, with no salvage at all. A chaos run lost 345 P0 records to twelve single-row foreign-key violations. | **Fixed** |

## Batch 1 — Backend Bootstrap, Process Boundary, and Upgrade Inputs

Files reviewed completely:

- `backend/src/index.ts`
- `backend/src/server.ts`
- `backend/src/config.ts`
- `backend/src/logger.ts`
- `backend/src/ws/upgrade.ts`
- `backend/src/ws/connection.ts`
- `backend/src/util/ids.ts`

### Findings

## [MEDIUM] Production permits the known default IP hash salt

Location: `backend/src/config.ts:662,806`; used at `backend/src/server.ts:243-245`

Category: Security / Privacy

Problem: `IP_HASH_SALT` defaults to the literal `change-me-in-production`. Under `NODE_ENV=production`, `loadConfig` accepts that value and `configWarnings()` only emits a log warning. The server immediately uses it for the IP and client-token hashes that key rate limits, blocks, and enforcement checks.

Why it matters: The salt is the control that makes these otherwise low-entropy identifiers non-reversible and non-linkable outside the trusted boundary. A public default makes hashes of candidate IP addresses and client tokens reproducible by anyone who obtains them through a database, Redis, backup, diagnostics, or an accidental log. It also removes a deployment safety net for direct Node/Kubernetes-style deployments that do not use the production Compose override (which does require the variable).

Evidence: The production Compose file requires `IP_HASH_SALT`, but the application configuration itself deliberately permits the default and the unit test at `backend/tests/unit/config.test.ts:341-351` asserts warning-only behavior.

Failure scenario: A production deployment starts `node dist/index.js` with `NODE_ENV=production` but no `IP_HASH_SALT`. It remains available and stores deterministic hashes using the checked-in string. A later data exposure lets an attacker test candidate IPs or tokens offline and correlate affected records.

Recommendation: Reject the known default and an empty/insufficient salt in production, rather than warning. Keep development convenience by retaining the default only outside production. Add a test that `loadConfig({ NODE_ENV: 'production', ... })` throws when the salt is omitted or equal to the placeholder.

Confidence: High

### Key observations

- The bootstrap is explicit about dependency ordering, and signals drain sockets before stopping storage dependencies.
- Readiness is correctly scoped to Redis—the dependency required for chat state transitions—while liveness remains process-level.
- The WebSocket upgrade path validates path, draining state, origin, capacity, enforcement, and session creation before socket attachment. Client-derived identifiers are server-minted or salted hashes; message frames do not choose routing identity.
- The structured logger recursively redacts high-risk field names and prevents circular/non-serialisable log fields from terminating the process.

### Dependency question carried forward

None from Batch 1.

## Batch 2 — Session Lifecycle and Cross-Instance Delivery

Files reviewed completely:

- `backend/src/ws/lifecycle.ts`
- `backend/src/ws/subscriber.ts`
- `backend/src/ws/dispatch.ts`
- `backend/src/ws/registry.ts`

## [HIGH] An unhandled reconnect task can terminate the backend process during a Redis failure

Location: `backend/src/server.ts:474-491`; dependency behavior at `backend/src/ws/lifecycle.ts:266-293`

Category: Reliability / Availability

Problem: `attach()` launches an async IIFE with `void` and no rejection handler. For a resumed conversation it awaits `lifecycle.restoreMatch()` and then `lifecycle.announceReturn()`. Both call `store.readMatch()` and do not catch errors. A Redis transport error or command timeout therefore rejects the detached promise.

Why it matters: In the supported Node 20 runtime, an unhandled promise rejection is surfaced as an uncaught exception by default. A transient Redis failure affecting one reconnect can therefore kill the whole backend worker, rather than degrading just that resumed conversation. Restarting replicas amplifies the incident through connection churn and further resume attempts.

Evidence: The upgrade flow intentionally accepts a resumed socket before this task runs; `restoreMatch()` has no catch around `await this.store.readMatch(matchId)` and `announceReturn()` repeats the same operation. The normal event and close paths have explicit error handling, making this detached task an exception to the process's reliability model.

Failure scenario: Redis is briefly unavailable after `lifecycle.resume()` succeeds but before `restoreMatch()` runs. The client’s socket attaches; `readMatch` rejects; no handler observes the IIFE’s promise; the process exits under Node’s default unhandled-rejection behavior.

Recommendation: Attach an explicit catch to the task. Log only non-sensitive context, avoid sending a misleading restored state, and either keep the resumed socket usable without the restored frame or close it with a retryable service error. Add an integration test that forces `readMatch` to reject after a successful resume and asserts neither an unhandled rejection nor process termination.

Confidence: High

### Key observations

- Lifecycle transitions correctly separate committed Redis state from best-effort notification delivery. The dispatcher catches publish failures rather than rolling back state.
- Pub/Sub subscription happens before a session becomes matchable, avoiding a real cross-instance race. Registry removal is identity-safe against late close handlers.
- Match-resume restoration gracefully handles absent/malformed old match identity data, but Redis errors are intentionally propagated; the server-side detached caller must handle them (F-002).

### Dependencies to review next

- `RedisStore` and its Lua scripts are the authoritative implementation of session, resume, connection-slot, block, and match atomicity.
- Retention enqueue return values are ignored in several lifecycle paths; the retention queue/spool policy must be examined before judging evidence-loss risk.

## Batch 3 — Redis Authoritative State and Recovery

Files reviewed completely:

- `backend/src/redis/keys.ts`
- `backend/src/redis/scripts.ts`
- `backend/src/redis/store.ts`
- `backend/src/ws/janitor.ts`

## [HIGH] A post-match write can resurrect an untracked Redis match with no expiry

Location: `backend/src/redis/store.ts:344-346`; invoked by `backend/src/ws/lifecycle.ts:614-618`; match teardown at `backend/src/redis/scripts.ts:106-118`

Category: Reliability / Resource Management / Privacy

Problem: Match creation and teardown are atomic Lua transitions, but the display-identity write happens later as a plain `HSET`. If a socket closes or a concurrent end/block transition deletes the match after `tryMatch` creates it but before `saveMatchIdentities()` executes, Redis recreates the deleted hash containing only `identA` and `identB`. This new hash has neither the original expiration nor membership in the `matches` set.

Why it matters: The janitor only discovers matches through `matches`; it cannot see this recreated key. The result survives until Redis is manually flushed/restarted, retaining per-conversation display/profile data indefinitely and consuming Redis memory. Repeated fast disconnects can accumulate these orphan hashes until the configured `noeviction` Redis instance runs out of memory, disrupting the state service that the chat path depends on.

Evidence: `endMatchInline` deletes `kMatch(mid)` and removes `mid` from `kMatches()`. `RedisStore.saveMatchIdentities()` subsequently calls `HSET` directly, which creates a hash if absent, but it does not check the match’s existence, verify `a`/`b`, restore an expiry, or re-add it to the janitor set. Existing janitor tests cover a missing record *for a set member*, not a record recreated after set membership was removed.

Failure scenario: Two clients match. Before the winning lifecycle task completes the profile/identity write, one WebSocket drops and its close path ends the match. The pending `HSET` arrives afterwards, re-creating `chat:match:<id>` with only serialised identity fields. No ordinary state path or janitor pass removes it.

Recommendation: Make the identity update an atomic conditional Redis script that updates only a still-live match and preserves its existing TTL. It should return an `ended/not_found` outcome rather than creating the key. Add an integration race test that ends the match before the identity write and asserts the match key does not exist and has no persistent residual data.

Confidence: High

### Key observations

- The principal session, queue, matching, block, rate-limit, and teardown transitions are correctly centralised in Redis Lua scripts. This is a real architectural strength for multi-instance correctness.
- `ScriptRunner` correctly retries on `NOSCRIPT`; Lua reply parsing is contained in the store adapter rather than spread through callers.
- The janitor refreshes an instance beacon on every interval, including followers, and is defensive about Redis failures. It cannot collect data that is no longer present in its `matches` discovery set (F-003).

### Dependencies to review next

- `ws/messages.ts` controls message delivery, moderation outcomes, deduplication semantics and retention enqueue priorities.
- Retention queue/spool behavior must be reviewed together with message and report handling, including database-outage behavior.

## Current Batch

Batch 4 will review `backend/src/ws/messages.ts`, `backend/src/moderation/index.ts`, `normalise.ts`, `policy.ts`, and `rules.ts`, then trace enqueue behavior into storage. This follows the highest-risk user-content and retention flow.

## Batch 4 — Message, Moderation, and Retention Pipeline

Files reviewed completely:

- `backend/src/ws/messages.ts`
- `backend/src/moderation/index.ts`
- `backend/src/moderation/normalise.ts`
- `backend/src/moderation/policy.ts`
- `backend/src/moderation/rules.ts`
- `backend/src/storage/sink.ts`
- `backend/src/storage/queue.ts`
- `backend/src/storage/retention.ts`
- `backend/src/storage/spool.ts`
- `backend/src/storage/pool.ts`

Batch complete.

## [HIGH] Hard-blocked messages are never sent to the retention pipeline

Location: `backend/src/ws/messages.ts:125-135`; retention call at `backend/src/ws/messages.ts:189-190`

Category: Safety / Correctness / Observability

Problem: When moderation returns `action === 'block'`, `send()` logs rule metadata and immediately returns `withheld`. The sole call to `persist()`, which enqueues both the message body and per-rule `moderation_event` records, is below that return. Therefore hard-blocked content is neither retained nor recorded as a moderation event.

Why it matters: Hard-block rules represent the highest-confidence, highest-severity policy matches. Dropping this evidence prevents operators from investigating the most serious abuse, measuring rule accuracy, or linking it to reports/enforcement. It also contradicts the declared outcome contract: `MessageOutcome` describes a withheld message as “accepted and recorded but not handed on.”

Evidence: The early return at lines 125-135 executes before the `persist()` invocation at lines 189-190. `persist()` is the only location in this module that submits `message` and `moderation_event` records to the retention sink.

Failure scenario: A user sends content matched by a configured hard-block rule (for example a prohibited contact or deny-list rule). The partner does not receive it, but no retained message or moderation-event record exists for review, leaving the enforcement team without the key evidence that caused the policy action.

Recommendation: Enqueue the message and its moderation events before returning the hard-block outcome. Preserve the current no-delivery behavior. The retention implementation should determine the appropriate priority, but the pipeline must not bypass it. Add a unit test covering an `action: 'block'` verdict and asserting both record types are enqueued.

Confidence: High

## [HIGH] Previously acknowledged P0 safety records can be evicted when the queue is full

Location: `backend/src/storage/queue.ts:83-106`; acknowledgement handling at `backend/src/server.ts:410-431`

Category: Safety / Reliability

Problem: When the P0 queue is full, `RetentionQueue.enqueue()` normally evicts the oldest P0 record and accepts the incoming one. `RetentionWriter.enqueue()` consequently returns `{ accepted: true }`. The report handler acknowledges a report whenever its own `enqueue()` call is accepted. The user whose older report was displaced has already been told it was recorded, but its evidence is later dropped.

Why it matters: P0 is explicitly the safety-evidence class and reports are acknowledged only to avoid misleading users. Under a database outage plus report pressure, the system turns a visible refusal for the newest report into a silent loss of earlier reports. Anonymous users can create fresh sessions, so the per-session quota does not protect the global P0 lane from broad report flooding.

Recommendation: Treat P0 differently from lower priorities: never evict an existing P0 record. Refuse the incoming P0 record when full, so the caller can report a retryable failure honestly. Preserve eviction behavior only for non-P0 records if desired, and add tests for a full P0 lane with reports from multiple sessions.

Confidence: High

## [MEDIUM] The configured Redis spool backend is silently ignored

Location: `backend/src/config.ts:496-500`; `backend/src/index.ts:47-50`

Category: Privacy / Configuration / Operational correctness

Problem: Configuration accepts `SPOOL_BACKEND=file|redis` and exposes `config.spool.backend`, but startup always constructs `new FileSpool(...)` whenever spooling is enabled. No Redis spool implementation exists and the selected backend is never consulted.

Why it matters: An operator who configures `SPOOL_BACKEND=redis` reasonably expects outage records not to be written to the local plaintext spool file. Instead, the process writes the file spool anyway. This can violate a deployment's storage/encryption expectation and turns a configuration choice into silent misconfiguration.

Recommendation: Either implement and select a Redis-backed spool, or remove `redis` from accepted configuration and fail startup when it is requested. Add a configuration-to-runtime test asserting each supported backend is selected.

Confidence: High

### Key observations

- The writer correctly keeps database I/O off the chat path, uses bounded queues, and distinguishes transient database failures from permanent SQL rejections before retrying/salvaging.
- Spool files use restrictive permissions and bounded capacity, but they remain plaintext by design; correct runtime backend selection is therefore privacy-significant (F-006).
- The hard-block evidence bypass identified earlier is confirmed to bypass the only message/moderation enqueue code (F-004).

## Review Checkpoint

Completed phases: Phase 0; Batches 1-4.

Reviewed files: listed in the table above.

Remaining major areas: database migrations/repositories/deletion; admin console; frontend state/protocol; deployment/monitoring; tests; load-test tooling and cross-cutting assessment.

Next recommended files: `backend/src/storage/repositories.ts`, `migrations/001_initial.sql`, `deletion.ts`, `holds.ts`, and `records.ts`. They determine persisted data shape, foreign keys, retention/deletion correctness, and administrative legal-hold behavior.

## Batch 5 — Persistence Schema, Repositories, Deletion, and Legal Holds

Files reviewed completely:

- `backend/src/storage/repositories.ts`
- `backend/src/storage/deletion.ts`
- `backend/src/storage/holds.ts`
- `backend/src/storage/records.ts`
- `backend/src/storage/migrations/001_initial.sql`
- `backend/src/storage/migrations/004_identifier_columns.sql`
- `backend/src/storage/migrations/005_admin_accounts.sql`
- `backend/src/storage/migrations/006_declared_profiles.sql`

## [HIGH] A conversation-level legal hold does not retain the conversation’s messages

Location: `backend/src/storage/deletion.ts:127-133`; hold placement at `backend/src/storage/holds.ts:58-61`

Category: Privacy / Legal hold correctness / Data retention

Problem: A conversation hold sets `conversations.legal_hold = true` only. The deletion worker deletes expired messages first using only `messages.legal_hold = false`; it does not exclude messages belonging to a held conversation. Consequently, messages can be erased while their parent conversation remains on hold.

Why it matters: A hold on a conversation is expected to preserve the evidence in that conversation. The retained conversation row without its transcript defeats investigations, report review, and any legal preservation purpose. This is the inverse of the guarded cascade implemented later in the worker, which protects a held message from its expired parent being deleted.

Failure scenario: An operator places a hold on a reported conversation but not every individual message. Once message-level retention expires, the next deletion pass removes the transcript before evaluating the held parent. The parent record survives, but the evidence that prompted the hold does not.

Recommendation: Define and implement containment semantics consistently. For a conversation hold, either cascade the hold flag to all existing and subsequently written messages/reports, or modify child deletion queries to exclude rows whose parent conversation has `legal_hold = true`. Add an integration test that holds a conversation, advances child expiry, runs the worker, and confirms all transcript rows remain.

Confidence: High

### Key observations

- All application values are parameterised in repository SQL; retention deadlines are stamped at write time and later identifier migrations correctly change the initial UUID columns to the generated text-ID format.
- The deletion worker has a good lock/failure model and protects held children from an expired parent’s cascade. The missing reverse protection is material (F-007).

## Updated Review Checkpoint

Completed phases: Phase 0; Batches 1-5.

Remaining major areas: admin console/authentication/authorization; frontend state/protocol; deployment/monitoring; tests; load-test tooling; cross-cutting and final architecture assessment.

Next recommended batch: `backend/src/admin/auth.ts`, `server.ts`, `routes.ts`, `enforce.ts`, `review.ts`, and `totp.ts`, because privileged access to retained plaintext is the remaining highest-risk trust boundary.

## Batch 6 — Admin Authentication, Review, and Enforcement

Files reviewed completely:

- `backend/src/admin/auth.ts`
- `backend/src/admin/server.ts`
- `backend/src/admin/routes.ts`
- `backend/src/admin/review.ts`
- `backend/src/admin/enforce.ts`
- `backend/src/admin/totp.ts`
- `backend/src/admin/password.ts`

## [CRITICAL] Any authenticated moderator can revoke multiple—or all—active bans with a wildcard ID

Location: `backend/src/admin/routes.ts:171-179`; `backend/src/admin/enforce.ts:252,275`

Category: Authorization / Correctness

Problem: The revoke route accepted any non-empty string as `enforcementId` and used it as an unescaped SQL `LIKE` pattern for both the database revocation and the Redis key removal, so a console session could revoke more sanctions than the one it named, and the audit row recorded only the supplied text. Fixed (see the remediation log below): the id is validated against the server-generated format and matched exactly, with regression tests in `backend/tests/integration/admin-enforce.test.ts`.

Confidence: High

### Key observations

- Password verification, TOTP replay protection, absolute sessions, cookie flags, request-body bounds, audit-before-content-read ordering, and isolated console binding are generally carefully implemented.
- Retained content reads are purpose-scoped by report and audit logged in the same transaction. The revoke endpoint breaks the same high-assurance model by accepting an unconstrained identifier pattern (F-008).

## Updated Review Checkpoint

Completed phases: Phase 0; Batches 1-6.

Remaining major areas: frontend state/protocol; infrastructure and monitoring; automated test quality/coverage; load-test tooling; cross-cutting and final architecture assessment.

Next recommended batch: frontend bootstrap/configuration, `useChat`, state machine, protocol validation/types, and the network-resume logic. This is the client half of the highest-risk reconnect/message state flow already reviewed on the backend.

## Batch 7 — Client Socket, State Machine, and Presentation

Files reviewed completely:

- `frontend/src/hooks/useChat.ts`
- `frontend/src/state/machine.ts`
- `frontend/src/resume.ts`
- `frontend/src/config.ts`
- `frontend/src/view/presentation.ts`
- `frontend/src/App.tsx`
- `frontend/src/components/ChatShell.tsx`
- `frontend/src/components/LandingScreen.tsx`
- `frontend/src/components/MessageInput.tsx`
- `frontend/src/components/ReconnectBanner.tsx`
- `frontend/src/hooks/useAutoSearch.ts`
- `frontend/src/profile.ts`, `notify.ts`, `ads/provider.ts`
- `frontend/nginx.conf`, `frontend/security-headers.conf`

Reason: this is the client half of the reconnect/resume and message flow already
reviewed on the backend (Batches 1-3), and the only place §28 resumption is
visible to a user.

Batch complete.

## [HIGH] A partner leaving disables session resumption for every conversation that follows

Location: `frontend/src/state/machine.ts:340-353`; token issuance at `backend/src/server.ts:486` and `backend/src/ws/lifecycle.ts:215-231`

Category: Correctness / Reliability

Problem: The `partner_left` case calls `clearResumeToken()`, which removes the
token from `sessionStorage`. The token is a **session** credential, not a
per-conversation one, and the server only ever hands out a replacement on the
`connected` frame. Nothing re-issues one mid-session. The clear also runs
*before* the stale-frame guard on the next line, so a late `partner_skipped` or
`partner_disconnected` for an already-finished match discards the token for the
conversation the user is in now.

Why it matters: In stranger chat, "the other person left" is the ordinary way a
conversation ends. After the first one, the tab holds no token, so the next
dropped socket cannot resume — it opens a fresh session and the live
conversation is destroyed. That is the exact failure `RESUME_GRACE_SECONDS` and
D42 exist to prevent, and it fails in the common case rather than an edge one.
The harm is doubled on the other side: the server still holds the departed
user's seat for the full grace window, so their partner sits watching a
"reconnecting" countdown for somebody who can never come back, instead of being
told the conversation ended.

Evidence: `resumeToken` appears in exactly one server frame
(`backend/src/protocol/types.ts:599`, populated at `backend/src/server.ts:327`
and `:486`), and `saveResumeToken` is called from exactly one place
(`machine.ts:190`, the `connected` case). `clearResumeToken` is called from
exactly one place, `machine.ts:342`. `user_skipped` and `user_blocked` — which
also end a conversation — do not clear it, so the behaviour is not even
internally consistent.

Failure scenario: A user talks to stranger A. A leaves; the reducer clears the
token. Auto-search matches the user with stranger B. Thirty seconds later their
phone changes network. The socket closes, `connect()` reads `null` from
`sessionStorage`, opens a plain `kbb.v1` handshake, and the server mints a new
session. Conversation B is gone, and B waits out the whole grace window.

Recommendation: Stop treating the resume token as conversation-scoped — it is
scoped to the session, and the session survives a partner leaving. Remove the
`clearResumeToken()` call from `partner_left`. If a spent token must be dropped
on a *session*-ending event, do it where the session actually ends
(`SESSION_GONE`, an explicit leave the server confirms), and always after the
stale-frame guard, never before it. Add reducer tests asserting that (a) a
`partner_left` leaves the stored token intact and (b) a `partner_left` carrying
a non-current `matchId` changes no stored state at all.

Confidence: High

## [HIGH] The conversation is dropped from the screen the moment the socket is, and every reconnect affordance is unreachable

Location: `frontend/src/view/presentation.ts:54-67`; `frontend/src/App.tsx:86,149-176`; dead branches at `frontend/src/components/ChatShell.tsx:74-76,127-132` and `frontend/src/components/ReconnectBanner.tsx:13-26`

Category: Correctness / UX / Dead code

Problem: `socket_closed` sets `screen: 'disconnected'` while deliberately
preserving `matchId` and the transcript (`machine.ts:226-242`). But
`phaseOf('disconnected')` returns `'idle'`, and `App` renders `ChatShell` only
when the phase is `searching` or `chatting`. So the instant the socket drops
mid-conversation, the user is routed to the full landing screen — headline
"Meet someone new." — and the transcript disappears from view. The reducer's own
comment says the transcript is kept precisely so the interface does not do this.

The same routing makes three components unreachable:

- `ReconnectBanner` renders `null` unless `connection !== 'connected'`, and
  `connection` is `connectionOf(state.screen)`. It is only mounted inside
  `ChatShell`, which only renders for `searching`/`chatting` — both of which map
  to `'connected'`. The component can never display anything.
- `ConnectionStatus` in the `ChatShell` header is passed the same value, so it is
  permanently pinned to "connected".
- `ChatShell`'s `reconnecting` flag (`state.screen === 'disconnected'`), its
  `selfCountdown`, and the "Reconnecting — Ns" header branch are unreachable for
  the same reason.

Why it matters: The one visible signal a user gets on a drop is a transient
toast. The screen they are looking at says the opposite — a landing page offering
to find someone new — while the server is holding their seat and their partner is
being told they are coming back. A user shown a landing screen closes the tab or
presses "Start chatting", and closing the tab clears the `sessionStorage` token,
permanently destroying a conversation that would have resumed. The countdown UI
built for §28 never runs.

Evidence: `phaseOf` maps `connecting` and `disconnected` to `idle`
(`presentation.ts:62-65`); `showShell = phase === 'searching' || phase ===
'chatting'` (`App.tsx:86`); `connectionOf` returns `'connected'` for every screen
except `connecting`/`disconnected` (`presentation.ts:35-44`). Grep confirms
`ReconnectBanner` has exactly one call site, inside `ChatShell`.

Failure scenario: Two users are mid-conversation. One switches from Wi-Fi to
cellular. Their screen replaces the transcript with the landing page; no banner,
no countdown, no indication anything is being held. They tap "Start chatting" (or
close the tab), and the resumable conversation is thrown away by the client even
though the server kept it.

Recommendation: Route on the conversation, not only on the socket. Keep the shell
mounted while `screen === 'disconnected' && matchId !== null` — for example, have
`phaseOf` take the state rather than the screen and return `'chatting'` for a
disconnected session that still holds a match — and derive `connection` so that
`ChatShell` receives `'reconnecting'` in that state. Then the existing banner,
pill and countdown all become live. Add a test asserting that a `socket_closed`
during a match still selects the chat layout and a `reconnecting` connection view.

Confidence: High

## [MEDIUM] User-facing copy and file headers still describe the reversed D7 behaviour

Location: `frontend/src/components/ReconnectBanner.tsx:1-8,25`; `frontend/src/hooks/useChat.ts:8-15`

Category: Correctness / UX / Misleading documentation

Problem: The reconnect banner's copy reads "Connection lost. Reconnecting — this
starts a new conversation.", and its doc comment states "there is no session
resumption (D7)". The `useChat` header carries a whole section titled
"RECONNECTING STARTS A NEW SESSION" that says "There is no resumption (D7) … a
dropped connection means the conversation is over" — in the very file that reads
the stored token and offers it as a `kbb.resume.` subprotocol twelve lines below.

Why it matters: The string is a promise to the user that the product no longer
keeps. Told the conversation is already over, a person stops waiting — and the
action they take (closing the tab) is the one that makes it true, because the
token lives in `sessionStorage`. The header comment is worse for maintenance: it
is the first thing a reader of the socket client sees, and it asserts the
opposite of what the code does, in a repository whose convention is that the
comment explains the decision.

Evidence: `useChat.ts:96-100` reads `loadResumeToken()` and appends
`${RESUME_PROTOCOL_PREFIX}${token}` to the handshake. `DESIGN.md` §28 / D42
reverses D7, and `CLAUDE.md` records the reversal.

Recommendation: Rewrite both comments against D42, and change the banner copy to
describe the held seat and its bounded window ("Reconnecting — your conversation
is held for a few more seconds"). Note this is only visible once F-010 is fixed;
the two should be fixed together.

Confidence: High

## [MEDIUM] Escape closes an open dialog and skips the stranger at the same time

Location: `frontend/src/App.tsx:60-72`; competing handlers at `SafetySheet.tsx:43`, `ReportDialog.tsx:45`, `SettingsSheet.tsx:46`, `FiltersModal.tsx:38`, `AuthModal.tsx:47`

Category: Correctness / UX

Problem: `App` installs a `window` keydown listener that calls `chat.skip()` on
Escape whenever the phase is `chatting`. Each dialog installs its *own* `window`
keydown listener to close itself on Escape. Neither suppresses the other: both are
bubble-phase listeners on the same target, so both run. The only exemption in
`App`'s handler is a focused `<input>`/`<textarea>`.

Why it matters: Escape-to-close is the universal dialog gesture. A user who opens
the safety sheet — the sheet somebody opens *because they are uncomfortable* — and
presses Escape ends the conversation as well. Skipping is irreversible: the match
is torn down server-side and that stranger cannot be reached again, so a report
the user was in the middle of filing loses its subject. It also silently spends a
rate-limit token.

Evidence: Five components register `window.addEventListener('keydown', …)`
handlers calling their close callback; none calls `stopPropagation`, and
`stopPropagation` on a `window`-level listener would not reliably help against
another `window`-level listener anyway.

Recommendation: Give `App` a single piece of "a modal is open" state (it already
owns all five open flags) and return early from the global handler when any of
them is set. Alternatively move dialog dismissal to a shared component that owns
the escape key and have the chat shortcut consult it. Add a test that Escape with
the safety sheet open closes the sheet and does not call `skip`.

Confidence: High

## [MEDIUM] The Content-Security-Policy permits a WebSocket to any host

Location: `frontend/security-headers.conf:8`

Category: Security / Privacy

Problem: The policy sets `connect-src 'self' ws: wss:`. The bare `ws:` and `wss:`
scheme sources match **every host**, so the connect-src restriction is effectively
absent for WebSockets. The `nginx.conf` comment above it describes the policy as
"the CSP's `connect-src 'self'`", which is not what is deployed.

Why it matters: This origin renders retained plaintext message content, and the
project's first rule is that message content never leaves the trusted boundary.
CSP `connect-src` is the control that stops injected or compromised script from
opening an outbound channel. As written, any script that executes on the page — a
supply-chain compromise in one of the frontend's dependencies is the realistic
path, since `script-src 'self'` means the bundle itself is the only script — can
open `wss://attacker.example` and stream the whole transcript out, and the browser
will permit it.

Evidence: CSP Level 3 defines `'self'` as matching the document's origin including
its `ws`/`wss` scheme upgrades, so the wildcard schemes are not needed for the
application's own socket; `useChat` derives the socket URL from
`window.location.host` by default (`frontend/src/config.ts:134`,
`useChat.ts:31-39`).

Recommendation: Drop the scheme sources: `connect-src 'self'`. Where a deployment
sets `VITE_WS_URL` to a different origin, list that exact origin instead of a
scheme wildcard, and generate the header from the same value so the two cannot
drift. Verify the socket still connects in the deployed configuration before
shipping.

Confidence: High

## [MEDIUM] Reconnect backoff has no jitter, so a restart produces a synchronised retry wave

Location: `frontend/src/hooks/useChat.ts:121-130`; schedule at `frontend/src/config.ts:143`

Category: Reliability / Scalability

Problem: The backoff table is `[500, 1000, 2000, 5000, 10_000]` and the delay is
selected purely by attempt index. Every client dropped by the same event therefore
retries at the same offsets from a common start, and the final entry repeats
forever at exactly 10s.

Why it matters: The events that drop sockets are global by nature — a rolling
deploy, a backend restart, a load-balancer change. Every connected user's client
then attempts to reconnect within a few milliseconds of each other, and each
reconnect is a WebSocket upgrade that costs a Redis session creation, a Pub/Sub
subscribe and an enforcement lookup. A server that is still coming up gets the
whole population at once, fails, and gets it again 10 seconds later, in lockstep,
indefinitely. Per-IP connection limits do not help, because the herd is spread
across every IP.

Evidence: `attemptRef.current` is the only input to the delay; there is no
randomisation anywhere in the close handler, and the backoff never gives up.
`server_shutdown` (`machine.ts:395-401`) puts every client on this path
simultaneously by design.

Recommendation: Apply full jitter — `Math.random() * base`, or
`base/2 + Math.random() * base/2` if a floor matters — and cap the tail with
jitter rather than a fixed 10s. This is a two-line change in the close handler and
materially changes what a restart costs the backend.

Confidence: High

## [MEDIUM] Nothing mechanically enforces the verification the project depends on

Location: repository root — no `.github/workflows`, no other CI definition

Category: Operational / Process

Problem: `npm run verify` chains the protocol drift check, both typechecks, the
backend unit suite and the frontend suite, and `CLAUDE.md` states that it "fails
the build if they drift". There is no build. No CI configuration exists anywhere
in the repository, and there is no pre-commit hook, so the check runs only when
somebody remembers to run it.

Why it matters: Several of this codebase's most important invariants are enforced
*by tests* rather than by types — the logger denylist, the `console.js`
`innerHTML` ban, the two-database-role separation, the ban/block namespace
separation, the byte-identity of the two protocol files. Each of those is a
control whose failure mode is silent. A control that is only checked when
remembered is not a control.

Recommendation: Add a workflow running `npm run install:all` then `npm run verify`
on push and pull request, plus a job that brings up the test Redis and PostgreSQL
services and runs `npm run test:integration` — the integration suite holds the
race tests and the database-role assertions, which are the ones least likely to be
run by hand.

Confidence: High

## [LOW] The landing screen states that nothing is kept, directly above the notice that conversations are kept

Location: `frontend/src/components/LandingScreen.tsx:127-130` and `:137-145`

Category: Privacy / Accuracy

Problem: When the user has declared a profile, the trust line reads "No signup ·
No account · Nothing kept after you leave". The footer of the same screen reads
"Conversations are kept for a limited period so abuse can be investigated, then
deleted automatically." Both are on screen at once.

Why it matters: The intended meaning is that the *declaration* is not kept
server-side, which is true and is a genuine design achievement (D34). As written,
the phrase is an unqualified retention claim, and it is the one a user will read
as the privacy promise. The file's own header comment argues against exactly this
— "claiming they vanish the moment you close the tab would be the easy lie".

Recommendation: Scope the claim to what it means: "No signup · No account · Your
profile stays on this device". Leave the retention statement to the footer, which
already says it accurately.

Confidence: High

## [LOW] The reducer is documented as pure and performs storage I/O

Location: `frontend/src/state/machine.ts:1-7,190,342`; unused import at `frontend/src/hooks/useChat.ts:28`

Category: Maintainability / Architecture

Problem: `reduce` is introduced as "A pure reducer, deliberately", and then writes
to `sessionStorage` in two cases. React may invoke a reducer more than once for
the same action (StrictMode in development, and re-basing of queued actions during
concurrent rendering), so this is a side effect on a function whose contract does
not allow one. Separately, `useChat` imports `saveResumeToken` and never calls it
— the write moved into the reducer and the import was left behind.

Why it matters: The current writes happen to be near-idempotent, so this is not
producing a live bug on its own — but F-009 is precisely a bug caused by a side
effect sitting where the ordering rules of a reducer do not protect it (it runs
before the guard that discards the action). Keeping the effect in the reducer
means the next person to add a guard has the same trap waiting.

Recommendation: Return the token in the state (`resumeToken: string | null`) and
perform the storage write in an effect in `useChat` keyed on that value. That puts
the write after the reducer has decided whether the action applies, makes the
reducer testable without a `sessionStorage` stub, and lets the tests assert token
handling as state rather than as a mock. Remove the unused import.

Confidence: High

### Key observations

- The protocol copy is currently in sync — `node scripts/verify-protocol.mjs`
  reports OK — and `profile.ts`, `notify.ts` and `ads/provider.ts` hold the
  privacy line carefully: the profile never leaves the browser between sessions,
  the desktop notification carries no conversation content, and the ad provider
  interface is structurally incapable of receiving one.
- `script-src 'self'` with no `unsafe-eval` and no third-party origins means a real
  advertising provider cannot be added without an explicit, reviewable CSP change.
  That is a good boundary and worth keeping.
- The reducer/socket split is genuinely well made: the interesting behaviour is in
  a pure function with a real test file, and unknown frames are dropped rather than
  thrown on. The defects found here are all in the layer *around* that split —
  routing, copy, and effects — not in the state logic itself.
- The frontend has two test files. `machine.test.ts` covers the reducer well,
  including resumption of the conversation; nothing covers `useChat`, the view
  mapping in `presentation.ts`, or any component. F-010 and F-012 are both in that
  gap, and both are cheap to test.

### Dependencies to review next

- The backend `/health` and `/ready` endpoints are proxied to the public edge
  (`frontend/nginx.conf:84-92`); their response bodies were not examined and should
  be checked for information disclosure.
- Deployment topology, Prometheus alert coverage and the Grafana dashboard have not
  been reviewed, and two findings above (F-014, F-015) touch operations directly.

## Updated Review Checkpoint

Completed phases: Phase 0; Batches 1-7.

Remaining major areas: infrastructure and monitoring (`docker-compose*.yml`,
`monitoring/`, `backend/src/metrics/`); automated test quality and coverage across
the backend suites; the load-test harness in `load-test/swarm/`; and the final
cross-cutting (Phase 7), architecture (Phase 8) and prioritisation (Phase 9)
passes.

Next recommended batch: `backend/src/metrics/*`, `monitoring/prometheus.yml`,
`monitoring/alerts.yml` and the Grafana dashboard, together with the `/health` and
`/ready` handlers. Observability is the remaining dimension with no coverage at
all, and it is the one that decides whether any of the failure modes already found
— the spool filling, the P0 lane evicting, the orphaned match hashes, the
reconnect wave — would be visible before a user reported them.

## Batch 8 — Observability: Metrics, Alerts, Dashboard, Health

Files reviewed completely:

- `backend/src/metrics/registry.ts`
- `backend/src/metrics/retention.ts`
- `monitoring/prometheus/prometheus.yml`
- `monitoring/prometheus/alerts.yml`
- `monitoring/grafana/dashboards/karobakbak.json` (all panel expressions)
- `backend/src/server.ts:150-200` (the `/health`, `/ready` and `/metrics` handlers)
- `docker-compose.yml` / `docker-compose.prod.yml` port exposure

Reason: observability was the one review dimension with no coverage, and it
decides whether the failure modes already found in Batches 1-7 would be seen
before a user reported them.

Batch complete.

## [HIGH] The only availability page cannot fire when a backend disappears

Location: `monitoring/prometheus/alerts.yml:9-15`; discovery at `monitoring/prometheus/prometheus.yml:31-36`

Category: Observability / Reliability

Problem: `BackendDown` is `up{job="karobakbak-backend"} == 0`. Targets come from
`dns_sd_configs` against the Docker service name `backend`. Docker's embedded DNS
only answers with records for running containers, so a backend that has crashed,
been OOM-killed, or failed to start is **removed from the target list** at the
next 15s refresh. Prometheus then stops producing an `up` series for it and marks
the old one stale. `up == 0` matches nothing, and the alert never fires.

The expression only fires in the narrower case where a container is running and
reachable by DNS but its `/metrics` scrape fails.

Why it matters: This is the single `severity: page` alert for availability, and
production runs one replica (`frontend/nginx.conf:24-26`). The most likely
outage — the one backend process is gone — produces no alert at all. Worse, it
produces a *quieter* monitoring picture than a healthy system: fewer series, an
empty dashboard, and no firing rule. The whole rule file is built on the stated
principle that everything in it is "users are affected"; this is the rule for the
case where every user is affected.

Evidence: `prometheus.yml` sets no `honor_labels` and no static fallback target,
and the alert has no `absent()` or `count()` form. The DNS discovery comment
correctly explains why a static target would be wrong for scraping, but the
consequence for `up`-based alerting is not addressed anywhere.

Failure scenario: The backend container exits on an unhandled rejection (see
F-002, which makes this a live possibility rather than a hypothetical). Docker
DNS drops the record within seconds. Prometheus discovers zero targets. `up`
series go stale. No alert fires. nginx returns 502 to every user, and the first
notification anybody gets is a complaint.

Recommendation: Alert on the absence of targets as well as on failing ones. Add
`absent(up{job="karobakbak-backend"})` — or, better, `count(up{job=
"karobakbak-backend"} == 1) < 1` with a `for: 1m` — as a `severity: page` rule,
and keep the existing rule for the reachable-but-failing case. If the replica
count is ever expected to exceed one, assert the expected count rather than
non-zero. This is also the right place to alert on the edge itself: nothing
currently scrapes or checks nginx.

Confidence: High

## [HIGH] Ten metrics are declared but never incremented, including the product's headline SLI

Location: `backend/src/metrics/registry.ts:156-227`; dashboard panels in `monitoring/grafana/dashboards/karobakbak.json`

Category: Observability

Problem: A repository-wide search for each field of the `Metrics` interface finds
no write site anywhere — not in `src/`, not in `tests/`, not in the load-test
harness — for ten of them:

`matchmakingLatency`, `matchAttempts`, `matchmakingFailures`, `invalidFrames`,
`oversizedFrames`, `socketErrors`, `dbWriteLatency`, `dbWriteFailures`,
`breakerTransitions`, `enforcementActions`.

Because `prom-client` does not emit a series for a labelled metric until it is
first observed, and because none of these ten is zero-initialised the way
`connectionsRejected`, `messagesDelivered`, `moderationFlags` and
`retentionQueueDepth` are (`registry.ts:237-240`), the corresponding series never
appear in a scrape at all.

Why it matters: Two of them are charted:

- `chat_matchmaking_latency_seconds` drives three dashboard panels (p50 and p95
  of "time from joining the queue to being matched"). That is the product's
  headline service level indicator — the number that answers "is this thing
  finding people strangers to talk to, and how fast". The panel reads "No data"
  permanently, and reads that way identically to a healthy system with no
  traffic.
- `chat_enforcement_actions_total` drives the enforcement panel. The safety
  team's view of its own actions is permanently empty.

The other eight are the signals for exactly the failure classes this audit has
already found: `dbWriteFailures`/`dbWriteLatency`/`breakerTransitions` are the
retention path's health (F-005, F-006 live there), and
`invalidFrames`/`oversizedFrames`/`socketErrors` are the protocol-abuse signals.
Each is a metric an operator would reasonably believe exists, because it is
declared, documented, and typed.

Evidence: `grep -rn "\.<name>\b" --include=*.ts backend load-test` returns
nothing for all ten. `metrics.test.ts` scrapes the registry and asserts nothing
id-shaped appears in the output — a valuable test, but one that passes equally
well when a metric is never written.

Failure scenario: Matchmaking latency degrades from 2s to 90s as the queue
starves during off-peak hours. The dashboard panel built to show exactly this has
shown "No data" since the day it was written, so nobody looks at it, and the
regression is invisible until users stop returning.

Recommendation: Wire the ten. `matchmakingLatency` needs the queue-join timestamp
carried to the point of match — the session hash already exists and is the
natural place to stamp it. `dbWriteLatency`/`dbWriteFailures`/`breakerTransitions`
should be sampled by `RetentionMetricsPublisher` alongside `breakerState`, which
already works and proves the pattern. Then add a test that asserts every metric
declared in the `Metrics` interface has at least one write site, or delete the
ones that are not going to be wired — a declared-and-dead metric is worse than an
absent one, because it is charted and believed.

Confidence: High

## [MEDIUM] Alert thresholds duplicate configuration defaults instead of deriving from them

Location: `monitoring/prometheus/alerts.yml:44,58`; configuration at `backend/src/config.ts:631-634,644`

Category: Observability / Operational

Problem: `SpoolNearCapacity` fires at `chat_spool_records > 40000`, which is 80%
of the *default* `SPOOL_MAX_RECORDS` of 50,000 — a value the configuration allows
to be set anywhere from 1 to 100,000,000. `BackupsStale` hardcodes `> 93600`,
which is the default of `BACKUP_MAX_AGE_SECONDS`, also tunable. Neither alert has
any link to the running configuration.

Why it matters: The alert silently becomes wrong the first time somebody tunes
the deployment. A `SPOOL_MAX_RECORDS=10000` deployment fills the spool and starts
dropping records at 10,000 — the alert threshold is unreachable, so the drops
happen unannounced, and the spool is explicitly "bounded outage tolerance"
(D28) whose overflow is silent data loss. A `SPOOL_MAX_RECORDS=1000000`
deployment pages at 4% full, which trains the operator to ignore it.

Separately, `chat_spool_bytes` has no alert at all, although the spool is bounded
by `SPOOL_MAX_BYTES` (default 128 MiB) as well as by record count. A workload with
larger records reaches the byte ceiling first, and that path is entirely
unmonitored.

Recommendation: Export the limits as gauges from the application — the config
object already holds them — and write the alerts as ratios:
`chat_spool_records / chat_spool_max_records > 0.8`, and the same for bytes.
`BackupsStale` should compare against an exported `chat_backup_max_age_seconds`
rather than a copied literal. This makes the alert correct by construction under
any configuration, which is the property that matters for a value an operator is
invited to tune.

Confidence: High

## [LOW] The application's `instance` label is renamed by the scrape, contradicting the comment that relies on it

Location: `backend/src/metrics/registry.ts:133`; `monitoring/prometheus/prometheus.yml:24-28`

Category: Observability

Problem: The registry sets a default label `instance: config.instanceId`.
Prometheus attaches its own `instance` label (the discovered target's
`address:port`) to every scraped sample, and with `honor_labels` unset —
defaulting to false — a conflicting label from the exposition is renamed to
`exported_instance`. So the application's stable instance id is present, but not
under the name the `prometheus.yml` comment asserts: "Every series already
carries an `instance` label from the application itself, so a metric can be read
per-process".

Why it matters: Nothing breaks today, because every dashboard expression
aggregates with `sum`/`max` and none groups by `instance`. It matters the first
time somebody debugs a single replica during an incident: `by (instance)` groups
by container IP, which is reassigned on every restart, so a graph spanning a
deploy shows two unrelated lines and no continuity. The comment will send that
person the wrong way.

Recommendation: Either set `honor_labels: true` on the job, or drop the default
label from the registry and add the instance id via a relabel rule, or simply
rename the application's label to something non-colliding (`instance_id`) and fix
the comment. The last is the smallest change and removes the ambiguity entirely.

Confidence: High

## [LOW] `/health` is proxied to the public edge and names the instance

Location: `backend/src/server.ts:160-165`; edge exposure at `frontend/nginx.conf:84-92`

Category: Security / Information disclosure

Problem: `location = /health` and `location = /ready` are proxied through nginx to
the internet-facing edge with no restriction. `/health` responds with
`{ status, instance: config.instanceId }` and `/ready` with `{ status, redis,
draining }`.

Why it matters: Small, but real. Polling `/health` across a deployment enumerates
replicas by their server-minted ids and reveals when one is draining — that is,
when a deploy is in progress, which is the window in which a system is least
robust. `/ready` reports the health of Redis, an internal dependency, to anybody
who asks. None of this is user content and none of it is a credential, so the
severity is genuinely low; it is nonetheless information the product gets nothing
in return for publishing.

Evidence: The `/metrics` path is deliberately 404'd at the edge with a comment
explaining that the scrape is not for the internet. The same reasoning applies to
these two, and was not applied.

Recommendation: Keep the endpoints proxied if an external uptime check needs them,
but reduce the bodies at the edge to a bare status, or restrict the locations to
the private network (`allow`/`deny`) and let Docker health checks and Prometheus
reach them directly, as they already do. Dropping `instance` from `/health` is a
one-line change and costs nothing — the same value is on every metric series.

Confidence: High

### Key observations

- The registry file is the strongest piece of privacy engineering in the
  repository after the logger. Every label set is a named `as const` array, the
  reasoning about cardinality-as-an-outage is correct and explicit, and
  `metrics.test.ts` scrapes the live registry to assert nothing id-shaped escapes.
  The gap found here is the opposite failure — metrics that are safe but silent.
- `RetentionMetricsPublisher` pulling state from components rather than having
  components push to a registry is a good boundary: it keeps a metrics dependency
  off the write path, and the delta-advance handling of cumulative counters is
  correct (a `set` counter would break every `rate()` across a restart).
- Zero-initialising fixed label sets so a dashboard shows `0` rather than "No
  data" is exactly right, and is the reasoning that the ten unwired metrics
  needed and did not get.
- The alert file's editorial principle — few alerts, each either "users are
  affected" or "a promise is silently not being kept" — is sound, and
  `RetentionDeletionFailing` in particular alerts on a legal obligation that
  nothing else in the system would notice. The gaps are `BackendDown` (F-018),
  no alert on `chat_messages_delivered_total{route="dropped"}` (a message that
  reached nobody), and no alert on queue depth or matchmaking latency, which is
  downstream of F-019 since that metric does not exist yet.
- Port exposure is correct and worth recording as a strength: the backend
  publishes no host port in either compose file, the production override resets
  Redis and PostgreSQL port mappings to empty, and every remaining mapping binds
  `127.0.0.1`. `/metrics` is reachable only from the compose network.

### Dependencies to review next

- The backend test suites have not been assessed for what they actually assert;
  several findings so far (F-004, F-005, F-019) are behaviours a test could have
  caught, which raises a question about coverage shape rather than coverage count.

## Updated Review Checkpoint

Completed phases: Phase 0; Batches 1-8.

Remaining major areas: backend test suite quality and risk-based coverage; the
`load-test/swarm/` harness; deployment topology and the Dockerfiles/entrypoints in
detail; and the final cross-cutting (Phase 7), architecture (Phase 8) and
prioritisation (Phase 9) passes.

Next recommended batch: `backend/tests/unit/` and `backend/tests/integration/` —
specifically the race, janitor, storage-role and logger-denylist tests. Eight
batches have produced findings that a test could plausibly have caught, so the
question to answer is whether the suite is testing the wrong things or simply not
enough of them. That answer changes the shape of the final recommendations.

## Batch 9 — Test Suite Shape and Risk Coverage

Files reviewed completely:

- `backend/tests/unit/messages.test.ts`
- `backend/tests/unit/queue.test.ts`
- `backend/tests/unit/metrics.test.ts`
- `backend/tests/integration/retention.test.ts`
- `backend/tests/integration/deletion.test.ts`
- `backend/tests/integration/races.test.ts`
- `backend/tests/integration/admin-enforce.test.ts`
- Re-read for verification: `backend/src/storage/queue.ts:70-100`, `backend/src/storage/deletion.ts:150-215`, `backend/src/storage/migrations/*.sql` (`legal_hold` columns)

Reason: eight batches produced findings that a test could plausibly have caught.
The question this batch answers is whether the suite tests the wrong things or
simply not enough of them — the answer changes the shape of the final
recommendations. Files were chosen as the tests that *should* have caught F-004,
F-005, F-007, F-008 and F-019.

Batch complete.

## [HIGH] A test asserts a refusal the code never performs, and its assertion cannot fail on the branch it names

Location: `backend/tests/integration/retention.test.ts:401-422`; behaviour at `backend/src/storage/queue.ts:82-99`

Category: Testing / Safety

Problem: The test is titled "refuses a P0 record when its class is full, so the
caller can fail the client". Reading `RetentionQueue.enqueue()`, a full class has
two branches:

- The incoming record's session is **at or over** its per-class quota → evict that
  session's own oldest record → `{ accepted: true, reason: 'quota' }`.
- The incoming record's session is **under** quota → evict the oldest record in the
  class *belonging to somebody else* → `{ accepted: true, reason: 'class_full' }`.

Neither branch refuses. A refusal is returned only in the unreachable fallback
where there is nothing left to evict. The test enqueues four reports **all from
the same session** (`s_flood`), so it only ever exercises the first branch, and
its assertion is a disjunction —
`results.some(r => !r.accepted || writer.counters.quotaEvictions > 0)` — which is
satisfied entirely by `quotaEvictions > 0`. The `!r.accepted` half can never be
true here, so the behaviour the title claims is never checked.

Why it matters: This is the test that a reader — or a future maintainer changing
the queue — would rely on to know that safety evidence is not silently displaced.
It reads as coverage of §14.3 and provides none. It is also the reason F-005
survived review: the cross-session eviction path is untested at *both* layers. The
unit test that does cover class-full eviction
(`queue.test.ts:116-128`, "evicts the oldest of the class when the sender is
within quota") is parametrised on **P3**, so it blesses the eviction behaviour
without ever applying it to the safety class.

Evidence: `queue.ts:93-98` returns `accepted: true` after `evictOldest(priority)`,
which selects the oldest entry in the lane regardless of session. `queue.test.ts`
contains no P0-full case (`grep -n "p0" tests/unit/queue.test.ts` shows P0 used
only for priority assignment, class isolation and drain ordering).

Failure scenario: A change to the queue makes cross-session P0 eviction more
aggressive. Both tests still pass. Reports acknowledged to users are dropped, and
the `SafetyRecordsDropped` alert does fire — but only after the evidence is gone,
and the reporter was told otherwise.

Recommendation: Rewrite the test to do what its title says: fill P0 from session
A, enqueue from session B, and assert the result is `accepted: false` — which
requires fixing F-005 first, since the current code cannot satisfy it. Replace the
`some(... || ...)` disjunction with two separate assertions; a disjunction across
a result array is not an assertion about behaviour. Add the P0 case to
`queue.test.ts` beside the P3 one.

Confidence: High

## [MEDIUM] The legal-hold test counts the parent row and never looks at the transcript it was placed to preserve

Location: `backend/tests/integration/deletion.test.ts:218-231`; behaviour at `backend/src/storage/deletion.ts:154-161`

Category: Testing / Privacy

Problem: "suspends deletion of a held conversation" seeds a conversation with two
messages, marks it expired, places a conversation hold, runs the worker to
exhaustion, and asserts exactly one thing: `count('conversations') === 1`. It
never counts `messages`. The messages are deleted by the first statement in
`deleteExpired()`, which filters on `messages.legal_hold = false` alone and does
not consult the parent's hold — so the test passes on a run in which the entire
transcript was destroyed.

Why it matters: This is the test that stands behind the §15 legal-hold promise. A
conversation row with no messages is not a suspended conversation; it is an empty
shell with a timestamp. The neighbouring test — "protects a held message from its
parent expiring underneath it" — covers the *reverse* containment and is correct,
which makes the gap easy to miss: the suite looks symmetric and is not.

Recommendation: Assert the children. `expect(await ctx.count('messages')).toBe(2)`
in that test, and the same for reports. Do it as part of fixing F-007 — which this
batch also widens, see the update below.

Confidence: High

## [MEDIUM] The message pipeline's retention responsibility is stubbed out of its own unit suite

Location: `backend/tests/unit/messages.test.ts:9` (`NullRetentionSink`); pipeline at `backend/src/ws/messages.ts:125-190`

Category: Testing / Architecture

Problem: `messages.test.ts` is a thorough suite — 320 lines covering rate limiting
before resolution, server-assigned ids, dedupe keys, replay-set exhaustion, the
vanished-partner cases, route labelling, and two separate I8 log-leak canaries. It
builds every context with `NullRetentionSink`. Nothing in the file asserts that
*any* record is enqueued, on any branch, with any priority.

`send()` has two responsibilities: route the message to the partner, and hand the
message and its moderation events to retention. The first is tested from every
angle. The second is a null object.

Why it matters: F-004 — hard-blocked messages returning before the only
`persist()` call, so the highest-severity moderation matches produce no retained
message and no `moderation_event` — is invisible to this suite by construction.
The test that covers that exact branch,
`it('refuses a hard-blocked message outright')` (line 225), asserts the outcome
kind, the flags, and that the partner received nothing. All three are correct.
The half that is broken is the half the fixture removed.

Evidence: `grep -n "sink\|retention\|enqueue" tests/unit/messages.test.ts` returns
one line: the import of `NullRetentionSink`.

Recommendation: Give the suite a recording sink — an array-backed
`RetentionSink` — and assert per branch: a clean message enqueues one `message`
record at P3; a flagged message enqueues a `message` plus one
`moderation_event` per rule; a hard-blocked message enqueues both and delivers
nothing. That last assertion is the regression test for F-004 and should be
written before the fix.

Confidence: High

## Updated finding: F-007 is wider than messages — a conversation hold protects nothing but the conversation row

Location: `backend/src/storage/deletion.ts:150-215`; schema at `backend/src/storage/migrations/001_initial.sql:23,48,70` and `003_legal_holds.sql`

Category: Privacy / Legal hold correctness

The original finding (Batch 5) said a conversation-level hold does not retain the
conversation's messages. Reading the full `deleteExpired()` body and the schema
shows the gap is broader:

- **Messages**: deleted on `retention_expires_at < now() and legal_hold = false`,
  with no reference to the parent conversation's hold. (As originally found.)
- **Reports**: identical filter, same gap. A hold on a conversation does not
  preserve the reports filed against it, even though a report is usually the
  reason the hold exists.
- **Moderation events**: deleted on `retention_expires_at < now()` with **no hold
  check at all** — and none is possible, because `moderation_events` has no
  `legal_hold` column. `grep -n legal_hold migrations/*.sql` shows the column
  exists on `conversations`, `messages` and `reports` only.
- **Enforcement**: same — no `legal_hold` column, deleted purely on its own
  deadline.

So a conversation hold placed during an investigation preserves one row: the
conversation. Its transcript, the reports against it, the moderation events that
flagged it and any enforcement issued from it all expire on their own schedules
underneath it.

The conversation delete statement is careful in the other direction — it excludes
conversations holding a held message or a held report, with an explicit comment
about the cascade. The containment reasoning was applied to one direction and not
the other.

Recommendation (revised): Define containment as a rule and implement it in one
place. Either (a) cascade the flag: placing a conversation hold sets `legal_hold`
on its existing messages and reports, and every subsequent insert into a held
conversation inherits it — which needs the flag on `moderation_events` and
`enforcement` too, plus a migration; or (b) make every child delete exclude rows
whose parent conversation is held, and add the `legal_hold` column to the two
tables that lack it so a direct hold on them is even expressible. (a) is
cheaper to query and is what the partial indexes
(`... where legal_hold = false`) are already shaped for; (b) has no write
amplification. Either way, a single integration test should place one conversation
hold, expire every child, run the worker, and assert nothing is gone.

Severity unchanged at HIGH; scope and confidence both increased.

## Updated finding: F-005 mechanism confirmed exactly

Reading `queue.ts:82-99` confirms the mechanism and narrows it. The displacing
enqueue must come from a session that is **under** its per-class quota; it then
evicts the oldest P0 in the lane regardless of owner and returns `accepted: true`,
which `RetentionWriter.enqueue()` passes up and the report handler treats as
grounds to acknowledge. Because anonymous users can open fresh sessions freely,
the per-session quota — which is the control that makes the class safe against one
flooder (D26) — is exactly what a distributed flood does not trip. Confidence
raised to High; see F-023 for why the existing test does not catch it.

### Key observations

- `races.test.ts` is the strongest file in the repository. It maps directly onto
  the numbered race scenarios in `DESIGN.md` §10 — simultaneous queue from two
  instances, one-match-only under fan-out (I5), disconnect racing matchmaking, a
  half-cleaned dead process, simultaneous skip, message racing a skip, duplicate
  queue entries being structurally impossible, and recovery from an emptied Redis
  script cache. Each asserts a specific outcome rather than an absence of throws.
  This is the concurrency-testing discipline `CLAUDE.md` asks for, and it is
  actually present.
- `metrics.test.ts` is a good privacy test and a poor liveness test. It asserts
  the fixed metric names appear in the scrape and that nothing id-shaped or
  IP-shaped ever does. It passes for the ten metrics nothing writes, because
  `prom-client` emits an *unlabelled* counter or histogram at 0 as soon as it is
  registered — so `chat_matchmaking_latency_seconds_bucket` is present in the
  output, all buckets zero, forever. This refines F-019: the unlabelled dead
  metrics are not absent, they are permanently and convincingly zero, which is
  worse. The labelled ones (`enforcementActions`, `dbWriteFailures`,
  `matchmakingFailures`) are genuinely absent.
- `admin-enforce.test.ts` covers issuing, revoking, the no-op case, and — notably —
  Redis-restart replay including "does not extend a sanction that was half spent"
  and "is safe to run twice, and from more than one instance". What it never does
  is pass a malformed `enforcementId`. Every test supplies an id the system itself
  generated. F-008 (a `%` revoking every active ban) sits in precisely that gap:
  the suite tests the system against itself, never against a hostile input.
- The shape that emerges across all four files is consistent, and it is not "too
  few tests". It is that **the suite tests the path the system takes, and rarely
  the path an adversary or an unlucky ordering takes**, outside `races.test.ts`
  where adversarial ordering *is* the subject. Delivery is tested and retention is
  nulled; the quota branch is tested and the cross-session branch is not; the
  parent row is counted and the children are not; generated ids are supplied and
  malformed ones are not. Four of this audit's findings live in that one blind
  spot, which makes it systemic rather than four separate oversights.

### Dependencies to review next

- `load-test/swarm/` is the remaining unexamined subsystem, and `docs/testing/SWARM-HANDOFF.md`
  claims it encodes server behaviours that "have each already cost a red run" —
  which may independently corroborate or contradict findings above.

## Updated Review Checkpoint

Completed phases: Phase 0; Batches 1-9. Phase 7 (cross-cutting) is now partly
answered by this batch's final observation.

Remaining major areas: the `load-test/swarm/` harness; Dockerfiles, entrypoints
and the migration container in detail; and the final cross-cutting (Phase 7),
architecture (Phase 8) and prioritisation (Phase 9) passes.

Next recommended batch: `docs/testing/SWARM-HANDOFF.md` and the `load-test/swarm/` core —
the scenario runner, the client model and the assertion layer. It is the only
subsystem with no coverage, it is the closest thing the project has to an
end-to-end behavioural specification, and its recorded traps are a second
independent source of evidence about the server behaviours this audit has been
reasoning about from the code alone.

## Batch 10 — The Load-Test Swarm as an Independent Source of Evidence

Files reviewed completely:

- `docs/testing/SWARM-HANDOFF.md` (all sections; §4 "Traps already paid for" and §5
  "Four weaknesses" in detail)
- `load-test/swarm/` file map and module sizes
- Verified against source: `backend/src/server.ts:507-595`,
  `backend/src/ws/messages.ts:136-190`, `backend/src/ws/janitor.ts:107-133`,
  `backend/src/server.ts:104-110`

Reason: the swarm is the only subsystem with no coverage, and its handoff
document records server behaviours that "have each already cost a red run" —
a second, independent source of evidence about the same server this audit has
been reading statically. Three of its recorded traps turned out to describe
defects in the product, not in the harness.

Batch complete.

## [HIGH] A refused `join_queue` leaves the client searching forever

Location: `frontend/src/hooks/useChat.ts:188-194` and `frontend/src/state/machine.ts:355-356,422-434`; server side at `backend/src/server.ts:507-516,572-595`

Category: Correctness / UX

Problem: `start()` sends `join_queue` and, if the socket accepted the frame,
immediately dispatches `user_searching`, which sets `screen: 'searching'`. The
server refuses a join in two ways, and **neither produces a `queue_status`**:

- Rate limiting. `withinRateLimit()` sends `RATE_LIMITED` and returns before the
  `join_queue` case is reached. The client's `applyError` handles `RATE_LIMITED`
  by setting a notice and `rateLimitedAt` and returning the state otherwise
  unchanged — so `screen` stays `'searching'`.
- Name moderation. A declared name matching any rule (D35) gets
  `VALIDATION_FAILED` and an early return. `applyError` has no case for it, so
  the default branch sets "Something went wrong. Please try again." and leaves
  `screen: 'searching'`.

In both cases the server never queued the session, nothing further is ever sent,
and the client shows the search overlay — "Looking for someone…", a rotating
line, an animated spinner — indefinitely. Only an explicit cancel recovers it.

Why it matters: This is not a rare path. `join_queue` is deliberately limited to
burst 5 / one token per 5 seconds (D40), and `useAutoSearch` exists *because* the
auto-advance cadence can outrun that refill — its own doc comment says so and
backs off after a refusal. But the backoff only runs while
`screen === 'ended'`; once the optimistic `user_searching` has fired, `qualifies`
is false, `setDeadline(null)` abandons the countdown, and the machinery built to
handle this refusal is switched off by the bug it was meant to handle. A user who
cycles quickly through strangers — the intended usage — lands on a permanently
false "searching" screen. The name-moderation path is worse: the user is told
"Something went wrong" for a decision that was deliberate and actionable, and
then waits forever.

Evidence: The harness found this independently and from the outside.
`testing/SWARM-HANDOFF.md` §4 trap 13: "**A refused join leaves the bot believing it is
SEARCHING.** The server never queued it, and nothing arrives to say so. Without
rolling the optimistic state back, a refused bot sits out the rest of the run
looking perfectly healthy — a hole in the population no oracle is looking for."
The harness fixed it in the harness. The browser client has the same defect and
was not changed.

Failure scenario: Auto-search is on. Five strangers leave in quick succession —
ordinary behaviour in this product. The sixth join is refused. The screen says
"Looking for someone…" and will say it until the tab is closed. Nothing in the
metrics distinguishes this user from one who is genuinely queued, because the
server has no session in the queue to count.

Recommendation: Make the server authoritative here, which is the project's own
protocol rule 3. Send `queue_status { state: 'IDLE' }` alongside the error on
every path that refuses a join, so the client's state is corrected by the server
rather than by client-side inference. Additionally, roll the optimistic state
back on the client — in `applyError`, any refusal received while
`screen === 'searching' && matchId === null` should return to `'idle'` — so an
older server, or an error code added later, cannot reproduce the stuck screen.
Give `VALIDATION_FAILED` a case with copy that says the name was refused. Add a
reducer test for both codes arriving in the searching state.

Confidence: High

## [MEDIUM] The two cluster-wide gauges are written only by the janitor's lock holder, so the dashboard reads stale followers

Location: `backend/src/server.ts:104-110`; write condition at `backend/src/ws/janitor.ts:113-133`; queries in `monitoring/grafana/dashboards/karobakbak.json`

Category: Observability / Correctness

Problem: `chat_active_matches` and `chat_queue_depth` are set from the janitor's
`onCounts` callback, which runs **after** `acquireJanitorLock()` succeeds. A
follower instance never calls it. Because a Prometheus gauge holds its last value
until overwritten, a follower that was previously the leader keeps exporting its
final sample forever, and a follower that never led exports no series at all. The
dashboard queries `max(chat_active_matches)` and `max(chat_queue_depth)`.

Why it matters: `max` over a set containing one live value and one permanently
frozen value returns the frozen one whenever it is larger — which is exactly what
happens after a busy period, after any leadership change, and after a deploy. The
"active conversations" and "queue depth" panels are the two that answer "is the
product working right now", and they will read high and flat while the system is
idle. There is no expiry: only a process restart clears the stale series.

Evidence: The project's own harness documentation states this as a hard-won rule.
`testing/SWARM-HANDOFF.md` §4 trap 7: "**`chat_active_matches` and `chat_queue_depth` are
cluster-wide gauges** written only by the janitor's lock holder. The follower's
copy freezes. Never sum them; `max` is also unreliable. Ask Redis." The oracles
were changed to query Redis directly. The dashboard still uses `max`.

Recommendation: Make exactly one series exist. On any pass where the lock is not
acquired, call `.reset()` on both gauges so a non-leading instance exports
nothing — then `max`, `sum` and a bare selector all agree, and the dashboard
needs no change. The comment at `server.ts:105-107` claims the gauges keep the
dashboard and the UI in agreement; that is true only for the leader, and should
be corrected either way.

Confidence: High

## [MEDIUM] `message_ack.delivered` reports a moderation verdict, not delivery, and now says "sent" for messages that reach nobody

Location: `backend/src/ws/messages.ts:149-190`; client rendering at `frontend/src/state/machine.ts:307-323`

Category: Protocol / UX

Problem: `delivered` on the ack is `verdict.deliverable` — purely the moderation
outcome. Whether the partner's socket existed, accepted the frame, or was
attached at all has no bearing on it. The dispatcher's failure to reach a session
is caught and does not change the ack. The client maps `delivered: true` to the
status `'sent'`.

This was defensible under D7, where a partner without a socket meant the
conversation had ended and the sender was told so. Under D42 the seat is held for
`RESUME_GRACE_SECONDS`, so "matched, partner has no socket" is now a normal,
expected state that can last tens of seconds — and every message sent into it is
acked `delivered: true` and reaches nobody.

Why it matters: The client's own state machine is explicit that it must never
render a delivery guarantee the protocol refuses to make (D14) — and it renders
one, because the field it reads is named `delivered`. `composerDisabled()` closes
most of the window by disabling the composer once `partnerAway` is set, but the
harness measured the remaining gap directly and found it real.
`testing/SWARM-HANDOFF.md` §4 trap 17: "**The sender cannot know its partner's socket
died.** It learns from a `partner_reconnecting` frame that takes a round trip,
and a message handed to the socket in that gap is acked `delivered: true`,
reaches nobody, and carries no flag the sender could set" — with a recorded case
of a message acked 10 ms before its partner's close. Trap 15 states the same
conclusion for the whole absence: "An ack during a partner's absence says
`delivered: true` and means nothing."

Recommendation: Two changes, both small. Rename the wire field to what it means —
`withheld: boolean`, or `accepted`/`moderated` — so no future client reads
delivery into it; this is a protocol change and needs the frontend copy
regenerated. Then, when the partner's session is known to have no attached socket
at ack time (`resolveRoute` already distinguishes this), return a third status
the client can render as "waiting" rather than "sent". Do not buffer the message —
D43 and I8 both forbid it — but do stop telling the sender it arrived.

Confidence: High. The mechanism is confirmed in source and independently measured
by the harness; only the right remedy is a judgement call.

### Key observations

- The swarm is a genuine engineering asset and the strongest argument in this
  repository that the system has been operated rather than merely written. It has
  a persona model, an oracle layer with separate ledger/metrics/Redis/log/spam
  checks, a seeded RNG for reproducibility, and — most valuably — a written record
  of every wrong assumption that cost a run. Section 4 is the highest-value
  document in the repository for a new maintainer.
- It is also, right now, a **better source of truth about server behaviour than the
  test suite**. Three of its traps describe product defects (F-026, F-027, F-028);
  each was fixed inside the harness so that runs would go green, and none was
  carried back to the product. That pattern is worth naming: the harness has been
  treated as the thing that must adapt to the server, which is correct for a load
  test and dangerous when the adaptation encodes a defect. Every trap in §4 that
  begins "About the server" deserves a second reading as a possible finding — this
  batch converted three of twenty-three.
- Trap 18 is the most instructive item in the document and generalises past this
  project: "**a harness bug that removes behaviour looks like a clean run.** When a
  persona group stops producing failures, check that it is still producing
  *events*." No bot had ever reconnected, from the first commit until the day it
  was found, and every run reported success. The same class of blindness is what
  F-019 (ten metrics nothing writes) and F-025 (`NullRetentionSink`) are made of.
- The self-declared weaknesses in §5 are honest and correctly ranked. `looksAbusive`
  cheating means the ~15s time-to-first-report is an optimistic bound, and the
  document says so rather than quoting the number as a result. The spam oracle's
  false-positive growth (0 of 381 at 150s, 251 of 381 at 1,500s) is reported as a
  precision budget rather than hidden.
- One item is unresolved and worth carrying: a worker died once under Windows exit
  code `0xC0000409` (V8's fast-fail for a fatal error) at 88 seconds into a
  1,500-second run, with nothing on stderr and an unremarkable ledger. It has not
  recurred. It is harness-side, so the risk to production is indirect — but the
  harness shares the protocol types and the `ws` client with nothing in the
  backend, so the most likely causes are local to it. The suggested mitigation in
  the document (bound the child's stack and heap, capture its stderr to a file) is
  the right next step and cheap.
- `bot.ts` at 1,224 lines is the largest source file in the repository. Nothing in
  this review depends on its internals, and a load-test client is a reasonable
  place for a long file, but it is the obvious candidate if the harness becomes
  hard to change.

### Dependencies to review next

- Nothing outstanding blocks the synthesis. The remaining unexamined code is the
  Dockerfiles, entrypoint scripts and the migration container, which are low-risk
  relative to what is already found and were partly covered in the Batch 0
  inventory.

## Updated Review Checkpoint

Completed phases: Phase 0; Batches 1-10.

The stop conditions in the brief are now met: every major architectural component
has been inspected, the critical execution paths (upgrade → session → match →
message → retention → deletion, and the admin console's read path) have been
traced end to end, persistence and failure paths have been reviewed, tests have
been assessed for shape rather than count, infrastructure and observability have
been examined, and the load-test harness has been used as a cross-check.

Remaining unexplored and explicitly accepted as low-risk: Dockerfiles and
entrypoint scripts, the migration container, the individual persona and oracle
modules inside `load-test/swarm/src/`, and the presentational React components not
implicated in a finding.

Next: Phases 7-10 — cross-cutting synthesis, architecture assessment,
prioritisation, and the final report.

## Open Questions

- Answered (Batch 1): the upgrade path validates path, draining state, origin, capacity and enforcement before a session exists, and all client-derived identifiers are server-minted or salted hashes.
- Answered (Batch 7): the protocol files are **not** kept in sync by anything beyond `scripts/verify-protocol.mjs`, and nothing runs that script automatically — see F-015.
- How do database writes, retention, deletion and spool recovery behave when PostgreSQL is unavailable? (Partly answered in Batch 4; the spool's replay path on restart is still unexamined.)
- Answered (Batch 8): `/health` returns the instance id and draining state, `/ready` returns Redis health; both are publicly proxied — see F-022.
- Answered (Batch 8): spool growth and P0 eviction *are* alerted, though on hardcoded thresholds (F-020). Orphaned match hashes (F-003) and the reconnect wave (F-014) have no metric, no alert and no panel; a backend that vanishes has no working alert either (F-018).
- Answered (Batch 9): the suite is large and, in `races.test.ts`, genuinely excellent. Its blind spot is adversarial and unlucky-ordering input outside matchmaking — see F-023, F-024, F-025 and the cross-cutting note in that batch.
- Answered (Batch 10): it corroborates, and it also independently found three product defects that were fixed in the harness and never carried back — F-026, F-027, F-028.
- Unresolved and carried forward: the swarm worker's single unexplained death under V8 fast-fail `0xC0000409`, documented in `docs/testing/SWARM-HANDOFF.md` §5 and not reproduced since.

## Late Finding — Deletion Throughput

Found while assessing scaling risk for Phase 8, verified in source.

## [HIGH] The deletion worker can never delete more than 500 rows per table per hour

Location: `backend/src/storage/deletion.ts:81-88,119-120,137-146`; configuration at `backend/src/config.ts:641-644`

Category: Privacy / Data retention / Scalability

Problem: `start()` schedules a single `runPass()` every `DELETION_INTERVAL_MS`
(default 3,600,000 — one hour). `runPass()` calls `deleteExpired()` exactly once,
and each statement inside it is bounded by `DELETION_BATCH` (default 500). The
pass computes `more` — "a batch was full, so more remains for the next pass" — and
the scheduler **discards it**: the callback is `void this.runPass()`.
`runUntilDrained()` exists and does the right thing, and has no call site anywhere
in `src/`; only tests use it.

The steady-state ceiling is therefore 500 conversations, 500 messages, 500
reports, 500 moderation events and 500 enforcement rows per hour — 12,000 of each
per day, cluster-wide, because the pass is behind a leader lock.

Why it matters: This is the mechanism behind the product's central promise, made
on the landing screen ("kept for a limited period … then deleted automatically"),
in `DESIGN.md` as invariant I10, and to any regulator who asks. A stranger-chat
service doing even modest volume — 20,000 conversations a day at ten messages
each — expires roughly 200,000 messages a day and deletes 12,000 of them. The
backlog grows without bound, and every row in it is personal data held past the
deadline the system itself stamped on it at insert time.

The failure is silent in every channel built to catch it:

- `RetentionDeletionFailing` alerts on `increase(chat_deletion_failures_total)`,
  and nothing has failed. The pass succeeded; it simply did 500 rows.
- `chat_retention_deleted_total` rises steadily at 500/hour, which on a graph
  looks like a worker doing its job.
- Nothing measures the backlog. There is no gauge for "rows past their retention
  deadline that still exist", which is the one number that would show this.

Evidence: `grep -rn "runUntilDrained" src/` returns only the definition.
`deletion.ts:119` computes `more`; `deletion.ts:83` ignores the returned promise's
value entirely. The deletion test suite includes `it('works in batches and reports
that more remains')`, which asserts the flag is set correctly — the signal is
produced, tested, and consumed by nobody. This is the same "declared but not
wired" shape as F-019 and F-015.

Failure scenario: The service reaches 1,000 concurrent users. Retention deadlines
begin expiring at hundreds of rows per minute. The deletion worker removes 500 per
hour. Six months later the database holds millions of rows past their deletion
date, every dashboard is green, no alert has fired, and the exposure is discovered
by a subject-access request or an audit.

Recommendation: Three changes, in order of importance.

1. Drain rather than nibble. Have the scheduled callback loop while `more` is
   true, with a per-run cap so a single pass cannot monopolise the connection
   pool — `runUntilDrained()` already implements exactly this and takes a
   `maxPasses` argument. Keep the batch size where it is; it is the right unit
   for a bounded statement, and it is the *scheduling* that is wrong, not the
   batch.
2. Measure the backlog, not the throughput. Export a gauge counting rows where
   `retention_expires_at < now()` per table (cheap — the partial indexes
   `... where legal_hold = false` on `retention_expires_at` already exist for
   precisely this predicate) and alert when it stays above zero across
   consecutive passes. A deletion worker that is keeping up has a backlog of
   approximately zero; that is the only assertion worth alerting on, and it is
   true independently of volume, batch size and interval.
3. Shorten the interval. One hour between passes means an hour of accumulation
   even once draining is fixed; something on the order of a minute costs nothing
   when there is nothing to delete, because the first statement returns zero rows
   against an index.

Confidence: High

---

## [LOW] Deleted message rows are undercounted whenever their parent expires with them

Location: `backend/src/storage/deletion.ts:246-249,154-178`; schema at `backend/src/storage/migrations/001_initial.sql:31`

Category: Observability

Problem: `deleteBatch()` returns `result.rowCount`, which PostgreSQL reports for
the statement that was issued. `messages.conversation_id` is
`references conversations on delete cascade`, so when the conversation delete
runs, any messages still attached go with it — removed by the database, counted
against the *conversation* statement, and never seen by the message counter.
`totals.messages` and therefore
`chat_retention_deleted_total{table="messages"}` count only the messages deleted
by their own statement.

Why it matters: Small, and worth recording because the number is on the
dashboard (`sum by (table) (rate(chat_retention_deleted_total[30m]))`) and reads
as "messages deleted". Conversation and message retention deadlines are normally
stamped together at insert time, so the common case is exactly the one that
undercounts: most expired messages leave through the cascade rather than through
the statement that counts them. An operator sizing retention load, or checking
that deletion is keeping up after F-029, would be reading a number
systematically lower than the truth — and F-029's recommended fix is a *backlog*
gauge precisely because a throughput counter is the wrong instrument here.

Evidence: Found by a test rather than by reading. A drain of seven conversations
holding fourteen messages, at batch size two, deletes everything — both tables
end at zero rows — while reporting eight message deletions. Four passes at two
explicit deletions each; the remaining six went with their parents. The
assertion in `tests/integration/deletion.test.ts` now documents this rather than
asserting the fourteen that seemed obvious.

Recommendation: Either count the cascade — `delete from conversations ...
returning conversation_id`, then attribute the children, which costs a second
query and is probably not worth it — or leave the counter alone and rename what
it measures, so the dashboard panel does not claim more than the number
supports. The backlog gauge recommended for F-029 is the measurement that
actually answers the operational question, and makes this one uninteresting.

Confidence: High

---

# Phase 7 — Cross-Cutting Analysis

Twenty-nine findings across ten batches resolve into seven patterns. Six are
systemic — the same mistake made independently in several places — and each is
worth more attention than any single finding inside it, because fixing the pattern
prevents the next instance.

## Pattern 1 — The delivery path is guarded; the evidence path fails open

*Findings: F-004, F-005, F-007, F-029, and F-019's `enforcementActions`.*

This is the most important pattern in the audit, and it is not a coincidence of
five bugs. In every place where the system must both **act** on user content and
**keep a record** of it, the action is implemented carefully and the record is
best-effort in a way that loses data silently:

- A hard-blocked message is refused correctly and its evidence is never enqueued
  (F-004).
- A report is refused correctly when the queue is genuinely full, and an
  already-acknowledged report is silently displaced when it is not (F-005).
- A legal hold stops the conversation row being deleted and preserves none of its
  contents (F-007).
- Expired data is deleted correctly, 500 rows an hour, forever (F-029).

The root cause is a correct principle applied one step too far. D16 — "never make
chat wait on PostgreSQL" — is right, and the write-behind queue, the circuit
breaker and the spool are a good implementation of it. But "the conversation must
not wait on the database" was generalised into "the retention path may fail
silently", and that is a different claim. It is true for an ordinary message. It
is false for a report the user was told was received, for a hold a lawyer placed,
and for a deletion deadline the product printed on its landing page. Those are
promises, and a promise that fails silently is worse than one that fails loudly.

The remedy is not to make chat wait on the database. It is to distinguish two
classes of retention record — *best-effort* and *promised* — and to make the
promised class refuse rather than drop, surface rather than swallow, and be
measured by backlog rather than by throughput.

## Pattern 2 — Controls that are declared but never wired

*Findings: F-015, F-018, F-019, F-020, F-029, F-006.*

A striking number of this system's safeguards exist as a declaration with nothing
behind them:

- `npm run verify` is described as failing the build; there is no build (F-015).
- Ten metrics are declared, documented and typed; nothing writes them, and the
  unlabelled ones export a convincing permanent zero (F-019).
- `BackendDown` is the one availability page; it cannot fire in the most likely
  outage (F-018).
- `SPOOL_BACKEND=redis` is a valid configuration value that changes nothing
  (F-006).
- `DeletionPassResult.more` is computed, tested, and read by no one (F-029).

The load-test handoff names this exact failure mode better than this audit can, in
trap 18: "**a harness bug that removes behaviour looks like a clean run.** When a
persona group stops producing failures, check that it is still producing
*events*." The lesson was learnt in the harness and not applied to the product.
A declared-and-dead control is worse than an absent one, because it is charted,
documented and believed.

## Pattern 3 — Optimistic client state that the server never corrects

*Findings: F-026, F-009, F-010.*

The protocol's third rule — the server is authoritative — is enforced with real
rigour for *identity and routing*: no client frame chooses a session id, a
partner, an ordering or a subject. It is not enforced at all for *session state*.
The client sets `screen: 'searching'` on its own initiative and the server has no
obligation to confirm or deny it, so a refused join produces a screen that is
wrong forever (F-026). The client decides on its own that a departed partner means
a spent resume token (F-009). The client decides that a closed socket means the
landing screen (F-010).

Each of these is a place where the client inferred something the server knew and
did not say. The fix in every case is the same shape: have the server state the
outcome, and have the client apply it rather than predict it.

## Pattern 4 — Tests that assert the visible half

*Findings: F-023, F-024, F-025.*

The suite is large and, in `races.test.ts`, genuinely excellent. Its blind spot is
narrow and consistent: where a function has a visible effect and a durable one,
the visible one is asserted and the durable one is stubbed, counted at the parent
level, or covered by a title that the assertion does not check. `NullRetentionSink`
in the message suite, `count('conversations')` in the hold test, and a disjunctive
assertion in the P0 capacity test are three instances of one habit — and they are
precisely why Pattern 1 survived to be found by reading rather than by running.

There is a second, smaller version of it: the suite tests the system against
itself. Every enforcement id supplied to `admin-enforce.test.ts` is one the system
generated. F-008 — a `%` revoking every active ban — lives in exactly that gap.

## Pattern 5 — Configuration validated for shape, not for effect

*Findings: F-001, F-006, F-020.*

`loadConfig` is a good piece of work: pure, injected, range-checked, with
cross-field coherence assertions. What it does not do is verify that a setting
*does* anything. A production deployment may keep the published default IP hash
salt with a log warning (F-001); `SPOOL_BACKEND=redis` selects a file spool
(F-006); and alert thresholds hardcode the defaults of settings an operator is
explicitly invited to tune (F-020). The gap is between "this value is well-formed"
and "this value reaches the thing it names".

## Pattern 6 — A reversed decision applied to state but not to view

*Findings: F-010, F-011, and the dead branches inside them.*

D42 reversed D7: a dropped socket no longer ends the conversation. The reversal
landed correctly in the backend, in the protocol, in the reducer and in the
reducer's tests. It did not land in the view layer or in any user-visible string.
`phaseOf` still routes a disconnected session to the landing screen, `ChatShell`'s
reconnect branch is unreachable, `ReconnectBanner` can never render, and the copy
it would render if it could still tells the user the conversation is over.

The mechanism is worth naming because it will recur: **the parts of this codebase
that have tests were updated, and the parts that do not have tests were not.**
`machine.test.ts` covers the reducer and the reducer was fixed. Nothing covers
`presentation.ts` or any component, and neither was.

## Pattern 7 (local, not systemic) — Two raw strings that reach a decision

*Findings: F-008, F-013.*

Worth separating from the others because it is *not* systemic — it is two
exceptions to a rule the codebase otherwise follows exceptionally well. "Redis
keys never contain client-supplied strings" and "no console route may accept an
identity hash" are stated, implemented and tested. The two places where a raw
string does reach a query or a policy are both defects: an unvalidated
`enforcementId` used as a SQL `LIKE` pattern (F-008, the only CRITICAL in this
audit), and a CSP that lets any host receive a WebSocket (F-013). The rule is
right; it has two holes.

---

# Phase 8 — Architectural Review

## Strengths

These are real and should survive any remediation. Several are better than what
this reviewer would expect from a team, let alone a single codebase of this size.

**Matchmaking correctness under concurrency.** All authoritative state lives in
Redis and every transition is a single Lua script, so transitions cannot
interleave across instances. This is the central architectural bet and it is
correct. `races.test.ts` maps onto the numbered scenarios in `DESIGN.md` §10 and
asserts specific outcomes — one match from a simultaneous two-instance join, never
two matches for one session under fan-out, a half-cleaned dead process, a
simultaneous skip naming exactly one winner, recovery from an emptied script
cache. This is the hardest part of the system and it is the best-tested part.

**Routing by channel name.** Cross-instance notification on `chat:ev:session:{sid}`
means the channel name *is* the routing key, so there is no routing table to go
stale. It is the kind of design decision that removes a whole class of bug rather
than handling it.

**The trusted boundary, and the logger that enforces it.** A recursive field
denylist that throws outside production, a metrics registry where every label is
drawn from a named fixed set, `dbErrorFields()` because driver errors echo
parameters, a rule against interpolating content into an `Error`, and a
notification payload that deliberately carries no conversation content. The
reasoning is written down beside each control. This is the most consistently
well-executed concern in the repository.

**Privilege separation in the console.** Its own process, its own database role,
`karobakbak_app` denied `admin_accounts` outright and `karobakbak_console` unable
to delete a conversation, both asserted in integration tests. The audit row
written before the content is selected and in the same transaction, so "a read
that was not logged did not happen" — with a test that breaks the audit insert and
asserts no transcript comes back. That is a genuinely high-assurance design.

**Advertising as an absence.** There is no ad module, endpoint or state on the
server, so "advertising can never observe or influence matchmaking" is
structurally true rather than intended. `script-src 'self'` means a third-party
provider cannot be added without an explicit, reviewable CSP change. Designing a
guarantee as the absence of a surface is the strongest form available.

**The load-test swarm and its trap ledger.** A persona model, a layered oracle
suite, seeded RNG, and — most valuably — a written record of every wrong
assumption that cost a run. §4 of `testing/SWARM-HANDOFF.md` is the highest-value document
in the repository for anyone new.

**The commentary.** Unusually, the comments explain *decisions* rather than
restating code, and they name the alternatives that were rejected. Where they are
wrong (F-011, F-021, F-027) they are wrong because a decision changed underneath
them — which is a maintenance problem, not a discipline problem.

## Weaknesses

**Two layers claim authority over session state, with no reconciliation
contract.** The server owns the session; the client predicts it. There is no rule
saying which frames must correct which optimistic transitions, so the answer
differs per code path and is wrong on the refusal paths (Pattern 3).

**Retention has one durability class and needs two.** Everything from an ordinary
message to an acknowledged report to a legally held transcript flows through the
same best-effort queue with the same drop-on-pressure semantics. Priority classes
P0-P3 order the *writes* and do not change the *guarantee*. The promises the
product makes are not all the same strength, and the pipeline cannot express the
difference (Pattern 1).

**Legal-hold containment has no single definition.** The conversation delete
excludes parents of held children; the child deletes ignore held parents; two of
the five retained tables have no `legal_hold` column at all. Whether a hold on a
conversation covers its contents is answered differently by each statement
(F-007).

**Observability is declared in one module and wired in another, with nothing
connecting them.** No test, type or lint rule ties a declaration in
`registry.ts` to a write site, so ten metrics drifted into decoration and two
dashboard panels went permanently blank without anything noticing (F-019).

**Nothing runs the checks.** A dozen important invariants in this system are
enforced by tests — the logger denylist, the `innerHTML` ban in `console.js`, the
database role separation, the ban/block namespace separation, the byte-identity of
the two protocol files. With no CI, each is enforced by memory (F-015).

## Coupling and boundaries

Module boundaries are good and dependency direction is clean. `protocol/` is a
genuine source of truth with a mechanical drift check; `redis/store.ts` is the
only place Lua replies are parsed; config is injected rather than a singleton;
the console is a separate process rather than a route. The one boundary violation
of substance is `saveMatchIdentities()` (F-003) reaching Redis with a plain `HSET`
outside the Lua discipline that governs every other match mutation — and it
produces exactly the class of bug that discipline exists to prevent.

The frontend's `machine.ts` / `presentation.ts` split is well-motivated on paper
and is where two findings live, because the protocol layer was updated for D42 and
the presentation layer was not (Pattern 6). The seam is right; it just has no
tests on one side of it.

## Future scaling risks

Ranked by when they bite.

1. **Deletion throughput (F-029).** Already binding at modest volume. The backlog
   grows monotonically and nothing measures it.
2. **Availability alerting (F-018).** Production runs one replica and the page for
   "the backend is gone" cannot fire. This is a risk at *any* scale, including
   today's.
3. **Redis memory (F-003).** `noeviction` plus orphan match hashes that no janitor
   can see is a slow leak with a hard ceiling. Fast-disconnect load — which is
   ordinary user behaviour here — is what accumulates them.
4. **No matchmaking latency SLI (F-019).** The first real scaling decision — more
   instances, queue segmentation, a premium segment — has to be made without the
   number that would justify it. The seam for segments exists and is well kept
   (D23); the measurement to drive it does not.
5. **Reconnect thundering herd (F-014).** Costs nothing at hundreds of users and
   turns every deploy into an incident at tens of thousands.
6. **DNS round-robin at the edge.** Documented honestly in `nginx.conf` as a known
   trade against `least_conn` and passive health checks, with the correct
   conclusion that scaling past one replica means a real load balancer. Recorded
   here as an accepted decision, not a finding.

## Technical debt: acceptable vs actively harmful

**Acceptable, and correctly reasoned about in the code:** DNS round-robin at the
edge; the file spool being bounded rather than durable; queue segments existing
with only `default` populated; `bot.ts` at 1,224 lines; the spam oracle's
false-positive growth, which is measured and reported rather than hidden;
`looksAbusive` cheating, which is disclosed where its number is quoted.

**Actively harmful:** the absence of CI (F-015), because it makes every other
control optional; the unwired metrics (F-019), because they are believed; the
stale D7 copy and routing (F-010, F-011), because they cost users conversations
the server was holding for them; and `NullRetentionSink` in the message suite
(F-025), because it is the reason the most serious finding in Pattern 1 was
invisible.

## Recommended direction

No rewrite is warranted, and none is recommended. The architecture is sound and
the central bet — Redis-authoritative state, Lua transitions, per-session
channels, write-behind retention — is correct. Four targeted changes address
almost everything above:

1. **Split retention into two durability classes.** *Promised* records (reports
   the user was told were received, anything under legal hold, moderation evidence
   for a hard block) refuse rather than drop, and are never evicted by a later
   record. *Best-effort* records keep exactly today's behaviour. This is a change
   to `queue.ts` and its callers, not to the architecture.
2. **Define hold containment once.** Cascade the flag on placement and on insert
   into a held conversation, add `legal_hold` to `moderation_events` and
   `enforcement`, and let every delete statement read one rule.
3. **Give the client a reconciliation contract.** Every refusal that invalidates
   an optimistic transition carries an authoritative status frame; the reducer
   applies server state and never infers session state from a socket event.
4. **Tie declarations to wiring.** A test that every metric in the `Metrics`
   interface has a write site; alerts expressed as ratios against exported limits;
   a backlog gauge instead of a throughput counter; and CI that runs all of it.

---

# Phase 9 — Prioritisation

Ranked on impact, effort, risk and confidence together. Effort is a rough
engineering estimate; risk is the risk of *making the change*.

## Fix immediately — should not remain in production

| ID | Finding | Impact | Effort | Risk | Confidence |
| --- | --- | --- | --- | --- | --- |
| F-008 | Wildcard `enforcementId` revokes every active ban | Catastrophic and immediate: one request disables all enforcement | Low — validate the id, use `= any($1::text[])` | Low | High |
| F-029 | Deletion capped at 500 rows/table/hour | The product's central privacy promise is unmet and unmeasured | Low — `runUntilDrained` already exists | Low | High |
| F-002 | Unhandled reconnect rejection can kill the process | A Redis blip becomes a full-instance outage | Low — one `catch` | Low | High |
| F-018 | `BackendDown` cannot fire when the backend is gone | The one availability page is blind to the likeliest outage | Low — add `absent()` | Low | High |
| F-004 | Hard-blocked messages retained nowhere | The most serious abuse leaves no evidence | Low — move `persist()` above the return | Low | High |

## Fix soon — meaningful risk, days not weeks

| ID | Finding | Impact | Effort | Risk | Confidence |
| --- | --- | --- | --- | --- | --- |
| F-005 / F-023 | A P0 record evicts another session's acknowledged report | Users told a report was filed lose it silently | Medium | Low | High |
| F-007 / F-024 | A conversation hold preserves only the conversation row | Legal preservation fails at the moment it is needed | Medium — needs a migration | Medium | High |
| F-009 | Resume token cleared for the whole session on `partner_left` | §28 fails in the common case; partners wait out a dead grace window | Low | Low | High |
| F-010 | Conversation dropped from screen on any socket blip | Users abandon conversations the server is holding | Medium | Low | High |
| F-026 | Refused join leaves the client searching forever | Reachable in ordinary use with auto-search on | Low | Low | High |
| F-003 | Orphan match hashes survive with no TTL and no janitor | Slow Redis leak toward a `noeviction` ceiling | Medium — new Lua script | Medium | High |
| F-015 | No CI | Every test-enforced invariant is optional | Low | Low | High |
| F-019 | Ten unwired metrics, two blank dashboard panels | No SLI for the core product behaviour | Medium | Low | High |
| F-001 | Production accepts the published default hash salt | Deterministic, reversible identity hashes on a bad deploy | Low | Low | High |

## Plan — architectural debt worth scheduling

| ID | Finding | Note |
| --- | --- | --- |
| F-025 | `NullRetentionSink` hides the retention half of the pipeline | Do this *with* F-004; it is the regression test |
| F-011 | Stale D7 copy and headers | Do this *with* F-010; the copy is invisible until the routing is fixed |
| F-028 | `message_ack.delivered` overstates delivery | Protocol change; needs the frontend copy regenerated |
| F-013 | CSP permits a WebSocket to any host | Verify in the deployed configuration before shipping |
| F-020 | Alert thresholds hardcode config defaults | Best done alongside F-019 and the backlog gauge from F-029 |
| F-027 | Cluster gauges freeze on followers | One `.reset()` on the non-leader path |
| F-006 | `SPOOL_BACKEND=redis` accepted and ignored | Implement it or reject it at startup |
| F-012 | Escape both closes a dialog and skips the stranger | Cheap, and it is an irreversible action behind a reflex |
| F-014 | No reconnect jitter | Two lines; matters before the next scale step |
| F-017 | Side effects in a documented-pure reducer | Do this *with* F-009; it is the same code |

## Nice to have

F-016 (landing-screen retention copy), F-021 (`instance` label collision),
F-022 (`/health` exposure). Each is a small, contained correction.

---

# Phase 10 — Final Report

## 1. Executive summary

This is a well-engineered system with an unusually clear architectural thesis, and
it has a specific, correctable blind spot.

The hard parts are done well. Matchmaking is correct under concurrency across
multiple instances because every transition is a single Lua script, and the race
suite proves it against the numbered scenarios in the design rather than against
convenient ones. The trusted boundary for message content is defended by a logger
denylist, a fixed-label metrics registry, and a set of narrower rules — never log a
`pg` error, never interpolate content into an `Error` — each written down beside
the code it governs. The moderation console runs as its own process under its own
database role and writes its audit row before it reads the content. Advertising
cannot influence matchmaking because there is no server-side surface for it to
touch. The load-test harness is real, and its record of wrong assumptions is the
most useful onboarding document here.

The blind spot is consistent enough to name in one sentence: **this system is
careful about what it does and careless about what it keeps.** A hard-blocked
message is refused correctly and its evidence is never stored. An acknowledged
report can be silently displaced by a later one. A legal hold preserves the
conversation row and none of its contents. The deletion worker removes 500 rows
per table per hour and will never remove more, so at any real volume the retention
promise printed on the landing page quietly stops being true. None of these fails
loudly, and the tests that appear to cover them assert the visible half of each
operation and stub, ignore or mis-assert the durable half.

Two other clusters matter. Several controls are declared and never wired — ten
metrics nothing writes, two blank dashboard panels, an availability alert that
cannot fire when the backend disappears, and a `verify` script no CI runs. And the
client predicts session state the server never confirms, which costs users
conversations the server is actively holding for them: a refused join leaves the
search screen running forever, a partner leaving disables resumption for the rest
of the session, and a dropped socket shows a landing page over a live conversation
while telling the user it is over.

One finding is critical on its own: any authenticated console session can revoke
every active ban in the system by submitting `%` as an enforcement id.

Engineering quality overall: high. The defects found are not the result of
carelessness — they are the result of a correct principle ("chat must never wait
on the database") generalised one step past where it holds, plus a test suite
whose shape mirrored that generalisation. Fixing the pattern is a smaller job than
the finding count suggests.

## 2. Codebase overview

A Node.js/TypeScript WebSocket service pairs anonymous strangers for text chat.
A backend instance owns only sockets and a local `Map` for finding them; all
matchmaking state lives in Redis and every transition is one Lua script, so N
instances cannot interleave. Cross-instance delivery uses Redis Pub/Sub on a
per-session channel, making the channel name the routing key. TTLs plus a
leader-locked janitor are the recovery net. Retained conversations reach
PostgreSQL through a write-behind path — a priority-bounded queue, a circuit
breaker, batched inserts, and a bounded file spool while the breaker is open — so
a database outage can never become a chat outage. A separate process serves the
moderation console under a separate database role. A React client mirrors server
state through a pure reducer. An nginx edge serves the bundle and proxies the
socket. Prometheus scrapes each replica by DNS discovery; Grafana renders it.

## 3. Critical findings

**F-008 — Any authenticated moderator can revoke every active ban.** The revoke
route accepts any non-empty string and uses it as a SQL `LIKE` pattern for both
the database update and the Redis key removal. `%` matches everything. The audit
row records the wildcard, not the sanctions it lifted. This defeats the system's
central abuse-enforcement control in one request, and the enforcement test suite
never supplies an id the system did not generate.

## 4. Complete findings

The full ledger is at the top of this document: 29 findings — 1 critical, 12 high,
12 medium, 4 low — each with location, evidence, a failure scenario and a
recommendation in its batch section.

## 5. Security review

The security posture is strong at the boundaries and has two holes at the seams.

Strong: server-minted identifiers only, with no client frame choosing identity,
routing or ordering; salted-hashed IPs that are never logged raw and never used
raw as Redis keys; blocks and bans in separate namespaces with a test asserting a
ban revocation cannot delete a user's own block; parameterised SQL everywhere in
the repositories; scrypt passwords, TOTP with replay protection, absolute session
lifetimes and correct cookie flags on the console; binary WebSocket frames refused
as an architectural decision; a console origin with no `innerHTML`, enforced by a
test; `script-src 'self'` with no third-party origins.

Holes: the `LIKE`-pattern revoke (F-008), which is the only critical finding here;
and a CSP whose `connect-src 'self' ws: wss:` permits a WebSocket to any host
(F-013), leaving an unblocked exfiltration channel on the origin that renders
retained plaintext. Lesser: production accepts the published default hash salt with
only a warning (F-001), and `/health` publishes the instance id and draining state
to the internet (F-022).

Privacy specifically: data minimisation is genuinely good — the profile never
leaves the browser between sessions, no cross-chat correlator exists, and the
design records why. The weaknesses are all on the retention side: holds that
preserve nothing (F-007), deletion that cannot keep up (F-029), a spool backend
setting that silently does not apply (F-006), and a landing-page claim that
contradicts the retention notice beneath it (F-016).

## 6. Performance and scalability review

No hot-path inefficiency was found, and the two decisions that matter most for
performance are right: chat never waits on PostgreSQL, and matchmaking state
transitions are single round-trips to Redis rather than read-modify-write cycles.

The scaling risks are operational rather than algorithmic, and are ranked in Phase
8: deletion throughput binds first (F-029), then availability alerting (F-018),
then Redis memory growth from orphan match hashes (F-003), then the absence of a
matchmaking latency SLI to justify the first scaling decision (F-019), then the
un-jittered reconnect herd (F-014).

## 7. Reliability review

Failure handling is deliberate in most places: `/ready` reflects Redis and not
PostgreSQL, so a backend with a dead database stays in the load balancer and keeps
serving chat correctly; the circuit breaker distinguishes transient failures from
permanent SQL rejections before retrying; the janitor never throws on a Redis blip;
shutdown drains sockets before stopping storage and does not hold seats, because a
shutdown is not a blip.

The reliability defects are: an unhandled detached promise on the resume path that
can terminate the process during a Redis failure (F-002); an availability alert
that cannot fire when the process is gone (F-018); orphaned Redis keys that no
recovery path can see (F-003); and a synchronised client reconnect wave after any
restart (F-014).

## 8. Architecture review

See Phase 8 above for strengths, weaknesses, coupling, scaling risks, debt
triage and the recommended direction. In brief: the architecture is sound, no
rewrite is warranted, and four targeted changes — two retention durability
classes, one definition of hold containment, a client/server reconciliation
contract, and a mechanical link between declarations and wiring — address almost
everything found.

## 9. Testing review

Roughly 12,000 lines of backend tests across 41 files, plus a reducer suite on the
frontend and a substantial load-test harness. Volume is not the problem.

Strongest: `races.test.ts`, which maps onto the design's numbered race scenarios
and asserts specific outcomes; the storage tests that assert database role
separation; the test that breaks the audit insert and asserts no transcript comes
back; the logger and metrics leak canaries.

Weakest, and consistently so: where an operation has a visible effect and a
durable one, the durable one is stubbed (`NullRetentionSink`, F-025), counted only
at the parent level (the hold test, F-024), or covered by a title the assertion
does not check (the P0 capacity test, F-023). Separately, the suite tests the
system against inputs the system generated, which is why F-008 was not caught.
And nothing at all covers the frontend's view layer, which is where the D42
reversal failed to land (F-010, F-011).

Nothing runs any of it automatically (F-015).

## 10. Observability review

Would an engineer woken at 3 a.m. find the cause? For a matchmaking or delivery
failure, probably yes — the structured logging is clean, ids are present, and the
label sets are disciplined. For anything else, several important answers are
missing by construction: there is no matchmaking latency series, no enforcement
series, no database write latency or failure series, no protocol-abuse counters,
no backlog measurement for deletion, and the two headline gauges read stale
followers. The one availability page cannot fire when the process is gone. The
alert file's editorial principle — few alerts, each either "users are affected" or
"a promise is silently not being kept" — is exactly right, and the gap is that
several of the promises now being silently broken have no rule watching them.

## 11. Technical debt

Triaged in Phase 8. Acceptable: DNS round-robin at the edge, the bounded
non-durable spool, unpopulated queue segments, `bot.ts`'s length, the spam
oracle's disclosed precision budget. Actively harmful: no CI, the unwired metrics,
the stale D7 copy and routing, and `NullRetentionSink`.

## 12. Quick wins

High value, low effort, low risk — a single day's work covers all of these:

1. Validate `enforcementId` and use exact matching (F-008) — closes the only
   critical finding.
2. Call `runUntilDrained()` from the deletion interval (F-029) — the function
   already exists.
3. Add a `.catch()` to the detached reconnect task (F-002).
4. Add `absent(up{job="karobakbak-backend"})` as a page (F-018).
5. Move `persist()` above the hard-block return (F-004).
6. Delete the `clearResumeToken()` call from `partner_left` (F-009).
7. Add jitter to the reconnect backoff (F-014).
8. `connect-src 'self'` in the CSP (F-013), verified against the deployment.
9. `.reset()` the cluster gauges on the non-leader janitor path (F-027).
10. Suppress the global Escape handler while any modal is open (F-012).

## 13. Recommended roadmap

```text
NOW  (this week)
├── The ten quick wins above
├── CI running `npm run verify` plus the integration suite (F-015)
└── Regression tests for each fix, written before the fix:
    a recording retention sink (F-025), the P0 cross-session case (F-023),
    child counts in the hold test (F-024), a hostile enforcement id (F-008)
        ↓
NEXT (this month)
├── Two retention durability classes; promised records refuse, never evict (F-005)
├── One definition of hold containment, with the migration adding
│   `legal_hold` to `moderation_events` and `enforcement` (F-007)
├── Backlog gauges and ratio-based alert thresholds (F-029, F-020)
├── Wire the ten metrics, starting with matchmaking latency, and add the
│   test that binds a declaration to a write site (F-019)
├── Client reconciliation: authoritative status on every refusal, and no
│   session state inferred from a socket event (F-026, F-009, F-010, F-011)
└── The conditional Lua script for match identity writes (F-003)
        ↓
LATER (next quarter)
├── Rename `message_ack.delivered` and add a waiting state (F-028)
├── Resolve `SPOOL_BACKEND` — implement the Redis spool or reject the value (F-006)
├── Reject the default hash salt in production (F-001)
├── Frontend tests for the view layer, which currently has none
└── Re-read `testing/SWARM-HANDOFF.md` §4 for the twenty traps this audit did not
    convert; three of twenty-three turned out to be product defects, and the
    conversion rate suggests others may be
```

---

*Audit complete. Ten batches, 29 findings, all major subsystems inspected and all
critical paths traced. Areas deliberately left unexamined and judged low-risk:
Dockerfiles and entrypoint scripts, the migration container, individual persona
and oracle modules inside `load-test/swarm/src/`, and presentational React
components not implicated in a finding.*

---

# Remediation Log — Quick Wins Pass

Eleven findings closed. Each entry says what changed and how it was verified.
Nothing here is a refactor: every change is the smallest one that makes the
finding false, plus the test that would have caught it.

## What changed

**F-008 — wildcard ban revocation (CRITICAL).**
`enforcementRowIds()` in `backend/src/util/ids.ts` validates a supplied id
against `^enf_[A-Za-z0-9_-]{22}$`, accepts either the base form or a
per-dimension form, and returns the exhaustive list of row ids that decision
could have written. `revokeBan()` and `markApplyFailed()` in
`backend/src/admin/enforce.ts` now use `enforcement_id = any($1::text[])`; there
is no `like` left in the file. A malformed id is refused before the transaction
opens, so it writes no audit row claiming a decision was made. The audit row now
records the normalised base id rather than whichever form the console sent.

Note the second, quieter half of this: base64url contains `_`, which is a
single-character wildcard in `LIKE`. Even a well-formed, server-generated id was
being used as a pattern rather than a value, including on the internal
`markApplyFailed` path where no attacker was involved.

**F-029 — deletion capped at 500 rows per table per hour.**
`start()` in `backend/src/storage/deletion.ts` now calls `runUntilDrained()`
rather than a single `runPass()`. `DeletionPassResult` gained a `failed` flag,
because `more` and a failure mean opposite things to a draining caller: the
error path used to report `more: true`, which under the new scheduling would
have retried a database that is refusing every statement up to `maxPasses` times
per run. The drain now stops on the first failure and lets the next scheduled
run retry. Batch size is unchanged — it was never the problem.

**F-002 — unhandled rejection on the resume path.**
The detached task in `backend/src/server.ts` gained a targeted `try/catch`
around `restoreMatch`/`announceReturn` that degrades to a `connected` frame
without `resumed` — a case the client already handles as "the resume did not
take" — plus a backstop `.catch()` on the task itself, so no future addition to
it can reach Node's unhandled-rejection handler and take the process with it.

**F-004 — hard-blocked messages retained nowhere.**
`persist()` is now called before the hard-block return in
`backend/src/ws/messages.ts`. Delivery is still refused; only the record
changes. The evidence lands where it should: the message at P1 (moderated) and
each `moderation_event` at P0.

**F-025 — the retention half of the message pipeline was stubbed.**
`backend/tests/unit/messages.test.ts` now builds with a `RecordingSink` instead
of `NullRetentionSink`, and asserts what reaches retention on four branches:
hard-blocked, flagged-and-delivered, ordinary, and never-accepted. This is what
made F-004 invisible, and it is the reason the fix has a test that fails without
it.

**F-018 — the availability page could not fire.**
`BackendAbsent` (`absent(up{job="karobakbak-backend"})`, `for: 1m`,
`severity: page`) added beside `BackendDown` in
`monitoring/prometheus/alerts.yml`. `BackendDown` covers a target that is
discovered and failing; the new rule covers the target list going empty, which
is what a crashed container looks like under DNS discovery.

**F-027 — cluster gauges frozen on followers.**
The janitor's `onCounts` callback now takes `counts | null` and is called with
`null` on a pass where the lock was not acquired
(`backend/src/ws/janitor.ts`). `backend/src/server.ts` publishes zero for both
gauges in that case, so `max`, `sum` and a bare selector all agree. `reset()`
was deliberately not used: it clears a labelled gauge's series and re-zeroes an
unlabelled one, so the two here would have behaved differently for no reason a
reader could infer.

**F-009 — resume token cleared on the wrong event.**
`clearResumeToken()` moved from `partner_left` to `SESSION_GONE` in
`frontend/src/state/machine.ts`. A conversation ending leaves the session alive
and resumable; only the server saying the session is gone spends the token. The
clear also no longer runs above the stale-frame guard.

**F-014 — no reconnect jitter.**
`withJitter()` in `frontend/src/hooks/useChat.ts` spreads each delay over half
its window. Half fixed and half random rather than full jitter, so a client
still backs off monotonically — full jitter can pick a shorter wait on a later
attempt, which reads as a client that never settles. The unused
`saveResumeToken` import was removed while in the file.

**F-013 — CSP permitted a WebSocket to any host.**
`connect-src` is now `'self'` alone in `frontend/security-headers.conf`, with a
comment recording why the scheme sources were not needed and what they cost.

**F-012 — Escape closed a dialog and skipped the stranger.**
`frontend/src/App.tsx` derives `overlayOpen` from the five dialog flags it
already owns, and the global Escape/Enter shortcut stands down while any of them
is set.

## Verification

`npm run verify` is green end to end: protocol drift check, both typechecks, 404
backend unit tests across 21 suites, 48 frontend tests across 2 files.

Two fixes were checked by deliberately reverting the source change and
confirming the new test fails:

- Restoring `clearResumeToken()` to `partner_left` fails
  `survives a partner leaving, because the session does` and
  `is untouched by a stale frame for a conversation that already ended`.
- Removing the `persist()` call from the hard-block branch fails
  `retains a hard-blocked message and its moderation events (I10)`.

A test that passes against the bug it claims to cover is the F-023 pattern this
audit found; these two are not that.

New tests:

- `backend/tests/unit/ids.test.ts` — seven cases for `enforcementRowIds`,
  including `%`, `enf_%`, `_`, `%_ip`, bare prefixes, a base id whose random
  part ends in `_ip`, and 500 real generated ids (base64url contains `-` and
  `_`, so a stricter character class would have refused roughly a third of real
  ids — moderators unable to revoke exactly the sanctions they issued).
- `backend/tests/unit/messages.test.ts` — four retention branches.
- `backend/tests/integration/admin-enforce.test.ts` — three cases: a wildcard
  revokes nothing in either store and writes no audit row; a revoke lifts only
  its own decision and not a neighbour's; a per-dimension id still lifts both
  dimensions.
- `backend/tests/integration/deletion.test.ts` — a backlog of seven
  conversations and fourteen messages drained in one run at batch size two, and
  a failing database attempted exactly once rather than a hundred times.
- `frontend/src/state/machine.test.ts` — six cases for the token's lifetime.
  These install an in-memory `sessionStorage` on `globalThis.window`, because
  vitest runs in a bare Node environment here with no `window` at all: `resume.ts`
  swallows every storage error by design, so without the shim each of these
  assertions would have passed without exercising anything.

## Integration run

Docker was unavailable when the fixes were written; it has since been started and
the suites have run. **21 suites, 401 tests, all passing**, against real Redis and
real PostgreSQL.

Two things came out of actually running them.

**One of the new tests was insufficient, in exactly the way this audit
criticised.** `drains a backlog larger than one batch` called `runUntilDrained()`
directly — but the defect was in `start()`, which is what schedules it. Reverting
the fix showed the problem plainly: that test still passed against the bug. It is
the F-023 pattern, committed by the person who wrote F-023. A second test,
`drains on its own schedule, rather than one batch per interval`, now goes
through `start()` with a one-second interval and fails against the old
scheduling (two conversations deleted, five left). The original test was kept —
it covers multi-batch drain correctness — but its title no longer claims to
cover the scheduler.

**A wrong assumption in a third test surfaced a new finding.** The drain test
asserted fourteen message deletions and got eight. `messages.conversation_id` is
`on delete cascade`, so most expired messages leave with their parent and are
never counted by the statement that counts messages. The rows were all gone; the
counter undercounts. Recorded as F-030, and the assertion now documents the
behaviour instead of asserting a number that was never true.

Each fix with an integration test was checked by reverting the source change and
confirming the test fails:

- Restoring `enforcement_id like $1 || '%'` fails
  `refuses a wildcard instead of revoking every sanction in the table` and
  `accepts a per-dimension id and still lifts both dimensions`.
- Restoring `void this.runPass()` in `start()` fails
  `drains on its own schedule, rather than one batch per interval`.

## Not verified here

**The CSP change needs confirming against a real deployment.** `connect-src
'self'` is correct for the default configuration, where the client derives its
socket URL from the page origin. A deployment that sets `VITE_WS_URL` to a
different origin must name that origin in the header, and this change would
break its socket until it does.

## Still open

**Every finding in this audit is now closed.** Thirty of thirty.

The last nine went together, because they were the same kind of problem: a
system telling you something that was not quite true. Configuration accepted
and ignored, thresholds repeated where they could drift, a label under a name
nothing queried, an endpoint naming its own instance to the internet, a screen
claiming nothing was kept, a reducer writing storage where ordering could not
protect it, and an ack field reporting a moderation verdict under the name
`delivered`.

Two are worth singling out. `SPOOL_BACKEND=redis` is now **refused at startup**
rather than implemented: a Redis-backed spool would die with a Redis restart,
because persistence is deliberately off (D12), so it would be less durable than
the file it replaced while looking like an upgrade. And `chat_retention_backlog`
replaces a throughput counter as the measure of whether deletion is keeping up —
a worker falling behind still deletes steadily, so the counter looks healthy
either way, while a backlog above zero across passes does not.

**F-003 is now fixed.** `saveMatchIdentities` is a Lua script that writes only
onto a match that still exists and reports `match_gone` otherwise, instead of a
bare `HSET` that recreated a torn-down match as a hash with no TTL and no
membership of the janitor's discovery set. `HSET` on a live key leaves its TTL
alone, and the script deliberately does not re-apply one — that would be an
identity write quietly extending a conversation's life.

The caller now acts on the result, which is the point of making the write
conditional: `announceMatch` returns `idle` rather than announcing a match into
a conversation that has already ended. The retention row is still enqueued
first, deliberately — the match did exist, and whoever ended it has already
enqueued a `conversation_ended` carrying the same id, which the writer would
otherwise hold back for ever waiting for a parent that was never written.

Two things surfaced. `FakeStore.saveMatchIdentities` reproduced the bug rather
than the behaviour — it recreated the record unconditionally — so no unit test
could have failed on this; and the fake's `tryMatch` never created a match
record at all, a divergence from the real script that was invisible for exactly
as long as the identity write papered over it. Both corrected.

**F-015 and F-019 are now fixed.** `.github/workflows/verify.yml` runs the
protocol drift check, both typechecks, both unit suites and — in a second job
with real Redis and PostgreSQL services — the integration suite, on every push
and pull request, plus a guard that no tracked file carries CRLF. A dozen of
this system's load-bearing invariants are enforced by tests rather than by
types, and each of them was, until now, enforced by memory.

Nine of the ten dead metrics are wired: `matchAttempts` and
`matchmakingFailures` from a matchmaking observer on `SessionLifecycle`;
`invalidFrames` (now labelled by reason), `oversizedFrames` and `socketErrors`
from observer callbacks on `SocketConnection`; `dbWriteLatency`,
`dbWriteFailures` and `breakerTransitions` pulled by
`RetentionMetricsPublisher` in the same style as everything else it samples, so
the write path still carries no metrics dependency. `matchmakingLatency` — the
headline SLI, three dashboard panels, never once written — needed a clock that
starts when a session is told it is queued and stops when it is told it matched,
which are two different requests decided by two possibly different instances;
both delivery paths now report to one observer on the instance holding the
socket. An integration test asserts a sample lands through the real socket path.

The tenth, `enforcementActions`, was **deleted** rather than wired, and its
dashboard panel with it. The only process that issues or revokes a sanction is
the moderation console, which is deliberately isolated (D32) and exposes no
scrape endpoint, so the metric could not have been collected from anywhere.
Measuring it means giving the console its own endpoint and Prometheus job —
a change to what the console is, not a wiring fix. Recorded here so the decision
is visible rather than implied by an absence.

`metrics-wiring.test.ts` reads the `Metrics` interface out of its own source and
fails if any declared metric has no write site elsewhere in `src/`. No test that
reads the *scrape* could have caught this: `prom-client` emits an unlabelled
counter or histogram at zero the moment it is registered, so a dead metric is
not missing from the output — it is present, plausible and permanently zero,
which on a graph is indistinguishable from a healthy system with no traffic.

**F-010, F-011 and F-026 are now fixed**, together, because they are one
user-visible failure between them. `phaseOf` takes the state rather than the
screen and keeps the conversation layout for a disconnected session that still
holds a match — which is what makes `ReconnectBanner`, `ConnectionStatus` and
the §28 countdown reachable at all for the first time. The banner's copy, which
still told the user a reconnection starts a new conversation, would have become
*visible* wrongness the moment the routing was fixed, which is why the two had
to move together. And a refused join now rolls its own optimistic transition
back, keyed on a `searchPending` flag so a genuinely queued session is never
dropped out of the queue on screen; the server also replies with an
authoritative `queue_status: IDLE` on both refusal paths.

Three things surfaced while fixing them. `AGE_BELOW_MINIMUM` was a third path
into the same stuck screen and had no client copy at all. A refused declared
name needed its own error code — `NAME_REFUSED`, on the reasoning
`AGE_BELOW_MINIMUM` already records — because `VALIDATION_FAILED` is what every
malformed frame in the protocol produces, and "invalid input" for a well-formed
name is not something a user can act on. And `leave()` silently did nothing when
the socket was down, which was unreachable before and became reachable the
moment the back button stayed on screen through a reconnect.

`presentation.ts` now has a test file. It had none, and that is not incidental
to what was wrong with it: when D42 reversed D7 the reducer was updated and its
tests with it, this file was not, and nothing failed.

**F-007 and F-024 are now fixed.** Containment is expressed in the deletion
queries: each child delete excludes rows whose parent conversation is held, and
a moderation event — which is never a hold subject and has no `legal_hold`
column — is kept by a hold on either of its parents. The alternative the
original finding offered, cascading the flag onto children, was rejected on
`holds.ts`'s own doctrine that the boolean is *not* the hold: a flag written
onto a message because its parent was held would be a flag with no hold row
naming it, and on release nothing could tell it apart from a hold placed on
that message directly. `enforcement` is deliberately excluded — it is keyed on
an identity hash with no conversation, so there is no containment relationship
to express, and a sanction that must outlive its retention needs a hold subject
of its own.

F-024's test asserted only that the conversation row survived and passed on runs
that had deleted the whole transcript; it now counts the children, and three
further tests cover the moderation-event parents, release, and the guard against
over-correcting into "never delete a moderation event". Three of the four fail
against the old queries.

**F-005 and F-023 are now fixed.** A P0 record is never displaced to make room
for another session's: `NEVER_EVICTED_FOR_ANOTHER_SESSION` in
`backend/src/storage/queue.ts` refuses instead, and the caller fails the client
operation honestly — which `server.ts` already did correctly, so the defect was
confined to the queue. The per-session branch is deliberately unchanged: a
session over its share still displaces its own oldest record, because without
that one flooder fills P0 and every honest report after it is refused, which is
a worse failure than the one being fixed (D26). P1 also still sheds across
sessions, and that is correct — nothing acknowledges a P1 record to anybody, so
it is load-shedding rather than a broken promise.

F-023's test was split into the two branches it conflated, with the assertions
its title implied; four unit tests were added beside it, since the unit-layer
equivalent had only ever been parametrised on P3. All three fail against the old
queue.

Nothing in this pass was committed; the working tree carries the changes.


### F-031 — the breaker could not open fast enough to reach its own spool

Found by chaos scenario C1, which is the only thing here that has ever made the
database actually unreachable under load. The run proved what it set out to
prove — delivery held at 43.5 msg/s while PostgreSQL was paused, against 43.7
msg/s after it came back, so D16 holds and a database outage is not a chat
outage. But the breaker stayed CLOSED for the whole 60-second pause, the
retention queue grew from 30 records to 3320, and the outage spool never took a
single record.

The cause was arithmetic, visible in the log timestamps once they were lined up
per instance:

```text
backend-1 19:05:18.828   backend-2 19:05:18.491
backend-1 19:05:38.830   backend-2 19:05:38.495
backend-1 19:05:58.833   backend-2 19:05:58.493
backend-1 19:06:18.436   backend-2 19:06:18.436
```

Twenty seconds apart, exactly, against a `DATABASE_STATEMENT_TIMEOUT_MS` of ten.
Each failure was costing two deadlines: the statement hung until the driver gave
up, then `transaction()` sent a `ROLLBACK` down the same unanswered connection,
which queued behind it and waited out the deadline in its turn. The breaker
opens on five *consecutive* failures, so it needed 5 x 20s = 100 seconds of
downtime before it could open at all — and until it opens, the spool that exists
to absorb precisely this outage is unreachable. Four failures per instance in
sixty seconds is not a slow breaker; it is a breaker that cannot be reached.

A rollback down a connection nobody is answering was never going to succeed, so
the whole second deadline bought nothing. The fix distinguishes the two kinds of
failure by whether PostgreSQL answered at all: every error the server produces
carries a five-character SQLSTATE, including `57014`, its own statement timeout,
which arrives on a connection that is alive and listening. An error without one
was manufactured by the driver after it stopped waiting, and that connection's
state is unknown rather than merely failed — so no rollback is attempted.

The same six lines held a second defect with no symptom yet. The cleanup called
`client.release()` bare while the comment directly above it claimed it was
"releasing it with an error", which is what would have destroyed the client. It
did not, so a connection that timed out mid-transaction went back into the pool
with a transaction still open on the server, for the next borrower to inherit.
Both are fixed by tracking one `poisoned` flag and passing it to `release()`.

`tests/integration/pool.test.ts` covers it against a real server, which this
needed: the distinction under test is between an error PostgreSQL sent and an
error the driver invented, and a fake pool can only ever produce the one it was
told to. Making the client-side timeout win against a live server takes
`SET statement_timeout = 0` inside the transaction — the server stops enforcing
its own deadline, a long `pg_sleep` runs on undisturbed, and the driver's
deadline expires underneath it. That is the same shape as the paused container,
where the server enforced nothing because it was not running.

Reverted, the test reports `2024` against a limit of `1800` on a 1000ms deadline
— the doubling, measured — and `pool.totalCount` of 1 where it should be 0. The
third test fails too, and for the right reason: it inherits the connection the
second one poisoned, with the `pg_sleep` still running on it.

Reaching the spool now needs 5 x 10s rather than 5 x 20s. That is a fix to the
cost per failure, not to the threshold, and the threshold is still a tuning
decision an operator has to make deliberately: `BREAKER_FAILURE_THRESHOLD` x
`DATABASE_STATEMENT_TIMEOUT_MS` is the outage that must elapse before the spool
comes into play, and the queue absorbs everything until then. The chaos oracle
now prints that arithmetic instead of advising "lengthen the run".


### F-032 — one orphan message destroyed the batch it travelled in

F-031's fix made the outage spool reachable for the first time. The very next
chaos run showed what was waiting there.

The run lost **1,350 P0 records** — the most protected class, the one a
per-session sub-quota exists to defend (D26) and an alert pages on. The record
kinds were `conversation_started`, `conversation_ended` and `moderation_event`:
not messages, but the rows every message depends on. And the cause was not
capacity. Every rejection in the logs was the same single error:

```text
"count":7,"dbCode":"23503","dbConstraint":"messages_conversation_id_fkey"
```

A message whose conversation row had not been written yet. `DESIGN.md` already
treats that as normal rather than exceptional — the conversation row is written
by whichever instance won `tryMatch`, while each participant's messages are
flushed by whichever instance owns their socket, so a message routinely arrives
a cycle before its parent. That is exactly why `deferForParent` exists.

**Two separate amplifications turned one late parent into hundreds of losses.**

The first was in `writeGroup`. Its generic permanent-error branch is careful:
if a batch has more than one record it re-writes each one alone, so a single bad
row cannot take the innocent rows with it — the comment above it says so, and
names the failure it was written to stop. The missing-parent branch, sitting
directly above, did no such narrowing. It deferred the *entire group*, retried
the entire group, and when the one orphan's parent never arrived, discarded the
entire group. Ninety-nine messages whose conversations had existed the whole
time were dropped because they shared a batch with one whose did not. The
narrowing existed; the missing-parent path was the one door left open to the
failure it prevents.

The second was in `drainSpool`, which had no salvage at all. A spool batch is
whatever was outstanding when the database went away, in arrival order, mixed
across kinds — so one 23503 discarded up to a hundred records including the
conversation parents and moderation events beside it. Twelve such batches in
one run. The code justified itself on the grounds that a permanently-refused
record must not block the drain forever, which is true, and does not require
discarding the ninety-nine records around it.

Both are fixed by the same principle the live path already held: refusing a
batch is not refusing every record in it. `drainSpool` now calls the existing
`salvage`, and `writeGroup` narrows to individual rows before deferring, so only
genuine orphans are waited on and only genuine orphans are eventually dropped.

**A third defect, small and separate.** `reportDrop` logged every P0 loss as
`"dropped a safety record: retention capacity exhausted"` regardless of why,
although the caller had always passed the real reason to `countDrop` beside it.
So the run produced 357 page-worthy lines blaming capacity for records the
database had refused outright — opposite causes wanting opposite responses, one
of which no amount of capacity would fix. The two methods are now one
`dropRecord`, and the reason is on the line as well as the counter. The
exhausted-parent case also gets its own reason, `no_parent`, instead of being
folded into the generic `rejected`.

`rescues the rest of a spool batch one bad record poisoned` covers both
amplifications: a spool batch of an orphan message, a good conversation and its
message must end with the conversation and its message stored and exactly one
drop, counted `p3:no_parent`. Reverted separately, each half fails it — the
spool revert loses the conversation row, the narrowing revert loses the good
message. Two existing tests were updated to assert the new specific reason
rather than the generic suffix, which strengthens them.
