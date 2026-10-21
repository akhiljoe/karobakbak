# Build phases

Dependency order. Each phase ends with a gate that must pass before the next
starts, and each phase is one commit.

**Revised 2026-08-18** after reading `docs/`. Retention, safety (report/block),
typing, presence and temporary identities moved into scope; see `DESIGN.md` §1.2
for every reconciliation decision.

| Phase | Scope | Gate | Status |
|---|---|---|---|
| **0** | Repo skeleton, folder structure, git + remote, `.env.example`, `DESIGN.md`, protocol-drift checker | structure exists, git pushes | ✅ done |
| **1** | Protocol v1, envelope validation, `config.ts`, `logger.ts` | `tsc --noEmit`, unit tests | ✅ done |
| **1b** | **Protocol revision** — add `typing`, `report`, `block`, `presence`, `partner_typing`, `report_ack`, identities, `DUPLICATE_MESSAGE`/`MESSAGE_WITHHELD`; required `id` on `message`; 500-char default; per-command limit config | `tsc --noEmit`, validation tests updated, protocol copies identical | ✅ done |
| **2** | Redis layer: keys (segmented queue), client, all Lua scripts + typed store | integration tests against real Redis cover every script | ✅ done |
| **3** | Session + match lifecycle (join/skip/disconnect/heartbeat/block), local connection registry | unit tests with a fake store; integration tests for the §10 races | ✅ done |
| **4** | WebSocket server: upgrade, origin allowlist (prod-fatal when empty), frame limits, strikes, backpressure, concurrent-connection cap, `/health` `/ready` | integration tests over real sockets | ✅ done |
| **5** | Message pipeline: `message` + `typing` commands, per-command rate limiting at the edge, delivery through the existing dedupe/replay script. (Pub/Sub itself landed in phases 3–4) | two-instance integration test over real sockets | ✅ done |
| **6** | Moderation: content-type dispatch (`DESIGN.md` §23.5, one `text` branch, unhandled types fail closed), normalisation view, URL/contact rules, policy engine, flags | unit tests per rule; policy table test; unhandled-type fails closed | ✅ done |
| **7** | PostgreSQL: migrations, least-privilege roles, plaintext message persistence, priority-bounded write-behind queue, circuit breaker, outage spool, conversation/message/report/block/audit repositories | integration tests against real Postgres; queue bounds + per-session quota; breaker open/half-open/close + paced drain; spool partial-write and corruption recovery | ✅ done |
| **8** | Retention: deletion worker, legal hold, report-triggered extension, retention + backup metrics and alerts | integration test proves expiry deletes and hold protects | ✅ done |
| **9** | Metrics, structured logging, janitor, graceful shutdown | `/metrics` scrape test, shutdown test | ✅ done |
| **10** | Frontend: React + Vite + TS, full UI state machine, chat/matchmaking/landing screens, report/block/typing/presence, ad slots (no-op provider), CSP. Message list dispatches on `message.type` (`DESIGN.md` §23.4) with `TextMessage` the only implementation and a neutral placeholder for unknown types | `tsc --noEmit`, `vite build`; unknown type renders a placeholder rather than throwing | ✅ done |
| **11** | k6 load test, Docker images, compose (2 backends + Redis + Postgres), Prometheus, Grafana | `docker compose up` healthy, k6 smoke run | ✅ done |
| **12** | Operator README, final cross-repo consistency verification (`DESIGN.md` §22) | `npm run verify` green, checklist filled | ✅ done |
| **13** | **Moderation console** (`DESIGN.md` §25, R16). Enforcement read at the upgrade; scrypt + TOTP login on its own port and its own database role; report queue, audited conversation replay, verdicts, ban issue/revoke; ban reconciler so sanctions survive a Redis restart; three static files with no build step | banned key refused before a session is allocated; RFC 4226/6238 vectors pass; a read whose audit row fails returns no content; a request body cannot name its own ban subject; Redis flushed mid-test and bans return with the right remaining life | ✅ done |
| **14** | **Self-declared profiles** (`DESIGN.md` §26, R18/R19). Protocol revision: optional name, age, gender, country on `join_queue`; ISO country codes with display names shipped in the protocol; name moderated harder than a message (D35); age floor with its own code and a safety counter (D36); declarations stored as evidence on `conversations`; console renders them as claims; editor on the landing screen and in Settings | validator refuses a bad country, a non-list gender, a fractional age and an under-18 declaration by its own code; every country code has a display name; a cleared field is deleted from the session hash; declarations reach the partner and the database; page fits the viewport with no scroll to the composer | ✅ done |
| **15** | **Getting away from someone** (`DESIGN.md` §27, D38–D41). A block arriving after the partner left now records, via a TTL'd note of their hashes written by the shared teardown; one-tap Block & next; opt-in auto-search that refuses after a block and backs off rather than widening the join limiter; match notification gated on the tab being hidden | late block records, keeps the pair unmatchable, is spent once used, expires, and disables cleanly at 0; it ends no match and notifies nobody; full race suite still green after the shared-teardown change | ✅ done |
| **16** | **Session resumption** (`DESIGN.md` §28, D42/D43 — reverses D7). A dropped socket keeps its seat for a grace window; a single-use, rotated token in `sessionStorage` reclaims it over a WebSocket subprotocol; partner sees a countdown rather than "they left"; composer disabled while a partner is away; drain still tears down | resume restores the same conversation and the same stranger; a spent token is refused; a still-connected session cannot be taken over; an unknown or expired token opens a fresh session rather than erroring; the full race suite green after the shared-teardown change |  ✅ done |
| **17** | **The pre-launch floor** (`docs/policies/`, `JURISDICTIONS.md`). Age gate before the first conversation; Terms and Privacy linked from the gate *and* the footer; EEA + UK blocked at the edge with a 451 page; encrypted backups copied off the database host, with a failed copy failing the run | gate is not dismissable by Escape or backdrop and re-asks only when its wording version changes; storage failure shows the gate rather than skipping it; production compose refuses to build without the policy URLs and the backup remote; blocked countries refused on `/` **and** `/ws`; a dump decrypts and `pg_restore --list` reads it | ✅ done |

