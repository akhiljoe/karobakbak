# CLAUDE.md — working notes for this repository

Read this first, then `DESIGN.md` (the contract) and `PHASES.md` (what is done
and what is next). `docs/PROGRESS.md` is the running log of what changed in each
phase and why.

**If the work is launch, policy or anything legal**, start in `docs/policies/`:
`docs/policies/JURISDICTIONS.md` records the geography decision everything else
hangs off, and the published terms and privacy policy sit beside it. The
engineering is done; what remains is a handful of template variables and a
counsel review, not code.

**If the work is AI personas**, read the D-AI records in `DESIGN.md` and
`backend/src/personas/guard.ts`. Personas are optional automated conversation
partners that fill an empty queue, and they are off by default. `PERSONAS_ENABLED`
starts the process; the `persona_control` table (an audited console switch)
decides whether anything may join, and it ships disabled. Both must say yes.

**If the work is sign-in, accounts, friends, Recent or reconnect**, read
`DESIGN.md` §31 and §32 plus `docs/product/FEATURE-INTAKE.md`.
`docs/operations/SIGNIN-SETUP.md` is the wiring — what is configured, the one command that
proves the whole chain, the Cognito/Google runbook including the custom-domain
cutover, and how to reach a phone over HTTPS. Signing in is **free** and gates saved
connections, recent history and friend requests; premium is the asymmetric
matching preferences and nothing else. `AUTH_ENABLED` and `ACCOUNTS_ENABLED` are
**true** — sign-in is live against a Cognito pool federated to Google on the
custom domain `auth.karobakbak.com`, and `SIGNIN_PROVIDER` in `features.ts`
decides whether the button names Google. `AUTH_AVATARS` is on.
`PAYMENTS_ENABLED` and `FILTERS_ENABLED` remain false, each for its own reason.
A half-specified auth config is still refused at startup by name.

What signing in now unlocks, all shipped: saved connections with one-sided
nicknames and online dots, a blocked-people list you can unblock from, a
profile picture relayed by this origin, and asking somebody you met earlier to
talk again. Recent needs no account and works signed out.

**If the work is matching preferences or premium filters**, read `DESIGN.md`
§29 and D44 first. It is a **preference and never a filter** — a search that
finds nobody matching takes an ordinary partner on the same pass — and the two
rate limits it depends on are configured, unenforced, and guarded by a startup
check that refuses production without them.

**If the question is "are we ready to launch"**, `docs/LAUNCH-CHECKLIST.md` is
the tracked list and names the register that holds the reasoning for each row.
It deliberately holds no reasoning of its own: a checklist that restates its
sources drifts from them, and then two places disagree about the same fact.

**If the work is testing, results, or deciding whether to launch**, start at
`docs/testing/README.md` — four core documents: the register (what is covered), the
results (what ran and what it found), the findings (every F-number and what is
left to decide), and `LAUNCH-GATE.md`, which maps every public claim to the
thing that demonstrates it. That last one is not a checklist: a review once
found seven places where the policies described a system that was not the one
built, and every one of them would have survived a checklist.

**If the work is the load test**, read `docs/testing/SWARM-HANDOFF.md` before anything
else in `load-test/swarm/`. It carries the state, the ranked backlog, and a list
of traps that have each already cost a red run — the server behaviours a harness
gets wrong on the first attempt.

**If the work is deployment or the live site**, read
`docs/operations/DEPLOY.md` first. Production runs from its own clone
(`%USERPROFILE%\karobakbak-live`) and is deployed by the `deploy` workflow on a
self-hosted runner, never from the working copy. That runner is registered only
to a private deployment repository, never to a public one. Production is a
single host behind a Cloudflare Tunnel, as compose project `karobakbak-live`
(development is `karobakbak-dev`); the VPS documents are kept as an alternative
path. The `laptop:*` scripts and `docker-compose.laptop.yml` are the names of
that single-host tunnel profile.

## What this project is

`karobakbak` — anonymous, real-time, text-only random stranger chat. Two
strangers are paired at random over WebSockets, either can skip or block, and
conversations are retained for a defined period to support abuse investigation,
then automatically deleted. Retained content is plaintext inside a trusted
boundary protected by infrastructure controls, not by application-level
encryption (`DESIGN.md` §2.1, §18.2).

The product name is **karobakbak**. The frontend spec in `docs/` says
"BakBakBox"; that naming is superseded (`DESIGN.md` §1.2 R2).

Not a demo. It is built to be correct under concurrency with **multiple backend
instances running at once**, containerised, observable and load-tested.

`docs/` holds six product documents (security/safety, frontend UI/UX,
advertising, monetization, cost/rollout). `DESIGN.md` §1.2 records every place
they conflicted with the original brief and how each was resolved — read that
table before assuming a doc is authoritative on a technical question. On
conflicts of fact, `DESIGN.md` wins.

## The rules that override normal judgement

1. **Message content is plaintext inside the trusted boundary, and must never
   leave it.** There is no application-level encryption (`DESIGN.md` D15). The
   boundary is: Node.js process memory, the bounded persistence queue, the
   outage spool, PostgreSQL `messages.body`, and a Redis Pub/Sub payload in
   flight. Outside that: **never** a log line, an error message, a Prometheus
   label *or value*, a Grafana annotation, a tracing span, an analytics event,
   a crash report, or any other persistent system. `reports.note` is user
   content and carries the same rule. `src/logger.ts` enforces this with a
   recursive field denylist that *throws* outside production — it is the
   primary control now that nothing is encrypted, so treat changes to it as
   security changes. If you need to log something about a message, log its
   length, its id, its moderation action or its queue state, never its content.
2. **Node's single thread is not a concurrency argument.** Every matchmaking
   state transition must be correct with N backend instances mutating Redis at
   once. That means Lua scripts, not read-then-write from TypeScript.
3. **The server is authoritative.** Never read identity, routing or ordering
   from a client frame: not session id, user id, partner id, match id, sender,
   recipient, or timestamp. The only client-supplied field that survives is the
   opaque `id` correlation token, echoed back in `message_ack.clientMsgId`.
4. **State-changing operations are idempotent** wherever practical. Repeat
   skips, repeat disconnect cleanups and repeat queue joins must converge, not
   error out or duplicate state.
5. **No placeholders.** No TODOs, no `...`, no "implement this yourself", no
   stub files. A phase either ships complete files or does not create them yet.

## Architecture in one paragraph

A backend instance owns WebSocket file descriptors and a
`Map<sessionId, Connection>` used purely to find a local socket. **All**
matchmaking state lives in Redis and every transition is a single Lua script, so
transitions cannot interleave. Cross-instance notification uses Redis Pub/Sub on
a per-session channel (`chat:ev:session:{sid}`) — the channel name *is* the
routing key, so no routing table can go stale. Reconnect **resumes** the session when a
valid token is presented within `RESUME_GRACE_SECONDS` (§28, D42 — reverses
D7); otherwise it creates a new one. Matching samples candidates at
random and takes the longest-waiting, and now **scores** them against the
searcher's declared preference before that tie-break (D44); a score of zero is
the ordinary candidate, so the preference can never make somebody wait. Redis
may be a single node or a **Sentinel** set — `REDIS_SENTINELS` — and every
half-specified topology is refused at startup rather than degraded to one node.
TTLs plus a leader-locked janitor are the recovery net for crashes. Retained
conversations go to PostgreSQL through a **write-behind** path (priority-bounded
queue → circuit breaker → batched inserts, with an outage spool when the breaker
is open) so chat delivery never waits on the database and a database outage can
never become a chat outage.

## Layout

```
backend/src/protocol/   wire types (SOURCE OF TRUTH), validation, envelope builders
backend/src/redis/      key names, client, Lua scripts, typed store  [phase 2]
backend/src/ws/         connection handling, session lifecycle       [phase 3-5]
backend/src/moderation/ normalisation view, rules, policy engine     [phase 6]
backend/src/storage/    migrations, priority queue, circuit breaker, spool,
                        repositories, deletion worker                [phase 7-8]
backend/src/admin/      moderation console: scrypt, TOTP, auth, review,
                        enforcement, routes, its own HTTP server and its own
                        process entrypoint (`main.ts`)               [phase 13]
backend/src/admin/public/  three static files, no build step, no framework
backend/src/util/       ids, time
backend/tests/unit/     fast, hermetic
backend/tests/integration/  real Redis, real Postgres, real sockets
frontend/src/protocol/  byte-identical COPY of the backend protocol types
frontend/src/agegate.ts + components/AgeGate.tsx
                        the age gate: versioned acknowledgement, never
                        server-side                                  [phase 17]
frontend/nginx.conf     the edge, the EEA/UK block, and the two payment
                        route proxies                                [phase 17]
frontend/src/components/EditorialShell.tsx
                        the shell About/HowItWorks/Premium/Rules/FAQ/Safety use.
                        Owns the sticky header and the pinned footer
frontend/src/components/FaqPage.tsx + content/faq.ts
                        twenty questions, four groups, native `<details>`
frontend/src/components/SafetyPage.tsx
                        controls before advice; two tile glyphs
backend/src/payments/   Razorpay: products, signature, gateway, repository,
                        accounts, routes. Off in both halves
docs/brand/             the mark as three SVGs, the palette as facts, and
                        prompts for regenerating it
docs/policies/PENDING-PAYMENTS.md
                        the staged policy patch that lands when payments do
backend/src/personas/   AI personas: characters, surface generation, the
                        WebSocket client, the guard, the supervisor, the
                        provider seam, the budget, and its own process
                        entrypoint (`main.ts`)                      [phases A0-A6]
backend/src/accounts/      sign-in and what it unlocks: the OIDC seam, the
                        credential, connections (with one-sided labels),
                        account-scoped blocks, presence, the avatar relay, and
                        the reconnect routes. AUTH_ENABLED starts it [phase 20-22]
frontend/src/history.ts + components/HistoryPanel.tsx
                        Recent: who you met this session, in sessionStorage,
                        never on a server                            [phase 21]
frontend/src/connections.ts + components/FriendsPanel.tsx
                        the friends list, its labels and its online dots
backend/src/admin/personas.ts
                        the console's persona view, audited          [phase A6]
docker-compose.laptop.yml + .env.laptop.example
                        production on a single host behind a Cloudflare
                        Tunnel: cloudflared and resource ceilings, on top of
                        the prod overlay
ops/laptop/launcher/    karobakbak-live.exe: pre-checks, start, stop. C# 5
                        (Windows' own csc v4 - no interpolation, no ?.);
                        build.ps1 builds it, the exe is gitignored
docker-compose.sentinel.yml
                        primary + replica + three sentinels, for the failover
                        drill in OPERATIONS.md §17. A rig, never a deployment
ops/backup/             dump, encrypt, copy off-host, prune
docs/policies/          G1/G2 drafts, the jurisdiction decision, and the
                        reusable review prompt               [phase 17]
```

