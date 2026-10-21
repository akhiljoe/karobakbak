# Results

What actually ran, when, and what it found. Append-only and chronological.

A run that nobody wrote down did not happen. The numbers here come from
`report.json` and from live queries, not from anybody's recollection.

---

## 2026-08-24 — 5,000 bots, `realistic`, 300s with a 90s ramp

The capacity run, and still the only one at this size.

| | |
|---|---|
| Bots connected | 5,000 of 5,000 |
| Conversations | 19,196 |
| Messages sent | 79,983 |
| Message ack | p50 4ms, p95 50ms, p99 61ms |
| Time to match | p50 7ms, p95 36ms, p99 70ms |
| Harness event-loop lag | p99 23.1ms |
| Reconnections keeping their conversation | 40% |

**The headline is the load shedding.** 2,657 records dropped under overload and
**every one of them P3** — ordinary chat. Zero P0, zero P1, zero P2. Safety
evidence, moderated messages and reported-conversation messages all survived a
write path that could not keep up, which is what D26 and D27 claim.

Queue conservation held exactly: 137,882 queued = 135,225 flushed + 2,657
dropped. The breaker never opened; the writer was simply behind.

Two things learnt, both now fixed: the write-behind path sustains roughly 200
records/second here, so a run this size ends with ~27,000 queued and about two
minutes of drain; and message conservation is a *range*, not an equality —
`acked - dropped <= stored <= sent - dropped`.

---

## 2026-08-24 — C1, PostgreSQL paused mid-run

D16 stopped being an untested claim.

| | |
|---|---|
| Delivery while PostgreSQL was paused | **43.5 msg/s** |
| Delivery after it resumed | 43.7 msg/s |
| Breaker | reached OPEN |
| Spooled | 10,904 records, 6,200 drained back while the run was still going |
| Client lag p99 across pause and resume | 22.8–23.0ms, no visible step |

`pause`, not `stop`, and the distinction is the point: a stopped container
refuses instantly, which the driver reports as a fast error; a paused one accepts
connections and never answers, which is the nastier failure and the only one
that tests timeouts.

**Two product bugs, neither reachable any other way.** F-031 (a `ROLLBACK` sent
down an unanswered connection waited out the deadline a second time, doubling
the cost and putting the spool 100 seconds away) and F-032 (one orphan message
destroying the batch it travelled in, which cost 1,350 P0 records).

---

## 2026-08-24 — C2, SIGKILL one of two backends

The likelier event by far: a backend dies on every deploy and every OOM.

The survivor absorbed the whole population with **no step in client lag** —
p99 sat at 22.7–23.0ms across the kill *and* the restart. Cross-instance routing
is Pub/Sub on a per-session channel, so there is no table to go stale.

Two harness bugs came out first and both are traps now: a bot whose socket died
unasked was finished for good, and a killed process takes its counters and its
unflushed queue with it.

---

## 2026-09-02 — phase 25, the log pipeline

**F-036, found before shipping anything into a queryable store.** nginx set no
access log format, so the container used the stock `main`, which writes the
visitor's IP twice and `$request` — the raw request line *including the query
string*. `location /auth/` proxies the OIDC callback, so every completed sign-in
had been writing an authorization code into an access log. Verified against the
running stack, quoted in `docs/testing/BUGS.md`.

Those lines were already on disk: no `logging:` block anywhere in compose, so
the default `json-file` driver with no rotation.

---

## 2026-09-02 — phase 27, the cost deck

Verified against the running load stack with fictional rates, to prove the
arithmetic rather than to describe anybody's bill:

| | |
|---|---|
| Provisioned | 8 vCPU, 31.3 GB |
| Cost per hour | $0.2217 |
| Projected monthly | $161.82 |
| Cost per conversation | $0.0015 |
| WebSocket bytes | 30,271 in / 170,029 out |

**Those rates are invented.** The development stack is unpriced and reports
`UNPRICED` rather than a number. The model also assumes hourly cloud billing and
a VPS is billed flat monthly — recorded as a deferred item in
`docs/testing/OBSERVABILITY-AND-TESTING.md` §4.3b.

**F-037**, found by accident: the swarm had been red for six days on a harness
bug that read as a product regression. The last passing run predates
`c043479` ("country comes from the connection") by two days.

---

## 2026-09-02 — phase 29, tracing

**F-039**: `enhancedDatabaseReporting: false` does not stop
`instrumentation-pg` writing `db.query.text`. Only the exporter-side denylist
caught it, which is the argument for D52 and D53 being two controls.

