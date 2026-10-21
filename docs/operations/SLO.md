# Service level objectives

**Status: proposed. Every number below is a recommendation for the operator to
accept, change or reject.** Nothing here is currently committed to anybody,
internally or publicly, except the two statutory clocks in §7 — which are already
published and are not negotiable.

**Read `docs/testing/RESULTS.md` first if you want to argue with a number.**
Every target here is anchored to something that was measured on the real stack,
and where it is not, it says so.

---

## Contents

1. [Why this document exists](#1-why-this-document-exists)
2. [What is deliberately not an objective](#2-what-is-deliberately-not-an-objective)
3. [The unit of measurement](#3-the-unit-of-measurement)
4. [The objectives](#4-the-objectives)
5. [Error budgets, and why there is not one yet](#5-error-budgets-and-why-there-is-not-one-yet)
6. [Alert coverage — which alert defends which objective](#6-alert-coverage--which-alert-defends-which-objective)
7. [The statutory clocks, which are not SLOs](#7-the-statutory-clocks-which-are-not-slos)
8. [What cannot be measured today](#8-what-cannot-be-measured-today)
9. [Review](#9-review)

---

## 1. Why this document exists

**There are 32 alert rules and no stated objective.** `monitoring/prometheus/alerts.yml`
carries 13 at `severity: page` and 19 at `severity: ticket`, each with a
threshold somebody picked. Without an objective, every one of those thresholds is
unarguable: there is no way to say a number is too tight except by being woken
by it, and no way to say it is too loose except by missing an outage.

That is the whole purpose here. Not process for its own sake — this is a service
with one operator and no revenue, and a formal SLO practice would be
theatre — but **a written answer to "how good is good enough", so a threshold can
be defended or moved on evidence.**

Three facts shape every number below and should be read before any of them:

- **There is one host, one Redis, one backend replica.** Redis Sentinel is built
  and drilled but not switched on (`ARCHITECTURE.md` §5.1). Availability targets
  that assume redundancy would be fiction.
- **There is one operator**, who sleeps. Anything that pages at 3am is a
  commitment that person is personally making.
- **Chatting is free.** Nobody is owed a refund. That does not make the service
  unimportant — a report that nobody reads is a safety failure whatever it cost —
  but it does mean availability is not the most important thing on this list.

---

## 2. What is deliberately not an objective

Stated first, because it is the shorter list and it prevents the obvious
mistakes.

**No objective counts a refusal.** A one-sided saved connection, an ignored
reconnect request, a request stopped by a block: each is a private decision, and
an aggregate of them turns it into an operational statistic. That rule predates
this document — `metrics/registry.ts` records it — and it is not relaxed here.

**No objective is set on moderation accuracy.** There is no ground truth. The
eight rules are deterministic and testable; whether they were *right* about a
given message is a judgement, and a false-positive rate computed against nothing
is a number that would be believed.

**No objective is set on how many people are online.** Presence is hidden below
100 and never faked (D21). A target on it would create an incentive the wire
format was specifically built to resist.

**No availability objective covers a deliberate deploy.** A graceful shutdown
closes every socket, and the client reconnects with jittered backoff. That is
user-visible and it is *correct behaviour* — counting it as downtime would make
the number argue against deploying, which is the opposite of what it should do.
Deploys are counted separately in §4.1.

---

## 3. The unit of measurement

**One session, one search.** This matters more than it sounds: `ARCHITECTURE.md`
§21.3 records that a funnel assembled from `chat_connections_total` and
`chat_matches_created_total` is a ratio across three denominators — sockets
including resumptions, versus pairs — and is wrong in a direction no graph shows.
`chat_funnel_total` exists precisely to keep the unit consistent.

Every objective below names the metric it is computed from, and none of them
mixes those denominators.

**Window:** a calendar month, evaluated on the 1st. Short enough that a bad month
is actionable, long enough that a single incident does not consume the whole
target.

---

## 4. The objectives

### 4.1 Reachability — a browser can open a socket

**SLI.** The proportion of scrape intervals in which at least one backend is up
and `/ready` is green.

```
  1 - ( time with no ready backend  /  total time )
```

Measured from `up{job="karobakbak-backend"}` and the readiness the load balancer
sees. `/ready` reflects **Redis, not PostgreSQL** — a backend with a dead
database still serves chat correctly and must stay in rotation.

| | |
|---|---|
| **Proposed target** | **99.0% monthly** — about 7h 12m |
| **Stretch, once Sentinel is on** | 99.5% — about 3h 40m |
| **Not proposed** | 99.9%. It is 43 minutes a month, and a single unplanned Redis restart plus one bad deploy exceeds it. Publishing a number you cannot hold is worse than publishing a modest one |

**Why 99.0% and not higher.** The whole service depends on one Redis with
persistence off, on one host. `ARCHITECTURE.md` P1 ranks that Critical. A target
above 99% is a promise about hardware that has not been bought.

**What is excluded:** graceful deploys. Track those separately — *deploys per
month* and *seconds of socket unavailability per deploy* — rather than letting
them consume an availability budget.

**Measured evidence.** A Redis failover, drilled under load, cost **~11.2 seconds**
during which every backend left the load balancer together, with 0 backend
restarts and 346 message positions agreeing across 113 conversations. So the
cost of the *protected* failure is about eleven seconds; the cost of the
unprotected one is however long it takes a person to notice and act.

---

### 4.2 Matchmaking — a stranger is found quickly

**SLI.** `chat_matchmaking_latency_seconds`, which measures from the search
starting to the `matched` frame reaching that socket. It is the product's
headline indicator.

| | |
|---|---|
| **Proposed target** | **p99 under 2s, when at least two people are searching** |
| **Measured at 1,000 concurrent** | p99 **428 ms** |
| **Measured at 2,000 concurrent** | p99 **1,617 ms** |

**The qualifier is the whole objective.** Time-to-match is dominated by whether
anybody is *there*, not by how fast the server is. A quiet Tuesday will show
minutes, and that is not a defect. So the objective is conditional on queue
depth, and the honest reading of the metric on a small population is "this
mostly measures demand".

**This is why the 2,000-user reading matters.** At 2,000 concurrent on 1 vCPU the
p99 is already 1.6s and the containers wanted 125.6% of one core — so the target
is met at 1,000 and marginal at 2,000. **The knee, not the target, is the thing
to watch**: it sits between 1,000 and 2,000, and the answer is vCPU.

---

### 4.3 Message delivery — a message reaches the other person

**SLI.** The proportion of accepted messages whose delivery route was not
`dropped`, from `chat_messages_delivered_total`.

```
  sum(rate(chat_messages_delivered_total{route!="dropped"}[5m]))
    / sum(rate(chat_messages_delivered_total[5m]))
```

| | |
|---|---|
| **Proposed target** | **99.5% monthly** |

**Read the definition carefully, because the ack does not promise delivery.**
`message_ack` has always meant "accepted and routed", never "received" (D14).
`dropped` here means the message was routed at a session whose socket was gone —
which under §28 is an ordinary state lasting tens of seconds, not an error.

**A permanent floor exists and should not be optimised away.** Messages are not
buffered while a partner is away (D43) — buffering would write message text to a
Redis key, which I8 forbids without exception. So some drops are the design
working. 99.5% leaves room for that; a target of 100% would be a request to
break a safety rule.

---

### 4.4 Message latency — the conversation feels live

**SLI.** `chat_delivery_latency_seconds`, and the client-observed ack time the
swarm records.

| | |
|---|---|
| **Proposed target** | **ack p99 under 500 ms** |
| **Measured at 1,000 concurrent** | p50 10 ms · p95 90 ms · **p99 150 ms** |
| **Measured at 2,000 concurrent** | p50 55 ms · p95 314 ms · **p99 598 ms** |

**So the target is met at 1,000 and missed at 2,000**, on 1 vCPU. That is not a
reason to loosen it — it is the capacity signal, and it fires before users
complain.

**Beware the harness.** A saturated swarm reports a server problem, confidently:
the same 2,000 bots gave ack p99 **1,261 ms** on the default worker count and
598 ms on `--workers 6`. The first reading was twice as bad as the truth and
named the server. Above ~2,500 bots the harness dies before the server degrades.

---

### 4.5 Safety evidence — a report and its transcript survive

**SLI.** P0 retention records dropped.

```
  increase(chat_retention_dropped_total{class="p0"}[30d])
```

| | |
|---|---|
| **Proposed target** | **zero, every month. This is a hard objective, not a percentage** |

**Why zero and why it is credible.** A report the system could not record is
*refused rather than acknowledged* — the user is told to retry, because telling
somebody asking for help that their report was filed when it was not is the one
lie this system refuses to tell (§14.3). The retention path is write-behind and
lossy under overflow *by design*, so this objective is what bounds "by design"
into "and it has not actually happened".

**It has happened.** F-032 cost **1,350 P0 records in a single chaos run**, when
one message whose conversation row had not landed yet destroyed every record
sharing its batch. Both write paths now narrow to individual rows. A non-zero
month means that class of bug is back.

Defended by `SafetyRecordsDropped` and `SafetyEvidenceDropped`, both `page`.

---

### 4.6 Retention — data past its deadline is actually deleted

**SLI.** `chat_retention_backlog`, the count of rows past `retention_expires_at`
that still exist.

| | |
|---|---|
| **Proposed target** | **backlog returns to zero within 2 hours, every day** |

**This is a promise made in a published document**, not an internal nicety: the
privacy policy states a retention period, and a policy that only exists in
configuration is a promise nobody keeps (I10).

**The metric is deliberately not zero-initialised**, and the panel says so.
`publishBacklog` refuses to publish a sample that never succeeded — a zero
backlog from a monitor that could not read the database is the most reassuring
thing this process could wrongly claim. **Empty means never sampled, not nothing
overdue.**

Defended by `RetentionBacklogGrowing` (ticket, 2h) and `RetentionDeletionFailing`
(page).

---

### 4.7 Recoverability — the backups are real

**SLI.** Two, because they fail differently.

| | |
|---|---|
| **Freshness** | A successful backup observed within the configured window. Target: **every day** |
| **Restorability** | A restore drill completed against a clean host. Target: **once per quarter, minimum** |

**The second one is the one that matters, and it is the one nobody does.** F-049
was found *by running the restore drill rather than by reading anything*: a
carriage return in a passphrase file, invisible, which made every archive
undecryptable on a clean host while every local drill passed — because backup and
restore read the same file. An archive written minutes earlier was provably
unrecoverable.

**A backup that has never been restored is a hypothesis.** `BackupsStale` and
`BackupsNeverObserved` defend freshness. Nothing defends restorability, and
nothing can — it is a calendar commitment.

---

### 4.8 Capacity — refusals are rare and visible

**SLI.** Connections refused at capacity.

```
  increase(chat_connections_rejected_total{reason=~"at_capacity.*"}[30d])
```

| | |
|---|---|
| **Proposed target** | **zero refusals at capacity in a normal month.** Any is a scaling signal, not a bug |

**Headroom is the leading indicator**, not the refusal.
`chat_connections_active / chat_connections_limit` crossing ~0.8 should be a
ticket long before anybody is refused; `ConnectionHeadroomLow` already does this
and `RefusingConnectionsAtCapacity` pages.

**Two things to keep in mind when reading these.** The reserve comes *out of* the
ceiling rather than extending it, so cold arrivals are refused at
`limit - reserved` — a dashboard that plots against `limit` alone is wrong by
exactly that much, which is why `chat_connections_reserved` is published beside
it. And a browser never sees the 503 anyway; it gets close code 1006, so the
refusal is only visible here and via `/api/capacity`.

---

## 5. Error budgets, and why there is not one yet

**A formal error budget would be theatre here, and adopting one would make this
document less honest rather than more.**

An error budget is a *currency*: you spend reliability to buy release velocity,
and the policy is what you stop doing when it runs out — freeze deploys, divert
to hardening. That trade needs two things this service does not have: a release
cadence somebody is pushing against, and more than one person to divert.

What is proposed instead, and is achievable:

- **A monthly reading.** Take the eight numbers above on the 1st. Write them
  down. Ten minutes.
- **One rule with teeth.** *If §4.5 (safety evidence) or §4.6 (retention) misses,
  nothing else ships until it is understood.* Those two are promises to users and
  to a regulator; the others are quality.
- **Revisit when there is revenue.** A paid tier changes this — availability
  becomes something owed rather than offered, and an error budget starts to mean
  something.

---

## 6. Alert coverage — which alert defends which objective

All 33 rules in `monitoring/prometheus/alerts.yml`, mapped. **This mapping is
the point of the document**: an alert that defends no objective is a candidate to
delete, and an objective with no alert is a candidate to instrument.

| Objective | Alerts defending it |
|---|---|
| §4.1 Reachability | `BackendDown` · `BackendAbsent` · `SessionsFailingToOpen` · `RedisApproachingMaxMemory` · `EventLoopLagHigh` |
| §4.2 Matchmaking | *(none — see below)* |
| §4.3 Delivery | *(none — see below)* |
| §4.4 Latency | `EventLoopLagHigh` only, indirectly |
| §4.5 Safety evidence | `SafetyRecordsDropped` · `SafetyEvidenceDropped` · `DatabaseCircuitOpen` · `SpoolNearCapacity` · `SpoolNearByteCapacity` · `StorageNotReachingSteadyState` |
| §4.6 Retention | `RetentionBacklogGrowing` · `RetentionDeletionFailing` |
| §4.7 Recoverability | `BackupsStale` · `BackupsNeverObserved` |
| §4.8 Capacity | `ConnectionHeadroomLow` · `RefusingConnectionsAtCapacity` |
| §7 Statutory clock | `ReportsWaitingTooLong` |
| **The alerting path itself** | `AlertmanagerAbsent` · `AlertNotificationsFailing` |
| **Safety signals, not objectives** | `AgeBelowMinimumDeclarations` · `PersonaCrisisHandled` · `PersonaMinorSignal` |
| **Cost, not reliability** | `CostPerConversationRising` · `PersonaBudgetNearCeiling` · `PersonaBudgetExhausted` · `PersonaEnabledWhileExhausted` · `PersonaNeverCachingPrefix` |
| **Persona health** | `PersonaProviderFailing` · `PersonaFillPolicyStalled` |
| **Correctness of the measurement** | `ClockSkewAgainstDatabase` · `SignInFailing` |
| **A daily summary, not an alert** | `DailyChatSummary`: an `info` notification once a day with approximate counts, so silence means nobody chatted rather than nothing being watched |

### Two objectives have no alert, and both should

- **§4.2 matchmaking latency** — there is a histogram and three dashboard panels,
  and nothing pages. A conditional alert is genuinely awkward (the metric mostly
  measures demand on a small population), which is probably why it does not
  exist. **A `p99 > 5s while queue depth > 5 for 15m` ticket would be defensible.**
- **§4.3 delivery success** — `chat_messages_delivered_total{route="dropped"}`
  is recorded and nothing watches its ratio. **A ticket on a sustained drop rate
  above 2% would catch a routing regression that no other alert sees.**

### Alerts that defend nothing on this list

`PersonaProviderFailing` and `PersonaFillPolicyStalled` are the honest ones to
keep despite that, and the reason is in `ARCHITECTURE.md` §20: the model provider
is **the failure that does not look like a failure**. Personas fall back to a
scripted voice, spend stays near zero, and the only symptom is a stranger who
ignores every question. An alert is the only thing that would ever notice.

**Note that seven of the 33 alerts watch subsystems that are switched off**
(personas, cost). They cost nothing while silent, but a reader should not mistake
their existence for the feature running — see `ARCHITECTURE.md` §5.2.

---

## 7. The statutory clocks, which are not SLOs

**These are legal commitments, already published, and they are not targets to be
missed 1% of the time.** They are listed here because they are response-time
objectives and this is where somebody will look for them.

| Commitment | Clock | Where it comes from |
|---|---|---|
| **Acknowledge a grievance** | **24 hours** | Terms §18. India's IT Rules appear to require a published grievance mechanism. **Automatable** |
| **Resolve a grievance** | **15 days** | Same. **A human commitment, not automatable** |
| **Act on a takedown order** | short statutory windows | IT Act / IT Rules, arriving at `abuse@`. Acting inside them is part of the s.79 safe-harbour diligence |
| **Change notice** | 14 days in-product | Privacy policy, terms §12 |

**`chat_report_queue_oldest_seconds` and `chat_report_response_target_seconds`
exist for the first of these**, and `ReportsWaitingTooLong` pages when the first
exceeds the second. That is the only clock the running system can see.

**The other three are unmonitored inboxes.** An unread inbox does not fail
loudly. And there is a structural problem behind all of them, recorded as
`ARCHITECTURE.md` P15: **the moderation console has no container in any compose
file.** The system can therefore alert that reports are ageing past a published
commitment while offering no deployed way to work them.

---

## 8. What cannot be measured today

| Gap | Why it matters |
|---|---|
| **The funnel is blind before the socket opens** | Nothing about the age gate reaches the server (D34), deliberately. So how many people see it and leave is not measurable, and never will be under the current privacy position. It is the cost of that position, and it is accepted |
| **Traces are off** | `TRACING_ENABLED` defaults false and no production file sets it, while Tempo runs anyway. Any latency objective that would be diagnosed with a trace currently cannot be |
| **No client-side telemetry** | The browser makes no third-party requests, by policy. Client-observed latency is only available from the load-test swarm, never from real users |
| **Restorability has no metric** | §4.7 second half is a calendar commitment. Nothing can measure a drill that was not run |
| **Capacity readings above ~2,500 concurrent are extrapolation** | The harness dies before the server degrades, and this is labelled as an assumption wherever it appears |
| **`TRUST_PROXY_HOPS` correctness is a fact about topology** | It can be measured (`npm run security:probe`) but not asserted. A wrong value silently corrupts every per-IP objective and limit |

---

## 9. Review

**Every six months, or when any of these changes:**

- Redis Sentinel is switched on → revisit §4.1, raise the target.
- A second backend replica or a second host arrives → revisit §4.1 and §4.8.
- Payments launch → availability becomes owed rather than offered. Revisit §5;
  an error budget starts to mean something.
- The EEA or the US opens → §7 gains rows, and they will be stricter.
- The knee moves (a bigger box) → re-measure §4.2 and §4.4 rather than assuming
  they scale.

**Do not tune a threshold without moving the objective it defends, or the number
stops meaning anything.** That is the failure this document exists to prevent.

---

*Companion to `docs/operations/OPERATIONS.md` §7–§7c, which is how to work the
alerts, and to `docs/testing/RESULTS.md`, which is where every measured number
here comes from.*