## Things that will bite you

* **`frontend/src/protocol/types.ts` is a generated copy.** Edit the backend
  file, then run `node scripts/verify-protocol.mjs --fix`. `npm run verify`
  fails the build if they drift. Never hand-edit the frontend copy.
* **Never type literal control characters into source.** An earlier attempt at a
  control-character regex wrote raw bytes into `validate.ts` and turned it into
  a binary file to git/grep. `hasForbiddenControlChar()` uses `charCodeAt`
  comparisons for exactly this reason. Keep it that way.
* **`.gitattributes` forces LF.** The backend and frontend run in Linux
  containers; CRLF breaks Dockerfiles, shell scripts and nginx configs. Do not
  commit CRLF.
* **Config is injected, never a module singleton.** `loadConfig(env)` is a pure
  function; `index.ts` calls it once and passes `Config` down. Tests build their
  own. Do not add a top-level `export const config = loadConfig()`.
* **`loadConfig` has cross-field checks** (`assertCoherent`). Adding a limit
  usually means adding a coherence check too — e.g. a heartbeat that is not
  comfortably below the session TTL silently expires live sessions.
* **`exactOptionalPropertyTypes` is off, `noUncheckedIndexedAccess` is on.**
  Array/record indexing yields `T | undefined`; handle it rather than
  reaching for `!` by reflex.
* **Redis keys never contain client-supplied strings.** All ids come from
  `util/ids.ts` (`crypto.randomBytes`, base64url). Client IPs are salted-hashed
  before they become keys, and are never logged raw.
* **Queue keys are segmented from day one** (`chat:queue:{segment}`) even though
  only `default` exists. Every Lua script takes a segment argument. Do not
  "simplify" it away — filters later would mean rewriting and re-race-testing
  every script (`DESIGN.md` §1.2 R6, D23).
* **A block is not keyed on session id.** Session ids are per-connection, so a
  session-id block would expire the instant the blocked user reconnects. Blocks
  key on salted IP hash *and* client token hash, both dimensions, both
  directions, checked inside `tryMatch` (D18).
* **Blocked candidates are skipped, never removed from the queue.** They are
  blocked relative to *this* searcher only and must stay matchable for everyone
  else.
* **Retention deadlines are stamped at insert time.** Never compute expiry at
  deletion time — that would let a config change retroactively extend the life
  of already-stored user data (D17).
* **Never make chat wait on PostgreSQL.** The retention path is write-behind and
  lossy under overflow by design. If you find yourself awaiting a DB insert on
  the message hot path, that is the bug (D16).
* **Never log a `pg` error object.** Driver errors echo parameter values — the
  row you just tried to insert — on constraint violations and timeouts. Use
  `dbErrorFields()`, which emits code/constraint/table/routine only.
* **Never build an `Error` by interpolating message content.** `errorFields()`
  truncates and the denylist scans field names, but `errMsg` is a legitimate
  field, so an interpolated body would survive. Throw constants on any path
  that has touched user text.
* **Queue priority is server-assigned only.** Nothing a client sends may raise
  its own durability priority, directly or indirectly (D27). Per-class caps
  alone are gameable — the per-session sub-quota inside each class is what stops
  someone tripping a mild moderation rule to flood P1 and evict other people's
  evidence (D26).
* **The spool is not durable storage.** Never describe it as such in code
  comments, docs or metrics. It is bounded outage tolerance; a host failure
  loses it, and a Redis-backed spool dies with a Redis restart (D28).
* **The product is text only.** A `type` discriminator exists on messages
  (`'text'`, and only `'text'`) purely so a future content type does not force
  a protocol version bump. It is not permission to build media. Do not add
  object storage, CDN, STUN, TURN, SFU, media servers, image processing, a
  `media_id` column, a media table, or `call.*` events. See `DESIGN.md` §23,
  which lists what was deliberately rejected and why.
* **Never coerce an unknown message content type to text.** Reject it. Coercion
  would let a sender believe an image was delivered when only text was (§23.6).
* **Binary WebSocket frames are rejected, and that is architectural.** It is
  what keeps the socket from becoming a media transport (§23.2). Do not relax it
  to "support attachments" — media goes beside the socket, never through it.
* **Moderation is entered by content-type dispatch, not `moderateText`.** One
  branch today. An unhandled type must fail closed (§23.5).
* **A ban is not a block, and the namespaces must stay apart.** A block is
  relative (a set of peers *one user* refuses, checked inside `tryMatch`); a ban
  is absolute (`chat:ban:{key}`, read at the upgrade before a session exists).
  If they ever shared a namespace, a moderator revoking a ban would delete a
  user's own block — silently removing protection the user asked for. There is
  a test for exactly that (D29).
* **Bans live in PostgreSQL and are only cached in Redis.** Redis has
  persistence off (D12), so every ban key dies with a restart. `reapplyActiveBans`
  replays them at startup and on an interval, recomputing the remaining life from
  `expires_at` — never reissuing the original duration, which would renew every
  ban on every restart. It is deliberately not leader-locked (D31).
* **No console route may accept an identity hash.** `issueBanForReport` resolves
  the subject from the report on the server. A body that could name its own
  subject would let any console session ban an observed or guessed hash, and the
  audit row would record a well-formed decision with nothing to show it was
  forged. Same rule as protocol rule 3, higher stakes (§25.3).
* **The audit row is written before the content is selected, in the same
  transaction.** Fetch-then-log yields a trail that is complete except for the
  reads that failed halfway. The guarantee is "a read that was not logged did
  not happen" (D33) — there is a test that breaks the audit insert and asserts
  no transcript comes back.
* **`console.js` must never gain an `innerHTML`.** That origin holds a session
  that can read every retained conversation, so a script smuggled through a
  message body could walk the whole queue. A test fails if one appears — and it
  strips comments first, so the prose explaining the rule does not trip it.
* **The console runs as its own process and its own database role.**
  `karobakbak_app` is denied `admin_accounts` outright; `karobakbak_console`
  cannot delete a conversation. Both facts are asserted in
  `tests/integration/storage.test.ts`. Do not "simplify" the console into the
  chat process (D32).
* **A declared profile is a claim, never an attribute.** Name, age, gender and
  country are typed by an anonymous stranger and verified by nothing. `age` is
  **not age assurance** (§26.4) and must never be described as such or read as a
  safety control. The console labels them "declared" for this reason.
* **The server keeps no profile between sessions.** It rides on `join_queue`,
  lives on the session hash, dies with the session; the browser re-sends it.
  Storing it against the block token or an IP hash would be the cross-chat
  correlator §24.3 forbids (D34). A join carries the *whole* profile — a missing
  field is deleted, because there is no partial update.
* **A declared name is refused on any moderation flag**, unlike a message, which
  is flagged and delivered (D20 vs D35). A name is a label shown to everyone the
  user meets, not one utterance in context.
* **Profiles are declared, not filterable.** No matchmaking path reads them, and
  that is D37 rather than an unfinished edge — filtering creates the incentive
  to misdeclare and turns a paid control into a targeting tool. If premium
  filters are built they go behind the queue-segment seam.
* **Read profiles beside `tryMatch`, never inside it.** The script is the most
  race-tested code here and its reply is parsed positionally; widening it to
  carry display fields means re-verifying every matchmaking race.
* **`COUNTRY_NAMES` lives in the protocol file, not the frontend**, because the
  console renders country names too. A test fails if a code has no name.
  Gender's short labels (`F`/`M`/`NB`) are client-side only — the wire value
  stays the full word so stored evidence reads unambiguously.
* **The Lua lives inside a TypeScript template literal.** A backtick anywhere
  in a Lua comment terminates the string and produces a syntax error several
  lines from the cause. Same family as the control-character trap above: the
  script is a *string*, so nothing that is syntax in the host language may
  appear in it.
* **`endMatchInline` is shared by five scripts.** Its extra arguments are passed
  **explicitly** by every caller, never read as "the last ARGV" — an implicit
  convention across five call sites is a trap for whoever adds the sixth. Adding
  a parameter means bumping each script's declared arity *and* its store call
  site.
* **A block can arrive after the match ended, and must still record** (D38).
  `chat:last_partner:{sid}` holds the departed partner's hashes for
  `BLOCK_LATE_WINDOW_SECONDS`. The record is **spent when used on both
  branches** — blocking ends the match, so the live branch writes one for the
  blocker too, and leaving it would let them re-block the same person for the
  whole window and burn their hourly budget.
* **A late block ends nothing and notifies nobody.** `endedByUs` false,
  `partnerSessionId` empty, `conversation_id` null — never `''`. Sending a
  `partner_skipped` for a match that ended minutes ago would reach whoever holds
  that session id now.
* **Auto-search must never fire after a block** (D39), and must back off rather
  than have the join limiter widened for it (D40). An explicit "Block & next"
  advancing is not the same thing: the person asked.
* **A dropped socket no longer ends a conversation** (D42, §28). `closeSession`
  marks the session detached and lets the row's TTL be the grace window; the
  janitor already ends a match whose side vanished, so there is exactly one
  expiry mechanism. `RESUME_GRACE_SECONDS=0` restores the old D7 behaviour, and
  the teardown tests run against it — that path is supported, not dead.
* **Never clear `instanceId` on detach.** `resolveRoute` reads an empty one as
  `PARTNER_GONE`, which the pipeline turns into "not matched" and *ends the
  conversation* — so one message during the gap would destroy what the window
  exists to protect.
* **Draining must not hold seats.** A shutdown is not a blip; holding leaves
  every partner waiting out a window for a server that is going away. The close
  handler passes `holdSeat: !draining`.
* **The resume token is a bearer credential.** Stored only as a SHA-256,
  rotated on every redemption, refused for a session that is still attached, and
  kept in `sessionStorage` so it dies with the tab. A failed resume opens a
  fresh session — never an error.
