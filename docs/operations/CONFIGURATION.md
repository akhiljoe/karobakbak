# Configuration — how it works, where every value lives, and what is still hard-coded

This is the standing answer to "where do I change X", and to "did that change
actually do anything". It also records the work that produced it (F-045,
phase 38) and what remains.

Read `CLAUDE.md` first for the rules that override normal judgement. The one
that started all of this:

> `docker compose --env-file X` does not put anything into a container. It
> populates `${VAR}` substitutions in the YAML, and nothing else.

---

## 1. The short version

* **One file per deployment.** `.env` for development, `.env.loadtest`,
  `.env.vps`, `.env.prod` for the others. `.env.loadtest` and `.env.vps` are
  copied from their `.example` templates on first use
  (`scripts/ensure-env.mjs`). `.env.example` documents every name that exists.
* **One place for every default:** `backend/src/config.ts` for the server,
  `frontend/src/config.ts` for the browser. Compose passes values, never
  defaults.
* **Nothing is a setting until it arrives.** `npm run verify` fails if a setting
  is readable but undeliverable, undocumented, or declared and read by nothing.
* **Verify by asking the running process**, never by re-reading the file you set
  it in. That mistake hid F-045 for months.

---

## 2. How a value gets from the file to the code

There are two paths and they behave differently. Confusing them is how values go
missing.

### 2.1 The backend path — runtime

```
.env
  │
  │  (a) docker compose reads it for ${VAR} substitution in the YAML
  │      — this is what --env-file does, and ONLY this
  │
  │  (b) env_file: ${APP_ENV_FILE:-.env}   ← the line that puts it in the container
  ▼
container environment  ──►  loadConfig(process.env)  ──►  Config object
                                     │                         │
                              assertCoherent()           passed down explicitly
                              configWarnings()           (never a module singleton)
```

`(a)` and `(b)` are separate mechanisms reading the same file for different
jobs. Before phase 38 only `(a)` existed, so a service received exactly the
names written out by hand under `environment:` and every other setting was inert
— settable, documented, and silently running on its compiled-in default.

**`APP_ENV_FILE` is why the path is not simply `.env`.** Each profile is invoked
with its own `--env-file`, so a fixed path would have served development values
to the load stack, the VPS rig and production. Each env file sets `APP_ENV_FILE`
to its own name — self-referential on purpose, so the value arrives by the same
mechanism it configures, and a profile that forgets the line falls back to
`.env` rather than to nothing. `required: false`, because `.env` is not tracked
and a fresh clone must still start.

**`environment:` still wins over the file.** That is the documented precedence,
and it is what keeps the topology authoritative: the service hostnames, and the
per-replica `INSTANCE_ID` that two containers must never share.

Changing a backend value needs a **restart**, not a rebuild.

### 2.2 The frontend path — build time

```
.env
  │  compose build.args:  VITE_X: "${VITE_X:-}"
  ▼
Dockerfile ARG VITE_X  ──►  ENV VITE_X=$VITE_X  ──►  vite inlines it into the bundle
                                                              │
                                        loadClientConfig(import.meta.env)
```

A `VITE_` value has to exist in **three** places: the compose `build.args`, a
Dockerfile `ARG`, and the `ENV` that hands the ARG to the build. **An ARG alone
is invisible to vite.** Drop any one of the three and the bundle ships the
compiled default with nothing to show for it.

Changing a frontend value needs a **rebuild** (`docker compose up --build`), and
the only honest verification is grepping the served bundle.

### 2.3 The other two surfaces

| Surface | Read by | Changing it needs |
|---|---|---|
| Ops shell scripts | `ops/backup/backup.sh`, `ops/caddy/Caddyfile` | nothing |
| Third-party images | Grafana, Postgres, the exporters | a restart |

These read their own names straight from the environment. They are out of scope
for `config.ts` and for the guard: they have no compiled-in default to fall back
to silently, which is the failure mode everything above defends against.

