# Load-test scenarios — the swarm

What a realistic run of karobakbak looks like when several thousand simulated
people use it at once, and what each of them is there to prove.

This is the plan document for `load-test/swarm/`. `load-test/websocket.js` (k6)
stays: it is the raw capacity smoke test, deliberately dumb, one behaviour. The
swarm is the opposite — it is a population, and its output is a verdict about
invariants rather than a latency number.

## 0. Running it, and what exists today

```bash
npm run swarm:install                       # once
npm run swarm -- --bots 5000 --duration 150 --profile realistic \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2

npm run swarm -- --bots 400 --duration 150 --profile adversarial   --redis karobakbak-loadtest-redis-1                      # the safety numbers

npm run swarm -- --bots 2 --duration 300 --profile tiny    # S9
npm run swarm -- --seed 47 ...                             # reproduce a run exactly
npm run unblock:loadtest                                   # clear blocks between runs
npm run loadtest:down                                      # tear the stack down

# a person in the swarm: run this, then open http://localhost:8090 and chat
npm run swarm -- --bots 400 --duration 900 --profile human --human
```

`npm run swarm` starts the load stack first (`.env.loadtest`, project
`karobakbak-loadtest`), so the traffic never touches the development database.
A run writes its ledger, `report.txt` and `report.json` to
`load-test/swarm/runs/<run-id>/`, and exits non-zero if any oracle failed.

**`npm run unblock:loadtest` between adversarial runs.** Blocks live for 30 days
and a bot's synthetic address comes from its index, so bot 41 is the same person
in every run against the same stack. A few adversarial runs leave hundreds of
block relationships behind, and the next run's matching is then shaped by them.
The Redis oracle prints the count so it cannot creep up unnoticed.

Note the `:loadtest` suffix. Plain `npm run unblock` talks to the **development**
stack, which is a different project with a different Redis, and against a load
run it either fails with `service "redis" is not running` or — worse, if the dev
stack happens to be up — clears the wrong database and reports success.

**A person can join a run.** `--profile human` is a mix shaped for someone
sitting at http://localhost:8090 rather than for statistics, and `--human` puts
a line in the report saying so: a human is invisible to the ledger and shows up
only as its consequences — a conversation with one side missing, server counters
ahead of what the bots sent — which otherwise read as a lost worker. Numbers from
a `human` run are not capacity numbers. The browser needs no special treatment:
it sends no `X-Forwarded-For`, so with `TRUST_PROXY_HOPS=2` the chain is shorter
than the hop count and `clientAddress()` falls back to the peer address, which
gives the person nginx's address and every bot its own.

**Implemented:** the harness, the seeded roster with ground-truth labels, 51
personas across N, S, L, A, M and G, the corpus and its lint, and six of the
seven oracles — pair reconstruction, profile agreement, metric conservation,
Redis residue, spam detection with block durability, and the log leak check.
Verified at 5,000 bots (realistic) and 400 bots (adversarial) against two
backend replicas.

**Not implemented yet, and reported as `SKIP` in every run rather than omitted:**
the database-agreement oracle, the P and R groups, and every chaos condition.
The catalogue below is the full target; the report is the honest statement of
how much of it ran.

---

## 1. Why not just more k6

k6 gives concurrency and percentiles. It cannot give what this product's
failures actually need:

* **Persona state that survives across matches.** A serial spammer is only
  detectable across the twenty conversations it had, not inside any one of them.
  A k6 VU is a fresh iteration.
* **Ground truth.** The interesting question is not "was it fast" but "did the
  system notice the twelve bots we planted". That needs a labelled roster and a
  post-run query, which is a program, not a summary line.
* **Pair-level assertions.** Both sides of a conversation receive the same
  `matchId`. A harness that owns both bots can reconstruct every conversation
  and check that what A acked is exactly what B received — the strongest
  delivery oracle available, and impossible from inside a single VU.
* **Chaos with a witness.** Pausing PostgreSQL mid-run only means something if
  something is simultaneously measuring whether chat noticed (D16).

So: k6 for capacity, swarm for behaviour. Both, not one.

---

## 2. Three constraints that shape every scenario

### 2.1 One host, one IP — and blocks are keyed on it

`blockPartner` records `SADD chat:blocks:{blockerIpHash} {blockedIpHash}` when
`BLOCK_DIMENSION_IP_ENABLED` is on, and `tryMatch`'s `isBlocked` checks that set
in both directions. Every bot on one load generator shares one address, so the
first `block` any bot issues writes *ipHash → the same ipHash*, and from that
instant **no bot in the swarm can ever match another**. The run does not fail
loudly; it goes quiet, which is worse.

The fix is not to disable the block dimension — that would delete the scenarios
that matter most. It is to give every bot its own address:

```
# .env.loadtest, loadtest stack only
TRUST_PROXY_HOPS=2
```

`clientAddress()` counts from the right. nginx appends the real peer with
`$proxy_add_x_forwarded_for`, so with two trusted hops the chain is
`[bot-chosen IP, generator IP]` and the entry the bot chose is selected. Each
bot picks a stable synthetic address from its seed, keeps it across reconnects,
and therefore has a real, distinct block identity and a real per-IP rate-limit
bucket.

This is a load-generator affordance, exactly like `CONN_RATE_LIMIT` already is,
and it lives only in `.env.loadtest` (created from `.env.loadtest.example` on
first use). A deployment sets its own hop count for its own proxy chain.

**Consequence worth stating plainly:** with distinct per-bot addresses, the
shipped per-IP limits (`MAX_CONNECTIONS_PER_IP`, `CONN_RATE_LIMIT`; defaults in
`backend/src/config.ts`) can stay at their defaults for most personas, so the
run measures the shipped defaults. Only the personas that *intend* to trip a limiter share an
address, and they share it on purpose.

### 2.2 A cookie is an identity

The server mints a client token in a `Set-Cookie` on the upgrade response, and
it is the second block dimension. A bot that drops the cookie on reconnect is a
different person to the server. Bots therefore persist their token for their
whole life — that is what makes "reconnect and get blocked again" testable at
all.

### 2.3 The command rate limits are low, on purpose

Shipped defaults, from `backend/src/config.ts` (a deployment may set its own):