* **Messages sent while a partner is away are not buffered** (D43). Buffering
  would write message text to a Redis key, which is what I8 forbids. The
  composer is disabled instead.
* **`/ready` reflects Redis, not PostgreSQL.** A backend with a dead database
  still serves chat correctly, so it must stay in the load balancer.
* **A batch being refused is not every record in it being refused.** Both write
  paths narrow to individual rows before giving up — `writeGroup` on *any*
  permanent error including a missing parent, and `drainSpool` through the same
  `salvage`. This was F-032: one message whose conversation row had not landed
  yet used to destroy every record sharing its batch, which cost 1,350 P0
  records in a single chaos run. Do not "simplify" either narrowing away.
* **Never rollback down a connection that never answered.** `transaction()`
  checks whether PostgreSQL produced a SQLSTATE: an error without one was
  manufactured by the driver after it gave up, so the connection's state is
  unknown and it is destroyed rather than released. Rolling back anyway costs a
  second full timeout and does nothing — that doubling (F-031) is what kept the
  circuit breaker shut through a sixty-second outage and made the spool
  unreachable.
* **The breaker's reaction time is `BREAKER_FAILURE_THRESHOLD` ×
  `DATABASE_STATEMENT_TIMEOUT_MS`** — 50s at the defaults. That is the outage
  that must elapse before the outage spool comes into play. Change one and the
  other needs revisiting; it is an arithmetic relationship, not two independent
  settings.
* **Child safety relies on the age gate plus reporting and moderation**, with
  stronger measures on the roadmap, so the gate's wording carries more weight
  than any other string here. It must never be described as age assurance, in copy or in
  code. Its acknowledgement is versioned rather than dated — re-asking on a
  schedule is theatre, re-asking when the wording changes tracks what was
  agreed to — and it is deliberately the one dialog that does *not* close on
  Escape or a backdrop click. Storage failures show it rather than skip it.
* **Nothing about the age gate reaches the server.** A durable per-user record of
  acceptance is the cross-chat correlator §24.3 and D34 forbid. The honest cost
  — that a local flag demonstrates nothing to anybody else — is the one open
  legal question in `docs/policies/age-gate.md` and is deliberately not assumed
  either way.
* **`VITE_TERMS_URL`, `VITE_PRIVACY_URL` and `BACKUP_REMOTE` are required in
  production** and the prod compose refuses to build without them. A gate citing
  documents nobody can open, or a backup living on the machine it protects, are
  both worse than the absence they replace.
* **Geo-blocking lives at the edge, in `frontend/nginx.conf`, and must cover
  `/ws`.** Refusing the page while leaving the socket open restricts nothing —
  anybody holding the bundle connects straight past it. Two nginx facts that
  were found by running it rather than reading it: `error_page` does **not**
  intercept a `return` from an `if` in the *server* block (the status arrives
  with an empty body), and the check therefore sits inside each location.
* **Anything added in front of nginx is another `X-Forwarded-For` hop**, and
  `TRUST_PROXY_HOPS` must be re-measured against the running stack. `clientAddress()`
  counts N entries from the right, so a value below the real chain reads an entry
  the *client* wrote, and per-address rate limits and blocks stop meaning
  anything.
* **The policy documents in `docs/policies/` are drafts with positions, not
  published text.** Every open question carries a `DRAFTED POSITION` with its
  reasoning; facts only the operator holds are `{{TEMPLATE_VARIABLES}}` and must
  stay that way, because plausible-looking false detail in a legal document is
  worse than an obvious gap. Terms §10 and §11 are empty on purpose and need a
  lawyer, not a model.
* **Every factual claim in those documents is checked against the code, and that
  claim has already failed once.** A review found seven places where they
  described a system that was not the one built — including "our moderation
  team" four times when there is one person. Changing behaviour means checking
  whether a policy now says something untrue; a false statement in a published
  policy is worse than a weak legal position, because it is not arguable.

* **A persona is an ordinary client, and that is load-bearing.** It opens a real
  socket, joins the ordinary queue and is matched by the ordinary path — no
  branch in `tryMatch`, no new Lua, no virtual peer (D-AI-6). Blocks, bans, rate
  limits, moderation and retention then apply to it without anybody writing code
  to make them apply, which the integration tests demonstrate rather than assume.
  Putting persona logic inside matchmaking would mean re-verifying every
  matchmaking race for a feature that is off by default.
* **A persona's declared profile is generated per conversation, never stored**
  (D-AI-3). The durable half is the *character*; the profile is a fresh
  `Profile` on every join and rides the declared-profile field that already
  exists, so there is no new storage.
* **The six safety limits sit between the model and the socket, not in the
  prompt** (`personas/guard.ts`, D-AI-5). A limit written into a system prompt is
  one the thing generating text can be talked around. The prompt still carries
  the instructions and nothing depends on them. The limits: no sexual content;
  a minor signal ends the romantic register for the session; no escalation under
  pressure; a crisis signal breaks character with helpline information; never
  solicit personal information; never claim to be human. The guard fails
  closed. `PERSONA_GUARD_TERMS_FILE` adds operator terms: detection lists
  extend the built-in ones (a file can never lower the floor), reply pools
  replace them and are checked against the same never-claim-to-be-human list.
* **The presence counter is hidden below 100 online, never faked** (D21). The
  wire format sends `approximate: true` as a literal so the UI cannot present a
  count as exact. `showPresence()` in
  `frontend/src/view/presentation.ts` is the whole rule, and it is pure and
  tested. Hiding a true number says nothing false. If a threshold change is ever
  wanted, change the constant — do not reach for a synthesised count, and do not
  add a floor.
* **Two model adapters ship and exactly one runs.** `PERSONA_PROVIDER` picks
  between `provider-anthropic.ts` and `provider-openai.ts` — the only two files
  allowed to import a vendor SDK (D-AI-10). Provider, model and price are one
  decision in three variables and `assertCoherent` refuses all three ways of
  getting them out of step, because every one fails *quietly*: the sharpest is
  one vendor's model id against the other's key, which authenticates fine and
  then fails every call, and the scripted fallback hides that completely.
  Adding a model means adding its published rates to `MODEL_PRICES` in the same
  commit — an unpriced model is a ceiling that cannot bind, since `safeCost`
  downgrades the throw to a zero rather than failing a live conversation.
* **The two vendors disagree about what an input token is.** Anthropic's
  `input_tokens` excludes cache reads; OpenAI's `prompt_tokens` includes them,
  and OpenAI charges nothing to write the cache. An adapter that passes the
  number through double-bills every cached token, so the ceiling binds early and
  the whole population drops to the scripted voice. `normaliseUsage` in
  `provider-openai.ts` subtracts, with a test named after the bug. Any third
  adapter needs the same question asked before it is written.
* **A second vendor is a policy change before it is a config change.** The
  Privacy Policy names the model provider individually as `{{MODEL_PROVIDER}}`
  and requires terms that forbid training on submitted content. Two adapters in
  the code is still one processor while only one runs; running two at once would
  be a second row and a 14-day notice.
* **The persona's message list must start with a `user` turn.** A persona
  speaks first, so its transcript is naturally `[assistant, user, ...]` and the
  Messages API rejects that — every call after the opening line 400'd. The
  adapter turns a rejection into `stop: 'error'` and that falls back to the
  scripted voice, so the failure never looked like one: the persona kept
  talking, spend stayed near zero, and the only symptom was a stranger who
  ignored every question. `contextWindow` seeds a marker turn *and* drops
  leading assistant turns after the slice, and `persona-voice-model.test.ts`
  asserts the shape of every request. Anything that changes how history is
  assembled needs that test to still pass.
* **`personas/cadence.ts` owns reply pacing** and the split of a reply into
  messages; the client turns it into ordinary `typing` frames. A newline in a
  reply always becomes a second message.
* **An identity question is handled by the guard before the model is called.**
  The model never sees the question, so it cannot be talked into a claim to be
  human, the answer does not depend on what the model happens to return, and the
  call is not paid for.
* **Every persona connects from the same IP and they share one bucket.**
  `PERSONA_MAX_CONCURRENT` must stay below `MAX_CONNECTIONS_PER_IP`;
  `assertCoherent` refuses to start otherwise. A cap above the connection limit
  looks applied and silently is not — the symptom is refused connections, which
  reads as "personas are broken" rather than "the cap is wrong".
* **The persona spend ceiling and the kill switch both live in PostgreSQL.**
  Redis persistence is off (D12), so a counter or a flag stored only there
  returns to its compiled-in default on restart. A spend counter that resets is
  not a budget, it is a budget that silently refills exactly when something has
  gone wrong enough to restart the process. Both are cached in Redis and
  reconciled, the ban pattern (D31).
* **The chat role can add to the spend and cannot raise the ceiling.** A
  column-level grant, asserted against real PostgreSQL. A process that can raise
  its own limit does not have one. It also cannot enable personas at all.
* **Trimming the persona character sheet can raise the bill.** The prompt splits
  into a cacheable stable half and a volatile half, and caching is a prefix
  match. Below the minimum cacheable prefix the whole block silently stops
  caching and goes from a tenth of the input price to full price. Trim the
  session summary and the message window instead — never the character.
* **No metric label or value may carry message content, and none does.** Rule 1
  names Prometheus labels *and values*, so the live persona feed everybody asks
  for cannot be built. What a persona said is read in the console, audited
  (D-AI-8). `conversation_id` is never a label: unbounded cardinality, and half a
  content leak.
* **`metrics-wiring.test.ts` fails any metric declared and never written.** It
  caught all sixteen persona series the moment they were declared, which is why
  `personas/metrics.ts` exists as a single writer. A declared-and-dead metric is
  worse than an absent one: it is charted, it reads zero, and it is believed.
* **Persona conversations are browsable without a report**, unlike every other
  conversation (D-AI-12). That makes the audit trail the only remaining control
  on reading a stranger's messages, so the D33 guarantee and the one-year audit
  retention are not negotiable while browsing is unrestricted.
* **The logger denylist is a case-sensitive exact-match Set.** `Password` is no
  more redacted than `ApiKey`. Both realistic spellings of the model key are
  covered and a test documents the limit rather than widening it — that is the
  primary I8 control, and making it case-insensitive is a security change that
  deserves its own decision.