**F-040**: the scrubber crashed the service it was protecting. `onEnd` runs
inside the instrumented call, so the throw failed the query it was watching, and
the stack went into a restart loop on its first query.

**F-041**: tracing started from `index.ts` instrumented nothing and reported no
error. Tempo received zero traces from a reachable stack.

After the fixes, Grafana queries Tempo and returns `pg.query:BEGIN / INSERT /
COMMIT` from the write-behind path, both backends healthy, the scrubber's single
log line naming `db.query.text` and no value.

---

## 2026-09-02 — phase 30, the entitlement gate under load

`FILTERS_ENABLED` on, payments off, 40 bots:

| | |
|---|---|
| `chat_preference_limited_total{reason="not_premium"}` | **101** |
| `chat_preference_applied_total` (all three dimensions) | **0** |
| `chat_preference_widened_total` | **0** |

The gate that CLAUDE.md says is "provably closed while nothing can be bought",
measured rather than asserted.

`payments-e2e.test.ts`: 11 of 11 against real PostgreSQL.

---

## 2026-09-02 — phase 31, the security probes

Against the load stack: **9 passed, 0 failed, 1 measured, 1 skipped.**

The measurement is IDENT-1, and it is exact:

```
one forged address x60:        40 opened, 20 refused
distinct forged addresses x60: 60 opened,  0 refused
```

40 was precisely that run's `MAX_CONNECTIONS_PER_IP` (the load stack's
configuration at the time). The forged header is trusted in the load stack,
which is correct there — it is how each bot gets an identity — and would be a
serious hole where nothing in front overwrites it. Production was checked
afterwards against its own proxy chain, and compose refuses to start without
`TRUST_PROXY_HOPS` by name. **Consistent.**

The fuzzer: 6 properties over ~13,000 generated frames, seeded.

---

## 2026-09-02 — phase 32b, Redis failover with the application on it

60 bots, 120 seconds, primary stopped at about 50 seconds in. The drill in
`operations/OPERATIONS.md` §17 had only ever drilled Redis alone.

| | |
|---|---|
| Sentinel promoted the replica | yes, master moved to `172.31.240.12` |
| Backend restarts | **0**, both instances |
| Redis unavailable for | **~11.2s** (16:24:14.066 → 16:24:25.280) |
| Conversations | 113, **346 message positions agreed** |
| Reclaimed by resume | 2 |

**Conversations survived a Redis failover** — the claim D13 makes, demonstrated
for the first time. The ~11 seconds is the number to plan around, and during it
`/ready` reports not-ready on *every* instance at once.

---

## 2026-09-02 — E6, the idle-heavy shape, and what a connected user costs

The catalogue says E1, E6 and E10 are the ones to run before believing any
capacity number, because "a capacity figure taken from a shape nobody
experiences is a number about the load generator's preferences". Every capacity
figure this project had came from a population where **everybody was searching**,
which is not what a live service looks like.

`--profile idle` is E6: 80% L6 (connects, never joins the queue) and 20% doing
something. Measured with 1,500 bots, two backend replicas:

| | Idle stack | 1,449 connections | Marginal |
|---|---|---|---|
| Resident memory, both backends | 206.1 MB | 219.3 MB | **13.2 MB** |
| Open file descriptors | — | 1,498 | ~1 per socket |
| CPU, both backends | — | 0.25 cores | — |
| Queue depth | 0 | 1 | — |

**An idle connection costs roughly 9 KB of resident memory and one file
descriptor.** Ten thousand of them is about 93 MB, which is not the constraint —
**the constraint is file descriptors and, before them, nginx's
`worker_connections`, which a proxied WebSocket consumes two of.**

That is a materially different capacity story from the one a search-heavy run
tells, and it is the first time it has been measured.

The shape also confirms what L6 asserts and nothing had checked at scale: 1,449
connected sockets and a queue depth of 1. Idle sockets are counted in presence
and appear in no queue.

---

## 2026-09-02 — Sentinel, the deeper questions

Section 17.4 showed conversations surviving a failover. It did not ask whether
the promotion **lost** anything, and Redis replication is asynchronous with
persistence off (D12) — the replica's memory is the only other copy.

| | |
|---|---|
| Writes acknowledged by the master | 6,934 |
| Present on the promoted replica | **6,934** |
| Acknowledged writes lost | **0** |

