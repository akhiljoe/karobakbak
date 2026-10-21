# Swarm handoff — read this before touching `load-test/swarm/`

Written to be picked up cold. It says where the work stopped, what is safe to
assume, and which traps have already been paid for once.

Read order for a new session: `CLAUDE.md`, then this file, then
`docs/testing/LOADTEST-SCENARIOS.md` (the catalogue and the target), then the two swarm
entries at the end of `docs/PROGRESS.md` (the reasoning).

---

## 1. Where things are

Three commits on `main`, tree clean:

```
(this one) test(load): teach the swarm about profiles, resumption and late blocks
0251455    test(load): labelled adversaries, and a measured answer to "would we notice"
c0c2b32    test(load): a swarm of scripted strangers, and oracles that judge the run
```

The third catches the harness up with phases 14–16 — declared profiles (§26),
session resumption (§28, D42) and the late-block window (D38) — and fixes a
harness bug those changes turned from invisible into fatal (see §4, trap 16).

Verified green after the catch-up, all against two backend replicas with every
implemented oracle passing: **400 bots on `human` for 1,500 seconds** (12,057
conversations, 96,400 message positions compared), **1,000** on `realistic`,
**200** on `adversarial`, **60** on `lifecycle`. The 5,000-bot `realistic` run
predates the change and should be repeated.

`npm run verify` is green (338 backend unit, 39 frontend unit). The swarm has its
own typecheck: `npm run swarm:typecheck`.

---

## 2. Running it

```bash
npm run swarm:install          # once

# the load stack comes up automatically; it uses .env.loadtest and the
# karobakbak-loadtest project, so it never touches the dev database
npm run swarm -- --bots 5000 --duration 150 --profile realistic \
  --redis      karobakbak-loadtest-redis-1 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2   --postgres   karobakbak-loadtest-postgres-1 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2

npm run swarm -- --bots 400 --duration 150 --profile adversarial --redis karobakbak-loadtest-redis-1
npm run swarm -- --bots 2   --duration 300 --profile tiny        # scenario S9
npm run swarm -- --seed 47 ...                                   # exact reproduction

npm run unblock:loadtest       # clear blocks between adversarial runs
npm run loadtest:down          # tear the stack down
```

Flags: `--bots --duration --ramp --profile --seed --workers --settle --url
--origin --out --redis --metrics --containers --key-prefix --segment --human`.

**A person can be in the run.** `--profile human` is a mix shaped for somebody
sitting at http://localhost:8090 instead of for statistics — prompt repliers
dominate, declared profiles are heavy, and the abusive fraction is small but not
zero so Block and Report get tried. `--human` puts a caveat in the report,
because a human is invisible to the ledger and shows up only as its
consequences: a conversation with one side missing, server counters ahead of
what the bots sent. Those otherwise read as a lost worker.

```bash
npm run swarm -- --bots 400 --duration 900 --profile human --human   --redis   karobakbak-loadtest-redis-1   --metrics karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2

# then open http://localhost:8090 and talk.
# Grafana for that stack is http://localhost:3002 (admin/admin), Prometheus 9092.
```

Nothing special is needed for the browser. It sends no `X-Forwarded-For`, so
with `TRUST_PROXY_HOPS=2` the chain is shorter than the hop count and
`clientAddress()` falls back to the peer address — the person gets nginx's
address, every bot keeps its own, and the two cannot collide.

**Open `http://localhost:8090`, not `http://127.0.0.1:8090`.** They are
different origins to the allowlist, which matches scheme, host *and* port
exactly. `.env.loadtest` now lists both, but a stack started before that change
— or a browser pointed at a LAN address — is refused at the upgrade with a 403,
and the client retries it like any dropped connection. The UI sits on
"connecting" and looks exactly like a server that is down. The one place it
shows is `chat_connections_rejected_total{reason="origin"}`; bots never trip
that counter, so any value in it is a person being turned away.

**`unblock` has a `:loadtest` twin now, and the plain one is a trap.**
`npm run unblock` talks to the *development* project, which is a different Redis.
Against a load run it fails with `service "redis" is not running`, or — if the
dev stack happens to be up — clears the wrong database and reports success.

Output lands in `load-test/swarm/runs/<run-id>/` — one NDJSON ledger per worker,
plus `report.txt` and `report.json`. Exit code is non-zero if any oracle failed
**or a worker died**.

**Run `npm run unblock:loadtest` between adversarial runs.** Blocks live 30 days
and a bot's synthetic address is derived from its index, so bot 41 is the same
person in every run against that stack. A few adversarial runs leave hundreds of block
relationships behind and quietly reshape the next run's matching. The Redis
oracle prints the count so it cannot creep up unnoticed.

---

## 3. File map