* **`overflow-x-hidden` on an ancestor kills `position: sticky` below it.** When
  one axis is `hidden` the other computes to `auto`, so the element becomes the
  nearest scrollport and a `sticky` descendant pins to a box that never scrolls.
  It cost the editorial header its stickiness for months and nothing errored.
  The clip belongs on the element that already scrolls.
* **Pinning something changes what it is, and silently invalidates the reasoning
  around it.** Making the footer sticky turned it from the end of a column of
  prose into chrome. Its alignment (to the 680px measure) and the menu button's
  missing breakpoint were both correct before and wrong after. Nothing failed;
  it just looked broken. When you pin a thing, re-read every decision that was
  made about it while it moved.
* **A breakpoint written in two places will drift.** The menu panel opened empty
  on desktop because its contents were `md:hidden` and its button was not. State
  the width once — on the control that opens the thing — and let the contents
  have none.
* **Absent beats present-and-disabled.** `ACCOUNTS_ENABLED` hides sign-in;
  Premium, `/support` and the filter control now do the same. A control that is
  rendered and does nothing still takes focus and still announces itself, then
  refuses. The filter button used to open a modal whose only content was "Part
  of Premium".
* **`FILTERS_AVAILABLE` is derived, not settable.** `FILTERS_ENABLED &&
  PAYMENTS_ENABLED`, because each half refuses for its own reason: only the
  `default` queue segment exists (R6, D23), and filtering is the paid tier.
  A single flag would let one of those be forgotten.
* **A class name in the JS bundle is not a rule in the CSS.** `max-w-[calc(100vw-1.5rem)]`
  shipped in the markup, appeared in the bundle, and produced **no CSS at all**:
  `calc()` requires spaces around the minus, so the declaration was invalid and
  dropped. Tailwind's arbitrary values take underscores for those spaces —
  `max-w-[calc(100vw_-_1.5rem)]`. Grepping the bundle "proved" the fix twice
  while the panel stayed broken. Grep the compiled **stylesheet**. Beware
  escaping while doing it: `sm\:w-72` and `[60vh]` both read as missing through
  a shell that ate the backslashes, and neither was.
* **`max-w` bounds a panel's width and says nothing about its position.** A
  288px popover centred on a control in the middle of a narrow row still hangs
  off the screen, and the half that hangs off is the right-hand one — where the
  row's buttons are. Below `sm` the panels are fixed to the viewport instead of
  anchored to their button.
* **A session's `accountId` is read from the cookie at the WebSocket handshake
  and nowhere else.** Sign-in happens in a popup that deliberately does not
  reload the page — that is what keeps a conversation alive across it — so an
  open socket keeps the identity it opened with, forever. The client closes and
  re-opens on sign-in (the resume token re-attaches the same session, §28) and
  the server binds the account when the connection is registered. Both halves
  are needed: without the first the cookie is never seen, without the second the
  session row stays empty until the next search.
* **The two `matched` frames are built in different places.** The side already
  waiting is told by a frame `lifecycle` builds and publishes; the side that
  pressed Start is told by one `server.ts` builds from the outcome. Anything
  added to a match must be added to both, or half of every conversation gets it
  and which half depends on who was waiting. `partnerPresence` shipped in one
  and not the other, and nothing failed.
* **Reconnect pairs two people through a private queue segment, not a new
  script.** `chat:queue:{segment}` has existed since day one with only `default`
  in it (R6, D23); a reconnect writes a random `pair-…` lane on both sessions
  and ordinary `tryMatch` does the rest. That is why blocks, bans and rate
  limits all still apply with no reconnect-specific code — and why a bespoke
  pairing script would have been the dangerous version, since it would have had
  to re-implement the block check.
* **A presence token is not an identity.** Minted per match *and* per viewer, so
  two people who met the same person hold different tokens and cannot discover
  it by comparing. Signed in it resolves to an account and lasts twelve hours;
  signed out it resolves to a *session* and dies with it, because nobody signed
  out agreed to be findable. Somebody who turned presence off gets no token
  minted at all — opting out means not being remembered, not merely hidden.
* **Routing and visibility are two different Redis keys.** `chat:sess:{account}`
  is written on every heartbeat and answers "where do I deliver this";
  `chat:online:{account}` is written only when sharing is on and answers "may
  others see them". Conflating them meant somebody who hid their presence could
  not be routed to at all, including by themselves.
* **`npm run verify` is not the whole build.** The table-enumeration guard lives
  in the integration suite and needs real PostgreSQL, so a new migration can be
  green locally and red in CI. Run `npm run test:integration` before pushing
  anything that adds a table.
* **Cognito refuses a plain-HTTP redirect URI unless it is loopback.** A LAN
  address will not be accepted, so a phone cannot sign in against a dev machine
  by IP. Use a Cloudflare tunnel (`cloudflared tunnel --url http://localhost:3001`)
  and register that HTTPS origin, or `adb reverse` on Android to keep localhost.
* **Verify the served artifact, not the source.** "Tests pass" and "I checked it
  in a browser" are different claims, and the second one is worthless unless it
  names *which* build. This cost three separate rounds: once the backend was six
  commits behind and rejected `react` as an unknown event while the frontend
  looked fine; once a vite dev server on `:5173` was checked and reported as
  verification of a container on `:8081`; once a container was rebuilt before the
  last two commits landed and served copy that had already been deleted. Every
  time the symptom was "the code is wrong" and every time the code was right.
  `docker exec <container> grep -rlo "<a string only the new build has>"
  /usr/share/nginx/html/assets/*.js` settles it in seconds, and
  `docker exec <backend> node -e "console.log(require('/app/dist/protocol/types').INTENTS)"`
  settles the other half. A stale bundle reports healthy, passes its health
  check, and serves last week — the same shape as everything else in this file.
* **The generated nickname is scoped to the session, not the match** (D50), and
  the colour is not. It is drawn once after `createSession` and read beside
  `tryMatch`; a per-match name made everybody unrecognisable in Recent and
  across a skip that re-paired the same two people. This reverses §24.3's "no
  handle stable across matches" *deliberately* — a session dies with the tab,
  and nothing is derived from an identifier — so the accepted cost is that two
  people matched twice in one visit can tell. Do not extend it to the colour, do
  not persist it past the session, and do not write back the collision redraw:
  the arriving side redraws for **one match only**, or a stranger could rename
  somebody everywhere by colliding on purpose.
* **A condition correlated with the real test is not the real test.** `AuthModal`
  allowed a full-page redirect when `reason === null`, meaning "nothing in the
  app asked for this" — a stand-in for "there is nothing to lose". They agree
  everywhere except the one path that matters: signing in from the header
  *during a conversation*, where the navigation killed the socket and the
  20-second resume grace could not cover a round trip through the provider. The
  chat was gone and nothing failed. It is gated on a live conversation now.
* **Verify which artifact the *reporter* is looking at, not just which one you
  built.** The stale-bundle trap above has a second half. A report of removed
  copy still appearing was diagnosed while a `vite` dev server on 5173 and the
  container on 3001 were both serving this repo; both were current and the
  answer was a cached page. Check the reporter's origin before concluding
  anything about the code — and prefer not to leave two servers running.
* **A protocol value added to a list is a backend change, not a UI change.**
  Rebuilding only the frontend after adding `flirty` to `INTENTS` would not have
  produced a cosmetic mismatch: the old `validateIntent` refuses the value, and
  the refusal fails the **whole** `join_queue` with `VALIDATION_FAILED` rather
  than dropping one field. Closed lists are validated on both sides on purpose,
  so both sides ship together.
* **A value added to a closed protocol list is a backend change.** Rebuilding
  only the frontend after adding `flirty` to `INTENTS` does not produce a
  cosmetic mismatch: the old validator refuses the value and the refusal fails
  the **whole** `join_queue` with `VALIDATION_FAILED`. Closed lists are
  validated on both sides on purpose, so both sides ship together.
* **Backticks break the shell the same way they break the Lua.** The Lua trap is
  already in this file; this is it wearing different clothes. A double-quoted
  `python -c` runs command substitution on backticks, so a backticked path
  inside a docstring became an empty `()` in `DESIGN.md` and nothing errored.
  Use a quoted heredoc for anything containing backticks — or write the content
  to a file and splice it — and re-read what actually landed.
* **`Profile` is defined as the thing sent to the other side, and that
  definition is load-bearing.** Intent is declared on the same frame and is
  deliberately not a member of it, which closes every disclosure path at once —
  `readProfiles` reads a fixed field list, the `matched` payload is built from
  `Profile`, `conversations.profile_a/_b` serialises one, the console column
  renders one, and `validateProfile` cannot produce the key. Adding a field to
  `Profile` is a decision about what strangers and moderators see, never a
  convenience.
* **Intent is symmetric, which is why it is free.** Gender and country are
  lists — what I want a *stranger* to be, so one party is selected and D37's
  objections apply. Intent is one value matched by **equality** against the
  candidate's own declaration, so both sides asked for the same thing and there
  is no selected party. `setIntent` is deliberately not gated on
  `preference.enabled` and is its own store method: folding it into
  `setPreferences` is the obvious simplification and would put a free feature
  behind a paid flag with nothing in the types to notice.
* **Intent must never enter `anyPreference`.** That is what triggers the wide
  sample, and escalation is a second `SRANDMEMBER` plus up to
  `PREFERENCE_WIDE_SAMPLE` further `HMGET`s. Most of the population will declare
  an intent, so counting it would put that second pass on nearly every search in
  the system to chase a dimension worth 1. There is a test named after it.
* **`flirty` was removed and then put back, and the reasoning matters more than
  the value.** §29.9 refused it as a D44 preference *list*, where it meant "find
  me somebody flirty" and pointed outward at people who had not asked. Intent
  inverts that — it says what *you* are here for and pairs only with somebody
  who declared the same — so the targeting objection is structurally gone rather
  than overruled (D46). It was removed on reasoning the redesign had already
  invalidated. The residual risk is unchanged: child safety relies on the
  age gate plus reporting and moderation, with stronger measures on the roadmap. Personas stay
  excluded on **authorship, not targeting** — persona speech is the operator's
  own (D-AI-11) and already outside s.79.
