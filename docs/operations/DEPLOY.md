# Development and deploying to production

Since 2026-10-11 production is deployed by a button, not by hand. This is the
whole process for the single-host deployment behind a Cloudflare Tunnel
(`docker-compose.laptop.yml`, `.env.laptop.example`, `ops/laptop/`); the
comments in those files are the reference for the stack itself.

## Two directories, two stacks

| | Development | Production |
|---|---|---|
| Directory | the working copy, wherever you cloned it | `%USERPROFILE%\karobakbak-live` (a clone nobody edits) |
| Compose project | `karobakbak-dev` | `karobakbak-live` |
| Started by | `docker compose up` with `.env` | the deploy workflow, or the desktop launcher |
| Secrets | `.env` | `.env.laptop`, `monitoring/alertmanager/webhook-url`, `ops/backup/{passphrase,rclone.conf,report-token}` — all in the live directory only |
| Reached at | `http://localhost:8081` | `https://karobakbak.com` |

The live directory is never edited. Its HEAD is whatever was last deployed, on
a detached commit. Bind mounts (Prometheus rules, Alertmanager, Grafana) read
from it, so they follow deploys and never follow whatever branch development
has checked out. A deploy refuses to run if a tracked file there was edited.

The `laptop:*` npm scripts still work, from the **live** directory, for the
things the workflow does not do (`laptop:ps`, `laptop:logs`, `laptop:stats`).

## The loop

1. **Develop** on a feature branch in the working copy. Try it on the dev stack.
2. **Merge** to `main` (`--no-ff`, `npm run verify` before and after) and push.
   CI (`verify.yml`) runs. **Nothing deploys.**
3. **Deploy**: GitHub → Actions → **deploy** → **Run workflow**, ref `main`.
   Works from the GitHub app on a phone.
4. **Roll back** if needed: the same button, ref `previous`.

## What a deploy does

`.github/workflows/deploy.yml` runs `ops/laptop/deploy.mjs` on the host:

1. Refuses unless the live directory is clean and is the live stack.
2. Fetches, resolves the ref (`main`, a SHA, a `live-*` tag, or `previous`).
3. Refuses unless `verify.yml` **passed for that exact commit**.
4. Lists migrations in the range; going backwards across one warns that it is
   not undone (every migration here is additive, which is what makes that safe).
5. Moves the live directory to the commit, then `docker compose up -d --build`
   with the profiles that were already running (admin, personas). Compose
   recreates only what changed; migrate runs before backend by `depends_on`.
6. Waits for backend, frontend, redis, postgres, cloudflared (and admin and
   personas if present) to be healthy.
7. Checks the public origin answers through the tunnel.
8. Tags the commit `live-YYYY-MM-DD-HHMM` (IST) on GitHub and appends a line
   to `%LOCALAPPDATA%\karobakbak-live\deploys.log`.

A failed deploy leaves the live directory at the new commit; deploy `previous`
to go back. GitHub emails the failure, and the GitHub app notifies if enabled.

## How the host hears about it

A GitHub Actions **self-hosted runner** lives in
`%USERPROFILE%\actions-runner-karobakbak`, labelled `karobakbak-live`. It
long-polls GitHub over outbound HTTPS: it asks "any job?", GitHub holds the
question open about a minute and answers the moment there is one. Nothing
connects in; no port is opened. If the host is offline, the job waits in the
queue up to a day and runs when it is back.

It starts at logon from the scheduled task **karobakbak runner** (headless, no
window), because Docker Desktop only runs while the account is logged in
anyway and a Windows service would need the account password. Stop it by
disabling that task; remove it under GitHub → Settings → Actions → Runners.

**The runner is registered only to a private deployment repository, and must
never be registered on a public repository.** Pull requests on a public
repository can run code on self-hosted runners.

## Setting it up again

```powershell
# 1. The live clone of the private deployment repository, and the secrets
#    copied into it (never committed)
git clone https://github.com/<owner>/<deploy-repo>.git $env:USERPROFILE\karobakbak-live
# copy .env.laptop, monitoring\alertmanager\webhook-url and ops\backup\{passphrase,rclone.conf,report-token}

# 2. The runner: download actions/runner (win-x64) into
#    $env:USERPROFILE\actions-runner-karobakbak, check its SHA-256 against the
#    release notes, then register it with a token from
#    `gh api -X POST repos/<owner>/<deploy-repo>/actions/runners/registration-token`
#    (the private deployment repository, never a public one)
.\config.cmd --unattended --url https://github.com/<owner>/<deploy-repo> --token <token> `
  --name live-host --labels karobakbak-live --work _work --replace

# 3. Start at logon, headless
$a = New-ScheduledTaskAction -Execute conhost.exe -Argument "--headless cmd /c `"$env:USERPROFILE\actions-runner-karobakbak\run.cmd`""
Register-ScheduledTask -TaskName 'karobakbak runner' -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)

# 4. The launcher from the live clone, so its desktop shortcut starts production
powershell -ExecutionPolicy Bypass -File $env:USERPROFILE\karobakbak-live\ops\laptop\launcher\build.ps1 -Shortcut
```
