# Launch checklist

The single tracked list of what must be true before karobakbak is public.

**This file does not hold the reasoning.** Every row names the document that
does, and that document stays the authority. A checklist that restates its
sources drifts from them, and then two places disagree about the same fact —
which is the failure this project has already had in its policy set once, and in
its configuration twice. If a row and its source disagree, **the source is
right and this file is stale**.

Three registers feed this. Read them, not summaries of them:

| Register | Holds |
|---|---|
| `docs/testing/LAUNCH-GATE.md` | Every public claim mapped to the thing that demonstrates it |
| `docs/testing/FINDINGS.md` | Open F-numbers and what each still needs |
| `PHASES.md` § Launch | The deploy-day settings and what is deliberately not blocking |

Status keys: `[ ]` outstanding · `[x]` done · `[~]` decided, not yet built ·
`[-]` deliberately deferred, with a trigger.

---

## A. Legal and policy — the operator decides these

- [x] **Operator identity published** in the Terms, as the Indian rules require.
- [x] **Grievance Officer named**, with designation and contact details, plus the
      GAC appeal route and the Rule 3(2)(b) 24-hour removal commitment.
- [x] **`payment_orders` retention: 7 years**, and the deletion worker enforces
      it.
- [x] **Seller of record: the operator.** Razorpay is the processor, not a
      merchant of record (terms §15).
- [x] **Publication date: 7 September 2026.** Set in both drafts, both wording
      sources and the shipped pages. It is now a commitment: the documents say
      they take effect that day.
- [ ] **Refund policy.** Deferred rather than drafted: Premium is to renew by
      default and a draft written for one-off purchases would have to be
      reversed in front of the people who relied on it. Write it once, for a
      renewing subscription. `PENDING-PAYMENTS.md` holds what renewal drags in.
- [ ] **Postal address, before payments only.** Absent on purpose while the
      service is free — Rule 3(2)(a) asks for contact details, which email and
      phone satisfy; the principal geographic address is a Consumer Protection
      obligation that attaches when money changes hands. Recorded in terms §18.
- [-] **Child safety.** Today it relies on the age gate plus reporting and
      moderation. Stronger measures (age assurance, grooming detection) are
      planned; see `PHASES.md` § Deferred.

## B. Product — must be true before the site is public

- [x] Age gate, versioned acknowledgement, never server-side.
- [x] Geo-block at the edge covering `/ws`, not only the page.
- [x] Moderation, blocks, bans, reports, and the console behind its own process
      and its own database role.
- [x] Retention enforced and demonstrated — the database-agreement oracle proves
      deadlines are stamped at insert (D17), not computed at deletion.
- [x] **A full swarm run, all oracles, read before launch.** Done 2026-09-04:
      `--seed 1823922046 --bots 400 --profile adversarial --duration 300
      --chaos c1` returned `VERDICT: PASS` with nine of nine oracles running —
      no skips, so no footnote weakening it. `docs/testing/RESULTS.md` holds the
      numbers. Three oracles failed first and all three were the harness
      (F-046, F-047, F-048); two were re-run on the failing seed to prove the
      fix rather than a different run that happened to pass.
- [x] **`npm run verify:logs`** against the deployed stack, not a dev machine.
      **Run on the box 2026-09-04.**
      Rehearsed on the load stack 2026-09-04 after an adversarial swarm: PASS
      over 3,456 lines across 23 streams, backend and frontend both present.
      The rehearsal is not the row — the deployed run is — but it did find that
      the script printed PASS over **zero** lines, which is the hollow verdict
      this checklist exists to distrust. It now prints per-service coverage and
      refuses a verdict below `--min-lines` (20). Run `--addresses` too and
      expect it to report the visitor addresses nginx keeps on purpose
      (`5dc474e`); that flag is an audit, not a gate.

## C. Deploy day — settings that can only be got right on the box

**Superseded 2026-10-10: the first host was retired and production moved to a
single host behind a Cloudflare Tunnel, starting from an empty database.** The
ticked rows further down were true of the first host and are kept as its
record; none of them carries over. These are the rows for the current host:

- [x] **Migrations applied** and `schema_migrations` matching the migration
      files (2026-10-10). A `migrate` run with nothing new logs `"applied":0`,
      which is correct, not a failure.
- [x] **`TRUST_PROXY_HOPS` measured** from nginx's access log with a forged
      header, *and* `security:probe` passing with a real population
      (2026-10-10): a forged entry is prepended rather than trusted.
- [x] **HSTS enabled in Cloudflare** (2026-10-10). Check with
      `curl -sI https://karobakbak.com/ | grep -i strict-transport`.