* **No frame may ever disclose a refusal to connect.** `connection_state`
  answers the caller about the caller; `connection_made` reaches both at once
  and is reachable only when both agreed; **ignoring a request sends nothing at
  all**. Asking *is* now announced (`connection_request`, D49) — that half of
  D47 was reversed deliberately, because a silent request is indistinguishable
  from a broken button. The refusal half was the load-bearing one and stands.
  There is still no fourth button state between Requested and Friends: that
  would report the other side's decision before they made it. The residual
  inference (a chat ending with no connection tells an asker the other did not
  agree) is inherent to mutual consent and is the only leak that is accepted.
* **The `connections` table must never gain a `conversation_id`**, and it is the
  table most likely to, because the natural description of the feature is "we
  met in conversation X". `010_accounts.sql` names this as the line to defend in
  review; a test asserts the column list against the live schema rather than
  trusting review. `created_by` is out for a subtler reason — it looks harmless
  and turns a symmetric relationship asymmetric by answering who asked first.
* **A connection is a canonical ordered pair**, `check (lo < hi)`. Two rows can
  disagree; one unordered row makes every query try both column orders. The sort
  happens inside the Lua, the one place holding both ids at once, and the
  repository re-checks it because the constraint's message names a column rather
  than the invariant.
* **Removing a connection is unilateral and a hard delete.** Consent to connect
  is mutual, consent to *stay* connected is not — requiring agreement to leave
  means somebody cannot stop being contactable. A `removed_at` tombstone would
  keep a record of a relationship one person explicitly ended.
* **The connection write may wait on PostgreSQL and it is not a D16 violation.**
  Retention is a side effect of every message and a dropped record costs
  evidence; a connection happens at most once per conversation, only when two
  people both pressed a button, and a lost one is a broken promise they watched
  succeed. It takes `report`'s shape, not `message`'s — and nothing on the
  message path calls into it.
* **`accounts.external_id` is never the primary key.** The obvious shape is to
  use the provider's `sub` as `accounts.id`. Payments reference `accounts.id`,
  so handing that key to a vendor defines a financial record on a system this
  project does not control, and a provider migration rewrites every foreign key
  rather than one column. The unique index is **partial** — a plain one collapses
  every account without an external id into a single row.
* **There is no JWT library, and that is only acceptable because the failing
  cases are tested.** Node verifies a JWK natively, so a library buys about
  forty lines at the cost of a dependency tree. Hand-written token validation is
  where authentication bugs live: `alg: none`, `HS256` (the key would be the
  *public* key), another pool's `iss`, another client's `aud`, expiry, a
  replayed `nonce`, an unknown `kid`. A validator nobody has watched reject a
  bad token is a validator nobody knows is running — so never add a check
  without a test for it failing.
* **The auth cookies are `SameSite=Lax`, not `Strict`.** Strict is dropped on
  the provider's cross-site redirect back, which breaks sign-in **only for the
  people who completed it** — the worst possible distribution of a bug. The
  `__Host-` prefix is dropped on local HTTP rather than left to fail, because a
  `__Host-` cookie without `Secure` is rejected silently and reads as "sign-in
  does nothing".
* **Sign-in is free and must never be coupled to payments.** It gates
  connections, recent history and friend requests; premium is the asymmetric
  matching preferences and nothing else. The `AuthModal` still on disk checks
  `ACCOUNTS_ENABLED && PAYMENTS_ENABLED` and is a **magic-link** form, which
  predates the OIDC decision — it needs replacing, not enabling.
* **Never embed a third party's image, script or widget.** The Privacy Policy
  says the browser makes no third-party requests, and `img-src` is `'self'
  data:` plus the payment provider. The Buy Me a Coffee button is the vendor's
  own SVG fetched once and served from this origin — self-contained, so nothing
  leaves the page. Their `<img src="img.buymeacoffee.com/...">` snippet would
  hand them every visitor's IP and referring page on every render, without a
  click. `docs/brand/README.md` has the re-fetch command.
* **The mark is drawn in three places and they must agree**: `Logo.tsx`,
  `public/favicon.svg` (inset so strokes clear the plate corners) and
  `docs/brand/*.svg`. The two arcs differ in **size** as well as opacity, and
  the size is the half that survives greyscale.
* **`abuse@` and `contact@` now carry clocks.** `abuse@` receives IT Act / IT
  Rules takedown orders with short statutory windows — acting inside them is
  part of the s.79 safe-harbour diligence. `contact@` carries the Terms'
  24-hour acknowledgement. Both are published commitments now, and an unread
  inbox does not fail loudly.
* **A preference is scored, never required.** Gender 4, country 2, vibe 1;
  highest wins, longest-waiting breaks a tie, and zero is the ordinary
  candidate — which is why the fallback needs no special case (D44, §29.8).
  Requiring all three does not survive the arithmetic: 15% of one gender times
  70% of one country times 20% of one vibe is two people in a hundred waiting,
  and under one in forty. The failure would be invisible, because the fallback
  still works — a paying user simply has a preference that never applies.
  Gender outweighs the other two combined on purpose, so country and vibe
  together can never displace it; there is a test named after that, because the
  weights are a decision rather than a constant to tune.
* **The preference lives on the session hash, not in an argument.** `tryMatch`
  reads `prefG`/`prefC`/`prefV` from the caller's own row, in the `HMGET` it was
  already issuing. A skip re-enters the queue carrying no profile and no
  preference — nothing the user asked for changed — so a preference passed per
  attempt would stop applying the instant somebody pressed next, which is the
  first thing they do. It follows the profile's rules for the same reasons:
  written whole so a cleared dimension is genuinely cleared, and session-scoped
  so nothing durable records what a person looks for (D34, §24.3).
* **The wide sample overlaps the ordinary one, so the scan tracks what it has
  already seen.** `SRANDMEMBER` draws independently, and without the `seen`
  table a blocked candidate walked by both passes is reported as two. Those
  counters are what §29.6 uses to decide whether the sample size is right, so
  they would have inflated precisely when widening happened. Found by a test,
  not by reading it.
* **The preference limits key on the IP hash, and that is the whole of them
  working.** `preferenceAllowance` is one Lua script — cooldown, then an hourly
  token bucket — and `joinQueue` writes the preference only when it grants.
  Every *other* limiter here keys on the session id, which is one connection:
  free to replace, and replacing it is the first thing somebody hunting would
  do. These read the hash from the session's own row, so no caller can name a
  bucket but its own (D18, protocol rule 3). Keying them on a session would look
  identical, pass every test that does not reconnect, and bound nothing.
* **Premium is enforced on the session hash, and `premium_until` is not the
  gate.** The column is the *truth*; what matchmaking reads is `premiumUntil`
  stamped onto the session row when a connection binds an account (D51). That
  keeps a search off PostgreSQL (D16) and off an extra Redis key. It was written
  by the payment webhook and read by nothing before this, which is why the
  column shipped ahead of payments in `017_premium_entitlement.sql` — the gate
  is provably closed while nothing can be bought, and there is a test asserting
  exactly that. It **fails closed**: a database that cannot answer means not
  premium, which costs a preference and nothing else.
* **The client learns about premium from `/auth/session`, not from the socket,
  and it is not a gate.** D51 on the session row is the only gate. This field
  exists so the interface does not *offer* a control the server will silently
  refuse — §29.4 requires a refused preference to be invisible, which is right
  for somebody who paid and spent their budget and exactly wrong for somebody
  who never paid: they would set a preference, watch it be accepted, and never
  learn it did nothing. Not on the `connected` frame because `stampEntitlement`
  is deliberately fire-and-forget, so the frame would race it and a paying user
  would watch the control vanish. Every failure answers **false**: wrongly
  hiding a paid control costs a click, wrongly showing one costs the trust of
  everybody who later finds out.
* **An entitlement bought mid-session applies on the next connection, not the
  next search.** Session-scoped by design. The client already has the seam —
  `reauthenticate` closes and re-opens the socket after sign-in and the resume
  token re-attaches the same session — so a payment does the same thing. If a
  purchase ever appears not to work, that is the first thing to check.
* **A refused preference must stay invisible.** Both limits degrade to an
  ordinary search — the preference is simply not written, so `tryMatch` scores
  everyone at zero and takes the longest-waiting, exactly as a preference
  matching nobody already does. There is no frame that could carry a refusal and
  there must not be one: a paying user is never told they have run out.
  `chat_preference_limited_total` is the only place either limit is observable,
  which is why it exists — without it, "matched nobody" and "never applied" look
  the same from outside and want opposite fixes.
* **The cooldown runs from the last *grant*, and §29.4 originally said from a
  match ending.** The literal version drops the preference for somebody who
  talked for twenty minutes and pressed next, which contradicts the same
  sentence's "costs nothing in ordinary use". Grant-to-grant bounds a scan
  identically, since a scan needs a preference-applied match every cycle. The
  deviation is recorded in §29.4 rather than left as a difference between the
  document and the code.
* **`PREFERENCE_LIMITS_ENFORCED` is now true and the guard still stands.** It is
  no longer "the feature is unfinished" — it is the seam that says these two
  settings are *live*. Reaching the `assertCoherent` throw now means somebody
  removed the limits, not that they were never built. Do not delete the constant
  along with the condition it used to guard: an unexplained `true` is one
  refactor from becoming configuration that looks applied and is not
  (`SPOOL_BACKEND=redis`, F-006).
* **`flirty` is not the same kind of vibe as the other three.** `chill`, `deep`
  and `funny` describe a tone; `flirty` declares an intent, and preferring on it
  means the server pairing people on sexual intent with no age assurance
  anywhere in the system (§29.9). It is accepted and stored — a declaration is
  not a match — and enabling a preference over it is a separate decision from
  enabling the other three. Personas never declare it (`SAFE_VIBES`), because
  persona speech is the operator's own (D-AI-11) and already outside s.79.
* **Never give Redis Sentinel a name that disappears with the thing it names.**
  The drill rig monitored the primary by container name with
  `sentinel resolve-hostnames yes`, formed a quorum, looked entirely correct,
  and then failed over *not at all*. Stopping a container removes it from
  Docker's DNS, Sentinel's lookup blocks, and the latency spike reads to
  Sentinel as its own clock jumping — so it enters TILT, a mode where it
  deliberately stops acting. It never votes, and the symptom is silence rather
  than an error. `docker-compose.sentinel.yml` uses static addresses now;
  `docs/operations/OPERATIONS.md` §17 is the drill.