Zero **at ~300 writes/sec on a Docker bridge network**, not zero in general. The
replica was 5,866 bytes behind when sampled and still lost nothing, because
`down-after-milliseconds` is 2000 and the primary keeps streaming through it. F-033
requires the replica on a second machine, where the lag is larger.

**Failback exposed a window.** A returning primary advertises `master` for a few
seconds before Sentinel demotes it — measured at under 5s. No split brain
survived, but a client holding a fixed address would have written to a node
about to be discarded by the resync. That is the argument for `REDIS_SENTINELS`
over `REDIS_URL`, as a measurement rather than a principle.

**Repeated failover works.** Four transitions in one session: .11 to .12, .11
back as a replica, .12 to .11, .12 back as a replica. A set that promotes once
and then cannot promote again looks identical to a healthy one until the second
incident.

---

## 2026-09-02 — a rig shaped like the VPS, and the first number about the machine being bought

Every capacity figure in this document was taken on an 8 vCPU / 31 GB
development machine, or derived by arithmetic. Both have now been wrong. The
arithmetic said 512 concurrent conversations where the same nginx slots buy 256
— a proxied WebSocket costs two connections, and a conversation is two people
— and the 5,000-bot run at the top of this file was measured on hardware
nobody intends to pay for.

`docker-compose.vps.yml` constrains the application path to the shape of a
cheap VPS. It is a rig, never a deployment, and holds the same status as
`docker-compose.sentinel.yml`.

**Why `cpuset` and not `cpus`.** A 1 vCPU VPS is not "each service gets a
fraction of a core". It is one core that every process contends for, including
the ones that are not the bottleneck until suddenly they are. `cpus: 0.25` per
service caps each container independently, so four of them can still consume
four cores in the same instant. `cpuset` pins them to the same physical core so
they queue behind one another, which is the property being measured. Verified
rather than assumed: `nproc` reads 1 inside the container, so nginx's
`worker_processes auto` resolves to a single worker and the edge ceiling is
exactly `worker_connections`. Backend runs one replica, because
`docker-compose.prod.yml` runs one.

Measured on 1 vCPU / 2 GB, `realistic`, 60s, seed 101, six harness workers:

| Concurrent | ack p50 | ack p95 | ack p99 | match p99 | messages |
|---:|---:|---:|---:|---:|---:|
| 1,000 | 10ms | 90ms | **150ms** | 428ms | 6,087 |
| 2,000 | 55ms | 314ms | **598ms** | 1,617ms | 12,245 |

**The bottleneck is CPU, and it is established by elimination.** At 2,000
concurrent the four containers demanded a combined **125.6% of one core**, and
only 100% exists. Nothing was OOM-killed, nothing restarted, nginx never
reported exhausting `worker_connections`, and the ephemeral port range was
never approached. The knee sits between 1,000 and 2,000.

**Memory is nowhere near binding, and the edge figure this project had been
carrying was wrong by an order of magnitude.**

| | Idle | At 2,000 users | Per user |
|---|---:|---:|---:|
| nginx | **4.1 MiB** | 57.2 MiB | ~13 KB (two connections) |
| backend | 29.9 MiB | 74.2 MiB | ~22 KB |
| postgres | 45.0 MiB | 48.9 MiB | — |
| redis | 10.9 MiB | 13.5 MiB | ~1.3 KB |
| prometheus | 28.1 MiB | — | — |
| **total** | **118 MiB** | **~222 MiB** | **~36 KB** |

nginx idles at 4.1 MiB, not the 114 MB recorded earlier. At ~36 KB per active
user, ten thousand users is about 360 MB — which fits in the **1 GB** tier.
CPU stops this service long before memory does.

**This supersedes E6's conclusion.** E6 measured an *idle* connection at 9 KB
and concluded "the constraint is file descriptors and, before them, nginx's
`worker_connections`". Both halves of that measurement stand — an idle
connection really is ~9 KB, and an active one is ~22 KB, which is a different
population and not a contradiction. The *conclusion* does not: neither file
descriptors nor `worker_connections` was reached, and the core saturated first.
E6 was run on the development machine, where the core was not the scarce thing.

**What this means for the tiers.** Extrapolating from 1.26 cores at 2,000 — a
floor, since contention worsens rather than scaling linearly — 10,000
concurrent needs roughly 6-8 vCPU, and 50,000 needs 30+. 50,000 also breaks the
edge architecturally rather than financially: there is no `upstream` keepalive
pool, because `proxy_pass` targets a variable so Docker's DNS is re-resolved for
a replaced replica. Every WebSocket therefore opens its own TCP connection to
the single address `backend:8080`, and with three of the four tuple members
fixed, the source-port range caps it at about 64k connections even when widened
to 1024-65535. That is ~32,000 people per edge, and going past it needs a second
backend address or a unix socket.

