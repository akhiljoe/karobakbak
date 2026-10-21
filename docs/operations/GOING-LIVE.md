# Going live — from a hardened box to a site serving traffic

The second half of the first day. `FIRST-BOOT.md` left you with a locked-down
Docker host running nothing; this puts the application on it, gets a
certificate, and proves the result rather than assuming it.

Every command says what it does, what you should see, and what it means when it
does something else.

**This is the procedure.** `VPS-PROVISIONING.md` holds the decisions behind it
(vendor, region, plan, and the measurements). `OPERATIONS.md` is the runbook for
when this is all running and something is wrong.

---

## Before you start

| You need | Check it with |
|---|---|
| `FIRST-BOOT.md` completed | `docker compose version` works without `sudo`, `free -h` shows swap |
| **Node.js 22 on the box** | `node --version` prints `v22.x`. `FIRST-BOOT.md` does not install it — see below |
| DNS proxied through Cloudflare | The apex resolves to a `2606:4700:…` address, not to the droplet's IP |
| Write access to the GitHub repository's settings | You will add a deploy key |
| An email address you actually read | Let's Encrypt sends expiry warnings there |

**Why DNS has to be right first.** Caddy asks Let's Encrypt for a certificate the
moment it starts, using the HTTP-01 challenge on port 80. If the name does not
yet resolve to this box, the challenge fails — and Let's Encrypt rate-limits
failures, so repeatedly retrying a broken setup locks you out of issuance for
hours. Get DNS correct, confirm it, then start the stack once.

Of the rows above, only the first two are about the droplet. The DNS check runs
wherever you like (`dig karobakbak.com AAAA +short`), and the GitHub access is a
browser tab.

### Node is not on the box yet — **[box]**

`FIRST-BOOT.md` leaves you with Docker and no Node, and every command below is
written as `npm run …`. The `prod:*` scripts are thin `docker compose` wrappers
and have a raw equivalent, but **step E does not**: `security:probe` and
`verify:logs` are Node programs with no compose form, so the box needs Node
either way.

Install it from NodeSource, using the same keyring pattern `FIRST-BOOT.md` used
for Docker:

```bash
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key   | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main"   | sudo tee /etc/apt/sources.list.d/nodesource.list
sudo apt-get update && sudo apt-get install -y nodejs
```

**Expect:** `node --version` prints `v22.x`.

**Do not `sudo apt install npm`.** Ubuntu 24.04's package pulls Node 18, which
is below this repository's `engines`, and it fights the above. `npm` ships
inside the `nodejs` package.

### Work inside `tmux` — **[box]**

```bash
sudo apt-get install -y tmux
tmux new -s deploy
```

The image build takes minutes on 2 vCPU, and an SSH session that drops during it
loses the build *and* every shell variable step B is holding. `tmux attach -t
deploy` puts you back in the same shell. This is the cheapest insurance in this
document.

---

## Where each command runs

Three different places, and confusing them is the commonest way this goes wrong.

| Marker | Means | How you get there |
|---|---|---|
| **[box]** | A shell on the droplet, over SSH | `ssh deploy@<DROPLET_IP>` — the address is recorded in `FIRST-BOOT.md`, in one place |
| **[laptop]** | A shell on your own machine | Any terminal. Nothing here needs the repository checked out locally |
| **[browser]** | A web UI — GitHub, Cloudflare, or the site itself | Your own machine |

**Almost all of it is [box].** Steps A through D, and E1, E2 and E4, are a shell
on the droplet — in `~/karobakbak` from the end of step A onwards. Four things
happen elsewhere: pasting the deploy key's public half into GitHub, the E3 curls,
opening the site, and the Grafana tunnel.

Each step below opens with where it runs. Where one command inside a step runs
somewhere else, the line above it says so.

### Stay in the same SSH session from step B to step D

Step B generates four secrets into shell variables and step D needs one of them.
Shell variables belong to one shell: a second terminal, or a reconnection after
a dropped link, has none of them set.

The failure is silent. `sed -i "s|^IP_HASH_SALT=.*|IP_HASH_SALT=${IP_SALT}|"` in
a shell where `IP_SALT` is unset writes `IP_HASH_SALT=` — an empty salt, no
error, and a stack that starts. So run all of step B in one session, and if that
session dies before step D, read the values back out of `.env.prod` rather than
generating new ones:

```bash
grep -E '^(IP_HASH_SALT|DATABASE_URL)=' .env.prod
```

The app role password is the one between `karobakbak_app:` and `@postgres` in
`DATABASE_URL`. If any line shows an empty value, that variable was lost — redo
step B from the top, in one session, before the stack has stored anything.

---

## Step A — Get the code onto the box

**Runs on: [box]**, except the one paste marked [browser].

If you deploy from a private repository (for example a private deployment
repository), the box needs credentials of its own. A **deploy key** is the
right shape: read-only, scoped to this one repository, and revocable without
touching your personal GitHub account. A public repository needs no key:
clone it over HTTPS (`git clone https://github.com/<owner>/<repo>.git`) instead.