* **A spool record deferred for a missing parent stays on disk.** `salvage` is
  shared by the live flush and the spool drain, and it used to hand everything
  it rescued to the in-memory queue regardless of origin — taking a record that
  was on disk *because the database was down* and moving it into the memory of a
  process that had just survived an outage (F-034). `RetryTarget` is the seam:
  `flush` passes the queue, `drainSpool` passes a collector and writes what it
  collects back to the file.
* **A test fixture can inherit a deadline meant for the code under test.**
  `pool.test.ts` sets `DATABASE_STATEMENT_TIMEOUT_MS` to a second because that
  is what it is testing, and `createPostgresContext` was running every migration
  on that same connection. Adding three index builds pushed it over on CI while
  it still passed locally, and the failure named the wrong thing entirely —
  "Query read timeout" from inside `migrate`, which reads as a broken migration.
  Migrations now run on their own connection at the default timeout.
* **The CRLF check flagged every binary file for a day.**
  `git ls-files --eol | grep -v 'w/lf' | grep -v 'w/none'` means "anything that
  is not one of these two", and a binary file is neither — it reports `w/-text`.
  The first PNG committed turned the step red and kept it red across three
  merges. It matches `w/crlf` positively now: the acceptable endings cannot be
  enumerated correctly because the set grows, and the unacceptable one is a
  single value.
* **The OIDC authorization code in the access log was the defect; the client
  address was a decision.** The stock `main` format logs `$remote_addr`,
  `$http_x_forwarded_for` and `$request` — and `$request` is the raw request
  line *including the query string*, so every completed sign-in through
  `location /auth/` recorded a bearer credential (F-036). `kbb_access` uses
  `$uri`, and that half is not negotiable: nobody has ever debugged anything
  with an authorization code. **The address half was reverted deliberately**
  (`5dc474e`) — `remote_addr`, `forwarded_for` and `user_agent` are back,
  because an access log without a client address is hard to debug with and hard
  to investigate abuse from, and because F-036 had gated a code change on draft
  policy prose, which is exactly backwards. The privacy policy §8 says the
  service receives your IP and lists abuse investigation among its uses, so the
  two agree; it does **not** claim addresses are never logged, and nothing
  should be written that says so. `verify-log-hygiene.mjs` therefore flags
  addresses only under `--addresses` — a check that fails on a healthy system is
  run with `|| true` within a week — while the credential and denied-field
  checks are never optional. Do not restore `main` for "more detail": the query
  string is the leak.
* **The log pipeline's second control is a detector, not a redactor.**
  `scripts/verify-log-hygiene.mjs` (`npm run verify:logs`) reads back what
  reached Loki and fails on addresses, credentials and denied field names. A
  scrubbing stage in the shipper was rejected on purpose: it would make a future
  failure of `logger.ts` or of the nginx format arrive looking clean. The script
  prints a truncated SHA-256 rather than the value, because a tool that reports
  a leak by quoting it has made a second copy of it.
* **Alloy's `stage.replace` replaces the captured group, not the whole match.**
  Capturing the parameter name and replacing it leaves the value in place and
  emits something that reads as redacted at a glance. Capture the *value*.
* **A four-part version number is an IP address to any regex.** The log-hygiene
  detector's first run reported `6.6.87.2` — the WSL2 kernel version out of two
  startup banners — as two leaked addresses. `\b` is not enough of a delimiter;
  reject a quad glued to a longer token.
* **`| json` in LogQL promotes every field to a label, including per-request
  ones.** A latency percentile over the nginx access log split into seven
  useless series because `conn` came along. Name the fields you want
  (`| json rs="request_seconds"`) and aggregate with `by ()`.
* **No metric may count a refusal.** A one-sided saved connection, a reconnect
  request that was ignored, a request stopped by a block: each is a private
  decision, and an aggregate of them turns it into an operational statistic.
  The `connectionsMade` comment in `metrics/registry.ts` recorded this before
  the product deck existed, and the phase-26 design proposed exactly what that
  comment had already refused. Count successes and technical faults; never the
  space between them.
* **The preference score is a bitfield, and the weights live in the Lua.**
  Gender 4, country 2, intent 1, so `chat_preference_applied_total` decomposes
  a number `tryMatch` already returns — no script change, no widened positional
  reply. The cost is that re-tuning the weights in `scripts.ts` would leave the
  decomposition running and silently attributing matches to the wrong
  dimension. `product-metrics.test.ts` reads the weights out of the Lua source
  and fails instead; do not delete it when the weights change, update it.
* **Conversation metrics are per side, not per conversation.** Counting a
  conversation's messages needs an `HINCRBY` on the message hot path or a wider
  `endMatch` reply, and neither is worth it for a metric. Per side is exact
  under summing across instances, and it is more informative: one side at zero
  is somebody being ignored, which a conversation total hides.
* **A conversation tally is flushed on the next match or on close, never on the
  conversation ending.** A conversation ends once, reported by whichever side
  won the race (D6) — hanging an observation there records one side of some
  conversations and neither side of others.
* **The funnel is one unit throughout: one session, one search.**
  `chat_connections_total` counts sockets including resumptions and
  `chat_matches_created_total` counts pairs, so a funnel assembled from those is
  a ratio across three denominators, wrong in a direction no graph shows.
* **A harness that has fallen behind does not report being out of date.** It
  reports a product bug, confidently, with a plausible count attached. The
  swarm was red for six days on 80-of-184 profile failures that were entirely
  the harness: `c043479` made country come from the connection, and the bots
  declared one while sending no `CF-IPCountry`. Bisect before believing a
  harness, and check the last green run against the commit dates (F-037).
* **The cost deck is priced in provisioned capacity, not consumed.** A fixed VM
  costs its vCPU count whether it is busy or idle, so a usage-based figure drops
  overnight while the invoice does not. Utilisation is a separate series and is
  never multiplied by a price. If this ever runs on something usage-billed, that
  rule changes deliberately.
* **Everything on the cost deck is micro-cents of US dollars.** `MODEL_PRICES`
  fixed that unit before the deck existed, and a price in another currency would
  be summed with persona spend by a recording rule, silently, producing a number
  that is neither. Convert once, in `loadConfig`; display in whatever currency
  at the very end.
* **An unpriced cost model must not render as $0.00.** Every price defaults to
  zero because a plausible default would be believed and wrong.
  `chat_cost_model_configured` is what lets a panel say "unpriced" instead.
* **`ws` hands you a Buffer, not a string.** `chat_ws_bytes_total{direction="in"}`
  read a flat zero against 133kB outbound because the counter guarded on
  `typeof raw === 'string'`. `metrics-wiring.test.ts` cannot catch this: it
  proves something writes the metric, not that the write is reachable.
* **cAdvisor on Docker Desktop / WSL2 sees only the root cgroup.** No
  per-container series at all, so a `name=~".+"` selector returns nothing.
  `machine_cpu_cores` and `id="/"` are what exist here.
* **A documented dead *label* is worse than a dead metric.**
  `chat_profiles_refused_total{reason="age_below_minimum"}` was described in the
  registry as a count of people declaring under 18 and cited to the minor-safety
  work, and nothing wrote it — the refusal happens inside `parseClientFrame`, so
  it pooled into `chat_invalid_frames_total{reason="invalid"}` with malformed
  JSON (F-038). `metrics-wiring.test.ts` proves a metric is written, not that
  each of its label values is.
* **A guard a type annotation satisfies proves nothing.** The first version of
  the dead-label check looked for the bare literal anywhere in `src/` and passed
  with the write site deleted, because the value also appears in
  `profileRefused(reason: 'age_below_minimum')`. Match a call argument. Then
  watch it fail before keeping it.
* **Prometheus stores `le="0"` as `le="0.0"`.** The scrape plainly emits
  `le="0"`; the stored series does not. An exact match on what the scrape shows
  is silently empty, and PromQL rejects `\.` as a string escape so the obvious
  regex will not parse either — use an `or` across both spellings. Same family
  as the stale-bundle trap: served and stored are different artifacts.
* **A safety series that only appears on first use reads as "never happened".**
  `chat_profiles_refused_total`, `chat_blocks_total`, `chat_rate_limited_total`
  and every `chat_retention_dropped_total{class}` were absent from a live scrape
  until the thing fired. A `p0` drop series appearing for the first time is
  safety evidence being lost, and before that the panel showed no data. Zero-
  initialise every closed label set.
* **`chat_retention_backlog` is deliberately NOT zero-initialised**, and the
  panel says so. `publishBacklog` refuses to publish a sample that never
  succeeded — a zero backlog from a monitor that could not read the database is
  the most reassuring thing this process could wrongly claim. Empty means never
  sampled, not nothing overdue.
* **A span processor must never throw.** `onEnd` is called synchronously from
  `span.end()`, inside the operation being measured, so a throw propagates into
  the database call it was watching — the load stack went into a restart loop on
  its first query and the thing crashing it was the safety control (F-040). The
  logger's throw-outside-production rule does not transfer: a log call is
  application code a test can wrap; a span processor is a callback a vendor
  invokes from somebody else's call stack. Redact, report once per attribute
  key, never throw. `strict` exists for `tracing.test.ts` and nothing else.
* **`enhancedDatabaseReporting: false` does not stop `instrumentation-pg`
  writing the statement.** It governs `db.statement`; the library also sets
  `db.query.text` on every span and that option does not suppress it (F-039).
  Only the exporter-side denylist caught it, which is the argument for D52 and
  D53 being two controls rather than one. Write the denylist against what a
  library *could* emit, not what its options mention.
* **OpenTelemetry started from `index.ts` instruments nothing.**
  `registerInstrumentations` patches a module by replacing its exports, and
  `pg` and `ioredis` are already imported by the time an async `main()` runs.
  The cost is not "a few early spans", it is every span, and it reports no error
  — Tempo simply stays empty, which looks like a quiet system (F-041). Tracing
  starts from `dist/tracing/preload.js` via `--require`, which reads
  `TRACING_ENABLED` before requiring anything OpenTelemetry so an off deployment
  still never loads the SDK. The `require` there must not become an `import`:
  imports are hoisted and would load it unconditionally.
* **`requireParentSpan: true` on `pg` hides the write-behind path.** It runs on
  a timer with no parent, so requiring one produces no spans for the subsystem
  `DESIGN.md` makes its strongest claims about. False for `pg`, true for
  `ioredis` — Redis is on every heartbeat and root spans for it would bury
  everything else.
