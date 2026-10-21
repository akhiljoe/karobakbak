# Deployment — what runs on the VPS, what does not, and how code gets there

> **Since 2026-10-10 production does not run on a VPS.** The droplet was deleted
> and the site runs on a single host behind a Cloudflare Tunnel
> (`docker-compose.laptop.yml`, deployed as `DEPLOY.md` describes). This
> document still holds for a VPS and is the path back if the site outgrows a
> single host.

A plan, written before the work, in the shape `docs/operations/CONFIGURATION.md` ended up
in: the reasoning first, then the phases, then what could go wrong.

It answers three questions that arrived together and are actually separate:

1. Can the monitoring move off the VPS so it stops consuming compute?
2. Can data be pulled periodically and read on a laptop instead?
3. Do we need dev and prod set up in git, for CI/CD?

Short answers: **the console is already free, the dashboards cost nothing
measurable and stay, and the VPS building the project on every deploy is a
reliability problem rather than a cost one.** And no, dev and
prod should not be branches.

§3.2 revises an earlier recommendation in this same document. It said Grafana
should move off the box; that was argued from idle memory, memory is not the
constraint on any tier being considered, and moving Grafana does not move the
query cost anyway. The correction is kept rather than edited away, because the
reasoning error is the useful part.

---

## 1. What the box actually spends

Measured with `docker stats` on the development stack, idle, 2026-09-03:

| Container | CPU | Memory |
|---|---|---|
| prometheus | 0.00% | 74 MiB |
| grafana | 0.12% | 72 MiB |
| alloy | 0.44% | 66 MiB |
| loki | 1.25% | 62 MiB |
| tempo | 0.38% | 26 MiB |
| cAdvisor | 0.00% | 26 MiB |
| redis + postgres exporters | 0.00% | 18 MiB |
| **the application** (2 backends, frontend, redis, postgres) | ~10% | **155 MiB** |

Two things follow, and only one of them is the thing that was asked about.

**At idle, observability costs memory rather than CPU.** Production already
omits Loki, Tempo, Alloy, cAdvisor and the exporters, so what is actually on the
box is Prometheus (74 MiB), Grafana (72 MiB) and Alertmanager. On a 1 GB VPS
that is a real fraction of the margin; in CPU terms it is close to noise while
nothing is querying.

**The build is not a cost, and an earlier draft of this document said it was.**
`docker-compose.prod.yml` still declares `build:`, so deploying compiles the
whole project on the VPS — `npm ci`, `tsc`, a vite bundle — on the one core the
capacity measurement is about. That was written up as "the biggest compute
cost", which contradicts a rule this project already had:

> The cost deck is priced in **provisioned capacity, not consumed**. A fixed VM
> costs its vCPU count whether it is busy or idle. — `CLAUDE.md`

A monthly-billed VPS costs the same whether it spends four minutes compiling or
four minutes idle. The build is occasional, bounded, and free in rupees. What it
actually costs is in §4.1, and none of it is money.

---

## 2. The console is already free, and cannot move

The moderation console is not a compose service in any file. It is
`ADMIN_CONSOLE_ENABLED=true npm run console`, its own process on its own port,
bound to loopback, started when somebody needs it (`operations/OPERATIONS.md` §1401). **It
consumes nothing when it is not running**, which is most of the time.

It also cannot usefully move to a laptop, and the reason is the design rather
than the deployment. The console *acts*: it issues bans, it resolves a report's
subject on the server because no route may accept an identity hash (§25.3), and
every transcript read writes an audit row **before** the content is selected, in
the same transaction (D33). A copy running against a downloaded snapshot could
read but not enforce, and the audit trail — which is the only remaining control
on reading a stranger's messages once persona browsing is unrestricted
(D-AI-12) — would be split across two places.

So: **viewing moves, acting does not.** The console stays, reached through an
SSH tunnel, off by default.

One improvement worth making while nearby: it is started by hand with `npm`,
which means the production box needs a source tree and a toolchain for a process
that already exists inside the backend image. A compose profile
(`docker compose --profile console up -d admin`) would run it from the published
image on demand and shut it down after. That belongs to phase 2 below, because
it only becomes possible once the box has images rather than source.

---

## 3. Where the data should live

### 3.1 Prometheus stays

It is the only component that can *record*. Alerts are expressions over it, and
a laptop that is closed cannot scrape. Retention on the box drops once snapshots
go off-host — 30 days of TSDB is being kept for a question nobody asks locally.

### 3.2 Grafana — measure before moving it (revised)

**The first version of this document said Grafana should leave the box. That was
argued from idle memory, and idle memory is not the constraint.** Phase 35
measured the tiers directly (`RESULTS.md`, 2026-09-02): the whole application
path idles at 118 MiB and reaches ~222 MiB at 2,000 concurrent users, ten
thousand users project to ~360 MB, and **CPU stops this service long before
memory does**. On the 1 GB tier that leaves roughly 600 MB unused at a load
nobody is close to. Spending 72 MiB of it on a dashboard is not the expensive
decision it was made to sound like.