```
load-test/swarm/
  src/run.ts             orchestrator: parses flags, builds the labelled roster,
                         forks workers, drains, runs oracles, prints the verdict
  src/worker.ts          one process, N sockets, its own event-loop lag monitor
  src/bot.ts             the protocol client — cookie, XFF identity, heartbeat,
                         ack correlation, block-outcome correlation, bucket mirror
  src/personas/          behaviour only; each persona is a set of event handlers
    talkers.ts           N group          skippers.ts   S group
    lifecycle.ts         L group          abusers.ts    A group
    moderators.ts        M group          declaring.ts  G group (declared profile)
    resume.ts            L3/L13/L14/L15 — the section 28 personas
    support.ts           think time, speak, looksAbusive, resumeTalking
    index.ts             registry + mix profiles + expandMix
  src/declared.ts        profile generation, the two refusable shapes, profileHash
  src/corpus.ts          loader + the moderation lint
  src/campaign.ts        PROPOSED canonical form for cross-message identity
  src/ledger.ts          NDJSON writer; hashes, never message text
  src/rng.ts             seeded streams; nothing here uses Math.random
  src/identity.ts        synthetic addresses (RFC 2544 range) + cookie handling
  src/oracles/           ledger.ts metrics.ts redis.ts spam.ts logs.ts index.ts
  src/report.ts          verdict first, numbers second
  corpus/*.txt           what bots say; benign files are linted against real RULES
                         — `names.txt` included, and that lint is load-bearing:
                         a name that fires a rule is refused at join (D35), so
                         every bot drawing it silently leaves the population
```

Profiles: `realistic` (default), `adversarial` (safety numbers), `capacity`,
`lifecycle`, `human` (a person is in the swarm), `tiny` (S9 — run it with 2 bots).

---

## 4. Traps already paid for — do not rediscover these

Each of these cost a red run. They are in the code as comments too; this is the
index.

**About the server, learnt from runs:**

1. **`MESSAGE_TOO_LONG` is a protocol strike** (`connection.ts:216`), and
   `INVALID_MESSAGE_STRIKES` caps them (default 5, `backend/src/config.ts`). A
   persona that sends one over-length message per conversation is disconnected
   with 4003 once the strikes run out. N5 probes once per bot lifetime for this
   reason.
2. **The server trims message text** before storing and delivering. A bot that
   sends padded text hashes something the partner can never receive.
3. **An ack can arrive after a skip.** Do not clear ack correlations at match
   end.
4. **`block` and `skip` race even on one socket** — frame handlers are async and
   interleave. A block can come back `NOT_MATCHED`.
5. **`block` has a small burst and an hourly budget** (defaults in
   `backend/src/config.ts`). Most block attempts in an adversarial run are
   refused with `RATE_LIMITED` and write nothing.
6. **A block is an intent until confirmed.** Success is a `queue_status` with
   state IDLE; failure is `NOT_MATCHED` or `RATE_LIMITED`. Bind durability
   checks on confirmation only.
7. **`chat_active_matches` and `chat_queue_depth` are cluster-wide gauges**
   written only by the janitor's lock holder. The follower's copy freezes. Never
   sum them; `max` is also unreliable. Ask Redis.
8. **Counters are cumulative and the stack is warm.** Diff against a baseline
   scrape taken before the first socket opens.
9. **Message conservation is `received == accepted + rejected`, read entirely
   from server metrics.** `RATE_LIMITED` is also returned for `skip`, `block`,
   `report` and `join_queue`, so deriving refusals from ledger error codes
   over-counts.
10. **Cleanup is lazy by design.** Give gauges a settle window of at least two
    janitor intervals (15s each) before judging.
11. **A resume token must be offered *beside* `kbb.v1`, never alone.** The server
    deliberately never selects the resume subprotocol — echoing it would repeat a
    bearer token in the response headers — and `ws` fails any handshake where the
    client offered subprotocols and the server selected none. Offer
    `[kbb.resume.<token>, kbb.v1]`, or the upgrade fails outright.
12. **An age below the floor is a protocol strike; a refused name is not.**
    `validateProfile` runs inside `parseClientFrame`, so `AGE_BELOW_MINIMUM`
    counts towards the strikes that disconnect a socket with 4003. Name moderation
    is checked in `server.ts` after parsing and costs nothing. G2 probes once per
    lifetime for this reason; G3 repeats freely.
13. **A refused join leaves the bot believing it is SEARCHING.** The server never
    queued it, and nothing arrives to say so. Without rolling the optimistic
    state back, a refused bot sits out the rest of the run looking perfectly
    healthy — a hole in the population no oracle is looking for.
14. **`null` and "every field declined" are the same profile.**
    `profileFromFields` collapses an all-empty profile to `null`, so a hash that
    told them apart reports every anonymous bot as a profile the server failed
    to echo. That is exactly how the profile oracle failed on its first run.