* **The WebSocket message path is not traced, and that is stated rather than
  fixed.** A socket is one HTTP request that never ends. Tracing covers the HTTP
  routes and the retention path; the cross-instance conversation flow is read
  from metrics and logs.
* **Span attribute keys are flat and dotted; log fields are nested.** The same
  forbidden names arrive in a different shape, so `isForbiddenAttributeKey`
  checks every dotted segment as well as the whole key. A check written for one
  shape does not catch the other.
* **The payment schema is staged, so payments do not work by flipping a flag.**
  `011_payments.sql` is in `migrations-pending/`, not `migrations/`. Turn
  `PAYMENTS_ENABLED` on without it and the routes exist while every order fails,
  which reads as a broken integration rather than a missing table.
  `npm run payments:migrate:loadtest` applies it to the load stack;
  `tests/integration/payments-e2e.test.ts` applies it itself. Its number looks
  wrong beside an applied set running to 017 and is not — it depends only on
  `accounts` from 010, and `migrate()` tracks by filename, not ordinal.
* **`verifyWebhookSignature` returns a verdict, not a boolean.** `valid` /
  `invalid` / `malformed` / `unconfigured`, because "no secret configured" is
  not the same answer as "this signature is wrong" — collapsing them is how a
  deployment that forgot the variable accepts anything. A truthiness check on
  the result passes for three of the four values.
* **An unknown product returns `amount_mismatch` from `fulfilCapture`.** So a
  wrong product id reads as a pricing bug. The premium product is
  `premium_1_month`.
* **Never flip `features.ts` on a branch that will merge.** Its constants are
  compiled in and ship to production; the comment on them says turning one on is
  a commit, and doing it while `PENDING-PAYMENTS.md` is unapplied creates
  exactly the half-applied state `verify-pending-policy.mjs` exists to catch.
  The load stack gets payments through backend env plus the staged migration,
  never through that file.
* **The server's country comes from the connection, never from the declaration,
  and a harness that forgets it reports a product bug.** `server.ts` builds the
  join profile as `{ ...command.profile, country: connection.country }`, so a
  bot that declares *nothing* is still echoed a country-only profile. F-037 was
  that, twice: first the bots declared a country while sending no
  `CF-IPCountry`, then the ledger hashed what it sent rather than what the
  server would build. Both times the failure was deterministic per seed, which
  reads as a product bug rather than a harness one — a race looks random, and
  this did not. `bot.ts` remembers the country it connected with, because a
  persona may change its declaration afterwards (G1 does, in `onConnected`).
* **`TRUST_PROXY_HOPS` cannot be checked by a unit test, only measured.**
  `upgrade.test.ts` proves the counting; whether the configured count matches
  the deployed chain is a fact about topology. `npm run security:probe` measures
  it through `MAX_CONNECTIONS_PER_IP` and reports `INFO` rather than a verdict —
  the load stack *should* trust the header (it is how each bot gets an identity)
  and a bare nginx deployment should not. The right value depends on the
  deployed proxy chain, so measure it again after any change in front of nginx.
* **A probe that measures must not be turned into a probe that asserts.** An
  `INFO` verdict whose correct value depends on the deployment is the honest
  output. Failing on it is how a check ends up being run with `|| true`.
* **`parseClientFrame` must return, never throw.** `connection.ts` calls it
  inside `handleFrame`, so a throw is an unhandled rejection on a stranger's
  socket rather than a refusal. `validate-fuzz.test.ts` asserts that over ~13k
  generated frames, seeded so a failure reproduces — an unseeded fuzzer fails
  once on CI and teaches everyone to re-run.
* **The audit gate is `high` and `--omit=dev`, deliberately.** A vulnerability
  in a test runner does not ship and cannot be reached by a request. Gating on
  it would get the whole job disabled within a month; the full audit is reported
  without gating instead.
* **The message content-type field is `type`, not `contentType`.** Sending
  `contentType` is an unknown field, which P26's forward-compatibility rule
  says to ignore — so the message is delivered as ordinary text and the §23.6
  refusal never runs. Easy to write a test that passes for the wrong reason.
* **The state check runs before content-type dispatch.** An idle sender is told
  `NOT_MATCHED` first, so anything about content types has to be tested from
  inside a match.
* **A frame with no `version` is `UNSUPPORTED_VERSION`, not `BAD_ENVELOPE`**
  (F-042). The object check passes because it is an object, so structural
  garbage is reported as a version problem.
* **`join_queue` while already matched answers with nothing at all** (F-043).
  Correct for the race it was written for — a `matched` frame is already
  inbound — and it leaves a deliberate re-join waiting forever.
* **The P group lives in `tests/integration/protocol-abuse.test.ts`, not in the
  swarm**, though the catalogue put it there. One client each and a specific
  expected refusal is not a load scenario, and CI runs it on every push.
* **A Redis failover costs about eleven seconds and every instance leaves the
  load balancer at once.** Measured, not estimated: `npm run sentinel:up` plus
  the swarm, primary stopped mid-run — 0 backend restarts, ~11.2s of Redis
  unavailability, and 346 message positions agreeing across 113 conversations.
  `/ready` is derived from Redis alone, so the whole service goes not-ready
  together rather than one node failing over. `operations/OPERATIONS.md` §17.3-17.4.
* **`All sentinels are unreachable. Retrying from scratch` is ioredis during a
  promotion, not a lost quorum.** It appears in the backend log on every
  failover and is followed by recovery. Do not chase it.
* **The Sentinel rig and the Sentinel *stack* are different things.**
  `docker-compose.sentinel.yml` is Redis only and drills Redis;
  `docker-compose.sentinel-app.yml` layers the application onto it and is what
  answers whether conversations survive. Stop the load-test stack first — both
  publish the same host ports, and the second to start silently gets none.
* **D17 is now executed, not just documented.**
  `tests/integration/retention-integrity.test.ts` builds a second
  `Repositories` over the same database with a longer window — which is exactly
  what a deploy editing one variable does — and asserts the old rows keep their
  stamp. It also asserts `retention_expires_at` has **no column default**: a
  default would satisfy every other assertion and would move when somebody
  altered the table, so its absence is what makes the value provably the
  application's.
* **A staged policy patch gets a guard.** `scripts/verify-pending-policy.mjs`
  asserts a `docs/policies/PENDING-*.md` still matches the documents it patches,
  and no-ops when there is none. It caught a real half-applied state during the
  persona patch. Left in place so the next staged patch gets it free.

* **`docker compose --env-file X` does not put anything into a container.** It
  populates `${VAR}` substitutions in the YAML, and nothing else. A service
  receives a variable only from an explicit `environment:` entry or an
  `env_file:` directive. There was no `env_file:` anywhere here until phase 38,
  so an env file listing eighty settings configured exactly the ones the YAML
  interpolated and was inert for the rest, silently: an undeclared variable is
  not an error, and the process starts cleanly on its compiled-in default.
  F-045 counted 109 settings `config.ts` reads that no compose file passed, 99
  of them written down in `.env.example` as supported. **Fixed in phase 38** —
  `backend` and `personas` read `env_file: ${APP_ENV_FILE:-.env}`, and
  `npm run verify:config` now fails the build if that line is removed or a
  readable setting is undocumented. Still verify a setting by asking the running
  process (`docker exec <c> node -e "...loadConfig(process.env)..."`), never by
  reading the file you set it in.
* **The env-file path follows the profile, and that is load-bearing.** Every
  profile is invoked with its own `--env-file` (`.env.loadtest`, `.env.vps`,
  `.env.prod`, each copied from its tracked `.example`), so a hardcoded `env_file: .env` would have served development
  values to all of them — a regression that looks like the load stack being
  mysteriously hard to tune. Each env file sets `APP_ENV_FILE` to its own name;
  self-referential on purpose, so a profile that forgets the line falls back to
  `.env` rather than to nothing. `required: false`, because `.env` is not
  tracked and a fresh clone must still start.
* **An env file is delivered whole.** The application container's environment
  now contains every secret in it, including the Postgres superuser password and
  the Grafana admin password, which the application never reads. That is the
  price of one file, it is stated in `.env.prod.example`, and the mitigation for
  a deployment that cares is to keep those two out of the app's env file —
  compose still reads them for `${VAR}` substitution, which is a different
  mechanism from what reaches a container.
* **A `VITE_` value has to exist in three places or it silently does not
  exist.** `.env`, the compose `build.args`, and a Dockerfile `ARG` **and**
  `ENV` — an ARG alone is invisible to vite. Vite inlines it at build time, so
  changing one needs a rebuild, and the only honest check is grepping the
  **served bundle**. `verify-config` asserts all three.
* **A build-time number must refuse a bad value, not clamp it.** A `0` from a
  typo turns the reconnect backoff into a spin and every timeout into an instant
  failure, both of which read as a broken server rather than as a bad setting —
  and it cannot be corrected without another build. `readNumber` falls back on
  zero, negatives and unparseable input; `readNumberList` falls back to the
  *whole* backoff curve rather than a partially-parsed one, because the shape is
  the point.
* **One value, one default.** `DEFAULT_CADENCE` (what `humanCadence` and every
  test use) and `config.personas.cadence` (what production runs) are fifteen
  numbers that look identical until somebody edits one of them in one place —
  and nothing would fail, personas would simply be paced differently in
  production than in every test. `config.ts` reads its defaults *from*
  `DEFAULT_CADENCE`, and a test asserts both that they are equal and that the
  environment still overrides them: the equality alone would pass if config had
  stopped reading the environment entirely.
* **A guard that greps for literal names cannot see a composed one.** Ten rate
  limits are built by `rateLimit(env, 'MESSAGE', …)`, so `MESSAGE_RATE_PER_SEC`
  appears nowhere in `config.ts`. `verify-config.mjs` knows about the composed
  names and asserts that it still finds them — a guard on the guard, because a
  silently-empty extractor passes every other assertion in the file.
* **Empty output from a failed command reads as a real answer.** Checking
  whether the prod overlay inherited the new build args returned zero matches,
  which looked like "prod is missing them"; the command had failed on an
  unrelated missing variable and printed nothing at all. Same family as the
  stale-bundle trap — confirm *what* answered before believing the answer.
