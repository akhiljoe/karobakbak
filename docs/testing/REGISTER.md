# The test register

What is covered, what is not, and where each thing lives. This is the agenda:
open the file, read the counts, pick the largest gap that matters.

It is maintained by hand, and that has already been wrong once — the swarm
handoff recorded the R group as having no coverage while four of its rows were
already tested under names describing the behaviour rather than the row number.
**A coverage number here is a claim like any other. Check it before relying on
it.**

Read `docs/testing/README.md` for how to run any of this,
`docs/testing/RESULTS.md` for what happened when it ran, and
`docs/testing/LAUNCH-GATE.md` for the claims each of these defends.

---

## Where the tests live

| Suite | Command | Needs | Runs in CI |
|---|---|---|---|
| Backend unit (44 files, 882 tests) | `npm test` | nothing | yes, every push |
| Frontend unit (12 files) | `npm run test:frontend` | nothing | yes, every push |
| Backend integration (33 files, 626 tests) | `npm run test:integration` | Redis + PostgreSQL | yes, own job |
| Protocol drift + pending policy | `npm run verify` | nothing | yes |
| Supply chain | — | — | yes, own job |
| Load and chaos (the swarm) | `npm run swarm -- …` | the load stack | no |
| Security probes | `npm run security:probe` | a running stack | no |
| Log hygiene | `npm run verify:logs` | a running stack with Loki | no |
| Redis failover | `npm run sentinel:up` then the swarm | its own stack | no |
| Regression against a baseline | `npm run swarm -- … --compare` | the load stack | no |

The bottom four need a running system and are deliberately outside CI. They are
the ones most likely to go stale, and `RESULTS.md` records when each last ran.

---

## The scenario catalogue

143 rows in `docs/LOADTEST-SCENARIOS.md`. Several groups have moved out of the
swarm into the integration suite, and the "where" column says so — they were
catalogued as load scenarios and are not: one client and one expected refusal
does not need load, and a test that needs no load should run on every push.

| Group | Covered | Catalogued | Where |
|---|---|---|---|
| N — conversation | **10** | 10 | swarm |
| S — matchmaking | **7** | 11 | swarm; S9 is `--profile tiny` |
| A — abuse | 14 | 14 | swarm |
| M — moderation response | 10 | 10 | swarm |
| G — declared profile | 4 | 4 | swarm |
| L — lifecycle | **12** | 15 | swarm; L5 and L11 in the unit and integration suites |
| **P — protocol abuse** | **28** | 28 | `tests/integration/protocol-abuse.test.ts` |
| **R — races** | **15** | 15 | `tests/integration/races.test.ts`; R8 by the swarm's pair-reconstruction oracle |
| **C — chaos** | **4** | 16 | swarm + `docker-compose.sentinel-app.yml` |
| **D — data integrity** | **10** | 10 | `retention-integrity.test.ts`, `races.test.ts`, `queue-conservation.test.ts` |
| E — load shapes | **2** (E6 `--profile idle`, E1/E10 `--profile endurance`) | 10 | swarm |

**R8 is credited to the swarm rather than to a test**, and that is the honest
placement: "each message delivered exactly once, per-sender order preserved" is
precisely what the pair-reconstruction oracle checks, across every conversation
in a run — 96,400 message positions in the 400-bot run, 346 in the Sentinel
failover. A dedicated unit test would be a weaker version of a check that
already runs at scale.

### What is genuinely missing, in the order worth doing it

1. **The remaining C rows (12 of 16).** C4 network partition, clock skew, Redis
   memory pressure to eviction. Chaos is where every product bug in this
   repository has come from — F-031 and F-032 both came out of C1, and nothing
   else had ever made the spool engage under load.
2. **The E group (load shapes), 2 of 10.** E6 is done and produced the first
   honest per-connection cost — an idle socket is ~9 KB and one file descriptor.
   `--profile endurance` exists for E1 and E10 and **has not been run for long
   enough to mean anything**: a leak is what an hour shows and a two-minute run
   cannot. E2's steps and E3's stampede need arrival-shape machinery the swarm
   does not have.
3. **The six rows that are shapes or need harness machinery.** Named
   individually below rather than left as a count, because each is a different
   kind of "not done".

### The rows deliberately left, and why

