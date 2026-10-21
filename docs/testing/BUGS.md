# Reported bugs

Numbering continues `docs/testing/DEEP-CODEBASE-AUDIT.md`, which ends at F-032, so
these read as findings 33 onwards of the same ledger. Each one below has been
confirmed in the code — the "Verified" line says what was actually read, not
what was claimed.

F-033 to F-035 were reported 2026-08-31 against the tree at `22537d7`. F-036
was found on 2026-09-02 while building the log pipeline (phase 25) and is the
first finding here that came out of *running* the system rather than reading
it.

All three are **fixed in code**: F-035 (a schema-only change), F-034 (bounded,
one file), F-033 (configuration and deployment, touching how every process
reaches Redis). What remains for F-033 is not code: it is a second machine for
the replica to live on, without which the failover protects against a Redis
process crashing and not against the host. That is tracked as a known and
accepted operational limit, not an open bug.

---

## F-033 — Redis is a single point of failure and cannot be made highly available from config

**Severity:** High (availability) · **Status:** Fixed in code (`REDIS_SENTINELS`, drilled under load). Running a replica on a second host is an operational decision, not open code

**Location:** `backend/src/redis/client.ts`, `backend/src/config.ts` (`config.redis`),
`docker-compose.prod.yml`, `ops/`.

**What is true.** The Lua scripts derive most of their keys inside the script
from the prefix in `ARGV[1]` (`scripts.ts:51-63`) rather than declaring them in
`KEYS`. That is deliberate and documented — a globally shared queue needs
cross-slot access, so Redis Cluster would be a matchmaking redesign (D13,
`DESIGN.md:229`). This is **not** the bug, and Cluster is not the fix.

**The actual gap.** D13 already commits to the mitigation — "scale via vertical
+ replica failover" — and that half is not built. `createRedisClients` takes
`config.redis.url`, one URL, and hands it to `new Redis(url)`. ioredis reaches a
Sentinel set through `{ sentinels: [...], name }` options, not through a URL, so
there is no value of `REDIS_URL` that gets failover. The client is otherwise
already written for a promotion — `reconnectOnError` reconnects on `READONLY`,
which is exactly what a promoted replica says to a client still talking to the
old primary (`client.ts:60-61`).

**How it manifests.** The primary dies; every backend instance's `/ready` goes
false because readiness is derived from Redis health and nothing else
(`client.ts:33-38`); every instance leaves the load balancer; the product is
down until a human repoints `REDIS_URL` and restarts. There is no data loss —
persistence is off by design (D12) and `reapplyActiveBans` replays sanctions —
so the whole cost is downtime.

**What shipped.** `REDIS_SENTINELS` and `REDIS_SENTINEL_NAME` (plus
`REDIS_PASSWORD` / `REDIS_SENTINEL_PASSWORD`, since Sentinel mode could not
otherwise authenticate at all and direct mode already could through the URL).
`createClient` in `client.ts` builds the Sentinel options object for both the
command and subscriber connections. The Lua scripts do not move; no matchmaking
race was re-verified.

**The safety property is the refusals, not the feature.** Sentinels without a
name, a name without sentinels, `REDIS_URL` and sentinels together, an address
that is not `host:port` — each is a startup failure. None falls back to a single
node. A half-specified topology that quietly used one address would look
configured, pass every health check, and reveal itself only on the night it was
bought to survive, with nothing to connect the outage to the setting. Startup
also warns on a production single node, and on a Sentinel set smaller than three.

**Drilled, not just typechecked.** `docker-compose.sentinel.yml` stands up a
primary, a replica and three Sentinels; `docs/operations/OPERATIONS.md` §17 is the runbook.
Measured 2026-08-31:

| Step | Result |
| --- | --- |
| Promotion | ~3 s from `docker stop` to the replica reporting `master` |
| Data | intact — the replica already held it in memory |
| Sentinel | reported the new primary's address immediately |
| Old primary restarted | demoted to replica within ~9 s |
| Write to the demoted node | `READONLY You can't write against a read only replica.` |

That last line confirms the pre-existing `reconnectOnError` matcher fires on the
real message — failover handling that had been sitting in a system that could
not fail over.

**The first drill failed, and the reason is the finding.** Monitoring the
primary by container name with `sentinel resolve-hostnames yes` formed a quorum,
looked correct, and then failed over *not at all*: stopping a container removes
it from Docker's DNS, Sentinel's lookup blocks, and the latency spike puts it
into TILT — a mode where it deliberately stops acting. It never votes, and the
symptom is silence rather than an error. The rig uses static addresses now. The
rule worth keeping: never give Sentinel a name that disappears with the thing it
names.

**Two limits the drill exposed**, both recorded in §17.3: a returning node is
briefly a primary again and a write landing on it in that window is discarded by
the resync; and a failover still costs 5–15 s of failing commands plus the
Pub/Sub events published inside it.

**Not covered by the automated suite, deliberately.** Sentinel hands clients the
address the primary is known by on its own network, which the host running Jest
is not on — a host-side test would exercise a platform-specific NAT workaround
rather than the failover. The unit tests assert what was actually broken (which
constructor shape the client is built with); the promotion is a documented drill.

