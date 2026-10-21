# Standing up the moderation console

**What this gets you:** a working way to read a report, look at the conversation
it points to, resolve it, and ban or unban somebody — reachable only over an SSH
tunnel, connecting to PostgreSQL as a role that cannot delete evidence.

**Why it has its own document:** the console is the only way to action a report,
and `ReportsWaitingTooLong` **pages** when the oldest untriaged one passes
`REPORT_RESPONSE_TARGET_SECONDS` (24 hours by default). That alert is also a
published commitment — the Terms promise a 24-hour acknowledgement, and India's
IT Rules appear to require a grievance mechanism with stated timelines. So the
sequence to avoid is: the alert fires at 3am, about a real person waiting, and
the response turns out to be a procedure nobody has ever run on this box.

**Do this before launch, not when the first report arrives.**

### Five different secrets, and they are not interchangeable

This is the thing most likely to go wrong. Nothing below reuses a value from
anywhere else.

| Secret | Who or what uses it | Where it comes from | Used at |
|---|---|---|---|
| **`deploy` user password** | you, for `sudo` on the box | chosen during `FIRST-BOOT.md` | logging in, `sudo` |
| **SSH key passphrase** | you, to open the session | your own key | every `ssh` |
| **`CONSOLE_PW`** | the console **process**, to reach PostgreSQL | generated in Step B | Steps B and C only — **you never type it again** |
| **`ADMIN_PASSWORD`** | **you**, to log in to the console web page | **a new one you choose, in Step E** | every console login |
| **TOTP secret** | your authenticator app | printed once by Step E | every console login |

**`CONSOLE_PW` and `ADMIN_PASSWORD` are the pair that get confused.** One is
machine-to-machine and no human ever types it at a login screen; the other is
your own login. They should not be the same value.

Commands are marked **[box]** (over SSH, in `~/karobakbak`), **[laptop]**, or
**[phone]** — §16 covers reaching all of this from Termux, which matters because
the alerts page a phone.

**`<DROPLET_IP>` is a placeholder, and deliberately stays one.** The current
value is recorded in exactly one place — the box table at the top of
`FIRST-BOOT.md` — so there is one line to change when the address moves. The
SSH user is `deploy`; `root` login is disabled.

---

## Contents