### Three faults the rig found in itself

These are recorded because each one produced a confident, wrong reading.

**A compose overlay can add a service and cannot remove one.** The first
version of the file carried a comment listing Loki, Tempo, Alloy, Grafana,
cAdvisor and the exporters as "deliberately absent" and started every one of
them. The comment was the whole of the mechanism. They are scaled to zero in
`vps:up` now.

**A pass over an empty run is not a pass.** The first run reported
`VERDICT: PASS` over 500 bots, **zero conversations and zero messages**.
`ALLOWED_ORIGINS` had been copied from the 8090 stack and refused all 500
upgrades with 403. Every oracle that could have failed needed a conversation to
judge, and there were none. A verdict is only as strong as the population it
was computed over, and the report prints that population directly above it.

**A saturated harness reports a server problem.** Swarm workers default to
`min(cpus, ceil(bots/1000))`, which is two for a 2,000-bot run. The same 2,000
bots produced 5,008 messages at ack p99 **1261ms** on the default and 12,245 at
**598ms** on six workers — the first reading was more than twice as bad as the
truth, and it named the server. `vps:climb` pins six. Above roughly 2,500 bots
a worker dies before the server degrades and the rig cannot answer from this
laptop at all, which is the honest limit of what it currently measures.

---

## Standing, as of 2026-09-02

`npm run verify`: 882 backend unit, 188 frontend unit, green.
Integration: 33 files, green.

Eight findings this session — F-036 through F-043. Five were in code that
already existed; three (F-039, F-040, F-041) were in the tracing pipeline being
built at the time, two of those in the safety control itself.

## 2026-09-03 — what the observability stack costs on one core

**Question.** `docker-compose.vps.yml` omits Loki, Tempo, Alloy, Grafana,
cAdvisor and the exporters, on the stated grounds that "it is already decided
that production does not run them". That decision was being revisited on the
grounds that memory is not the constraint, so the assumption had to be measured
rather than argued.

**Method.** The VPS rig, with an overlay pinning **every** container to core 0 —
including the observability stack. Without that pinning the stack would have run
on the development machine's other seven cores and the answer would have been
"free", confidently and wrongly. Five runs per arm, 2,000 bots, 60s,
`realistic`, seed 101, six harness workers.

| | stack off | stack on |
|---|---|---|
| ack p99, five runs | 273, 273, 387, 414, 615 ms | 328, 404, 441, 758, 806 ms |
| median | 387 ms | 441 ms |
| messages delivered, median | 9,438 | 9,410 |
| observability CPU under load | — | ~4.4% of one core |
| observability memory | — | 231 MiB beyond Prometheus |

**Result: no separable cost.** The medians differ by 54 ms; the spread *within*
each arm is 342 ms and 478 ms, which is larger than the difference between them.
Throughput is indistinguishable. What is measured cleanly, because it is direct
rather than derived, is the stack's own consumption: **~4.4% of a core and
231 MiB**, on a tier where the application peaks near 222 MiB.

**The stack stays on the box.** Moving Grafana was also shown not to move the
query cost — Grafana renders, Prometheus evaluates, and Prometheus stays either
way.

**The confound is worth more than the number.** Both arms drift worse with run
order (off: 273 → 615 → 273 → 414 → 387; on: 404 → 328 → 441 → 758 → 806).
Runs are not independent — Postgres rows, retention-queue state and the TSDB all
accumulate across them. **Any future capacity comparison on this rig must reset
the stack between runs, or interleave the arms, or both**, or run order becomes
an undeclared variable and whichever arm runs second loses.

The first stack-off run's 273 ms is also 55% faster than the 2026-09-02 baseline
of 598 ms at identical parameters. These numbers compare *within* a session, not
across them.

See `docs/operations/DEPLOYMENT.md` §3.2.1.

## 2026-09-04 — F-037 closed: the country comes from the connection

**Symptom.** ~6% of declared profiles appeared not to round-trip, deterministic
per seed: `--seed 33 --bots 40 --duration 60 --profile realistic` returned
exactly 8 failures of 130, every time, with filters and tracing both off. The
swarm's verdict had been FAIL on this oracle since 2026-08-26.