* **`os.cpus().length` ignores the cgroup; `availableParallelism()` does not.**
  In a container pinned to one core the first reports the *host* count — 8
  against the second's 1. Capacity derived from the wrong one authorises eight
  times what the box can serve, and on an unconstrained development machine the
  two agree, so it looks correct everywhere except the VPS where it matters.
  `connectionCeiling` in `config.ts` takes cores as a **parameter** with the
  host lookup as its default, because `loadConfig(env)` is a pure function of
  its arguments and a test has to be able to describe a box it is not on.
* **A compose overlay can add a service and cannot remove one.** The first
  `docker-compose.vps.yml` carried a comment listing the observability stack as
  "deliberately absent" and started every one of it — the comment was the whole
  of the mechanism. `--scale <name>=0` in the `vps:up` script is what actually
  omits them.
* **A swarm verdict is only as strong as the population above it.** A run
  reported `VERDICT: PASS` over 500 bots, **zero conversations and zero
  messages**: `ALLOWED_ORIGINS` named the wrong port and every upgrade was
  refused 403. Every oracle that could have failed needed a conversation to
  judge and there were none. Read POPULATION before reading VERDICT.
* **A saturated harness reports a server problem, confidently.** Swarm workers
  default to `min(cpus, ceil(bots/1000))` — two for 2,000 bots. The same 2,000
  gave 5,008 messages at ack p99 1261ms on the default and 12,245 at 598ms on
  `--workers 6`. The first reading was twice as bad as the truth and it named
  the server. Above ~2,500 bots the harness dies before the server degrades.
* **Capacity here is CPU, and it is not the thing anybody reaches for first.**
  Measured on 1 vCPU (`docs/testing/RESULTS.md`, 2026-09-02): ~1,100–1,400
  concurrent, with **~85% of the cost being connection maintenance rather than
  conversation** — an idle user is cheap on memory (9 KB) and nearly as
  expensive as an active one on CPU. Two plausible levers were measured and both
  did nothing: a mostly-idle population saved only 23%, and doubling
  `HEARTBEAT_INTERVAL_MS` to 40s moved nothing outside run-to-run noise. Memory
  is not the constraint at any tier being considered — the whole stack idles at
  118 MiB, and nginx idles at **4.1 MiB**, not the 114 MB once recorded.
* **The last 5% of the connection ceiling belongs to resumptions, and a seat is
  spent by resuming rather than by claiming to** (D63, §28.7). A returning
  browser and a first-time visitor arrive through the same upgrade, so before
  this the busiest moment refused the resume token §28 exists to honour — and a
  refused resumption destroys a live conversation for *two* people where a
  refused arrival loses one that never started. Three bands in `admission()`;
  the refusal in the reserved band sits **after** `lifecycle.resume`, because a
  subprotocol is the cheapest thing in the world to invent. Both bands return
  the identical 503: naming the reserve tells a client what to claim to be. The
  reserve comes **out of** the ceiling, never extends it, and derives to zero
  under `RESUME_GRACE_SECONDS=0`.
* **A browser never sees the 503 on a refused handshake.** It gets a close with
  code 1006 and nothing else — identical to a dead backend and to a dropped
  wifi — so the only way to tell them apart is to ask again over HTTP
  (`/api/capacity`, D64, §28.9). That endpoint answers **200 even when busy**,
  because a 503 would be indistinguishable from the outage the caller is ruling
  out; it carries no count, no ceiling and no instance id; and the copy never
  says "full", which describes a door where the truth is a wait. Fetched from
  the close handler for a socket that never opened, never polled — a close
  *after* an open is an ordinary drop and needs no explanation.
* **"Connection lost" is a lie on a first connection.** Nothing was lost;
  nothing was ever held. `socket_closed` carries `everOpened` (absent means "it
  was up") and a refused handshake suppresses the toast, leaving the landing
  screen — where the person is actually looking — to explain itself. No test
  could have caught this: every test that constructs a `socket_closed` was
  written about a conversation that dropped.
* **`closeSession` holds a seat only for a session that is in a match.** An idle
  session's row is deleted on close and there is nothing to resume — so any test
  about resumption has to pair two clients first. The first version of the
  reserve test did not, resumed nothing, and would have passed for the wrong
  reason.
* **An `information_schema` query with no `table_schema` filter passes alone and
  fails in a full run.** Every integration context migrates its own schema into
  one database, so `connections.test.ts` saw its column list three times over
  and reported it as a column somebody had added to the table `010_accounts.sql`
  names as the line to defend. Scope every catalogue query to `ctx.schema`, as
  `retention-integrity.test.ts` already did.
* **A backslash in a JavaScript string is gone before the regex sees it.**
  ``new RegExp(`...(\d+)`)`` compiles to `(d+)`, matches nothing, and a helper
  built on it reports "no such metric" rather than "this pattern is broken". Same
  family as the Lua backtick and the shell heredoc: one layer of quoting rewrites
  what the next layer reads. Prefer prefix matching over a pattern when reading a
  Prometheus scrape — and note that every series carries an `instance_id` label,
  so the value is never the second token on the line.

* **Development is compose project `karobakbak-dev`, production `karobakbak-live`.**
  The base file names the first and `docker-compose.prod.yml` overrides it (the
  last file's `name:` wins; `-p` beats both). Without them both are named after
  the directory, and on a host where they share one Docker engine, a
  development `up` or `down -v` would act on the live database. Containers are
  `karobakbak-dev-backend-1` / `karobakbak-live-backend-1`; `verify-config` fails
  if either name goes. Never `docker volume prune` there: a stopped live stack's
  database is an unattached volume.
* **Alloy ships only its own project's containers.** It used to take every
  compose container on the engine, so on a shared engine each stack's Loki held
  the others' logs. `ALLOY_COMPOSE_PROJECT` comes from compose's own
  `COMPOSE_PROJECT_NAME`, which compose fills for interpolation from the file's
  name or `-p`. `alloy validate` passes a misspelled function, so check a change
  to that file by running Alloy, not by validating it.
* **Git Bash rewrites arguments that start with `/`.** `docker exec c grep x
  /usr/share/...` arrives as `C:/Program Files/Git/usr/share/...`, finds nothing,
  and an empty result is exactly what a stale bundle looks like. `export
  MSYS_NO_PATHCONV=1`; `ops/restore-production.sh` sets it itself.
* **A CPU quota is invisible to Node.** `availableParallelism()` honours a cpuset
  and not a CFS quota, so a backend capped with `cpus: 1.5` still derives its
  connection ceiling from every core Docker has. Wherever a quota is the limit,
  set `MAX_CONNECTIONS` explicitly.
* **Compose checks `${VAR:?}` in a service parked behind a profile.** Interpolation
  runs over every file before profiles apply, which is why the tunnel profile's env sets
  Caddy's two variables to placeholders for a Caddy that never starts.
* **HSTS came from Caddy alone.** nginx does not send it. Behind the tunnel it is a
  Cloudflare dashboard setting, and losing it fails nothing.

* **Last-active exists, and it is coarse, mutual and erasable on purpose** (D65,
  `DESIGN.md` §31.7). It reverses an older "no last-seen, ever" that is still
  quoted in `016_connection_labels.sql` and the product documents. The route
  sends a bucket and never `last_active_at` itself; a viewer who hides gets no
  bucket for anybody; turning sharing off nulls the column in the same
  statement. The stamp rides the heartbeat **unawaited** and gated to one write
  an hour — the heartbeat loop visits every socket in turn, so awaiting a
  database write there is how a slow PostgreSQL times out healthy connections.
* **A friend's Chat goes through the visibility key, never the routing key.**
  `presence.visibleSession` reads `chat:online:`; `sessionFor` reads
  `chat:sess:`. Using the second would let a Chat button reach — and so reveal —
  a friend who turned presence off.
* **A link-preview card cannot be per-page.** WhatsApp, Facebook and X build it
  from `index.html` without running script, so the Open Graph tags there are the
  whole site's card. Per-page titles, descriptions and canonicals live in
  `src/meta.ts` and only reach crawlers that run JavaScript. A new public page
  needs an entry there and a line in `public/sitemap.xml`; `meta.test.ts` fails
  until both exist.
* **An account's deadline moves at sign-in, and only there** (D66). Credentials
  are absolute and last thirty days, so sign-in is the one event every active
  user repeats; `AUTH_ACCOUNT_RETENTION_DAYS` must stay longer than a session
  and `assertCoherent` enforces it. Anything that keeps somebody signed in
  longer than `AUTH_SESSION_TTL_SECONDS` — a sliding credential, a "remember me"
  — would need to restamp too, or an active account is deleted under its owner.
* **The integration suite connects as a superuser, so it cannot see a missing
  grant.** The deletion worker issued `delete from admin_audit` as
  `karobakbak_app`, which holds only select and insert on it (append-only, I11).
  PostgreSQL checks privileges before rows, so every production pass failed with
  42501 at that step from the first deployment — and every test passed. It
  surfaced only when alert delivery first worked. Expiry of a table the chat role
  must not delete from goes through a `SECURITY DEFINER` function that removes
  only rows past their own deadline (`expire_admin_audit`,
  `expire_payment_orders`), with the search path pinned and EXECUTE for the chat
  role alone. Anything the worker does is now also tested **as that role**
  (`asChatRole` in `deletion.test.ts`). Any new code path that writes as the
  chat role needs the same treatment, or it is tested against a different
  system from the one that runs.

## Commands

```bash
# from the repo root
npm run install:all           # install backend + frontend
npm run verify                # protocol drift check + typecheck + unit tests
npm run typecheck
npm test                      # backend unit tests

# backend package
cd backend
npm test                      # unit
npm run test:integration      # needs Redis on :6380 -> npm run redis:test:up (root)
npm run typecheck
npm run build                 # tsc -> dist/

# integration Redis
npm run redis:test:up         # root; docker compose -f docker-compose.test.yml
npm run redis:test:down
```

## Conventions

* TypeScript strict; CommonJS output (`module: node16`); Node >= 20.
* Tests must assert behaviour, not "does not throw". Race conditions get their
  own explicit test.
* Every exported function that touches matchmaking state gets a comment saying
  which invariant (I1–I8 in `DESIGN.md` §3) it preserves.
* Commit per phase, conventional-commit subject, body explains *why*.