---

## 3. Where the constants actually live

### 3.1 `backend/src/config.ts` — 2,061 lines, 27 groups, 215 fields

One `Config` interface, grouped by subsystem: `http`, `redis`, `limits`, `ttl`,
`timers`, `matchmaking`, `preference`, `blocks`, `admin`, `personas`, `auth`,
`payments`, `enforcement`, `resume`, `moderation`, `database`, `retention`,
`breaker`, `spool`, `deletion`, `tracing`, `cost`, `backup`, `janitor`,
`presence`, `metrics`, `security`.

Every field is read through a typed helper that validates as it parses:

| Helper | Refuses |
|---|---|
| `int(env, NAME, default, min, max)` | non-integers, out-of-range |
| `num` | non-numbers, out-of-range |
| `str`, `list`, `path`, `segment` | a value that cannot have the required shape |
| `bool` | anything but a clean true/false |
| `moderationAction`, `knownRules`, `spoolBackend`, `logLevel` | a value outside the closed set |
| `rateLimit(env, PREFIX, rate, burst)` | builds `PREFIX_RATE_PER_SEC` and `PREFIX_BURST` |

An empty string is treated as absent, which is what makes `${NAME:-}` in the
YAML mean "the process decides".

Three rules that are not obvious from reading it:

* **`loadConfig(env)` is a pure function of its arguments**, called once in
  `index.ts`; the `Config` is then passed down explicitly. There is no
  `export const config = loadConfig()`. A test builds its own, and
  `connectionCeiling` takes the core count as a *parameter* so a test can
  describe a box it is not running on.
* **`assertCoherent(config)` holds 43 cross-field checks.** Adding a limit
  usually means adding one: a heartbeat that is not comfortably below the
  session TTL silently expires live sessions, and
  `PERSONA_MAX_CONCURRENT ≥ MAX_CONNECTIONS_PER_IP` is a cap that looks applied
  and is not.
* **`configWarnings(config)` is the softer half** — printed at startup for
  states that are legal but worth seeing.

### 3.2 `frontend/src/config.ts` — the browser's `ClientConfig`

The same shape, smaller: URLs, flags, and a `timings` group. Its readers
(`readNumber`, `readNumberList`) **refuse rather than clamp** a bad value,
because a build-time number cannot be corrected without another build: a `0`
would turn the reconnect backoff into a spin and every timeout into an instant
failure, and both present as a broken server rather than as a bad setting.
`readNumberList` falls back to the *whole* backoff curve rather than a
partially-parsed one, because the shape is the point — the last entry repeats
for every attempt after it.

### 3.3 Values that live in the module that owns them

Some values are typed constants exported so `config.ts` can use them as its
default. `DEFAULT_CADENCE` in `personas/cadence.ts` is the example: fifteen
numbers describing how a persona reads, types and pauses. Config reads its
defaults **from** that object, so there is still exactly one place the shipped
value lives, and a test asserts the two agree — otherwise personas would be
paced one way in production and another in every test, with nothing failing.

---

## 4. Adding a setting

1. Add the field to the `Config` interface, in the group it belongs to, with a
   comment saying what breaks if it is wrong.
2. Read it in `loadConfig` with the right helper, giving the current constant as
   the default and a range that refuses nonsense.
3. Add a cross-field check to `assertCoherent` if it can disagree with another
   setting.
4. Thread it to the code that used the constant. **Do not** read config at
   module scope — take it as a parameter, or off the `Config` already being
   passed.
5. Document it in `.env.example`, with the reasoning, not just the number.
6. For a `VITE_` value, add it to the compose `build.args` **and** the Dockerfile
   `ARG`/`ENV` pair.
7. Run `npm run verify`. It fails on steps 5, 6, and on a field nothing reads.

---

## 5. Is it complete?

**For everything that is a setting: yes.** 217 backend names and 15 `VITE_`
names are documented, delivered and read, and the guard fails the build if that
stops being true.