15. **RESOLVED — the ack now says `undelivered`.** This used to read: an ack
    during a partner's absence says `delivered: true` and means nothing. That
    field carried the moderation verdict under the name of an outcome, so the
    harness inferred the truth from its own view of when the partner was away.
    The server reports it directly now, from the side that actually tried to
    deliver, and the local inference is kept only as a second opinion. Left in
    place because the reasoning below is still why the pair oracle treats these
    as holes rather than reorders.

    Originally: The message is accepted, routed at a session with no socket, and
    dropped — nothing is buffered (D43). The pair oracle has to treat it as a
    hole in the middle of the sender's list, not a reorder; see §7.

27. **`expandMix` floors every share, so a small weight is zero at a small
    run.** A14 was added at weight 2 against an adversarial total of 112 and
    produced *no bots at all* at 40 — the scenario silently did not run. The
    enforcement oracle reported `SKIP` rather than `PASS`, which is the only
    reason it was noticed. Same family as trap 18: a persona group that stops
    producing events looks like a clean run. Check a new scenario actually
    appears in the roster at the sizes people run.
28. **A banned bot still appears in "bots that connected".** That line counts
    distinct bots in the ledger, and a refused bot writes a `connect_refused`
    row, so the number now exceeds the population that actually held a socket
    whenever A14 is in the mix.

29. **The load-test database is not wiped between runs.** The database oracle
    compared one run's ledger against every run's rows on its first outing and
    reported 1516 stored against 738 acked. The rows were real; the comparison
    was not. Every query it makes is scoped to the run's start timestamp.
30. **A retention deadline is `now() + window` at insert, not
    `server_timestamp + window`.** The offset from a message's own timestamp is
    therefore the window *plus queue latency* — 12.6s under load in one run.
    Comparing exact seconds saw that as nine distinct retention windows and
    failed a healthy run; the check clusters to whole days and bounds the
    jitter instead. That jitter is the D17 signal: a deadline computed at
    deletion time would be out by the length of the run, not by seconds.
31. **The breaker's reaction time is `BREAKER_FAILURE_THRESHOLD` x
    `DATABASE_STATEMENT_TIMEOUT_MS`, and a C1 shorter than that proves nothing
    about the spool.** The first C1 run paused PostgreSQL for 60s and finished
    with the breaker still CLOSED, the retention queue at 3320 records and
    nothing spooled. The instinct is to call it a stuck breaker. It was not: a
    paused server answers nothing, so every failed write costs a full deadline,
    and the breaker wants five *consecutive* failures. Four per instance in
    sixty seconds never reaches five.

    A real bug was underneath it — a `ROLLBACK` sent down the unanswered
    connection waited out the deadline a second time, doubling the cost to 20s
    and putting the spool 100 seconds away (audit F-031, fixed in
    `storage/pool.ts`). But even fixed the arithmetic stands. Pick `--chaos-for`
    from the product of the two settings, with room to spare, or the oracle is
    only measuring that delivery survived — which is the main claim, but not the
    whole one.

32. **A chaos run leaves the database oracle nothing to compare.** It waits for
    the queue to drain and refuses to compare while records are in flight, which
    is right -- but a run that took the database away on purpose has a backlog
    by design, and the drain out of the spool is deliberately paced so it does
    not hammer a database that only just came back. It used to report FAIL for
    that and turn a green chaos run red. It now reports SKIP when a chaos
    scenario ran, and only then; the chaos oracle judges the recovery instead.

33. **A bot whose socket dies unasked used to be gone for good**, and it made
    the whole C group unable to measure recovery. `bot.ts` finished any bot
    whose socket closed without its persona having called `reconnect()`, which
    is right for every scripted close and wrong for the one kind the C group
    creates. The first C2 run ended with 282 of 586 connections and read exactly
    like a product refusing to let clients back in; it was the harness. A real
    browser reconnects after a drop -- that is the whole of §28 -- so
    `reconnectOnDrop` is set for chaos runs, and connections now hold through
    the kill. It stays **off** elsewhere: for every other scenario the persona
    asked for the close and knows what should happen next.