## AI personas — phases A0 to A6

Not numbered with the rest, because they are one feature that either ships
together or does not ship, and because the product is complete without them. All
seven are done and the whole thing is **off by default, twice**:
`PERSONAS_ENABLED` starts the process, and the `persona_control` table decides
whether anything may join — it ships disabled. Decision records are in
`DESIGN.md`. Running it: `docs/operations/OPERATIONS.md` §14.

| Phase | Scope | Status |
|---|---|---|
| **A0** | Twelve decision records into `DESIGN.md`; the policy patch staged rather than applied, with `verify-pending-policy.mjs` guarding it | ✅ done |
| **A1** | Character schema, seeded surface generation, name pools, and the brief's interchangeability check as executable code. Eight characters | ✅ done |
| **A2** | The control plane (four levers, drain-not-cut, Postgres-truth) and the WebSocket client, written fresh rather than on the swarm's `bot.ts` | ✅ done |
| **A3** | The fill policy: dispatch only when exactly one non-persona searcher has waited, withdraw when humans can pair, caps enforced in `assertCoherent` | ✅ done |
| **A4** | The provider seam, the Anthropic adapter, the integer cost model, and the spend ceiling with its own migration | ✅ done |
| **A5** | The six limits between the model and the socket, tested adversarially | ✅ done |
| **A6** | Sixteen metric series with one writer, eight alert rules, and the console's persona tab | ✅ done |

**The policy patch is applied.** The Terms and the Privacy Policy now describe a
service that has automated accounts in it. The staged patch file is gone; the
guard that watched it no-ops until the next staged patch needs it.

Two things that are *not* done, and neither is a coding task:

* **Publishing those documents is a material change** under their own 14-day
  notice clauses. The notice runs before personas reach production.
* **`{{MODEL_PROVIDER}}`** is a fourth template variable and only binds if
  personas ship with a model behind them. On the scripted voice they hold real
  conversations, spend nothing and reach no vendor.

---

## Phases 20 to 22 — sign-in, and what it unlocks

Shipped and merged. `AUTH_ENABLED`, `ACCOUNTS_ENABLED` and `AUTH_AVATARS` are
true; sign-in is Google through a Cognito pool on `<cognito-domain>`.

| | |
|---|---|
| 20 | Accounts over OIDC, saved connections, intent matching |
| 21 | The sign-in interface, the account menu, the avatar, Recent |
| 22 | Connection labels and presence, account-scoped blocks and unblock, reconnect |

`docs/operations/SIGNIN-SETUP.md` is the operational authority: what is configured, the one
command that proves the chain, and the runbooks for Cognito, the custom domain
and reaching a phone over HTTPS. `docs/PROGRESS.md` has the reasoning and the
four bugs that only two real clients could find.

