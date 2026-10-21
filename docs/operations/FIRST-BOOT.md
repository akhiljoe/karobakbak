# First boot — from a fresh droplet to a hardened Docker host

A command-by-command walkthrough of the first hour on a new box: what each
command does, what you should see, and what to do when it does something else.

**This is the procedure.** `VPS-PROVISIONING.md` is the *decision* — which
vendor, which plan, and why — and does not repeat any of this.
`DEPLOYMENT.md` is what runs here afterwards; `OPERATIONS.md` is the runbook for
when it is live.

Written 2026-09-04 while doing it for the first time, so the mistakes recorded
here are real ones rather than imagined.

---

## Before you start

| You need | Why |
|---|---|
| The droplet's public IPv4 | Everything below connects to it |
| Your SSH private key at `~/.ssh/id_ed25519`, with its passphrase | The only way in — the droplet has no password login |
| A password you have chosen for the `deploy` user | `sudo` will ask for it. Not the same as the key passphrase |
| A terminal you can open **three** copies of | Steps 3 and 4 need a second and third session open at once |

**The box this was written on:** a DigitalOcean droplet, `<vps-hostname>`,
2 vCPU / 2 GB / 60 GB, Ubuntu 24.04 LTS, created 2026-09-04. The private (VPC)
address is unused: it routes only between droplets in the same region and
nothing binds to it while this is one box. It becomes relevant if the Redis
single point of failure (F-033) is ever fixed with a second machine.

**A note on the IP.** This document writes `<DROPLET_IP>` in every command and
never records the real value. Keep the address in your own notes, outside the
repository.

Once Cloudflare proxies the domain, that protection holds only while the origin
address is unknown, so the IP does not belong in anything published (this
repository included), in a support ticket, or in a DNS record that resolves to
it directly.

### The rule that matters more than any command below

**Never close a working SSH session until you have proved the next one works.**

Steps 3 and 4 each end with a test from a *new* terminal while the old one stays
open. A droplet has no keyboard and no screen. If you lock yourself out, the
recovery is DigitalOcean's browser console, and if that fails it is destroying
the box and starting again.

---

## Step 1 — Log in as root

**Before:** the droplet exists and shows an IP in the DigitalOcean panel. Give it
a minute after creation; SSH is not up the instant the panel says Active.

```bash
ssh root@<DROPLET_IP>
```

**What it does.** Opens an SSH session as `root`. DigitalOcean has already put
your public key in `/root/.ssh/authorized_keys`, which is why no password is
asked for.

**Expect:** a prompt about authenticity the first time —

```
The authenticity of host '<DROPLET_IP>' can't be established.
ED25519 key fingerprint is SHA256:...
Are you sure you want to continue connecting (yes/no/[fingerprint])?
```

Type `yes`. This is trust-on-first-use: your machine is recording the server's
identity so it can warn you if it ever changes. Then your key passphrase, then:

```
root@<vps-hostname>:~#
```

The hostname in the prompt is your confirmation you are on the right box.

**If it fails:**

* `Permission denied (publickey)` — the droplet was created without your key
  selected, or `ssh` is offering a different key. Try
  `ssh -i ~/.ssh/id_ed25519 root@<DROPLET_IP>`.
* `Connection refused` — SSH has not started yet. Wait a minute.
* `Connection timed out` — wrong IP, or a firewall in front of it.

---

## Step 2 — Create the `deploy` user

**Before:** you are at the `root@<vps-hostname>` prompt.

**Why at all.** Working as root means every typo runs with full privileges, and
nothing separates "I meant to do that" from "I did not". A normal user with
`sudo` makes the dangerous half deliberate.

```bash
adduser deploy
```

**What it does.** Creates the user, its home directory, and its group, then
prompts for a password.

**Expect:** a password prompt, then five optional fields (Full Name, Room
Number, and so on). Press Enter through all of them, then `Y`.

**Choose a real password and keep it.** This is what `sudo` asks for. It is not
your SSH key passphrase and there is no reason for them to match.

> An earlier draft of this runbook used `adduser --disabled-password`, which
> creates the account with no password at all. SSH still works, because SSH uses
> the key — and then `sudo` prompts for a password that does not exist and
> cannot be satisfied. It looks like a broken `sudo` and it is a missing
> password.

```bash
usermod -aG sudo deploy
```