**What it actually was.** The harness, and the same field as the last time this
finding was investigated. `server.ts` builds the join profile as
`{ ...command.profile, country: connection.country }` (`c043479`), so the
country **always** comes from `CF-IPCountry` and never from what the client
declared — including when the client declared nothing at all, which is how an
anonymous bot is echoed a country-only profile it never sent.

The ledger hashed *what the bot sent* and compared it against *what the server
built*. Those differ by exactly one field, for every bot whose declaration and
connection disagree, in every match, for ever.

**How it was found, in the order it happened.**

1. Reproduced first, per the standing rule. 8 of 146 echo checks, all of them
   "not echoed" and **none** "crossed" — no profile ever reached the wrong
   conversation, which is the half that would have been serious.
2. The failures clustered on individual bots rather than scattering. Tracing one
   through the ledger: the same declared hash and the same echoed hash across
   seven matches. Not a race — a deterministic transform.
3. That bot runs G1, "declares nothing, ever", which made the empty-profile
   collapse in `profileHash` the obvious suspect. **It was not:** `null` and
   "every field declined" both hash to the same value, as the comment there
   claims.
4. So the server had echoed something non-empty to a bot that declared nothing.
   Hashing every country-only profile found the match on the first try: the
   echo was `{ country: 'PH' }`, and PH is the country that bot's *connection*
   carries, drawn for a profile G1 discards in `onConnected` — after the header
   is set.

**The fix.** `bot.ts` remembers the country it connected with and records the
hash the server will build, rather than the one it sent. Modelling the rule
rather than dropping country out of the hash: dropping it would make a genuine
country-crossing bug invisible, and country is one of the two fields a moderator
reads first.

**Result.** 0 of 136 on the documented repro, and 0 of 1,926 at 500 bots on
another seed. Both runs end `VERDICT: PASS`.

**The lesson is the one already in `CLAUDE.md`, now with a second instance.** A
harness that has fallen behind reports a product bug, confidently, with a
plausible count attached — and a *deterministic* count reads as a product bug
more strongly than a random one would, because a race looks random and this did
not.

## 2026-09-04 — the database-agreement oracle was finished, and nothing ran it

**What was pending.** The oracle "the last SKIP" — the only check that looks at
PostgreSQL, and therefore the only one that can catch a retention bug.

**What was actually wrong.** Nothing, in the oracle. It was written, wired and
correct. `--postgres` was missing from every documented invocation: the command
in `docs/testing/README.md`, the one in `testing/SWARM-HANDOFF.md`, and every run copied
from either. So it skipped, and the verdict line said
`PASS (2 oracle(s) did not run)` — which reads as a complete run with a footnote
rather than as a run that never opened the database.

**Result once invoked**, 1,000 bots, 90s, `realistic`, seed 101:

| | |
|---|---|
| messages | 9,095 stored, 9,093 acked, 9,116 sent, **0 dropped** |
| bodies matching a sent hash | 9,095, **0 unrecognised** |
| retention windows | 30d, worst stamping lag 1.3s (D17 holds) |
| conversations | every one ended |
| verdict | PASS, with only the two deliberate skips |

**Two changes so it cannot go quiet again.**

`npm run swarm:full` passes all four flags, so the complete set is one command
rather than four remembered ones.

The verdict now distinguishes an oracle that skipped **for want of a flag** from
one the run deliberately did not ask for:

```
VERDICT: PASS (7 oracle(s) did not run)
  ...but 4 of those needed a flag this run did not pass: metric conservation,
  redis residue, log leak (invariant I8), database agreement.
  A pass that skipped them is a weaker claim than a pass that did not.
```

`--chaos` not being requested and an absent A14 group stay quiet, because those
are choices. A forgotten `--postgres` is not.

**The shape is F-045's, in a different subsystem.** Something was built,
documented as available, and reached nothing — and the report said so in
language mild enough that nobody read it as a problem. The fix is the same one:
make the complete thing the easy thing, and make the incomplete thing say so.

---

## 2026-09-04 — the pre-launch swarm, and three oracles that accused the server

Run for the launch checklist row "a full swarm run, all oracles, read before
launch". Six runs; the last is the one that satisfies the row.

**The run that ticks it — every oracle, one run, no skips:**

```
npm run swarm -- --seed 1823922046 --bots 400 --profile adversarial \
  --duration 300 --workers 4 --chaos c1 \
  --redis karobakbak-loadtest-redis-1 \
  --metrics karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2 \
  --postgres karobakbak-loadtest-postgres-1
```

