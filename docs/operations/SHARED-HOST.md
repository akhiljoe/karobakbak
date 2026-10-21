# Sharing this box with another project

**Who this is for:** whoever — human or model — is deploying a *second*
application onto the same host that runs `karobakbak`.

**Copy this file into that project's repository.** It is written to be read
without any access to this one.

It answers five things: what is already running here, what is already taken,
the rules that are not negotiable, what you can steal, and when to stop sharing.

## Contents

1. [What already runs on this box](#1-what-already-runs-on-this-box)
2. [The box](#2-the-box) — spec, measured behaviour, swap, disk
3. [Ports already taken](#3-ports-already-taken) — and why `ufw` will not save you
4. [Rules that are not negotiable](#4-rules-that-are-not-negotiable)
5. [What you can reuse](#5-what-you-can-reuse)
6. [Room codes](#6-room-codes--the-part-karobakbak-has-no-answer-for)
7. [Your logs and karobakbak's collector](#7-your-logs-and-karobakbaks-collector)
8. [DNS, Cloudflare, and the geo-block](#8-dns-cloudflare-and-not-undoing-the-geo-block)
9. [Observability you can plug into](#9-observability-you-can-plug-into)
10. [When to stop sharing](#10-when-to-stop-sharing)
11. [Quick checklist](#11-quick-checklist)

**The four that most often go wrong**, if you read nothing else: §4.1 the shared
network, §3 the firewall that does not apply to Docker, §7 where your logs go,
and §8 publishing the origin address through DNS.

**Everything in it was checked against the running configuration**, not
remembered. Where a claim comes from a measurement, the measurement is named.

---

## 1. What already runs on this box

`karobakbak` — an anonymous, text-only, real-time random stranger chat. Two
strangers are paired over a WebSocket, either can skip or block, and
conversations are retained for thirty days for abuse investigation, then deleted
automatically.

Shape, because it determines how it behaves as a neighbour:

* **Node.js, one process, holding many long-lived WebSockets.**
* **All matchmaking state in Redis**, every transition a single Lua script.
* **PostgreSQL is write-behind and never on the hot path** — a database outage
  is not a chat outage.
* **Caddy owns `:80` and `:443`** and is the only thing on the box publishing a
  public port. Everything else is bound to `127.0.0.1`.
* Optional and currently **off**: AI personas, payments, a moderation console
  (running, on loopback), tracing.

**It is live.** Treat it as production belonging to someone else.

---

## 2. The box

| | |
|---|---|
| Name | `<vps-hostname>` |
| Spec | **2 vCPU / 2 GB RAM / 60 GB** (the size this guide was written against) |
| OS | Ubuntu 24.04 LTS |
| SSH user | `deploy` — key only, **`root` login is disabled** |
| Deploy dir | `/home/deploy/karobakbak` |

### Measured resource behaviour, not estimates

From this project's own load testing:

| | |
|---|---|
| Whole stack **idle** | **118 MiB** |
| At 2,000 concurrent chat users | **~222 MiB**, and **125.6% of one core** |
| Per active user | ~36 KB memory |
| Per idle user | ~9 KB memory |

**Two conclusions that matter to you:**

1. **CPU is the scarce resource here, not memory.** 2 GB is comfortable. Two
   cores is not, if both applications are busy at once.
2. **~85% of karobakbak's CPU is connection *maintenance*, not conversation.**
   An idle connected user costs nearly as much as an active one. So its floor
   rises with *connected sockets*, not with activity.

If your application also holds long-lived WebSockets — a room-based game, a
collaborative editor, anything with a persistent socket per user — **you are
competing for the same resource in the same way.** That is workable at low
traffic and is the first thing to give out.

### Swap, and why it matters more than the headroom suggests

There is a **2 GB swapfile** (`/swapfile`, added during first boot). So the box
has 2 GB RAM plus 2 GB swap.

Do not read that as 4 GB. Swap is a safety net against the kernel OOM-killing a
container, not capacity — and for two latency-sensitive real-time services,
**swapping is indistinguishable from an outage**. A process paged out mid-round
misses its tick.

The backend also runs with `NODE_OPTIONS=--max-old-space-size=384`, deliberately:
*"Node's default heap is sized for the machine, not the container. An explicit
limit is what makes the process fail predictably rather than being OOM-killed by
the kernel with no log line."* Consider the same for your process.

### Disk — 60 GB, and it is shared

Already consuming it: PostgreSQL, Prometheus (**30-day retention**), Loki, Tempo,
Grafana, Docker images and build cache, and the backup staging directory.

Nothing enforces a split. `docker system df` shows where it has gone. Build
caches are usually the surprise — but see §4.4 before reaching for `prune`.

---

## 3. Ports already taken

These are the defaults in karobakbak's compose files; check them, and `ss -ltnp`
on the box, before choosing. Everything below is bound to `127.0.0.1` unless
marked public. **Do not reuse any of these**, and do not publish anything on
`0.0.0.0`.

| Port | Used by | Public? |
|---|---|---|
| **80, 443** | **Caddy** | **yes — the only public ports** |
| 3000 | Grafana | loopback |
| 3100 | Loki | loopback |
| 3200 | Tempo | loopback |
| 4318 | Tempo OTLP ingest | loopback |
| 5434 | PostgreSQL | loopback |
| 6381 | Redis | loopback |
| 8081 | frontend — **dev and vps profiles only**; in production it publishes nothing and Caddy reaches it over the compose network | loopback |
| 8088 | moderation console | loopback |
| 8092 | cAdvisor | loopback |
| 9090 | Prometheus | loopback |
| 9093 | Alertmanager | loopback |
| 9121 | redis-exporter | loopback |
| 9187 | postgres-exporter | loopback |
| 12345 | Grafana Alloy | loopback |

**Safe range to pick from:** anything else. Suggested: `8100–8199` for your
application, `5435`/`6382` if you run your own PostgreSQL and Redis.

### The firewall will not save you — Docker bypasses it

The host firewall (`ufw`, `default deny incoming`, with only SSH and the web
ports allowed) looks like a safety net under a mistake in your compose file.
**It is not.**

Docker writes its own `iptables` rules in the `DOCKER` chain, which is evaluated
*before* ufw's. A container publishing `0.0.0.0:8100` is reachable from the
internet even though `ufw status` shows the port denied — and it will keep
showing denied, so the check you would run to reassure yourself returns the
wrong answer.

**Therefore: always bind explicitly to loopback.**

```yaml
ports:
  - "127.0.0.1:8100:8100"      # correct
  - "8100:8100"                # WRONG - public, and ufw will not tell you
```

Verify from *off the box*, never from on it:

```bash
curl -sS -m 5 http://<vps-ip>:8100/     # must fail
```

`ss -ltnp` on the box shows which interface each listener is on. `0.0.0.0:` in
the local-address column is the alarm; `127.0.0.1:` is correct.

---

## 4. Rules that are not negotiable

### 4.1 Never join karobakbak's Docker network

**Its Redis has no password.**

```yaml
command: ["redis-server", "--save", "", "--appendonly", "no", "--maxmemory-policy", "noeviction"]
```

No `requirepass`, deliberately — it is unreachable from outside the compose
network, so authentication would be ceremony. **That assumption breaks the
moment a second application joins that network.**

Anything on it can read every live session, every match, every block — and
`PUBLISH` into the per-session Pub/Sub channels, which are the *routing keys*.
That means injecting fabricated events at real users mid-conversation.

So:

* your own `docker compose` project, with `-p <yourname>`,
* its own default network,
* **never** `networks: { external: true }` pointing at karobakbak's,
* **never** `network_mode: service:` or `container_name` references into it.

### 4.2 Run your own PostgreSQL and Redis

Do not share the instances. Three reasons, in order:

1. **One outage takes both sites.** karobakbak survives a PostgreSQL outage by
   design; your app probably does not.
2. **karobakbak's database has a deliberate least-privilege role model** —
   `karobakbak_app` cannot touch `admin_accounts`, `karobakbak_console` cannot
   delete a conversation, and both are asserted by tests against real
   PostgreSQL. A second application's migrations wandering in undoes that
   quietly.
3. **Separability.** Two isolated stacks on one host split later in an
   afternoon. Two stacks sharing a database is a project.

Extra containers cost about 55 MiB combined at idle. That is not the constraint.

### 4.3 Do not publish ports; go through Caddy

Caddy already terminates TLS and holds `:80`/`:443`. Adding a site is one block
in `ops/caddy/Caddyfile` **in the karobakbak repository**:

```
yourgame.com {
	reverse_proxy yourgame-frontend:80
}
```

Certificates are automatic per hostname. **You do not own that file** — the
change is made in karobakbak's repo and deployed with it. Coordinate rather than
editing it on the box, or the next `git pull` silently reverts you.

For Caddy to reach your container across projects, attach *only your frontend*
to a shared front-end network — not your database, not your Redis. That is the
one deliberate exception to §4.1, and it should carry no state.

### 4.4 Announce and scope every restart

`docker compose down` in the wrong directory takes a live chat service with it.

* Always `-p <yourproject>` or run from your own directory.
* Never `docker system prune -a` — it will remove karobakbak's images.
* Never `docker network prune` while both are up.
* Say so before you restart anything shared.

### 4.5 Your backups are yours

`ops/backup/` in the karobakbak repo backs up **karobakbak's** PostgreSQL only —
dump, encrypt, copy to Cloudflare R2, prune. It knows nothing about you. If your
data matters, write your own job.

One inherited lesson worth taking free: **secrets written on Windows carry a
carriage return**, which is invisible and silently breaks decryption. A backup
passphrase with a `\r` produced archives that were provably undecryptable while
every local drill passed, because backup and restore read the same broken file.
Generate secrets with `printf`, never an editor.

---

## 5. What you can reuse

karobakbak's WebSocket foundation has been load-tested to 2,000 concurrent users
and chaos-tested against database and Redis failure. If your application is
room-based and real-time, most of these problems are the same problems.

**Copy the patterns. Do not import a shared library** — a shared package couples
your deploys, and you would be unable to ship without rebuilding chat.

| Pattern | Where it lives | Why you want it |
|---|---|---|
| **State transitions as Lua scripts** | `backend/src/redis/scripts.ts` | Redis runs one script to completion. Two players taking the last slot, or a host starting while somebody joins, is the same race as matchmaking. Read-then-write from the application has a gap; a script does not |
| **Pub/Sub channel per entity** | `backend/src/ws/subscriber.ts` | Publish to `ev:room:{code}` and whichever process holds the socket receives it. **No routing table means nothing can go stale.** Subscribe *before* the entity exists, or you lose events for whoever was quickest |
| **Resume token** | `DESIGN.md` §28 | Phones drop wifi mid-round. A seat held for ~20 seconds, keyed by a rotating single-use token presented as a **WebSocket subprotocol** (a browser cannot set headers, and a query string lands in access logs). Losing your place because a lift ate your signal is the worst bug a party game can have |
| **Janitor + TTLs** | `backend/src/ws/janitor.ts` | The host disconnects and the room is orphaned. TTLs handle expiry; a leader-locked sweep handles anything needing a *decision* |
| **Closed protocol lists, validated both sides** | `backend/src/protocol/` | A value added to a list is a server change, not a UI change — the old validator refuses it and fails the whole frame |
| **Admission bands** | `backend/src/ws/upgrade.ts` | Reserve the last few connection slots for *reconnections*. Refusing a newcomer costs one session that never started; refusing a reconnection destroys a live game for everyone in the room |
| **Backpressure, strikes, per-command rate limits** | `backend/src/ws/connection.ts` | Slow consumer closed at a buffer threshold; N malformed frames closes the socket; every command has its own token bucket |
| **A logger that refuses user content** | `backend/src/logger.ts` | A recursive field denylist that throws outside production. Player-typed answers are user content |
| **Metrics discipline** | `backend/tests/unit/metrics-wiring.test.ts` | A test fails any metric declared and never written. A declared-and-dead metric is worse than an absent one: it is charted, reads zero, and is believed |

---

## 6. Room codes — the part karobakbak has no answer for

Nothing here maps onto this, and it is where a party game usually goes wrong.

**A room code is your entire access control.** Four uppercase letters is about
450,000 combinations, which is trivially enumerable — a script walks every code
and joins strangers' games. Decide before launch:

* longer or mixed-alphabet codes,
* rate-limit joins per IP (karobakbak's `connRateLimit` Lua is the shape),
* expire codes quickly once a game starts,
* or make the host admit players.

**Generate them server-side from `crypto.randomBytes`** — never a counter, never
anything client-supplied. `backend/src/util/ids.ts` is the pattern. Exclude
ambiguous characters (`0`/`O`, `1`/`I`/`l`); people read these aloud.

---

## 7. Your logs and karobakbak's collector

**Read this before your first deploy.**

Grafana Alloy runs on this box with the Docker socket mounted, and discovers
containers by label:

```
filter {
  name   = "label"
  values = ["com.docker.compose.project=" + sys.env("ALLOY_COMPOSE_PROJECT")]
}
```

That filter matches **only containers in karobakbak's own compose project**
(`ALLOY_COMPOSE_PROJECT` is set from compose's `COMPOSE_PROJECT_NAME`). An
earlier version matched any container with a compose-project label, so check
`monitoring/alloy/config.alloy` on the box before relying on this.

**Two consequences:**

1. **Your logs are not collected for you.** If you want them in Loki, run your
   own collector or ask for a second discovery block, and use your own
   `project` label.
2. **If they ever are shipped into karobakbak's Loki, they land in a shared
   store** that this project pays to keep, and that `verify:logs` reads back
   and fails on addresses, credentials and denied field names. karobakbak
   treats user content as never loggable: not a log line, not a metric label,
   not a tracing span.

**Either way, do not log player-typed content, room codes, or session
tokens.** A room code in a log is a join credential sitting in a store.

---

## 8. DNS, Cloudflare, and not undoing the geo-block

karobakbak resolves through **Cloudflare**, which is where its edge controls
(including any country blocking) happen, before a request reaches the box.

That protection holds only while **the origin address is not publicly known.**

So: if you point `yourgame.com` at `<vps-ip>` with a plain, unproxied A
record, you have published karobakbak's origin. Anyone can then reach the box
directly and bypass Cloudflare entirely, including its edge controls, some of
which are compliance controls rather than preferences.

**Proxy your DNS record too** (orange cloud), or use a separate address. Do not
put the raw IP in anything public: not a repository, not a support ticket, not a
DNS record that resolves to it directly.

---

## 9. Observability you can plug into

Prometheus, Grafana, Loki, Tempo and Alertmanager are already running and can
serve both projects.

* **Metrics:** expose `/metrics` on your container and add a scrape target to
  `monitoring/prometheus/prometheus.yml` (karobakbak's repo). Use your own
  metric prefix — never `chat_`.
* **Dashboards:** Grafana at `127.0.0.1:3000`, reachable over an SSH tunnel.
  Make your own folder.
* **The one metric to share:** event-loop lag p99. karobakbak alerts at 0.25s.
  **This is how you will see the two applications competing** — CPU contention
  shows up as latency jitter long before it shows as a failure.
* **Alertmanager is shared**, and there are 33 rules already — 13 of them
  `severity: page`. If you add alerts they reach the same person through the
  same route. Match the existing convention: `page` means wake somebody,
  `ticket` means look tomorrow. **An alert that fires on a healthy system gets
  the whole channel muted within a week**, and that channel is not only yours.
* **cAdvisor is running** (`127.0.0.1:8092`) and gives per-container CPU and
  memory. That is the honest way to answer "which of us is using the box",
  rather than arguing from application metrics.

---

## 10. When to stop sharing

Agree the trigger **now**, while nothing is wrong. A trigger decided in advance
is one you act on; one decided during an incident is one you argue with.

Suggested:

* sustained **event-loop p99 above 100 ms** on either service, or
* **combined CPU above 70%** of the box, or
* either service refusing connections at capacity.

Because both stacks are isolated, splitting is: bring up a new droplet, `docker
compose up` your project there, restore your volume, repoint DNS. Hours.

**One timing note:** karobakbak went live on 7 September 2026. Deploying a
second service in the same week makes every resource question ambiguous — was
that the new app, or real traffic arriving? A week of baseline first is worth
more than a week of guessing later.

---

## 11. Quick checklist

* [ ] Own compose project (`-p`), own network, own volumes
* [ ] Own PostgreSQL and Redis containers
* [ ] No port from §3 reused, nothing published on `0.0.0.0`
* [ ] Caddy site block added in karobakbak's repo, not on the box
* [ ] Only the frontend attached to any shared network
* [ ] Own backup job
* [ ] `/metrics` exposed, own prefix, scrape target added
* [ ] Event-loop lag on a Grafana panel for both services
* [ ] Split trigger written down
* [ ] Never `docker system prune -a`
* [ ] Verified from **off the box** that nothing of yours answers publicly
* [ ] DNS record proxied, so the origin address stays unpublished
* [ ] Not logging player content, room codes or tokens
* [ ] Node heap capped, so your process fails predictably rather than being
      OOM-killed

---

*Written from the karobakbak repository, 6 September 2026. The numbers come from
`docs/testing/RESULTS.md`; the deployment facts from
`docs/operations/FIRST-BOOT.md` and the compose files.*
