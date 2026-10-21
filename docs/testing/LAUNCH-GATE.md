# The launch gate

**This is not a checklist of tasks.** It is a mapping from every factual claim
this product makes in public to the thing that demonstrates it.

The distinction is the whole point, and it comes from something that already
happened here. A review of the policy documents found **seven places where they
described a system that was not the one built** — including "our moderation
team" four times, when there is one person. Every one of those would have
survived a task list, because a task list records what somebody intended to do.
A mapping does not: a claim with an empty evidence column is visible.

A false statement in a published policy is worse than a weak legal position,
because it is not arguable.

Read with `REGISTER.md` (what is covered) and `RESULTS.md` (what happened when
it ran).

---

## How to read the status column

| | |
|---|---|
| **Demonstrated** | Something ran and produced the evidence named. `RESULTS.md` says when |
| **Asserted** | A test proves it, and runs on every push. Not the same as having watched it under load |
| **Open** | Nothing demonstrates this. Either build the evidence or change the claim |
| **Not a code question** | The claim is true or false because of a decision, not because of behaviour |

---

## Retention and deletion

| Claim | Where it is made | Evidence | Status |
|---|---|---|---|
| Conversations are deleted after 30 days | privacy policy | `retention-integrity.test.ts` D9 boundary; the deletion worker's own suite | **Asserted** |
| A configuration change cannot extend the life of data already stored | D17, `repositories.ts` | `retention-integrity.test.ts` D10, watched failing before it was kept | **Demonstrated** |
| The deadline is the application's, not the database's | D17 | `retention-integrity.test.ts` — the column has no default | **Asserted** |
| Reported conversations are held longer, and a report never shortens a deadline | §8 | `retention-integrity.test.ts` D5 | **Asserted** |
| A legal hold survives its deadline | §8 | `retention-integrity.test.ts` D9 | **Asserted** |
| Safety evidence survives overload | D26, D27 | the 5,000-bot run: 2,657 records dropped, **every one P3** | **Demonstrated** |
| A database outage is not a chat outage | D16 | C1: delivery held at 43.5 msg/s while PostgreSQL was paused | **Demonstrated** |

## Message content and the trusted boundary

| Claim | Where it is made | Evidence | Status |
|---|---|---|---|
| Message content never reaches a log | I8, privacy policy | `logger.test.ts`; the swarm's log-leak oracle; `verify-log-hygiene.mjs` against shipped logs | **Demonstrated** |
| Message content never reaches a metric | I8, §18 | `metrics.test.ts` — no id-shaped or content-shaped value in a scrape | **Asserted** |
| Message content never reaches a span | I8, D52, D53 | `tracing.test.ts`; the scrubber caught `db.query.text` in production configuration (F-039) | **Demonstrated** |
| No IP address appears in the application's logs | privacy policy | `verify-log-hygiene.mjs`. The edge access log does record client addresses, by decision (F-036's partial reversal); `verify-log-hygiene.mjs --addresses` reports them | **Demonstrated** for the backend; **not true at the edge** |
| An OIDC authorization code never appears in a log | — (implied by the above) | F-036; `security-test` EDGE-4 for the response half | **Demonstrated** |

## Safety and moderation

| Claim | Where it is made | Evidence | Status |
|---|---|---|---|
| A ban and a block are separate, and revoking one cannot delete the other | D29 | `enforcement.test.ts` | **Asserted** |
| A block persists and is honoured | D18 | the swarm's spam oracle, block-durability half | **Demonstrated** |
| Every console read is logged before the content is retrieved | D33 | `admin-review.test.ts` — the audit insert is broken and no transcript comes back | **Asserted** |
| No console route accepts an identity hash | §25.3 | `admin-routes.test.ts` | **Asserted** |
| The two database roles are genuinely separated | D32 | `storage.test.ts`, against real PostgreSQL | **Asserted** |
| Under-18 declarations are counted | §24, minor-safety work | **F-038: the metric was documented and written by nothing.** Now counted | **Asserted** |
| An age gate is shown before the first conversation | `docs/policies/age-gate.md` | frontend unit tests | **Asserted** |
| We can tell how long a report waited | §25 | `chat_report_queue_oldest_seconds` against the exported target, on the safety deck | **Asserted** |