1. [What you are actually deploying](#1-what-you-are-actually-deploying)
2. [Why not `npm run console`](#2-why-not-npm-run-console)
3. [Before you start — log in and check the ground](#3-before-you-start--log-in-and-check-the-ground)
4. [Step A — Build the image](#step-a--build-the-image)
5. [Step B — Give the console role a password](#step-b--give-the-console-role-a-password)
6. [Step C — Record the connection string](#step-c--record-the-connection-string)
7. [Step D — Start it](#step-d--start-it)
8. [Step E — Create the first account](#step-e--create-the-first-account)
9. [Step F — Reach it](#step-f--reach-it)
10. [Step G — Prove it, rather than looking at it](#step-g--prove-it-rather-than-looking-at-it)
11. [What the console can and cannot do](#11-what-the-console-can-and-cannot-do)
12. [The legal hold, which the console cannot place](#12-the-legal-hold-which-the-console-cannot-place)
13. [Routine operation](#13-routine-operation)
14. [Troubleshooting](#14-troubleshooting)
15. [Turning it off](#15-turning-it-off)
16. [Reaching all of this from a phone (Termux)](#16-reaching-all-of-this-from-a-phone-termux)

---

## 1. What you are actually deploying

An `admin` service in `docker-compose.yml`, behind the compose profile `admin`,
so nothing starts it by accident. Three things about it are deliberate.

**It reuses the backend image.** `tsconfig.build.json` compiles all of `src`, so
`dist/admin/main.js` is already inside the image the backend runs from — and the
Dockerfile copies the console's three static files in explicitly, with a comment
saying why: *"this is the one origin in the system that can read every retained
conversation, so it carries no toolchain and no third-party script."* The runtime
stage ran `npm ci --omit=dev`, so nothing that could compile more ships with it.
Nothing new is built here and nothing is installed on the host.

**It connects as `karobakbak_console`, never as the app role.** That role can
read a transcript and **cannot delete a conversation**; the app role is denied
`admin_accounts` outright. Both facts are asserted against real PostgreSQL in
`tests/integration/storage.test.ts`. This is the entire reason the console is a
separate process (D32) — running it as the app role would collapse the
separation *while appearing to work perfectly*, which is the failure mode worth
fearing.

**It is published on the host's loopback only** — `127.0.0.1:8088`. It is never
proxied by nginx, never given a Caddy site, and never has a public hostname. The
access control is an SSH tunnel.

---

## 2. Why not `npm run console`

`OPERATIONS.md` used to say to run it on the host with `npm run console`. That
would not have worked on this box, and fixing it the obvious way would have been
worse than the problem.

**It would not have started.** `npm run console` runs through **`tsx`, a
devDependency**, and nothing installs `backend/node_modules` on the box — the
application arrives as an image with its dependencies inside it. `GOING-LIVE.md`
installs Node only so `security:probe` and `verify:logs` can run. And unlike the
`dev` script, `console` passes **no `--env-file`**, so it would have started with
an empty environment, found `ADMIN_CONSOLE_ENABLED` defaulting to false, and
refused.

**The obvious fix — `npm install` in `backend/` — is a security regression**, for
three reasons:

1. `npm install` **executes install scripts from every package in the tree**, as
   the invoking user, on the machine holding the database, `IP_HASH_SALT` and
   the spool of plaintext message bodies. That is code execution outside the
   container boundary the rest of the deployment relies on.
2. It installs **devDependencies**, which falsifies a security argument this
   project already made: the CI audit gate is `--omit=dev` at `high`, reasoned as
   *"a vulnerability in a test runner does not ship and cannot be reached by a
   request."* That holds only while the test runner stays off production.
3. `install` is not `ci`. It can resolve versions the lockfile does not pin, so
   what runs on the box is not what CI audited.

`npm run console` remains correct **on a laptop**, against a local stack. It is
not the production path.

---

## 3. Before you start — log in and check the ground

**One command at a time.** Chaining them with `&&` tells you that something
failed without telling you which part, and every check below fails for a
different reason with a different fix.

### 3.1 Log in — **[laptop]**

```bash
ssh deploy@<DROPLET_IP>
```

**Expect:** your key passphrase, then `deploy@<vps-hostname>:~$`. The hostname
in the prompt is your confirmation you are on the right box.

**If it says `Permission denied (publickey)`** — the `deploy` user does not
exist yet, or your key is not on it. That is `FIRST-BOOT.md`, not this document.

**Everything from here to §15 runs in that session.**

### 3.2 Find the code — **[box]**

```bash
cd ~/karobakbak
pwd
```

**Expect:** `/home/deploy/karobakbak`.

**If the directory does not exist**, the code was never deployed. Stop here and
do `GOING-LIVE.md` first — the console connects to the same PostgreSQL and Redis
the stack runs, and cannot start without them.

### 3.3 Is the stack running? — **[box]**

```bash
docker ps --format "{{.Names}}	{{.Status}}"
```

**Expect:** at least `postgres` and `redis`, both `Up` and `(healthy)`, plus
`backend`, `frontend` and `caddy`.

**If nothing is listed**, the stack is down. Bring it up with `npm run prod:up`
before continuing; the console has nothing to connect to.

**`postgres` is the one that must be healthy.** Step B runs `psql` through that
container, and the service will not start without it.

### 3.4 Is the environment file there? — **[box]**

```bash
ls -l .env.prod
```

**Expect:** one file, non-zero size. The `admin` service reads it through
`env_file:`, exactly as `backend` does.

**If it is missing**, that is `GOING-LIVE.md` Step B — and do not hand-write it,
because it holds generated secrets that must match what is already in the
database.

### 3.5 Has the console been set up before? — **[box]**

```bash
grep -c '^CONSOLE_DATABASE_URL=' .env.prod
```

**Expect:** `0` on a first run — then continue to Step A.

**If it prints `1`**, somebody already did Step C. **Do not regenerate the
password**: a new one would no longer match the role, and the console would fail
authentication in a way that reads as a broken deployment. Read the existing
value instead and skip to Step D:

```bash
grep '^CONSOLE_DATABASE_URL=' .env.prod
```

### 3.6 Does the database role exist? — **[box]**

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml exec -T postgres psql -U karobakbak -d karobakbak -c "select rolname, rolcanlogin from pg_roles where rolname like 'karobakbak%';"
```

**Expect:** **three** rows. The pattern matches the database owner as well as
the two application roles:

```
      rolname       | rolcanlogin
--------------------+-------------
 karobakbak         | t
 karobakbak_console | f
 karobakbak_app     | t
```

| Role | `rolcanlogin` | What it means |
|---|---|---|
| `karobakbak` | `t` | The database owner — the role these `psql` commands connect as (`-U karobakbak`). Not used by any application process |
| `karobakbak_app` | `t` | The chat backend. `t` means `GOING-LIVE.md` step D was done |
| `karobakbak_console` | **`f`** | **Correct before Step B.** The role ships `nologin` with no password on purpose; it becomes `t` when you grant it one |

**A `f` on `karobakbak_console` is the expected state here, not a fault.** It is
the single most likely thing on this page to be misread as something broken.

**If `karobakbak_console` is missing entirely**, migrations have not run as far
as `005_admin_accounts.sql`. That is `GOING-LIVE.md` Step C1.

**If `karobakbak_app` shows `f`**, the backend cannot connect either, and the
stack is not actually working — that is `GOING-LIVE.md` step D, and it should be
fixed before anything here.

### 3.7 Have these ready

| Needed | Why |
|---|---|
| An authenticator app on your phone | Step E prints a TOTP secret **once**, with no recovery path |
| A few minutes uninterrupted | Steps B and C share a shell variable; losing the terminal between them means reading the value back rather than regenerating it |

### 3.8 The long command, once

Every command from Step A onwards needs the profile, so the `prod:*` npm scripts
cannot be used — they do not take one. Set this alias in the session:

```bash
alias dcp='docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml --profile admin'
```

**Expect:** no output. Check it resolves:

```bash
dcp config --services | grep admin
```

**Expect:** `admin`.

**If it prints nothing**, one of two things is true, and they need different
fixes:

**The profile is not being passed.** Re-read the alias. The `admin` service
exists only with `--profile admin`, which is what stops it starting by accident.

**Or the box's `docker-compose.yml` predates the service.** This is the likely
one on a box deployed before the console was added, and it is what happened the
first time this document was followed. Check:

```bash
grep -c '^  admin:' docker-compose.yml
```

**Expect:** `1`. If it prints `0`, the file on the box is older than the change.

### 3.9 Getting the service onto the box — **[box]**

Only needed when §3.8 found no `admin:` service.

**Pull, rather than editing the file here.** A compose file edited on the box
and nowhere else is drift that survives until the next `git pull` overwrites it
without warning — and the thing it would silently remove is a service holding
database credentials.

```bash
git status --short
```

**Expect:** empty. **If it lists modified files**, somebody edited this checkout
by hand; resolve that before pulling, or the pull will refuse or clobber.

```bash
git pull --ff-only
```

**Expect:** a fast-forward listing `docker-compose.yml` among the changed files.
`--ff-only` refuses to create a merge commit on the box, which is the right
posture for a deployment checkout: it is a copy of `main`, not a place work
happens.

Then re-run the §3.8 check:

```bash
dcp config --services | grep admin
```

**Expect:** `admin`.

**Nothing restarts from a `git pull`.** The running containers keep their old
compose definition until something recreates them, which is Step A and Step D.
The chat is not interrupted by this.

---

## Step A — Build the image

**Runs on: [box]**

```bash
dcp build admin
```

**Expect:** mostly cache hits. The `admin` service builds from `./backend`, the
same context as `backend`, so if the backend image is current this is layer
reuse and takes seconds.

**What it does not do:** create a second image or a second dependency tree.
`admin` and `backend` are the same build, started with different commands.

---

## Step B — Give the console role a password

**Runs on: [box]. Once, ever.**

`005_admin_accounts.sql` creates `karobakbak_console` as `nologin` with no
password, for the same reason `karobakbak_app` is (`GOING-LIVE.md` step D):
credentials live in secret management, never in a migration in git. So the role
exists with exactly the grants it needs and **cannot log in until a deployment
gives it one out of band**.

```bash
CONSOLE_PW=$(openssl rand -base64 24 | tr -d '\n')
echo "$CONSOLE_PW"          # copy this; step C needs it

dcp exec -T postgres psql -U karobakbak -d karobakbak \
  -c "alter role karobakbak_console with login password '$CONSOLE_PW';"
```

**Expect:** `ALTER ROLE`.

**Use a different password from the app role's.** They are different trust
levels; sharing one means a leak of either is a leak of both.

**This value is for the process, not for you.** `CONSOLE_PW` is how the console
container authenticates to PostgreSQL. You will paste it into `.env.prod` in
Step C and never type it again — it is not your console login, which you choose
separately in Step E.

**The `tr -d '\n'` is not decoration.** A trailing newline or carriage return in
a secret is invisible and breaks things silently — that is F-049, where a `\r` in
a backup passphrase made every archive undecryptable while every local drill
passed, because backup and restore read the same broken file.

---

## Step C — Record the connection string

**Runs on: [box]**

```bash
printf 'CONSOLE_DATABASE_URL=postgres://karobakbak_console:%s@postgres:5432/karobakbak\n' "$CONSOLE_PW" >> .env.prod
```

**Expect:** no output. Confirm it landed as one line with no stray characters:

```bash
grep -c '^CONSOLE_DATABASE_URL=' .env.prod     # → 1
grep -P '\r' .env.prod | wc -l                 # → 0
```

**Use `printf`, not an editor**, for the reason in step B.

**If you lose the terminal**, read the value back rather than generating a new
one — a new password would no longer match the role:

```bash
grep '^CONSOLE_DATABASE_URL=' .env.prod
```

The password is the part between `karobakbak_console:` and `@postgres`.

---

## Step D — Start it

**Runs on: [box]**

```bash
dcp up -d admin
dcp logs -f admin
```

**Expect:** a startup line and then quiet. The console logs almost nothing at
rest.

**If you see `ADMIN_CONSOLE_ENABLED is false; refusing to start the console`** —
the environment did not reach the container. That message is deliberate: the
process refuses rather than idling, because *"a process that starts, opens
nothing and logs nothing looks healthy to an orchestrator, and the operator finds
out the console is missing when they try to use it."*

**If you see authentication failures against PostgreSQL**, step B and step C
disagree. Re-read the value rather than regenerating it.

---

## Step E — Create the first account

**Runs on: [box]. Once.**

There is no default account and no signup.

**It takes arguments, not prompts.** The username is an argument and the
password comes from `ADMIN_PASSWORD` in the environment — running it bare prints
its usage and exits:

```
usage: create-account <username> [role]   (password in ADMIN_PASSWORD)
```

### E1 — Choose a role

| Role | Use |
|---|---|
| `moderator` | The default if you pass none. Day-to-day report triage |
| `senior_moderator` | |
| `security_admin` | |

Anything else is refused. For a single operator, `security_admin` is the honest
choice for the first account.

### E2 — Create it

**This is a NEW password that you choose now.** It is the one you will type into
the console's login page. It is **not** `CONSOLE_PW` from Step B, which is the
database role's password and is never typed by a human — and it is not the
`deploy` user's password either.

```bash
read -rs ADMIN_PASSWORD
```

Type the password you want for your console login and press enter. Nothing
echoes. `read -rs` keeps it **out of
your shell history**, which `ADMIN_PASSWORD='...' node ...` on one line would
not — that line would sit in `~/.bash_history` in plain text.

**Minimum 12 characters**, enforced by the script — it refuses rather than truncating.

```bash
export ADMIN_PASSWORD
```

```bash
dcp run --rm -e ADMIN_PASSWORD admin node dist/admin/create-account.js <username> security_admin
```

**`-e ADMIN_PASSWORD` with no value** passes the variable through from your
shell rather than writing it into the command line, so it does not appear in
`docker ps`, in the compose file, or in your history.

**Expect:**

```
Created security_admin account: <username>

  secret: BASE32SECRETHERE
  uri:    otpauth://totp/...
```

### E3 — Enrol it immediately, then clear the variable

**The TOTP secret is shown exactly once.** The server stores it so it can verify
codes, but there is **no way to display it again**, and the source says why: *"a
console that could re-display an enrolled secret is a console where reading one
row of the database is enough to log in as somebody else."*

**The `uri` is printed as text, not as a QR code** — the console has no way to
render an image, so there is nothing on screen to point a camera at. Two ways to
enrol it, and the first needs no tools:

**Type the `secret` in by hand.** Every authenticator supports this: *Add
account → Enter a setup key* (Google Authenticator), *Enter key manually*
(Authy), *Add → Enter secret* (Aegis), or a one-time-password field in a
password manager. Account name is whatever you like, key is the `secret` string,
type is **time-based**. This is the ordinary path and takes about twenty
seconds.

**Or draw a QR in the terminal**, if you would rather scan:

```bash
sudo apt-get install -y qrencode
```

```bash
qrencode -t ANSIUTF8 "PASTE_THE_otpauth_URI_HERE"
```

`-t ANSIUTF8` renders into the terminal, so **no image file is written** and
nothing has to be cleaned up afterwards.

> **Never paste the `otpauth://` URI into an online QR generator.** The URI
> contains the secret, so a website that renders it now holds your second
> factor. This is the one step of the whole document where the convenient
> option is the dangerous one.

Enrol it before you run anything else.

**The account name you type into the authenticator is cosmetic.** It lives only
on your phone and is never sent anywhere; codes are computed from the secret and
the clock, and nothing else. Getting it wrong is a rename in the app, not a
problem with the account — every authenticator can edit an entry's label.

**Do not delete an entry in order to re-add it unless you still have the
`secret` string in front of you.** Once the terminal is cleared it is gone, and
deleting the entry locks you out.

**A lost secret means deleting the account row and creating another.** There is
no password reset either — the console has no email to send one to:

```bash
dcp exec -T postgres psql -U karobakbak -d karobakbak -c "delete from admin_accounts where username = 'NAME';"
```

Then run E2 again. Removing the row is safe: `admin_accounts` holds console
operators and nothing else, and no report, ban or audit row references it by
foreign key — the audit trail records the actor as text precisely so that
deleting an operator cannot erase what they did.

```bash
unset ADMIN_PASSWORD
```

**Then clear the scrollback**, because the secret is still on your screen and in
the terminal's buffer:

```bash
clear
```

### E4 — Confirm the row exists

```bash
dcp exec -T postgres psql -U karobakbak -d karobakbak -c "select username, role, created_at from admin_accounts;"
```

**Expect:** one row, with the role you chose.

**If this errors with `permission denied`**, you ran it as the wrong role —
these `psql` checks use `-U karobakbak`, the database owner, not the console
role.

---

## Step F — Reach it

**Runs on: [laptop]**

```bash
ssh -N -L 8088:127.0.0.1:8088 deploy@<DROPLET_IP>
```

Leave that running, then open **http://127.0.0.1:8088** in a browser.

**Expect:** a login form with three fields.

| Field | What to enter |
|---|---|
| **Username** | The one you passed to `create-account` in Step E |
| **Password** | **`ADMIN_PASSWORD`** — the value you chose in E2 |
| **Six-digit code** | The rotating number in your authenticator, right now |

Not `CONSOLE_PW`, not the `deploy` user's password, not your SSH passphrase —
see the secrets table at the top.

**The code rotates every 30 seconds.** If it is about to roll over, wait for the
next one rather than submitting the tail end of an expiring one. Repeated
failures lock the account for `ADMIN_LOCKOUT_SECONDS` (15 minutes) after
`ADMIN_MAX_FAILED_ATTEMPTS` (5).

`-N` means "no remote command" — it opens the tunnel and nothing else. Close it
with Ctrl-C when you are done; the console is not something to leave tunnelled
all day.

---

## Step G — Prove it, rather than looking at it

Five checks. The third is the one that matters most.

### G1 — It is connected as the console role — **[box]**

```bash
dcp exec -T postgres psql -U karobakbak -d karobakbak \
  -c "select usename, application_name, state from pg_stat_activity where usename = 'karobakbak_console';"
```

**Expect:** one row per pooled connection - three is normal, and is
`DATABASE_POOL_MAX` rather than anything to investigate. `idle` is the healthy
state for a console nobody is clicking in.

```
      usename       | application_name | state
--------------------+------------------+-------
 karobakbak_console | karobakbak       | idle
 karobakbak_console | karobakbak       | idle
 karobakbak_console | karobakbak       | idle
```

**If it returns no rows**, the container is not running or never connected -
check `dcp logs admin`.

**If it says `karobakbak_app`**, `CONSOLE_DATABASE_URL` is wrong and the process
separation is not real, however well the console appears to work.

### G2 — The role genuinely cannot delete evidence — **[box]**

Read the password out of `.env.prod` rather than relying on `$CONSOLE_PW`
still being set - by this point the shell that generated it may be long gone:

```bash
CONSOLE_URL=$(grep '^CONSOLE_DATABASE_URL=' .env.prod | cut -d= -f2-)
```

```bash
dcp exec -T postgres psql "$CONSOLE_URL" -c "delete from conversations where false;"
```

**Expect:** `ERROR: permission denied for table conversations`.

`where false` matches nothing, so this proves the grant without touching a row.
A success here means the console could destroy the evidence in the case it was
opened for.

### G3 — It is not reachable from the internet — **[box] then [laptop]**

```bash
# [box] — the listener must be on loopback, never 0.0.0.0
ss -ltnp | grep 8088
```

**Expect exactly this shape** — the address before the colon is the whole check:

```
LISTEN 0      4096       127.0.0.1:8088       0.0.0.0:*
```

`127.0.0.1:8088` means the port is bound to the loopback interface and is
unreachable from any other machine. **`0.0.0.0:8088` would mean it is listening
on every interface**, and the console would be on the public internet — stop and
fix `ports:` before going further. The `0.0.0.0:*` at the end is the *peer*
address, meaning "from anywhere", and is normal.

```bash

# [box] — locally it answers
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8088/

# [laptop] — from outside it must NOT, by either route
curl -sS -m 5 http://karobakbak.com:8088/
curl -sS -m 5 http://<DROPLET_IP>:8088/
```

**Expect:** a listener on `127.0.0.1:8088`; a 200 or 302 on the box; and a
timeout or connection-refused from your laptop.

**A response from the laptop is a stop-everything result.** It would mean an
origin that can read every retained conversation is on the public internet.

### G4 — The audit trail is being written — **[box]**

**This check is conditional, and on a fresh deployment it is expected to be
empty.** The audit row is written when somebody *reads* retained content. If
nobody has logged in and opened a conversation, there is nothing to log — and on
a new box there are usually no reports to open in the first place.

```
 actor | action | subject_type | created_at
-------+--------+--------------+------------
(0 rows)
```

**That is a pass at this stage**, not a failure. Come back to it the first time
you actually work a report.

To exercise it now rather than waiting, log in at Step F and open any
conversation the console will show you, then:

```bash
dcp exec -T postgres psql -U karobakbak -d karobakbak \
  -c "select actor, action, subject_type, created_at from admin_audit order by created_at desc limit 5;"
```

**Expect:** a row naming you as the actor.

The audit row is written **before** the transcript is selected, in the same
transaction (D33). The guarantee is *"a read that was not logged did not
happen"*, and there is a test that breaks the audit insert and asserts no
transcript comes back.

**The alarm is narrow and worth stating exactly:** empty is fine while nothing
has been read; empty *after you have read a transcript on screen* means the
guarantee is not holding, and you should stop using the console and investigate
before reading anything else.

### G5 — The report queue metric is live — **[box]**

```bash
curl -s 'localhost:9090/api/v1/query?query=chat_reports_open' | jq -r '.data.result[].value[1]'
curl -s 'localhost:9090/api/v1/query?query=chat_report_queue_oldest_seconds' | jq -r '.data.result[].value[1]'
```

**Expect:** numbers, `0` being a fine answer. This is what `ReportsWaitingTooLong`
compares against `chat_report_response_target_seconds`.

---

## 11. What the console can and cannot do

Decided by the PostgreSQL grants in `005_admin_accounts.sql`, not by the
interface — so it holds even if somebody reaches the API directly.

| Action | Allowed | Grant |
|---|---|---|
| Read a report and its transcript | **yes** | `select` on `conversations`, `messages` |
| Resolve a report | **yes** | `select, update` on `reports` |
| Issue a ban, both identity dimensions | **yes** | `select, insert, update` on `enforcement` |
| Revoke a ban | **yes** | `update` — never `delete` |
| Read moderation events and blocks | **yes** | `select` |
| Manage console accounts and sessions | **yes** | full lifecycle |
| **Delete a conversation** | **no** | read-only on retained content |
| **Edit an audit row it wrote** | **no** | `select, insert` only |
| **Place a legal hold** | **no** | `select` only — see §12 |
| Warn, throttle, or quarantine a user | **no** | Reserved in the schema, nothing delivers them |

Two of those refusals are worth understanding rather than working around.

**A revoked ban is updated, not deleted**, so a lifted ban leaves `revoked_at`
and `revoked_by` behind instead of vanishing.

**The audit log is append-only by grant rather than by convention** (I11). The
console is the main writer of that table and must not be able to edit what it
wrote.

So the working vocabulary is **resolve, ban, or revoke**. Ban length is the only
dial, and `suspend` is the same mechanism with an end date.

---

## 12. The legal hold, which the console cannot place

**This is the sharpest gap in the moderation surface, and it is worth reading
before you need it.**

The escalation procedure in `OPERATIONS.md` §7e says that for content involving
a minor you **preserve first** — place a legal hold before anything expires —
and then follow the reporting obligations. That is the most time-critical action
in the whole system, and it is the one action the console cannot perform: the
role has `select` on `legal_holds` and no route offers it.

The clock is real. A conversation past `retention_expires_at` is deleted by a
worker that does not know a case is open.

**A hold is two writes, and both are required.** There is no trigger linking
them: the boolean is the fast predicate the deletion query reads, and the row is
the record of who placed the hold and why.

```bash
# [box] — as the superuser. Substitute the conversation id and your details.
CONV='00000000-0000-0000-0000-000000000000'
CASE='case-2026-001'
WHO='<username>'
WHY='preserved pending report to SJPU'

dcp exec -T postgres psql -U karobakbak -d karobakbak -v ON_ERROR_STOP=1 <<SQL
begin;
insert into legal_holds (hold_id, subject_type, subject_id, case_id, owner, justification, created_at)
values (gen_random_uuid(), 'conversation', '$CONV', '$CASE', '$WHO', '$WHY', now());

update conversations set legal_hold = true where conversation_id = '$CONV';
commit;
SQL
```

**Expect:** `INSERT 0 1`, then `UPDATE 1`, then `COMMIT`.

**Messages are covered by the parent.** The deletion worker's message query
excludes any message whose conversation is held, so holding the conversation
holds the transcript with it. That guard runs in both directions — a child under
hold also prevents the parent being emptied, because *"an empty shell with a
timestamp is not a suspended conversation."*

**Verify it took:**

```bash
dcp exec -T postgres psql -U karobakbak -d karobakbak \
  -c "select subject_id, case_id, owner, created_at, released_at from legal_holds order by created_at desc limit 5;"
dcp exec -T postgres psql -U karobakbak -d karobakbak \
  -c "select count(*) held from conversations where legal_hold;"
```

**Releasing a hold sets `released_at` and `released_by` rather than deleting the
row**, then clears the boolean. The record that data *was* held, by whom and
why, outlives the hold itself.

**Worth fixing properly at some point:** granting `insert, update` on
`legal_holds` to `karobakbak_console` and adding a button is a small change, and
it would move the most urgent action in the system out of a hand-typed
transaction. Until then, keep this section open in a tab when you escalate.

---

## 13. Routine operation

**`REPORT_RESPONSE_TARGET_SECONDS`** (default 24 hours) is the promise, exported
as a metric so `ReportsWaitingTooLong` compares against it rather than repeating
the number. It **pages** rather than raising a ticket, deliberately: a report is
a person saying something went wrong, and with one moderator there is no rota to
notice the queue grew overnight.

Set the target to something you will actually meet. A target you miss every day
is the same as no target, except that it also trains you to ignore the alert.

**The console does not need to run continuously.** `restart: unless-stopped`
keeps it up across reboots, which is what you want when an alert can arrive at
any hour — but nothing breaks if it is stopped. Chat is entirely unaffected; that
is why it is a separate process.

---

## 14. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ADMIN_CONSOLE_ENABLED is false; refusing to start` | The env file did not reach the container | Check `--env-file .env.prod` is in the command, and that `env_file:` is still on the service |
| `password authentication failed for user "karobakbak_console"` | Step B and step C disagree | Read `CONSOLE_DATABASE_URL` back; re-run step B with **that** password |
| `role "karobakbak_console" is not permitted to log in` | Step B never ran | Run it |
| Container is up, tunnel connects, browser shows nothing | Bound to the container's own loopback | `ADMIN_CONSOLE_HOST` must be `0.0.0.0` **inside** the container; the loopback that matters is in `ports` |
| Login accepts the password then rejects the code | Clock drift on the box or the phone | `timedatectl` on the box; TOTP tolerates very little skew |
| `permission denied for table admin_accounts` | Connected as the app role | `CONSOLE_DATABASE_URL` is pointing at the wrong role — G1 |
| Reports visible, `admin_audit` empty | Serious — the D33 guarantee is not holding | Stop using it and investigate before reading anything else |

---

## 15. Turning it off

```bash
dcp stop admin           # keeps the container
dcp rm -sf admin         # removes it
```

Neither touches chat, the database, or any report. Accounts and sessions live in
PostgreSQL and survive.

**A deployment that is not moderating anything should not run this**, which is
why it sits behind a profile: no console, no open port, and no operator
credentials in memory anywhere.

---

## 16. Reaching all of this from a phone (Termux)

**Why this is in this document.** `ReportsWaitingTooLong` pages. So does
`BackendDown`, `SafetyRecordsDropped` and eleven others. A page at 3am reaches a
phone, and an on-call of one either responds from that phone or does not respond
until morning. So the phone path is part of the operational design, not a
convenience.

Two surfaces, both bound to the box's loopback, both reached the same way:

| Surface | Port on the box | What it answers |
|---|---|---|
| **Grafana** | `127.0.0.1:3000` | Is this real, and how bad |
| **Moderation console** | `127.0.0.1:8088` | Act on it |

Neither is on the internet and neither should be. Caddy has exactly one route —
`reverse_proxy frontend:80` — and nothing serves `/grafana`. **The tunnel is the
access control.**

### 16.1 Install an SSH client — **[phone]**

```bash
pkg update
pkg upgrade
pkg install openssh
```

**Expect:** `ssh -V` prints an OpenSSH version.

### 16.2 Make a key for the phone — **[phone]**

Give the phone **its own key**, not a copy of your laptop's. A phone is lost and
stolen far more often than a laptop, and a separate key is one you can revoke
without locking yourself out from everywhere else.

```bash
ssh-keygen -t ed25519 -C "termux-phone" -f ~/.ssh/id_ed25519
cat ~/.ssh/id_ed25519.pub
```

**Use a passphrase.** Termux stores the key in the app's private data — safe
while the phone is locked and unencrypted at rest against anybody with the
unlocked device.

**Expect:** one line beginning `ssh-ed25519 AAAA…` ending in `termux-phone`.

### 16.3 Authorise it on the box — **[box]**

Copy that line across — long-press in Termux to select and copy, then paste
wherever you already have a session on the box:

```bash
mkdir -p ~/.ssh
chmod 700 ~/.ssh
echo 'ssh-ed25519 AAAA…termux-phone' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

**Expect:** no output.

Confirm from the phone before relying on it:

```bash
ssh -i ~/.ssh/id_ed25519 deploy@<DROPLET_IP> 'echo ok'
```

**Expect:** a prompt for your key passphrase, then `ok`.

**Do not use `-o BatchMode=yes` here.** It is the obvious way to make a test
fail rather than hang, and it is wrong for this case: the key has a passphrase
and there is no agent loaded, so ssh cannot decrypt it, offers **no key at all**,
and closes the connection. The box logs that as

```
Connection closed by authenticating user deploy <IP> [preauth]
```

with **no `Failed publickey` line before it** — which reads as the box refusing
the key when in fact the client never sent one. Both halves of that are
misleading, and it cost a debugging round.

### 16.4 Open the tunnel — **[phone]**

One command carries both ports:

```bash
ssh -N   -L 3000:127.0.0.1:3000   -L 8088:127.0.0.1:8088   deploy@<DROPLET_IP>
```

**Expect:** nothing. `-N` means "no remote command" — it opens the forwards and
sits there. That silence is success.

Then open **`http://localhost:3000`** in the phone's browser.

**Use `localhost`, not `127.0.0.1`.** `GRAFANA_ROOT_URL` is
`http://localhost:3000`, and Grafana builds its redirects and cookie domain from
that value. Visiting the other spelling is a different origin as far as the
cookie is concerned.

The Grafana login is `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` from
`.env.prod`:

```bash
grep -E '^GRAFANA_ADMIN_(USER|PASSWORD)=' .env.prod        # [box]
```

### 16.5 Keep it alive while the screen is off

Android aggressively suspends background apps, and a suspended Termux is a dead
tunnel.

```bash
termux-wake-lock          # release it later with termux-wake-unlock
```

Also exempt Termux from battery optimisation in Android settings. Even then,
treat the tunnel as something you open when you need it rather than something
that is always up — and add keepalives so a dead one fails fast instead of
hanging:

```bash
ssh -N -o ServerAliveInterval=30 -o ServerAliveCountMax=3   -L 3000:127.0.0.1:3000 -L 8088:127.0.0.1:8088 deploy@<DROPLET_IP>
```

Worth saving as `~/.ssh/config` on the phone so the 3am version is two words:

```
Host box
    HostName <DROPLET_IP>
    User deploy
    IdentityFile ~/.ssh/id_ed25519
    ServerAliveInterval 30
    ServerAliveCountMax 3
    LocalForward 3000 127.0.0.1:3000
    LocalForward 8088 127.0.0.1:8088
```

Then it is just:

```bash
ssh -N box
```

### 16.6 What you can actually do from the phone

**Grafana works well on a phone.** The dashboards are readable, and the four
decks — health, product, cost, safety — answer "is this real" without typing.

**The console is usable but not comfortable.** It is a plain three-file page with
no framework and no responsive layout, built that way on purpose: *"this is the
one origin in the system that can read every retained conversation, so it carries
no toolchain and no third-party script."* Reading a transcript on a phone is
fine. Deciding a ban length at 3am on a phone is a judgement call about you, not
about the tooling.

**A legal hold cannot be placed from either** (§12). That needs a `psql`
transaction, which Termux can run over plain SSH — worth having the command in a
note on the phone before the night you need it.

### 16.7 The security position, stated plainly

**What this does not change:** nothing is published. Both surfaces stay on
loopback; no Caddy route, no nginx location, no public port. The phone reaches
them exactly as your laptop does.

**What it does change:** a phone is now a credential that can reach the box. So —

* a **separate key** for the phone, revocable on its own (§16.2),
* a **passphrase** on that key,
* a **screen lock** on the phone, since Termux is unlocked when the phone is,
* remove the line from `authorized_keys` the day the phone is lost or replaced.

**Do not "fix" this by publishing Grafana.** `.env.prod.example` records what
happened the one time somebody tried: `GRAFANA_ROOT_URL` was set to
`https://karobakbak.com/grafana` for the first deployment, which broke the only
access route there is. Publishing it properly means a Caddy route, a sub-path
Grafana agrees to serve, **and a decision about exposing an admin login to the
internet** — three things, and the third is the one that matters.

### 16.8 Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `ERR_TOO_MANY_REDIRECTS` on Grafana | `GRAFANA_ROOT_URL` has a sub-path without `GF_SERVER_SERVE_FROM_SUB_PATH=true` | Set it back to `http://localhost:3000`. **The error names cookies, which is a false lead**, and it fails identically at every origin so it is not the tunnel |
| Browser shows "connection refused" | The tunnel is not up, or Android suspended Termux | Check the `ssh -N` session is still running; `termux-wake-lock` |
| `Permission denied (publickey)` | Key not authorised, or wrong user | Re-run §16.3; test with `-o BatchMode=yes` |
| Tunnel hangs instead of failing | No keepalives | Add `ServerAliveInterval 30` |
| `bind: Address already in use` | A previous tunnel is still alive | `pkill ssh` on the phone, or use different local ports |
| Grafana loads, panels say "No data" | Prometheus is fine but the series is genuinely empty | Several safety series only appear on first use — an empty `chat_retention_backlog` means **never sampled**, not nothing overdue |

---

*Companion to `OPERATIONS.md` §7e, which covers moderation as a practice —
response targets, escalation, and the limits of what a ban can do, and to
`GOING-LIVE.md`, which stands up everything else.*