Worse for the original argument: **moving Grafana off the box does not move the
query cost.** Grafana renders; PromQL is evaluated by Prometheus, which stays
either way. A laptop Grafana pointed through a tunnel at the VPS Prometheus
sends exactly the same queries to exactly the same process. What moving it
actually saves is Grafana's own resident memory and its render loop — real, but
small, and not the thing that was implied.

The convenience argument is a wash too. Grafana is loopback-only in production
(`ports: !override`, and the compose comment says why), so it is reached through
an SSH tunnel *either way*: `-L 3000:` to the box's Grafana, or `-L 9090:` to
its Prometheus with Grafana running locally. Neither is meaningfully easier.

So the honest position: **there is no measured reason to move it, and it should
stay until there is one.** What is missing is a number, and the rig to get it
already exists.

### 3.2.1 Measured, 2026-09-03 — and the answer is "no measurable cost"

Run on the VPS rig with **every container pinned to core 0**, including the
observability stack. That pinning is the whole validity of the experiment:
`docker-compose.vps.yml` pins only the five services production runs, so leaving
the rest unpinned would have let them use the development machine's other seven
cores and produced the answer "observability is free", confidently and wrongly.

Five runs per arm, same seed, same parameters as the phase 35 baseline
(2,000 bots, 60s, `realistic`, seed 101, six harness workers).

| | stack off | stack on |
|---|---|---|
| ack p99, five runs | 273, 273, 387, 414, 615 ms | 328, 404, 441, 758, 806 ms |
| **median** | **387 ms** | **441 ms** |
| messages delivered, median | 9,438 | 9,410 |
| observability CPU during load | — | **~4.4% of one core** (alloy 2.1, cAdvisor 1.0, Prometheus 0.7, Loki 0.6) |
| observability memory | — | **231 MiB** beyond Prometheus |
| combined CPU, mid-run sample | ~60% | ~69% |

**The honest reading: the difference is not separable from the noise.** The
medians differ by 54 ms (+14%), and the spread *within* each arm is 342 ms and
478 ms respectively — larger than the difference between them. Throughput is
indistinguishable: 9,438 against 9,410 messages.

Two things are measured cleanly, because they are direct rather than derived:

* The stack consumes **~4.4% of one core** while 2,000 users are talking.
* It holds **231 MiB** beyond Prometheus, on a tier where the application peaks
  around 222 MiB and ten thousand users project to ~360 MB.

**So it stays on the box.** There is no evidence it costs capacity, the memory
is available, and the alternative — Grafana on a laptop through a tunnel — was
already shown not to move the query cost anywhere.

### 3.2.1.1 What this experiment cannot support, and why

Both arms drift *worse with run order* (off: 273 → 615 → 273 → 414 → 387; on:
404 → 328 → 441 → 758 → 806). Runs are not independent: the stack accumulates
Postgres rows, retention-queue state and Prometheus TSDB across them, and the
harness's six workers compete for the machine's remaining cores with whatever
else it is doing.

That confound is worth more than the number. **Any future capacity comparison on
this rig has to reset the stack between runs, or interleave the arms, or both** —
otherwise run order is a variable nobody declared, and the arm that happens to
run second loses.

The 273 ms in the first stack-off run is also 55% faster than the phase 35
baseline's 598 ms at the same parameters, which is a further reminder that these
numbers are comparable *within a session* and not across them.

### 3.2.2 If the measurement says something has to go

Not all of it costs the same, and the order is not the order of memory use.

| Component | Idle | What it costs beyond idle | Verdict |
|---|---|---|---|
| **Tempo** | 26 MiB | Nothing — `TRACING_ENABLED` is false by default, so it receives no spans | **Should follow the flag.** Running a container for a disabled feature is waste at any tier, independent of this whole question |
| **Loki + Alloy** | 128 MiB | The only continuous work in the set: Alloy tails and ships every log line, Loki indexes and writes them. CPU *and* disk, both proportional to traffic, on a box whose disk is small | First to drop, if anything drops. But logs are the most useful thing in an incident, and `npm run verify:logs` reads them back to prove the hygiene controls hold — so tighten retention before dropping the pipeline |
| **cAdvisor** | 26 MiB | Per-container CPU and memory, which on a one-core box is exactly the signal that explains a slowdown. Note it reports nothing useful on Docker Desktop/WSL2 (root cgroup only) — it is more valuable on the real VPS than it looks here | Keep |
| **redis / postgres exporters** | 18 MiB | Two scrapes per interval | Keep. Cheapest useful thing on the list |
| **Grafana** | 72 MiB | A render loop while a dashboard is open; queries land on Prometheus regardless | Keep unless the measurement says otherwise |
| **Prometheus** | 74 MiB, and the one that **grows** with series count and retention | Query evaluation, which is where dashboard cost actually lands | Stays regardless — it is the recorder, and alerts are expressions over it |