34. **Killing a process makes conservation unprovable, and that is not a bug.**
    A SIGKILLed backend takes two things with it: its counters, which restart at
    zero so every `after - before` delta undercounts; and its in-memory
    retention queue, whose records were acknowledged to clients and will now
    never be written *or counted as dropped*, because the counter that would
    have counted them died at the same instant. Both oracles know about it now —
    conservation says which identities it could not check and why, and the
    database oracle quantifies the loss instead of calling it silent ("killed
    instance took N acknowledged message(s) with it"). Do not relax either one
    to make a C2 run green.

35. **`worker 0 exited with code 3221226505` is a Windows native crash and can
    be spurious.** Seen immediately after start on a run whose worker code
    was byte-identical to the previous green run; it did not reproduce. **Seen
    twice now** -- an earlier 1,500-second `human` run lost its only worker at
    88 seconds the same way, with no stderr, and also did not reproduce. The
    important part is what the harness did: it failed the verdict with "the
    population was incomplete" rather than reporting 249 conversations as a
    pass. That is trap 24 working. Re-run before investigating, but never accept
    the numbers from a run that logged it.

36. **RESOLVED — it was the test, not a race.** `lifecycle.test.ts` "lets a
    disconnect and a match race" failed once on a CI runner and once locally,
    and never in 30 quiet runs. It looked like contention exposing a real
    teardown race. It was not.

    The test was written under D7, where closing a session ended its match. §28
    reversed that: a close now **holds the seat** for the grace window and
    leaves the conversation intact. So the old assertion — that neither side
    still points at a match — is only true for a deliberate teardown, and the
    test passed only because the interleaving where the *join* wins is rare.
    When it did win, the failure was certain, not probable.

    Proven mechanically rather than by reproduction, which matters here: the
    interleaving would not occur on demand — **0 of 60 forced rounds**, and 0
    failures in 10 runs under six saturating CPU hogs, on both the old and new
    tests. What was proven directly is that `close` with the default returns
    `detached` and leaves `currentMatchId` set, which is exactly the observed
    CI failure (a match id where null was expected).

    The lesson generalises past this test: **a test that encodes a superseded
    decision does not fail when the decision changes — it fails later, rarely,
    and reads as flakiness.** D42 was applied everywhere it had tests and this
    was one of the places it did not. Worth a look at anything else asserting
    that a close ends a conversation.

    Split into the two behaviours it conflated: a teardown (`holdSeat: false`),
    where neither interleaving can strand anyone, and a network blip, where the
    conversation survives and the seat is held. Both deterministic.

**About the harness itself:**

16. **The spam oracle's false-positive count is a measurement, not a verdict —
    and it grows with run length until it swallows the population.** The
    criterion is "the same line in five distinct conversations", which anyone
    with a finite vocabulary meets eventually. Measured on the same profile: 0
    of 381 benign bots at 150 seconds (4 conversations each), **251 of 381 at
    1,500 seconds** (35 conversations each). Nothing about the server or the
    query changed in between.

    So the oracle fails only on a **block durability violation** now. It used to
    fail on the false positives too, which meant it could never pass an
    endurance run (E10) however correct the product was. Growing the corpora
    (replies 40→124, small talk 50→98) delays the effect and does not remove it;
    nothing removes it, because real users repeat themselves too. The number is
    the precision budget a campaign detector would have to pay, and §6.1 of the
    catalogue now carries it.
17. **The sender cannot know its partner's socket died.** It learns from a
    `partner_reconnecting` frame that takes a round trip, and a message handed
    to the socket in that gap is acked `delivered: true`, reaches nobody, and
    carries no flag the sender could set. The oracle therefore reads the
    *partner's own ledger* for when it had no socket, with 500 ms of lead
    tolerance — the recorded `closed` is when the bot noticed, not when the
    socket became unusable, and the run that produced that constant had a
    message acked 10 ms before its partner's close and delivered to nobody.
18. **No bot in this harness had ever reconnected**, from the first commit until
    now. `reconnect()` scheduled the new connection through `this.timers`, and
    the close its own teardown produced ran `clearTimers()` on the next tick and
    cancelled it. Every run's `connect_attempt` count equalled its bot count
    exactly — which reads as "nothing went wrong" rather than as "L1, L2, L9 and
    L10 are dead". It mattered less when a dropped socket ended the conversation;
    under §28 the seat is *held* for somebody who is never coming back, so the
    same bug stalls the whole run, which is how it was finally noticed. The
    reconnect timer now lives outside `timers`, and anything that means "this bot
    is finished" cancels it explicitly.

    The lesson generalises: **a harness bug that removes behaviour looks like a
    clean run.** When a persona group stops producing failures, check that it is
    still producing *events*.

**About the environment:**

19. **A refused upgrade used to kill a bot permanently.** `unexpected-response`
    called `finish()`, so one refusal removed that bot from the run for good. It
    looked harmless because refusals are rare — until a backend restart, where
    nginx answers **502** for as long as it has no upstream: 244 of 400 bots
    died in one window and never came back, while the progress line kept
    printing "400 connected" because it counted a session id that outlives its
    socket. Both are fixed — retry with jittered backoff for 429/502/503, still
    terminal for 403, and the progress count reads live sockets.

    Worth knowing before writing the C group: pausing or restarting a backend is
    the *point* of those scenarios, and without this the harness loses most of
    its population every time one runs.
20. **A refused origin is invisible from the outside.** The upgrade returns 403,
    the client retries as it would after any dropped connection, and the UI
    shows "connecting" — the same thing it shows when the backend is down. There
    is no console error worth reading and nothing in the backend log. Check
    `chat_connections_rejected_total{reason="origin"}`: bots always send a
    matching Origin, so a non-zero value there is a person being turned away.
    `http://localhost:8090` and `http://127.0.0.1:8090` are different origins.
21. **Every bot needs its own address** or the first block kills matching for the
    whole swarm. `TRUST_PROXY_HOPS=2` in `.env.loadtest` plus a per-bot
    `X-Forwarded-For`.
22. **nginx `worker_connections` caps the edge.** A proxied WebSocket costs two.
    Set from the environment by an entrypoint script in the frontend image.
23. **A killed orchestrator used to leave its worker running**, holding every
    socket it had. Nothing noticed: the progress timer wrote into a closed IPC
    channel and the failure was swallowed. A stopped run kept 156 bots alive for
    **179 seconds into its replacement**, the two swarms matched with each
    other, and the new run's ledger held 853 conversations with one side missing
    while its metric conservation oracle failed on a mismatch that had nothing
    to do with the server. The worker now exits on `disconnect`, which fires
    however the parent died, and flushes its ledger on the way out.

    So: **never assume a stopped run has released the stack.** If a run is
    stopped by anything other than its own drain, check for a live `worker.ts`
    before starting the next one.
24. **A dead worker fails the verdict.** A crashed run once printed PASS on 11
    conversations out of 1,000 — every oracle read the truncated ledger as a
    smaller, self-consistent population.

**About the tooling on this machine:**

25. `cat > file <<'EOF'` through the Bash tool breaks on apostrophes in the
    content. Use the Write tool, or a Python heredoc.
26. Escape sequences written through a heredoc can arrive as literal control
    characters. `src/oracles/firstline.ts` builds LF and CR from `String.fromCharCode`
    for this reason — the same defence `hasForbiddenControlChar()` uses in the
    backend. Check with a control-byte scan before committing.

---

## 5. What exists

**52 of 144 catalogued scenarios**, 8 of 8 oracles.

| Group | Implemented | Catalogued |
|---|---|---|
| N conversation | 9 (N9 missing) | 10 |
| S matchmaking | 5, plus the `tiny` profile for S9 | 11 |
| A abuse | **14** | 14 |
| M moderation response | **10** | 10 |
| G declared profile | **4** | 4 |
| L lifecycle | 10 | 15 |
**Three groups moved out of the swarm and into the integration suite (phases
32, 32c, 32d), and the counts above say where they live.**

They were catalogued as swarm rows and none of them is a load scenario. P needs
one client and one expected refusal each. D needs a real PostgreSQL and control
over the configuration. R needs two writers racing on one Redis — the
catalogue's own preamble says "both sides under one controller", which is a
description of an integration test rather than of a swarm. A harness
synchronising two bots across a network to hit a Redis race is testing its own
scheduler as much as the server's scripts.

They run on every push now instead of when somebody remembers to start a stack.

**The R row was also wrong before it was updated.** It read "0 dedicated" while
R1, R4, R13 and R14 were already covered in `races.test.ts` under names that
describe the behaviour rather than the catalogue row. Worth remembering when
reading any coverage number here: this table is maintained by hand.

| P protocol / state machine | **28**, in `tests/integration/protocol-abuse.test.ts` | 28 |
| R races | **8**, in `tests/integration/races.test.ts` | 15 |
| C chaos | 0 | 16 |
| D data integrity | **3** (D5, D9, D10), in `tests/integration/retention-integrity.test.ts` | 10 |
| E load shapes | `--ramp`/`--duration` only | 10 |

Oracles: pair reconstruction, profile agreement, metric conservation, Redis
residue, spam detection with block durability, log leak, enforcement at the
door, database agreement. **All eight now run** — the last `SKIP` is gone.

Database agreement found a product bug on its first real run, which is the
argument for having built it: **matches reaped by the janitor never recorded an
ending.** `conversation_ended` was enqueued only by `endMatchAndNotify` — a
skip, an explicit leave, a close that ends the match — and the janitor had no
retention sink. Under §28 a dropped socket no longer ends its match, so "their
connection died" was the ordinary path into it and left `ended_at` and
`end_reason` null for ever.

**Fixed.** Both janitor scripts now return the match ids they ended rather than
a count, and the janitor writes a `conversation_ended` with `end_reason: reap`
for each. A run that reported 22 of 249 conversations without an ending now
reports none. The oracle polls for the count to reach zero rather than sampling
once, because a conversation whose seat is still held has legitimately not
ended yet — that is a transient, and "never ends" was the bug.

Every bot declares a profile on `join_queue`, so §26 is exercised by the whole
population rather than by one group; G is the refusals and the churn. The four
resumption personas (L3, L13, L14, L15) sit in `resume.ts`, and L9 resumes too —
a mobile network flapping in the same tab is exactly what §28 is for.

### Four weaknesses in what exists

* **The log-leak oracle has almost no surface.** The backend emits about five log
  lines per run — excellent hygiene, and it leaves the check with little to
  search. It prints its own coverage instead of a confident green. Making it
  meaningful needs a deliberately chatty run mode.
* **`looksAbusive` cheats.** M personas recognise the adversarial corpora
  directly, so the ~15s median time-to-first-report is an **optimistic bound**,
  not a forecast. Any conclusion drawn from it inherits that.
* **A worker died once, and nothing explains it yet.** A 1,500-second `human`
  run at 400 bots lost its only worker at 88 seconds with Windows exit code
  3221226505 (`0xC0000409`, the fast-fail V8 uses for a fatal error) and no
  message on stderr at all. Two 150-second reruns at the same seed and profile
  finished cleanly, and the ledger up to the moment of death is unremarkable —
  a flat ~1,250 events per five seconds, no bot spinning, no growth. Unresolved.
  If it recurs, run the worker under `--stack-size` and `--max-old-space-size`
  bounds and capture the child's stderr to a file rather than inheriting it; the
  orchestrator already treats a dead worker as a failed verdict, so it cannot
  hide.
* **L15 tests rotation, not concurrency.** It proves a *spent* token buys
  nothing, which is the defence that matters. What it does not do is present a
  token while the session holding it is still attached — that needs two live
  sockets for one bot, and every accounting assumption in this harness is "one
  bot, one socket". The server refuses that case (`resumeSession` checks
  attachment); nothing here confirms it.