**One gap was found while writing this document**, and it is worth recording
because it is the same bug inside its own fix: `PERSONA_REASONING_HEADROOM_TOKENS`
was added to `Config`, documented in `.env.example`, and delivered to the
container — and read by nothing, because the value was never threaded into the
OpenAI adapter, which went on using its own module constant. Every check written
at the time passed. It is wired now, and §7 check 3 covers the class.

### What is still a constant, and why

Each of these is a decision rather than a preference. A setting is a promise that
changing it is safe, and none of these are.

| Where | What | Why it stays |
|---|---|---|
| `protocol/types.ts` | `PROTOCOL_VERSION`, event names, `INTENTS`, `COUNTRY_NAMES`, error codes | Wire contract, validated on both sides, and both sides ship together. A closed list one deployment widens fails the **whole** frame, not one field |
| `redis/scripts.ts` | preference weights (gender 4, country 2, intent 1) | A decision a test reads out of the Lua, and a metric decomposes the score against them. An env var would silently re-rank matching and mislabel every metric downstream |
| `logger.ts` | denylist, depth, truncation limits | The primary I8 control. A setting that can widen them is a setting that can disable them |
| `admin/password.ts` | scrypt cost, block size, key and salt lengths | Changing them invalidates every stored hash. That is a migration, not a tunable |
| `admin/totp.ts` | base32 alphabet, secret length | Specification constants |
| `metrics/registry.ts` | histogram buckets | Dashboards and recording rules are written against these exact boundaries; change one and the other breaks silently while the graph keeps rendering |
| `moderation/rules.ts` | the regexes | Code. `MODERATION_DENY_LIST` already exists for the operational part |
| `personas/differentiation.ts` | `DIFFERENT_ENOUGH = 0.34`, `REQUIRED_DIFFERENTIATORS = 3` | An authoring-time check on the shipped character set, run by a unit test rather than by the server. Configurable, it would let a deployment lower the bar for its own test |
| `personas/provider.ts` | `MC = 1_000_000` | A unit, not a setting |
| everywhere | cookie names, storage keys, HTTP status codes | Contracts. A changed storage key silently orphans everybody's saved state rather than tuning anything |
| `components/MessageInput.tsx` | `MAX_HEIGHT_PX`, `COUNTER_VISIBLE_AT` | Layout, expressed in the language of layout. Configuration for CSS is a build flag nobody can picture |

`DEFAULT_*` constants inside `personas/` (silence timeout, repeats, cadence,
context window, output cap, scripted message count, surface probabilities) are
**fallbacks for tests**, not second defaults: production passes the config value
in every case, and for the cadence a test asserts the two sets agree.

---

## 6. What is pending

| Item | Why it is not done |
|---|---|
| `.env.prod.example` lists 29 names by hand | It is a *template of what production must set*, not a mirror of `.env.example`. Worth re-deriving from the `:?` required markers if the two ever disagree |
| Secrets are delivered whole | An env file goes into the container entire, so the app's environment holds the Postgres superuser and Grafana admin passwords it never reads. Documented with a mitigation; not fixed, because fixing it means more than one file |
| A few YAML defaults remain | `${CONN_RATE_LIMIT:-30}` and friends, mirroring the shipped defaults in `config.ts`. Production sets its own abuse-control values in its env file, outside the repository; the rest are candidates for reduction to `${NAME:-}` so `config.ts` is the only default |
| Nothing checks a value is used *as named* | The guard proves a field is read somewhere. Nothing proves `AVATAR_FETCH_TIMEOUT_MS` is used as a timeout — that is what tests are for |
| Ops scripts and third-party images are unguarded | `backup.sh`, the Caddyfile, `GF_*`, `POSTGRES_*`. They read the environment directly and have no silent default, so the F-045 shape does not apply — but nothing checks their names either |

---

## 7. The guard

