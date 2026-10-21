# Observability and testing at scale — the design

What this system can be *watched* doing, and what it is *proven* to survive.
Read `CLAUDE.md` first, then `docs/testing/SWARM-HANDOFF.md` (the load harness, and the
traps it has already paid for), then this.

This document is the contract for phases 25–34. `PHASES.md` tracks what is
done; `docs/PROGRESS.md` records why each phase went the way it did.

---

## 0. The question this answers

Three different people ask three different questions of the same running system
and today only one of them gets an answer.

| Who | Asks | Answered today |
|---|---|---|
| The operator | Is it up, is it fast, is it losing data | **Yes** — 20-panel dashboard, 8 alert rules |
| The founder | Is anybody using it, what does it cost me, is the product working | **No** |
| The reviewer | Does it survive load, failure and attack | **Partly** — 52/144 load scenarios, 0 security scenarios |

The engineering behind the first column is genuinely good and is not the
subject of this document. The other two columns are.

---

## 1. What exists, so nothing gets rebuilt

**The load harness.** `load-test/swarm/` is mature: seeded RNG, forked workers,
per-worker NDJSON ledger, eight oracles that judge a run rather than assert it
did not crash. 52 of 144 catalogued scenarios. A 5,000-bot run is verified green
and produced the load-shedding evidence for D26/D27 (2,657 records dropped under
overload, **every one of them P3**). Chaos C1 (pause PostgreSQL) and C2 (SIGKILL
one of two backends) are done and each found real product bugs — F-031 and F-032
came out of C1, and neither had a test that could have found them.

**The metrics stack.** Prometheus v3.1, Grafana 11.4, Alertmanager, one
provisioned dashboard, `monitoring/prometheus/alerts.yml`.

**A separate load stack.** Docker project `karobakbak-loadtest` with its own
Redis, PostgreSQL, Prometheus (9092) and Grafana (3002), driven by
`.env.loadtest`. It never touches the development database. Every scenario in
this document runs there.

**A guard that makes new metrics safe to add.** `metrics-wiring.test.ts` fails
any metric declared and never written. It caught all sixteen persona series the
moment they were declared. A declared-and-dead metric is worse than an absent
one: it is charted, it reads zero, and it is believed.

---

## 2. What is missing

### 2.1 Two of the three pillars

No log aggregation. There is no Loki, no promtail, no shipper of any kind; logs
live in `docker logs` and are lost when a container is replaced. During a
5,000-bot run across two replicas, "what did the server say when that happened"
is not a question anybody can currently answer.

No tracing at all. Zero `@opentelemetry` in the dependency tree, no `traceparent`
propagation, no span anywhere. This is the pillar this architecture needs most,
because its characteristic bug is *cross-instance*: a session on instance A,
matched by a Lua script in Redis, notified over Pub/Sub, delivered by instance B,
persisted through a write-behind queue that batches across conversations. A
latency spike in that chain currently has to be reasoned about from counters.

### 2.2 The product is dark

`backend/src/accounts/` writes **no metrics**. `backend/src/payments/` writes
**no metrics**. That is phases 20–24 — sign-in, connections, one-sided
nicknames, blocked-people lists, presence, avatars, reconnect, premium
entitlement — with no observable surface whatsoever. The features shipped;
whether anybody uses them is unknowable from the running system.

Beyond that, the metrics that *do* exist are health metrics wearing product
clothes. `chat_matches_created_total` says matching works. It does not say
whether the conversations were any good, and the difference between those two
statements is the entire product.

Missing outright, with nothing to derive them from:

* messages per conversation (only *duration* is measured)
* time to first message, and the bounce — a match skipped before either side spoke
* why conversations end, as a distribution
* searches abandoned before a match
* the sign-in funnel, and where it drops
* connection requests, and what share are accepted
* how many people are online and reachable
* what intents and profiles people actually declare
* whether the premium preference ever applies to a search

### 2.3 Cost is one line item out of nine

`docs/product/karobakbak-cost-calculation-and-feature-rollout-plan.md` §4 breaks the
bill into nine categories — compute, Redis, database, object storage, bandwidth,
moderation, observability, security, domain. Exactly one of them is
instrumented: persona LLM spend, and that one is instrumented well
(`chat_persona_cost_micro_cents_total`, per-kind token counts, budget remaining,
provider latency).