**Still true, and the reason this is only half the fix:** on one host the
replica and all three Sentinels die with the machine. This protects against a
Redis process crashing. Buying protection against the failure that actually
takes the service down means the replica on a second machine — one small
instance, or managed Redis with a standby, which needs no compose change at
all.

---

## F-034 — spool records deferred for a missing parent lose their disk durability

**Severity:** High (silent data loss) · **Status:** Fixed — `RetryTarget` in `retention.ts`

**Location:** `backend/src/storage/retention.ts` — `drainSpool` (`:446`),
`salvage` (`:344`), `writeGroup` (`:363`), `deferForParent` (`:406`).

**Verified path.**

1. PostgreSQL goes down, the breaker opens, records go to the file spool.
2. PostgreSQL recovers. `drainSpool` reads a batch and calls `writeBatch`.
3. The batch is refused with a permanent `23503` — a `messages` row whose
   `conversations` parent has not landed yet, which is ordinary here because the
   conversation is written by whichever instance won the match while the
   messages are flushed by whichever instances own the sockets.
4. `drainSpool` calls `salvage`, which narrows to `writeGroup`, which for a
   missing parent calls `deferForParent`, which calls **`this.queue.defer(waiting)`**
   (`:416`) — the in-memory `RetentionQueue`.
5. `drainSpool` then calls `this.spool.clear()` and rewrites only
   `spooled.slice(batch.length)` (`:490-492`).

The deferred records are now in process memory and no longer on disk. A restart
while they wait for their parent loses them silently.

**Why it matters.** These are exactly the records the spool exists to protect —
P0 safety evidence recovering from an outage — and the window is not small: a
container restart is the *likely* event right after a database outage.

**Same shape, second door.** `writeGroup`'s non-permanent branch calls
`this.queue.requeue(group)` (`:371`), which moves spool-drained records into
memory too. That window is shorter (the next flush cycle re-spools them once the
breaker opens) but it is the same transfer and should be decided deliberately,
not inherited.

**What shipped.** A `RetryTarget` interface — `defer` and `requeue` — threaded
through `salvage` to `writeGroup` to `deferForParent`. `RetentionQueue` already
satisfies that shape, so the live flush passes `this.queue` and behaves exactly
as before; `drainSpool` passes a `SpoolRetryTarget` that collects, and writes
what it collects back to the file.

Two things beyond the reported direction:

* **`requeue` is on the interface too.** The second door above was routed rather
  than left as an inherited default. Its window is shorter, but "shorter" is not
  a reason for the destination to be implicit at five call sites.
* **`respool()` counts a short write.** The old `this.spool.write(remaining)`
  discarded the return value. Everything passed back was read from the spool
  moments earlier and the file has just been cleared, so the size bounds cannot
  bind — but an I/O failure can still lose a record, and losing one silently is
  the bug class this finding is about. Deliberately not `toSpool`, which adds
  what it writes to `counters.spooled`: these were counted when first spooled,
  and counting them again per drain would make the metric mean something other
  than "records that entered the spool". The shortfall reuses `spool_full` so the
  label set on `chat_retention_dropped_total` does not grow.

**Ordering.** Deferred records go *behind* the untried remainder —
`[...remaining, ...retry.held]` — for the reason `RetentionQueue.defer` returns
records to the back of their lane: a record waiting on a parent has no claim on
the next batch, and leading with it would let a few waiting records block the
drain of everything behind them.

**Tests**, both against real PostgreSQL and a real spool file. A second writer
over the same spool directory is what a restart actually is — a fresh queue and
the same file:

* *leaves a deferred spool record on disk, so a restart still has it* — the
  regression. Confirmed to fail without the fix, with the record gone from disk
  (`Expected: 1, Received: 0`) because it was in the memory of a process about to
  disappear.
* *carries the wait count back to disk* — `parentWaits` survives the JSON round
  trip. Without it the retry bound would reset on every drain and a record whose
  parent never arrives would circulate as long as the spool lives.

**One existing test changed, and it had been passing because of the bug.**
`drops a poisoned spool batch instead of retrying it on every cycle` asserted the
spool was empty after exactly two flushes — true only because a deferred record
left the spool on the first drain by going into memory. It now waits on disk
until its retries run out. The test keeps the property it exists for (bounded,
never retried forever) and now additionally asserts the drop is counted as
`no_parent` and the breaker stays `CLOSED`. The cycle count was never the
property.

---

## F-035 — three missing indexes on the console and enforcement paths

**Severity:** Medium (database CPU) · **Status:** Fixed — `012_console_query_indexes.sql`

**Location:** `backend/src/storage/migrations/` (no `010` in `migrations/` yet;
`migrations-pending/` holds `010_accounts.sql` and `011_payments.sql`, so the
new file needs a number that does not collide).

All three confirmed by reading `001_initial.sql` — the indexes named below do
not exist.