| Command | Default | Effect on a persona |
|---|---|---|
| `message` | 3/s, burst 8 | Fast typers are fine; flooders are the point |
| `typing` | 4/s, burst 8 | Per-keystroke indicators would trip it; throttle like the UI does |
| `join_queue` | 10/min, burst 4 | Queue flappers hit this in seconds |
| `skip` | 15/min, burst 5 | **The hyper-skipper hits this after a handful of fast skips** |
| `report` | 6/hour, burst 2 | A bot cannot report every partner |
| `block` | 12/hour, burst 3 | Same |

Personas must treat `RATE_LIMITED` as an expected answer with a backoff, never
as a failure. A run where skippers spend their time being throttled has measured
the token bucket — which is itself a finding worth reporting, but it must be
reported as that and not as capacity.

---

## 3. The scenario catalogue

Each scenario is one persona or one condition. `Oracle` is how the run decides
it passed — the whole point of the harness.

### N — normal conversation

| ID | Persona | Behaviour | Proves | Oracle |
|---|---|---|---|---|
| N1 | **Talker** | Joins, greets, turn-takes from the corpus with think-time proportional to partner message length, sends `typing` on/off around each send, ends with `leave_chat` after 8–30 turns | The ordinary path at scale: delivery, ordering, ack latency, retention | Every `message_ack{delivered:true}` on A has a matching `message` frame on B with the same `matchId`; text identical; per-match order preserved |
| N2 | **Long-hauler** | One conversation for 10–30 min, sparse messages, relies on heartbeat | Session and match TTL refresh; a live conversation never expires under it | No `SESSION_GONE`; conversation row's `ended_at − started_at` matches the harness ledger |
| N3 | **Lurker** | Replies to one message in three, 20–90 s think time | Idle-but-alive sessions; presence counts | Session survives; partner's typing/presence frames arrive |
| N4 | **Polyglot** | Corpus lines with emoji, CJK, RTL, combining marks, zero-width joiners | Length counting, normalisation view, PostgreSQL round-trip | Text stored in `messages.body` is byte-identical to what was sent and to what the partner received |
| N5 | **Verbose** | Messages at exactly `maxMessageLength`; one over, **once per bot** | Boundary of the length check | At limit → ack; over → `MESSAGE_TOO_LONG`, socket stays open. See the note below — the "once" is load-bearing |
| N6 | **Rapid turn-taker** | Both sides reply within 100–500 ms for 20–50 turns | Ordering when sends are near-simultaneous in both directions | Per-match hash sequence identical on both sides; no reorder, no duplicate, no gap |
| N7 | **One-sided chatterbox** | 20–50 messages while the partner stays near-silent | Asymmetric load: one busy sender, one idle receiver | Sender stays inside its bucket and healthy; receiver's `received` count equals the sender's `delivered:true` acks |
| N8 | **Conversation finisher** | Talks, says goodbye, `leave_chat`; the partner leaves independently | Clean bilateral teardown from both directions at once | Exactly one conversation end recorded; no residual match or queue membership for either side |
| N9 | **Late joiner** | Connects when the population is already matched up, waits in queue | Queue fairness for an arrival that missed the rush | Matched within the fairness window; never starved behind a churning population |
| N10 | **Persistent regular** | 50–100 sequential conversations, ordinary behaviour throughout | State leakage across many matches — the failure that only appears on the fortieth | No frame carrying a previous `matchId`; identity, blocks and dedupe scope never bleed between matches |