---

## 6. Pending work, in the order worth doing it

### 6.0 Repeat the 5,000-bot run — DONE

Re-run on 2026-08-24 with resumption in the population, 5,000 bots on
`realistic`, 300s with a 90s ramp. All 5,000 connected. 19,196 conversations,
79,983 messages sent.

| | |
|---|---|
| message ack | p50 4ms, p95 50ms, p99 61ms |
| time to match | p50 7ms, p95 36ms, p99 70ms |
| harness event-loop lag | p99 23.1ms |
| reconnections keeping their conversation | 40% |

**The headline result is the load shedding.** 2,657 records were dropped under
overload and **every one of them was P3 `evicted`** — ordinary chat. Zero P0,
zero P1, zero P2. Safety evidence, moderated messages and reported-conversation
messages all survived a write path that could not keep up, which is exactly what
D26 and D27 claim and the first time it has been demonstrated at this size.

Queue conservation held exactly: `queued == flushed + dropped`
(137,882 = 135,225 + 2,657). The breaker never opened — the database was healthy
throughout, the writer was simply behind.

Two things the run taught, both now fixed:

* **The write-behind path sustains roughly 200 records/second** here, and a run
  this size ends with about 27,000 records still queued — around two minutes of
  drain. The database oracle's flat 60s drain timeout gave up half way and
  reported a shortfall that was still being written. It refused to compare,
  which was correct; the default was what was wrong, and it now scales with the
  population.