The other eight are a spreadsheet, and a spreadsheet drifts from the running
system silently. Nothing measures container CPU, database size, Redis memory,
or a byte of egress — and egress on a WebSocket chat product is a real bill
line that scales with exactly the number everyone is trying to grow.

### 2.4 Security testing does not exist

The P group ("protocol abuse", 0 of 28) is the closest thing in the catalogue,
and it is input *validation*, not security. Nothing tests, at any level:

* **`TRUST_PROXY_HOPS` against the running stack.** This is the highest-value
  target in the system. `clientAddress()` counts N entries from the right of
  `X-Forwarded-For`; a value below the real chain reads an entry the *client*
  wrote, handing every visitor a free choice of rate-limit bucket and a way to
  shed their blocks with a header. CLAUDE.md names it. Nothing measures it.
* The console authorisation matrix over HTTP — every route against no session,
  an expired session, a wrong-role session, and a forged one.
* Rate-limit bypass by reconnection or cookie churn. Every limiter except the
  preference pair keys on session id, which is one connection and free to
  replace.
* Resume-token replay and the concurrent-attachment case (L15 tests rotation,
  not concurrency — the handoff says so explicitly).
* Presence-token forgery across viewers.
* The two database role grants, over the wire rather than in an integration test.
* Response headers and cookie flags on the *served artifact* — CSP, `__Host-`
  prefix, `SameSite=Lax`, HSTS.
* Dependency vulnerabilities and committed secrets, on every push.

### 2.5 Scale evidence is anecdote, not regression

`load-test/swarm/runs/` holds 130-odd run directories with no baseline file, no
run-to-run comparison and no trend. The 5,000-bot numbers are in a markdown
document written by a person. Nothing in the repository would notice a p99
doubling.

---

## 3. The constraint that governs all of it

**Rule 1 (I8) applies to every pillar added here, and the two new ones are the
most dangerous things in this plan.**

Message content is plaintext inside the trusted boundary and must never leave
it — not a log line, not a Prometheus label *or value*, not a tracing span.
`src/logger.ts` enforces this today with a recursive field denylist that throws
outside production, and it is the primary control now that nothing is encrypted.

Adding traces and log shipping adds two paths out of the boundary that the
existing control does not cover:

1. **A span attribute has no denylist.** OpenTelemetry's auto-instrumentation
   for `pg` captures `db.statement` by default. On this system that statement is
   `insert into messages (conversation_id, body, ...)`. Enabling stock
   auto-instrumentation would ship every retained message body to a tracing
   backend, which is an I8 violation with a dashboard on it.
2. **A log shipper ships whatever is on stdout**, including anything a
   dependency printed that never went through `logger.ts`.

So the design rules for this work, non-negotiable:

* **`FORBIDDEN_FIELDS` becomes shared, and the span exporter uses it.** A
  `SpanProcessor` runs the same recursive scan over every attribute before
  export, throws outside production exactly as the logger does, and redacts in
  production for the same reason. `db.statement` is disabled at the
  instrumentation config as well — two independent controls, because the first
  one is a denylist and denylists are wrong eventually.
* **A test proves the control runs.** `tracing.test.ts` asserts that a span
  carrying `body`, `text` or `note` is refused, in the same shape as
  `logger.test.ts`. A validator nobody has watched reject a bad value is a
  validator nobody knows is running.
* **Loki ingests the structured JSON stream and labels it, never free text.**
  Log lines are already one JSON object per line and already denylist-scanned
  at the point of writing. The shipper adds no fields of its own beyond
  service, instance and level.
* **No new metric label carries content or unbounded cardinality.**
  `conversation_id` is never a label — it is unbounded and half a content leak.
  Every label added below is drawn from a closed list declared in
  `registry.ts`, which is the pattern already in use.
* **Nothing about the age gate reaches the server**, including as a metric.
  A durable per-user record of acceptance is the cross-chat correlator §24.3
  and D34 forbid. The product funnel therefore starts at the socket, not at
  the page load, and that gap is deliberate and permanent.

---

## 4. The four decks

Grafana gets four dashboards, because four different questions want four
different default time ranges and four different audiences. One dashboard that
serves all of them serves none.

### 4.1 Health — exists, needs completing

The current `karobakbak.json`, plus the series that are declared, written, and
charted nowhere: all sixteen `chat_persona_*`, `chat_preference_limited_total`,
`chat_queue_composition`, `chat_report_queue_oldest_seconds`, the spool detail,
and backup freshness. Default range: 1 hour.

