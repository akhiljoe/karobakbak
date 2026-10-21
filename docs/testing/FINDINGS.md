# Findings — the action plan

Every F-numbered finding, its status, and what is left to decide. The full
write-up of each lives in `docs/testing/BUGS.md` and `docs/testing/DEEP-CODEBASE-AUDIT.md`; this
is the index and the decision list.

**The accepted findings are the valuable half.** A bug that was found,
understood and deliberately not fixed is the thing most likely to be
rediscovered from scratch in six months — and rediscovered without the reasoning
that made it acceptable.

---

## Open — needs a decision, not code

| ID | Finding | The decision |
|---|---|---|
| F-042 | A structurally broken frame is answered `UNSUPPORTED_VERSION`, not `BAD_ENVELOPE` | Reorder two checks in `validate.ts`, or change the catalogue. An error code is wire contract, so this is a protocol decision |
| F-043 | `join_queue` while already matched is answered with silence | Distinguish the race from a deliberate re-join and answer `ALREADY_MATCHED` only for the second, or accept the silence and change the catalogue |

Both were found by the P group and both are low severity. Neither is safe to
"just fix" without deciding what existing clients see.

## Open — needs work

| ID | Finding | What is left |
|---|---|---|
| F-044 | When Redis refuses writes the service cannot open sessions while `/ready` still reports healthy | Logging and alerts are fixed. Still open: `/ready` checks reachability rather than writability, and the base and production compose files set no Redis `maxmemory`, which is a deployment decision |

## Fixed

| ID | Finding | Fixed in |
|---|---|---|
| F-033 | Redis is a single point of failure | `REDIS_SENTINELS`, drilled under load (`operations/OPERATIONS.md` §17.3). Fixed in code; a second host for the replica is an operational decision, listed under Accepted |
| F-045 | 109 settings documented, settable, and reaching nothing | Phase 38: `env_file:` on the services that read `config.ts`, guarded by `scripts/verify-config.mjs` |
| F-049 | A carriage return in a backup secret file, which is invisible and silently destroys recoverability | **Found by running the restore drill rather than by reading anything.** A secret written on Windows (`openssl rand ... > ops/backup/passphrase` in Git Bash) is CRLF; `.gitattributes` forces LF across the repository but these files are gitignored, so nothing normalises them. In the report token the CR malforms the Authorization header, the backend answers 400, and `backup.sh` logs "could not reach" — which reads as a network fault while backups keep succeeding and `BackupMonitor` never observes one. In the **passphrase** it becomes part of the key with no symptom at all: backup and restore read the same file, so every drill passes, and recovery fails the day somebody re-types the passphrase onto a clean host. Demonstrated, not argued — after correcting the file, an archive written minutes earlier was provably undecryptable. Both scripts now **refuse** rather than strip, because stripping would silently orphan archives already written |
| F-046 | Five banned identities reported as "never refused" by the enforcement oracle | **The harness, and the third time it has accused the server.** All five carried a `451` in the ledger: they were refused by the edge geo-block in `frontend/nginx.conf`, which answers in nginx before the upgrade reaches a backend, so `chat:ban:{key}` was never read for them. The ban held on all thirteen identities that actually reached the door. `oracles/enforcement.ts` now partitions the cohort — tested, untested-at-the-edge (named), admitted — and **fails when the tested set is empty**, because a run whose whole A14 group drew an EEA country would otherwise "prove" enforcement while asking nothing |
| F-047 | 219 stored message bodies "hash to something no bot recorded sending" | **The harness.** Exactly the 219 rows with `moderation_action = 'block'`, confirmed against the database. A message the policy refuses outright is never acked and is still stored — D20 keeps it as evidence — and `oracles/database.ts` built its hash set only from `ack` events. A comment on that branch asserted withheld messages were covered, which was true of the server and false of the code: a remark about the system was standing in for a claim about the harness. Hashes now come from `sent`, which sees every message either way |
| F-048 | A C1 chaos run failed D17 for a 125s stamping lag against a 120s bound | **The harness.** The lag *is* the write-behind queue's latency, and pausing PostgreSQL is a deliberate instruction to make it large — so the oracle reported a retention violation for the one thing D17 is indifferent to, how long the row waited before being written. The bound is now `120s + the measured chaos episode`, taken from the phases the scenario actually recorded rather than from `--chaos-for`, and **printed in the report**. Not removed: offsets must still cluster near whole windows, which a deadline computed at deletion time could not do |
| F-037 | ~6% of declared profiles appeared not to round-trip | **The harness, again, and the same field as last time.** `server.ts` builds the join profile as `{ ...command.profile, country: connection.country }`, so the country always comes from `CF-IPCountry` and never from the declaration. A bot that declared *nothing* was still echoed a country-only profile, and the ledger hashed what it sent rather than what the server would build — so the comparison was wrong by exactly one field, deterministically, for every bot whose declaration and connection disagreed. `bot.ts` now records the hash the server will produce. 0 of 136 on the documented repro, 0 of 1,926 at 500 bots on another seed |
| F-036 | The edge wrote client IPs and OIDC authorization codes to its access log | `frontend/nginx.conf` — a format with no client-address variable and `$uri` rather than `$request` |
| F-038 | A safety label the registry documented and nothing ever wrote (`age_below_minimum`) | `ws/connection.ts`, plus a guard in `metrics-wiring.test.ts` |
| F-039 | `enhancedDatabaseReporting: false` does not stop `instrumentation-pg` writing the statement | Contained by the exporter-side denylist, which already listed it |
| F-040 | The span scrubber crashed the service it was protecting | `tracing/scrub.ts` — redact and report, never throw at runtime |
| F-041 | Tracing started from `index.ts` instrumented nothing, silently | `dist/tracing/preload.js` via `--require` |
| F-031 | A rollback down an unanswered connection doubled the timeout | `storage/pool.ts` |
| F-032 | One orphan message destroyed the batch it travelled in | `writeGroup` and `drainSpool` narrow to individual rows |
| F-034 | Spool records deferred for a missing parent lost their disk durability | `RetryTarget` |
| F-035 | Three missing indexes on the console and enforcement paths | `012_console_query_indexes.sql` |