```bash
ssh-keygen -t ed25519 -C "<vps-hostname>-deploy" -f ~/.ssh/github_deploy -N ""
```

**What it does.** Generates a second keypair on the droplet, unrelated to the one
you log in with.

**`-N ""` means no passphrase, and that is deliberate here.** A key you use
interactively should have one; a key a machine uses for an unattended `git pull`
cannot, because there is nobody to type it. The protection comes from the key
being read-only and confined to one repository instead.

```bash
cat ~/.ssh/github_deploy.pub
```

**[browser]** Copy the whole line out of your terminal. On GitHub: **repository
→ Settings → Deploy keys → Add deploy key**. Paste it, name it
`<vps-hostname>`, and leave **Allow write access unchecked**.

**What this writes to GitHub is the public half, and nothing else.** The private
key stays on the droplet and never leaves it. With write access unchecked, the
credential can only `git clone` and `git pull` this one repository — it cannot
push a commit, move a branch, open an issue, or read any other repository you
own. Nothing in this deployment ever writes to GitHub; images are built on the
box from the checkout.

**Why a key on the box at all, rather than copying the code up.** The droplet
has to fetch a private repository unattended, every time you deploy. The
alternatives are worse: a personal access token is a bearer secret in a file
with a much wider scope and an expiry that will surprise you, your own SSH key
forwarded to the box hands the box everything you can reach on GitHub, and
`scp`-ing a tarball loses the commit you deployed. A deploy key is the narrowest
of the four: one repository, read-only, revocable from that same settings page
without touching your account.

```bash
printf 'Host github.com\n  IdentityFile ~/.ssh/github_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
chmod 600 ~/.ssh/config
```

**What it does.** Tells SSH to use that key for GitHub specifically.
`IdentitiesOnly yes` stops it offering every other key first — without it, SSH
can exhaust GitHub's authentication attempt limit before reaching the right one,
and the error says "too many authentication failures" rather than anything
useful.

```bash
git clone git@github.com:<owner>/<repo>.git
cd karobakbak
```

**Expect:** a host authenticity prompt for `github.com` (type `yes`), then a
normal clone.

**If it fails with `Permission denied (publickey)`** — the deploy key was not
saved, or was added to the wrong repository. `ssh -T git@github.com` should say
`Hi <owner>/<repo>! You've successfully authenticated, but GitHub does not
provide shell access.`

---

## Step B — Generate the secrets and write `.env.prod`

**Runs on: [box]**, in `~/karobakbak`, and all of it in **one** SSH session —
see above for what happens when it is not.

`.env.prod` is the entire configuration of this deployment. The production
compose file **refuses to start** if any of thirteen variables is missing, by
name — a half-specified configuration is rejected rather than quietly defaulted,
which is the same principle `loadConfig` applies inside the application.

```bash
cp .env.prod.example .env.prod
```

Now generate the secrets. **On the box**, not on your laptop:

```bash
IP_SALT=$(openssl rand -hex 32)
PG_SUPER=$(openssl rand -hex 24)
PG_APP=$(openssl rand -hex 24)
GRAFANA_PW=$(openssl rand -hex 16)
```

**Why on the box.** Linux writes LF. A secret generated on Windows arrives with
a carriage return that is invisible in every tool you would use to look at it,
and F-049 is what that cost during the backup drill: the CR became part of the
encryption key, every test passed because backup and restore read the same file,
and recovery would have failed on the one day it mattered.

**Why hex rather than base64.** Two of these end up inside a
`postgres://user:password@host/db` URL, and base64 produces `/`, `+` and `=`,
which corrupt it. The failure arrives as an authentication error, not a parse
error, so it reads as a wrong password rather than a malformed URL. Hex is
URL-safe by construction.

**What each one is:**

| Variable | What it protects |
|---|---|
| `IP_HASH_SALT` | Every block and ban is keyed on a salted hash of the client address. **Generate once, never change it** — rotating the salt silently releases every block anyone has ever set |
| `POSTGRES_PASSWORD` | The `karobakbak` superuser. Used by migrations |
| The app role password | The `karobakbak_app` role the application connects as. Least privilege: it cannot create tables, read other databases, or delete from the audit log |
| `GRAFANA_ADMIN_PASSWORD` | Grafana, which is only reachable over an SSH tunnel |

```bash
sed -i "s|^IP_HASH_SALT=.*|IP_HASH_SALT=${IP_SALT}|" .env.prod
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_SUPER}|" .env.prod
sed -i "s|^GRAFANA_ADMIN_PASSWORD=.*|GRAFANA_ADMIN_PASSWORD=${GRAFANA_PW}|" .env.prod
sed -i "s|^DATABASE_URL=.*|DATABASE_URL=postgres://karobakbak_app:${PG_APP}@postgres:5432/karobakbak|" .env.prod
sed -i "s|^MIGRATION_DATABASE_URL=.*|MIGRATION_DATABASE_URL=postgres://karobakbak:${PG_SUPER}@postgres:5432/karobakbak|" .env.prod
```