The one change worth making without waiting for a measurement is Tempo: gate the
container on `TRACING_ENABLED` so a disabled feature does not hold memory.

### 3.3 Snapshots, so history survives the box

A periodic Prometheus snapshot, tarred, and pushed through the same rclone
remote the database backups already use (`ops/backup/backup.sh`,
`BACKUP_REMOTE`). That is the literal request — take data periodically, read it
on a laptop — and it buys two things beyond convenience: history survives the
VPS dying, and the laptop can browse a window without a live tunnel.

Two facts to design around:

* **The snapshot API is not enabled today.** Prometheus needs
  `--web.enable-admin-api`. In production it publishes no port at all, so the
  API is reachable only from inside the compose network; that is acceptable, and
  it must stay that way — the admin API can delete series.
* **A metrics snapshot is not a database dump.** Rule 1 forbids message content
  in a Prometheus label *or value*, and `metrics-wiring.test.ts` plus the
  registry's own rules keep `conversation_id` out of labels entirely. So a
  snapshot carries counts and timings, not user content. It should still be
  encrypted in transit and at rest, because the backup path already does that
  and a second path with weaker rules is how the weaker one gets used by
  mistake — but the *reason* is uniformity, not exposure.

### 3.4 Alertmanager stays

"I check when I remember" is fine for trends and useless for an outage. It is
small, and it is the difference between noticing in minutes and noticing when
somebody complains.

---

## 4. How code should get to the box

### 4.1 What building on the box actually costs

Not money. On a fixed monthly VPS the compute is already paid for, and a deploy
is minutes. Four things, ranked by whether they matter *now* rather than by how
bad they sound:

| | Real? | Matters when |
|---|---|---|
| **The artifact deployed is not the one CI tested** | Yes, and it is the only one independent of machine size | Always. It is the argument that would hold on a 64-core box |
| **Rollback is a recompile** | Yes — minutes, at the moment you are rolling back *because production is broken* | From the first real user |
| **OOM risk during deploy** | Plausible and **unmeasured**: `tsc` and esbuild can want 300–600 MB on top of ~222 MB of application and ~165 MB of Prometheus and Grafana, on a 1 GB tier | Now, if it happens — the OOM killer picks a victim mid-deploy and it may not be the build |
| **Latency spike for live users while it compiles** | Yes, on one core | Once there are users to disturb. Not before |

**So the honest case for publishing images is provenance and rollback speed, not
compute.** Pre-launch, building on the box is defensible: there is nobody to
disturb, and CI publishing plus a registry plus deploy credentials is real work
for a benefit that is mostly latent.

The one thing worth checking before deferring it is the OOM row, because it is
the only entry that can take the service down rather than slow it: build on the
pinned one-core rig with the stack running and watch peak memory. If it fits,
D1 is genuinely deferrable. If it does not, D1 stops being about compute and
becomes about not crashing during a deploy.

### 4.2 The shape instead

```
git tag v1.2.3
      │
      ▼
GitHub Actions ── verify + integration (already exist)
      │
      ├── build backend image  ──►  ghcr.io/akhiljoe/karobakbak-backend:v1.2.3
      └── build frontend image ──►  ghcr.io/akhiljoe/karobakbak-frontend:v1.2.3
                                          │
                                          ▼
                          VPS: docker compose pull && up -d
                          (two compose files and an env file — no source tree)
```

* **Immutable tags, never `latest`.** A box that pulls `latest` cannot answer
  what it is running, and "the same command produced a different result" is the
  failure this project has already had twice with stale bundles.
* **Rollback is a deploy of the previous tag.** No rebuild, no branch.
* **Migrations keep their ordering.** The `migrate` service already runs with
  its own credentials before the backend starts; it becomes another image pull.

### 4.3 The sharp edge: the frontend image is environment-specific

`VITE_` values are inlined at build time (`operations/CONFIGURATION.md` §2.2). A published
frontend image therefore **contains** one environment's terms URL, privacy URL,
contact address and support link. There is no way to publish one frontend image
and configure it per environment without changing how the client reads config.

Two honest options:

1. **Build the frontend image in CI with production's values.** They are public
   strings, not secrets — the published Terms URL is on the page. CI holds them
   as environment variables and the image is tagged for the environment it was
   built for. Simple, and the values are already required at build in
   `docker-compose.prod.yml`.
2. **Make them runtime.** nginx serves a small `/config.json` the app fetches
   before first render. One image for every environment, at the cost of a
   request before first paint and a new failure mode (config fetch fails → what
   does the age gate link to?).