**1. `blocks(conversation_id)`.** `issueBanForReport` joins
`blocks b on b.conversation_id = r.conversation_id` (`admin/enforce.ts:254`) and
`openReport` selects `dimension, blocked_key from blocks where conversation_id = $1`
(`admin/review.ts:261`). `blocks` has `blocks_pair_idx (blocker_key, blocked_key)`
and `blocks_expiry_idx (expires_at)` and nothing on `conversation_id`, so both
paths sequentially scan the table. Every report opened and every ban issued.

**2. `moderation_events(conversation_id)`.** `listOpenReports` runs a correlated
subquery per report: `select array_agg(distinct e.rule) from moderation_events e
where e.conversation_id = r.conversation_id` (`admin/review.ts:167`).
`moderation_events` has `moderation_events_message_idx (message_id)` and
`moderation_events_expiry_idx` — nothing on `conversation_id` — so the triage
queue scans the whole events table once per row it returns.

**3. Active sanctions on `enforcement`.** `reapplyActiveBans` runs every
`ENFORCEMENT_RELOAD_INTERVAL_MS` (5 min default) with
`where action = any($1) and revoked_at is null and expires_at is not null and
expires_at > $2` (`admin/enforce.ts:360-366`). `enforcement` has
`enforcement_subject_idx (subject_key)` and `enforcement_expiry_idx
(retention_expires_at)` — neither helps. The table grows monotonically with
revoked and expired history, so this becomes a periodic full scan on a timer.

**Direction.** One migration:

```sql
create index if not exists blocks_conversation_idx on blocks (conversation_id);
create index if not exists moderation_events_conversation_idx
  on moderation_events (conversation_id);
create index if not exists enforcement_active_idx on enforcement (expires_at)
  where revoked_at is null;
```

**What shipped.** `backend/src/storage/migrations/012_console_query_indexes.sql`,
numbered 012 because `migrations-pending/` reserves 010 and 011 for payments and
`scripts/verify-pending-policy.mjs` guards that staged patch. `CONCURRENTLY` was
considered and rejected: `migrate.ts` runs each file inside a transaction on
purpose, which forbids it, and the lock is milliseconds at this size. The
migration says so, and says what to do instead if these tables ever get large.

**Measured** against PostgreSQL 16 with 20k conversations, 60k moderation events,
40k blocks and 30k enforcement rows of which 40 are live:

| Query | Before | After | Plan change |
| --- | --- | --- | --- |
| Triage queue | 167.963 ms | 3.284 ms | seq scan per report → bitmap index scan |
| `openReport` blocks | 3.273 ms | 0.119 ms | 39,998 rows filtered → 2 read |
| `reapplyActiveBans` | 3.501 ms | 0.066 ms | 30,000 rows filtered → 0 |

One assumption did not survive the measurement. The second query in the ban
reload — `expires_at is null or expires_at > $2` — was expected to fall back to a
scan; the planner instead splits the disjunction into a BitmapOr over two scans
of the partial index. The migration comment says what was measured rather than
what was expected.

Guarded by `storage.test.ts` → *indexes the columns the console and the ban
reload read by*, which asserts the enforcement index is still **partial** — that
is the half that silently degrades, since dropping the predicate leaves an index
that answers the query and grows with every sanction ever issued. The test was
confirmed to fail when the predicate is removed.

---

## F-036 — the edge wrote client IP addresses and OIDC authorization codes to its access log

> **PARTIALLY REVERSED, 3 September 2026, by the operator.** Client addresses
> are logged again, deliberately: an access log without one is hard to debug
> with and hard to investigate abuse from, and that is a decision about the
> product rather than about the code. The privacy policy will be written around
> the system rather than the system around a draft policy.
>
> **The credential half stands.** `$uri` rather than `$request`, so no query
> string and therefore no authorization code, which was never a policy question
> — a single-use bearer credential in a log file is a defect whatever any
> document says, and excluding it costs nothing anybody debugs with.
>
> `verify-log-hygiene.mjs` no longer flags addresses unless asked with
> `--addresses`; the credential and forbidden-field checks are not optional. A
> check that fails on a healthy system is one that gets run with `|| true`
> inside a week.


**Severity:** High (privacy, and a published claim) · **Status:** Fixed — `frontend/nginx.conf`

