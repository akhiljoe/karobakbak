# Testing — start here

Four documents, each answering a different question.

| | |
|---|---|
| [`REGISTER.md`](REGISTER.md) | What is covered and what is not. The agenda |
| [`RESULTS.md`](RESULTS.md) | What ran, when, and what it found. Append-only |
| [`FINDINGS.md`](FINDINGS.md) | Every F-numbered finding and what is left to decide |
| [`LAUNCH-GATE.md`](LAUNCH-GATE.md) | Every public claim, against the thing that demonstrates it |

**If you are deciding whether to launch, read `LAUNCH-GATE.md` and nothing
else first.** It ends with three blocking items and five things you would be
choosing to ship without.

---

## Running everything

### On every push, and by hand in seconds

```bash
npm run verify          # protocol drift, pending policy, both typechecks, both unit suites
npm run test:integration    # needs Redis on :6380 and PostgreSQL — npm run redis:test:up
```

`npm run verify` is hermetic and must stay that way: it has to be runnable with
nothing running. **It is not the whole build** — the table-enumeration guard
lives in the integration suite, so a new migration can be green locally and red
in CI.

### Against a running stack

```bash
npm run loadtest:up                 # the load stack: its own database, its own ports

npm run swarm -- --bots 5000 --duration 300 --profile realistic \
  --redis      karobakbak-loadtest-redis-1 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2

npm run security:install && npm run security:probe   # 11 live probes
npm run verify:logs                                  # what actually reached Loki
```

Pass `--redis`, `--metrics` and `--containers` or six of the eight oracles skip,
including the log-leak check, which is the strongest safety assertion the swarm
makes. A run that skips them is not a smaller version of a full run; it is a
different, much weaker claim.

### Catching a regression

The oracles judge a run against its own internal consistency. None of them can
see the run *before* this one, so a change that halves throughput or doubles the
time to find somebody passes every one of them and the verdict says PASS.

```bash
# freeze a run you are happy with
npm run swarm -- --bots 400 --duration 300 --profile realistic   --record-baseline --baseline-note "why this run was worth freezing"

# and from then on
npm run swarm -- --bots 400 --duration 300 --profile realistic --compare
```

A regression fails the verdict and sets a non-zero exit code, the same as a
failed oracle.

**Baselines are recorded deliberately and never learned.** A baseline updated
automatically from each green run is a ratchet in the wrong direction: a
regression arriving in small enough steps is absorbed one run at a time, and the
file ends up describing whatever the system currently does — the one thing a
baseline must not be. `baselines/<profile>.json` carries the commit it was taken
at and a note saying why.

Metrics are **per bot per minute**, so a baseline recorded at 400 bots over 300
seconds still means something at 40 over 60. Tolerances are wide on purpose —
they catch a step change, not a drift. Drift is what the dashboards are for, and
a check that fails on a busy afternoon is one that gets run with `|| true`
inside a month.

### The failover drill

```bash
npm run loadtest:down       # both stacks publish the same ports
npm run sentinel:up
npm run sentinel:status     # expect flags=master, num-other-sentinels=2

# drive it, then pull the primary out about a third of the way in
npm --prefix load-test/swarm run swarm -- --bots 60 --duration 120 \
  --profile realistic --seed 40 --url ws://localhost:8090/ws --origin http://localhost:8090
npm run sentinel:failover

npm run sentinel:restore && npm run sentinel:down
```

`OPERATIONS.md` §17.3–17.4 has the procedure and the numbers it produced.

### Watching it happen

Grafana on the load stack is <http://localhost:3002> (admin/admin). Five
dashboards: overview, product, cost, safety, logs. Tempo has traces when
`TRACING_ENABLED=true`.

---

## Reading a swarm verdict

Exit code is non-zero if any oracle failed **or a worker died**. Both matter:
a crashed run once printed PASS on 11 conversations out of 1,000, because every
oracle read the truncated ledger as a smaller, self-consistent population.

Two things that are not failures:

* **`SKIP` on six oracles** means you did not pass the container flags above.
* **A spurious worker death on Windows** (`exit code 3221226505`) has been seen
  three times and has never reproduced. Re-run before investigating — but never
  accept the numbers from a run that logged it.

One thing that is a known failure: **profile agreement reports a residual ~6%**
(F-037). It is deterministic per seed and is not the product; see `FINDINGS.md`.

---

## Before adding a test

Read `docs/LOADTEST-SCENARIOS.md` for the catalogue and `docs/SWARM-HANDOFF.md`
for the thirty-odd traps that have each already cost a red run.

Then ask where it belongs. Three groups were catalogued as swarm rows and are
not load scenarios at all — P needs one client and one expected refusal, D needs
a real database and control over configuration, R needs two writers racing on
one Redis. All three moved into the integration suite, where they run on every
push instead of when somebody remembers to start a stack.

**The rule of thumb: if it does not need load, it does not belong in the load
harness.**
