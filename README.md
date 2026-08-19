# karobakbak

Anonymous, real-time, text-only random stranger chat. Two strangers are paired
at random over WebSockets, exchange messages, and either one can skip, report or
block at any time. Conversations are **retained for a defined period** to
support abuse investigation and then deleted automatically.

Retained content is plaintext inside the trusted boundary of
[`DESIGN.md`](./DESIGN.md) §2.1 and never leaves it: **no message content is
ever logged, labelled or valued on a metric, put in an error message, or
exported to any other system.** That rule is enforced in code by a recursive
field denylist in `backend/src/logger.ts` that throws outside production.

It is built to be correct with **several backend instances running at once**.
All matchmaking state lives in Redis and every state transition is a single Lua
script, so no two instances can interleave a transition. Retention is
write-behind, so a database outage can never become a chat outage.

## Contents

* [Quick start](#quick-start) · [Local development](#local-development-without-docker)
* [Commands](#commands) · [Configuration](#configuration)
* [Operating it](#operating-it) · [Production hardening](#production-hardening)
* [Troubleshooting](#troubleshooting) · [Verification](#verification)

---

## Quick start

Requires Docker with the Compose plugin. Nothing else — no local Node, Redis or
PostgreSQL.

```bash
cp .env.example .env
docker compose up --build -d
open http://localhost:8081
```

Seven services come up: nginx serving the built frontend, **two** backends,
Redis, PostgreSQL, a one-shot migration job, Prometheus and Grafana.

| Service | URL | Notes |
|---|---|---|
| Frontend + WebSocket | http://localhost:8081 | the only published application port |
| Prometheus | http://localhost:9090 | both backends are scrape targets |
| Grafana | http://localhost:3000 | `admin` / `admin` by default; dashboard **karobakbak — overview** |
| Backends, Redis, PostgreSQL | — | private network, no published host port |

Two backend **replicas** is deliberate. Production starts at **one** (cost §26);
the second exists here so cross-instance correctness is *exercised* on a laptop
rather than asserted — it has caught real bugs. They are replicas of one
service, so they are `karobakbak-backend-1` and `karobakbak-backend-2`, and
`--scale backend=N` is how the count changes. nginx finds them through Docker's
DNS and Prometheus discovers them the same way, so neither needs editing.

To open a second, independent chat client, use a private window: the block token
is a same-site cookie, so two normal tabs share one identity.

```bash
docker compose logs -f backend            # or: npm run logs
docker compose down -v                     # or: npm run down  (drops volumes)
```

## Local development without Docker

Node >= 20.

```bash
npm run install:all

# Redis and PostgreSQL on the test ports (6380 / 5433), which the defaults
# in .env.example already point at for the integration suite.
npm run redis:test:up

npm run dev:backend     # tsx watch, :8080, ws path /ws
npm run dev:frontend    # vite, :5173, proxies to the backend
```

`ALLOWED_ORIGINS` already contains `http://localhost:5173`. An empty allowlist is
a **startup failure** in production (R9) and a warning in development, so a
backend that refuses to start is usually this.

## Commands

```bash
# repo root
npm run install:all      # install backend + frontend
npm run verify           # protocol drift + typecheck + backend unit + frontend unit
npm run typecheck
npm test                 # backend unit tests
npm run test:frontend    # frontend unit tests
npm run test:integration # needs redis:test:up — real Redis, Postgres, sockets
npm run build            # tsc -> backend/dist, vite build -> frontend/dist
npm run up / down / logs # the development stack
npm run psql             # a shell in the running database
npm run redis-cli        # a shell in the running Redis
npm run loadtest         # k6 against an isolated load-test stack
npm run loadtest:down    # destroy that stack, volumes and all
npm run prod:config      # resolve the production config without starting it
npm run prod:up          # the production stack (needs .env.prod)

# integration dependencies
npm run redis:test:up    # Redis :6380 and PostgreSQL :5433, both tmpfs-backed
npm run redis:test:down
```

**`npm run verify` is the gate.** It fails the build if
`frontend/src/protocol/types.ts` has drifted from the backend copy. That file is
generated: edit the backend one, then run `node scripts/verify-protocol.mjs
--fix`. Never hand-edit the frontend copy.

### Looking inside a running stack

Development publishes PostgreSQL and Redis on **loopback only** — reachable
from this machine, from nothing on the network. Production publishes neither
(§8.1): PostgreSQL holds plaintext conversation content, and reaching it should
mean coming through a bastion or a tunnel.

DBeaver, or any PostgreSQL client: host `localhost`, port **5434**, database
`karobakbak`, user `karobakbak`, password `karobakbak`. Port 5434 keeps clear of
a PostgreSQL installed on the host (5432) and of the integration-test stack
(5433).

Redis holds only live state — sessions, the queue, rate-limit buckets — and has
persistence off (D12), so it is small and empties itself. `npm run redis-cli --
monitor` while chatting in a browser is the quickest way to watch matchmaking
happen.

### Load testing

`npm run loadtest` runs the **same stack under a different compose project**
(`karobakbak-loadtest`, port 8090), which gives it its own volumes and therefore
its own database. Its traffic never reaches the development one. The differences
are a handful of environment variables in `.env.loadtest`, not another compose
file.

Retention stays enabled there deliberately: the write-behind path is where load
actually hurts, and a run that skipped it would prove much less. The per-IP
abuse limits are raised in that override only — a single generator is one
address, which is exactly the traffic shape those controls exist to refuse.

```bash
npm run loadtest         # bring the stack up and run k6 against it
npm run loadtest:down    # destroy it, volumes and all
```

## Configuration

Every variable is documented, with its reasoning, in
[`.env.example`](./.env.example) — that file is the reference, not this section.
Configuration is loaded once by `loadConfig(env)` and passed down; there is no
module-level singleton to import.

`loadConfig` also runs **cross-field coherence checks**, so a set of individually
valid values can still be rejected — a heartbeat interval that is not comfortably
below the session TTL, for instance, would silently expire live sessions, so it
is a startup error instead.

The ones you will actually change:

| Variable | Why it matters |
|---|---|
| `ALLOWED_ORIGINS` | comma-separated. **Empty is fatal in production.** |
| `TRUST_PROXY_HOPS` | how many proxies sit in front. Wrong value ⇒ wrong client IP ⇒ wrong rate limiting and wrong blocks. `1` behind the bundled nginx. |
| `IP_HASH_SALT` | salts every IP hash. Change it in production; changing it later invalidates existing IP-dimension blocks. |
| `REDIS_URL`, `DATABASE_URL` | credentials come from secret management, never from a compose file. |
| `DATABASE_REQUIRE_SSL_IN_PRODUCTION` | defaults to `true` and refuses to start without TLS to the database. |
| `MAX_MESSAGE_LENGTH` | 500 by default (security §11, cost §19). |
| `CONVERSATION_RETENTION_DAYS` and friends | retention periods. Stamped **at insert time**, so a change never retroactively extends the life of data already stored (D17). |
| `MODERATION_DEFAULT_ACTION` | `flag` by default: local rules flag for review rather than block. |
| `VITE_ADS_*` | the ad slots are real; the provider is a no-op until one is chosen. |

## Operating it

### Endpoints

| Path | Serves |
|---|---|
| `/ws` | the WebSocket. Text frames only — **binary frames are rejected**, and that is architectural (§23.2). |
| `/health` | liveness: this process. Stays `200` while Redis is down, because the process is fine. |
| `/ready` | readiness: **Redis, not PostgreSQL.** A backend with a dead database still serves chat correctly and must stay in the load balancer. `503` when Redis is unreachable. |
| `/metrics` | Prometheus text format. nginx returns **404** for it at the edge: the scrape is for the private network, not the internet. |

### Metrics

`chat_*`, plus `chat_process_*` for the Node defaults. No metric name, label or
value ever carries message content — labels come from closed enumerations only.

The families worth knowing: `chat_connections_*`, `chat_queue_depth`,
`chat_matches_created_total`, `chat_matchmaking_latency_seconds`,
`chat_messages_{received,delivered,rejected}_total`,
`chat_delivery_latency_seconds`, `chat_moderation_flags_total`,
`chat_retention_{queued,flushed,dropped,deleted}_total`,
`chat_retention_queue_depth`, `chat_db_breaker_state`, `chat_spool_*`,
`chat_deletion_failures_total`, `chat_backup_*`.

### Alerts

Shipped in `monitoring/prometheus/alerts.yml`:

| Alert | Means |
|---|---|
| `BackendDown` | an instance stopped being scraped |
| `RetentionDeletionFailing` | data is past its deadline and still stored — nothing else in the process will notice (I10) |
| `SafetyRecordsDropped` | reports/blocks/moderation events were evicted from the write-behind queue: evidence is being lost |
| `DatabaseCircuitOpen` | writes are spooling instead of landing. Chat is unaffected |
| `SpoolNearCapacity` | the outage buffer is filling. It is **bounded tolerance, not durable storage** — a host failure loses it (D28) |
| `BackupsStale` | no successful backup inside the window |
| `EventLoopLagHigh` | the process is saturated |

### What the write-behind path does under stress

Messages are delivered first and persisted afterwards, through a
priority-bounded queue → circuit breaker → batched inserts, with a bounded
on-disk spool while the breaker is open. Under overflow, retention is lossy **by
design** — but only in priority order, and every drop is counted and alerted,
never silent. Priority is server-assigned only: nothing a client sends can raise
its own durability class (D27), and a per-session sub-quota inside each class
stops one session flooding it (D26).

A rejection is not an outage. A constraint violation proves the database is
*available* — it parsed the statement and refused the data — so permanent
SQLSTATE classes (22, 23, 42) are discarded and counted rather than retried
forever behind an open breaker.

### Retention and deletion

Deadlines are stamped at insert time. A leader-locked deletion worker removes
rows past their deadline unless `legal_hold` is set; a report extends the
deadline of what it references in the same transaction that inserts it, so a
deletion pass running concurrently either has not selected the row yet or finds
it already re-protected (§10.19).

## Production hardening

The compose stack is a development stack. Before this faces the internet:

* **Age assurance and minor-safety policy are unbuilt and block public launch.**
  They need legal counsel (`PHASES.md`, security §24). This is not a code TODO.
* **TLS terminates in front of nginx**, and `DATABASE_REQUIRE_SSL_IN_PRODUCTION`
  stays `true`.
* **Set `IP_HASH_SALT` and every credential from secret management.** The
  passwords in `docker-compose.yml` are local-only placeholders.
* **Set `TRUST_PROXY_HOPS` to the real number of proxies.** Too high and a
  client can forge its own address in `X-Forwarded-For`.
* **Storage encryption at rest, and encrypted backups** for the PostgreSQL
  volume and the spool volume. Both hold plaintext message bodies. That, plus
  network isolation and least-privilege credentials, is what replaces
  application-level encryption (D15, §18.2).
* **The database security boundary is a first-class requirement, not a
  backstop.** §18.2 states the residual gap plainly: valid PostgreSQL
  credentials read message content.
* **Run migrations as their own step**, with credentials that are not the
  application's. The application role has no `CREATE` and could not run them.
* **Neither Redis nor PostgreSQL publishes a host port**, and should not start.
* **Core dumps are disabled** (`ulimits: core: 0`) and the image pins a
  `NODE_OPTIONS` with no `--inspect` and no `--heapsnapshot-signal`: a dump or a
  heap snapshot is a file full of plaintext bodies.
* **The spool is a named volume, never a bind mount.**
* Run **one** backend to start (cost §26) and scale on measured resource
  pressure, not on user count.

## Troubleshooting

**Backend exits immediately in production.** Almost always an empty
`ALLOWED_ORIGINS` (R9) or a coherence check in `loadConfig`. The error names the
variable.

**The WebSocket never opens; the upgrade gets `403 origin_not_allowed`.** The
origin the browser sent is not in the allowlist — it must match scheme, host
*and* port. The refusal deliberately does not say what *would* have been
accepted. Watch `chat_connections_rejected_total{reason="origin"}`.

**`/ready` returns 503.** Redis is unreachable. `/health` staying 200 alongside
it is correct — the process is healthy, its dependency is not.

**Everything returns `SESSION_GONE` and sockets close with 4001.** Redis
restarted. Persistence is off on purpose (D12), so all live state is gone and
clients reconnect into new sessions. There is no session resumption by design;
reconnect always creates a *new* session.

**Two tabs on one machine do match each other.** Sharing an IP and a block
token does not prevent pairing — only an actual block record does. This is the
easiest way to try the app. If they do not pair, check `chat_queue_depth`.

**...but do not test the block button with two tabs in the same browser.** A
block is recorded against the salted IP hash *and* the client-token hash (D18),
and two tabs in one browser share both — so blocking your own partner adds your
own hashes to your own block set, and that browser will then refuse to match
itself. Harmless, and it clears when `BLOCK_TTL_SECONDS` expires or the Redis
state is flushed, but it looks like matchmaking has broken. Test blocking from
two genuinely different devices.

**`DUPLICATE_MESSAGE` on a retry.** Working as intended — `id` is required on
`message` and deduplicated per match (I14, §10.17).

**`NOT_MATCHED` when sending.** The partner skipped or disconnected in the
instant before the send (§10.8, §10.9). It is a refusal, not an error; the
client re-reads authoritative state.

**A load test reports mass connection failures.** Check
`chat_connections_rejected_total{reason="rate_limited"}` and
`{reason="too_many_connections"}`. Every VU shares one IP, and both limits are
per IP — the server is refusing an address that asked for too many sockets too
quickly, which is its job. Resize the run, or raise the ceiling on the target
stack for the test. See the sizing note under [Verification](#verification).

**Grafana panels say "no data".** Check Prometheus → Status → Targets: both
one target per backend replica must be `UP` (Prometheus finds them by DNS, so
the list follows `--scale`). Grafana's datasource is pinned
to uid `karobakbak-prometheus` and every panel references it by that uid.

**Integration tests fail to connect.** `npm run redis:test:up` first. They use
ports 6380 and 5433 deliberately, and their own compose project name
(`karobakbak-test`), so the two stacks cannot wipe each other in either
direction — a development stack is never what the tests reset, and
`npm run down` never takes the test services with it.

**A `pg` error appears in logs as `{}` or with only a code.** Deliberate.
Driver errors echo parameter values — the row just attempted — on constraint
violations, so they are logged through `dbErrorFields()` by code, constraint,
table and routine only.

## Verification

`DESIGN.md` §22, executed at phase 12. Gate: `npm run verify` — protocol check
OK, both packages typecheck clean, **338 backend unit + 25 frontend unit
tests** green, and **281 integration tests** green against real Redis, real
PostgreSQL and real sockets.

| Area | Result |
|---|---|
| **Code** | every local import resolves; `tsc --noEmit` clean for both packages; no placeholder implementations; no TODOs for required functionality |
| **Protocol** | frontend and backend `protocol/types.ts` byte-identical; event names, payload shapes and error codes agree; server-generated fields never read from client frames |
| **Redis** | key names consistent; every script's KEYS/ARGV arity asserted before the call reaches Redis, and every script has a declared arity; match cleanup symmetric; TTLs applied; duplicate queue entries structurally impossible |
| **PostgreSQL** | migrations apply from empty; every retained table carries `retention_expires_at`; the deletion worker honours `legal_hold`; no table stores raw IPs, user agents or fingerprints — salted hashes only; the application role holds DML on its own tables, `select, insert` on the audit log, and no `CREATE`; no host port in compose |
| **Persistence pipeline** | queue bounded per class; per-session sub-quota enforced; priority server-assigned only; breaker opens on repeated failure and drains at a paced rate; spool bounded by size, count and age, survives a partial trailing write, and skips corrupt records |
| **Concurrency** | all **20** scenarios of §10 have tests |
| **Infrastructure** | images build; compose service names match every reference; health checks hit real endpoints; Prometheus scrapes both backends; Grafana's datasource uid matches every panel; Redis and PostgreSQL publish nothing to the host |
| **Data handling** | grep-verified and test-asserted: no log line, metric name, label, value, error message or span receives message content or a report note; no `dangerouslySetInnerHTML` in `frontend/`; database errors logged by code and constraint only; core dumps disabled and no heap-snapshot signal in the production image |
| **No stale encryption concepts** | the grep returns only infrastructure/storage/backup encryption and TLS, `util/ids.ts` hashing, and the design record's own account of why application-level encryption was removed. No column, config variable, phase entry or live prose claims message bodies are encrypted |

k6 smoke run through nginx against the live stack, 20 VUs for 20s — all five
thresholds green, exit 0: **66 matches, zero protocol errors**, ack p95 18.7ms,
0.00% connection failures, 0.00% throttled upgrades. Retention verified end to
end — conversations and messages in PostgreSQL, breaker closed, both spools
empty.

> **Sizing a load run.** Every k6 VU shares the generator's single IP, and the
> abuse controls are per IP (`CONN_RATE_LIMIT` attempts per window,
> `MAX_CONNECTIONS_PER_IP` concurrent sockets). A load generator is precisely
> the traffic shape those controls exist to refuse, so the shipped defaults stay
> inside them. For a real capacity run, raise the ceiling on the target stack
> for the duration of the test rather than weakening the defaults:
> `CONN_RATE_LIMIT=100000 MAX_CONNECTIONS_PER_IP=100000 docker compose up -d`,
> then `k6 run -e VUS=200 -e DURATION=2m load-test/websocket.js`. A throttled
> upgrade is counted as `kbb_upgrade_throttled`, never as a connect failure —
> and if most of a run is throttled, that threshold fails so the profile gets
> resized instead of the result being read as a capacity number.

## Where to read next

| File | What it is |
|---|---|
| [`DESIGN.md`](./DESIGN.md) | the contract: invariants, state machine, wire protocol, Redis data model, matchmaking, the §10 concurrency analysis, the threat model, and §23 on what was deliberately rejected |
| [`PHASES.md`](./PHASES.md) | build order, what is done, and the trigger that pulls each deferred item in |
| [`docs/PROGRESS.md`](./docs/PROGRESS.md) | the running log: what changed each phase, what broke, and why |
| [`CLAUDE.md`](./CLAUDE.md) | working notes — the rules that override normal judgement, and the things that will bite you |
| [`docs/`](./docs) | the six product documents. `DESIGN.md` §1.2 records every place they conflicted and how each was resolved; on conflicts of fact, `DESIGN.md` wins |

## Repository layout

```
karobakbak/
├── backend/                 Node + TypeScript + ws + ioredis + pg + prom-client
│   ├── src/
│   │   ├── protocol/        wire types, validation (SOURCE OF TRUTH)
│   │   ├── redis/           keys, client, Lua scripts, typed store
│   │   ├── ws/              connections, session lifecycle, janitor
│   │   ├── moderation/      normalisation view, rules, policy engine
│   │   ├── storage/         migrations, queue, breaker, spool, repositories,
│   │   │                    deletion worker
│   │   ├── metrics/         registry
│   │   └── util/            ids, time
│   └── tests/               unit (hermetic) + integration (real everything)
├── frontend/                React + TypeScript + Vite + Tailwind, native WebSocket
│   └── src/
│       ├── protocol/        byte-identical COPY of the backend types
│       ├── state/           the UI state machine (a pure reducer)
│       ├── hooks/           useChat — socket, reconnect, typing throttle
│       ├── view/            ChatState -> layout, as pure functions
│       ├── components/      presentational only
│       ├── ads/             slot provider (no-op)
│       └── features.ts      flags for surface the server cannot back yet
├── load-test/               k6 WebSocket load test
├── monitoring/              Prometheus scrape config + alerts, Grafana
├── scripts/                 protocol drift checker
├── docs/                    product documents + PROGRESS log
├── DESIGN.md · PHASES.md · CLAUDE.md
├── .env.example             every environment variable, documented
└── docker-compose.yml       frontend, 2× backend, redis, postgres, monitoring
```

## Scope

Text only. The `type` discriminator on messages exists so a future content type
does not force a protocol version bump — it is not permission to build media.
Image, voice and video are deferred behind explicit triggers in `DESIGN.md`
§23.8, along with anonymous accounts, friend connections, premium entitlements
and a moderator console. `PHASES.md` lists each with the condition that pulls it
in.

## License

MIT