**Location:** `frontend/nginx.conf` (no `log_format` or `access_log` of its own),
`frontend/Dockerfile:47` (the file is installed as `conf.d/default.conf`, inside
the stock image's `http` block).

**What is true.** `nginx.conf` never set an access log format, so the container
used the image's default: `access_log /var/log/nginx/access.log main`, where
`/var/log/nginx/access.log` is a symlink to stdout and `main` is

```
'$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent '
'"$http_referer" "$http_user_agent" "$http_x_forwarded_for"'
```

Two of those fields are the problem, and the second one is worse than the first.

**1. The visitor's IP address, twice per line.** `$remote_addr` and
`$http_x_forwarded_for`. The privacy policy says, of the raw address: "We never
store your actual IP address, **and it never appears in our logs**"
(`privacy-policy.md:98-100`), and `REVIEW-PROMPT.md:54` repeats it as a fact a
reviewer may rely on. The application honours this scrupulously — addresses are
salted-hashed before they become keys and `logger.ts` denies `ip` outright — and
the edge in front of it did not.

**2. An OIDC authorization code, on every completed sign-in.** `$request` is the
raw request line *including the query string*, and `location /auth/` proxies the
callback. So every successful sign-in wrote

```
"GET /auth/callback?code=<AUTHORIZATION CODE>&state=<STATE> HTTP/1.1"
```

A single-use, short-lived bearer credential, in a log, in the clear. It is
redeemable exactly once and the backend redeems it immediately, so the practical
window is small — but "the credential is only briefly useful" is not the claim
anybody would want to be making, and `state` beside it is the CSRF token for the
same flow.

**Verified**, not inferred. Against the running load stack before the fix:

```
$ curl "http://localhost:8090/auth/callback?code=SECRETAUTHCODE123&state=STATEVAL" \
       -H "X-Forwarded-For: 203.0.113.77"
$ docker logs karobakbak-loadtest-frontend-1 | tail -1
172.22.0.1 - - [02/Sep/2026:11:10:16 +0000]
  "GET /auth/callback?code=SECRETAUTHCODE123&state=STATEVAL HTTP/1.1" 404 21
  "-" "curl/8.4.0" "203.0.113.77"
```

**Why it was not ephemeral.** The instinct is that container stdout does not
count as "our logs". It does here: no `logging:` block is set anywhere in
`docker-compose.yml`, so every container uses Docker's default `json-file`
driver with **no `max-size` and no `max-file`**. Those lines were already on
disk, unrotated, for the life of the host. Phase 25 would additionally have
shipped them into a queryable store with seven days of retention, which is what
turned a latent problem into a blocking one.

**The fix, and why it is at the source.** `nginx.conf` now declares a
`kbb_access` JSON format and sets `access_log /dev/stdout kbb_access` at server
level. Two deliberate choices inside it:

* **`$uri`, not `$request`.** `$uri` is the normalised path and carries no query
  string, so the credential cannot be expressed by the format at all. This is
  the half that closes (2) at the source rather than by redaction downstream.
* **No client-address variable at all.** Not a redacted one — absent. What is
  kept is `$upstream_addr`, an internal container address, which is the field
  that says which backend replica answered and is the most useful thing the
  access log carries for a cross-instance problem.

Also dropped, and each for a stated reason rather than by omission: User-Agent
and Referer (the policy says "no device fingerprinting", and the application's
own structured logs cover behaviour), and `$http_cf_ipcountry` (country is
*derived* from the address rather than declared, so retaining it per request is
location history by another name — `$geo_blocked`, a 0/1, answers the
operational question without recording where anybody was).

A `map` on `$remote_addr` suppresses the container health check's line, which
fired every ten seconds for the life of the container. The variable is used and
not logged: removing a field from a format does not remove the variable.

**The second control is a detector, not a redactor.**
`scripts/verify-log-hygiene.mjs` reads back what actually reached Loki and fails
on an address literal, a credential-shaped `name=value`, or any of
`logger.ts`'s denied field names appearing as a JSON key. It reports findings as
a truncated SHA-256 rather than quoting them, because a tool that reports a leak
by printing it has copied the leak into CI output.

A redaction stage in the shipper was considered and rejected: it would make a
future failure of `logger.ts` or of this format *invisible*, arriving clean with
the broken control undiscovered. The shipper scrubs credential-shaped query
parameters only — the case nginx can no longer produce but a future service
might — and leaves addresses to be found.

**Two things the fix got wrong first, both caught by running it:**

* Alloy's `stage.replace` replaces the **captured group**, not the whole match.
  The first version captured the parameter name and emitted the literal text
  `${1}REDACTEDLEAKEDCODE9` — a line that reads as redacted at a glance and
  still carries the secret.
* The detector's first run reported two findings that were `6.6.87.2`, the WSL2
  **kernel version** from two containers' startup banners. A four-part version
  number is indistinguishable from an address by shape, so the pattern now
  rejects a quad glued to a longer token. A detector that cries wolf on a clean
  stack is one that gets run with `|| true` within a week.

**Guarded by** `scripts/verify-log-hygiene.mjs`, run against a live stack. It is
deliberately not in `npm run verify`, which is hermetic.

---

## F-037 — the swarm had been red for six days for a reason that was not the product

**Severity:** Medium (verification, not runtime) · **Status:** Fixed — `load-test/swarm/src/bot.ts`

**Location:** `load-test/swarm/src/bot.ts` (upgrade headers), against
`backend/src/server.ts` (`{ ...command.profile, country: connection.country }`)
and `backend/src/ws/upgrade.ts` (`clientCountry`).

**What happened.** A 40-bot run during phase 27 failed the profile-agreement
oracle: *80 of 184 declarations did not survive the round trip*. The instinct
is a product regression in phase 23 or 24, both of which touched declared
profiles.

It was not. Bisecting to `6072f7a` — before phases 25 and 26 — reproduced it
identically, so neither of this session's phases caused it. The last **passing**
run is dated 2026-08-24, and `c043479` *"country comes from the connection, not
from a dropdown"* landed **2026-08-26**.

**The product is correct.** Since that commit the server discards whatever
country a client sends and resolves it from `CF-IPCountry` at the upgrade —
which is the documented behaviour and the whole point of the change: country is
the one declared dimension that cannot be misdeclared without a VPN. The swarm
declares a country 48% of the time, sent no such header, and was therefore
echoed a null every time. 43% observed against 48% expected; the arithmetic is
the proof.

**So the harness was two days out of date and nothing said so.** This is the
gap `docs/testing/OBSERVABILITY-AND-TESTING.md` §2.5 names — 130 run directories, no
baseline, no comparison, nothing that would notice a change. The swarm has been
unusable as a gate since 2026-08-26 and the fact was discovered by accident,
while building something else.

**The fix sends the header rather than dropping country out of the hash.**
Excluding it would have made the oracle green and made a genuine
country-crossing bug invisible — and country is one of the two fields a
moderator reads first. A bot now sends `CF-IPCountry` matching what it declared,
nginx forwards it, and the round trip is tested end to end for real.

80 failures became 1, and a subsequent 30-bot run at the same seed passed
outright.

**Still open, and now much better characterised (phase 30).** A residual
fraction of declarations fails to round-trip: 1 of 138 and 1 of 44 on early
runs, and **8 of 130 at seed 33**.

Three runs at seed 33 with the population and duration held constant returned
**exactly 8 failures and exactly 130 declarations every time** — once with
`FILTERS_ENABLED` on, once with it off, once with `TRACING_ENABLED` off. So:

* it is **deterministic per seed**, not a race and not flakiness;
* neither the preference feature nor the tracing pipeline causes or worsens it;
* it is reproducible on demand, which is most of the work of fixing it.

That is a materially different bug from the one recorded above. A race would
have varied across those runs; this picks the same bots every time, which means
some specific declaration shape is being dropped rather than some interleaving
being lost.

The ledger holds only hashes — by design, so no name ever reaches it — so
naming the field needs deliberate instrumentation rather than another run. Left
open and not chased here because it is unrelated to the phases that found it,
but `--seed 33 --bots 40 --duration 60 --profile realistic` is the reproduction.

**The lesson generalises, and it is the one this repository keeps relearning:**
a harness that has fallen behind the product does not report "I am out of date".
It reports a product bug, confidently, with a plausible count attached.

---

## F-038 — a safety label the registry documented and nothing ever wrote

**Severity:** Medium (a missing safety measurement, not a runtime fault) · **Status:** Fixed — `backend/src/ws/connection.ts`

**Location:** `backend/src/metrics/registry.ts` (`profilesRefused`),
`backend/src/protocol/validate.ts:295` (`AGE_BELOW_MINIMUM`),
`backend/src/ws/connection.ts` (the parse-failure branch).

**What the registry claimed.** On `chat_profiles_refused_total`:

> `age_below_minimum` is the one to watch: it counts people who told this
> service they are under 18. That is a safety signal and an input to the
> minor-safety policy security section 24 requires before launch.

**What was true.** `profilesRefused.labels(...)` had exactly one call site in
the whole tree, and it passes `'name_moderation'`. Nothing anywhere wrote
`'age_below_minimum'`.

`AGE_BELOW_MINIMUM` is raised by `validateProfile`, which runs inside
`parseClientFrame` — so an under-18 declaration was refused correctly, counted
as a protocol strike correctly, and landed in
`chat_invalid_frames_total{reason="invalid"}` alongside malformed JSON, missing
fields and every other validation failure. The number the minor-safety work
needs did not exist and could not be recovered from anything that did.

**Found by** building the safety dashboard and asking what each panel would
actually show. It is not visible from the metric's definition, its type, or the
scrape — `chat_profiles_refused_total{reason="age_below_minimum"}` was simply
absent, which on a graph is a series that has never fired.

**Why this is worse than a dead metric.** A dead metric is an empty panel:
suspicious, and `metrics-wiring.test.ts` exists to catch it. A documented dead
*label* is a comment in the source asserting that a specific safety number is
being collected, cited to a policy section, and read by whoever writes that
policy as a thing they can rely on.

**The fix** counts it at the one place the refusal is visible to anything that
can count it: the parse-failure branch in `connection.ts`, which already has
the code. It is reported through a separate observer hook rather than folded
into `frameRejected`, because the two answer different questions — one is
protocol health, the other is safety — and pooling them is how this happened.

It remains a protocol strike, and ten of them still disconnect the socket. That
part is unchanged and deliberate; what is new is that it is also counted.

**Guarded by** a new case in `metrics-wiring.test.ts` asserting every value in
`PROFILE_REFUSAL_REASONS` appears as a call argument somewhere outside the
registry.

**The guard was wrong first, in the same shape as the bug.** Its first version
looked for the bare literal `'age_below_minimum'` anywhere in `src/` and
**passed with the write site deleted** — because the value also appears in a
type annotation, `profileRefused(reason: 'age_below_minimum')`. A guard that a
type satisfies proves nothing. It matches a complete call argument now, and was
confirmed failing with the write removed before being kept.

Scoped to this one list on purpose: several label values are passed as
variables and never appear as literals at their write site, so a blanket version
would fail on correct code and be deleted within a week.

---

## F-039 — `enhancedDatabaseReporting: false` does not stop `instrumentation-pg` writing the statement

**Severity:** Medium (would have been High if the second control did not exist) · **Status:** Contained — denied by `ScrubbingSpanProcessor`

**Location:** `backend/src/tracing/index.ts` (the `PgInstrumentation` options),
`backend/src/redaction.ts` (`FORBIDDEN_ATTRIBUTE_KEYS`).

**What was assumed.** D53 says the dangerous capture is switched off at the
instrumentation *as well as* denied at the exporter, on the reasoning that a
denylist is a list of things somebody thought of. The setting named in that
decision is `enhancedDatabaseReporting`, and it governs `db.statement`.

**What is true.** `@opentelemetry/instrumentation-pg@0.74` also sets
**`db.query.text`** — the newer semantic-convention name for the same thing —
and `enhancedDatabaseReporting: false` does not suppress it. Every single
database span carried it.

Nothing failed. Nothing warned. The attribute was on every span the moment
tracing was switched on for the first time, and the only reason it is in this
document rather than in a tracing backend is that the second control caught it:

```
{"level":"error","msg":"span carried a forbidden attribute",
 "component":"tracing","spanName":"pg.query:SELECT karobakbak",
 "attribute":"db.query.text"}
```

**Severity is Medium rather than High, and the distinction is worth being exact
about.** `db.query.text` is the *parameterised statement* — `insert into
messages (conversation_id, body, ...) values ($1, $2, ...)` — not the parameter
values, which is where message bodies actually are. So this was the shape of the
query leaving the boundary, not the content. It is denied anyway, for two
reasons: the denylist covers statements as a class, and any query that is ever
built without parameters would carry values in exactly this attribute.

**This is the argument for D52 and D53 being two controls rather than one,
made by events rather than by reasoning.** The instrumentation-level control was
written against the attribute name the documentation discusses, and the library
sets a second one. A single control at that layer would have shipped.

**No fix was needed** beyond what was already there — `FORBIDDEN_ATTRIBUTE_KEYS`
already listed `db.query.text`, because it was written by asking what the
library *could* emit rather than what its options mention. The instrumentation
option is kept, and is now documented as insufficient on its own.

---

## F-040 — the span scrubber crashed the service it was protecting

**Severity:** High (self-inflicted outage) · **Status:** Fixed — `backend/src/tracing/scrub.ts`

**Location:** `backend/src/tracing/scrub.ts`, `backend/src/tracing/preload.ts`.

**What happened.** The scrubbing span processor copied `logger.ts`'s rule —
throw outside production, redact inside it — so that a leak would be impossible
to miss where new instrumentation is written. The comment justifying it said the
throw was safe because `onEnd` runs "on the SDK's own path rather than the
application's, so the tracer swallows it".

That is wrong. `SpanProcessor.onEnd` is called synchronously from `span.end()`,
which the instrumentation calls **inside the operation it is measuring**. So the
throw propagated into the database call being observed. Combined with F-039 —
which meant every single query carried a denied attribute — the backend went
into a restart loop on its first query, and the thing crashing it was the safety
control.

**The rule that came out of it.** A log call is application code and a test can
wrap it. A span processor is a callback a vendor invokes from inside somebody
else's call stack, so the logger's rule does not transfer. **Redact always,
report loudly, never throw in a running process.** `strict` survives as a
constructor option because the test suite needs to assert refusal directly, and
`tracing.test.ts` is its only caller; it must never be derived from `NODE_ENV`
again.

**A second problem underneath it.** With the throw removed, the violation was
reported on every span — an error line per database operation, which would bury
the log stream and train whoever reads it to ignore that message. Reports are
deduplicated by attribute key now: an operator needs to know *that* an attribute
is being denied, not how many times. The run that produced the evidence above
logged it exactly once.

---

## F-041 — tracing started from `index.ts` instrumented nothing, and said nothing

**Severity:** Medium (the feature did not work) · **Status:** Fixed — `dist/tracing/preload.js`

**Location:** `backend/src/index.ts`, `backend/src/tracing/preload.ts`,
`backend/Dockerfile`, `backend/package.json` (`start`).

**What was built.** `startTracing` was called from `index.ts` after
`loadConfig`, deliberately rather than from a `--require` preload, so that a
process with tracing disabled would never load the SDK into the address space
holding every WebSocket file descriptor. The comment acknowledged a cost: "a
small number of early spans are missed".

**What was true.** `registerInstrumentations` patches a module by replacing its
exports, and by the time an async `main()` runs, `pg` and `ioredis` have already
been imported at the top of `index.ts` and everything it pulls in. Nothing was
patched. **No span was produced at all.**

The symptom is the interesting part: Tempo received zero traces from a stack
that logged no error, was reachable from the backend, and returned
`{"partialSuccess":{}}` when its OTLP endpoint was poked by hand. A tracing
pipeline that exports nothing is indistinguishable from a system with nothing to
report — the same family as a metric that is present, plausible and permanently
zero.

**The fix keeps the original property by ordering rather than by placement.**
`dist/tracing/preload.js` runs via `--require`, reads `TRACING_ENABLED` from the
raw environment, and only then `require`s anything OpenTelemetry. With tracing
off the SDK still never enters the process. The `require` is deliberately not a
top-level `import`, because an import is hoisted and would load the SDK
unconditionally — which is the behaviour the file exists to avoid.

---

## F-042 — a structurally broken frame is reported as a version problem

**Severity:** Low (diagnostics) · **Status:** Recorded, not changed

**Location:** `backend/src/protocol/validate.ts:490` and `:494`.

`{"hello":"world"}` is answered with `UNSUPPORTED_VERSION`. The catalogued P2
row expects `BAD_ENVELOPE`.

Neither is a bug in the sense of something behaving unsafely. `:490` refuses
anything that is not a JSON object, and that frame *is* one, so it reaches the
version check at `:494` with `version` undefined and is reported as a version
mismatch. A client sending structural garbage — a wrong serialiser, a truncated
frame, somebody else's protocol — is told to fix its protocol version, which is
the one thing that is not wrong with it.

**Recorded rather than fixed**, because an error code is part of the wire
contract: reordering the two checks changes what an existing client sees, and
that is a protocol decision rather than a test fix.
`protocol-abuse.test.ts` asserts the behaviour as it is and names this row.

---

## F-043 — `join_queue` while already matched is answered with silence

**Severity:** Low (a client can hang) · **Status:** Recorded, not changed

**Location:** `backend/src/ws/lifecycle.ts:490-491`, `backend/src/server.ts`
(`replyToSearch`, the `matched_elsewhere` case).

A `join_queue` sent by a session that is already in a match produces **no frame
at all**. The catalogued P14 row expects `ALREADY_MATCHED`.

`lifecycle.joinQueue` returns `matched_elsewhere` for it, and `replyToSearch`
deliberately sends nothing for that outcome. That is correct for the case the
branch was written against and its comment describes: a peer matched this
session while it was joining, so a `matched` frame is already inbound from the
instance that won the race (§10.1). Sending an error there would be a second
answer to a question that already has one.

The problem is that a *deliberate* re-join reaches the same branch, and in that
case nothing is inbound. The client is left waiting for a reply that never
comes. The shipped client does not do this; a reconnecting one that has lost
track of its state might, and a probing one certainly will.

Two ways out, both decisions rather than fixes: distinguish the race from the
deliberate re-join at the lifecycle level and answer `ALREADY_MATCHED` only for
the second, or accept the silence and change the catalogue. Recorded so that
whoever picks has both halves in front of them.

---

## F-044 — when Redis refuses writes the service is dead and reports itself healthy

**Severity:** High (availability: an outage that passes every health check) · **Status:** Open. Logging and alerts fixed; the `maxmemory` setting is a deployment decision

**Location:** `docker-compose.yml` (the `redis` service), `backend/src/server.ts`
(`failed to open a session`), `/ready`, `monitoring/prometheus/alerts.yml`.

**What was measured.** In a test where Redis reached its configured `maxmemory`
and refused writes, the service could not open a session, match anybody or
deliver a message, while `/ready` still reported ready and the swarm verdict
still read PASS. Every instance would have stayed in the load balancer for the
whole outage.

**Why `/ready` is wrong here and is not obviously wrong.** It is derived from
Redis health and nothing else, which is right — a backend whose *database* is
down still serves chat and must stay in the load balancer (§10.18). But the
Redis check is reachability, and under OOM Redis answers `PING` perfectly well:
only writes are refused. So the check answers "can I reach Redis" when the
question is "can I serve a conversation".

**The swarm said PASS**, which is its own version of the same problem. The
oracles are consistency checks — every acked message delivered, every
conversation with two sides — and a run in which nothing happened is perfectly
consistent. Trap 18 in the handoff records the general form: *a harness bug that
removes behaviour looks like a clean run*. This is a **product** failure that
looks like a clean run for the same reason.

**The logs said `ReplyError` and nothing else.** `server.ts` logged only
`errName`, so an operator saw `failed to open a session — ReplyError` 202 times
with no indication that Redis was out of memory. `ReplyError` is true of every
reply error Redis has ever sent.

**Fixed:** that call site now uses `errorFields(err)`, which is what every other
call site uses and which truncates and denylist-scans the message and stack —
the reason that helper exists.

**Fixed:** two alerts. `SessionsFailingToOpen` watches
`chat_connections_rejected_total{reason="error"}`, which was the one series that
moved and which nothing was watching. `RedisApproachingMaxMemory` watches the
precondition.

**Not fixed, because it is a decision: the base and production compose files
set no `maxmemory`.** (`docker-compose.vps.yml` sets one through
`REDIS_MAXMEMORY`.) The policy is `noeviction`, which is the right choice,
since evicting a session key at random would silently break matchmaking for
whoever owned it, but with no limit set it is **inert**: Redis memory is
bounded only by the host, and with persistence off (D12) a Redis restart loses
live state. `/ready` checking reachability rather than writability is the other
half still open.

Setting a number needs one that leaves headroom on whatever the deployment
actually runs on, which is the operator's to pick. The measurement that informs
it: **roughly 2.6 KB of Redis per live session** — 600 concurrent sessions moved
`used_memory` from 1.81 MB to 3.35 MB.

---

## F-045 — 109 settings are documented, settable, and reach nothing

**Severity:** Medium-High (configuration that looks applied and is not, including
safety limits) · **Status:** Fixed in phase 38: the services that read
`config.ts` receive the env file through `env_file:`, and
`scripts/verify-config.mjs` fails on a documented setting that no service
receives. The write-up below describes the defect as found

**Location:** every `docker-compose*.yml` (no `env_file:` directive anywhere,
and the `backend` service's `environment:` block), `backend/src/config.ts`,
`.env.example`, `.env.prod.example`.

**How it was found.** Not by reading. While measuring whether a longer heartbeat
would buy capacity on the VPS rig, `HEARTBEAT_INTERVAL_MS=40000` was written to
the env file the stack was started with, the backend was recreated, and the
process was asked what it thought:

```
$ docker exec ... printenv HEARTBEAT_INTERVAL_MS
                                        (nothing)
$ docker exec ... node -e "...loadConfig(process.env).timers.heartbeatIntervalMs"
heartbeatIntervalMs = 20000
```

The experiment would otherwise have compared 20s against 20s and reported that
the heartbeat interval does not affect capacity — which is, by coincidence, the
true answer. A wrong method produced the right number, and nothing would have
said so.

**Why it is invisible.** `docker compose --env-file X` populates `${VAR}`
substitutions **in the YAML**. It does not put anything into a container. A
service receives an environment variable only from an explicit `environment:`
entry or an `env_file:` directive, and **there is no `env_file:` in any compose
file here**. So an env file listing eighty settings configures exactly those the
YAML happens to interpolate, and is inert for the rest. Nothing warns: an
undeclared variable is not an error, it is silence, and the process starts
cleanly on its compiled-in defaults.

**The scale.** Counting the names `config.ts` reads out of the environment, with
the ten `rateLimit()` prefixes expanded to the twenty real names they build
(`BLOCK` is not an env name; `BLOCK_RATE_PER_SEC` and `BLOCK_BURST` are):

| | |
|---|---|
| Environment names `config.ts` reads | 167 |
| Names some compose file passes | 97 |
| Read by `config.ts`, passed by nothing | **109** |
| ...of which named in `.env.example` or `.env.prod.example` | **99** |

The second number is what makes this a defect rather than an absence. Ninety-nine
of them are written down as supported settings. They can be set, they parse, they
are documented, and they do nothing.

**Confirmed against the running container rather than the regex**, because a
scan of source is exactly the kind of evidence this repository has been wrong
about before:

```
SESSION_TTL_SECONDS            ABSENT      -> ttl.sessionSeconds       = 120
MAX_CONNECTIONS                ABSENT      -> limits.maxConnections    = 5000
BREAKER_FAILURE_THRESHOLD      ABSENT
RETENTION_QUEUE_MAX_P0         ABSENT
SPOOL_BACKEND                  ABSENT
ADMIN_CONSOLE_ENABLED          ABSENT
```

**What it costs.** The silent list is not a tail of obscure tunables. It includes
`SESSION_TTL_SECONDS` and `MAX_CONNECTIONS`; `BREAKER_FAILURE_THRESHOLD`, which
with `DATABASE_STATEMENT_TIMEOUT_MS` sets how long an outage runs before the
spool comes into play; every `RETENTION_QUEUE_MAX_*`, which is how much evidence
survives an overflow; the whole `SPOOL_*` group; and the entire admin-console
block including `ADMIN_CONSOLE_ENABLED`. Somebody hardening this for production
would set several of these, restart, observe no error, and be running the
defaults.

`SPOOL_BACKEND` appearing in that list is the sharpest part. F-006 was *one*
setting that looked applied and was not, and it is cited three times elsewhere in
this repository as the reason to distrust an unexercised constant. It is still
unreachable, and it now has a hundred companions.

**Three distinct failures, needing three different fixes.** They are worth
separating rather than sweeping together:

1. **Read by `config.ts`, passed by no compose file** — the 109 above. Fixable
   by an `env_file:` on the services that should receive one, or by explicit
   `environment:` entries. `env_file:` is the smaller diff and the larger blast
   radius, since it hands a container everything in the file; that is a decision,
   not a detail.
2. **Hard-coded in source with no environment name at all** — needs a name
   before it can have a value. Not counted here.
3. **Passed by compose and read by nothing** — 39 names, most of which
   legitimately belong to `postgres`, `grafana` or `prometheus` rather than to
   `config.ts`. The residue needs checking one at a time.

**Why a guard matters more than the fix.** The fix is mechanical and will be
correct on the day it lands. What makes this recur is that nothing fails when a
setting is added to `config.ts` and to `.env.example` and to neither compose
file. A test that diffs the names `config.ts` reads against the names the compose
files pass, and fails on a name that is documented but unreachable, is the
control — the same shape as `metrics-wiring.test.ts`, which exists because a
declared-and-dead metric is worse than an absent one. A documented-and-dead
setting is worse than an absent one for the same reason: it is set, it is
believed, and it is not there.