**What it does.** Adds `deploy` to the `sudo` group. On Ubuntu that group is
what `/etc/sudoers` grants administrative rights to. No output on success.

```bash
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

**What each line does:**

* `mkdir -p` — creates the directory SSH looks in for a user's authorised keys.
* `cp` — copies the same public key DigitalOcean installed for root.
* `chown -R deploy:deploy` — makes `deploy` the owner. Copied as root, the files
  would otherwise still belong to root and `deploy` could not read them.
* `chmod 700` (directory, owner-only) and `chmod 600` (file, owner read/write) —
  **not cosmetic.** `sshd` refuses to use an authorized_keys file that others
  can write to, on the reasoning that anyone who can write it can grant
  themselves access. It refuses *quietly*, and the symptom is
  `Permission denied (publickey)` with nothing in your terminal explaining why.

**Expect:** no output from any of them. Verify:

```bash
ls -la /home/deploy/.ssh/
```

Owner `deploy deploy`, directory `drwx------`, file `-rw-------`.

---

## Step 3 — Test the new user BEFORE changing anything else

**Before:** keep the root session open. Do not close it.

Open a **second terminal**:

```bash
ssh deploy@<DROPLET_IP>
```

**Expect:** your key passphrase, then `deploy@<vps-hostname>:~$`. Note the `$`
rather than `#` — that is the shell telling you that you are not root.

```bash
sudo whoami
```

**What it does.** Runs `whoami` as root. The first `sudo` in a session asks for
**your user password** — the one from step 2, not the key passphrase.

**Expect:**

```
[sudo] password for deploy:
root
```

`root` is the answer that matters. It proves the sudo group membership works.

**If `sudo` fails:**

* `deploy is not in the sudoers file` — `usermod -aG sudo deploy` did not run,
  or you logged in before it did. Run it from the root session and reconnect;
  group membership is applied at login.
* Password rejected — set one from the root session: `passwd deploy`.

**Do not continue until both commands above work.** The next step removes root
access, and this session is what will replace it.

---

## Step 4 — Harden SSH

**Before:** step 3 passed. The root session is still open.

### 4a. Look at the drop-in directory first

```bash
ls /etc/ssh/sshd_config.d/
cat /etc/ssh/sshd_config.d/*.conf
```

**Why this comes first.** Ubuntu 24.04's `/etc/ssh/sshd_config` begins with

```
Include /etc/ssh/sshd_config.d/*.conf
```

and `sshd` uses the **first** value it finds for any setting. So a file in that
directory beats anything later in the main config — and DigitalOcean's images
ship one. Editing `sshd_config` directly and finding your change ignored is a
confusing half hour; the file you edited plainly says what you want and the
server plainly does something else.

Files in the directory are read in lexical order, and first still wins — so
`00-` beats `50-`.

### 4b. Write the hardening

```bash
printf 'PermitRootLogin no\nPasswordAuthentication no\nPubkeyAuthentication yes\n' \
  | sudo tee /etc/ssh/sshd_config.d/00-hardening.conf
```

**What each setting does:**

* `PermitRootLogin no` — root can no longer log in over SSH at all. You reach
  root through `sudo`, which requires a password, so a stolen key alone is no
  longer enough.
* `PasswordAuthentication no` — keys only. Already the default on this image,
  stated explicitly so it survives a future package update that changes the
  default.
* `PubkeyAuthentication yes` — the one that must stay on. Stated so nothing
  turns it off implicitly.

**Expect:** `tee` echoes the three lines back.

### 4c. Validate before restarting

```bash
sudo sshd -t
```

**What it does.** Parses the whole configuration and reports errors. **It prints
nothing when the config is valid.**

This is the most important command in this document. A typo restarts `sshd` into
a broken config, and you find out by being unable to connect — with no way in to
fix it.

**If it prints anything at all, stop.** Fix the file. Do not restart.

```bash
sudo systemctl restart ssh
```

**Expect:** no output. Your current session survives — restarting `sshd` does not
kill established connections.

### 4d. Prove it, from a third terminal

Root session still open. Second session still open.

```bash
ssh deploy@<DROPLET_IP>     # must work
ssh root@<DROPLET_IP>       # must now be refused
```

**Expect:** the first gives a shell. The second gives
`Permission denied (publickey)` — root is refused even holding the right key.

**Only now close the root session.**

---

## Step 5 — Firewall