## Accepted — understood, deliberately not fixed

These are the ones to read before "fixing" anything.

| Finding | Why it is accepted |
|---|---|
| **Redis failover protects against a process, not a host** (F-033) | The Sentinel code is done and drilled; surviving the loss of the host needs a second machine, which is a cost decision |
| **Blocking does not bound a spammer** | A block protects the blocker and nobody else, so a spammer that is blocked simply moves on to the next stranger. Changing that means a proactive detector, which is a purpose-scope decision (§25.7) with its own false-positive budget |
| **A block racing a teardown is silently lost** | The user pressed Block, the server answered `NOT_MATCHED` because the partner had already left, and nothing was recorded. Whether the UI retries or the server records against a departed partner is a product decision. Partly mitigated by the late-block window (D38) |
| **Repeating a line is not, alone, a campaign definition** | Many benign users repeat common lines over a long enough run, so a repetition count measures vocabulary size. Anything built on `campaign.ts` needs a second axis before it points at real accounts |
| **A message sent while the partner is reconnecting is acked and then dropped** | Working as designed — the ack means "accepted and routed", and buffering the text would write message content to a Redis key (I8, D43). The open question is whether the ack should distinguish "routed to a live socket" from "routed to a held seat" |
| **Two people matched twice in one visit can tell** | D50's accepted cost: the nickname is session-scoped so Recent stays readable across a skip. Deliberately reverses §24.3's "no handle stable across matches" |
| **A chat ending with no connection tells an asker the other did not agree** | Inherent to mutual consent, and the only such leak that is accepted (D47, D49) |
| **The product funnel cannot see the age gate** | Nothing about it reaches the server (§24.3, D34), so how many people see it and leave is not measurable. The cost of the privacy position |
| **The cost model assumes hourly cloud billing** | A VPS is billed flat monthly. `COST_VPS_MONTH_USD` is the shape it should take; recorded in the observability design §4.3b |

---

## The two things a reader should take away

**Chaos finds product bugs and nothing else does.** F-031 and F-032 both came
out of C1 and neither had a test that could have found them, because nothing had
ever made the spool actually engage under load. Twelve of sixteen chaos rows are
still untouched.

**A harness that has fallen behind reports a product bug, confidently.** F-037
had the swarm red for six days on something that was not the product. Bisect
before believing a harness, and check the last green run against the commit
dates.