### 4.2 Product — new, and mostly new metrics

Default range: 7 days. The funnel is the spine of it.

**The funnel**, one counter with a closed-list label rather than six counters,
so a rate over the label renders as a funnel without six queries:

```
chat_funnel_total{step="connected"|"searched"|"matched"|"spoke"|"conversed"|"ended"}
```

`spoke` is the first message in either direction. `conversed` is the fifth,
which is the point at which a conversation stops being a skip and starts being
a use of the product. The threshold is a constant in `registry.ts` and is a
decision, not a tuning knob.

**Conversation quality:**

```
chat_conversation_messages           histogram   messages per conversation
chat_conversation_first_message_seconds  histogram  match -> first message
chat_conversation_end_reason_total{reason}  skip|leave|block|reap|shutdown|partner_gone
chat_search_abandoned_total          searches that left the queue without a match
```

The bounce — matched, then skipped before either side spoke — falls out of
`end_reason="skip"` crossed against `chat_conversation_messages` bucket zero,
and gets its own panel because it is the single most useful product number here.

**Accounts, which emitted nothing before phase 26.** What shipped differs from
this draft in one important way — see the note below it:

```
chat_auth_starts_total
chat_auth_callbacks_total{outcome}       ok|state_mismatch|nonce_replay|expired|bad_token|provider_error
chat_accounts_created_total
chat_accounts_online                     gauge, from chat:online:{account}
chat_connection_requests_total{outcome}  sent|accepted|ignored|refused_silently
chat_connections_active                  gauge, rows in connections
chat_connections_removed_total
chat_reconnect_attempts_total{outcome}   paired|no_answer|declined
chat_avatar_relay_total{outcome}
```

**`chat_connection_requests_total` was not built, and the draft above was
wrong to propose it.** The `connectionsMade` comment in `metrics/registry.ts`
had already recorded the decision, before this document existed: a count of
one-sided saves measures how often somebody was *not* saved back, and
publishing it turns a private refusal into an operational statistic. The accept
rate is exactly the number that cannot be had, and that is the feature rather
than a gap. The same reasoning removed `declined` and `ignored` from the
reconnect labels, and then `blocked` as well. What ships counts successes
(`chat_connections_made_total`, `chat_reconnect_paired_total`) and technical
faults (`chat_reconnect_failures_total`), never the space between them.

`chat_accounts_online` was dropped too, for a duller reason: it needs a `SCAN`
of the keyspace every janitor tick, and `chat_connections_active` answers the
neighbouring question.

**Declarations and preferences:**

```
chat_intents_declared_total{intent}          closed list, INTENTS
chat_profiles_declared_total{field}           already exists — verify labels
chat_preference_applied_total{dimension}      gender|country|vibe, when a score > 0 won
chat_preference_wide_sample_total             the escalation, which is the cost
chat_premium_sessions_total                   sessions that bound a premium entitlement
```

`chat_preference_applied_total` is the honest answer to "does premium do
anything". A preference that never wins a score is a paid control that silently
does not apply — the failure mode §29 warns about, invisible because the
fallback still works.

### 4.3 Cost — new, and the most valuable of the four

Default range: 30 days. Two halves.

**Measured spend.** Persona LLM cost already exists. The rest needs exporters,
which are infrastructure rather than application code and therefore cheap:

| Source | Gives | Bill line |
|---|---|---|
| cAdvisor | per-container CPU seconds, memory, network bytes | §4.1 compute |
| `redis_exporter` | memory used, evictions, ops/sec, keyspace | §4.2 Redis |
| `postgres_exporter` | database size, table sizes, connections, tx rate | §4.3 database |
| app counter | `chat_ws_bytes_total{direction}` at the socket | §4.5 bandwidth |
| existing | `chat_retention_deleted_total`, `chat_persona_cost_*` | §4.6 moderation |

`chat_ws_bytes_total` is measured in the application rather than at nginx on
purpose: it is the number that scales with users, it is free to count where the
frames already are, and it does not depend on a log format.