Not built, deliberately, and each with the reason recorded: offline delivery for
a reconnect (the request rides an existing socket, which is why it costs
nothing), directed messaging, and friend requests as a durable inbox.

## Phases 23 and 24 — recognisable strangers, and two limits that enforced nothing

Neither was planned. Both came out of using the product and reading what was
actually wired, and `docs/PROGRESS.md` has the reasoning.

| | |
|---|---|
| 23 | The generated nickname is scoped to the session rather than the match (D50); Recent shows the declared name; auto-search keeps you in the chat shell; a header sign-in no longer ends the conversation |
| 24 | The §29.4 preference cooldown and hourly budget built and enforced (`PREFERENCE_LIMITS_ENFORCED` is true); the premium entitlement enforced on the session row and shipped **before** anything can buy one (D51) |

**The half that is missing is the client's.** `/auth/session` says nothing about
premium and `FILTERS_AVAILABLE` is compile-time, so once payments flip a free
user would see the filter control, set a preference, and have it silently dropped
— correctly by the gate, and invisibly by design. That is the next piece of
product work and it depends on none of the decisions still open below.

## Phases 25 to 34 — observability, security and scale

`docs/testing/OBSERVABILITY-AND-TESTING.md` is the contract. The premise: the operator's
questions were answered well, the founder's were not answered at all, and two of
the three observability pillars did not exist. Nothing about the product changes
in these phases; what changes is what can be seen and what has been proven.

| | |
|---|---|
| 25 | **Done.** Loki + Alloy, a provisioned datasource, a log dashboard, and `verify:logs`. Found F-036 on the way: the edge was writing client IPs and OIDC authorization codes to its access log |
| 26 | **Done.** Product metrics — the funnel, conversation quality, and the whole of `accounts/` and `payments/`, which write none today |
| 27 | **Done.** Cost metrics — cAdvisor, redis/postgres exporters, `chat_ws_bytes_total`, the price model as gauges, and recording rules for cost per conversation |
| 28 | **Done.** The four dashboards: health completed, product, cost, safety |
| 29 | **Done.** Traces — OTel with a span processor sharing `logger.ts`'s denylist, and `db.statement` off at the instrumentation. The highest I8 risk in the plan |
| 30 | **Done.** Payments and filters **on in the load stack**, end to end in a browser, including the D51 entitlement seam and webhook abuse probes |
| 31 | **Mostly done.** The security suite: abuse probes, protocol fuzzing, ZAP/nuclei, and supply chain in CI |
| 32 | **P group done.** The rest of the load catalogue — R, P, D, E groups — plus Sentinel failover, C3, C4, clock skew, memory pressure |
| 33 | Scale and regression: run annotations, a run dashboard, baselines and `--compare`, distributed workers |
| 34 | **Done.** `docs/testing/` — the register, the results, the evidence, the findings, and the launch gate as a claims-to-evidence mapping |

**Phase 30 is not a step towards enabling payments in production.** The load
stack publishes no policy documents. Production is a separate commit carrying
`docs/policies/PENDING-PAYMENTS.md`; what it still needs is in the Launch
section below.

## Launch — what is left, and none of it is code

**`docs/LAUNCH-CHECKLIST.md` is the tracked list.** This section holds the
reasoning behind the deploy-day settings; the checklist holds the state. Where
they disagree, this file is the authority on *why* and the checklist is the
authority on *whether*.

The engineering is done. Every decision has now been taken. The domain is
bought, the role addresses exist and the `www` redirect is deployed, so what is
left is the settings that follow from standing the stack up.

`docs/policies/JURISDICTIONS.md` records the geography decision.
`docs/policies/REVIEW-PROMPT.md` is the reusable prompt for putting the drafts
in front of a reviewer.

Decided since: encrypted backups go to object storage outside the hosting
country, a cross-border transfer disclosed as one in the privacy policy.