* **Message conservation is a range, not an equality.** The oracle asserted
  `stored == acked - dropped` and it held on every small run. At 1,000 bots it
  reported five *surplus* rows, and the surplus was right: 24 acks were lost
  with their sockets, and a message the server accepted and wrote before the
  socket died has a row and no ack in the ledger. The ledger counts acks a bot
  *received*, which is not the same as messages the server accepted. It now
  asserts `acked - dropped <= stored <= sent - dropped`.

Neither was visible below about a thousand bots, which is the argument for
running at this size rather than trusting a small run.

### 6.1 The database-agreement oracle — built, and now actually invoked

**Status, 2026-09-04: written, wired, and passing.** 9,095 messages stored and
accounted for at 1,000 bots, bodies matched by hash with none unrecognised, and
every retention deadline stamped at insert.

It spent months reported as "the last SKIP" for a reason worth keeping: the
oracle was finished, and **`--postgres` was missing from every documented
invocation** — the command in `docs/testing/README.md`, the one in this file,
and every run anybody copied from either. It skipped, the verdict said
`PASS (n oracle(s) did not run)`, and that read as a complete run with a
footnote rather than as a run that never opened the database.

Two things stop that recurring. `npm run swarm:full` passes all four flags, so
the full set is one command rather than four remembered ones. And the verdict
now names any oracle that skipped **for want of a flag** rather than by choice —
`--chaos` not being requested stays quiet, a forgotten `--postgres` does not.

The rest of this section is what it checks, and stands.

The only oracle that can catch a retention bug, and the retention path is the
one `DESIGN.md` makes the strongest claims about.

The join key is already there: **`conversation_id` is `text` and equals the
ledger's `matchId`** (migration `004_identifier_columns.sql` changed it from
`uuid`, and the design comment "equals the matchId" is now literally true).

What it should check:

