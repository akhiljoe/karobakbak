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
| Backend unit (41 files) | `npm test` | nothing | yes, every push |
| Frontend unit (12 files) | `npm run test:frontend` | nothing | yes, every push |
| Backend integration (33 files) | `npm run test:integration` | Redis + PostgreSQL | yes, own job |
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
| N — conversation | 9 | 10 | swarm |
| S — matchmaking | 5 | 11 | swarm |
| A — abuse | 14 | 14 | swarm |
| M — moderation response | 10 | 10 | swarm |
| G — declared profile | 4 | 4 | swarm |
| L — lifecycle | 10 | 15 | swarm |
| **P — protocol abuse** | **28** | 28 | `tests/integration/protocol-abuse.test.ts` |
| **R — races** | **10** | 15 | `tests/integration/races.test.ts` |
| **C — chaos** | **4** | 16 | swarm + `docker-compose.sentinel-app.yml` |
| **D — data integrity** | **3** | 10 | `tests/integration/retention-integrity.test.ts` |
| E — load shapes | **2** (E6 `--profile idle`, E1/E10 `--profile endurance`) | 10 | swarm |

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
3. **The remaining D rows (7 of 10).** D1-D4 and D6-D8. D3 (a message accepted
   in the instant before the database fails) and D8 (restart between ack and
   persistence) are the two that keep the durability promise honest.
4. **The remaining R rows (5 of 15).** R3, R6, R7, R8, R9, R11.
5. **S and L tails, and N9.** The least interesting of the lot.

---

## Chaos, in detail

The group with the worst ratio and the best track record.

| ID | Scenario | Status |
|---|---|---|
| C1 | Pause PostgreSQL mid-run | **Done.** Delivery held at 43.5 msg/s while paused. Found F-031 and F-032 |
| C2 | SIGKILL one of two backends | **Done.** Survivor absorbed the population, no step in client lag |
| C3 | Graceful shutdown | **Done**, though not by the swarm — `server_shutdown` is asserted in `operations.test.ts` and `server.test.ts`, the `holdSeat: false` drain in `lifecycle.test.ts`, and draining health in `operations.test.ts` |
| C-Redis | Sentinel failover under load | **Done.** 0 backend restarts, ~11.2s unavailable, 346 message positions agreed |
| C4 | Network partition between backends, Redis up | not started — and close to a no-op by design: backends never talk directly, all coordination is Redis Pub/Sub |
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
