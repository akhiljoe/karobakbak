# Operations — every command, and what it actually does

A working reference for poking at a running karobakbak: inspecting services,
reading state, changing behaviour, clearing things, and telling a real problem
apart from something that only looks like one.

Everything here is **development-stack** unless a section says otherwise.
Commands are run from the repository root.

> **Destructive commands are marked ⚠️.** Nothing else changes state.

---

## Contents

1. [The ten you will actually use](#1-the-ten-you-will-actually-use)
2. [Docker and compose](#2-docker-and-compose)
3. [The three environments](#3-the-three-environments)
4. [Backend endpoints](#4-backend-endpoints)
5. [Redis — live state](#5-redis--live-state)
6. [PostgreSQL — retained conversations](#6-postgresql--retained-conversations)
7. [Prometheus — metrics](#7-prometheus--metrics)
8. [Grafana — dashboards](#8-grafana--dashboards)
9. [Changing behaviour](#9-changing-behaviour)
10. [Clearing and resetting](#10-clearing-and-resetting)
11. [Testing helpers](#11-testing-helpers)
12. [Things that look broken and are not](#12-things-that-look-broken-and-are-not)
13. [The moderation console](#13-the-moderation-console)
14. [AI personas](#14-ai-personas)
15. [Load testing with the swarm](#15-load-testing-with-the-swarm)
16. [Running the database somebody else operates](#16-running-the-database-somebody-else-operates)
17. [Redis failover — the drill](#17-redis-failover--the-drill)

---

## 1. The ten you will actually use

```bash
npm run up                 # build and start everything
npm run down               # stop it (keeps data)
npm run logs               # follow the backend logs
docker compose ps          # what is running and is it healthy

npm run psql               # a SQL shell in the database
npm run redis-cli          # a Redis shell
npm run unblock            # clear blocks so testing can continue

npm run verify             # typecheck + unit tests + protocol drift check
npm run test:integration   # real Redis, real PostgreSQL, real sockets
npm run loadtest           # k6 against an isolated stack
```

| What | Where |
|---|---|
| The app | http://localhost:8081 (or `FRONTEND_PORT`) |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3000 (`admin` / `admin`) |
| PostgreSQL | `localhost:5434`, db/user/pass `karobakbak` |
| Redis | `localhost:6381` |

PostgreSQL and Redis are bound to **127.0.0.1 only** — reachable from this
machine, from nothing on the network. Production publishes neither.

---

## 2. Docker and compose

### What is running

```bash
docker compose ps                                   # this project
docker compose ps --format '{{.Name}}\t{{.Status}}' # tidier
docker ps -a --filter name=karobakbak               # including stopped
docker compose config                               # the fully resolved file
docker compose config --services                    # just the service names
```

Seven services: `frontend` (nginx), `backend` ×2 replicas, `migrate` (runs once
and exits — `Exited (0)` is success), `redis`, `postgres`, `prometheus`,
`grafana`.

### Lifecycle

```bash
npm run up                       # docker compose up --build -d
docker compose up -d             # start without rebuilding
docker compose up -d --build backend   # rebuild one service
docker compose restart frontend  # restart, no rebuild
docker compose stop              # stop, keep containers
docker compose start             # start them again
npm run down                     # remove containers, KEEP volumes
docker compose down -v           # ⚠️ also delete volumes (all data)
docker compose up -d --remove-orphans  # drop containers whose service is gone
```

**Scaling.** The backends are replicas of one service, so:

```bash
docker compose up -d --scale backend=3
docker compose up -d --scale backend=1
```

nginx finds them by DNS and Prometheus discovers them the same way, so neither
needs editing.

### Logs

```bash
npm run logs                                  # follow both backends
docker compose logs -f                        # everything
docker compose logs -f --tail=100 backend     # last 100 lines, then follow
docker compose logs --since 10m backend       # a window
docker compose logs backend | grep -i error   # filter
docker logs karobakbak-dev-backend-1          # one specific replica
```

Backend logs are JSON, one object per line. Readable fields:

```bash
docker compose logs --no-log-prefix backend | grep '^{' | python -c "
import sys, json
for line in sys.stdin:
    try: o = json.loads(line)
    except Exception: continue
    print(f\"{o.get('ts','')} {o.get('level',''):5} {o.get('msg','')}\")"
```

### Inside a container

```bash
docker compose exec backend sh          # shell in the first replica
docker exec -it karobakbak-dev-backend-2 sh # a specific one
docker compose exec backend env | sort  # its environment
docker compose exec backend ls -la /var/lib/karobakbak/spool
docker compose exec backend node -e "console.log(process.version)"
```

Note `backend` addresses *a* replica; `karobakbak-dev-backend-2` addresses that one.
Containers are `<project>-<service>-<n>`: `karobakbak-dev-*` in development,
`karobakbak-live-*` in production (the project names are set in the compose files).

### Resources

```bash
docker stats --no-stream                        # CPU/memory now
docker stats                                    # live
docker compose top                              # processes per service
docker system df                                # disk used by docker
docker volume ls --filter name=karobakbak
docker volume inspect karobakbak-dev_pgdata     # karobakbak-live_pgdata in production
docker network inspect karobakbak-dev_default   # who is on the network
```

### Images

```bash
docker compose build                    # build without starting
docker compose build --no-cache backend # ignore the layer cache
docker compose images                   # what each service is running
docker image prune                      # ⚠️ delete dangling images
```

---

## 3. The three environments

| | Command | Ports | Database |
|---|---|---|---|
| Development | `npm run up` | 8081 | its own |
| Load test | `npm run loadtest` | 8090 | its own, separate |
| Production | `npm run prod:up` | loopback 8080 | whatever you configure |
| Integration tests | `npm run redis:test:up` | 6380 / 5433 | throwaway, no app |

They are separate **compose projects**, so they have separate containers,
networks and volumes and cannot see each other's data.

```bash
# load test — its own stack, so it never pollutes the development database
npm run loadtest
npm run loadtest:down            # ⚠️ destroys it, volumes and all

# talk to the load-test stack specifically (`.env.loadtest` is copied from
# `.env.loadtest.example` the first time `npm run loadtest` runs)
docker compose --env-file .env.loadtest -p karobakbak-loadtest ps
docker compose --env-file .env.loadtest -p karobakbak-loadtest logs backend

# production — refuses to start unless every secret is set
npm run prod:config              # resolve it without starting anything
npm run prod:up
npm run prod:logs
```

---

## 4. Backend endpoints

| Path | Meaning |
|---|---|
| `/health` | the process is alive. Stays 200 while Redis is down. |
| `/ready` | **Redis** is reachable. 503 means take it out of the load balancer. Deliberately does *not* check PostgreSQL — a backend with a dead database still serves chat. |
| `/metrics` | Prometheus format. **404 through nginx** on purpose; the scrape is private. |
| `/ws` | the WebSocket. Text frames only. |

```bash
curl -i http://localhost:8081/health
curl -i http://localhost:8081/ready
curl -i http://localhost:8081/metrics    # expect 404 — that is correct

# /metrics from inside, where it is served
docker compose exec backend node -e "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(console.log)" | head -40

# security headers at the edge
curl -sI http://localhost:8081/ | grep -iE 'content-security|x-frame|referrer'
```

---

## 5. Redis — live state

Redis holds **only live state**: sessions, the queue, matches, rate-limit
buckets, blocks. Persistence is off (D12), so nothing here survives a restart —
by design. Retained conversations are in PostgreSQL, never here.

### Looking around

```bash
npm run redis-cli                       # interactive shell
npm run redis-cli -- dbsize             # how many keys
npm run redis-cli -- --scan             # list them (safe; never use KEYS in prod)
npm run redis-cli -- info memory
npm run redis-cli -- info clients
npm run redis-cli -- --stat             # a live one-line summary
```

### The key names

| Pattern | Type | What |
|---|---|---|
| `chat:session:{sid}` | hash | one live session: state, instance, hashes |
| `chat:sessions` | set | every live session id |
| `chat:queue:{segment}` | set | who is searching (`default` is the only segment) |
| `chat:segments` | set | known segments |
| `chat:match:{mid}` | hash | a live match: both sides, segment, created |
| `chat:matches` | set | every live match id |
| `chat:user_match:{sid}` | string | which match a session is in |
| `chat:dedupe:{mid}` | set | message ids already seen in this match (replay protection) |
| `chat:rl:{command}:{sid}` | string | a rate-limit bucket |
| `chat:rl:conn:{ipHash}` | string | connection-attempt bucket per address |
| `chat:conn:{ipHash}` | set | live sessions per address |
| `chat:blocks:{hash}` | set | who this hash has blocked |
| `chat:instance:{iid}` | string | a backend's liveness beacon |
| `chat:instances` | set | known backends |
| `chat:janitor:lock` | string | leader lock for the reaper |
| `chat:deletion:lock` | string | leader lock for the deletion worker |
| `chat:ev:session:{sid}` | channel | Pub/Sub; the channel name *is* the routing key |

```bash
npm run redis-cli -- --scan --pattern 'chat:session:*'
npm run redis-cli -- --scan --pattern 'chat:blocks:*'
npm run redis-cli -- smembers chat:sessions
npm run redis-cli -- smembers chat:queue:default
npm run redis-cli -- scard chat:queue:default          # queue depth
npm run redis-cli -- smembers chat:matches

# one session, one match
npm run redis-cli -- hgetall chat:session:s_XXXXXXXX
npm run redis-cli -- hgetall chat:match:m_XXXXXXXX
npm run redis-cli -- ttl chat:session:s_XXXXXXXX       # seconds left
```

### Watching it happen

```bash
npm run redis-cli -- monitor            # every command, live
```

Run that, then chat in a browser. You will see `EVALSHA` for each Lua
transition, `SADD` on the queue, `PUBLISH` to the partner's channel.

```bash
# watch a session's events cross instances
npm run redis-cli -- psubscribe 'chat:ev:session:*'
```

### Clearing things

```bash
npm run unblock                          # ⚠️ clear every block
npm run redis-cli -- flushall            # ⚠️ clear ALL live state
```

`flushall` is safe in the sense that the system is designed for it (§10.14):
every session gets `SESSION_GONE`, sockets close with 4001, clients reconnect
into new sessions. It ends every live conversation.

Targeted deletes:

```bash
# every rate-limit bucket, so limits start fresh
npm run redis-cli -- EVAL "local n=0 for _,k in ipairs(redis.call('KEYS','chat:rl:*')) do redis.call('DEL',k) n=n+1 end return n" 0

# one session
npm run redis-cli -- del chat:session:s_XXXXXXXX
```

---

## 6. PostgreSQL — retained conversations

This is where message bodies live, in plaintext, inside the trusted boundary.
Nine tables; `schema_migrations` is bookkeeping.

### Connecting

```bash
npm run psql                             # shell inside the container
npm run psql -- -c '\dt'                 # one command and exit
```

**DBeaver or any client:** host `localhost`, port **5434**, database
`karobakbak`, user `karobakbak`, password `karobakbak`.

### Shape

```bash
npm run psql -- -c '\dt'                 # tables
npm run psql -- -c '\d messages'         # one table's columns and indexes
npm run psql -- -c '\di'                 # indexes
npm run psql -- -c '\du'                 # roles — note karobakbak_app has no CREATE
npm run psql -- -c '\l+'                 # databases and their sizes
```

| Table | Holds |
|---|---|
| `conversations` | both session ids, segment, start/end, end reason, expiry, legal hold |
| `messages` | **`body` is the message text**, plus length, moderation action and flags |
| `reports` | category, the reporter's note, state, resolution |
| `blocks` | salted hashes only — never raw IPs |
| `moderation_events` | which rule fired, action, severity |
| `enforcement` | actions taken against a subject key |
| `admin_audit` | append-only; the app role may `insert` but not `update` |
| `legal_holds` | who placed a hold, under what case, and why |

### Reading conversations

```bash
# how much of everything
npm run psql -- -c "select 'conversations' t, count(*) from conversations union all select 'messages', count(*) from messages union all select 'reports', count(*) from reports union all select 'blocks', count(*) from blocks order by 1;"

# a conversation, both sides, in order
npm run psql -- -c "select left(sender_session_id,10) sender, body, moderation_action, server_timestamp from messages where conversation_id = 'm_XXXX' order by server_timestamp;"

# the most recent real conversations, hiding load-test traffic
npm run psql -- -c "select m.conversation_id, left(m.sender_session_id,10) sender, m.body, to_char(m.server_timestamp,'HH24:MI:SS') at from messages m where m.body not like 'load test message%' order by m.server_timestamp desc limit 40;"

# conversations by size
npm run psql -- -c "select c.conversation_id, c.started_at, c.ended_at, c.end_reason, count(m.*) msgs from conversations c left join messages m using (conversation_id) group by 1,2,3,4 order by msgs desc limit 20;"

# anything moderation flagged
npm run psql -- -c "select rule, action, severity, count(*) from moderation_events group by 1,2,3 order by 4 desc;"
npm run psql -- -c "select left(conversation_id,14) conv, body, moderation_action, moderation_flags from messages where moderation_action <> 'allow' order by server_timestamp desc limit 20;"

# reports, with the note
npm run psql -- -c "select report_id, left(conversation_id,14) conv, category, note, state, created_at from reports order by created_at desc;"
```

### Retention and deletion

Deadlines are stamped **at insert time** and never recomputed (D17), so a
config change cannot retroactively extend the life of stored data.

```bash
# what expires when, and whether a report extended it
npm run psql -- -c "select left(c.conversation_id,14) conv, (r.report_id is not null) reported, c.retention_expires_at::date expires, (c.retention_expires_at::date - now()::date) days_left, c.legal_hold from conversations c left join reports r using (conversation_id) order by days_left;"

# anything already past its deadline (the worker should be removing these)
npm run psql -- -c "select count(*) overdue from conversations where retention_expires_at < now() and legal_hold = false;"

# legal holds
npm run psql -- -c "select * from legal_holds order by created_at desc;"
npm run psql -- -c "select count(*) held from conversations where legal_hold;"

# the audit log
npm run psql -- -c "select created_at, actor, action, subject_type, left(subject_id,14) subject, justification from admin_audit order by created_at desc limit 20;"
```

### Size and health

```bash
npm run psql -- -c "select relname table_name, pg_size_pretty(pg_total_relation_size(relid)) size, n_live_tup rows from pg_catalog.pg_statio_user_tables join pg_stat_user_tables using (relid) order by pg_total_relation_size(relid) desc;"
npm run psql -- -c "select pg_size_pretty(pg_database_size('karobakbak')) total;"
npm run psql -- -c "select count(*) connections from pg_stat_activity where datname='karobakbak';"
npm run psql -- -c "select name from schema_migrations order by applied_at;"
```

### Changing and clearing

```bash
# ⚠️ delete only load-test rows
npm run psql -- -c "delete from messages where body like 'load test message%';"
# ⚠️ then the conversations left with nothing in them
npm run psql -- -c "delete from conversations where conversation_id not in (select distinct conversation_id from messages);"

# ⚠️ empty every data table, keep the schema and the migration ledger
npm run psql -- -c "truncate conversations, messages, reports, blocks, moderation_events, enforcement, admin_audit, legal_holds restart identity cascade;"

# place a legal hold by hand (deletion will skip it)
npm run psql -- -c "update conversations set legal_hold = true where conversation_id = 'm_XXXX';"
```

### Backup and restore

The two commands below are a *manual* dump and reload, useful for moving data
around. **They are not the backup this deployment takes.** `ops/backup/backup.sh`
writes `karobakbak-<stamp>.dump.gpg` — PostgreSQL custom format, symmetric
AES256 through gpg, copied to an rclone remote — and a plain `psql` cannot read
one. Restoring the real thing is `restore.sh`, below.

```bash
# manual dump and reload, NOT the deployment's backup format
docker compose exec -T postgres pg_dump -U karobakbak karobakbak > backup.sql
cat backup.sql | docker compose exec -T postgres psql -U karobakbak -d karobakbak
```

#### Restoring an encrypted backup

```bash
# what the remote holds
docker compose run --rm --entrypoint /usr/local/bin/restore.sh backup --list

# restore the newest into a throwaway database, and count what came back
docker compose exec -T postgres psql -U karobakbak -d postgres -c 'create database restore_drill'
# restore.sh does not create the target database; without this the run ends at
# `FATAL: cannot reach database restore_drill`, which reads as a connection fault
docker compose exec -T postgres psql -U karobakbak -d postgres -c "create database restore_drill;"
docker compose run --rm --entrypoint /usr/local/bin/restore.sh backup --database restore_drill
```

`restore.sh` fetches, decrypts, verifies the archive parses as a custom-format
dump *before* touching the target, restores, and then prints row counts —
because a restore can exit zero having brought back nothing. It **refuses a
database that already has tables** unless `--force` is passed: a restore over a
populated database is how a bad day becomes an unrecoverable one.

Drilled end to end on 2026-09-04 against a MinIO stand-in for R2: 1,375 messages
and 431 conversations out, and the same counts back.

#### The two secret files

`ops/backup/passphrase` and `ops/backup/report-token` are operator-provided and
gitignored, so `.gitattributes` does not normalise them. **Write both with no
trailing newline and never with CRLF**:

```bash
printf %s "$SECRET" > ops/backup/passphrase
```

A carriage return in the passphrase becomes part of the encryption key
*invisibly* — backup and restore read the same file, so every drill passes, and
recovery fails on the day somebody re-types the passphrase from a password
manager onto a clean host. `backup.sh` and `restore.sh` both refuse to run on
one now rather than normalising it, because stripping it would silently orphan
every archive already written with it. That is not hypothetical: it was
demonstrated during the drill (F-049).

Nothing in the stack takes backups automatically without the `ops` profile.
`BackupMonitor` reports staleness and the `BackupsStale` alert fires, but the
job has to run *and report success*, or that alert is permanently red — and
`BACKUP_REPORT_TOKEN` in the environment must equal the contents of
`ops/backup/report-token`, which nothing checks.

---

## 7. Prometheus — metrics
7b. Alertmanager — who gets woken
7c. Backups — taking them, and getting them back
7d. TLS — going live on a real hostname
7e. Moderation — the part that is not code

```bash
open http://localhost:9090               # the UI, with a query box
curl -s http://localhost:9090/-/healthy
```

### Targets

```bash
curl -s 'http://localhost:9090/api/v1/targets?state=active' | python -c "
import sys, json
for t in json.load(sys.stdin)['data']['activeTargets']:
    print(f\"{t['labels']['job']:24} {t['scrapeUrl']:38} {t['health']}\")"
```

One target per backend replica. They are found by **DNS**, so scaling changes
the list with no config edit.

### Querying from the shell

```bash
q() { curl -s --get http://localhost:9090/api/v1/query --data-urlencode "query=$1" | python -c "
import sys, json
d = json.load(sys.stdin)
for r in d['data']['result']:
    print(r['metric'].get('instance','-'), r['metric'], r['value'][1])"; }

q 'chat_connections_active'
q 'sum(chat_connections_active)'
q 'chat_queue_depth'
q 'chat_active_matches'
q 'rate(chat_messages_received_total[5m])'
q 'histogram_quantile(0.95, rate(chat_delivery_latency_seconds_bucket[5m]))'
q 'chat_db_breaker_state'
q 'sum by (reason) (chat_retention_dropped_total)'
q 'chat_spool_records'
```

### The metrics that matter

| Metric | Watch for |
|---|---|
| `chat_connections_active` | live sockets per instance |
| `chat_connections_rejected_total{reason}` | `origin`, `rate_limited`, `too_many_connections`, `at_capacity` |
| `chat_queue_depth` | people waiting; if it only grows, matching is stuck |
| `chat_active_matches` | live conversations |
| `chat_matchmaking_latency_seconds` | dominated by who is waiting, not by the server |
| `chat_messages_{received,delivered,rejected}_total` | delivery health |
| `chat_delivery_latency_seconds` | one Redis round trip plus a socket write |
| `chat_rate_limited_total{command}` | which limit people are hitting |
| `chat_moderation_flags_total{action}` | how often rules fire |
| `chat_retention_queued/flushed/dropped_total` | **`dropped` should be zero** |
| `chat_retention_queue_depth{priority}` | write-behind backlog |
| `chat_db_breaker_state` | 0 closed, 1 open, 2 half-open |
| `chat_spool_records`, `chat_spool_bytes` | outage buffer filling |
| `chat_deletion_failures_total` | data past its deadline and still stored |
| `chat_backup_last_success_timestamp` | 0 means no backup has ever reported |
| `chat_process_nodejs_eventloop_lag_p99_seconds` | process saturation |

```bash
# everything the app exports, names only
docker compose exec backend node -e "fetch('http://127.0.0.1:8080/metrics').then(r=>r.text()).then(t=>console.log([...new Set(t.split('\n').filter(l=>l.startsWith('# HELP')).map(l=>l.split(' ')[2]))].join('\n')))"
```

### Alerts

```bash
curl -s http://localhost:9090/api/v1/rules | python -c "
import sys, json
for g in json.load(sys.stdin)['data']['groups']:
    for r in g['rules']:
        if r['type'] == 'alerting':
            print(f\"{r['name']:26} {r['state']}\")"

curl -s http://localhost:9090/api/v1/alerts   # currently firing
```

Shipped alerts: `BackendDown`, `RetentionDeletionFailing`, `SafetyRecordsDropped`,
`DatabaseCircuitOpen`, `SpoolNearCapacity`, `BackupsStale`, `EventLoopLagHigh`.

There is **no alertmanager** — alerts evaluate and show in the UI, but nothing
sends them anywhere.

```bash
docker compose exec prometheus promtool check rules /etc/prometheus/alerts.yml
docker compose exec prometheus promtool check config /etc/prometheus/prometheus.yml
docker compose restart prometheus         # after editing either file
```

---

## 7b. Alertmanager — who gets woken

Prometheus decides *that* something is wrong. Alertmanager decides who hears
about it. Before this existed the rules evaluated and reached nobody, including
the ones labelled `severity: page` — the monitoring looked finished and was not.

### One-time setup

The webhook URL is a bearer credential — anyone holding it can post alerts that
look like they came from your service — so it lives in a gitignored file rather
than in the environment or this repository.

```bash
# any endpoint that accepts a POST: ntfy, Pushover, Discord, Slack, your own
cp monitoring/alertmanager/webhook-url.example monitoring/alertmanager/webhook-url
$EDITOR monitoring/alertmanager/webhook-url

docker compose up -d alertmanager
```

For one operator, pick something that reaches a **phone**. Email at three in the
morning is not a page.

### Prove it works, rather than assuming

The whole chain is Prometheus → rule → Alertmanager → webhook → you, and every
link fails silently. Test it end to end at least once:

```bash
# is Prometheus actually talking to Alertmanager
curl -s localhost:9090/api/v1/alertmanagers | jq '.data.activeAlertmanagers'

# every rule and its current state — all should be "inactive" on a healthy stack
curl -s localhost:9090/api/v1/rules \
  | jq -r '.data.groups[].rules[] | select(.type=="alerting") | "\(.name): \(.state)"'

# fire one by hand, without breaking anything
curl -s -XPOST localhost:9093/api/v2/alerts -H 'content-type: application/json' -d '[{
  "labels": {"alertname": "ManualTest", "severity": "page"},
  "annotations": {"summary": "testing the notification path"}
}]'

# what Alertmanager is currently holding
curl -s localhost:9093/api/v2/alerts | jq -r '.[] | "\(.labels.alertname) \(.status.state)"'
```

The honest test is the destructive one: `docker compose stop backend`, then wait
for `BackendDown` to go from pending to firing and confirm your phone buzzes.
It takes about seventy seconds — `for: 1m` plus the ten-second group wait.
`docker compose start backend` afterwards.

### The two rhythms

| Severity | Means | Wait | Repeats |
|---|---|---|---|
| `page` | Users are affected right now | 10s | hourly until it stops |
| `ticket` | A promise is quietly not being kept | 30s | twice a day |

Paging somebody for a ticket is how a person learns to ignore pages.

### Rules that watch the watcher

Two rules exist only to make the rest trustworthy, because both of these
failures are indistinguishable from a quiet week:

* **`AlertmanagerAbsent`** — Prometheus cannot reach the notifier at all.
* **`AlertNotificationsFailing`** — the notifier is running and the receiver is
  rejecting it. Almost always a webhook URL that is wrong, expired or rate
  limiting. Suspect this first after changing the URL.

### Still to add

A **dead man's switch** is the one gap left in this chain. Every rule above
fires when something breaks; none of them fires when *Prometheus itself* stops,
and silence then reads exactly like health. The pattern is an always-firing
`Watchdog` alert routed to an external service that alerts you when it stops
hearing from you. It needs a second receiver and an account somewhere, so it is
a deliberate next step rather than something wired blind.

---

## 7c. Backups — taking them, and getting them back

`BackupMonitor` in the application exists to notice when backups stop. For a
long time nothing took one, so it reported `unknown` for ever. The `backup`
service is the thing that takes them.

Dumps are **encrypted** (`DESIGN.md` §8.1), and the reason is worth restating:
message bodies are plaintext inside the trusted boundary, so a dump is the
entire retained corpus in one file — and that file travels, to object storage
and to a laptop during a drill. That is exactly the boundary I8 says text must
not cross unprotected.

### One-time setup

```bash
# Both secrets, written here rather than anywhere else, with no trailing
# newline. See the note on CRLF above: these three files are gitignored, so
# `.gitattributes` does not normalise them and nothing else will.
printf %s "$(openssl rand -base64 32)" > ops/backup/passphrase
printf %s "$(openssl rand -hex 16)"    > ops/backup/report-token

# The container runs as `postgres` (ops/backup/Dockerfile), not as you. Give
# that group read and nobody else anything.
BGID=$(docker run --rm --entrypoint id karobakbak-backup -g)
sudo chown "$USER":"$BGID" ops/backup/passphrase ops/backup/report-token ops/backup/rclone.conf
chmod 640 ops/backup/passphrase ops/backup/report-token ops/backup/rclone.conf

# the backend needs the same token, so it can recognise the report
echo "BACKUP_REPORT_TOKEN=$(cat ops/backup/report-token)" >> .env

docker compose up -d --build backup backend
```

> **`0640` and the container's group. Both obvious alternatives are wrong.**
> This step used to say `cp passphrase.example passphrase`, which inherits
> `0644` — so it works on the first try and leaves the key that decrypts every
> retained conversation readable by every account on the host. Tightening it to
> `0600` breaks it the other way: the container is a different user, and the log
> says `gpg: can't open '/run/secrets/backup-passphrase': Permission denied`
> followed by `dump or encryption failed`, which reads as a bad passphrase
> rather than as a permission. Found by doing it, 4 September 2026.

> **A file that Docker created is a directory, and it will recreate it.** The
> `backup` service bind-mounts these three paths, and Docker's answer to a bind
> mount whose source does not exist is to create a **directory** there. So a
> stack that ran before the files existed has three directories in their place,
> and the container reports `missing, empty, or not a file` alongside
> `cat: read error: Is a directory`. Removing them is not enough on its own:
> a restarting container puts them back as fast as they are deleted, and
> `docker compose up` will reuse an existing container with its old mount type
> and fail with `not a directory: Are you trying to mount a directory onto a
> file`. Stop it, **remove the container**, delete the directories, write the
> files, then `up -d --force-recreate backup`.

> **Copy the passphrase into a password manager now.** An encrypted backup you
> cannot decrypt is not a backup, and the passphrase living only on the host
> being backed up defeats the entire exercise. Both files are gitignored.

### The off-host destination

`BACKUP_REMOTE` is **Cloudflare R2** — S3-compatible, 10 GB free, and no egress
charge, which matters on the day you restore because that day is already going
badly. It is also a vendor already in the stack, so it is one fewer set of
credentials to hold and one fewer status page to watch.

Creating it, once:

1. Cloudflare dashboard → **R2** → **Create bucket** → give it a name
   (`<backup-bucket>` below). Location hint can stay automatic.
2. **R2 → Manage API Tokens → Create API Token.** Permission
   **Object Read & Write**, scoped to **that one bucket**. Not account-level: a
   token with account permissions can delete the bucket it exists to fill.
3. Copy the **Access Key ID**, the **Secret Access Key**, and the **S3 endpoint**
   (`https://<account id>.r2.cloudflarestorage.com`). The secret is shown once.
4. Put them in `ops/backup/rclone.conf` under an `[r2]` section — the shape is in
   `rclone.conf.example` — and set `BACKUP_REMOTE=r2:<backup-bucket>`.

Prove the credentials before a scheduled job depends on them. The `backup`
service exists only in the production override, so on a machine without it, run
the same commands in a throwaway container:

```bash
CONF=$PWD/ops/backup/rclone.conf
R="docker run --rm -i -v $CONF:/config/rclone/rclone.conf:ro rclone/rclone"

echo probe | $R rcat r2:<backup-bucket>/probe.txt   # write
$R ls   r2:<backup-bucket>                          # list  -> 6 probe.txt
$R cat  r2:<backup-bucket>/probe.txt                # read  -> probe
$R delete r2:<backup-bucket>/probe.txt              # clean up
```

On the production host the `backup` service is present, so it is
`docker compose exec backup rclone ...` with the same four arguments.

> **`rclone lsd r2:` returns 403, and that is the token being correct.** `lsd`
> lists *buckets*, which is an account-level operation, and the token is scoped
> to one bucket on purpose. Reaching for it as a first smoke test reads as
> "these credentials are broken" at exactly the moment somebody is least
> inclined to doubt the test rather than the setup. Probe the bucket, never the
> account.

**R2 is outside India, and that is a disclosed cross-border transfer**, named
outright in the Privacy Policy's "Where your data is". Changing the destination,
or adding a second one, changes that section too — it is a policy
edit before it is a config edit. Register row 10 records why the earlier
India-only position was reversed.

**A machine that is not always on is a fine second copy and a bad primary.** It
is a different failure domain, but it is reachable only while it is switched on,
so a pushed run would fail whenever it is off, and an alert that cries wolf is
the one nobody reads on the night it is right. If you want one, pull rather than
push, on that machine, whenever it suits:

```bash
rclone copy r2:<backup-bucket> ~/backups
```

The dumps are encrypted before they move, so neither R2 nor the second copy
holds anything readable. That is also why the passphrase must live in neither
place.

### Watching it

```bash
# what it has done
docker compose logs -f backup

# what it holds, oldest first
docker compose exec backup ls -la /backups

# what the application believes — 0 means it has never been told anything
docker compose exec backend wget -qO- http://localhost:8080/metrics | grep chat_backup
```

`BACKUP_INTERVAL_SECONDS` (default daily) and `BACKUP_KEEP` (default 7) control
the rhythm and how many are kept. The job prunes only files matching its own
name pattern, so nothing else sharing that volume is ever a deletion candidate.

### Restoring — do this once before you need it

A backup nobody has restored is a hypothesis. Restore into a scratch database,
never over the live one:

```bash
# 1. somewhere to put it
docker compose exec postgres psql -U karobakbak -d karobakbak -c "create database restore_drill"

# 2. decrypt and restore the newest backup
docker compose exec backup sh -c '
  f=$(ls -1 /backups/*.dump.gpg | tail -1)
  gpg --batch --quiet --decrypt --passphrase-file /run/secrets/backup-passphrase "$f" > /tmp/drill.dump
  pg_restore --no-owner --no-privileges -d restore_drill /tmp/drill.dump
'

# 3. prove it — eleven tables, and real rows in them
docker compose exec postgres psql -U karobakbak -d restore_drill -c "\dt"
docker compose exec postgres psql -U karobakbak -d restore_drill -c "select count(*) from conversations"

# 4. clean up
docker compose exec postgres psql -U karobakbak -d karobakbak -c "drop database restore_drill"
```

Restoring **over** the live database is `docs/operations/OPERATIONS.md` §6, and is a
different, more dangerous procedure. The drill above touches nothing real.

### Off the host

The volume lives on the same machine as the database it protects, which covers
a bad migration and not a lost host. Shipping the encrypted files somewhere else
— object storage, another machine — is the remaining step, and it is safe to do
with a dumb file copy precisely because they are already encrypted.

### What alerts

| Alert | Means |
|---|---|
| `BackupsNeverObserved` | Up longer than the window and never told about a backup. Nothing is taking them, or the report is not arriving. |
| `BackupsStale` | Backups were running and have stopped. |
| `chat_backup_failures_total` moving | The job is running and *failing* — a different problem from silence, and visible only because the job reports its failures too. |

---

## 7d. TLS — going live on a real hostname

Production used to publish the edge to loopback and leave HTTPS as a deployment
decision. Until something terminated it, secure WebSockets did not work, the
block-token cookie could not be `Secure`, and every message crossed the network
in clear text. The `caddy` service is that something, and it exists only in the
production override — nothing on a laptop needs a certificate.

### Before you start it

Certificates are issued against a name, so DNS has to be right **first**:

```bash
# an A record for the hostname, pointing at this host
dig +short karobakbak.com

# nothing else may hold 80 or 443 — Caddy needs both
sudo ss -lntp | grep -E ':(80|443)\s'
```

Port 80 is not optional. The ACME HTTP challenge arrives on it, and Caddy
redirects everything else from it to 443.

```bash
# .env for the production stack
KAROBAKBAK_DOMAIN=karobakbak.com
ACME_EMAIL=you@example.com
ALLOWED_ORIGINS=https://karobakbak.com
TRUST_PROXY_HOPS=<hops>   # the number of proxies you run; see below

npm run prod:up   # or: docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
docker compose logs -f caddy   # watch the certificate being obtained
```

### The setting that breaks everything quietly

`TRUST_PROXY_HOPS` tells the backend how many entries at the right-hand end of
`X-Forwarded-For` were written by proxies you control. It has to match the
proxies actually in front of the backend (with this override, at least Caddy and
nginx), and it is worth understanding rather than copying.

| Value | What the backend sees | Consequence |
|---|---|---|
| Too low | a proxy's address, for everybody | One rate-limit bucket and one block identity for the whole service. A ban on anyone bans everyone. |
| Exact | the real client | Correct. |
| Too high | an entry the proxies did not vouch for | Per-address limits and blocks key on a value the backend should not trust. |

Every proxy added in front (Cloudflare, a load balancer) changes the count, and
a proxy that Caddy should trust has to be listed in `trusted_proxies` in
`ops/caddy/Caddyfile` at the same time. Measure it on the running stack
(§7d, "Measuring `TRUST_PROXY_HOPS`") rather than reasoning about it.

### Checking it worked

```bash
# a real certificate, and the app behind it
curl -sI https://karobakbak.com | head -1
curl -sI https://karobakbak.com | grep -i strict-transport

# the WebSocket upgrade through TLS — expect 101
curl -sk -o /dev/null -w '%{http_code}\n' https://karobakbak.com/ws \
  -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='

# certificate expiry, if you ever want to check by hand
echo | openssl s_client -connect karobakbak.com:443 2>/dev/null \
  | openssl x509 -noout -dates
```

### Where the headers come from

Caddy adds `Strict-Transport-Security` because it is the only layer that knows
the request arrived over TLS. Everything else — the Content Security Policy,
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` — stays in
nginx's `security-headers.conf`, so there is one place those are decided rather
than two that can disagree.

HSTS is set to two years with subdomains and deliberately **without** `preload`.
Preloading is a one-way door enforced by browsers for months regardless of what
the config later says; it should be a considered decision, not a default picked
up from an example.

### If the certificate does not issue

```bash
docker compose logs caddy | grep -iE 'error|challenge|obtain'
```

Almost always one of: DNS not pointing here yet, port 80 blocked by a firewall
or held by another process, or Let's Encrypt rate limiting after repeated
failed attempts on the same name. The `caddydata` volume holds the certificates
and the ACME account key — losing it means re-issuing, which counts against
those rate limits, so it is not a cache to be cleared casually.

### `www` redirects, and must never serve

**Done on 2 Sep 2026.** Recorded here because the reasoning is not obvious and
the failure it prevents is silent.

`www.karobakbak.com` and `karobakbak.com` are different origins to a browser, so
nothing saved for one is sent to the other. The block token is exactly that: set
by `clientTokenCookie()` with **no `Domain` attribute**, which makes it host-only.
Somebody who blocks three people on the apex and later arrives on `www` presents
no token, is issued a fresh one, and is a different person as far as every block
they have made is concerned. Nothing errors. The auth cookies split the same way,
but visibly — `__Host-` *requires* no `Domain`, so signing in on one hostname
leaves the other signed out, and somebody would report that. The block failure is
the one nobody reports.

What is configured at Cloudflare:

| | |
|---|---|
| DNS | `A` record, name `www`, value `192.0.2.1`, **Proxied** |
| Redirect rule | Single Redirect, wildcard `https://www.*` → `https://${1}`, **301**, preserve query string |
| SSL/TLS | **Always Use HTTPS** on |

The address is deliberately RFC 5737 TEST-NET-1 and routes nowhere. A
`CNAME www → karobakbak.com` would work identically today and fail the *dangerous*
way: delete the redirect rule and `www` quietly starts serving the app again,
restoring the split silently. With a dummy address, losing the rule breaks `www`
outright and you find out.

`Always Use HTTPS` is required rather than tidy: the rule's pattern begins
`https://`, so a plain HTTP request does not match it and returns 522 — which is
the path a person typing the address by hand takes. With it on the request is
upgraded at the edge first and the redirect then fires, two hops, both at
Cloudflare.

Verifying it, from anywhere:

```bash
# both hops
curl -sS -o /dev/null -L -w "hops=%{num_redirects} final=%{url_effective}
"   http://www.karobakbak.com/faq
# expect: hops=2 final=https://karobakbak.com/faq

# path and query survive
curl -sS -o /dev/null -w "%{http_code} %{redirect_url}
"   "https://www.karobakbak.com/premium?ref=x"
# expect: 301 https://karobakbak.com/premium?ref=x
```

**If you ever see a WebSocket upgrade refused with a 403 naming `www`, the
redirect has stopped firing.** Fix the redirect. Adding
`https://www.karobakbak.com` to `ALLOWED_ORIGINS` clears the error and makes the
split identity permanent, which is worse than the visible breakage because it
now looks fixed.

### The apex must be proxied, not just pointed

At deploy the apex `A` record changes from the `192.0.2.1` placeholder to the
real host **and must be switched to Proxied**. `frontend/nginx.conf` performs the
EEA/UK block on the `CF-IPCountry` header, which exists only for traffic that
passed through Cloudflare. Grey-clouded, the geo-block silently permits everyone.
It is also another `X-Forwarded-For` hop, so `TRUST_PROXY_HOPS` is re-measured
against the running stack at the same time.

`auth.karobakbak.com` stays **DNS only** — it is a CNAME to the CloudFront
distribution behind the Cognito custom domain, and proxying it breaks the
certificate validation that lives beside it.

### Measuring `TRUST_PROXY_HOPS`

**Do this on the real stack, after deploy, and measure rather than reason.** The
value depends on what is actually in front of the backend, and every version of
getting it wrong is silent.

**What it decides.** `clientAddress()` turns the connection into an address, and
that address becomes the rate-limit bucket, one of the two dimensions a block
keys on, and the ban check read before a session exists (the upgrade handler in `server.ts`). Each
proxy *appends* what it saw to `X-Forwarded-For`, so the chain reads right to
left — rightmost is the nearest proxy — and the setting says how many entries
from the right were written by infrastructure you control.

**Too low** and every visitor resolves to a proxy's own address: one rate-limit
bucket and one block identity for the whole service, so a ban on anybody bans
everybody. **Too high** and the backend trusts an entry no proxy of yours wrote,
which undermines per-address limits and blocks. Neither produces an error.

**The measurement:**

1. Bring the full public chain up — Cloudflare proxying the apex, Caddy, nginx,
   backend.
2. Set `TRUST_PROXY_HOPS=0` for the moment. The header is then ignored entirely,
   so nothing is trusted while you look at it.
3. Make one request **from outside**, over the public hostname — a phone on
   mobile data. Not from the server, not from your LAN.
4. Read the header the backend actually received. If nothing logs it, stand up a
   throwaway listener rather than guessing:

   ```bash
   docker compose exec backend node -e "require('http').createServer((q,s)=>{console.log(JSON.stringify(q.headers['x-forwarded-for']));s.end('ok')}).listen(9099)"
   ```

5. Count from the right until you reach your phone's real address. That index is
   the value. The client's claimed address is never one of the hops you control.
6. Set it, restart, and prove it with two devices on **different networks** —
   they must land in separate rate-limit buckets rather than sharing one.

**Which upstream proxies Caddy trusts changes what reaches the backend.** Adding
an upstream such as Cloudflare to `trusted_proxies` in `ops/caddy/Caddyfile`
changes how Caddy treats the inbound header, so the hop count has to be
re-measured with it. The two changes belong in the same commit: the
`trusted_proxies` edit, and the re-measured count.

**Re-measure whenever anything is added in front** — a WAF, a load balancer,
another CDN. Each is a hop, and the value becomes wrong without anything saying
so.

---

## 7e. Moderation — the part that is not code

The console is built and audited: purpose-scoped transcript access, an audit row
written before the content is selected, its own process and its own database
role. None of that decides who opens it, how quickly, or what happens when a
report stops being moderation and becomes something else.

That is this section, and it is deliberately short. With one moderator, most of
this is a decision rather than a process.

### Start it

**Standing it up for the first time is `CONSOLE-SETUP.md`** — the role password,
the first account, the tunnel, and five checks that prove it rather than
assuming it. This section is the short form, for a console that already exists.

The console is its own container, behind a profile, so nothing starts it by
accident:

```bash
docker compose --profile admin up -d admin
```

It reuses the **backend image** — `tsconfig.build` compiles all of `src`, so
`dist/admin/main.js` and the console's three static files are already in there,
after `npm ci --omit=dev`. Nothing extra is built and nothing is installed on
the host.

**Do not start it with `npm run console` on the box.** That entry point is
`tsx`, a devDependency, so it needs `npm install` in `backend/` — which puts a
compiler and the whole development tree on the one machine holding the database,
the hash salt and the spool, and runs every package's install scripts there. It
also falsifies the reasoning behind the CI audit gate, which omits dev
dependencies *because they never reach production*. The `npm run console` script
remains what it always was: the way to run the console on a laptop.

### Give the console role a password — **[box], once**

`005_admin_accounts.sql` creates `karobakbak_console` as `nologin` with no
password, for the same reason `karobakbak_app` is (step D of `GOING-LIVE.md`):
credentials live in secret management, never in a migration in git. Until this
is done the container starts and cannot connect.

```bash
docker compose --env-file .env.prod -f docker-compose.yml -f docker-compose.prod.yml   exec -T postgres psql -U karobakbak -d karobakbak   -c "alter role karobakbak_console with login password 'PASTE_PG_CONSOLE_HERE';"
```

Then put the matching value in `.env.prod` as `CONSOLE_DATABASE_URL`:

```
CONSOLE_DATABASE_URL=postgres://karobakbak_console:PASTE_PG_CONSOLE_HERE@postgres:5432/karobakbak
```

**It must be a different password from the app role's**, and it must point at
`karobakbak_console`. That role can read a transcript and cannot delete a
conversation; the app role is denied `admin_accounts` outright. Pointing the
console at the app role collapses that separation and *appears to work
perfectly*.

### Create the first account

There is no default account and no signup. The first one is made by running the
same image with a different command:

```bash
docker compose --profile admin run --rm admin node dist/admin/create-account.js
```

It prompts for a username and password and prints a TOTP secret. The secret is
shown once. Put it in an authenticator app immediately; there is no recovery
path other than creating another account the same way.

### Reaching it

The port is published on the host's **loopback only** — `127.0.0.1:8088` — so it
is not reachable from the internet, is never proxied by nginx, and never gets a
Caddy site. From your laptop:

```bash
ssh -N -L 8088:127.0.0.1:8088 deploy@<vps-ip>
```

then open `http://127.0.0.1:8088`. This origin can read every retained
conversation; an SSH tunnel is the access control.

### Response target

`REPORT_RESPONSE_TARGET_SECONDS` (default 24 hours) is the promise, and it is
exported as a metric so `ReportsWaitingTooLong` can compare against it rather
than repeating the number. When the oldest untriaged report has waited longer
than the target for fifteen minutes, it pages.

It pages rather than raising a ticket on purpose. A report is a person saying
something went wrong, and with a single moderator there is no rota to notice
that the queue grew overnight.

```bash
# what is waiting right now
curl -s localhost:9090/api/v1/query?query=chat_reports_open | jq -r '.data.result[].value[1]'
curl -s localhost:9090/api/v1/query?query=chat_report_queue_oldest_seconds | jq -r '.data.result[].value[1]'
```

Set the target to something you will actually meet. A target you miss every day
is the same as no target, except that it also trains you to ignore the alert.

### What the console can and cannot do

**Can:** review a reported conversation with the transcript, resolve a report,
issue a ban across both identity dimensions, revoke one.

**Cannot:** warn a user, narrow one user's rate limits, or quarantine somebody
into a segregated queue. Those words exist in the `enforcement` schema and are
deliberately reserved, but nothing carries them out — each needs a delivery
mechanism this build does not have, so they are deferred rather than
half-built. A row written with one of them is now reported at error level
rather than silently doing nothing, which is what would otherwise happen if an
automated path ever wrote one.

So the vocabulary today is: **resolve, ban, or revoke.** Ban length is the only
dial, and `suspend` is the same mechanism with an end date.

### Escalation — decide this before launch, not during

Some reports stop being moderation. Write down, in advance, what you do when
one arrives, because the moment it does is the worst time to be deciding:

* **Content involving a minor.** Preserve first — place a legal hold before
  anything expires (`docs/operations/OPERATIONS.md` §6) — then follow the reporting
  obligations for your jurisdiction. This is the case the retention window and
  the hold mechanism exist for.
* **Credible threat to a person.** Preserve, then contact local law
  enforcement. Have the contact route written down.
* **A legal request or takedown notice.** Place a hold before responding, and
  do not delete anything while one is open.

The technical parts are already built — holds suspend deletion, the audit log
records every read, and `admin_audit` is retained for a year. What is missing
is the phone number and the decision, and neither is code.

### What a ban can and cannot guarantee

Bans key on a salted IP hash and a cookie token, because the service collects no
identity. A ban is therefore a deterrent, not a guarantee, and that is a
deliberate trade: the alternative is identity collection, which is a much larger
privacy and compliance surface.

Treat a ban as one layer among several. The others are already in place: rate
limits, per-IP connection caps, moderation rules on message content, and the
block that a user applies themselves.

---

## 8. Grafana — dashboards

```bash
open http://localhost:3000                # admin / admin
```

The dashboard is **karobakbak — overview** (uid `karobakbak-overview`),
provisioned from `monitoring/grafana/dashboards/`. Edits in the UI are not
saved back — `allowUiUpdates: false`, so the file is the source of truth.

```bash
# what Grafana thinks it has
curl -s -u admin:admin http://localhost:3000/api/health
curl -s -u admin:admin 'http://localhost:3000/api/search?type=dash-db'
curl -s -u admin:admin http://localhost:3000/api/datasources

# query Prometheus through Grafana, proving the datasource wiring
curl -s -u admin:admin 'http://localhost:3000/api/datasources/proxy/uid/karobakbak-prometheus/api/v1/query?query=up'

docker compose restart grafana            # after editing a dashboard file
```

The datasource uid is pinned to `karobakbak-prometheus` and every panel
references it by that uid, so it does not depend on which datasource Grafana
considers default.

There are two dashboards now: **karobakbak - overview** and
**karobakbak - logs** (uid `karobakbak-logs`), the second described in 8b.

---

## 8b. Loki - logs

Log lines used to live in `docker logs` and disappear with the container. Loki
keeps them for seven days; Alloy is what puts them there, reading container
stdout through the Docker API.

```bash
open http://localhost:3000/d/karobakbak-logs      # the dashboard
curl -s http://localhost:3100/ready               # is Loki up
curl -s http://localhost:12345/-/ready            # is Alloy up
```

The dashboard has a **Service** picker and a **Contains** box; start with the
"Warnings and errors" panel. Useful queries by hand:

```bash
# which services are shipping at all
curl -s http://localhost:3100/loki/api/v1/label/service/values

# the last hour of warnings and errors, newest first
curl -s -G http://localhost:3100/loki/api/v1/query_range   --data-urlencode '{service="backend", level=~"warn|error"}'   --data-urlencode "start=$(( ($(date +%s) - 3600) ))000000000"   --data-urlencode "end=$(date +%s)000000000"
```

On the **load stack** the ports are offset like every other component:
Loki `3103`, Alloy `12348`, Grafana `3002`.

### Checking the logs are clean

```bash
npm run verify:logs                                    # dev stack
node scripts/verify-log-hygiene.mjs --url http://localhost:3103 --since 2h
```

It fails on an address literal, a credential-shaped `name=value`, or any of
`logger.ts`'s denied field names appearing as a JSON key on a shipped line. Run
it after a load run and after anything that changes what gets logged.

It is a **detector, not a redactor**, and that is deliberate: a scrubber in the
shipper would make a future failure of `logger.ts` or of the nginx access format
invisible. It reports a truncated SHA-256 rather than the value, so its own
output never becomes the second copy of the leak. Find the source by the service
and the shape it names.

It is not in `npm run verify`, which is hermetic and must stay runnable with
nothing running.

### The nginx access log is not the stock one

`frontend/nginx.conf` defines `kbb_access`, a JSON format that has **no
client-address variable in it** and logs `$uri` rather than `$request` - so no
query string, and therefore no OIDC authorization code. That is F-036; the
default format was writing both. Do not replace it with `main` to "get more
detail": the detail it adds is a visitor's IP address and a credential.

`$upstream_addr` is in there and is worth knowing about - it says which backend
replica answered, which is how a cross-instance problem is read from the edge.

---

## 9. Changing behaviour

Every knob is documented in [`.env.example`](../../.env.example). Put overrides in
`.env` and recreate:

```bash
docker compose up -d          # picks up .env changes for env-driven values
```

Values Vite inlines (`VITE_*`) need a **rebuild**, not a restart:

```bash
docker compose up -d --build frontend
```

### Worth knowing about

| Variable | Effect |
|---|---|
| `ALLOWED_ORIGINS` | every origin a browser may connect from. Wrong ⇒ 403 on upgrade. Add `http://<lan-ip>:8081` to test on a phone. |
| `MAX_MESSAGE_LENGTH` | 500 by default; the client reads it from the server |
| `MESSAGE_RATE_PER_SEC` / `MESSAGE_BURST` | how fast anyone may send |
| `CONN_RATE_LIMIT`, `MAX_CONNECTIONS_PER_IP` | per-address abuse controls — the reason a load test needs its own stack |
| `BLOCK_TTL_SECONDS` | how long a block lasts (30 days) |
| `BLOCK_DIMENSION_IP_ENABLED` | whether blocks apply by address as well as token |
| `MODERATION_ENABLED`, `MODERATION_DEFAULT_ACTION` | `flag` reviews, `block` withholds |
| `MODERATION_DENY_LIST` | extra terms, comma separated |
| `CONVERSATION_RETENTION_DAYS` etc. | retention periods, stamped at insert |
| `DELETION_INTERVAL_MS` | how often the deletion worker runs (1 hour) |
| `RETENTION_ENABLED` | turn the write-behind path off entirely |
| `LOG_LEVEL` | `debug` is genuinely useful here |

Client-side timings — typing idle, reconnect backoff, message grouping, notice
duration — are in `frontend/src/config.ts`, not the environment, because they do
not vary per deployment. Per-person settings live in the browser
(`frontend/src/preferences.ts`).

### Making the deletion worker run now

It runs hourly. To see it work without waiting:

```bash
# ⚠️ backdate everything so it is all expired
npm run psql -- -c "update conversations set retention_expires_at = now() - interval '1 day'; update messages set retention_expires_at = now() - interval '1 day';"
docker compose restart backend           # a pass runs shortly after start
docker compose logs backend | grep -i 'deleted expired'
```

---

## 10. Clearing and resetting

From gentlest to most complete.

```bash
# 1. blocks only — the usual one during testing
npm run unblock

# 2. rate limits only
npm run redis-cli -- EVAL "local n=0 for _,k in ipairs(redis.call('KEYS','chat:rl:*')) do redis.call('DEL',k) n=n+1 end return n" 0

# 3. ⚠️ all live state; every conversation ends, clients reconnect
npm run redis-cli -- flushall

# 4. ⚠️ all stored conversations, keep the schema
npm run psql -- -c "truncate conversations, messages, reports, blocks, moderation_events, enforcement, admin_audit, legal_holds restart identity cascade;"

# 5. ⚠️ both of the above, for a genuinely clean run
npm run redis-cli -- flushall && npm run psql -- -c "truncate conversations, messages, reports, blocks, moderation_events, enforcement, admin_audit, legal_holds restart identity cascade;"

# 6. ⚠️⚠️ delete the volumes and start from an empty database
docker compose down -v && npm run up
```

Do **not** truncate `schema_migrations` — the ledger is what stops migrations
re-running. It is harmless if they do, but pointless.

Clearing the browser side:

```
DevTools → Application → Storage → Clear site data
```

That removes the block-token cookie (a new identity) and the settings in
`karobakbak.preferences.v1`.

---

## 11. Testing helpers

```bash
npm run verify              # protocol drift + typecheck + unit tests, both packages
npm test                    # backend unit only
npm run test:frontend
npm run redis:test:up       # throwaway Redis :6380 and PostgreSQL :5433
npm run test:integration    # needs the above
npm run redis:test:down
npm run loadtest            # isolated stack on :8090, then k6 capacity smoke
npm run loadtest:down
```

For the population load test — thousands of scripted strangers with oracles that
decide whether the run passed — see [§15](#15-load-testing-with-the-swarm). `k6`
above measures how many sockets the edge will hold; the swarm measures whether
the product is still correct while it holds them.

Two WebSocket clients from the shell, to check matching and delivery without a
browser:

```bash
cd backend && cat > tc.tmp.js <<'EOF'
const WebSocket = require('ws');
const URL = 'ws://localhost:8081/ws', ORIGIN = 'http://localhost:8081';
function client(name) {
  const ws = new WebSocket(URL, { origin: ORIGIN }); const log = [];
  ws.on('message', (raw) => {
    const f = JSON.parse(raw); log.push(f.type);
    if (f.type === 'connected') ws.send(JSON.stringify({ type: 'join_queue', version: 1, payload: {} }));
    if (f.type === 'matched') ws.send(JSON.stringify({ type: 'message', version: 1, id: `c_${name}`, payload: { text: `hello from ${name}` } }));
    if (f.type === 'message') log.push(`RECEIVED: ${f.payload.text}`);
  });
  return { ws, log };
}
const a = client('A'), b = client('B');
setTimeout(() => { console.log('A:', a.log.join(' -> ')); console.log('B:', b.log.join(' -> ')); process.exit(0); }, 3000);
EOF
node tc.tmp.js; rm -f tc.tmp.js; cd ..
```

---

## 12. Things that look broken and are not

**`/metrics` returns 404 through the browser.** Correct. nginx refuses it; the
scrape happens on the private network.

**`/ready` is 503 but `/health` is 200.** Redis is unreachable. The process is
fine, its dependency is not — that is exactly the distinction the two endpoints
exist to draw.

**`migrate` shows `Exited (0)`.** It is a one-shot job. Success.

**Everything returns `SESSION_GONE`, sockets close with 4001.** Redis restarted
or was flushed. Persistence is off on purpose (D12), and a resume token is
stored only as a hash in Redis, so every session and every token dies with it.
Clients fall back to a fresh session, which is the designed answer to a token
that cannot be redeemed.

**A partner shows as "reconnecting" instead of gone.** Correct since §28 (D42):
a dropped socket no longer ends a conversation. The seat is held for
`RESUME_GRACE_SECONDS` (20 by default), the partner is told
`partner_reconnecting`, and a browser that comes back with its token lands in
the same conversation. Messages sent during the gap are **not** delivered and
not buffered — buffering them would write message text to a Redis key (I8), so
the composer is disabled instead. `RESUME_GRACE_SECONDS=0` restores the old
behaviour, and it is a supported configuration with tests on it.

**You cannot match after testing Block.** Blocks last 30 days and key on both
your address hash and your token hash. `npm run unblock`.

**Two tabs in one browser stop matching after a Block.** Same cause — they share
both hashes, so blocking your partner blocks your own browser.

**`NOT_MATCHED` when sending.** The partner skipped or left in the instant
before the send. A refusal, not an error.

**`DUPLICATE_MESSAGE` on a retry.** Replay protection. The first copy was
delivered.

**A `pg` error logs as a code with no detail.** Deliberate. Driver errors echo
the parameters of the failing statement, and those parameters are message
bodies.

**Rows appear in PostgreSQL about a second after sending.** The retention path
is write-behind. Chat never waits on the database.

**The spool is filling and `chat_db_breaker_state` is 1 or 2.** The instance
cannot write to PostgreSQL. Chat is unaffected — that is what write-behind is
for — but retention has stopped on that instance. Check what it is actually
dialling, from inside it:

```bash
docker exec karobakbak-dev-backend-1 printenv DATABASE_URL   # expect @postgres:5432 (karobakbak-live-backend-1 in production)
docker exec karobakbak-dev-backend-1 node -e "
const {Pool}=require('pg');
const p=new Pool({connectionString:process.env.DATABASE_URL});
p.query('select 1').then(()=>{console.log('ok');return p.end();})
 .catch(e=>{console.log('FAILED', e.code||e.name); for (const c of e.errors ?? []) console.log(' ', c.code, c.address, c.port);});"
```

`ECONNREFUSED 127.0.0.1` means it is pointed at `localhost`, which inside a
container is the container itself. Historically this came from a `.env` copied
from `.env.example`, whose values describe running the backend *outside* Docker.
Compose now fixes `DATABASE_URL` for exactly that reason.

**Grafana panels say "no data".** Check Prometheus targets are `up` first.

**nginx returns 502 after recreating the backends.** It resolved their addresses
earlier. `docker compose restart frontend`.

**`chat_retention_dropped_total` is missing from `/metrics`.** Labelled counters
only appear once incremented. Missing means nothing has been dropped, which is
what you want.

---

## 13. The moderation console

Its own process, its own port, its own database role, **off by default**. Never
proxied by the public edge — reach it through a tunnel.

```bash
cd backend

# create an operator. Password in the environment, never argv: arguments are
# visible in `ps` to every other user on the host.
ADMIN_PASSWORD='...' npm run console:create -- alice

# it prints the TOTP secret ONCE. There is no way to see it again; a lost
# secret means deleting the account and making another.

ADMIN_CONSOLE_ENABLED=true npm run console

# from a laptop, without publishing the port
ssh -L 8088:127.0.0.1:8088 <host>
```

The console needs its schema, so a stack that predates phase 13 must migrate
before an account can be created:

```bash
docker compose run --rm migrate
```

Two roles exist after that migration, and neither can do the other's job:

```bash
# what the chat backend may touch (no admin_accounts at all)
npm run psql -- -c "select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'karobakbak_app' order by table_name;"

# what the console may touch (select on conversations, never delete)
npm run psql -- -c "select table_name, privilege_type
  from information_schema.role_table_grants
 where grantee = 'karobakbak_console' order by table_name;"
```

### Reading the audit log

Every disclosure and every decision is a row, and `admin_audit` outlives the
content it describes (365 days by default against 30 for a conversation).

```bash
# who read what, why, and when
npm run psql -- -c "select created_at, actor, action, case_id, justification
  from admin_audit order by created_at desc limit 20;"

# everything one operator did
npm run psql -- -c "select created_at, action, subject_id, justification
  from admin_audit where actor = 'adm_...' order by created_at;"
```

Neither role can `update` or `delete` this table — the grant enforces it, so an
audit row cannot be rewritten by the process that wrote it.

### Sanctions

Live bans, and what they attach to:

```bash
npm run psql -- -c "select enforcement_id, subject_key, action, source,
       created_at, expires_at, revoked_at, revoked_by
  from enforcement order by created_at desc limit 20;"

# the cached copy the upgrade path actually reads
npm run redis-cli -- --scan --pattern 'chat:ban:*'

# what a specific key resolves to: the value is the enforcement row id
npm run redis-cli -- get 'chat:ban:<hash>'
```

**If a ban is in PostgreSQL but not in Redis**, that is expected shortly after a
Redis restart and fixes itself within `ENFORCEMENT_RELOAD_INTERVAL_MS` (default
five minutes). Redis has persistence off by design, so the database is the
source of truth and every instance replays live sanctions on an interval. If it
does *not* fix itself, the chat instances cannot reach the database — look
there, not at Redis.

**If `revoked_by` says `system:apply_failed`**, the decision committed and the
Redis write did not, so the row was withdrawn to keep the record honest. The
operator saw a failure and needs to press the button again.

### Lifting a ban

Through the console, so the revocation is audited. Directly in SQL only in an
emergency, and it leaves no audit row and no Redis change:

```bash
# emergency only — also delete the cached key, or it stays enforced until it expires
npm run psql -- -c "update enforcement set revoked_at = now(),
       revoked_by = 'manual' where enforcement_id like 'enf_...%';"
npm run redis-cli -- del 'chat:ban:<hash>'
```

### Turning it off

`ENFORCEMENT_ENABLED=false` stops ban keys being read *or* written, without
touching the rows. That is the switch if the check ever misfires at the edge —
existing sanctions stop being enforced and stay on record.

---

## Where else to look

| File | What |
|---|---|
| [`RUNNING.md`](./RUNNING.md) | setup, configuration, troubleshooting, the §22 checklist |
| [`DESIGN.md`](../../DESIGN.md) | the contract — invariants, protocol, data model, concurrency analysis |
| [`.env.example`](../../.env.example) | every variable, documented, with its reasoning |
| [`PHASES.md`](../../PHASES.md) | what is built and what is deferred behind which trigger |
| [`docs/PROGRESS.md`](../PROGRESS.md) | what changed each phase, what broke, and why |

---

## 14. AI personas

> **Off by default, and off twice.** `PERSONAS_ENABLED` decides whether the
> process starts; the `persona_control` table decides whether anything may
> join, and it ships **disabled**. Turning personas on takes a deployment
> change *and* a deliberate, audited act. That is the right weight for a
> feature that spends money per message.

Personas are optional automated conversation partners. A guard layer enforces
their limits on every reply, a monthly spend cap bounds what they cost, and a
persona never claims to be human. Extra guard terms can be supplied through
`PERSONA_GUARD_TERMS_FILE` (template: `ops/personas/guard-terms.example.json`).

### See it working in five minutes, spending nothing

```bash
npm run up                # the usual stack
npm run personas          # start the persona service (its own container)
npm run personas:on       # flip the durable switch on
```

Then open **http://localhost:8081**, accept the age gate, and press start. With
no other person waiting, a persona joins.

**With no `PERSONA_API_KEY` set, personas run on the scripted voice.** They hold
real conversations, exercise the fill policy, the control plane, the safety
limits and the console, and cost exactly nothing. That is a supported mode, not
a broken one: it is the same fallback production uses when the spend ceiling is
reached or a provider is down, and it is the right way to see the system work
before deciding to pay for it.


### Turning it off

```bash
npm run personas:off      # drain: no new joins, live conversations finish
npm run personas:down     # stop the container entirely
```

`personas:off` **drains rather than cuts**. Ending a live conversation
mid-sentence looks like a bug to the person on the other end. A hard stop
exists for when that is the point:

```bash
npm run psql -- -c "update persona_control set enabled=false, mode='hard', updated_by='operator' where scope='global';"
```

The switch lives in PostgreSQL and is cached in Redis, so **it survives a Redis
restart** — a flag stored only in Redis dies with it (persistence is off, D12)
and personas would silently turn themselves back on.

### What is running, and what it has done

```bash
npm run personas:status   # the control switches, and the last ten conversations
npm run personas:logs     # follow the service
```

```
 scope  | subject | enabled | mode  | updated_by |     reason
--------+---------+---------+-------+------------+-----------------
 global |         | t       | drain | operator   | enabled locally

    persona_id    | replies | cost_micro_cents | flagged | limits_tripped
------------------+---------+------------------+---------+----------------
 nadia-nightshift |       4 |                0 | f       | {identity}
```

`limits_tripped` names which of the guard layer's limits fired for that
conversation. `cost_micro_cents` is zero because no model was configured.

### The levers, individually

Four, and they compose. Global is the panic switch; the others are for when one
thing is misbehaving and the rest is fine.

```bash
# one character only, leaving the rest running
npm run psql -- -c "insert into persona_control (scope,subject,enabled,updated_by,reason) values ('character','marco-forward',false,'operator','too forward') on conflict (scope,subject) do update set enabled=false;"

# one vendor, for an outage or a price change
npm run psql -- -c "insert into persona_control (scope,subject,enabled,updated_by,reason) values ('provider','anthropic',false,'operator','vendor outage') on conflict (scope,subject) do update set enabled=false;"
```

**The chat backend cannot turn personas on.** It has `select` on
`persona_control` and nothing else, so a compromised chat process cannot enable
a feature that spends money. Verified in `tests/integration/storage.test.ts`.

### Adding a model, and what it costs

Two adapters ship. **One runs at a time** — `PERSONA_PROVIDER` picks it, and it
must match the key and the model:

```bash
# Anthropic (the default)
PERSONA_API_KEY=sk-ant-... npm run personas

# OpenAI
PERSONA_PROVIDER=openai PERSONA_MODEL=gpt-5-mini PERSONA_API_KEY=sk-proj-... npm run personas
```

Put them in `.env` at the repo root instead if you are using `npm run up` — it
is gitignored, and `docker-compose.yml` passes all three through.

`loadConfig` refuses to start on a mismatched trio, because every mismatch fails
quietly at runtime rather than loudly at boot:

| What is wrong | What would happen without the check |
|---|---|
| Unknown `PERSONA_PROVIDER` | Whichever adapter the wiring constructs first, silently |
| One vendor's model id against the other's key | Authenticates fine, then fails **every** call — and the scripted fallback turns that into weeks of unhelpful conversations with nothing in the logs saying why |
| A model with no row in `MODEL_PRICES` | Spend is recorded as zero, so `PERSONA_MONTHLY_LIMIT_MICRO_CENTS` never binds |

Models each provider will accept are listed in `PROVIDER_MODELS`
(`backend/src/personas/provider.ts`). Adding one means adding its **published**
rates to `MODEL_PRICES` in the same commit — the price table is what the ceiling
is made of.

**Adding a vendor is a policy change before it is a config change** (D-AI-10).
The Privacy Policy names the model provider individually, as
`{{MODEL_PROVIDER}}`, and requires terms that forbid training on what is sent.
Switching from one to the other means changing that variable; running both at
once would mean two rows and a 14-day notice.

Costs below are Anthropic first-party rates. **Nothing about them transfers to
another vendor** — the caching model differs in kind, not only in price: OpenAI
caches implicitly on an exact prefix match and charges nothing to write the
cache, Anthropic takes an explicit breakpoint and charges a premium for it.
Re-measure rather than scaling a number across.

The monthly ceiling is enforced in code, not by an alert:

```bash
# what has been spent this month, against the ceiling
npm run psql -- -c "select period, spent_micro_cents, limit_micro_cents, exhausted_at from persona_spend;"

# set it deliberately: 500000000 micro-cents is 5 US dollars (the code default
# in backend/src/config.ts is 2 US dollars; .env.example explains the units)
PERSONA_MONTHLY_LIMIT_MICRO_CENTS=500000000 npm run personas
```

The check runs **before** every model call and **fails closed**: if the spend
cannot be read, no call is made. When the ceiling is reached personas fall back
to the scripted voice rather than going silent.

The persona process can add to the counter and **cannot raise its own ceiling**
— that is a column-level grant, and a process that can raise its own limit does
not have one.

### Metrics

The persona service exposes its own scrape endpoint on **:8090**, and
Prometheus has a `karobakbak-personas` job for it. The target is down on any
deployment that has not started the service, which is correct rather than a gap.

```bash
# from inside the container, where it is served
docker compose exec personas node -e "fetch('http://127.0.0.1:8090/metrics').then(r=>r.text()).then(t=>console.log(t.split('\n').filter(l=>l.startsWith('chat_persona')).join('\n')))"

# the six safety limits, from Prometheus
curl -s 'http://localhost:9090/api/v1/query?query=chat_persona_limit_trips_total'

# why the fill policy is not dispatching
curl -s 'http://localhost:9090/api/v1/query?query=chat_persona_fill_suppressed_total'
```

`chat_persona_fill_suppressed_total` is the one to look at when personas are
enabled and nothing turns up. Every reason is zero-initialised, so a flat line
at zero means "this reason has not happened", not "no data" — the two look
identical on a graph and mean very different things.

Common reasons, and none of them is a fault:

| Reason | Meaning |
|---|---|
| `humans_available` | Two or more real people are waiting. **A persona must never take a conversation a human was going to have with another human**, so it stays out |
| `disabled` | The control switch is off |
| `at_capacity` | `PERSONA_MAX_CONCURRENT` reached |
| `queue_unreadable` | Redis did not answer. The policy refuses to dispatch into an unknown queue rather than guessing |

The remaining reasons are pacing controls; the full list is in
`backend/src/personas/supervisor.ts`.

### Nothing here carries message content

No metric label and no metric value contains a word anybody typed, and none can
— rule 1 names Prometheus labels *and values* explicitly. The live persona feed
that everybody asks for **cannot be built** on this side.

What a persona actually said is read through the moderation console, and every
read is audited exactly as a reported conversation is. Persona conversations are
browsable **without a report**, unlike every other conversation (D-AI-12), which
makes that audit trail the only remaining control:

```bash
# who has read what
npm run psql -- -c "select created_at, actor, action, left(subject_id,14) subject, justification from admin_audit where action='viewed_persona_conversation' order by created_at desc limit 20;"
```

### Reading them in the console

The console has a **Personas** tab beside Reports. It shows the spend against
the ceiling, the enable/disable switch, and the conversations — flagged first,
because a flagged one is where a minor signal or a crisis fired and is the only
kind that needs a person.

```bash
cd backend
ADMIN_CONSOLE_ENABLED=true npm run console          # http://localhost:8088
```

Opening a conversation asks for a reason, exactly as a reported one does, and
writes the audit row **before** a single message is fetched. Unlike a report,
nothing gates the open — that is D-AI-12, and it is why the reason box is still
mandatory: with no report in the way, the audit trail is the only remaining
control on reading a stranger's messages.

```bash
# who has read what
npm run psql -- -c "select created_at, actor, action, left(subject_id,14) subject, justification from admin_audit where action='viewed_persona_conversation' order by created_at desc limit 20;"
```

The switch sits beside the spend figure on the same screen, deliberately. The
decision to turn personas off is usually made *because* of a number, and putting
the number and the switch in different places is how the switch gets found late.
Disabling drains by default; the hard stop is a separate button and says what it
does.

### Alerts

Eight rules in `monitoring/prometheus/alerts.yml`, all validated by `promtool`.
Two are deliberately unusual:

* **`PersonaCrisisHandled` pages.** Not because anything is broken — a persona
  broke character and gave helpline numbers, which is what it is built to do —
  but because a person should know it happened.
* **`PersonaNeverCachingPrefix`** fires on zero cache reads against real input
  volume. The stable/volatile prompt split has **no error case**: if it breaks,
  the bill is several times larger and nothing else says so.

### Before this reaches production

1. **Update the Terms and the Privacy Policy first.** They must describe
   automated conversation partners before one joins. It is a **material
   change** under both documents, so the 14-day in-product notice runs *before*
   personas ship, not after.
2. **Check `PERSONA_MAX_CONCURRENT` is below `MAX_CONNECTIONS_PER_IP`.** Every
   persona connects from the same address and they share one connection bucket;
   `assertCoherent` refuses to start rather than letting it fail silently as
   refused connections.
3. **Set the ceiling to a number you are willing to pay**, and know that
   reaching it is a degraded experience rather than an outage.

---

## 15. Load testing with the swarm

`load-test/swarm/` runs a population of scripted strangers against the load
stack and then **judges** the result. It is not a throughput tool: a run ends
with seven oracles, and any one of them failing exits non-zero.

Read `docs/testing/SWARM-HANDOFF.md` before changing anything in there — it carries the
traps that have each already cost a red run. `docs/testing/LOADTEST-SCENARIOS.md` is the
catalogue of what the personas are for.

### 14.1 Setup, once

```bash
npm run swarm:install            # installs load-test/swarm
npm run swarm:typecheck          # the package has its own tsc
```

The stack comes up automatically on the first run. It uses `.env.loadtest`
(copied from `.env.loadtest.example` on first use) and the compose project
`karobakbak-loadtest`, so load traffic never reaches the development database.

| | Development | Load test |
|---|---|---|
| Frontend | http://localhost:8081 | http://localhost:8090 |
| Grafana | http://localhost:3000 | **http://localhost:3002** |
| Prometheus | http://localhost:9090 | **http://localhost:9092** |
| PostgreSQL | 127.0.0.1:5434 | 127.0.0.1:5435 |
| Redis | 127.0.0.1:6381 | 127.0.0.1:6382 |

Both Grafana instances serve the same provisioned dashboard, **karobakbak —
overview**, admin / admin.

### 14.2 The command

```bash
npm run swarm -- --bots 1000 --duration 300 --profile realistic \
  --redis      karobakbak-loadtest-redis-1 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2
```

`npm run swarm` brings the stack up first. **Pass the three container flags every
time**: without `--metrics` the conservation oracle is skipped, without `--redis`
the residue oracle is skipped, and without `--containers` the log-leak oracle —
the only end-to-end check of invariant I8 — is skipped. A run missing them still
prints PASS, and the report lists every `SKIP`, which is the only reason that is
survivable.

| Flag | Default | What it does |
|---|---|---|
| `--bots` | 500 | Population size |
| `--duration` | 120 | Seconds of traffic after the ramp |
| `--ramp` | `min(60, bots/100)` | Seconds over which sockets open |
| `--profile` | `realistic` | Which mix (see below) |
| `--seed` | clock | Reproduces a run exactly, personas and addresses included |
| `--workers` | `min(cpus, bots/1000)` | Load-generator processes |
| `--settle` | 40 | Seconds waited before the second metrics scrape |
| `--url` | `ws://localhost:8090/ws` | Target |
| `--origin` | `http://localhost:8090` | Must be in `ALLOWED_ORIGINS` |
| `--out` | `load-test/swarm/runs` | Where the ledger and report land |
| `--redis` | — | Redis container, for the residue oracle |
| `--metrics` | — | Backend containers to scrape |
| `--containers` | — | Backend containers whose logs are searched |
| `--key-prefix` | `chat` | Must match `REDIS_KEY_PREFIX` |
| `--segment` | `default` | Must match the matchmaking segment |
| `--human` | off | States in the report that a person took part |

### 14.3 Profiles

| Profile | Population | Use it for |
|---|---|---|
| `realistic` | talkers dominate, skippers a large minority, a little spam | The default, and the **only** latency numbers worth quoting |
| `adversarial` | a third abusive, an eighth reacting to it | Safety numbers. Match latency is worse, correctly |
| `capacity` | talkers and grazers only, nothing disconnects | Throughput, when the question is "how many conversations can this hold" |
| `lifecycle` | connection churn, resumption, cookie loss | Cleanup, leaked sessions, section 28 |
| `human` | prompt repliers, heavy declared profiles, a little spam | A person joining through a browser. **Not** a measurement profile |
| `tiny` | two personas | Scenario S9 — run it with `--bots 2` |

### 14.4 The three runs

Every one of these assumes a clean start:

```bash
npm run unblock:loadtest         # blocks last 30 days and reshape the next run
```

**1,000 bots — the baseline.** Comfortable on this machine, and the run every
other number should be compared against.

```bash
npm run swarm -- --bots 1000 --duration 300 --profile realistic --seed 1000 \
  --redis      karobakbak-loadtest-redis-1 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2
```

Measured here: harness event-loop lag p99 **23 ms**, message ack p50 4 ms /
p95 49 ms / p99 52 ms, time to match p50 7 ms / p95 51 ms / p99 84 ms, delivery
split roughly evenly between `local` and `remote` across two replicas.

**5,000 bots.** More workers, a longer ramp, and a scaled backend.

```bash
docker compose --env-file .env.loadtest -p karobakbak-loadtest up -d --scale backend=3

npm --prefix load-test/swarm run swarm -- --bots 5000 --duration 300 --ramp 60 \
  --workers 6 --profile realistic --seed 5000 \
  --redis      karobakbak-loadtest-redis-1 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2,karobakbak-loadtest-backend-3 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2,karobakbak-loadtest-backend-3
```

**The second command is deliberately not `npm run swarm`.** That script runs
`loadtest:up` first, and `up` without `--scale` puts the replica count back to
the two in `docker-compose.yml` — silently undoing the line above. Once you have
scaled by hand, invoke the swarm package directly.

**10,000 bots.** Untried on this machine; the ceiling in 14.5 is arithmetic
rather than experience. Expect the **load generator** to bind before the server
does.

```bash
docker compose --env-file .env.loadtest -p karobakbak-loadtest up -d --scale backend=4

npm --prefix load-test/swarm run swarm -- --bots 10000 --duration 300 --ramp 120 \
  --workers 10 --profile capacity --seed 10000 \
  --redis      karobakbak-loadtest-redis-1 \
  --metrics    karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2,karobakbak-loadtest-backend-3,karobakbak-loadtest-backend-4 \
  --containers karobakbak-loadtest-backend-1,karobakbak-loadtest-backend-2,karobakbak-loadtest-backend-3,karobakbak-loadtest-backend-4
```

`capacity` is deliberate at this size: nothing in it disconnects unexpectedly,
so the numbers describe throughput rather than a mixture of throughput and
recovery. Run `realistic` at 10k as well, but read the two as different
experiments rather than as one number that moved.

### 14.5 What actually limits a big run here

Work down this list before concluding the server is the bottleneck.

**1. Ephemeral ports on the host — the first wall at 10k.** Every bot socket is
an outbound connection to one address and port, and this machine has 16,384
ephemeral ports (49152–65535). 10,000 concurrent bots is 61% of the range before
any churn, and the reconnecting personas hand ports back to `TIME_WAIT` rather
than to the pool.

```powershell
netsh int ipv4 show dynamicport tcp                       # the range
(Get-NetTCPConnection -State TimeWait).Count              # how much is parked

# widen it (needs an elevated shell; survives a reboot)
netsh int ipv4 set dynamicport tcp start=10000 num=55000
```

A run that hits this shows connection failures from the **generator** while
`chat_connections_rejected_total` stays flat — the bots never reached the
server, so the server has nothing to report.

**2. The load generator's own event loop.** The report **withholds** latency
percentiles when the generator's lag p99 exceeds 100 ms, because a generator
that stalled cannot tell its own delay from the server's. Add workers or remove
bots. The run is not failed; it simply is not a capacity number.

This host has 12 cores and Docker holds 8 of them, so generator workers and the
stack compete for the same silicon. `--workers 10` at 10k bots is already
oversubscribed — treat a withheld latency block as the machine saying the
measurement belongs on two hosts.

**3. Backend replicas.** Two by default, which is a correctness choice — it
proves cross-instance matchmaking — rather than a capacity one. Scale to 3–4 for
5k–10k, and remember that every extra replica must be named in `--metrics` and
`--containers` or its share of the run is invisible to the oracles.

```bash
docker compose --env-file .env.loadtest -p karobakbak-loadtest ps backend
```

**4. The edge.** `NGINX_WORKER_CONNECTIONS=32768` in `.env.loadtest`, and a
proxied WebSocket costs **two** connections, one downstream and one upstream. At
`worker_processes auto` that is far above 10k; the stock 1024 would have capped
it at 512 **people** per worker, which is 256 conversations — a conversation is
two of them. Refused upgrades that look like a backend fault are usually this.

**5. Synthetic addresses.** Bots draw from 198.18.0.0/15 (RFC 2544), which is
131,072 addresses, so uniqueness holds well past any run this generator can
produce. It is not cosmetic: blocks key on an address hash, so a swarm sharing
one address writes that address into its own block set the first time any bot
blocks anyone — after which `tryMatch` refuses every pair in the run and
matching silently stops.

**6. Per-IP limits stay at their shipped defaults.** `CONN_RATE_LIMIT` and
`MAX_CONNECTIONS_PER_IP` (defaults in `backend/src/config.ts` and
`.env.example`) are per address, and every bot has its own, so they do not
bind. That is the point: the run measures the product people actually get
rather than a disarmed version of it. Raise them only for a scenario that
deliberately shares an address (L7's herd), and say so in the run notes, because
the numbers then mean something different.

### 14.6 Reading the verdict

```bash
ls -t load-test/swarm/runs | head -3
cat "load-test/swarm/runs/<run-id>/report.txt"
```

`report.json` beside it is the same content for a script. The NDJSON ledgers are
one per worker, and they hold **hashes, never message text**.

| Oracle | Fails when |
|---|---|
| pair reconstruction | A message arrived that the sender was never acked for, arrived twice, arrived out of order, or arrived in a conversation the bot was never in |
| profile agreement | A declared profile is not what the server echoed back, or not what the partner was shown |
| metric conservation | Server counters disagree with each other or with the ledger beyond tolerance |
| redis residue | Queue entries pointing at dead sessions, or `user_match` keys outnumbering matches |
| spam detection and block durability | A pair matched again after a **confirmed** block (D18). The false-positive count is reported, never gated |
| log leak (I8) | Any corpus line appears in a backend log |
| database agreement | Not implemented — prints `SKIP` in every run rather than being silently absent |

Exit code is non-zero if any oracle failed **or a worker died**. A dead worker
matters more than it looks: a truncated ledger is a smaller, self-consistent
population that passes everything.

### 14.7 What to watch in Grafana during a run

Open **http://localhost:3002** and pick *karobakbak — overview*. Set the range to
`Last 15 minutes` and refresh to `10s`. Panels are grouped by row.

#### Row: Conversations

| Panel or series | Healthy | What a problem looks like |
|---|---|---|
| `connected` — `sum(chat_connections_active)` | Rises through the ramp, then flat at roughly the bot count | Flat *below* the bot count means bots never arrived — check ephemeral ports first. Sagging mid-run means sockets are being lost |
| `conversations` — `max(chat_active_matches)` | Roughly half the connected count once matched up, and steady | Falling while `connected` holds means matches end and do not re-form |
| `waiting` — `max(chat_queue_depth)` | Small and noisy, near zero | **Growing monotonically is the alarm.** Matching is not keeping up, or the queue holds entries whose sessions are gone |
| Message throughput | Received tracks delivered; rejected near zero | A gap between received and delivered is withheld moderation, which the report also counts |
| Matchmaking latency p50/p95 | Tens of milliseconds | Dominated by *who else is waiting*, not by server speed. A spike when the population is thin is normal, not a regression |
| Refusals — `chat_connections_rejected_total{reason}` | Zero | `origin` means a browser was turned away — bots always send a matching Origin, so any value there is a person. `rate_limited` and `too_many_connections` mean the per-IP limits bound, expected only when bots share an address |

Both cluster gauges — `chat_active_matches` and `chat_queue_depth` — are written
only by whichever instance holds the janitor's leader lock, so the follower's
copy is frozen at whatever it last held. The dashboard uses `max()` for exactly
that reason. **Never sum them**: summing adds a live value to a stale one and
invents a leak.

#### Row: Safety

| Panel | Healthy | Watch for |
|---|---|---|
| Reports, blocks and moderation | Non-zero on `adversarial`, near zero on `capacity` | `chat_moderation_flags_total{action="block"}` only moves when `MODERATION_HARD_BLOCK_RULES` is set, and `.env.loadtest` sets it so the withhold path has traffic at all |

#### Row: Retention — the row that matters under load

| Panel | Healthy | Watch for |
|---|---|---|
| Write-behind queue by class | Rises with load, drains continuously | **Monotonic growth is the failure.** The queue is bounded, and once full it sheds |
| Dropped records | **Zero** | Anything here is retained evidence the system decided not to keep. Lossy under overflow is by design (D16), which is precisely why the count must be read rather than assumed |
| Database circuit breaker | 0, closed | 1 open, 2 half-open. Open means chat is fine and the database is not — the design working (D16) — and the spool is now filling |
| Outage spool | Zero records | Accumulation means the breaker is open. It is bounded outage tolerance, **not durable storage** (D28): a host failure loses it |
| Rows deleted by retention | Non-zero over a long run | A flat line with data in the database means expiry is not being enforced (I10) |

#### Row: Sessions, resumption and profiles

| Panel | Healthy | Watch for |
|---|---|---|
| Reconnections that kept their conversation | `ok` dominates | A high `expired` ratio means `RESUME_GRACE_SECONDS` is shorter than the reconnections people actually make, and **every one of those was a conversation that ended when it did not have to** |
| Declared profiles refused | Near zero on `realistic` | `name_moderation` rises on `adversarial`, where the G3 persona earns it. `age_below_minimum` is a minor-safety signal and a count only — never who, never what age |
| Delivery latency | p95 in the tens of milliseconds | `remote` crossed Redis Pub/Sub to another instance; both routes are normal (D9). A widening gap between `local` and `remote` is the fan-out getting expensive |
| Enforcement | Zero unless the console is used | Bans applied and lifted. Distinct from blocks — a block is one user refusing one peer, a ban is absolute and read at the upgrade |

#### Row: Process

| Panel | Healthy | Watch for |
|---|---|---|
| Event-loop lag p99 | Low and flat, per instance | **The first thing to move when a socket fan-out costs more than it should.** One instance lagging while its twin does not means load is not spread |
| Resident memory | Flat after the ramp | Monotonic growth across a long run is a leak, and this is the panel that shows it. `--profile capacity --duration 3600` is the way to look for one properly |

#### The four numbers worth writing down after every run

1. `sum(chat_connections_active)` at plateau — did the population actually arrive?
2. `max(chat_active_matches)` at plateau — capacity in conversations, which is
   the unit this product is really sized in.
3. Delivery latency p95, `local` and `remote` separately.
4. Event-loop lag p99, the server's **and** the harness's. If either is high,
   the other three are not capacity numbers.

### 14.8 Prometheus queries for a run

Against the load stack on **:9092**:

```bash
lq() { curl -s --get http://localhost:9092/api/v1/query --data-urlencode "query=$1" | python -c "
import sys, json
for r in json.load(sys.stdin)['data']['result']:
    m = r['metric']
    label = m.get('reason') or m.get('route') or m.get('outcome') or m.get('class') or ''
    print(m.get('instance','-'), label, r['value'][1])"; }

lq 'sum(chat_connections_active)'
lq 'max(chat_active_matches)'
lq 'max(chat_queue_depth)'
lq 'sum(rate(chat_messages_received_total[1m]))'
lq 'histogram_quantile(0.95, sum by (le, route) (rate(chat_delivery_latency_seconds_bucket[5m])))'
lq 'sum by (outcome) (chat_session_resumes_total)'
lq 'sum by (reason) (chat_profiles_refused_total)'
lq 'sum by (class, reason) (chat_retention_dropped_total)'
lq 'max(chat_db_breaker_state)'
lq 'chat_process_nodejs_eventloop_lag_p99_seconds'
```

Histogram quantiles read `NaN` on an idle stack — `rate()` over a window with no
observations has nothing to interpolate. That is the query being honest, not a
broken metric; it fills in as soon as traffic starts.

Counters are cumulative and the stack survives between runs, so a value here is
"since this container started", never "this run". The report diffs against a
baseline scrape taken before the first socket opens — do the same by hand, or
the previous run's totals become this one's.

### 14.9 Between runs

```bash
npm run unblock:loadtest         # clear blocks and late-block records
```

Blocks live 30 days and a bot's synthetic address comes from its index, so bot
41 is the same person in every run against that stack. A few adversarial runs
leave hundreds of block relationships behind and quietly reshape the next run's
matching. The Redis oracle prints the count so it cannot creep up unnoticed.

Note the `:loadtest` suffix. Plain `npm run unblock` talks to the **development**
project — against a load run it fails outright, or, if the dev stack happens to
be up, clears the wrong database and reports success.

**Check nothing is still running before starting the next run.** A run stopped by
anything other than its own drain used to leave its worker holding every socket
it had; the worker exits on `disconnect` now, but it costs nothing to look:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -match 'worker\.ts|run\.ts' } |
  Select-Object ProcessId, CreationDate
```

Two swarms against one stack match with **each other**, and each run's ledger
then holds conversations whose other half it has never heard of. It presents as
a metric-conservation failure with nothing wrong on the server.

### 14.10 Tearing it down

```bash
npm run loadtest:down            # ⚠️ removes the stack and its volumes
```

Run directories under `load-test/swarm/runs/` survive this, and they are the
evidence — keep the ones attached to a finding.

---

## 16. Running the database somebody else operates

Two notes that belong together, because they are the same question asked from
opposite ends: **how long is PostgreSQL allowed to be away, and what happens to
the writes that pile up while it is.**

Neither is a change to make blindly. Both are decisions with numbers attached,
and the numbers come from settings already in `config.ts`.

### 15.1 The fallback is good; the outage is the thing to shorten

Chaos scenario C1 froze PostgreSQL for ninety seconds under load and chat did
not notice: delivery held at 82.9 msg/s during the outage against 80.5 after it,
and client lag p99 did not move off 23ms across the pause *or* the resume. The
write-behind path did what it exists to do -- 10,830 records went to the spool
and 11,781 came back out of it.

That is the safety net working. It is not a reason to leave the failure
probability where it is.

**A managed PostgreSQL with automatic failover is the highest-leverage change
available here**, and it is a configuration decision rather than an architecture
one. RDS Multi-AZ, Cloud SQL HA and their equivalents turn the common failures
-- host loss, patching, a storage fault -- from an outage that lasts until
somebody notices into a failover that lasts tens of seconds. Self-managed
PostgreSQL on one box has no such story: every one of those events is however
long it takes a human to wake up.

Three things follow that are worth knowing before the bill arrives:

* **It roughly doubles the database cost**, because a standby is a second
  instance. Weigh that against what an unattended multi-hour outage costs, which
  for this product is measured in lost retention -- the evidence for abuse
  reports that arrived while the queue was overflowing.
* **`/ready` already does the right thing.** It reflects Redis, not PostgreSQL,
  so an instance whose database is failing over stays in the load balancer and
  keeps serving chat. That is deliberate (D16) and it is what makes a failover
  invisible rather than a partial outage.
* **It introduces a third-party processor**, which the privacy policy currently
  says does not exist. Adding a managed database means adding a sub-processor
  section before launch, not after.

### 15.2 What that does to the breaker, and why the arithmetic matters

The outage the circuit breaker needs before it opens is not a setting. It is a
product:

```
BREAKER_FAILURE_THRESHOLD  x  DATABASE_STATEMENT_TIMEOUT_MS
        5                            10,000 ms          =  50 seconds
```

The breaker opens on *consecutive* failures, and against a database that is hung
rather than refusing, each failure costs a full statement timeout -- there is
nothing to answer sooner. Until the breaker opens, the outage spool is
unreachable and the retention queue absorbs everything on its own.

This is worth stating plainly because it used to be twice as long and nobody had
noticed. A rollback issued down a connection that had already timed out waited
out the deadline a second time, so each failure cost 20s and the breaker needed
100 seconds of downtime before it could open at all. The first C1 run ended with
the breaker still CLOSED and the queue at 3,320 records (audit F-031).

**So: a managed database with ~30s failover will never reach the breaker**, and
that is the correct outcome. The queue absorbs a 30-second gap comfortably and
the spool is never touched. What matters is that this is a decision rather than
an accident -- if you shorten `DATABASE_STATEMENT_TIMEOUT_MS`, you shorten the
outage the breaker tolerates before spooling, and the two numbers should be set
together.

```bash
# what the breaker is doing right now (0 closed, 1 half-open, 2 open)
lq 'max(chat_db_breaker_state)'

# how much is waiting, and whether the spool has been reached
lq 'sum(chat_retention_queue_depth)'
lq 'sum(chat_spool_writes_total)'
```

### 15.3 The spool is per-instance and does not survive its container

`SPOOL_DIR` is backed by an **anonymous** Docker volume, and that is not an
oversight to be tidied up later. Every backend instance writes its own
`spool.jsonl`; a *named* volume is shared by every replica of a service, so
switching to one would put two writers into a single append-only file. The
comment in `docker-compose.yml` says this, and it is right.

The consequence is that a container replacement discards whatever is spooled.
D28 already scopes the spool as bounded outage tolerance rather than durable
storage, so this is the documented behaviour and not a defect -- but it does
imply an operational rule:

> **Do not deploy while the breaker is open.**

Records only reach the spool when the database is unreachable. `stop()` flushes
the queue to PostgreSQL before it spools the remainder, so a deploy against a
healthy database loses nothing. A deploy *during* a database outage is the one
case that discards evidence, and it is the case where somebody is most likely to
be redeploying in a hurry.

Check before you deploy:

```bash
# both should be 0 before a rolling restart
lq 'max(chat_db_breaker_state)'
lq 'sum(chat_spool_records)'
```

Making the spool survive a container is not a one-line change. Per-replica
subdirectories on a shared named volume would work, but a replaced container
comes back with a new hostname and no claim on the old directory, so it needs an
adoption pass that can decide which orphaned spool belongs to nobody -- and two
instances adopting the same one is worse than losing it. Worth building only if
deploying into an outage stops being avoidable.


---

## 17. Redis failover — the drill

Redis holds every piece of live matchmaking state, and `/ready` is derived from
its health and nothing else — so losing it takes every backend instance out of
the load balancer at once. D13 rules out Cluster and names **replica failover**
as the answer instead. For a long time only the first half of that was true:
the decision was recorded and nothing implemented it.

`REDIS_SENTINELS` and `REDIS_SENTINEL_NAME` are the implementation. ioredis
reaches a Sentinel set through a different constructor shape rather than a
different address, which is why no value of `REDIS_URL` ever produced failover.

### 17.1 Configuring it

```bash
# Unset REDIS_URL. Setting both is refused at startup, on purpose.
REDIS_SENTINELS=10.0.0.11:26379,10.0.0.12:26379,10.0.0.13:26379
REDIS_SENTINEL_NAME=karobakbak

# Only if the nodes require AUTH. They are separate processes with separate
# credentials; passing one where the other belongs connects fine and then fails
# every command.
REDIS_PASSWORD=...
REDIS_SENTINEL_PASSWORD=...
```

Every half-specified combination is a startup failure rather than a fallback:
sentinels without a name, a name without sentinels, both `REDIS_URL` and
sentinels, an address that is not `host:port`. That is the whole safety property
of the feature. A topology that quietly degraded to one node would look
configured, pass every health check, and only reveal itself on the night it was
bought to survive — with nobody able to connect the outage to the setting.

Three Sentinels, not two. Two is the worst possible number: losing either leaves
the other short of a majority, so nothing is ever promoted and the topology is
strictly worse than the single node it replaced. Startup warns below three.

### 17.2 Running the drill

```bash
docker compose -f docker-compose.sentinel.yml up -d
sleep 8

# Quorum formed? Expect the primary's address and num-other-sentinels: 2
docker exec karobakbak-sentinel-1 redis-cli -p 26379 sentinel master karobakbak

# Something to lose
docker exec karobakbak-redis-primary redis-cli set drill:key survived

# Pull the primary out
docker stop karobakbak-redis-primary

# Watch the replica take over
docker exec karobakbak-redis-replica redis-cli role          # -> master
docker exec karobakbak-redis-replica redis-cli get drill:key # -> survived
```

### 17.3 The drill that matters — failover with the application on it

§17.2 proves Redis promotes a replica. It says nothing about what this system
does while that happens, and that is the question D13 was answering: every
matchmaking transition lives in Redis and `/ready` is derived from Redis health
alone, so a promotion takes every backend out of the load balancer at once.

`docker-compose.sentinel-app.yml` puts the application on the Sentinel set.

```bash
npm run sentinel:up          # the whole stack, backend pointed at the sentinels
npm run sentinel:status      # expect flags=master, num-other-sentinels=2

# drive it, and pull the primary out about a third of the way in
npm --prefix load-test/swarm run swarm --   --bots 60 --duration 120 --profile realistic --seed 40   --url ws://localhost:8090/ws --origin http://localhost:8090

npm run sentinel:failover    # docker stop karobakbak-redis-primary
npm run sentinel:status      # ip should now be 172.31.240.12

npm run sentinel:restore     # the old primary rejoins as a replica
npm run sentinel:down
```

**Stop the load-test stack first.** Both publish the same host ports, so the
second one to start silently gets none of them.

### 17.4 What it measured, 2026-09-02

60 bots, 120 seconds, the primary stopped at about 50 seconds in.

| | |
|---|---|
| Sentinel promoted the replica | yes — master moved to `172.31.240.12` |
| Backend restarts | **0**, both instances |
| Redis unavailable for | **~11.2s** (16:24:14.066 → 16:24:25.280) |
| Conversations | 113, **346 message positions agreed** across all of them |
| Conversations reclaimed by resume | 2 |

**Conversations survived a Redis failover.** The pair-reconstruction oracle
compares both sides of every conversation and it passed, which is the claim D13
is making and the first time anything has demonstrated it.

The ~11 seconds is the number to plan around, and it is roughly what the
configuration asks for: `down-after-milliseconds` is 2000, so a primary has to
be unreachable for two seconds before anything is declared down, and the
promotion and the clients' rediscovery follow. During that window `/ready`
reports not-ready on **every** instance simultaneously — which is correct, and
means a load balancer sees the whole service leave and come back rather than one
node failing over.

Two log lines to expect and not be alarmed by, both transient and both followed
by recovery:

```
"redis error" ... "connect ECONNREFUSED 172.31.240.11:6379"
"redis error" ... "All sentinels are unreachable. Retrying from scratch after 10ms."
```

The second reads much worse than it is: it is ioredis during the promotion
window, not a topology that has actually lost quorum.

**The one failure in that run was not Redis.** The profile-agreement oracle
reported 9 of its declarations failing to round-trip, which is the pre-existing
F-037 residual — deterministic per seed, reproduced with filters and tracing
both off, and unrelated to failover.

# And what a client would now be told
docker exec karobakbak-sentinel-1 redis-cli -p 26379 \
  sentinel get-master-addr-by-name karobakbak

docker compose -f docker-compose.sentinel.yml down -v
```

Measured on this rig, 2026-08-31:

| Step | Result |
| --- | --- |
| Promotion | **~3 s** from `docker stop` to the replica reporting `master` |
| Data | `drill:key` intact — the replica already held it in memory |
| Sentinel | reported the new primary's address immediately |
| Old primary restarted | demoted to replica within ~9 s |
| Write to the demoted node | `READONLY You can't write against a read only replica.` |

That last line is the one to notice. `reconnectOnError` in
`backend/src/redis/client.ts` matches on exactly that string, and it was written
before any of this existed — failover handling sitting in a system that could
not fail over. The drill confirms the real message matches.

### 17.4b Does a promotion lose acknowledged writes?

The question §17.4 did not ask. It showed conversations surviving a failover,
which is the product claim — but Redis replication is **asynchronous**, so a
promoted replica can be behind the primary that died, and every session and
match in this system lives in Redis with **persistence off** (D12). There is no
AOF or RDB to recover from; the replica's memory is the only other copy.

Measured by writing sequential keys directly at the master as fast as one
`redis-cli` loop manages (~300/s), killing it mid-write, and counting what
survived the promotion:

| | |
|---|---|
| Writes acknowledged by the master | 6,934 |
| Keys present on the promoted replica | 6,934 |
| **Acknowledged writes lost** | **0** |

At the moment the `info` was read the replica was 5,866 bytes behind
(`master_repl_offset` 1,092,222 against a slave offset of 1,086,356), and it
still lost nothing — because `down-after-milliseconds` is 2000, so the primary
goes on streaming for two seconds after it stops being useful, and the buffer
drains.

**Read that as "zero at this rate on this topology", not as "zero".** This is a
Docker bridge network with sub-millisecond latency and one writer. F-033 says
the replica has to live on a *second machine* for the failover to protect
against anything but a process crash, and on a real network the lag is larger
and loss becomes possible. Redis offers `WAIT` to make a write synchronous; this
application deliberately does not use it, because that would put chat delivery
on the replication path.

### 17.4c Failback, and the window where a returning primary lies

A stopped primary that comes back **advertises `master` for a few seconds**
before Sentinel reconfigures it:

```
t+0s   old primary role: master   (0 slaves)
t+5s   old primary role: slave    of 172.31.240.12
```

No split brain survived, and replication came back online immediately. But
anything that connected **directly** to that node in the window would have
written to a server that was about to be demoted, and those writes would be
discarded by the resync.

That is the argument for `REDIS_SENTINELS` rather than a `REDIS_URL` pointing at
a fixed address, stated as a measurement rather than as a principle: a client
holding an address does not learn about a promotion, and a returning node will
happily accept its writes for several seconds.

### 17.4d Repeated failover

Four transitions in one session, all correct:

1. `.11` → `.12` (primary stopped under load)
2. `.11` returns and is demoted to a replica of `.12`
3. `.12` → `.11` (the new primary stopped)
4. `.12` returns and is demoted to a replica of `.11`

`failover-timeout` is 10s and nothing needed longer. A set that promotes once
and then cannot promote again would look identical to a healthy one until the
second incident.

### 17.5 Two honest limits the drill exposed

**A returning node is briefly a primary again.** The old primary came back
claiming `master` and accepted a write for several seconds before Sentinel
demoted it. That write was **discarded** by the resync — it existed on no node
afterwards. A client following Sentinel has already moved and will not write
there, but anything pointed at the old address directly can lose writes into
that window.

**Sentinel is not free of downtime.** Budget 5–15 seconds of failing commands
per failover. `/ready` goes red, the instance leaves the load balancer, in-flight
commands fail fast because `enableOfflineQueue` is false — which is correct: a
matchmaking transition delivered forty seconds late would match two people who
have both left. Pub/Sub events published during the gap are simply lost, so a
handful of users see a stalled match and press next. The trade is ten seconds
and automatic against thirty minutes and a pager.

### 17.6 The trap that cost the first drill

The rig originally monitored the primary by container name with
`sentinel resolve-hostnames yes`. It formed a quorum, looked entirely correct,
and then **failed over not at all** — forty seconds, quorum satisfied, replica
still a replica. The logs:

```
# Failed to resolve hostname 'redis-primary'
# +tilt #tilt mode entered
```

Stopping a container removes it from Docker's DNS, so the name stops resolving.
Sentinel's lookup blocks, the latency spike reads to Sentinel as its own clock
jumping, and it enters **TILT** — a safety mode where it deliberately stops
acting because it no longer trusts its own timing. It never votes, nothing is
promoted, and the symptom is not an error but silence.

The rig uses static addresses now. The general rule it teaches is worth keeping:
**never give Sentinel a name that disappears together with the thing it names.**

### 17.7 Where the replica has to live

On a **second machine**, or the money buys nothing.

The compose rig above runs every node as a container on one host, which is fine
for a drill and useless as a deployment: the host dying takes the primary, the
replica and all three Sentinels together. It protects against a Redis process
crashing, and the failure that actually takes this service down is the host.

A second small VM, or managed Redis with a standby — which needs the config
change above and no compose change at all. One further note before crossing a
machine boundary: Redis has no password and no TLS in this deployment today,
which is defensible only while it is reachable solely from inside a Docker
network. Replication between hosts is not that, so set `REDIS_PASSWORD` and put
the link on a private network.