## Availability

| Claim | Where it is made | Evidence | Status |
|---|---|---|---|
| Losing a backend does not lose the conversations on it | §28, D42 | C2: the survivor absorbed the population, no step in client lag | **Demonstrated** |
| Redis can fail over without losing conversations | D13 | Sentinel drill under load: 0 restarts, ~11.2s unavailable, **346 message positions agreed** | **Demonstrated** |
| A dropped socket does not end a conversation | D42 | `lifecycle.test.ts`; the swarm's resumption personas | **Demonstrated** |
| Matchmaking is correct with N instances racing | rule 2, D13 | `races.test.ts` R13 and nine other race rows | **Asserted** |
| A graceful shutdown does not strand partners | — | `operations.test.ts`, `lifecycle.test.ts` (`holdSeat: false`) | **Asserted** |

## The product and the paid tier

| Claim | Where it is made | Evidence | Status |
|---|---|---|---|
| A preference never makes anybody wait | D44, §29.8 | `preference.test.ts` against the real Lua | **Asserted** |
| Premium is enforced and cannot be self-granted | D51 | `payments-e2e.test.ts`; the gate measured closed under load — 101 refusals, 0 applications | **Demonstrated** |
| A capture grants exactly one month, and a renewal extends rather than resets | payments | `payments-e2e.test.ts` | **Asserted** |
| A refund takes the entitlement back | payments | `payments-e2e.test.ts` | **Asserted** |
| Presence is approximate and never fabricated | D21 | `presentation.test.ts`; the wire carries `approximate: true` as a literal | **Asserted** |
| Rate limits bound abuse | §6 | `limits.test.ts`; `security-test` IDENT-1 measured the per-IP cap enforcing at the configured value | **Demonstrated** |
| The browser purchase path works end to end | — | **nothing** — `features.ts` is off and was deliberately not flipped | **Open** |

## The claims that are not about code

These have no evidence column because no test can produce one. They are
decisions, and they are the launch gate's real content.

| Claim | Status |
|---|---|
| "Our pages make no requests to any third party" | **True today, false the moment payments ship.** `docs/policies/PENDING-PAYMENTS.md` is the staged patch and lands in the same commit as the flag |
| "There is no payment provider, because nothing is for sale" | Same. Same patch |
| Merchant of record versus a bare processor | Decided: the operator is the seller of record and Razorpay the processor (terms §15, `docs/LAUNCH-CHECKLIST.md` §A) |
| The retention period for a financial record | Decided: seven years, enforced by the deletion worker (`docs/LAUNCH-CHECKLIST.md` §A) |
| A published refund policy | Open (`docs/LAUNCH-CHECKLIST.md` §A) |
| Terms §10 and §11 | Drafted |
| Stronger child-safety measures (age assurance, grooming detection) | Planned; see `PHASES.md` § Deferred |
| Whether a local age-gate flag demonstrates anything to anybody else | Open, and deliberately not assumed either way in `docs/policies/age-gate.md` |

---

## The gate itself

**Blocking, in the sense that shipping without them makes a published statement
false:**

1. The `PENDING-PAYMENTS.md` patch lands with the payment flags, or payments
   stay off.
2. A published refund policy, before anything can be bought.

**Not blocking, and worth knowing you are choosing:**

* The browser purchase path has never been run. The server side is proven; the
  checkout has not been opened by a person.
* No active security scanner has ever been pointed at this.
* The console authorisation matrix has a probe and has never run it.
* Capacity is one 5,000-bot run. There is no endurance evidence and no
  idle-heavy shape, which is what real traffic looks like.
* Twelve of sixteen chaos rows are untouched, and chaos is where every product
  bug in this repository has come from.