**Before:** you are `deploy`, and root login is off.

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
```

**What it does.** Sets the baseline: nothing may connect in, anything may
connect out. Outbound matters — the box needs to reach Docker Hub, Let's
Encrypt, npm and your backup remote.

**Expect:** `Default incoming policy changed to 'deny'` and similar.

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
```

* **22** — SSH. **Add this before enabling the firewall.** `ufw enable` with a
  default-deny policy and no rule for 22 disconnects you mid-command and locks
  you out. This is the single most common way people lose a server.
* **80** — HTTP. Needed for Let's Encrypt's challenge and for Caddy's redirect
  to HTTPS. Not optional even though nothing is served on it.
* **443** — HTTPS, and the WebSocket, which runs over the same port.

**Expect:** `Rule added` twice per rule (IPv4 and IPv6).

```bash
sudo ufw enable
```

**Expect:** `Command may disrupt existing ssh connections. Proceed with operation (y|n)?`
Answer `y`. It does not disrupt yours, because you allowed 22 first.

```bash
sudo ufw status verbose
```

**Expect:** `Status: active`, default deny incoming, and 22, 80, 443 allowed.

Nothing else is opened. Prometheus and Grafana are published to `127.0.0.1` by
the compose files and are reached over an SSH tunnel:

```bash
ssh -L 3000:localhost:3000 deploy@<DROPLET_IP>
```

Then `http://localhost:3000` in your own browser. Never open those ports.

---

## Step 6 — Docker

```bash
curl -fsSL https://get.docker.com | sh
```

**What it does.** Fetches Docker's official install script and runs it: adds
their apt repository, installs the engine, the CLI and the Compose plugin, and
enables the service.

**Expect:** a minute or two of apt output, ending with a note about managing
Docker as a non-root user.

> Piping a script from the internet into a shell deserves a moment's thought.
> This is Docker's own domain over HTTPS and is the installation method they
> document. The alternative is adding their GPG key and apt repository by hand,
> which is the same trust in more steps.

```bash
sudo usermod -aG docker deploy
```

**What it does.** Lets `deploy` talk to the Docker socket without `sudo`.

**This grants root-equivalent access** — anyone in the `docker` group can start
a container that mounts the host filesystem. It is the standard trade and worth
knowing you made it.

**Now log out and back in.** Group membership is read at login; until you
reconnect, `docker` still fails with a permissions error and it looks as though
the command did not work.

```bash
exit
ssh deploy@<DROPLET_IP>
docker compose version
```

**Expect:** `Docker Compose version v2.x.x`. **Without `sudo`** — that is the
test. Note it is `docker compose`, two words: v2 is a plugin, not the old
`docker-compose` binary.

---

## Step 7 — Swap

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**What each line does:**

* `fallocate -l 2G` — creates a 2 GB file.
* `chmod 600` — owner-only. Swap can contain anything that was in memory, so it
  must not be world-readable.
* `mkswap` — formats it as swap space.
* `swapon` — activates it now.
* The `fstab` line — makes it survive a reboot. Without it, swap is gone after
  the first restart and you find out under load.

**Why, on a 2 GB box.** Not because the build needs it — that was measured at
384 MB (`VPS-PROVISIONING.md` §2.2). It is headroom so a transient spike is
slow rather than fatal: without swap, the kernel's only response to memory
pressure is to kill a process, and it chooses the largest, which is usually
PostgreSQL or a backend.

**Expect:** `Setting up swapspace version 1, size = 2 GiB` from `mkswap`, and
the fstab line echoed back.

```bash
free -h
```

**Expect:** a `Swap:` row showing `2.0Gi` total.

---

## What you have now

A box that:

* accepts SSH only by key, only as `deploy`, on port 22
* refuses root login entirely
* accepts nothing else from the internet except 80 and 443
* runs Docker as a non-root user
* has 2 GB of swap that survives a reboot

**Not yet done:** no code, no environment file, no DNS, no TLS, nothing serving.
Continue at `VPS-PROVISIONING.md` §4.3.

---

## Quick reference

```bash
ssh deploy@<DROPLET_IP>                      # in
sudo ufw status verbose                      # what is open
docker ps                                    # what is running
free -h                                      # memory and swap
df -h /                                      # disk
sudo journalctl -u ssh -n 50                 # why SSH did something
ssh -L 3000:localhost:3000 deploy@<DROPLET_IP>   # tunnel for Grafana
```