- [x] **Sign-in, geo-block, served bundle, edge cache** (2026-10-10): a real
      Google sign-in completed; `451` for page and `/ws` from a blocked country,
      `200` from India; the bundle is current; `CF-Cache-Status: HIT` on the
      hashed JS.
- [x] **A new backup taken, reported and restored once**, under a new passphrase
      held in a password manager (2026-10-10): uploaded to
      `r2:<backup-bucket>`, reported `ok=true`; the drill decrypted it and
      `pg_restore` brought back all tables cleanly. The off-host copy was then
      downloaded and matched the local one by SHA-256, the path a lost host
      would need.
- [x] **An alert reached the operator's phone** (2026-10-10), delivered through
      ntfy; Alertmanager counted the send with zero failures.
- [x] **A conversation held from a phone on mobile data** (2026-10-10).
- [ ] **The site comes back after a host restart without being touched.**
- [ ] **The console runs on the host**, bound to loopback only.

The first host's record follows.

**The first host existed as of 2026-09-04**, hardened per
`operations/FIRST-BOOT.md`: key-only SSH, root login refused, a firewall down to
SSH and web ports, Docker without sudo, swap. DNS is on Cloudflare with the
apex and `www` both **proxied**, `www` redirecting to the apex, and Cognito's
`auth` record left unproxied.

**The stack was deployed and serving as of 2026-09-04.**
`https://karobakbak.com` answered over TLS, migrations were applied, sign-in
completed through Cognito to Google, and a two-party conversation was held
on it. `operations/GOING-LIVE.md` is the procedure, and it was corrected in
seven places by being followed — most of the defects found were configuration or
documentation rather than product, and every one presented as a broken build.

- [x] **`TRUST_PROXY_HOPS` measured against the real chain** and paired with
      Cloudflare in Caddy's `trusted_proxies` (`901c014`); without that entry
      Caddy discards the client address at the first hop and the whole internet
      shares one rate-limit bucket. Measured with
      `npm run security:probe -- --origin https://karobakbak.com`, which passed
      against a real population. Note the `--origin`: it defaults to the
      load-test stack's port, and a bare run reports connection refusals as
      failures. The right value is a fact about topology, so the probe reports
      `INFO` rather than a verdict; see `docs/operations/CONFIGURATION.md`.
- [x] **Cloudflare apex set to Proxied** (2026-09-04), verified by resolving
      the apex and getting a Cloudflare address.
- [x] **`BACKUP_REMOTE`** set, and a restore actually performed once
      (2026-09-04): a daily encrypted dump to `r2:<backup-bucket>`,
      `reported ok=true`, then fetched back and restored. `ops/restore-production.sh`
      is that drill as one command (`npm run restore:drill`), so the recovery
      path is rehearsed rather than only described. Three traps it found are in
      `operations/GOING-LIVE.md` step F. Previously drilled against
      a MinIO stand-in for R2, both refusals watched failing. `restore.sh` now
      ships in the backup image; it did not exist before the drill. See F-049
      for the CRLF trap the drill found, which silently destroys recoverability.
- [x] **Production build variables** — set in `.env.prod`, and the values
      confirmed in the **served bundle** rather than the source, 2026-09-04.
      The prod compose refuses to build without
      `VITE_TERMS_URL` and `VITE_PRIVACY_URL`, so a gate citing documents nobody
      can open cannot ship.
- [x] **Alerts reach somebody** (2026-10-10, see the rows above).
      `alertmanager.yml` points both receivers at
      `url_file: /etc/alertmanager/webhook-url`, gitignored and written once by
      the operator (`webhook-url.example` shows the shape). Absent on the host,
      twenty-odd rules fire into nothing — including `AlertNotificationsFailing`,
      which is delivered through the thing that is broken. `ls` it on the
      host; do not assume it from the repository, which holds only the
      example. Phase 41.
- [ ] **The moderation console is reachable on the host.** It has no compose
      service: `npm run console` via `tsx`, from source. Fine while nobody could
      file a report, wrong the moment strangers can — `ReportsWaitingTooLong`
      can page about a report there is no deployed tool to read, and persona
      transcripts (D-AI-12) are unreadable for the same reason. It keeps its own
      process and its own database role either way (D32). Phase 41.
- [ ] **The two inboxes that carry clocks are monitored.** `abuse@` receives IT
      Act takedown orders with short statutory windows; `contact@` carries the
      24-hour acknowledgement. Neither going unread fails loudly, which is the
      whole difficulty.

## D. Before payments — not before launch

Payments are off in both halves and nothing can be bought. These block the flip,
not the launch.

- [~] **Premium renews by default** — decided 2026-09-04, code is one-off only.
      RBI e-mandate rules, pre-debit notification, affirmative consent under
      Rule 4(9), a cancellation control that exists, renewal-aware entitlement
      arithmetic. `PENDING-PAYMENTS.md`.