**On N5, learnt from a run rather than from the code.** `MESSAGE_TOO_LONG`
counts as a protocol strike (`connection.ts:216`, deliberately: "a client that
cannot construct a valid frame is either broken or probing"), and
`INVALID_MESSAGE_STRIKES` bounds it (default 5, in `backend/src/config.ts`). A
persona that tries one over-length message per conversation is therefore not a
verbose user — it is a protocol-abuse persona in disguise, and the server closes
it with `TOO_MANY_INVALID_MESSAGES` and 4003 once the strikes run out. That is the server being
right. The over-length probe happens once per bot; the strike behaviour belongs
to P-group work, where it can be asserted deliberately.

Two smaller facts with the same origin, both worth knowing before writing a
persona:

* **The server trims message text before storing and delivering it.** A bot
  that sends padded text hashes something the partner can never receive, and
  the pair oracle then reports a delivery bug that belongs entirely to the
  harness. `Bot.sendMessage` trims, and records a `harness_error` when it had to.
* **An ack can arrive after a skip.** The message was accepted and delivered;
  teardown raced the acknowledgement. A harness that forgets what it sent at
  match end reports "the partner received a message the sender was never acked
  for", which reads exactly like a routing bug and is not one.

### S — skipping, the actual product loop

| ID | Persona | Behaviour | Proves | Oracle |
|---|---|---|---|---|
| S1 | **Grazer** | Two or three messages, then `skip`. Repeats all run | Queue churn, match latency under constant re-entry | Every skip yields a new `matched` with a different `matchId`; `chat_skips_total` matches ledger |
| S2 | **Hyper-skipper** | Skips within 1–3 s of match unless the partner's first message matches its "looking for" predicate. Backs off on `RATE_LIMITED` | The skip limiter under its intended load; whether the queue starves when many people churn | `RATE_LIMITED{command=skip}` count matches the harness's own prediction from the bucket parameters; queue depth returns to baseline |
| S3 | **Picky pair** | Two hyper-skippers that would accept each other; run long enough that they should meet | Matchmaking fairness — nobody is starved by `SRANDMEMBER` sampling | Match count per bot within a stated band; no bot with zero matches after N minutes |
| S4 | **Leaver** | `leave_chat` rather than `skip` — stops, does not re-queue | The distinction the protocol exists to express | State goes `MATCHED → IDLE`, no re-match without an explicit `join_queue` |
| S5 | **Queue flapper** | `join_queue` / `leave_queue` repeatedly | Idempotency, queue GC, the join limiter | No orphan queue members at end; `SCARD chat:queue:default` is 0 after drain |
| S6 | **Queue survivor** | Joins once and waits through several match cycles happening around it | Queue stability under churn — an entry must not be collateral damage of somebody else's GC | Stays a queue member throughout; `tryMatch`'s stale-entry cleanup never removes a live searcher; eventually matched |
| S7 | **Instant rejoiner** | `skip` → `join_queue` in the same tick, forever | Cleanup ordering between the old match's teardown and the new session state | Never receives a frame carrying the previous `matchId` after the new match begins |
| S8 | **Unmatchable** | Has blocked, or been blocked by, every eligible partner | What the product does when the queue is full of people you cannot meet | Stays queued, never matched, and the *cost* stays flat: `blockedSkipped` rises but Redis call count per attempt does not grow |
| S9 | **Tiny population** | The whole run is 1–2 eligible users for several minutes | Low-population matchmaking, which large runs hide completely | Never self-matches; no duplicate match for one session; queue never corrupts when the only candidate is the caller |
| S10 | **Queue surge** | A large population joins at once, then drains gradually | Queue insertion and removal at scale | Every join is accounted for: matched, still queued, or explicitly left. Match count reconciles with the ledger exactly |
| S11 | **Matchmaking churner** | Thousands cycling enter → match → skip → re-enter for the whole run | Sustained matchmaking pressure rather than a burst | Creation and teardown rates stay flat over time; `chat_active_matches` has no upward drift; no ghost match at the end |

**S9 deserves its own run, not a slot in a mix.** Nearly every matchmaking bug
this design worries about — self-match, double-match, a queue entry surviving
its session — is *masked* by a large population, because `SRANDMEMBER` almost
always finds a clean candidate and the broken path is never taken. A two-user
run for five minutes exercises the empty-and-nearly-empty queue continuously.

### A — spam and abuse, with ground truth

These are the scenarios the whole harness exists for. Each bot in this group is
**labelled in the roster** before the run, so precision and recall are
computable afterwards.

| ID | Persona | Behaviour | Proves | Oracle |
|---|---|---|---|---|
| A1 | **Copy-paste spammer** | Identical line every match, then immediate `skip`. 100+ matches per run | Whether a serial spammer is detectable at all | Offline: group `messages` by normalised-body hash across distinct `conversation_id`; the labelled bots must be in the top results. **Expected today: nothing live fires** — see §6 |
| A2 | **Mutating spammer** | Same payload, varied per send | Whether the normalisation view identifies variants of one campaign | **It does not.** Exact and normalised grouping both miss it; a purpose-built canonical form does much better. See §6.1, this row is the one the runs rewrote |
| A3 | **Link dropper** | Corpus of URLs, bare domains, IP literals, invite links | The `url` / `invite_link` rules | `chat_moderation_flags_total{action=flag}` rises; `messages.flags` contains the rule id; still delivered (D20) |
| A4 | **Contact harvester** | Emails, phone numbers, social handles, "add me on…" | `email` / `phone` / `social_handle` / `contact_solicitation` | Flags recorded with the right severity; sender never told anything beyond the ack |
| A5 | **Deny-list hitter** | Terms from the configured deny list | Hard-block path when `MODERATION_HARD_BLOCK_RULES` is set | `message_ack{delivered:false}` or `MESSAGE_WITHHELD`, partner receives nothing, row still stored |
| A6 | **Flooder** | Bursts past the message limit | The message token bucket under real sockets | `RATE_LIMITED{command=message}`; no dropped socket; partner's stream has no gaps |
| A7 | **Harasser** | Aggressive corpus, does not stop when asked | Feeds M-personas something to report | Reports land with the right `category`; blocks recorded on both dimensions |
| A8 | **Slow spammer** | Sends steadily within the message limit | That rate limiting is not spam detection: the two are unrelated controls | Never rate-limited; volume across conversations is what identifies it |
| A9 | **Burst-and-wait** | Ten messages, pause until the bucket refills, repeat | Whether burst capacity is gameable into sustained throughput | Sustained rate converges on `perSecond` regardless of burst shape; bucket accounting has no leak |
| A10 | **Multi-match spammer** | Runs the same campaign against many partners in sequence, as fast as skip allows | Cross-conversation attribution — the only view in which a spammer exists | Every campaign conversation resolves to one labelled sender in the ledger and one identity in the database |
| A11 | **Template rotator** | Varies wording rather than characters | Detection robustness beyond exact repetition | Hash-based grouping cannot fold paraphrases; that needs similarity, not hashing |
| A12 | **Report spammer** | Reports every partner regardless of what they said | Report abuse: the limiter, and the write amplification behind it | `RATE_LIMITED{command=report}` after the burst; database writes bounded by the limiter, not by intent |
| A13 | **Block/skip attacker** | Blocks and skips as fast as both limiters allow | Interaction of two teardown paths racing on one match | Exactly one teardown per match; no queue corruption; counters agree with the ledger |
| A14 | **Banned returner** | An identity under an active ban, applied before the run opens a socket | Enforcement at the upgrade under load — and, just as much, whether it catches anyone *else*. Every bot shares a host, so a ban keyed on the wrong hop refuses the whole population, and a run that quietly shrinks passes every other oracle | Every A14 bot refused 403 and never allocates a session; **no other bot refused 403**; `chat_connections_rejected_total{reason="banned"}` moves. Silence is a failure, not a pass: if no ban applied, nothing was tested |

A8–A11 are the behavioural half of this group, and they are the ones that
matter for the question in §6. A3–A7 test *payloads*, which the rule engine can
see. A8–A11 test *patterns*: per-message moderation cannot see campaigns spread
across messages and conversations, so these rely on reports until a
cross-message detector exists.

### M — moderation response, the other half of A

| ID | Persona | Behaviour | Proves | Oracle |
|---|---|---|---|---|
| M1 | **Reporter** | Reports a partner whose text matches its own "offensive" predicate, keeps chatting | `report` does not end the match; `report_ack` carries no verdict | `report_ack` present, contains only id + time; conversation continues |
| M2 | **Blocker** | Blocks after one bad message, lands in IDLE | Block records both dimensions; blocked party is told only `partner_skipped` | Blocked bot's received frame is `partner_skipped`, never anything block-shaped |
| M3 | **Grudge holder** | Blocks bot X, then re-queues for the rest of the run | Blocks outlive the session id (D18) | X and the blocker never share a `matchId` again, across reconnects on both sides |
| M4 | **Mass blocker** | Blocks every partner until the block limiter refuses | Whether one user can shrink their own matchable pool to nothing, and how that feels | Match latency for this bot climbs; `blockedSkipped` in `tryMatch` rises; **other bots' latency must not move** |
| M5 | **Report race** | Files a report in the same tick the partner skips | Report persistence through teardown — §10.16 is why `blockPartner` resolves and writes in one script, and `report` has the same exposure | The report is stored against the conversation it was filed in, or refused cleanly. Never stored against the wrong one, never silently dropped |
| M6 | **Block race** | Blocks while the blocked party is reconnecting | Whether a block survives the session being replaced underneath it | The blocked party's *new* session cannot match the blocker: the block keys on IP and client-token hashes precisely so a new session id changes nothing (D18) |
| M7 | **Mutual blocker** | A blocks B, and B blocks A | Bidirectional handling of a one-directional record | `isBlocked` checks both directions, so one record already suffices; two must not double-count, error, or resurrect the pair |
| M8 | **Reporter reconnect** | Reports, disconnects, reconnects | Report durability independent of the session that filed it | Report row survives; still references the original conversation; the new session inherits nothing |
| M9 | **Repeated reporter** | Reports the same partner in the same conversation several times | Report idempotency — the protocol says `report` is *not* idempotent, so this tests the documented behaviour, not an assumed one | Each frame files a distinct report with its own id, up to the limiter. Duplicates are a product decision, and the run states the count rather than asserting one |
| M10 | **Late blocker** | Blocks a partner who has *already left*, then tries again inside the same window | D38: the case that used to record nothing at all. Someone says something vile and skips, the user reaches for Block, and the server answered `NOT_MATCHED` | The first block is confirmed like a live one (`queue_status` IDLE) and ends nothing — no `partner_skipped` for a match that finished minutes ago, and `conversation_id` null rather than `''`. The second is refused: the record is spent when used, or one departure would burn the hourly budget on the same person |

### G — the declared profile

What a stranger volunteers about themselves (§26). Every bot in the swarm now
declares one on `join_queue`, so the happy path is covered everywhere; this
group is the refusals and the churn, which need bots that misbehave on purpose.

**The trap, before writing anything here.** The two refusals arrive by different
routes and only one of them is free. An age below the floor is refused inside
`parseClientFrame`, which makes it a **protocol strike** counted against
`INVALID_MESSAGE_STRIKES`, and a persona that probed it every conversation would
be disconnected with 4003 partway through the run. A refused *name* is rejected in `server.ts`
after the frame has parsed, so it costs nothing and may be repeated.

| ID | Persona | Behaviour | Proves | Oracle |
|---|---|---|---|---|
| G1 | **Anonymous** | Declares nothing, ever | The null path, which is the most common real profile there is | Both sides render from the server-generated nickname; nothing downstream needs a profile to exist. `null` and "every field declined" are the same thing on the wire |
| G2 | **Underage declarer** | Declares an age below `MIN_DECLARED_AGE`, **once per lifetime** | The floor is enforced with its own code, so the client can say what the service is and the server can count a minor-safety signal | `AGE_BELOW_MINIMUM`, not a generic `VALIDATION_FAILED`; nothing about the refused age is stored; a later join with an acceptable age matches normally |
| G3 | **Name advertiser** | Puts a contact handle in its display name, repeatedly | D35: a name is a label shown to everyone this person meets, so *any* rule refuses it — unlike a message, which is flagged and delivered (D20) | Every attempt refused; `chat_profiles_refused_total{reason="name_moderation"}` accounts for all of them; the flags are logged, the name never is |
| G4 | **Profile churner** | A different declaration on every join, including declaring nothing | A join carries the **whole** profile and an omitted field is deleted — there is no partial update | Each conversation sees the current declaration and no trace of the previous one |

### L — connection lifecycle

| ID | Persona | Behaviour | Proves | Oracle |
|---|---|---|---|---|
| L1 | **Tab closer** | Clean close mid-conversation | `partner_disconnected` path | Partner receives it within the heartbeat window; match row cleaned |
| L2 | **Rage quitter** | TCP reset, no close frame | Half-open detection, janitor | Same as L1, but via TTL/janitor rather than a close handler |
| L3 | **Refresher** | Drops mid-conversation and comes back inside the grace window presenting its resume token | Session resumption (§28, D42): the seat is held, the conversation survives, the transcript is not lost | `connected.resumed` carries the same `matchId`; the partner saw `partner_reconnecting` then `partner_returned`; the pair oracle's comparison spans the gap |
| L4 | **Backgrounded phone** | Stops sending entirely, socket stays open, no `ping` | Session TTL expiry of a silent client | `SESSION_GONE` at the configured TTL, not before |
| L5 | **Slow consumer** | Never reads its socket while its partner floods | Backpressure kill | Close code 1013; other bots unaffected |
| L6 | **Settings browser** | Connects, never joins the queue; toggles typing; idles | The non-participating user — presence counts them, matchmaking must not | Counted in `presence.online`, never in `chat_queue_depth` |
| L7 | **Thundering herd** | 500 bots connect within 2 s | Connection rate limiting, `/ready`, upgrade cost | Refusals are 429 with `chat_connections_rejected_total{reason}` labelled; no crash; no accepted socket left in a broken state |
| L8 | **Reconnect storm** | Thousands disconnect and reconnect inside a short window | Session creation and cleanup under churn — the shape a deploy produces | Sessions created equals sessions closed plus sessions live; no Redis session hash outlives its TTL; every bot ends up in a working state |
| L9 | **Network flapper** | connect → disconnect → reconnect on a short interval, repeatedly | Rapid lifecycle transitions where cleanup and setup overlap | One live session per bot at any instant; a new session never inherits a match; no duplicate queue membership |
| L10 | **Cookie loser** | Reconnects deliberately without its previous cookie | Identity semantics: the token *is* half the block identity | Treated as a new client identity; a block recorded against the old token no longer applies on that dimension, while the IP dimension still does |
| L11 | **Cookie sharer** | Several concurrent connections deliberately present one cookie | Identity collision — a shared browser, or a copied token | Each connection gets its own session; no cross-session state; the shared token is a block dimension, never a session key |
| L12 | **Dead socket** | Traffic stops with no FIN and no RST, far longer than the heartbeat | Heartbeat and TTL cleanup for a connection the OS still believes is open | Session expires at the configured TTL, not before and not never; the partner is told; the queue entry is GC'd |
| L13 | **Gap talker** | Keeps sending while the *partner* is away with their seat held | D43: messages sent during the window are not buffered, because buffering would write message text to a Redis key (I8) | Nothing sent in the gap is delivered, then or later; the conversation still survives; the ack says `delivered: true` and means "accepted and routed" — see §7.1 |
| L14 | **Late returner** | Waits out the grace window, then presents its token | A stale token is the common case — every phone that slept for a minute — and must fail softly | A fresh `sessionId`, no error frame, no refused upgrade, and never somebody else's conversation. The partner's side was ended by the janitor when the window closed |
| L15 | **Token replayer** | Keeps a resume token, lets it be redeemed and rotated away, then presents the spent value | The token is a bearer credential and rotation is the whole defence | The replay buys nothing: a fresh session. A spent token that still worked would be a permanent key to somebody else's chat |

### P — protocol abuse

One bot per row, each expecting a specific refusal. These are cheap and they are
the ones that catch regressions in `validate.ts`.

| ID | Sends | Expects |
|---|---|---|
| P1 | Non-JSON text frame | `BAD_JSON`, strike |
| P2 | Valid JSON, wrong shape | `BAD_ENVELOPE` |
| P3 | `version: 2` | `UNSUPPORTED_VERSION` |
| P4 | `type: "call_start"` | `UNKNOWN_EVENT` |
| P5 | Binary frame | Refused; socket policy unchanged |
| P6 | Frame over `maxFrameBytes` | Close 1009 |
| P7 | `message` with no `id` | `BAD_ENVELOPE` |
| P8 | Same `id` twice in one match | First delivered, second `DUPLICATE_MESSAGE` (I14) |
| P9 | Same `id` in a *different* match | Accepted — dedupe is match-scoped |
| P10 | `payload.type: "image"` | `UNSUPPORTED_CONTENT_TYPE` |
| P11 | `payload.mediaId` present | `UNSUPPORTED_CONTENT_TYPE`, never silently dropped (§23.6) |
| P12 | Empty / whitespace-only text | `EMPTY_MESSAGE` |
| P13 | Ten malformed frames in a row | `TOO_MANY_INVALID_MESSAGES`, close 4003 |
| P14 | `join_queue` while `MATCHED` | `ALREADY_MATCHED` |
| P15 | `message` while `IDLE` | `NOT_MATCHED` |
| P16 | `leave_chat` while `IDLE` | No-op. "Ensure I am idle" is the documented meaning, so an error here is the bug |
| P17 | `skip` while `IDLE` | `queue_status{state:IDLE}`, not an error, and **not** a queue join — `lifecycle.skip` returns `idle` without re-queueing when there is no match |
| P18 | `report` while `IDLE` | `NOT_MATCHED` — there is no partner to name |
| P19 | `block` while `IDLE` | `NOT_MATCHED`, and nothing written to any block set |
| P20 | `leave_chat` twice | Both idempotent; state is `IDLE` after each |
| P21 | `skip` twice, the second after a new match formed | The second skip ends the *new* match; it must never reach back into the old one |
| P22 | `message` immediately after `skip` | `NOT_MATCHED` (the §10.8 race, arrived at deliberately) |
| P23 | `typing` after the match ended | `NOT_MATCHED`. Typing is unacknowledged *on success* but still errors when there is no partner (`server.ts:427`) — worth knowing, because a client that fires typing on a teardown race will see errors it did not expect |
| P24 | A report naming another conversation | **Not expressible.** `ReportPayload` is `{category, note}`; the conversation is resolved server-side. The test is that the field does not exist to abuse — if one ever appears, this row becomes a real scenario |
| P25 | Structurally valid JSON, enormous | Frame size limit enforced before parse cost; close 1009 |
| P26 | Unknown fields on every payload | **Accepted.** `validate.ts` rejects only `RESERVED_MEDIA_FIELDS`; other unknown fields are ignored, which is the forward-compatibility contract |
| P27 | Wrong field types (`text: 42`, `active: "yes"`) | `VALIDATION_FAILED` |
| P28 | `null` where a value is required | `VALIDATION_FAILED`, never coerced |

### R — races, run deliberately and often

These need the swarm because they need both sides under one controller.

| ID | Race | Expected |
|---|---|---|
| R1 | Both partners `skip` in the same tick | Both re-queue; exactly one match teardown; no ghost match |
| R2 | `message` sent as the partner skips | `NOT_MATCHED` on the sender — a deleted match cannot deliver (I6) |
| R3 | `block` while the partner is mid-send | Block recorded; in-flight message refused, not delivered |
| R4 | Partner disconnects during `tryMatch` | Stale queue entry GC'd by the next scan; searcher matched to someone else |
| R5 | Two bots skip into each other repeatedly | No livelock; the pair does not monopolise each other |
| R6 | Report filed as the match ends | Report stored against the right conversation, never orphaned |
| R7 | Reconnect exactly at session TTL | Either a clean `SESSION_GONE` or a clean new session; never both states at once |
| R8 | Both sides send simultaneously, repeatedly | Each message delivered exactly once, per-sender order preserved. Cross-sender order is not defined and is not asserted |
| R9 | `skip` lands in the same tick as an inbound `message_ack` | Either delivery completed before teardown, or a clean `NOT_MATCHED`. Never an ack for a match that no longer exists |
| R10 | `block` and `skip` issued together | Exactly one teardown; the block is recorded regardless of which won |
| R11 | `report` and disconnect together | Report is queued for persistence before the session is torn down, or refused. Never accepted and then lost |
| R12 | `join_queue` and `leave_queue` together | Deterministic final state, and it matches the last frame the server processed — not a coin flip between two writers |
| R13 | Two instances run `tryMatch` over the same candidates at the same instant | Exactly one match. This is the single strongest argument for the Lua-script design (CLAUDE.md rule 2), so it is run continuously, not once |
| R14 | A Pub/Sub event arrives after its match was torn down | Discarded by the receiving instance; never delivered to a client |
| R15 | A delayed message from a previous match arrives after a new one began | Never delivered into the new match — the match id on the record is what makes this decidable |

### C — chaos conditions, layered over any mix

| ID | Condition | Proves | Oracle |
|---|---|---|---|
| C1 | `docker pause postgres` for 60 s mid-run | **D16: a database outage is not a chat outage** | Breaker opens, spool fills, `chat_messages_delivered_total` slope unchanged; on resume the spool drains and the row count catches up to the ledger |
| C2 | Kill one of two backends | Cross-instance Pub/Sub routing, reconnect | Bots on the dead instance reconnect; conversations spanning instances either end cleanly or continue; no message delivered twice |
| C3 | Rolling restart | Graceful drain | `server_shutdown` received; bots reconnect; no `INTERNAL_ERROR` |
| C4 | Redis restart | Everything is gone by design | All bots get `SESSION_GONE`, recover to a working state, and the run continues rather than wedging |
| C5 | Retention set to 60 s | Deletion worker under live write load | Rows disappear on schedule; `chat_retention_deleted_total` moves; nothing under legal hold is touched |
| C6 | Queue overflow (retention queue capped small) | The write-behind path is lossy under overflow **by design** | Drops appear in `chat_retention_dropped_total` with a class label, and the DB shortfall equals the drop count exactly — no silent loss |
| C7 | Redis latency, 100–500 ms injected | Degraded Redis, which is worse than dead Redis: nothing fails over, everything just waits | Matchmaking and delivery latency track the injected delay and no more; no timeout cascade; no duplicate match from a retry |
| C8 | PostgreSQL latency | Database backpressure without a chat outage | Retention queue depth rises, breaker may open, `chat_delivery_latency_seconds` does not move |
| C9 | 1–5 % packet loss on the socket path | Resilience to ordinary bad networks | TCP absorbs it; no application-level duplicate or gap; latency degrades rather than the session dying |
| C10 | Intermittent connection resets | Recovery from an unstable network, which is what mobile is | Bots reconnect; no leaked sessions; the partner is told each time |
| C11 | Kill the instance holding the janitor leader lock | *Reframed:* there is no separate matchmaking process — matchmaking is a Lua script run by whichever instance received the frame. What **is** singular is the leader-locked janitor | The lock expires and another instance takes it; queue GC resumes; nothing is cleaned twice |
| C12 | Kill the instance running the retention/deletion worker | Same reframing: the worker is leader-locked inside a backend process, not a separate service | Chat continues on the surviving instance; the backlog drains once leadership moves; no row deleted twice |
| C13 | CPU throttle a backend container | Event-loop saturation — the failure mode the process metrics exist to catch | `chat_process_` event-loop lag rises first; backpressure engages before memory does; no silent message loss |
| C14 | Memory pressure on a backend | Graceful degradation rather than an OOM cascade across instances | Connection cap and backpressure refuse work before the process dies; if it dies, the other instance absorbs it and the run recovers |
| C15 | Redis latency **and** a PostgreSQL outage together | Combined dependency failure, where the write-behind path and the state path degrade at once | Chat still works: `/ready` reflects Redis only, and the breaker keeps the database out of the hot path |
| C16 | Kill a backend mid-conversation at high volume | Partial delivery at the moment of death | Every message is either acked and delivered, or not acked. No message acked and then provably never delivered to a live partner |

### D — data integrity

The reconciliation group. These are the scenarios the five oracles in §7 exist
to judge, expressed as things to actively cause rather than wait for.

| ID | Scenario | Proves | Oracle |
|---|---|---|---|
| D1 | The same envelope `id` reused after a reconnect | Dedupe scope is the *match*, not the session or the client | Accepted in a new match, refused inside the same one (I14). The scope is documented; this run proves the implementation agrees |
| D2 | An ack arrives after the bot has reconnected | Ack-to-session association | The old ack cannot mutate the new match's state — the new session has a different id and an empty pending map |
| D3 | A message accepted in the instant before the database fails | Write-behind durability at the seam | Either persisted, or counted in `chat_retention_dropped_total` / spooled. Never accepted, uncounted and absent |
| D4 | A conversation ends during a batch write | Transaction consistency at teardown | No half-created conversation: every `conversations` row is complete and has `ended_at` |
| D5 | A report filed while the deletion worker is running | Retention versus evidence | The report and the messages it references are not deleted underneath it; a legal hold protects them (§8) |
| D6 | A block recorded while retention deletes the conversation | Block outliving its evidence | The block persists — it keys on identity hashes, not on a conversation row, so deletion of the conversation must not affect it |
| D7 | The same message routed through two instances | Cross-instance delivery, not de-duplication of a broadcast | The partner's socket is owned by exactly one instance, so exactly one delivery. Two would mean the per-session channel is not the routing key it claims to be |
| D8 | Server restart after an ack but before persistence | What an ack actually promises | The ledger and the database disagree by exactly the in-flight queue depth, and the documented guarantee says that is allowed. This scenario exists to keep the promise honest, not to make it stronger |
| D9 | Retention boundary hit exactly at the expiry timestamp | Precision at the edge of a deletion window | Inclusive or exclusive, consistently, in both the query and the metric. Off-by-one here deletes evidence a day early or keeps it a day late |
| D10 | Retention configuration changed while conversations are live | D17: deadlines are stamped at insert time | Rows written before the change keep their original deadline. A config change must never retroactively extend the life of stored user data |

---

## 4. Mix profiles

A run picks one profile. Percentages are of total bots.

| Persona group | `realistic` | `adversarial` | `capacity` | `human` |
|---|---|---|---|---|
| N talkers | 55% | 25% | 70% | 55% |
| S skippers | 25% | 20% | 25% | 18% |
| L lifecycle, including resumption | 12% | 10% | 5% | 6% |
| G declared profile | 8% | 2% | 0% | 11% |
| A spam/abuse | 4% | 30% | 0% | 5% |
| M report/block | 3% | 12% | 0% | 4% |
| P protocol abuse | 1% | 3% | 0% | 0% |

`realistic` is the default and is the one whose latency numbers mean anything.
`adversarial` is for the safety questions and will show worse match latency —
correctly, because a third of the population is churning.

`human` is not a softer `realistic`; it is a differently shaped one, for the run
where a person is in the swarm. The proportions that make a five-thousand-bot
run statistically honest make a human's ten minutes mostly disappointing — they
meet a hyper-skipper, then a lurker, then somebody who rage-quits, and conclude
the product does not work. So the prompt repliers dominate, the declared
profiles are heavy because that is what a person looks at first, and the abusive
fraction is small but **not zero**: without somebody worth blocking, Block,
Report and the whole safety half of the UI go untried.

Every profile also runs the R races continuously in a small dedicated cohort:
races found by chance are not a test.

### E — load shapes

A mix says *who* is in the run. A shape says *how many, when*. They are chosen
independently: `realistic × E3` is a flash crowd of ordinary users, and
`adversarial × E5` is a spam wave during churn. Both are worth running, and
neither is expressible as a persona.

| ID | Shape | What it is for |
|---|---|---|
| E1 | 1k connected, steady, one hour | Baseline endurance. The run every other number is compared against |
| E2 | 1k → 5k → 10k → 20k, stepped | Where the transition costs are. Look for the step that moves latency non-linearly |
| E3 | 10k arriving inside 30 s | Flash crowd. Connection rate limiting, upgrade cost, `/ready` under a stampede |
| E4 | 10k leaving gradually | The cleanup side, which is never as well tested as the arrival side |
| E5 | 5k churning matches continuously | Matchmaking under sustained pressure rather than a burst |
| E6 | 80 % idle, 20 % active | The realistic connected-user profile. Idle sockets are not free, and this is what actually pays for them |
| E7 | 20 % long-haulers, 80 % short conversations | Session-duration distribution, which changes memory and TTL behaviour more than raw count does |
| E8 | A compressed daily cycle, repeated | Long-running state and retention behaviour across quiet and busy periods |
| E9 | 5× traffic spike *during* a chaos condition | Recovery under load — the realistic incident, where the surge and the failure arrive together |
| E10 | Sustained maximum supported population | Endurance and leak detection. Anything that grows monotonically here is a leak |

E1, E6 and E10 are the ones to run before believing any capacity number: a
capacity figure taken from a shape nobody experiences is a number about the load
generator's preferences.

---

## 5. Corpora

Plain text, one utterance per line, in `load-test/swarm/corpus/`. A bot draws
lines with its own seeded PRNG, so a run is reproducible from its seed.

| File | Used by | Notes |
|---|---|---|
| `openers.txt` | N, S | "hey", "asl", "anyone up" — the real first line of this product |
| `smalltalk.txt` | N | Statements and questions, mixed length |
| `replies.txt` | N | Short acknowledgements, so turn-taking looks like turn-taking |
| `questions.txt` | N | Draws a reply from the partner, which is what makes conversations last |
| `farewells.txt` | N, S4 | Ends a conversation the way a person does |
| `unicode.txt` | N4 | Emoji, CJK, RTL, combining marks, zero-width |
| `spam.txt` | A1, A2 | One line per campaign; A1 sends one line forever |
| `links.txt` | A3 | URLs, bare domains, IP literals, invite links |
| `contact.txt` | A4 | Emails, phones, handles, solicitations |
| `hostile.txt` | A7 | Aggressive but not gratuitous; enough to justify a report |

**Rule for the benign corpora:** no line may accidentally match a moderation
rule. A `smalltalk.txt` line containing "insta" would flag under
`social_handle` and quietly corrupt every precision number in the report. The
harness lints the corpora against `RULES` at startup and refuses to run if a
benign file matches — that check is cheap, and the alternative is a run whose
headline finding is an artefact.

---

## 6. What "identify the spam bots" means today, and the honest answer

The catalogue plants A1 and A2 as labelled serial spammers. Worth being explicit
about what the current system does with them:

* **Live moderation is per message.** `RULES` covers URLs, email, phone, social
  handles, invite links, crypto addresses, contact solicitation and a deny list,
  and nothing in the pipeline compares a message to anything the same sender
  said in a different conversation. That is a deliberate scope boundary, not an
  oversight, but it means the answer to "can we identify them" is currently
  *offline*.
* **Reports and blocks are the live signal.** A1 will accumulate blocks from
  M-personas. Whether that accumulation is *usable* is measurable by this
  harness.
* **The offline oracle is a query** over stored messages that groups repeated
  content across distinct conversations, and the run reports its precision and
  recall against the labelled roster. A2 exists to show its blind spot.

### 6.1 What the adversarial runs actually measured

The claim here used to be that grouping by the normalised moderation view would
catch a mutating campaign that exact hashing misses. Against labelled pattern
spammers it did no better than exact hashing. That is not a defect in it.
`moderationView` is built to prepare **one message for one pass of the rule
engine**, and its normalisation choices are correct for that job and wrong for
cross-message identity.

`load-test/swarm/src/campaign.ts` is a harness-side canonical form built for
the other job, and it did much better with no false positives in short runs. It
lives in the harness because it is a **proposal**, not shipped behaviour:
measuring it is the point, and shipping it is a separate decision with its own
false-positive budget.

**The design input, stated plainly:** a serial-spam detector cannot reuse the
moderation view. It needs a second canonical form whose only purpose is
cross-message identity, and the two must stay separate: one is read by rules
that need precision, the other by a grouping that needs recall.

#### Short runs flatter precision

The false-positive counts above came from short runs. A long run says something
very different: given enough conversations, many benign bots (and people) repeat
the same greeting, so a repetition count alone measures vocabulary size rather
than intent.

Two things follow, and only one of them is about the harness.

* **The harness one.** The oracle used to fail a run on this count, which meant
  it could not pass an endurance run (E10) however correct the server was. It
  now fails only on a **block durability violation**, which is a property of the
  server, and reports the false positives as the measurement they are.
* **The product one.** Anything built from §6.1's canonical form needs a second
  axis (volume, rate, or what fraction of a sender's output the repeated line
  is) before it can be pointed at real accounts.

### 6.2 What the live signals are worth

On the enforcement that exists today, the live controls did not stop the
labelled pattern spammers. Blocks and reports arrived quickly, but a block
protects the blocker and nobody else, so being blocked costs a spammer one
partner and changes nothing about its rate. Reporting and blocking are
per-victim controls being asked to solve a per-sender problem.

One caveat the harness owes the reader: the M personas decide what to report
using `looksAbusive`, which recognises the adversarial corpora directly. Real
users are slower, less consistent and less accurate, so the measured time to a
first report is **an optimistic bound**, not a forecast.

The deliverable from an `adversarial` run is therefore those measurements, plus
a statement of what a live detector would have to look like. That is a design
input, not a feature this harness should quietly build.

---

## 7. Verification — how a run passes or fails

A load test that only prints percentiles cannot fail for the reasons that
matter. The swarm ends with seven oracles, and any one of them failing fails the
run.

1. **Pair reconstruction (ledger).** Group every bot's events by `matchId`.
   For each conversation: what A acked with `delivered:true` is exactly what B
   received, in order, with identical text. Withheld messages appear on neither
   side. This is the delivery correctness proof and it needs no server access.

   ### 7.1 The one thing this oracle is allowed to forgive

   Since §28 the receiver's list is not always a *prefix* of the sender's: it
   can be the sender's list **with a hole in the middle**. Two acks do not mean
   what they appear to:

   * a message sent while the partner's seat was being held is accepted, routed
     at a session with no socket, and dropped — nothing is buffered (D43), and
     the ack still says `delivered: true`, because it has always meant "accepted
     and routed" rather than "arrived";
   * a message in flight when the socket dies is never acked at all, though the
     server may well have delivered it.

   Aligned by index, one missing message turns every message after it into a
   reported delivery bug. So the comparison walks both lists with two pointers
   and may skip **only** an unconfirmed send. Everything else is held to strict
   order with no tolerance at all. The report separates what this produced:
   *provably never delivered* (an unconfirmed send the receiver overtook) from
   *no proof either way* (an unconfirmed send at the end).

   "Unconfirmed" cannot be decided by the sender alone. It learns its partner is
   away from a frame that takes a round trip, and a message handed to the socket
   in that gap is acked `delivered: true` and carries no flag. So the oracle
   also reads the *partner's* ledger: each bot's `closed`/`connected` events
   bound the stretches when it had no socket, and anything acked inside one
   could not have arrived. That window gets 500 ms of lead tolerance, because a
   recorded close is when the bot noticed rather than when the socket became
   unusable. It is the only tolerance in this oracle.

   The first of those numbers is a product question rather than a bug, and it is
   in `docs/testing/SWARM-HANDOFF.md` §7.
2. **Metric conservation.** Scrape `/metrics` from every backend before and
   after. `messages_received == acks + rejected`. `matches_created × 2 ==`
   `matched` frames in the ledger. `retention_queued == flushed + dropped`.
   Gauges return to baseline: `chat_queue_depth → 0`, `chat_active_matches → 0`.

   Three things this oracle has to get right, each learnt the hard way:

   * **Counters must be diffed against a pre-run baseline.** The compose stack
     survives between runs, so reading counters only at the end attributes the
     previous run's totals to this one. A harness that can only be trusted on a
     cold stack will lie on the day somebody runs it twice.
   * **`chat_active_matches` and `chat_queue_depth` are cluster-wide values
     read with `max`, never summed.** They are one Redis cardinality, written by
     whichever instance holds the janitor's leader lock (`server.ts:96-102`);
     the follower's copy is frozen at whatever it last held. Summing adds a live
     value to a stale one and invents a leak. The shipped Grafana dashboard
     already uses `max()` for both.
   * **Cleanup is lazy, so gauges get a settle window rather than an
     assertion.** Queue entries are repaired by whatever scans them, so a
     non-zero depth immediately after the last socket closes is the design
     working. Scrape twice, at least two janitor intervals apart, and fail only
     on state that has *stopped* shrinking.
3. **Redis residue.** After drain: queue sets empty, no match hashes, no session
   hashes outside TTL, no orphaned `chat:blocks:*` beyond what the M-personas
   created. Leaked state here is the failure mode that only appears at scale.
   `chat:resume:*` and `chat:last_partner:*` are counted rather than asserted
   on: both are supposed to be non-zero while their windows run, and what would
   be worth noticing is a count that does not fall between runs.
4. **Profile agreement.** For every match, the declaration one bot sent on
   `join_queue` must be what the server echoed to it as `you`, and must be what
   the *other* side was shown as `partner`. A break in the first leg is
   validation or the session hash losing a field; a break in the second means a
   profile reached the wrong conversation, which in a product where the profile
   is the only thing one stranger knows about another is the serious one. Proved
   with hashes, so the ledger never holds a declared name.
5. **Database agreement.** Rows in `messages` equal the ledger's accepted count
   minus `chat_retention_dropped_total`, exactly. Every `conversations` row has
   an `ended_at`. Every `reports` row maps to a conversation the reporter was
   actually in. Retention deadlines are stamped at insert time (D17) — a row
   written before a config change keeps its original deadline.
6. **Safety invariants.** Grep the whole run's backend logs for any message body
   or report note drawn from the corpora. **Zero matches required.** The corpus
   lines are known strings, which makes this the only end-to-end test of
   invariant I8 that exists — the logger denylist checks field names; this
   checks reality.

7. **Spam detection and block durability.** The ground-truth question, and the
   only oracle whose answer is a measurement rather than a verdict: how many of
   the bots labelled `spammer` before the run would be caught, by which
   canonical form, and how many strangers they reached anyway. It also holds the
   durability half — a *confirmed* block must never be followed by another match
   between the same pair. §6 is the whole discussion.

Oracle 6 is the one worth building first. It is the cheapest, and it tests the
rule this repository treats as non-negotiable.

**And it is currently the weakest, for a good reason.** The backend emits
roughly five log lines during a 5,000-bot run: it logs nothing per message,
which is exactly the hygiene invariant I8 asks for. So the check has almost no
surface to search, and a pass means "no leak on the paths that did log" rather
than "no leak anywhere". The oracle prints its own coverage — the number of log
lines it actually searched — instead of reporting a confident green against an
empty file. Making it strong needs a deliberately chatty run mode, which is
worth building before trusting it.

---

## 8. Proposed harness shape

```
load-test/
  websocket.js              unchanged; k6 capacity smoke
  swarm/
    package.json            ws, pg, ioredis, tsx
    src/
      run.ts                orchestrator: roster, ramp, chaos schedule, verdict
      worker.ts             one process, N sockets; scaled to CPU count
      bot.ts                protocol client: cookie, XFF identity, heartbeat, acks
      rng.ts                seeded PRNG — a run is reproducible from its seed
      personas/*.ts         one file per persona above
      corpus/*.txt
      ledger/               NDJSON per worker, merged at the end
      oracles/              ledger.ts metrics.ts redis.ts postgres.ts logs.ts
      report.ts             per-scenario pass/fail, plus the two spam numbers
```

Notes on the shape:

* **TypeScript, importing `backend/src/protocol/types.ts` as types only.** The
  swarm then fails to typecheck the moment the protocol changes, which is the
  same guarantee `verify-protocol.mjs` gives the frontend. A load test that
  silently tests last month's protocol is worse than none.
* **Multi-process.** One Node process holds a few thousand sockets before the
  event loop becomes the bottleneck and the harness starts measuring itself.
  Workers are separate processes; the orchestrator owns the roster and the
  ledger merge. Bots that must meet each other (S3, M3, R-races) are pinned to
  the same worker.
* **The harness must not be the bottleneck.** It records its own event-loop lag
  and refuses to publish latency numbers from a run where its own lag exceeded a
  threshold. Otherwise the first "regression" found is the load generator.
* **Chaos is scheduled, not manual.** C1–C6 are entries in the run plan with a
  time offset, executed through the Docker socket, so a run is one command and
  is reproducible.