**Expect:** no output. `sed -i` edits in place silently.

### `TRUST_PROXY_HOPS`: count your own proxies

This is the setting that breaks things quietly, so it is worth understanding
rather than copying. Set it in `.env.prod` to match your own topology.

The backend counts `X-Forwarded-For` entries **from the right**: the rightmost N
were written by infrastructure you control, and anything to the left is whatever
the client sent. Get it wrong in one direction and the backend trusts an entry
the client wrote, so per-address limits and blocks stop meaning anything; get it
wrong in the other and real visitors are keyed on a proxy's address and share
one identity.

The right value is the number of proxies you run in front of the backend, which
changes when you add or remove a layer such as Cloudflare. Work it out from your
own chain and confirm it with the probe in step E rather than copying a number
from here.

**Cloudflare in front only works because it is listed in `trusted_proxies` in
`ops/caddy/Caddyfile`.** Caddy discards an inbound `X-Forwarded-For` from an
untrusted peer rather than appending to it, so without that entry the client
address is destroyed at the first hop and every visitor in the world shares one
rate-limit bucket and one block identity — while the site appears to work
perfectly. The two settings are one decision in two files.

You will measure this in step E rather than trust it.

### The one value to set by hand

```bash
nano .env.prod
```

Set `ACME_EMAIL=` to an address you actually read. **Use a personal mailbox, not
`contact@karobakbak.com`** — that address routes through Cloudflare Email
Routing, and certificate-expiry warnings are precisely what you do not want
depending on infrastructure that might itself be the thing that broke.

While you are in there, confirm these are already correct:

```
KAROBAKBAK_DOMAIN=karobakbak.com
ALLOWED_ORIGINS=https://karobakbak.com
VITE_TERMS_URL=https://karobakbak.com/terms
VITE_PRIVACY_URL=https://karobakbak.com/privacy
APP_ENV_FILE=.env.prod
```

`ALLOWED_ORIGINS` matches scheme, host **and port** exactly. `www` is not listed
because Cloudflare redirects it to the apex, so there is one canonical origin. If
that redirect is ever removed, this needs the second value — a wrong origin
refuses the WebSocket upgrade with a 403, and the client retries it like any
dropped connection, so the UI sits on "connecting" and looks exactly like a
server that is down.

```bash
echo "app role password, needed in step D: ${PG_APP}"
```

Keep that visible. You need it in a few minutes.

---

## Step C — Build and start

**Runs on: [box]**, in `~/karobakbak`.

```bash
npm run prod:config | tail -20
```

**What it does.** Renders the merged compose configuration without starting
anything. Every `${VAR}` is substituted and every required variable is checked.

**Expect:** a large block of YAML. **If a required variable is missing it fails
here**, naming it — which is the cheapest possible place to find out.

```bash
npm run prod:up
```

**What happens, in order:**

1. Images build — backend, frontend, migrations. Several minutes on 2 vCPU the
   first time. The frontend build inlines `VITE_*` values at build time, which is
   why changing one later needs a rebuild rather than a restart.
2. Postgres and Redis start and become healthy.
3. The migration container runs every file in `migrations/` and exits.
4. Backend, frontend, Prometheus, Grafana, Caddy start.
5. Caddy requests a certificate from Let's Encrypt over HTTP-01.

**Expect:** a list of containers with `Started` or `Healthy`.

### C1 — Check that migrations actually ran

**Do this before anything else.** It is the one step the first real deployment
of this stack needed and did not have.

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml ps -a
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml logs migrate | tail -5
```

**Expect:** `migrate` shows `Exited (0)`, and the log ends with
`migrations complete` and `"applied":16`. Sixteen, not seventeen — the
directory holds sixteen files, because `011_payments.sql` is staged in
`migrations-pending/` until payments launch.

**`ps -a`, not `ps`.** The migration container runs once and exits, so a plain
`ps` does not list it at all.

**Why this check exists.** When `migrate` fails, *nothing else looks wrong*.
Postgres is healthy, Redis is healthy, the frontend is healthy, Caddy is serving
on 443, and the backend reports healthy too — its healthcheck is liveness only,
deliberately, because a database outage must not make Docker restart a process
that is working (§10.18). The only evidence is one `Exited (1)` line. The
failure then surfaces two steps later as

```
ERROR:  role "karobakbak_app" does not exist
```

because `002_roles.sql` creates that role and no migration ran. That reads as a
wrong command or a missing step, and it is neither.

Two real causes, both fixed, both worth recognising if they return:

* `ConfigError: IP_HASH_SALT is still the published default` — the service was
  not receiving `.env.prod` at all. Every service running this repository's code
  needs an `env_file:`; `npm run verify:config` fails the build if one loses it.
* `The server does not support SSL connections` — the overlay required TLS from
  a PostgreSQL container that ships without it.

```bash
npm run prod:logs
```

**Expect to see backend errors about the database at this point**, *provided
migrations succeeded*. That is normal and step D fixes it. If migrations did
**not** succeed, these same errors mean something else entirely — fix C1 first.

---

## Step D — Give the application role a password

**Runs on: [box]**, in `~/karobakbak`, in the same session as step B.

**This is not in any script, and skipping it looks like a broken build.**

`002_roles.sql` creates `karobakbak_app` as `nologin` with no password, and says
why in its own comment: credentials live in secret management, never in a
migration in git. So the role exists, has exactly the grants it needs, and
**cannot log in until a deployment gives it a password out of band**.

Until you run this, the backend cannot connect and will retry in a loop. The
error says authentication failed, which reads as a wrong password rather than an
unfinished deployment.

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T postgres psql -U karobakbak -d karobakbak \
  -c "alter role karobakbak_app with login password 'PASTE_PG_APP_HERE';"
```

