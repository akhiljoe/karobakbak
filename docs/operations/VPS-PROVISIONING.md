# The box — which vendor, which plan, and how to set it up

Written 2026-09-04, three days before launch, because six of the seven
outstanding launch-checklist rows need a machine that does not exist yet.

This holds the **hosting decision and its reasoning**. `DEPLOYMENT.md` is about
what runs on the box once it exists and how code gets there; `OPERATIONS.md` is
the runbook for when it is running. Where this and those disagree about a fact,
they are the authority on their own subject.

---

## 1. The decision: host in India

**Mumbai or Bangalore, on any of DigitalOcean, AWS Lightsail, Vultr or Akamai
(Linode). 2 vCPU, 2 GB RAM, 80 GB SSD.**

*Revised 2026-09-04 from 4 GB to 2 GB, after measuring the thing the 4 GB was
bought for — see §2.2. The measurement is the reason, not the price.*

*What was actually used: a DigitalOcean droplet first (`FIRST-BOOT.md` is that
box), later replaced by a single host behind a Cloudflare Tunnel. The reasoning
below is the decision as it was made on 2026-09-04, kept because the
jurisdiction argument still applies to any future move.*

Three reasons, in the order they actually matter.

### 1.1 India is already the floor, so Indian hosting adds no new regime

`docs/policies/JURISDICTIONS.md` §1 opens with the fact everything else hangs
off: the operator is resident in India, so the IT Act, the IT Rules 2021, the
DPDP Act and POCSO attach **regardless of where the server is**. Hosting in
India therefore adds nothing to the compliance surface. It is the only location
with that property.

### 1.2 The other two obvious choices each import a regime this project spent effort avoiding

**The US is ruled out by the project's own research.** JURISDICTIONS.md §2:

> **§2258A reporting duties attach to providers**, so US hosting pulls you into
> that regime whether or not you serve US users.

A solo operator with one person doing moderation does not want a US federal
reporting duty on day one. That document deliberately left the US serving
decision open "until hosting is settled, because hosting decides half of it" —
settling hosting outside the US is what keeps that decision open and cheap.

**The EEA is ruled out by the same logic that produced the geo-block.** The
service blocks the EEA and the UK precisely to avoid obligations that are owed
on day one for a single user. Putting the servers inside the EEA invites an
argument that processing happens in the context of an establishment in the
Union — the exact question the block exists so as never to have to answer. It
may well be arguable either way; the point is that it is a question, and cheap
hosting is not worth acquiring one.

**This is what disqualifies Hetzner**, which is otherwise the obvious value
choice and roughly half the price. Its locations are Germany, Finland and the
US: the two regimes above and nothing else. Do not take the cheaper box.

### 1.3 The users are nearer

JURISDICTIONS.md §2 again: "For a product with no revenue and no marketing
budget, [South and Southeast Asia, Latin America and Africa] is where a
population would realistically come from regardless." Mumbai or Bangalore is the
closest option to the largest part of that. This is a real-time chat product
where round-trip time is the felt quality — and it is the weakest of the three
reasons only because the other two are legal.

### 1.4 What settling this unblocks

Two documents are waiting on it and can be finished now:

* The CSAM escalation route. JURISDICTIONS.md flags that NCMEC is "relevant
  mainly if hosting in the US brings you inside the US provider definition".
  With Indian hosting it stays **POCSO reporting to Indian police and the
  SJPU**, with NCMEC as a voluntary secondary.
* The US serving decision stays open rather than being forced by infrastructure.

---

## 2. The plan: 2 vCPU, 4 GB — and the RAM is not for connections

Everything below is measured, from `docs/testing/RESULTS.md` and
`DEPLOYMENT.md` §1. None of it is estimated.

### 2.1 CPU is the constraint, and one core is already enough

**~1,100–1,400 concurrent connections per vCPU.** About 85% of that cost is
connection maintenance rather than conversation, so an idle user is nearly as
expensive as an active one. Two vCPU is therefore roughly 2,200–2,800
concurrent, which is far past anything a launch needs.

Two plausible levers were measured and both did nothing: a mostly-idle
population saved only 23%, and doubling `HEARTBEAT_INTERVAL_MS` moved nothing
outside run-to-run noise. Capacity here is bought with cores, not with tuning.

Take 2 rather than 1 for a reason that is not capacity: on one core a deploy
compiles the project on the same core that is serving conversations.

### 2.2 Memory: the build was measured, and it is small

At idle the whole application — two backends, frontend, Redis, Postgres — is
**155 MiB**, and nginx alone is 4.1 MiB. Production adds Prometheus (74 MiB) and
Grafana (72 MiB); Loki, Tempo, Alloy, cAdvisor and the exporters are scaled to
zero. Call it 300-400 MiB serving.

The reason to buy more than that was `DEPLOYMENT.md` §4.1's OOM-during-deploy
row — the only entry that can take the service **down** rather than merely slow
it — which estimated `tsc` and esbuild at "300-600 MB on top" and marked itself
"plausible and **unmeasured**".

**Measured on 2026-09-04.** A full `npm ci` plus `vite build` plus `tsc`, for
both packages, in a container with swap disabled:

| Limit | Result |
|---|---|
| 1536 MB | builds cleanly |
| 768 MB | builds cleanly |
| 512 MB | builds cleanly |
| 384 MB | builds cleanly |