**Recommendation: (1) now, (2) never unless a second environment appears.** The
cost of (2) is paid on every page load, for a problem one deployment does not
have.

### 4.4 Why not dev and prod branches

Because the environment axis is already `compose overlay + env file`, and it is
now fully wired end to end. A branch per environment adds a second axis for the
same distinction, and the two drift the first time a fix lands on one and not
the other. The symptom is the worst kind: an environment that differs from the
one that was tested, in a way `git diff` between two long-lived branches makes
tedious to see.

Trunk-based is also what the history already is — every phase is a `--no-ff`
merge into `main` with the reasoning in the merge commit. Tags are the release
mechanism; the artifact is promoted, not the source.

---

## 5. The phases

| Phase | Scope | Done when |
|---|---|---|
| **D1** | CI builds and publishes both images on a tag; prod overlay consumes `image:` with `build: !reset`. **Justified by provenance and rollback speed, not by compute** (§4.1) — and deferrable pre-launch if the build is measured to fit in memory beside the running stack | A tagged commit produces two images, and `docker compose -f … config` on the prod overlay shows no `build:` key |
| **D2** | Deploy without a source tree: a `deploy/` directory holding the two compose files, an env file and nothing else; console as a compose profile | The VPS can be rebuilt from a registry pull, an env file and a volume restore |
| **D3** | ~~Measure what observability costs on one core~~ **done, 2026-09-03 (§3.2.1): no separable latency or throughput cost, ~4.4% of a core and 231 MiB. Everything stays.** What remains is gating Tempo on `TRACING_ENABLED` | Tempo does not start when tracing is off |
| **D4** | Prometheus snapshot → encrypt → rclone, on the existing backup cadence; `--web.enable-admin-api` with no published port; retention on the box reduced | A snapshot restores into a local Prometheus and the dashboards render history without the VPS |
| **D5** | Repo cleanup by rule (below) | **Deferred by the operator (3 Sep 2026):** a larger documentation cull is planned before launch, so tidying now would be done twice. §6 is the rule to do it by when that happens |
| **D6** | A guard: prod compose must not contain `build:`, and the deploy directory must not reference a source path | `npm run verify` fails if production regresses to building on the box |

D6 matters more than it looks. Every other item in this plan is a state that
drifts back silently — the reason `verify-config.mjs` exists is that F-045 was
found by accident, months late.

---

## 6. The cleanup, and the rule to do it by

Nothing below ships today: the images build from `./backend` and `./frontend`
only, so this is repository hygiene rather than deploy weight. It is last on the
list for that reason, and it is **deferred on purpose** — the operator intends a
larger documentation cull before launch, and a tidy now would be undone by it.
What follows is the inventory and the rule, ready for that pass.

| Directory | Tracked files | Disposition |
|---|---|---|
| `security-test/` | 8 | ZAP/nuclei configuration. Keep — it is cited by the security phase and run deliberately |
| `load-test/` | 52 tracked (723 MB on disk, mostly `node_modules`) | Keep. The swarm is a first-class tool; the disk is untracked dependencies |
| `docs/*-prompt*.md` | 5 | Generation prompts for documents that now exist. Keep only if regenerating is still plausible; otherwise they describe a process, not the system |
| `docs/karobakbak-*.md` | 6 | The original product briefs. Keep — `DESIGN.md` §1.2 resolves against them and that table is only meaningful while they exist |

**The rule:** a file stays if it is shipped, executed by a script or test, or
cited by a document that is itself cited. Anything else is a candidate, and the
question to ask is not "is this useful" but "what reads it".

---

## 7. What could go wrong

* **A frontend image built with the wrong environment's values.** Silent: the
  page renders, and the age gate links to a Terms URL that 404s. Mitigation: the
  image tag names the environment, and the deploy asserts the tag it pulled.
* **`latest` creeping in.** A box that cannot say what it runs is the stale
  bundle trap with a bigger blast radius.
* **The admin API published.** Prometheus's admin API can delete series. It must
  stay unpublished; production already publishes no port for it, and D4 must not
  change that to make snapshotting easier.
* **A snapshot treated as a backup.** It is metrics, not data. The database dump
  is the backup; a Prometheus snapshot restores dashboards, not the service.
* **Deploying with no rollback tested.** The first rollback must happen on
  purpose, before it happens under pressure.
* **The build guard being added and then bypassed** with a `build:` in a third
  overlay. The check must read the merged config, not one file.

---

## 8. What this does not change

* The console stays on the VPS, off by default, reached by tunnel. Acting is not
  something a laptop can do.
* Prometheus stays on the VPS. Recording is not something a laptop can do.
* Alerting stays. Periodic checking is not monitoring.
* Environment separation stays `compose overlay + env file`. Git branches are
  not environments.