Substitute the value printed at the end of step B. It must match `DATABASE_URL`
exactly.

**If that terminal is gone**, the value is still in the file rather than lost —
read it back rather than generating a new one, which would no longer match
`DATABASE_URL`:

```bash
grep '^DATABASE_URL=' .env.prod
```

The password is the part between `karobakbak_app:` and `@postgres`.

**Expect:** `ALTER ROLE`.

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml restart backend
npm run prod:logs
```

**Expect:** the backend reaching ready and the database errors stopping.

---

## Step E — Prove it, rather than looking at it

**Runs on: mixed** — each check says which, because two of these are worth
nothing run from the wrong place.

"I checked it in a browser" is worthless unless it names *which* build. That
mistake has cost this project three separate rounds: a backend six commits
behind, a dev server checked instead of a container, a container rebuilt before
the last commits landed. Every time the symptom was "the code is wrong" and every
time the code was right.

### E1 — The served artifact is the one you just built — **[box]**

```bash
docker exec karobakbak-live-backend-1 node -e \
  "console.log(require('/app/dist/protocol/types').INTENTS)"
```

**Expect:** the intents list including `flirty`. This asks the running process,
which is the only answer that counts.

### E2 — The proxy hop count, measured — **[box]**

`security-test` is a separate package with its own dependency tree, and nothing
has installed it yet. Without this the probe fails with `sh: 1: ts-node: not
found`, which reads as a broken script rather than a missing install:

```bash
npm run security:install
```

Then point it at the deployment. **The `--origin` is not optional here**, and
leaving it off is the sharpest trap in this document:

```bash
npm run security:probe -- --origin https://karobakbak.com
```

**`--origin` defaults to `http://localhost:8090`, which is the load-test
stack.** Production publishes nothing on that port — the frontend and backend
both carry `ports: !reset []` and Caddy owns 80 and 443 — so a bare
`npm run security:probe` connects to a closed port and reports:

```
2 passed, 8 failed
FAILED:
  EDGE-1 security headers reach every response, not just the root
  ...
  PROTO-4 an invented resume token opens a fresh session rather than resuming one
```

Every one of those is a connection refusal, not a finding. Worse are the two
that *passed*:

```
[PASS] IDENT-1  X-Forwarded-For decides the rate-limit bucket
        · one forged address x60: 0 opened, 60 refused
```