`scripts/verify-config.mjs`, inside `npm run verify`. Four checks:

1. **Every service running this code has an `env_file:`.** Without it, only the
   hand-written `environment:` names arrive.
2. **Every name `config.ts` reads is documented in `.env.example`.**
3. **Every field `Config` declares is read outside `config.ts`.** The mirror
   image, added after the reasoning-headroom gap above.
4. **Every `VITE_` name the frontend reads exists in all three places.**

### Two traps the guard itself has to survive

**Composed names.** Ten rate-limit buckets are built by
`rateLimit(env, 'MESSAGE', …)`, so `MESSAGE_RATE_PER_SEC` is a literal nowhere
in `config.ts`. A checker that greps for names reports all twenty as dead and
gets deleted the first time somebody trusts it. The extractor knows about the
composed shape, and `EXPECTED_COMPOSED` asserts it still finds them — a guard on
the guard, because a silently-empty extractor passes every other assertion in
the file.

**What check 3 can and cannot prove.** It matches a field name appearing
anywhere in `backend/src` outside `config.ts`. That catches the real case — a
field nothing references at all, which is exactly how the reasoning headroom
shipped — and it was watched failing on a faithful reconstruction of that bug
before being kept. It does **not** catch a field whose name appears in a module
that never receives the value. It is a floor, not a proof.

---

## 8. Verifying a change

Backend:

```bash
docker exec <container> node -e \
  "console.log(require('/app/dist/config').loadConfig(process.env).timers.heartbeatIntervalMs)"
```

Frontend, after a rebuild:

```bash
docker exec <container> grep -c 7777 /usr/share/nginx/html/assets/*.js
```

Both were used to accept phase 38, and both have caught something that reading
the source would not have. Never verify a setting by reading the file you set it
in.

---

## 9. The audit that started it

Counted 2026-09-03, before the work:

* **108** names read by `config.ts` and passed by no compose file at all —
  settable, documented, inert.
* **29** more readable and documented nowhere, found by the guard's first run:
  the whole persona group, both preference limits, the Sentinel topology,
  `FILTERS_ENABLED`, `CONNECTIONS_PER_CORE`.
* **43** values hard-coded in source with no env name: the OIDC round trips, the
  avatar relay, the entitlement cache, the console's body cap and login window,
  Redis reconnection, the pool's idle timeout, the retention histogram bound, the
  product catalogue, and the whole persona cadence.
* **34** names passed by compose and not read by `config.ts` — all but two
  legitimately read by the backup script, Caddy, the third-party images or
  `personas/main.ts`; the two `NGINX_WORKER_*` names are read by the frontend
  image's own entrypoint, confirmed by asking the running container.

### How it shipped

| Phase | What | How it was proved |
|---|---|---|
| P1 | `env_file:` on `backend` and `personas` | `HEARTBEAT_INTERVAL_MS=25000` read back from the running process against a compiled default of 20000; backend env entries 47 → 152 |
| P2 | The guard, wired into `verify` | Watched it fail three ways before keeping it; first run found 29 undocumented settings |
| P3 | 43 constants named and threaded | `PERSONA_MAX_BUBBLES=2`, `AVATAR_MAX_BYTES=65536` read back from the container with their neighbours untouched |
| P4 | 7 client timings through all three places | `VITE_TOAST_VISIBLE_MS=7777` found in the **served bundle**, gone after reverting |
| P5 | This document, `.env.example`, `.env.prod.example`, `CLAUDE.md` | — |

### Two near-misses worth keeping

**`0` is a plausible typo and a catastrophic value.** Hence readers that refuse
rather than clamp.

**Empty output from a failed command reads as a real answer.** Checking whether
the production overlay inherited the new build args returned zero matches, which
looked like "prod is missing them". The command had failed on an unrelated
missing variable and printed nothing at all; with the required values supplied,
all fifteen were present. Same family as the stale-bundle trap — confirm *what*
answered before believing the answer.