- [ ] **Price, and whether there are tiers.** ₹99 is a placeholder that had
      started to read as a decision. The Premium page states it in prose while
      the server charges from configuration and nothing checks they agree.
- [ ] Apply `011_payments.sql` from `migrations-pending/`, and
      `docs/policies/PENDING-PAYMENTS.md` in the same commit.
- [ ] **Verify the Razorpay statement descriptor and invoice with a real test
      payment.** Nothing in this codebase shows the operator's name or bank
      details; what a customer sees comes from the merchant account. Verify it,
      never assume it.
- [ ] `{{PREMIUM_PRICE}}`, `{{PAYMENT_PROVIDER}}`,
      `{{PAYMENT_RECORD_RETENTION_PERIOD}}`, `{{REFUND_POLICY}}`.

## E. Only if the feature ships

- [-] **AI personas.** `{{MODEL_PROVIDER}}` is needed only with a model behind
      them; on the scripted voice they spend nothing and reach no vendor. A
      second vendor is a policy change before it is a config change.
- [-] **Sign-in** — `{{IDENTITY_PROVIDER}}`, `{{FEDERATED_PROVIDER}}`. Live
      against Cognito federated to Google on `<cognito-domain>`.

## F. Known and accepted

Not blockers. Listed so nobody rediscovers them as surprises.

- **Redis is a single point of failure** (F-033). The code is done and drilled
  under load; what remains is a second machine, which is a cost decision.
- **F-042 / F-043** — two protocol answers that are wire contract, so changing
  either is a decision rather than a fix.
- **Deployment builds on the VPS** (`docs/operations/DEPLOYMENT.md` D1). Not a cost on a
  fixed monthly box; it costs provenance and rollback speed, and matters from
  the first real user rather than before.
- **Five configuration leftovers** — `docs/operations/CONFIGURATION.md` §6.
- **CI installs dominate every run, and caching did not fix it.** Measured
  2026-09-04: `setup-node`'s `cache: npm` hits and restores in all three jobs,
  and installs still take around seven minutes each, because that cache holds
  downloaded tarballs while `npm ci` still deletes and re-extracts several
  hundred packages. The tests themselves run in 18–43 seconds. One run the same
  day completed in 1m28s with 23-second installs on identical inputs, so a large
  part of this is upstream rather than configuration. **The change that would
  actually attack it is caching `node_modules` directly, keyed on the
  lockfiles** — deliberately not attempted three days before launch, when CI is
  green and the local `npm run verify` answers in seconds.
- **Dependency auditing now has two mechanisms, and finding that out switched
  one of them on.** On 2026-09-04 the frontend `npm audit` timed out on the bulk
  advisory endpoint on two consecutive runs, warned, and let both builds go
  green — a control that had stopped existing while still appearing in the log.
  Fixed rather than tolerated: the CI audit retries three times with a widening
  pause and raised npm fetch timeouts, and then **fails** if it still could not
  run. The objection to failing — that npmjs.com availability should not block a
  merge — is answered by **Dependabot security updates**, which watch the
  committed lockfiles server-side and do not care whether a runner could reach
  the registry.

  Writing that down is what exposed the real gap: **Dependabot alerts were
  disabled on this repository entirely**, so the backstop being cited did not
  exist. Enabled the same day (`gh api -X PUT .../vulnerability-alerts` and
  `.../automated-security-fixes`; 0 open alerts at the time of writing). They
  are repository settings, invisible in the tree and unassertable by any test
  here — `gh api repos/<owner>/<repo>/dependabot/alerts` returns 403 when they
  are off, which is how to check before believing this row.

  `.github/dependabot.yml` configures *version* updates, which are housekeeping
  rather than a control, and which opened fourteen major-version pull requests
  within a minute of being switched on. Every limit in it is `0` until after
  launch — the documented way to stop routine upgrades while leaving security
  updates running. Raise them to 5, one ecosystem at a time, once the site is
  up.

  Both retry paths were tested against a stubbed npm before shipping: recovers
  on the third attempt, fails after three. The gate itself now lives in
  `scripts/ci-audit-report.mjs` rather than inside a shell string, because the
  first version of it was broken by an apostrophe in one of its own comments —
  and `npm run verify:workflows` shell-parses every `run:` block so that class
  is caught locally instead of by a push.

---

## Keeping this honest

Add a row when a decision is taken, and name the document that holds the
reasoning. Do not paste the reasoning here.

Tick a box only against evidence: a passing check, a document that exists, or
something observed on the running system. "It should work" is how a checklist
starts lying, and a launch checklist that lies is worse than none — it converts
an unknown into a false certainty at the exact moment that matters.