So the estimate was high by roughly a factor of two, and the row it justified is
answered rather than merely respected. On a 2 GB box the serving stack leaves
about 1.6 GB free and the build wants under 400 MB — not close.

**2 GB, then.** 1 GB would probably also work and is not worth the margin: it
leaves ~600 MB for a build measured at ~400 MB, plus whatever Postgres wants for
cache as the retained corpus grows, and the failure mode is an OOM kill during a
deploy. 2 GB buys a factor of four on the only number here that can take the
service down, for about a thousand rupees a month.

Note what this does *not* say. It does not say the build is free — it still runs
on the same cores that serve conversations, which is why §2.1 takes 2 vCPU. And
it does not remove the argument for CI-published images (§5), which was never
about memory.

### 2.3 What to actually order

| | |
|---|---|
| Region | Mumbai or Bangalore |
| Size | 2 vCPU, 2 GB RAM, 80 GB SSD |
| Image | Ubuntu 24.04 LTS |
| Transfer | Anything on offer — text chat is tiny, the JS bundle is the only real egress |
| Snapshots | On — but they are not the backup that counts, and the one that does is `OPERATIONS.md` §7c |

Roughly the $20–24/month class at every vendor named above. **Verify the price
at purchase.** These move, and this document is not a price list.

---

## 3. Before touching the box: two things that are not the box

### 3.1 DNS, and the one setting that silently breaks the geo-block

Point `karobakbak.com` and `www` at the box's IPv4 (or, behind a Cloudflare
Tunnel, at the tunnel, which is proxied by construction).

**Set the apex record to Proxied — the orange cloud — in Cloudflare.** This is a
launch-checklist row of its own because of *how* it fails: `CF-IPCountry` only
arrives when Cloudflare proxies the request, and `frontend/nginx.conf` reads
that header to enforce the EEA/UK block. DNS-only mode does not error. The
header is simply absent, every visitor looks unclassified, and the block quietly
stops blocking. Nothing in the application notices.

`auth.karobakbak.com` already exists for Cognito and is unaffected.

### 3.2 The two inboxes carry statutory clocks

`abuse@` receives IT Act and IT Rules takedown orders with short statutory
windows; acting inside them is part of the s.79 safe-harbour diligence.
`contact@` carries the Terms' 24-hour acknowledgement commitment.

Both are published commitments now. An unread inbox does not fail loudly, so
route them somewhere with a notification you will actually see — a phone, not a
browser tab.

---

## 4. The runbook

Vendor-neutral from here: it is Ubuntu, Docker, and this repository's own
compose files.

### 4.1-4.2 First boot: hardening, firewall, Docker, swap

**[`FIRST-BOOT.md`](FIRST-BOOT.md) is the walkthrough** — every command with what
it does, what you should see, and what to do when it does something else. It is
not repeated here.

In outline: create a `deploy` user with a password (it needs one, because `sudo`
asks for it), copy the authorised key across, **prove the new login and `sudo`
work from a second terminal**, then disable root login through a drop-in in
`/etc/ssh/sshd_config.d/` — the main `sshd_config` is overridden by that
directory and editing it directly is a confusing half hour. Then `ufw` down to
22, 80 and 443, Docker, and 2 GB of swap.

The rule that outranks every command there: **never close a working SSH session
until the next one is proved.** A droplet has no console.

### 4.3 onwards: code, environment, TLS and verification

**[`GOING-LIVE.md`](GOING-LIVE.md) is the walkthrough** — deploy key, the
thirteen required variables, what each secret protects, how `TRUST_PROXY_HOPS`
is chosen for the proxies in front of the backend, the application role's
password (which no script sets),
and how to prove the result rather than look at it. Not repeated here.

The two steps most likely to be missed, because both look like a broken build:

* **`karobakbak_app` has no password.** `002_roles.sql` creates it `nologin`
  deliberately — credentials never live in a migration. Until a deployment sets
  it out of band the backend cannot connect, and the error reads as a wrong
  password rather than an unfinished deployment.
* **`TRUST_PROXY_HOPS`, paired with Cloudflare in Caddy's `trusted_proxies`.**
  One decision in two files: the hop count must equal the number of proxies
  that actually sit in front of the backend. Get one wrong and either every
  visitor shares a rate-limit bucket and a block identity, or the client
  address becomes something a sender can choose, while the site works
  perfectly.

## 5. What this deliberately does not do

**No CI-published images yet.** `DEPLOYMENT.md` D1 argues for CI building images
that the box pulls by tag, and the argument is provenance and rollback speed —
**not** compute, because a fixed monthly VPS costs the same idle or compiling.
Pre-launch there is nobody to disturb, and it is real work for a latent benefit.
Revisit from the first real user, or sooner if a deploy ever OOMs.

**No second machine.** Redis is a single point of failure (F-033); the code half
is done and drilled under load. What is missing is a host, which is a cost
decision rather than an engineering one.

**No observability beyond Prometheus and Grafana.** `npm run vps:up` scales
Loki, Tempo, Alloy, cAdvisor and both exporters to zero — and note that a
compose overlay can add a service but cannot remove one, so those `--scale N=0`
flags are the whole mechanism. A comment saying they are absent is not.