| Blocking | Detail |
|---|---|
| ~~A domain~~ **Done: `karobakbak.com`** | Bought, and filled in across `.env.prod.example`, `operations/OPERATIONS.md` and the Caddy hostname. Five role addresses exist and are mapped: `contact@` for operator identity, grievance officer and ban appeals; `privacy@`; `support@`; `abuse@` for legal, takedown and regulator mail; `hello@` deliberately unpublished. `{{CONTACT_EMAIL}}` and `{{LEGAL_CONTACT_EMAIL}}` are gone from the documents |
| ~~`www` must redirect, not serve~~ **Done: 2 Sep 2026** | It was never cosmetic. `www.karobakbak.com` is a **different origin**, so serving both splits the block-token cookie — somebody arriving on the other hostname silently loses every block they have made. Now a proxied `www` record pointing at RFC 5737 `192.0.2.1`, a 301 Single Redirect to the apex preserving path and query, and `Always Use HTTPS` so a plain HTTP request is upgraded into the rule rather than 522-ing. Verified on both hops. The dummy address is deliberate: a `CNAME` to the apex would fail dangerously, quietly serving the app on `www` again if the rule were ever removed. Runbook in `operations/OPERATIONS.md` §7d, including the trap — a 403 naming `www` means fixing the redirect, never widening `ALLOWED_ORIGINS` |
| **`{{PUBLICATION_DATE}}`** | The last variable in the published documents, and the only one that should be filled on the day rather than before it |
| **`{{MODEL_PROVIDER}}`** | Needed only if AI personas ship with a model behind them; on the scripted voice they spend nothing and reach no vendor. A second vendor is a policy change before it is a config change — the Privacy Policy names one processor |
| **Monitoring the two boxes that carry clocks** | Not drafting, operations. `abuse@` receives IT Act / IT Rules takedown orders, which arrive with short statutory windows, and acting inside them is part of the s.79 safe-harbour diligence. `contact@` carries the Terms' 24-hour acknowledgement. Neither box going unread fails loudly, which is the whole difficulty |
| **Production build variables** | The production compose refuses to build without `VITE_TERMS_URL` and `VITE_PRIVACY_URL`, so a gate citing documents nobody can open cannot ship. `VITE_CONTACT_EMAIL` and `VITE_SUPPORT_URL` are set; an empty `VITE_SUPPORT_URL` hides the coffee link rather than pointing it nowhere |
| **Deploy-time settings** | `BACKUP_REMOTE` (a Cloudflare R2 bucket — free at this volume, no egress charge, and a disclosed cross-border transfer), and `TRUST_PROXY_HOPS` **re-measured against the running stack** once Cloudflare is in front. `nginx.conf` blocks on `CF-IPCountry`, so the CDN is required rather than optional — and it is another `X-Forwarded-For` hop |

Child safety today relies on the age gate plus reporting and moderation.
Stronger measures (age assurance, grooming detection) are on the roadmap in the
deferred table below.

## After phase 12 — the swarm

Not a phase: ongoing work with its own document. `load-test/swarm/` is a
population load test — thousands of scripted strangers, personas with state that
survives across matches, and oracles that give a run a verdict rather than a
graph. State, backlog and hard-won gotchas live in `docs/testing/SWARM-HANDOFF.md`; the
scenario catalogue it is working towards is `docs/testing/LOADTEST-SCENARIOS.md`.

Current: 54 of 144 scenarios, 9 of 9 oracles, **re-verified at 5,000 bots with
resumption in the population**, and the first two chaos conditions done
(2026-08-25).

**C1 — PostgreSQL paused mid-run.** D16 is no longer a claim the code argues
for: delivery held at 82.9 msg/s with the database frozen against 80.5 after it
resumed, and client lag p99 did not move off 23ms across the pause or the
recovery. It found two product bugs, and the second was only reachable because
of the first — F-031 meant the circuit breaker could not open inside a realistic
outage, so the outage spool had never actually engaged under load; fixing it
exposed F-032, where one message whose conversation row had not landed yet
destroyed every record sharing its batch. That cost 1,350 P0 records in one
ninety-second run.

**C2 — one of two backends killed outright.** The survivor absorbed the whole
population with no step in client lag, and 591 of 591 connections came back. All
three bugs this one found were in the *measurement* rather than the product,
which is the more useful lesson: a dead instance stops reporting rather than
reporting zero, a bot whose socket died unasked used to be finished for good,
and a SIGKILLed process makes conservation unprovable because its counters and
its unflushed queue die together. Traps 33–35.

C4 and the other twelve C rows are untouched. The P group — 28 rows, one frame
and one expected error code each — remains the cheapest thing on the backlog.

That run's headline result: under a write path that could not keep up, 2,657
records were shed and **every one was P3 — ordinary chat**. No P0, P1 or P2 was
lost. Priority shedding does what D26 and D27 claim, demonstrated at size for
the first time.