`VERDICT: PASS`, nine of nine. 34,036 message positions agreeing across 8,037
conversations, 16,074 declarations agreeing on both sides, 34,462 messages
stored and accounted for, 18 banned identities refused and nobody else, no
message content in 944 log lines, and chat carrying 126.0 msg/s *through* a
paused PostgreSQL.

### The headline numbers, from the 1,000-bot realistic run

| | |
|---|---|
| bots / conversations / messages | 1,000 · 6,102 · 26,254 |
| message positions agreeing | 26,209 |
| declarations agreeing both sides | 12,204 |
| stored / acked / dropped | 26,229 · 26,226 · 0 |
| ack latency | p50 5ms · p95 50ms · p99 62ms |
| time to match | p50 12ms · p95 77ms · p99 119ms |
| harness event-loop lag p99 | 22.5ms |
| resumptions keeping their conversation | 205 of 246 (83%) |

The harness lag matters as much as the server numbers: at 22.5ms the harness was
not the bottleneck, so the latencies are the server's. Workers were set to 6
explicitly — the default of `min(cpus, ceil(bots/1000))` is **one** at this size,
and a saturated harness reports a server problem confidently.

### D16 and instance loss, measured rather than asserted

**C1, PostgreSQL paused mid-run:** delivery 55.5 msg/s during the outage against
53.8 after resume. The breaker opened (peak state 2), 4,837 records spooled and
drained on recovery. A database outage was not a chat outage.

**C2, a backend killed mid-run:** survivors carried 47.2 msg/s, and 532 of 533
connections came back. The metric oracle declined to check its conservation
identities rather than relaxing them — a killed process restarts its counters at
zero, so every delta undercounts, and the oracle says so instead of reporting a
shortfall that is not there.

### Three failures, all of them the harness

Two runs came back red. Both were investigated before being believed, which is
the standing rule after F-037, and all three findings were the harness reporting
a product bug with a plausible number attached.

**F-046, five banned identities "never refused".** Every one carried a `451` in
the ledger — refused by the edge geo-block before the upgrade could reach a
backend, so the ban was never asked. The ban held on all thirteen that did reach
the door. The oracle counted only `403` and read an edge refusal as a miss.

The fix is not "count 451 as a pass", which would be the worse mistake and the
one this oracle's own header warns about: a run whose whole A14 cohort drew an
EEA country would then prove enforcement while testing nothing. They are
excluded, named, and an empty tested set is now a failure.

**F-047, 219 stored bodies "hashing to something no bot sent".** Exactly the 219
rows with `moderation_action = 'block'`, confirmed by querying the database
rather than by inference — `allow|53183  flag|2192  block|219`. A refused
message is never acked and is still stored, because that is what retaining
evidence means, and the oracle built its hash set from acks alone.

The comment on that branch is the part worth keeping: it asserted withheld
messages were covered *because D20 stores them*, which is true of the server and
false of the code beneath it. A remark about the system was standing in for a
claim about the harness, and nobody re-read it once the two came apart.

**F-048, a 125s stamping lag against a 120s bound.** The lag is the write-behind
queue's latency, and pausing PostgreSQL is a deliberate instruction to make it
large — so the oracle reported a D17 violation for the one thing D17 does not
care about, how long the row waited before being written. The bound is now the
120s plus the chaos episode the run actually measured, and it is printed:
`stamping-lag allowance: 241s — 120s, plus the 121s chaos episode the queue was
told to wait through`.

Unlike the other two, this fix is **not** demonstrated by a before/after flip:
the re-run on the same seed measured 114.4s, under the old bound as well. What
is demonstrated is that the allowance now derives from the phases the scenario
recorded and states itself in the report.

### What the reruns prove

F-046 and F-047 were re-run on **the same seed as the failure**, so the
comparison is controlled rather than a different run that happened to pass:

| | before | after |
|---|---|---|
| enforcement at the door | FAIL — 5 "never refused" | PASS — 13 tested, 5 excluded and named |
| database agreement | FAIL — 219 unrecognised | PASS — 0 unrecognised |

### The thing to carry forward

Three red oracles in one afternoon, three harness bugs, zero product bugs. Every
one was deterministic, every one named a plausible server-side cause, and one of
them pointed at a safety control three days before launch.

F-037's rule held: reproduce before theorising, and check what the label means.
The ledger settled all three in minutes — the five "unrefused" bots each had one
line saying `451`, and the 219 bodies matched a `group by moderation_action`
exactly. The harness is now three accusations more trustworthy, which is the
only reason its next red run will be worth believing.