**The price model, exported as gauges.** This is the part that keeps the
dashboard honest. The cost plan's unit prices — per vCPU-hour, per GB-month of
managed Redis, per GB of egress, per million model tokens — become
`chat_cost_unit_price{resource}` gauges read from configuration, in exactly the
pattern `chat_report_response_target_seconds` already uses ("exported so an
alert compares against it"). Then Prometheus *recording rules* multiply measured
resource by exported price and the dashboard shows a currency figure that cannot
drift from either the running system or the pricing decision, because both are
inputs to the same expression.

Recording rules, evaluated once and charted many times:

```
kbb:cost_per_hour:total          sum over resources of usage * unit price
kbb:cost_per_conversation        cost per hour / conversations per hour
kbb:cost_per_1k_messages
kbb:persona_cost_per_reply
kbb:projected_monthly_cost       cost per hour * 730
kbb:storage_growth_bytes_per_day database size derivative, against retention rate
```

`kbb:cost_per_conversation` is the number the founder wants and nothing today
can produce. `kbb:storage_growth_bytes_per_day` compared against the retention
deletion rate answers whether stored data reaches a steady state or grows for
ever, which is a design claim (D17) that has never been watched.

Alerts on this deck fire on *rate of change*, not absolute value: a laptop and a
production host have different absolute costs and the same wrong-direction
signal.

### 4.3b Deferred — the price model assumes hourly cloud billing, and a VPS is not that

Recorded during phase 28 and not yet acted on.

`COST_PER_VCPU_HOUR_USD` and `COST_PER_GB_MEMORY_HOUR_USD` are an AWS/GCP-shaped
model: pay per resource, per hour. **A Vultr or DigitalOcean droplet is billed as
one flat monthly price** for a fixed box, and that is the deployment the cost
plan's Scenario A actually describes. Under the current model an operator has to
back out a synthetic per-vCPU-hour rate from a flat invoice, which is arithmetic
nobody should have to do and which will be wrong the moment the box is resized.

What it should take instead is `COST_VPS_MONTH_USD` — one number, straight off
the invoice — with the per-resource rates kept for the case where this ever runs
somewhere that genuinely bills that way. Both feed the same
`kbb:cost_micro_cents_per_hour:compute`, so nothing downstream changes.

Until then, the figures on the cost deck are only as meaningful as the rates fed
in, and the load stack's rates are deliberately fictional — they exist so the
arithmetic could be verified end to end, not to describe anybody's bill. The
development stack is unpriced and reports `UNPRICED` rather than a number.

### 4.4 Safety — exists, needs a time axis

Default range: 24 hours. Reports, blocks, moderation flags by rule,
enforcement actions and the report queue's oldest item all exist. What is
missing is the response-time distribution — `chat_report_response_target_seconds`
is exported but nothing measures the achieved time against it, so the target is
declared and unmeasured. Add `chat_report_response_seconds` as a histogram
written when a report is actioned, and the deck answers the compliance question
directly.

---

## 5. Test surfaces

### 5.1 Load — finish the catalogue

92 of 144 scenarios remain. In value order, which is not catalogue order:

* **R group (0/15), races.** Needs a coordinating cohort: two bots pinned to one
  worker firing on a shared trigger. The sharding already keeps adjacent roster
  indices in one process; nothing drives them yet. R13 — two instances running
  `tryMatch` over the same candidates — is the strongest argument for the whole
  Lua-script design and should run continuously rather than as a scenario.
* **P group (0/28), protocol.** One frame and one expected error code each,
  plus a structure-aware fuzzer over `parseClientFrame`. Cheap, and it catches
  `validate.ts` regressions. P24 is deliberately not expressible and P26 expects
  acceptance; the catalogue explains both.
* **D group (0/10), data integrity.** The database-agreement oracle exists and
  runs; the D scenarios that would stress it do not. D17 in particular —
  change `MESSAGE_RETENTION_DAYS` mid-run and prove rows written before the
  change kept their original deadline — is the check that stops a config edit
  retroactively extending the life of stored user data, and it has never run.
* **E group, load shapes.** E6 (80% idle / 20% active) and E10 (endurance) are
  where capacity numbers should come from, rather than from a flat ramp.
* **L5 and L7.** Slow consumer / backpressure kill, and the thundering herd.
  `sharedAddress()` exists in `identity.ts` and is unused; L7 is what it is for.

### 5.2 Chaos — 14 of 16 remain

C1 and C2 are done and both found product bugs. The rest, in value order:

* **C-Redis: Sentinel failover under load.** `docker-compose.sentinel.yml`
  exists for the drill in `operations/OPERATIONS.md` §17 but has never run with traffic on
  it. All matchmaking state is in Redis; a failover with 2,000 bots mid-match is
  the single most informative thing left to try. Note the trap already paid for:
  never give Sentinel a name that disappears with the thing it names, or it
  enters TILT and votes for nothing, silently.
* **C3: graceful shutdown.** The `draining` path, `holdSeat: !draining`, the
  `server_shutdown` frame. C2 proved the ugly case; this proves the deploy case,
  which happens far more often.
* **C4: network partition** between the two backends while Redis stays up.
* **Clock skew** on one instance, against TTL-based recovery.
* **Redis memory pressure** to eviction, which is the failure mode with the
  worst blast radius given persistence is off (D12).

### 5.3 Security — new, four axes, all four building

**(a) In-repo abuse suite.** `security-test/`, reusing the swarm's protocol
client so it inherits identity handling, cookies and the ack correlation rather
than reimplementing them. Deterministic, seeded, CI-runnable, asserting a
specific refusal for each probe:

* XFF spoofing against every `TRUST_PROXY_HOPS` value from 0 to 4, asserting
  which bucket the request lands in. This is the one that has a real chance of
  finding something.
* Rate-limit bypass: reconnect churn, cookie rotation, session replacement
  against every limiter — and specifically confirming the preference limiters
  key on the IP hash while the others key on session, because that difference is
  deliberate and the tests should encode it.
* Console authorisation matrix: every route × {no session, expired session,
  wrong role, forged cookie, valid session wrong TOTP}.
* No console route accepts an identity hash (§25.3) — probe every body shape
  that could name its own subject.
* Ban/block namespace separation (D29) probed over the wire, not in a unit test.
* Resume-token replay, rotation, and the concurrent-attachment case L15 does
  not cover.
* Presence-token forgery: two viewers who met the same person, confirming their
  tokens differ and neither resolves the other's.
* Origin allowlist: scheme, host and port exactness.
* Binary frames, oversized frames, and the strike accounting that disconnects
  at ten.

**(b) Protocol fuzzing.** Structure-aware, seeded, over `parseClientFrame` —
type confusion, deep nesting, prototype pollution shapes, unicode
normalisation, control characters, near-miss discriminators. Any crash or any
acceptance of a malformed frame is a failure; a clean rejection is a pass.
Corpus minimised and committed, so a crash reproduces.

**(c) Active scanning against the load stack.** OWASP ZAP baseline plus nuclei
against the frontend origin and the console origin in `karobakbak-loadtest`,
localhost only. What it is actually for is headers and stock misconfiguration —
CSP, `__Host-` prefix, `SameSite`, HSTS, directory listing, verbose errors —
which are exactly the things that are correct in the config file and wrong in
the served artifact. **Verify the served artifact, not the source** is already a
rule in `CLAUDE.md` and this is the automated form of it.

**(d) Supply chain, on every push.** `npm audit` with a severity gate,
`gitleaks` over history, and a lockfile-diff check on the verify workflow. The
cheapest of the four and the only one that runs unprompted.

### 5.4 Scale — both tracks

**Track 1, deepen at 5,000 on one host.** Everything in 5.1–5.3 runs here. This
is where the scenario coverage comes from and where the regression baseline
lives.

**Track 2, distribute past 20,000.** The orchestrator already forks workers and
shards the roster; distributing means replacing the fork with a remote worker
and a coordinator. Two things must be re-derived, not assumed: `TRUST_PROXY_HOPS`
against the new chain — anything added in front of nginx is another hop — and
the synthetic address allocation, which currently derives from bot index and
would collide across hosts.

### 5.5 Payments and premium — the untested half of the product

`PAYMENTS_ENABLED` and `FILTERS_ENABLED` are both false, each for its own
reason, and between them they hide the entire paid tier: the checkout, the
webhook, the entitlement grant, `premium_until`, the session-hash `premiumUntil`
that matchmaking actually reads (D51), and the filter surface in the chat
header. Every one of those has unit and integration coverage and **none of it
has ever run end to end in a browser against a live stack.**

**Enable both in the load stack, not in development and not in production.**
`.env.loadtest` gets `PAYMENTS_ENABLED=true` and `FILTERS_ENABLED=true`;
`frontend/src/features.ts` gets its two constants flipped on a branch. The load
stack publishes no policy documents to be made untrue, has its own database, and
is the environment already used for everything else here.

What that requires, all of which is already present or free:

* `RETENTION_ENABLED` — `assertCoherent` refuses payments without it, because
  the routes need the database.
* `PREFERENCE_LIMITS_ENFORCED` — already true; `FILTERS_ENABLED` without it is
  refused at startup by name.
* The `razorpay` package — already in `backend/package.json`, lazily required.
* Razorpay **test-mode** keys (`rzp_test_`) for order creation. `assertCoherent`
  refuses a test key under `NODE_ENV=production`, which is the guard working.
* Nothing for the inbound half: `fake-webhook.sh` already builds a valid
  `payment.captured` body and HMAC from `RAZORPAY_WEBHOOK_SECRET`, so webhook
  verification, idempotency and the entitlement grant are testable with no
  vendor at all.

The scenarios, which are the point:

* **The whole purchase path in a browser**: signed in, checkout opens, order
  created, webhook captured, `premium_until` set, and the filter control
  appears — watched, not asserted.
* **The entitlement seam.** An entitlement bought mid-session applies on the
  **next connection, not the next search** (D51). Prove it: buy while a
  conversation is live, confirm the preference does not apply, confirm
  `reauthenticate` re-opens the socket and it then does. This is the first thing
  to check when a purchase "does not work", and it has never been demonstrated.
* **The gate fails closed.** A database that cannot answer means not premium.
  Combine with chaos C1 — pause PostgreSQL and confirm a premium user loses a
  preference and nothing else.
* **Webhook abuse**, in the security suite: bad signature, replayed event,
  reordered events, an event naming another account's order, an amount that
  disagrees with the order. A payment webhook is an unauthenticated endpoint
  that grants entitlements, which makes it the highest-value target in the
  system after `TRUST_PROXY_HOPS`.
* **The preference actually applying under load.** With filters on, a premium
  cohort in the swarm declaring preferences, and `chat_preference_applied_total`
  from §4.2 charting whether a paid control ever wins a score. §29 warns that a
  preference matching nobody is invisible because the fallback still works —
  this is the run that makes it visible.

### 5.6 The regression baseline

A run writes `report.json` today. Add `load-test/swarm/baselines/<profile>.json`
holding the accepted percentiles, and a `--compare` flag that fails a run whose
p99 regressed beyond a stated tolerance. Without it, 130 run directories are
130 anecdotes.

---

## 6. Watching a run happen

The point of all of this is to sit in front of Grafana while 5,000 bots run and
see the system move. Three things make that work and none of them exist yet:

1. **Run annotations.** The swarm posts a Grafana annotation at run start, at
   ramp completion, at every chaos injection and at drain. Then a spike on any
   panel is attributable to an event rather than to a guess. The chaos module
   already knows every phase boundary — `src/chaos.ts` scrapes counters at each
   one — so this is a POST beside an existing hook.
2. **A run dashboard** with the time range bound to the run, showing the four
   decks' key rows on one screen: throughput, latency percentiles, queue depth,
   drops by priority class, breaker state, spool records, cost per hour.
3. **The report links to it.** `report.txt` ends with a Grafana URL carrying the
   run's exact `from`/`to` and the run id as a variable. A verdict you can click
   into is worth several a person has to reconstruct.

---

## 7. Documentation, evidence and the launch gate

A run that nobody wrote down did not happen. Today the load work's results live
in `docs/testing/SWARM-HANDOFF.md` — a good document, but one written by a person after
the fact, which means it records what somebody remembered to record. This
section makes the record a byproduct of running rather than an act of will.

`docs/testing/` holds four things, and each has a different job.

### 7.1 `docs/testing/REGISTER.md` — the agenda

One row per scenario across every surface: the 144 catalogued load rows, the
chaos rows, every security probe, and the payment scenarios. Columns: id, what
it *proves* (not what it does), which design decision or invariant it defends,
status, last run, verdict. It opens with the counts, so the shape of the
remaining work is visible in one screen.

A register in this form keeps the remaining work visible in one screen.

### 7.2 `docs/testing/RESULTS.md` — what actually happened

Chronological and append-only. One entry per significant run: date, commit sha,
profile, population, duration, the configuration that differed from default,
the headline numbers, the verdict, and — the part that matters — **what it
found**. A run that found nothing gets one line. A run that found F-031 gets the
paragraph that explains why nothing had found it before.

The numbers come from `report.json`, not from a person retyping them.

### 7.3 `docs/testing/evidence/<run-id>/` — the artifacts

`report.json`, `report.txt`, the resolved configuration, and the Grafana
permalink carrying the run's exact time range. Ledgers stay where they are
(`load-test/swarm/runs/`) and are gitignored; they are large, and they are
reproducible from the seed, which is the whole reason the harness is seeded.

A verdict a reviewer can click into is worth several they have to reconstruct.

### 7.4 `docs/testing/FINDINGS.md` — the action plan

The repository already numbers its findings — F-031, F-032 — and that
convention becomes the register. One row per finding: id, where it came from,
severity, what breaks, whether it is a product bug or a harness bug, status,
and the decision if it was accepted rather than fixed.

**Accepted findings are the valuable half.** "Blocking does not bound a
spammer" and "a block racing a teardown is silently lost" are already in the
handoff as open product questions, and they are exactly the sort of thing that
gets rediscovered by a reviewer six months later unless there is a record
saying it was seen, considered and accepted.

### 7.5 `docs/testing/LAUNCH-GATE.md` — claims against evidence

This is the document the launch decision is actually made from, and it is not a
checklist of tasks. It is a two-column mapping: **every factual claim the
product makes in public, against the test that demonstrates it.**

The reason is specific to this repository. `CLAUDE.md` records that a review of
the policy documents found **seven places where they described a system that was
not the one built** — including "our moderation team" four times when there is
one person. A false statement in a published policy is worse than a weak legal
position, because it is not arguable. The defence against that recurring is a
document where each claim names its evidence, so a claim with no evidence is
visible rather than assumed.

Claims that need a row, drawn from the policies, the Terms, `DESIGN.md` and the
marketing surface:

| Claim | Evidence that would demonstrate it |
|---|---|
| Conversations are deleted after the retention window | D-group scenario against the deletion worker, counting rows |
| A config change cannot retroactively extend stored data's life | D17 scenario: change `MESSAGE_RETENTION_DAYS` mid-run |
| Message content never leaves the trusted boundary | log-leak oracle, plus the span-attribute guard from phase 29 |
| A database outage is not a chat outage | C1, done — 43.5 msg/s while PostgreSQL was paused |
| Safety evidence survives overload | the 5,000-bot run, done — 2,657 drops, every one P3 |
| Blocks persist and are honoured | spam oracle's block-durability check, done |
| A ban is not a block and revoking one cannot delete the other | D29 probe over the wire, security suite |
| The pages make no third-party requests | header/asset scan of the served artifact — **changes when payments land** |
| Presence is approximate and never fabricated | `showPresence()` unit test plus a live check above and below 100 |
| A preference never makes anybody wait | preference scenario measuring time-to-match with and without |
| Premium is enforced and cannot be self-granted | entitlement scenario plus the webhook abuse probes |
| Rate limits bound abuse | the limiter-bypass probes, security suite |
| A person's IP is never logged raw | log-leak oracle with a deliberately chatty run mode |

Rows whose evidence column is empty are the launch backlog. Rows whose evidence
exists but has never been *run against the current build* are worse, because
they read as green.

### 7.6 Generated, not written

`REGISTER.md` status columns and the `RESULTS.md` entry are emitted by the run
itself — a `--record` flag that appends the entry and copies the evidence. A
document that requires discipline to stay accurate will stop being accurate,
and the failure will be invisible, which is the shape of every trap in
`testing/SWARM-HANDOFF.md`.

---

## 8. Phases

Each phase ships complete files and a commit, per the repository's rules. No
phase creates a metric without a write site, because `metrics-wiring.test.ts`
would fail it.

| # | Phase | Ships | Why here |
|---|---|---|---|
| 25 | Logs in Grafana | Loki + promtail, JSON pipeline, log deck, Grafana datasource | Lowest risk, immediate payoff, and it makes every later phase debuggable |
| 26 | **Done.** Product metrics | funnel, conversation quality, accounts, declarations, preferences — 13 series, all wired, plus the Lua-weight guard | The dark half of the product. Metrics before dashboards |
| 27 | **Done.** Cost metrics | cAdvisor, redis/postgres exporters, `chat_ws_bytes_total`, `chat_cost_unit_price`, recording rules | Depends on 26 for the denominators (cost *per conversation*) |
| 28 | **Done.** The four decks | Health completed, Product, Cost, Safety dashboards + alert rules | Now there is something to chart |
| 29 | **Done.** Traces | OTel SDK, scrubbing span processor, shared `FORBIDDEN_FIELDS`, Tempo, exemplars, `tracing.test.ts` | Highest I8 risk. Goes after the cheap wins, with its own guard test |
| 30 | **Done.** Payments and premium, on | both flags on in `.env.loadtest` and a `features.ts` branch, the purchase path end to end, the entitlement seam, webhook abuse probes | Unblocks the last dark half of the product. Test stack only — the policy patch is a separate, later commit |
| 31 | **Mostly done.** Security suite | `security-test/` (a), fuzzer (b), ZAP/nuclei (c), CI supply chain (d) | Independent of 25–29; can start in parallel. Absorbs the webhook probes from 30 |
| 32 | **P group done.** Load + chaos coverage | R, P, D, E groups; Sentinel failover, C3, C4, clock skew, memory pressure | The long tail, and where the remaining product bugs are |
| 33 | Scale + regression | run annotations, run dashboard, baselines and `--compare`, distributed workers past 20k | Makes every previous phase repeatable rather than a one-off |
| 34 | **Done.** The record | `docs/testing/` — register, results, evidence, findings, launch gate; `--record` | Last, because it is generated from what 25–33 produce |

Phases 25–29 are the observability track and are sequential. Phase 30 is
gated only on the load stack, not on any policy work. Phase 31 is independent
and can start whenever. Phases 32–33 depend on 25–28 being in place, because
their whole value is being able to watch what they do. Phase 34 is written
throughout and committed last.

### What is *not* in these phases, and must not drift into them

Flipping `PAYMENTS_ENABLED` in **production** is a separate commit that carries
the `docs/policies/PENDING-PAYMENTS.md` patch with it, because it makes two
published claims false — the Terms say there is no payment provider and the
Privacy page says the pages make no third-party requests. That patch also does
not answer the question it names: Terms §15 recommended a **merchant of record**
and Razorpay is a bare payment processor, which leaves the operator as seller of
record for cross-border tax, invoicing and refunds. That is a business decision
and it belongs to the operator, not to this plan. Phase 30 proves the code
works; it does not decide whether to sell anything.

---

## 9. Decisions recorded here

**D52 — the span exporter shares the logger's denylist rather than having its
own.** Two denylists drift, and the one that drifts is the one nobody is
looking at. `FORBIDDEN_FIELDS` moves to a shared module that both import; the
logger's behaviour is unchanged and its tests keep passing unchanged, which is
the check that the move was mechanical.

**D53 — `db.statement` is disabled at the instrumentation, in addition to
being denylisted.** A denylist is a list of things somebody thought of. The
statement attribute is known to carry message bodies on this system, so it is
switched off at the source as well. Two controls, because the interesting
failures are the ones where the first control was wrong.

**D54 — the price model is exported as gauges and multiplied by recording
rules, not hard-coded into dashboard queries.** A price in a dashboard query is
a number that is edited in one place and believed in nine. A price as a gauge
is visible, versioned with the configuration, and comparable against measured
usage in the same expression.

**D55 — the product funnel starts at the socket, not at the page.** Nothing
about the age gate reaches the server (§24.3, D34), so the step before
`connected` cannot be measured server-side and will not be inferred. The
resulting blind spot — how many people see the gate and leave — is accepted and
is the cost of the privacy position, not an oversight to be fixed later.

**D56 — cost alerts fire on rate of change, never on an absolute figure.** The
same code runs on a laptop and on a production host with different absolute
costs and identical wrong-direction signals. An absolute threshold would have to
be re-tuned per environment, which means it would be wrong in one of them.

**D57 — payments and filters are enabled in the load stack first, and that is
not a step towards enabling them in production.** The two are different acts.
The load stack publishes no policy documents, holds its own database, and
already runs everything else here, so turning both flags on there costs
nothing and proves the code. Production is a commit carrying document changes
and a business decision about merchant of record. Conflating them is how a
staged policy patch ends up half-applied, which is the exact state
`scripts/verify-pending-policy.mjs` was written to catch.

**D58 — the launch gate is a claims-to-evidence mapping, not a task list.** A
task list records what somebody intended to do. This repository's recorded
failure mode is different: a review found seven places where published policy
described a system that was not the one built. A mapping makes an unsupported
claim visible, because its evidence column is empty. A task list would have
been fully ticked and every one of those seven statements would still have been
false.

**D59 — the record is generated by the run, not written after it.** Every trap
in `testing/SWARM-HANDOFF.md` has the same shape: something stopped happening and
nothing said so. A results document maintained by discipline fails that way on
a long enough timeline. `--record` appends the entry and copies the evidence, so
the register is wrong only when a run did not happen — which is a state worth
seeing.