The database-agreement oracle — skipped out of every documented run until
2026-09-04, because `--postgres` was in no command anybody copied — found a
product bug on its
first real run, now fixed: **matches reaped by the janitor recorded no ending**,
so under §28 the ordinary "their connection died" path left
`conversations.ended_at` and `end_reason` null for ever. Both janitor scripts
now return the ids they ended, and the janitor writes `end_reason: reap`.

Phases 13–15 added paths the swarm did not exercise. The sharpest of them —
**no scenario reconnects a banned identity** — is now A14, with its own oracle.
It bans an identity before the run and asserts both directions: that the
refusal happened, and that it caught nobody else. The second half is the one
that mattered, because a ban keyed on the wrong hop refuses the whole
population, and a run that quietly shrinks passes every other oracle.

Building it found the reason the worry was well-founded: `'banned'` was written
by the upgrade path and **missing from `REJECT_REASONS`**, so it was never
zero-initialised and `chat_connections_rejected_total{reason="banned"}` did not
exist until the first ban fired. Every capacity-related reason was visible at
zero and the safety one was not — which is precisely how a misfiring ban would
have read as capacity pressure.

The other two gaps this paragraph used to name are closed: every bot now
declares a profile on `join_queue`, so §26 is exercised by the whole population
rather than one group, and M10 blocks a partner who has already left — the case
phase 15 fixed.

## Deferred, with the trigger that pulls it in

| Item | Trigger |
|---|---|
| External/AI content classifier | local rules provably insufficient AND abuse volume justifies spend (cost §20) |
| Grooming detection, age assurance | Planned. Today child safety relies on the age gate plus reporting and moderation; building stronger controls is the next step for this area |
| **Premium matchmaking filters** (gender, age) | a decision recorded against `DESIGN.md` D37. Profiles are declared but deliberately not filterable: filtering creates the incentive to misdeclare and turns a paid control into a targeting tool. Belongs behind the queue-segment seam (D23), and the safer shapes — language, interests, country, mutual opt-in — should be costed first |
| Role scopes beyond `moderator` (senior review, security investigation) | a second person moderates, or an investigation needs a scope the moderator role should not have (`DESIGN.md` R17) |
| A **proactive** review queue fed by the spam detector | a decision on widening I11 purpose scope from "people somebody reported" to "people a heuristic suspects", with its own false-positive budget (`DESIGN.md` §25.7) |
| Enforcement actions beyond `ban` — warn, ratelimit, quarantine | the upgrade path reads them; today shipping one would be a button that reports success and changes nothing |
| Filters beyond the `default` segment | enough concurrent users that segmentation still matches quickly |
| **Recent history and friend requests** — the remaining half of `docs/product/karobakbak-anonymous-accounts-recent-chats-friend-requests.md`. Accounts, sign-in and mutual connections are **built and merged** (D47, D48, §31, §32); this is what still is not | Two things. A **Cognito user pool**, which is six environment variables and nothing in code — startup names the missing one. And a review of the child-safety position, which history triggers rather than connections do |
| **Payments (Razorpay)** — built, merged and switched off in both halves | The retention period and the seller of record are decided (`docs/LAUNCH-CHECKLIST.md` §A); a published refund policy is still open, and none of it is code. Turning it on is a four-part commit — `features.ts`, three env vars, the two migrations in `migrations-pending/`, and applying `docs/policies/PENDING-PAYMENTS.md` — and it also restores Premium, `/support` and, with `FILTERS_ENABLED`, the filter control |
| Premium entitlements, mini-games | product retention validated (UI §39) |
| Image sharing (object storage, moderation, abuse quotas) | `DESIGN.md` §23.8 image trigger |
| Voice (WebRTC signalling, TURN) | `DESIGN.md` §23.8 voice trigger |
| Video (TURN at scale, possibly SFU) | `DESIGN.md` §23.8 video trigger — gated behind stable voice |
| Managed Redis / Postgres, load balancer, multi-region | measured resource pressure, not user count (cost §27–31) |
| Real ad provider | retention validated, house/no-op provider proven (ads §21) |

## Rules per phase

* No placeholders, no TODOs, no `...`. A phase ships complete files or does not
  create them yet.
* Run the gate before committing; a red gate is fixed in the same phase.
* `DESIGN.md` is the contract. If implementation forces a design change, update
  `DESIGN.md` in the same commit and say why.
* Retention, moderation and safety code is held to the invariants in
  `DESIGN.md` §4 — particularly I8 (bounded resting place for text), I11
  (audited access) and I14 (replay rejected).