* Rows in `messages` == the ledger's accepted count minus
  `chat_retention_dropped_total`, **exactly**. The write-behind path is lossy
  under overflow by design (D16), so drops must be counted, not tolerated.
* Every `conversations` row has an `ended_at` and an `end_reason`.
* Every `reports` row maps to a conversation its reporter was actually in —
  cross-check against the ledger's `reported` events, which carry the `matchId`.
* **D17:** `retention_expires_at` was stamped at insert time. Change
  `MESSAGE_RETENTION_DAYS` mid-run and prove rows written before the change kept
  their original deadline. This is the check that stops a config edit
  retroactively extending the life of stored user data.
* Message bodies stored match what the sender sent, by hash. The ledger holds
  `hash` per message; hashing `body` in SQL and comparing proves the text path
  end to end, including the Unicode personas.

Implementation notes: add `pg` to `load-test/swarm/package.json`; connect through
the published port (`POSTGRES_HOST_PORT=5435` in `.env.loadtest`) with the
credentials from `docker-compose.yml`. Follow the shape of `oracles/redis.ts` —
optional flag, `skipped` when not supplied, never a hard dependency.

**Watch out:** the retention queue is still draining when the run ends. The
metrics oracle already waits `--settle` seconds; this one needs to wait until
`chat_retention_queued_total == flushed + dropped` before comparing, or poll for
it with a timeout, or it will report a shortfall that is simply in flight.

### 6.2 C1 — pause PostgreSQL mid-run — DONE

D16 is no longer an untested claim. `src/chaos.ts` schedules the fault and
scrapes every counter at each phase boundary; `src/oracles/chaos.ts` judges the
growth between them, because "did delivery continue *during* the outage" is a
question about a window that a scrape taken at the end cannot answer.

The run: delivery held at **43.5 msg/s while PostgreSQL was paused**, against
43.7 msg/s after it resumed. A database outage is not a chat outage, and that
has now been watched rather than argued.

`pause`, not `stop`, and the distinction is the point — a stopped container
refuses connections instantly, which the driver reports as a fast error. A
paused one accepts them and never answers, which is the nastier failure and the
only one that tests timeouts. It is what exposed F-031.

Re-run at 90s, against the F-031 fix, the recovery half holds too: the breaker
reached OPEN, 10,904 records went to the spool and 6,200 came back out of it
while the run was still going. Client lag p99 sat at 22.8-23.0ms across the
pause *and* the resume with no visible step.

Two product bugs came out of it, both only reachable once the spool was: F-031
(the rollback doubling) and F-032 (one orphan message destroying the batch it
travelled in, which cost 1,350 P0 records in the first 90s run). Neither had a
test that could have found them, because nothing had ever made the spool
actually engage under load.

C4 and the other twelve catalogued C rows are untouched.

### 6.2b C2 — kill one of two backends — DONE

The likelier event by far. A backend dies on every deploy, every host
replacement, every OOM, and until now nothing had watched what happens to the
half of the population that was on it.

`docker kill`, not `stop`: SIGKILL, no graceful drain, no `server_shutdown`
frame, no chance to hand seats back. A clean shutdown is C3 and a different
claim. This is the ugly case, where the process is simply gone and every
recovery has to come from TTLs, the janitor and the clients.

**The product came through it.** The survivor absorbed the whole population
without a step in client lag — p99 sat at 22.7–23.0ms across the kill *and* the
restart — and delivery on the surviving instance never dipped. Cross-instance
routing is Pub/Sub on a per-session channel, so there is no table to go stale,
and half the sessions changing host at once is the condition that would have
exposed it if that were untrue.

**Two harness bugs came out first, and both are traps now.** A bot whose socket
died unasked was finished for good (trap 33), which made the first run read as a
product refusing to let clients back in. And a killed process takes its counters
and its unflushed queue with it, which made two oracles report silent data loss
(trap 34). Neither was the product. Both would have been found by any C-group
scenario that killed anything, and neither could have been found by reading the
code.

One thing to know before extending this: **the metrics scrape has to be
per-target.** A dead instance stops reporting rather than reporting zero, so a
sum across "whatever answered" *falls* when an endpoint disappears — which reads
as delivery collapsing, the exact conclusion C2 exists to test for, reached by
arithmetic instead of evidence. `Sample.target` exists for this, and the oracle
compares only instances alive in every phase.

### 6.3 The P group — 28 rows, cheap

One frame and one expected error code each. Catches `validate.ts` regressions.
Note P24 is deliberately "not expressible" and P26 expects **acceptance**;
`docs/testing/LOADTEST-SCENARIOS.md` explains both.

### 6.4 The R group — needs a coordinating cohort

Two bots pinned to one worker, firing simultaneously on a shared trigger. The
sharding already keeps adjacent roster indices in one process; nothing drives
them yet. R13 (two instances running `tryMatch` over the same candidates) is the
strongest argument for the Lua-script design and should run continuously.