**`0 opened` is not evidence that forged headers were rejected.** Nothing
connected, so the assertion had nothing to be true of. That is the same failure
as the swarm run that reported `VERDICT: PASS` over 500 bots and zero
conversations (`CLAUDE.md`, "a swarm verdict is only as strong as the population
above it"). Read the population before the verdict, here as well.

Going through the public origin is also the *correct* measurement, not merely
the reachable one: it traverses Cloudflare, Caddy and nginx, which is the chain
`TRUST_PROXY_HOPS` describes.

**Expect, behind Cloudflare:** `IDENT-1` **PASS**, with a population attached:

```
[PASS] IDENT-1  X-Forwarded-For decides the rate-limit bucket
        the forged header did not buy a fresh bucket
        · one forged address x60: <N> opened, <60 - N> refused
        · distinct forged addresses x60: 0 opened, 60 refused
```

Read those two lines rather than the verdict. A non-zero `opened` count is the
part that matters (N is whatever `MAX_CONNECTIONS_PER_IP` you configured):
connections were made and then capped by `MAX_CONNECTIONS_PER_IP`,
which is the limiter doing its job on the *real* address. The second line then
shows sixty forged addresses buying nothing, because the first line had already
spent the one bucket they all share. A run where both lines say `0 opened`
proves nothing at all — see the trap above.

`IDENT-1` can also come back as `INFO` rather than `PASS`, and that is not a
failure. It reports rather than judges, because the correct value depends on
your topology: a bare deployment with nothing in front *should* distrust the
header, and the load stack *should* trust it, and the probe cannot know which it
is looking at. Behind Cloudflare, with `TRUST_PROXY_HOPS` matching your chain,
the forged header is overwritten before the backend sees it, so the stronger
`PASS` is available and is what you should get here.

Do not turn this into a pass/fail gate in CI. A probe whose correct answer
depends on the deployment is one that ends up being run with `|| true`.

### E2b — Sign-in reaches the provider — **[box]**

`AUTH_ENABLED` and `ACCOUNTS_ENABLED` are true, and no probe covers whether the
flow is actually wired: `EDGE-4` only checks that the callback does not reflect
its own query string, and it passes on a 404. One request settles it:

```bash
curl -s -o /dev/null -w "%{http_code} -> %{redirect_url}
" https://karobakbak.com/auth/start
```

**Expect:** `302 -> https://auth.karobakbak.com/oauth2/authorize?...`

**A `404` here means sign-in is not configured**, and it is the state the first
real deployment reached. `.env.prod.example` carried no auth block at all, so
`AUTH_ENABLED` kept its default of `false` and the four `/auth/*` routes were
never registered — while `ACCOUNTS_ENABLED` in `frontend/src/features.ts` is a
compiled-in `true`, so the bundle still rendered the button. `features.ts`
predicts this failure in its own comment: "the header offers a button into a
404".

The block is in `.env.prod.example` now, at the end. Fill it from
`docs/operations/SIGNIN-SETUP.md` §"the live values", then rebuild:

```bash
npm run prod:build
```

A half-filled block is refused at startup by name, so a missed value is a
container that will not start rather than a button that fails.

**Not `curl -I`.** That sends `HEAD`, and `/auth/start` is a `GET` route, so it
answers `405` — which looks like a failure and is in fact proof the backend's
own router replied. Worth knowing while reading the result rather than after.

A `404` means `/auth/` is not reaching the backend at all; a `500` means the
Cognito configuration is half-specified. Both surface in the UI as a sign-in
button that does nothing, which is why one curl is worth more here than a
click.

### E3 — The geo-block covers the socket, not only the page — **[box]**

**This cannot be run through the public origin, and trying is instructive.**
Cloudflare sets `CF-IPCountry` itself, from the real client address, and
overwrites whatever the caller sent. So a forged header from your laptop — or
from the droplet — arrives at nginx as your own country and the page is served
normally:

```
page: 200
ws:   404
```

That is not a broken geo-block. It is Cloudflare refusing to let anyone forge
the header, which is the property the block depends on. (The `404` is unrelated:
a plain `GET /ws` carries no `Upgrade`, so it is not a WebSocket handshake and
the backend does not route it.)

The earlier version of this section said the test proves nginx honours the
header but not that Cloudflare sends it. It is the other way round: run from
outside, it proves only that Cloudflare sends it.

To test nginx, bypass Cloudflare by asking the container directly:

```bash
docker exec karobakbak-live-frontend-1 wget -S -q -O /dev/null   --header="CF-IPCountry: DE" http://127.0.0.1/ 2>&1 | grep "HTTP/"

docker exec karobakbak-live-frontend-1 wget -S -q -O /dev/null   --header="CF-IPCountry: DE" http://127.0.0.1/ws 2>&1 | grep "HTTP/"
```

**Both must be 451.** Refusing the page while leaving the socket open restricts
nothing — anybody holding the bundle connects straight past it. `location /ws`
carries its own `if ($geo_blocked) { return 451; }` for exactly this reason, and
it must stay there: `error_page` does not intercept a `return` from an `if` in
the *server* block, so the check cannot be hoisted.

Then prove the test can fail, or it is not a test:

```bash
docker exec karobakbak-live-frontend-1 wget -S -q -O /dev/null   --header="CF-IPCountry: IN" http://127.0.0.1/ 2>&1 | grep "HTTP/"
```

**Expect 200.** A check that returns the same answer for every input has not
checked anything — the same reasoning as reading the population before the
verdict in E2.

### E4 — Nothing sensitive reached the logs — **[box]**

The logs are on the droplet; this reads what reached Loki there.

```bash
npm run verify:logs
```

**Expect:** per-service line counts and `PASS`. Use the site for a minute first —
it refuses a verdict below 20 lines, because finding nothing in nothing is not
evidence.

Add `--addresses` for the stricter audit, and expect it to report the visitor
addresses nginx keeps deliberately.

### E5 — The served bundle carries the build you think it does — **[box]**

The browser check below is worth nothing until this one passes, because a stale
frontend image serves last week's copy, reports healthy, and passes its own
health check.

**Pick a string only the new build contains** and grep the served bundle for
it. Put it in a shell variable first, for example a sentence of copy you have
just added to the Terms or Privacy page, so it is absent from any image built
before that:

```bash
NEW_STRING='a sentence of copy you just added'
docker exec karobakbak-live-frontend-1 grep -rlo "$NEW_STRING"   /usr/share/nginx/html/assets/
```

**Expect:** a filename, e.g. `/usr/share/nginx/html/assets/index-uUqObboV.js`.
Silence means the image was not rebuilt — go back and use `prod:build` rather
than `prod:up`.

**Use a fresh string for each deploy.** A sentence you have just
added is the right choice; a class name or a variable is not, because the
bundler renames them. And note that an empty result is the *failure* signal
here, so grepping for a string that was never in any build — including the
words "a string only the new build has", which an earlier version of this
document put in that position — returns nothing and reads exactly like a stale
bundle. Confirm the string exists in the source first:

```bash
grep -rl "$NEW_STRING" frontend/src/
```

### E6 — The site itself — **[browser]**

Open `https://karobakbak.com` in a browser on your own machine. Check the certificate is valid, the
age gate appears, and a conversation can start with a second tab.

---

## Step F — Backups

**Runs on: [box]**, except step F1 which is the Cloudflare dashboard.

**Why this is a step and not an afterthought.** A dump is the entire retained
corpus in one file, and that file travels — to object storage, and to a laptop
during a drill. So it is encrypted (`DESIGN.md` §8.1), and the passphrase that
encrypts it is the one secret here that nothing can regenerate for you.

`OPERATIONS.md` §7c is the runbook and holds the reasoning. This is the order to
do it in.

### F0 — Clear what Docker created

The `backup` service bind-mounts three files. Docker's answer to a bind mount
whose host path does not exist is to **create a directory there**, so a stack
that has been running without them has three directories where files belong —
and a container restarting on each one.

**Stop the container first, or it recreates them.** Docker creates the path at
container-create time, so a restarting service puts the directories back as fast
as you delete them:

```bash
cd ~/karobakbak
COMPOSE="docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE stop backup
$COMPOSE rm -f backup
ls -la ops/backup/
```

Anything shown with `d` in the first column is one of these. Remove it:

```bash
rm -rf ops/backup/passphrase ops/backup/report-token ops/backup/rclone.conf
```

**`rm -rf`, not `rmdir`, and never with `2>/dev/null`.** An earlier version of
this step used both, which is wrong twice: `rmdir` refuses a non-empty directory,
and the redirect then swallows the one message that would have said so. The step
appears to succeed, F2 and F4 fail with `Is a directory` further down, and the
container reports

```
FATAL: /run/secrets/backup-passphrase is missing, empty, or not a file
cat: read error: Is a directory
```

which reads as a missing secret rather than as a directory in its place. Do not
suppress errors in a step whose whole purpose is to remove something.

### F1 — The bucket and a scoped token — **[browser]**

Cloudflare dashboard → **R2** → **Create bucket** → `<backup-bucket>`.
Location hint can stay automatic.

Then **R2 → Manage API Tokens → Create API Token**, permission **Object Read &
Write**, scoped to **that one bucket**. Not account-level: a token with account
permissions can delete the bucket it exists to fill.

Copy the **Access Key ID**, the **Secret Access Key** and the **S3 endpoint**
(`https://<account id>.r2.cloudflarestorage.com`). The secret is shown once.

### F2 — `rclone.conf`

```bash
cat > ops/backup/rclone.conf <<'EOF'
[r2]
type = s3
provider = Cloudflare
access_key_id = PASTE_ACCESS_KEY_ID
secret_access_key = PASTE_SECRET
endpoint = https://PASTE_ACCOUNT_ID.r2.cloudflarestorage.com
region = auto
no_check_bucket = true
EOF
chmod 600 ops/backup/rclone.conf
```

`region = auto` is what R2 expects. It is not a placeholder to fill in.

### F3 — Prove the credentials before anything depends on them

```bash
CONF=$PWD/ops/backup/rclone.conf
R="docker run --rm -i -v $CONF:/config/rclone/rclone.conf:ro rclone/rclone"

echo probe | $R rcat r2:<backup-bucket>/probe.txt
$R ls     r2:<backup-bucket>
$R cat    r2:<backup-bucket>/probe.txt
$R delete r2:<backup-bucket>/probe.txt
```

**Expect:** no error on the write, `6 probe.txt` from the list, `probe` from the
read, silence on the delete. The first run also pulls the `rclone/rclone` image,
which is normal. All four, in that order — a token that can write
and not delete leaves the prune step failing weeks later.

**Do not reach for `rclone lsd r2:` as a first smoke test.** It lists *buckets*,
which is an account-level operation, and this token is scoped to one bucket on
purpose — so it answers 403 at exactly the moment somebody is least inclined to
doubt the test rather than the setup. Probe the bucket, never the account.

### F4 — The two secret files, generated here

```bash
printf %s "$(openssl rand -base64 32)" > ops/backup/passphrase
printf %s "$(openssl rand -hex 16)"    > ops/backup/report-token

# The container runs as `postgres`, not as you (ops/backup/Dockerfile).
# Give that group read, and nobody else anything.
BGID=$(docker run --rm --entrypoint id karobakbak-backup -g)
sudo chown "$USER":"$BGID" ops/backup/passphrase ops/backup/report-token ops/backup/rclone.conf
chmod 640 ops/backup/passphrase ops/backup/report-token ops/backup/rclone.conf
ls -la ops/backup/passphrase ops/backup/report-token
```

**`0640` and the container's group, not `0600` and not `0644`.** Both obvious
choices are wrong in opposite directions, and each fails in a way that reads as
something else:

* `0600` owned by you — the container cannot read it, and the log says
  `gpg: can't open '/run/secrets/backup-passphrase': Permission denied`
  followed by `dump or encryption failed`. That reads as a broken passphrase.
* `0644` — which is what `cp passphrase.example passphrase` gives you, so it
  works first time and leaves the key that decrypts every retained conversation
  readable by every account on the host.

**Expect `-rw-r----- 44` and `-rw-r----- 32`**, and those two numbers are the
check. Base64 of 32 bytes is exactly 44 characters and hex of 16 bytes is
exactly 32, so a trailing newline would read 45 and 33, and a CRLF 46 and 34.
The byte count settles it without opening the file — which is worth more than
`od -c` here, because the thing being ruled out is invisible when printed.

**`printf %s`, on this box, never on a laptop.** These three files are
gitignored, so `.gitattributes` does not normalise them and nothing else will.

A carriage return in the **report token** malforms the `Authorization` header:
the backend answers 400, `backup.sh` logs "could not reach", and it reads as a
network fault while backups keep succeeding unobserved.

A carriage return in the **passphrase** becomes part of the encryption key with
no symptom at all. Backup and restore read the same file, so every drill passes
— and recovery fails on the day somebody re-types the passphrase from a password
manager onto a clean host. That is F-049, demonstrated on 4 September 2026: an
archive written minutes earlier was provably undecryptable. `backup.sh` and
`restore.sh` **refuse** a CR rather than stripping one, because stripping would
change the key and silently orphan every archive already written with it. If
that refusal fires, fix the file — do not work around it.

### F5 — Put the passphrase somewhere that survives losing this host

```bash
cat ops/backup/passphrase; echo
```

Into a password manager, now, before the first run. An encrypted backup whose
key exists only on the machine it protects is not a backup. Everything else in
this document can be regenerated; this cannot.

### F6 — Wire `.env.prod`

```bash
sed -i "s|^BACKUP_REPORT_TOKEN=.*|BACKUP_REPORT_TOKEN=$(cat ops/backup/report-token)|" .env.prod
grep -c '^BACKUP_REMOTE=r2:<backup-bucket>' .env.prod
```

**Expect:** `1` from the grep.

`BACKUP_REPORT_TOKEN` must equal the contents of `ops/backup/report-token`
exactly, **and nothing checks that**. A mismatch shows up as `BackupsStale`
staying red while backups quietly succeed — an alert that is permanently on,
which is an alert nobody reads on the night it is right.

### F7 — Start it, and watch one whole run

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml   up -d --build backup backend
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml   logs -f backup
```

The backend restarts too, because it needs the same token to recognise a report.
Anyone connected sees a brief drop and reconnects (§28).

**Expect:** a dump, an encrypt, an upload to `r2:`, a prune, and a successful
report. A line saying the backup exists only on this host means `BACKUP_REMOTE`
is unset. A `FATAL: ... contains a carriage return` means F4 was done elsewhere.

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml   exec backup rclone ls r2:<backup-bucket>
```

**Expect:** one object, sized in megabytes.

### F8 — Restore it, because a backup nobody has restored is a hypothesis

**`restore.sh` does not create the target database.** Create it first, or the
run ends at `FATAL: cannot reach database restore_drill as karobakbak` — which
reads as a connection problem rather than a missing database:

```bash
COMPOSE="docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml"

$COMPOSE run --rm --entrypoint /usr/local/bin/restore.sh backup --list
$COMPOSE exec -T postgres psql -U karobakbak -d postgres -c "create database restore_drill;"
$COMPOSE run --rm --entrypoint /usr/local/bin/restore.sh backup --database restore_drill
```

**Expect** `pg_restore completed cleanly`, then a table of row counts and a line
saying the plaintext dump has been removed.

**Do not re-run it into the same database with `--force` and then read the error
count as a finding.** A second restore into a populated database produces one
error per object that already exists — `already exists`, `duplicate key value
violates unique constraint`, `multiple primary keys ... are not allowed`. On
this schema that is 83 errors, all of them saying the same thing, and the
sequence

```
restore: decrypted to a valid custom-format archive
restore: pg_restore reported 83 error(s)
```

reads as a corrupt backup when in fact the restore **already succeeded** on the
previous run. Drop and recreate the database between attempts.

**The R2 fetch is a separate thing to prove.** `restore.sh` uses the local copy
in `/backups` when there is one, and after any successful backup there is:

```
restore: using local /backups/karobakbak-....dump.gpg
```

That path does not test the object in R2, and on the day this matters the local
copy is gone with the host. To force the remote path:

```bash
docker exec karobakbak-live-backup-1 sh -c 'mkdir -p /backups/aside && mv /backups/*.dump.gpg /backups/aside/'
$COMPOSE run --rm --entrypoint /usr/local/bin/restore.sh backup --database restore_drill
docker exec karobakbak-live-backup-1 sh -c 'mv /backups/aside/*.dump.gpg /backups/ && rmdir /backups/aside'
```

**Expect** `fetching ... from r2:<backup-bucket>` in place of `using local`.

Clean up when the drill passes:

```bash
$COMPOSE exec -T postgres psql -U karobakbak -d postgres -c "drop database restore_drill;"
```

### F9 — The command you will actually want on the day

Everything above is the drill done by hand, which is how it should be done once
— you learn what each stage proves. `ops/restore-production.sh` is the same
sequence as one command, and it exists because the parts that go wrong are the
ones around the restore rather than the restore itself.

```bash
npm run restore:list          # what the remote holds
npm run restore:drill         # into restore_drill; live database untouched
npm run restore:production    # the live database. Destructive. Asks first.
```

**The drill is the default and takes no arguments**, because that is the one to
run on a schedule. `--production` drops the live database and replaces it, so it
requires typing the database name back.

What the wrapper does that a bare `restore.sh` cannot:

* **Stops `backup` first.** A scheduled run firing mid-restore dumps a
  half-loaded database and uploads it, and `BACKUP_KEEP` then prunes the good
  archive to make room. That converts a recoverable outage into an
  unrecoverable one while every log line reports success.
* **Stops `backend`** on a production restore. `pg_restore` into a database the
  application is writing to produces constraint violations that read as a
  corrupt archive.
* **Recreates the target database**, which `restore.sh` does not — and which
  otherwise fails as `cannot reach database`, reading as a connection fault.
* **Brings the stack back on any exit path.** A failed restore that also leaves
  the site down is two outages.

It deliberately does **not** set the `karobakbak_app` password. A restored
database has the role from `002_roles.sql` — present, granted, unable to log in
— exactly as a fresh one does, for the same reason. The script prints the two
commands rather than reaching for the value itself.

`restore.sh` fetches, decrypts, verifies the archive parses as a custom-format
dump, and loads it into a database beside the live one. This is the step that
proves the passphrase is the passphrase — which is the whole reason F-049 was
found rather than discovered during an outage.

**Do this now, not later.** The gap between taking a first backup and testing it
is the window in which the encryption key can be wrong and nothing says so.

---

## What is deliberately not done yet

* **Backups, if you skipped step F.** The container says so by crash-looping:
  `docker compose ps -a` shows `karobakbak-live-backup-1` as `Restarting (1)` until
  the three files exist. That is honest — a backup service that exited quietly
  would look configured — but it restarts forever and fills the log. Either do
  step F, or silence it rather than getting used to a red line:

  ```bash
  docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml \
    stop backup
  ```

  Note that a later `prod:build` starts it again — `restart: unless-stopped`
  survives a daemon restart but not a fresh `up`.

* **Nothing is watching the two inboxes.** `abuse@` and `contact@` carry
  statutory clocks and neither fails loudly when unread.
* **Images are built on the box.** `DEPLOYMENT.md` D1 argues for CI publishing
  them, on provenance and rollback speed rather than compute. Revisit from the
  first real user.

---

## Quick reference

**[box]**, from `~/karobakbak`:

```bash
cd ~/karobakbak
npm run prod:logs                     # follow the backend
npm run prod:up                       # start/restart with the images that exist
npm run prod:build                    # rebuild from the working tree, then start
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml ps -a
```

**`prod:up` does not rebuild anything, and this line used to claim it did.** It
is `docker compose up -d` with no `--build`, so after a `git pull` it restarts
the images already on the box and the new code never runs — while every
container reports healthy. Use `prod:build` after pulling. Same family as the
stale-bundle trap in `CLAUDE.md`: a command that succeeds and serves last
week.

**[laptop]** — Grafana binds to localhost on the droplet and is not published,
so it is reachable only through a tunnel. Run this on your own machine, leave it
open, and browse to `http://localhost:3000`:

```bash
ssh -L 3000:localhost:3000 deploy@<DROPLET_IP>
```

**`ERR_TOO_MANY_REDIRECTS` here is `GRAFANA_ROOT_URL`, not the tunnel and not
your cookies.** `.env.prod.example` shipped `https://karobakbak.com/grafana`
for the first deployment. Caddy has one route and it is the frontend, so
nothing serves that path — and a sub-path in `root_url` without
`GF_SERVER_SERVE_FROM_SUB_PATH=true` makes Grafana serve at `/` while building
its redirects under `/grafana`, which loops until the browser stops. It is
`http://localhost:3000`, because the tunnel is the origin the browser really
sees — the same rule `AUTH_REDIRECT_URI` follows. Chrome caches the loop, so
clear localhost cookies after fixing it or the fixed server still fails.

Deploying a change — **[box]**:

```bash
git pull && npm run prod:build
```

`prod:build`, never `prod:up` — see above.

A `VITE_*` change needs the frontend image rebuilt, which `prod:build` does
and `prod:up` does not — then verify by grepping the **served bundle**, never
the source, because the bundle that matters is the one inside the running
container:

```bash
docker exec karobakbak-live-frontend-1 grep -rlo "<a sentence you just added>" \
  /usr/share/nginx/html/assets/
```

Substitute a real sentence from your change. See E5: an empty result is this
check's *failure* signal, so grepping for a string no build ever contained is
indistinguishable from a stale bundle.