| ID | Row | Why it is not a test |
|---|---|---|
| S3 | Picky pair — fairness, nobody starved by `SRANDMEMBER` | Needs a long run with a stated per-bot match band. The property is real; asserting it at two-minute scale would measure the sampler's luck |
| S8 | Unmatchable — blocked by every eligible partner | Needs a pre-blocked roster, which means a setup phase the harness does not have. The *cost* half — `blockedSkipped` rising while Redis calls per attempt do not — is the interesting part and is the harder half |
| S10 | Queue surge | This is `--ramp`, which exists. Kept as a row rather than a persona because it is a shape |
| S11 | Matchmaking churner | Behaviourally S1 run for longer. A separate persona would be a duplicate with a different name |
| L7 | Thundering herd — 500 connections in 2s | A shape, and `--ramp 1` at scale is it. E3 is the same row from the other direction |
| L8 | Reconnect storm | Needs an arrival shape the swarm cannot express; the closest thing is the `lifecycle` profile run large |
| L12 | Dead socket — no FIN, no RST | Needs a socket that stops without closing, held past the session TTL. Minutes of wall clock per assertion; the TTL path itself is covered by the janitor tests |

None of these is unreachable. Each needs either a run measured in tens of
minutes or a piece of harness machinery, and saying so is more useful than a
count that implies they are all the same size of task.

---

## Chaos, in detail

The group with the worst ratio and the best track record.

| ID | Scenario | Status |
|---|---|---|
| C1 | Pause PostgreSQL mid-run | **Done.** Delivery held at 43.5 msg/s while paused. Found F-031 and F-032 |
| C2 | SIGKILL one of two backends | **Done.** Survivor absorbed the population, no step in client lag |
| C3 | Graceful shutdown | **Done**, though not by the swarm — `server_shutdown` is asserted in `operations.test.ts` and `server.test.ts`, the `holdSeat: false` drain in `lifecycle.test.ts`, and draining health in `operations.test.ts` |
| C-Redis | Sentinel failover under load | **Done.** 0 backend restarts, ~11.2s unavailable, 346 message positions agreed |
| C4 | Network partition between backends, Redis up | **Resolved as a no-op, and guarded.** There is no channel between backends to partition — `tests/unit/no-instance-addressing.test.ts` asserts no outbound HTTP outside the OIDC seam and that routing is by session channel. If it ever fails, C4 becomes a real scenario |
| — | Clock skew on one instance | **Done.** The sharp case is app-clock stamps versus database-clock checks; measured as `chat_clock_skew_seconds` and alerted above 5 minutes |
| — | Redis memory pressure to eviction | **Done, and it found F-044** — a total outage that passes every health check |
| — | The other nine catalogued C rows | not started |

---

## Security

| Axis | Status | Where |
|---|---|---|
| Live abuse probes | 11 probes, 9 pass / 1 measures / 1 skips | `security-test/` |
| Protocol fuzzing | 6 properties, ~13k generated frames | `tests/unit/validate-fuzz.test.ts` |
| Protocol abuse (the P group) | 28 rows | `tests/integration/protocol-abuse.test.ts` |
| Supply chain | audit + gitleaks + lockfile drift | `.github/workflows/verify.yml` |
| Active scanning (ZAP / nuclei) | **not done** | — |
| Console authorisation matrix | probe written, **never run** | `security-test/`, skips without `--console` |

The last two are the honest gaps. EDGE-1 to EDGE-4 cover the header and
misconfiguration surface that a scanner would mostly be for, with checks that
know what these headers are supposed to say; what is missing is a scanner's
breadth. The console probe needs a run that starts the console, which the load
stack does not.

---

## Observability

Every declared metric is charted or ruled on — 89 of 89, asserted by
`metrics-wiring.test.ts` for existence and by hand for coverage.

| Deck | Default range | Panels |
|---|---|---|
| Health (`karobakbak-overview`) | 1h | 29 |
| Product (`karobakbak-product`) | 7d | 17 |
| Cost (`karobakbak-cost`) | 30d | 12 |
| Safety (`karobakbak-safety`) | 24h | 12 |
| Logs (`karobakbak-logs`) | 1h | 6 |

Traces are in Tempo, off by default (`TRACING_ENABLED`). The WebSocket message
path is deliberately not traced — see `src/tracing/index.ts` for why.