### 6.5 Remaining L rows, then E load shapes

L5 (slow consumer, backpressure kill) and L7 (thundering herd) are the
interesting ones. L7 needs `sharedAddress()` in `identity.ts`, which exists and
is currently unused. E6 (80% idle / 20% active) and E10 (endurance) are where
capacity numbers should actually come from.

---

## 7. The open product questions this work produced

Not tasks for the harness — decisions for the people who own the product.

1. **A serial-spam detector cannot reuse `moderationView`.** Measured: the
   moderation view groups a mutating campaign no better than exact content, and
   a purpose-built canonical form does much better with no false positives on
   benign users in short runs. `src/campaign.ts` is that form, kept in the harness because it
   is a proposal with its own false-positive budget. See
   `docs/testing/LOADTEST-SCENARIOS.md` §6.1.
2. **Blocking does not bound a spammer.** Blocks and reports arrive quickly,
   but a block protects the blocker and nobody else.
3. **A block racing a teardown is silently lost.** The user pressed Block; the
   server answered `NOT_MATCHED` because the partner had already left, and
   nothing was recorded. Whether the UI should retry, or the server should record
   a block against a departed partner, is a product decision.
4. **The block limiter has an hourly budget.** A user meeting several bad
   strangers in a row can run out of blocks. Whether that is the right budget is worth revisiting
   alongside (2).
5. **Repeating a line is not, alone, a campaign definition.** It is a
   vocabulary-size measurement, and over a long enough window it accuses many
   ordinary users. The recall in `docs/testing/LOADTEST-SCENARIOS.md` §6.1 is
   real and still worth having; the zero-false-positive figure beside it came
   from short runs and does not survive a long one.

   Anything built on `campaign.ts` needs a second axis before it points at real
   accounts — volume, rate, or what share of a sender's output the repeated line
   is.
6. **A message sent while the partner is reconnecting is acked as delivered and
   then dropped.** Measured, not theorised: the L13 persona sends into the gap
   on purpose, and the pair oracle now counts how many messages were *provably*
   never delivered — one in a 1,000-bot realistic run, hundreds in a run full of
   dropped sockets.

   Everything about it is working as designed. `message_ack` has always meant
   "accepted and routed", buffering the text would write message content to a
   Redis key (I8, D43), and the shipped client disables the composer so a person
   never sends into the gap at all. But a client that is not this one — a
   reconnecting tab whose composer re-enabled a moment early, a future mobile
   app — gets a positive acknowledgement for a message nobody will ever read.

   The question for whoever owns the protocol: should the ack distinguish
   "routed to a live socket" from "routed to a held seat"? A third `route` value
   would cost one field and would let any client show the sender what actually
   happened. The alternative — that the composer being disabled is the whole
   defence — is a UI guarantee protecting a protocol property, which is the kind
   of arrangement that survives exactly until the second client.

---

## 5. Three traps added 2026-09-04, all from the pre-launch run

Each was a red oracle that named the server. All three were the harness.

**A `451` is a refusal the ban never got to make.** The edge geo-block in
`frontend/nginx.conf` answers in nginx, before the upgrade reaches a backend and
therefore before `chat:ban:{key}` is read. An A14 bot that draws an EEA country
is refused *harder* than the ban would refuse it, and the ban is never asked.
The enforcement oracle counted only `403` and reported five of eighteen as
"never refused" — a safety bug that had not happened. It now partitions the
cohort, names the ones excluded at the edge, and **fails if the tested set is
empty**, because a cohort entirely geo-blocked would otherwise pass while
demonstrating nothing.

**A refused message is stored and never acked.** Moderation refusing a message
outright still writes the row — D20 keeps it as evidence, which is the point of
retaining it — so any set built from `ack` events is missing exactly those
bodies. The database oracle reported 219 of them as content the text path had
altered. Hashes come from `sent` now. Confirm this class against the database
directly: `select moderation_action, count(*) from messages group by 1` named it
in one query.

**Stamping lag is queue latency, and chaos is an instruction to make it large.**
Pausing PostgreSQL holds records in the spool for the outage plus the paced
drain, so the D17 stamping-lag bound has to widen by the episode or it reports a
retention violation for the one thing D17 is indifferent to. The allowance is
`120s + the measured span of the chaos phases` and is printed in the report.
Derived from the phases the scenario recorded, never from `--chaos-for`: a
scenario that threw half way leaves a shorter real span, and a bound taken from
the flag would allow a latency the run never justified.

**The pattern, and it is now the third session in a row.** F-037 was the harness
and read as a product bug because it was deterministic. So were all three of
these. A race looks random; a harness bug looks like a finding. Read the ledger
for the individual bots named in a failure before theorising — five lines of
NDJSON settled the first of these, and one `group by` settled the second.
