# Karobakbak — Cost Calculation & Feature Rollout Plan

## 1. Purpose

This document defines how to estimate, monitor, and control the cost of running Karobakbak as traffic grows.

The goal is not to produce one fixed "Karobakbak will cost ₹X/month" number.

That number will become wrong as soon as traffic, architecture, provider choices, or moderation requirements change.

Instead, this document provides:

- a cost model;
- formulas;
- traffic scenarios;
- infrastructure tiers;
- feature rollout gates;
- recommendations for what to skip initially;
- thresholds for introducing more expensive services;
- a monthly cost-review process;
- a break-even model;
- a stop-loss model;
- guidance for moving from hobby infrastructure to production infrastructure.

The central principle is:

> Do not pay production-scale costs for production-scale problems before Karobakbak actually has production-scale traffic.

---

# 2. Executive Summary

Karobakbak is a text-only random stranger chat service.

That is economically favorable compared with:

- video chat;
- voice chat;
- image-heavy social platforms;
- livestreaming;
- large media storage systems.

The expensive parts are unlikely to be raw chat message storage.

The main cost drivers will eventually be:

1. compute;
2. Redis / state infrastructure;
3. persistent conversation storage;
4. database backups and storage;
5. bandwidth;
6. moderation/classification;
7. logging/observability;
8. DDoS/WAF/security services;
9. human moderation if required;
10. operational complexity.

The architecture should therefore grow in stages.

Recommended philosophy:

```text
Private testing
    ↓
One modest server
    ↓
Measure real traffic
    ↓
Optimize bottlenecks
    ↓
Separate services only when required
    ↓
Managed infrastructure when operational risk justifies it
    ↓
Horizontal scaling when concurrency requires it
```

---

# 3. Important Cost Principle

Do not confuse:

```text
Maximum theoretical capacity
```

with:

```text
Actual monthly cost
```

A system capable of supporting 100,000 concurrent users may be dramatically more expensive than a system currently serving 100 concurrent users.

Build the latter first.

---

# 4. Cost Categories

Every monthly review should classify spending into these categories.

## 4.1 Compute

Includes:

- Node.js server;
- frontend serving;
- background workers;
- moderation workers;
- scheduled jobs;
- supporting services.

---

## 4.2 Redis

Redis is used for:

- matchmaking queue;
- active session state;
- connection/session metadata;
- rate limiting;
- temporary coordination.

Initially Redis can run on the same machine as the application if the traffic level and reliability requirements permit it.

Do not immediately purchase a separate managed Redis cluster.

---

## 4.3 Persistent Database

Once conversations are intentionally retained, persistent storage becomes a meaningful cost category.

Potential data:

- conversation records;
- messages;
- reports;
- moderation results;
- abuse records;
- audit events;
- user/session metadata.

The key distinction is:

```text
chat transport data
```

versus:

```text
retained application data
```

The latter grows over time.

---

## 4.4 Object Storage

Potential uses:

- backups;
- exports;
- reports;
- moderation evidence where legally appropriate;
- archived logs.

Do not use object storage for ordinary live chat messages unless there is a specific reason.

---

## 4.5 Bandwidth

Text chat has relatively low payload sizes.

However, bandwidth can still increase through:

- WebSocket connections;
- frontend assets;
- API requests;
- observability;
- backups;
- repeated reconnections;
- abuse traffic.

The important variable is not simply user count.

It is:

```text
concurrent users
× messages/user
× average payload size
× connection behavior
```

---

## 4.6 Moderation

This can become one of the largest variable costs if every message is sent to a paid external classifier.

Avoid designing:

```text
Every message
    ↓
External AI API
```

as the default economic model.

Prefer layered filtering:

```text
Message
  ↓
cheap local validation
  ↓
known-bad pattern checks
  ↓
rate/abuse checks
  ↓
only uncertain/high-risk content
  ↓
expensive classifier
```

---

## 4.7 Observability

Costs can include:

- Prometheus storage;
- Grafana;
- logs;
- log retention;
- error tracking;
- external observability platforms.

Initially:

```text
Prometheus + Grafana locally/on the same server
```

is sufficient.

Do not immediately purchase an expensive observability SaaS product.

---

## 4.8 Security

Potential costs:

- Cloudflare;
- WAF;
- DDoS protection;
- bot management;
- security monitoring.

Some protection can be obtained without paying for a premium plan.

Cloudflare currently lists a Free plan at $0/month with CDN, universal SSL, unmetered DDoS protection, and a managed ruleset. Its Pro plan is currently listed at $20/month when billed annually or $25/month monthly. Verify current pricing before committing because provider pricing can change.

---

## 4.9 Domain / Email / Miscellaneous

Include:

- domain renewal;
- transactional email;
- support email;
- DNS;
- uptime monitoring;
- payment fees;
- developer tooling if dedicated to the project.

These are usually small compared with infrastructure, but they should still be tracked.

---

# 5. Recommended Initial Architecture

For early traffic, prefer a simple deployment:

```text
                    Internet
                       │
                       ▼
                 Cloudflare
                       │
                       ▼
              ┌────────────────┐
              │ One VPS / VM   │
              │                │
              │ Node.js        │
              │ Redis          │
              │ Prometheus     │
              │ Grafana        │
              │ Frontend       │
              └────────────────┘
                       │
                       ▼
                Persistent DB
```

Depending on the chosen provider and reliability requirements, the database may initially run on the same VM as well, but a separate persistent database becomes preferable once retained conversation data matters.

The objective is to minimize fixed monthly cost while the product is being validated.

---

# 6. Initial Cost Target

A sensible initial personal budget is:

```text
₹3,000–₹10,000/month
```

depending on:

- provider;
- database strategy;
- traffic;
- moderation provider;
- backups;
- security requirements.

Do not treat this as a guaranteed quote.

It is a planning envelope.

The actual bill should be measured.

---

# 7. Example Low-Traffic Configuration

For development/private testing:

```text
Frontend:
same application/server

Backend:
1 Node.js instance

Redis:
same machine

Prometheus:
same machine

Grafana:
same machine

Database:
small persistent database

Cloudflare:
Free tier initially

Backups:
small object-storage footprint
```

The architecture can remain conceptually production-like without purchasing production-scale infrastructure.

---

# 8. Provider Pricing Reference

Current official provider pricing illustrates why the early architecture can remain inexpensive.

AWS Lightsail currently lists Linux/Unix bundles starting at $3.50/month for 512 MB RAM and going through $5, $10, $20, etc. The listed data-transfer allowances for Mumbai and several Asia-Pacific regions are half the headline allowances shown for some other regions. Verify the exact regional allowance and final price before deployment.

Cloudflare currently lists:

```text
Free: $0/month
Pro: $20/month annually
Pro: $25/month monthly
Business: $200/month annually
Business: $250/month monthly
```

The Free plan already includes important baseline capabilities such as CDN, SSL, DDoS protection, and managed security rules.

AWS RDS PostgreSQL is usage-based and charges for DB instance hours, storage, backups, I/O where applicable, and data transfer. AWS explicitly recommends its pricing calculator for region/instance-specific estimates.

AWS ElastiCache pricing is also usage/configuration dependent. AWS currently states that Valkey can start around $6/month and that serverless/node-based pricing varies by configuration.

These provider examples are references, not recommendations that Karobakbak must use AWS.

---

# 9. Traffic Is More Important Than Registered Users

For cost calculations, distinguish:

```text
Registered users
Monthly active users
Daily active users
Concurrent users
Messages/day
Messages/second
Conversation minutes/day
```

For a WebSocket application:

```text
Concurrent connections
```

is particularly important for compute and connection capacity.

For a retained-message system:

```text
Messages/day
```

is particularly important for storage and moderation.

---

# 10. Traffic Scenario Model

Use scenarios instead of pretending to know future traffic.

## Scenario A — Private / Hobby

```text
MAU: 100–500
DAU: 20–100
Concurrent: 5–30
Messages/day: 1,000–10,000
```

Recommended architecture:

```text
1 modest VM
Redis local
Prometheus/Grafana local
small persistent DB
Cloudflare Free
```

Expected objective:

```text
Minimize cost.
```

Do not buy:

- managed Redis;
- multi-node Kubernetes;
- multiple regions;
- dedicated load balancers;
- expensive logging platforms.

---

# 11. Scenario B — Early Public

```text
MAU: 500–2,000
DAU: 100–500
Concurrent: 20–150
Messages/day: 10,000–100,000
```

Recommended:

```text
1 stronger application server
Redis local or separate depending on memory/load
persistent database
automated backups
Cloudflare
Prometheus/Grafana
basic external uptime monitoring
```

Start measuring:

```text
CPU
RAM
WebSocket count
Redis memory
Redis latency
DB size
DB IOPS/load
network traffic
messages/sec
```

Still avoid unnecessary distributed infrastructure.

---

# 12. Scenario C — Growing Service

```text
MAU: 2,000–10,000
DAU: 500–3,000
Concurrent: 100–1,000
Messages/day: 100,000–1,000,000
```

Now architectural separation may become justified.

Possible:

```text
Cloudflare
    │
    ▼
Load balancer / reverse proxy
    │
    ├── Node.js #1
    ├── Node.js #2
    └── Node.js #3
          │
          ▼
      Redis
          │
          ▼
      PostgreSQL
```

Consider:

- separate Redis;
- separate database;
- horizontal Node.js scaling;
- centralized logs;
- external alerting;
- database backups;
- queue workers.

Do not implement every item automatically.

Measure first.

---

# 13. Scenario D — Significant Public Service

```text
MAU: 10,000–50,000+
Concurrent: 1,000–10,000+
```

At this point:

- single-server Redis becomes risky;
- single Node.js process is insufficient;
- database growth matters;
- abuse traffic becomes economically significant;
- moderation costs become material;
- operational reliability becomes more important.

Potential architecture:

```text
                     Cloudflare
                         │
                         ▼
                   Load Balancer
                         │
             ┌───────────┼───────────┐
             ▼           ▼           ▼
           Node 1      Node 2      Node 3
             │           │           │
             └───────────┼───────────┘
                         ▼
                       Redis
                         │
                         ▼
                    PostgreSQL
                         │
                         ▼
                   Object Storage
```

This is where managed infrastructure becomes much easier to justify.

---

# 14. Feature Rollout Matrix

| Feature | Initial | Trigger to Implement | Reason |
|---|---|---|---|
| Cloudflare Free | YES | Immediately | Baseline DNS/CDN/DDoS/SSL |
| TLS / WSS | YES | Immediately | Mandatory for production |
| Redis matchmaking | YES | Immediately | Core architecture |
| Redis rate limiting | YES | Immediately | Abuse prevention |
| Prometheus | YES | Immediately | Basic metrics |
| Grafana | YES | Immediately | Useful local visualization |
| Local logs | YES | Immediately | Debugging |
| External log platform | NO | When local retention becomes insufficient | Avoid early cost |
| Persistent conversation DB | YES if retaining chats | Before public launch if retention is a stated feature | Required for product requirement |
| Managed Redis | NO | When Redis load/reliability requires separation | Avoid fixed cost |
| Managed PostgreSQL | Preferably later | When retained data/reliability justify it | Operational simplicity |
| DB read replicas | NO | Sustained read bottleneck | Avoid premature complexity |
| Multi-AZ DB | NO | Business-critical availability requirement | Expensive redundancy |
| Load balancer | NO | Multiple backend instances needed | No reason with one server |
| Multiple Node.js instances | NO | CPU/memory/concurrency bottleneck | Horizontal scale |
| Kubernetes | NO | Very high operational complexity | Not justified early |
| Multi-region | NO | Large international latency/availability requirement | Expensive |
| Premium ads system | NO | Meaningful user base | Monetization later |
| Ad network | NO | Retention validated | Don't monetize an unvalidated product |
| AI moderation on every message | NO | Only if economics prove it necessary | Potentially expensive |
| AI escalation layer | MAYBE | When abuse volume requires it | Use selectively |
| Human moderation | NO initially | Reports/traffic justify it | Operational cost |
| Advanced bot detection | MAYBE | Bot abuse becomes material | Introduce when needed |
| Dedicated security platform | NO | Threat/traffic level justifies it | Avoid early spend |
| DDoS/WAF premium plan | NO | Free tier/rules become insufficient | Upgrade based on threat |
| Automated backups | YES | Before public retained data | Protect stored conversations |
| Cross-region backups | NO | Significant data/business value | Add later |
| Data warehouse | NO | Analytics volume justifies it | Not needed early |
| Full event analytics platform | NO | Product scale justifies it | Prometheus + basic metrics initially |

---

# 15. Features That Should Be Implemented Immediately

These should not be deferred merely to save money.

## 15.1 TLS / WSS

Required for production.

Do not launch anonymous chat over insecure WebSockets.

---

## 15.2 Rate Limiting

Implement early.

Abuse traffic can become more expensive than normal traffic.

Rate limiting protects both the service and the budget.

---

## 15.3 Input Size Limits

Implement immediately.

Example:

```text
maximum message length
maximum JSON payload
maximum messages/sec
maximum connection attempts
```

This is both a security and cost-control mechanism.

---

## 15.4 Basic Metrics

Track:

```text
active connections
matches
messages/sec
messages/day
errors
Redis latency
database size
```

You cannot optimize costs without measurements.

---

## 15.5 Automated Backups

If conversations are retained, backups become important.

Do not wait until you have a large database.

---

# 16. Features to Delay

## 16.1 Managed Redis

Do not start with managed Redis unless:

- Redis failure is unacceptable;
- the application server cannot safely host Redis;
- Redis memory/load requires separation;
- you need independent scaling.

Start with:

```text
Redis on same VM
```

if the risk is acceptable.

Move to managed Redis when the cost of an outage or operational burden exceeds the monthly service cost.

---

# 17. Managed Database Timing

A persistent database is different from Redis because retained conversations have durable value.

A good progression:

```text
Development
    ↓
small persistent DB
    ↓
automated backups
    ↓
monitor growth
    ↓
managed DB when reliability/operations justify it
```

Do not immediately buy:

```text
Multi-AZ
read replicas
large provisioned IOPS
```

unless measurements require them.

AWS RDS pricing is affected by instance hours, storage, backups, I/O, and data transfer, so a managed database can have several cost components beyond the headline instance price.

---

# 18. Database Growth Calculation

Assume:

```text
M = messages/day
S = average stored message size
D = retention days
```

Approximate raw message storage:

```text
Storage =
M × S × D
```

Example:

```text
100,000 messages/day
× 500 bytes
× 90 days

= 4.5 GB raw message payload
```

But real database storage is larger because of:

- row overhead;
- indexes;
- metadata;
- conversation IDs;
- timestamps;
- moderation fields;
- MVCC/versioning;
- backups.

Use a multiplier when planning.

For example:

```text
Estimated DB footprint
≈ raw payload × 2–5
```

Use actual measurements once available.

---

# 19. Conversation Retention Is a Cost Lever

If you retain conversations for a fixed period, the retention policy directly affects storage.

Example:

```text
30 days
vs
90 days
vs
365 days
```

Storage scales roughly with:

```text
daily message volume × retention period
```

Therefore retention should be configurable.

Do not store everything forever by default.

---

# 20. Moderation Cost Model

Use:

```text
messages/day
× percentage requiring external moderation
× cost per moderation request
```

Example:

```text
500,000 messages/day
× 5% escalated
= 25,000 external checks/day
```

This can be dramatically cheaper than:

```text
500,000 external checks/day
```

The exact moderation provider pricing should be measured from the selected vendor.

---

# 21. Moderation Architecture for Cost Control

Recommended:

```text
                   Message
                      │
                      ▼
              Schema validation
                      │
                      ▼
               Length/rate checks
                      │
                      ▼
              Local rule checks
                      │
            ┌─────────┴─────────┐
            │                   │
        obvious bad          uncertain
            │                   │
         reject                  ▼
                         external classifier
                                  │
                           ┌──────┴──────┐
                           ▼             ▼
                         safe        suspicious
                           │             │
                        deliver       escalate
```

The percentage reaching the expensive layer should be measurable.

---

# 22. Logging Cost Control

Do not log every message body.

Chat messages are explicitly sensitive application data.

Instead log:

```text
message_received
message_rejected
message_rate_limited
message_moderation_escalated
```

with IDs/metrics rather than full text.

This reduces:

- privacy risk;
- storage;
- log ingestion;
- accidental retention;
- debugging noise.

---

# 23. Prometheus Retention

Prometheus can initially run locally.

Do not retain years of metrics.

Start with something like:

```text
7–30 days
```

depending on disk capacity and usefulness.

Long-term metrics can be introduced later if necessary.

---

# 24. Grafana

Grafana itself does not need to be an expensive managed service initially.

Run:

```text
Prometheus
+
Grafana
```

on the same development/early production environment.

Move them separately when:

- resource usage becomes significant;
- availability requirements increase;
- multiple backend instances need centralized monitoring;
- dashboards become operationally critical.

---

# 25. Cloudflare Strategy

Recommended progression:

## Stage 1

Cloudflare Free.

Use:

- DNS;
- SSL;
- CDN;
- DDoS protection;
- basic security rules.

## Stage 2

Add carefully selected paid features only when needed.

## Stage 3

Upgrade plan only when the incremental security/support value is justified by traffic or risk.

Cloudflare currently lists Pro at $20/month annually or $25/month monthly, so this is a relatively small but still unnecessary cost if the Free plan already meets the project's requirements.

Do not buy Business simply because the project is "production."

---

# 26. Load Balancer Timing

Do not start with:

```text
Cloudflare
→ Load Balancer
→ Node.js #1
```

if there is only one Node.js server.

Start:

```text
Cloudflare
→ Node.js
```

Introduce a load balancer when:

```text
Node.js #2
```

is actually required.

The trigger should be measured:

- CPU;
- memory;
- event-loop latency;
- connection count;
- restart behavior;
- deployment availability requirements.

---

# 27. Horizontal Scaling Trigger

Introduce multiple Node.js instances when one instance cannot reliably handle:

```text
CPU
OR
memory
OR
event-loop latency
OR
connection count
OR
deployment availability
```

Do not scale merely because MAU crossed an arbitrary number.

Traffic thresholds are planning indicators; measured resource pressure is the actual trigger.

---

# 28. Redis Separation Trigger

Separate Redis when:

- Redis memory competes with Node.js;
- Redis CPU becomes significant;
- Redis latency increases;
- Redis restarts affect application availability;
- independent scaling is needed.

Until then:

```text
Node.js + Redis
```

on one server is simpler and cheaper.

---

# 29. Database Separation Trigger

Separate the database when:

- database load affects application performance;
- backups interfere with application resources;
- disk capacity becomes significant;
- database availability requirements increase;
- application and database need independent scaling.

---

# 30. Kubernetes Trigger

Kubernetes should be considered late.

Do not introduce it because:

```text
"We want to be scalable."
```

Introduce it only if the operational benefits justify the complexity.

Potential trigger:

```text
multiple services
+
multiple deployment environments
+
multiple replicas
+
complex scheduling
+
team operational need
```

For a small independent random-chat platform, Kubernetes may remain unnecessary for a long time.

---

# 31. Multi-Region Trigger

Do not deploy multiple regions initially.

Consider it when:

- international traffic becomes significant;
- latency measurements show a real problem;
- a single-region outage is unacceptable;
- the business can support the added operational cost.

Multi-region adds:

- infrastructure;
- replication complexity;
- monitoring;
- deployment complexity;
- data consistency considerations.

---

# 32. Data Warehouse Trigger

Do not introduce:

- BigQuery;
- Snowflake;
- Redshift;
- Databricks;
- a separate analytics warehouse

for basic product metrics.

Use application metrics and a simple relational/event store initially.

A warehouse becomes justified when:

```text
analytics volume
+
complex reporting
+
multiple data sources
```

make the simple approach inadequate.

---

# 33. Cost Scenario Table

These are planning envelopes, not provider quotes.

| Stage | Approx. Traffic | Architecture | Planning Monthly Cost |
|---|---:|---|---:|
| Development | none | local Docker | ₹0 infrastructure |
| Private test | <100 MAU | 1 small VM + local Redis | ₹1k–₹4k |
| Early public | 100–1k MAU | 1 VM + DB + backups | ₹2k–₹8k |
| Growing | 1k–5k MAU | stronger VM + separate DB as needed | ₹5k–₹15k |
| Larger | 5k–20k MAU | multiple app instances + managed/separate services | ₹10k–₹30k+ |
| Significant | 20k–50k+ MAU | horizontally scaled architecture | ₹25k–₹75k+ |
| Large public platform | 50k+ MAU | distributed/managed infrastructure | highly workload-dependent |

These ranges are deliberately broad.

The correct number should come from:

```text
actual traffic
+
actual resource usage
+
actual provider invoices
```

not the table.

---

# 34. Why the Range Gets Wide

Two platforms with identical MAU can have radically different costs.

Example:

```text
Platform A
10,000 MAU
short sessions
few messages
low moderation rate
```

versus:

```text
Platform B
10,000 MAU
long sessions
high message volume
heavy moderation
high abuse traffic
```

Platform B can cost substantially more.

Therefore:

> MAU is a useful business metric but a poor infrastructure billing metric by itself.

---

# 35. Cost-per-User Model

Track:

```text
Monthly infrastructure cost / MAU
```

Example:

```text
₹10,000 / 5,000 MAU
= ₹2 / MAU
```

Also track:

```text
Monthly variable cost / active user
```

and:

```text
Cost / conversation minute
```

The latter may be the most useful for this product.

---

# 36. Cost-per-Conversation-Minute

Calculate:

```text
Total variable operating cost
÷
Total conversation minutes
```

Example:

```text
₹8,000
÷
40,000 conversation minutes

= ₹0.20/minute
```

Then compare against:

```text
advertising revenue / conversation minute
```

This directly answers:

> Does additional usage make or lose money?

---

# 37. Break-Even Example

Suppose:

```text
Monthly operating cost = ₹10,000
Average revenue/MAU = ₹3
Variable cost/MAU = ₹0.50
```

Contribution:

```text
₹3 - ₹0.50
= ₹2.50
```

Break-even:

```text
₹10,000 / ₹2.50
= 4,000 MAU
```

Then add a safety margin.

A practical target might be:

```text
5,000+ MAU
```

rather than exactly 4,000.

---

# 38. Cost Escalation Rule

Before adding a service, answer:

### Question 1

What problem does this solve?

### Question 2

Is the problem happening now?

### Question 3

Can the existing architecture handle it?

### Question 4

What does the new service cost per month?

### Question 5

Does the service reduce another cost or risk?

### Question 6

Can the service be removed easily if traffic does not materialize?

If the answer to Question 2 is "no," defer it.

---

# 39. "Skip for Now" Rules

These are specifically intended to prevent overengineering.

## Skip initially

```text
Kubernetes
Multi-region
Multi-AZ everything
Read replicas
Dedicated load balancer
Managed Redis
Dedicated analytics warehouse
Premium observability SaaS
Dedicated bot-management platform
AI moderation on every message
Human moderation team
Advanced recommendation systems
Complex ad optimization
```

## Implement immediately

```text
TLS/WSS
Rate limiting
Input validation
Redis matchmaking
Basic moderation safeguards
Basic metrics
Error logging
Backups
Cloudflare baseline protection
```

## Introduce when justified

```text
Managed Redis
Multiple Node.js instances
Load balancer
Managed DB
External log platform
Advanced moderation
Premium Cloudflare plan
Human moderation
Premium subscriptions
Advanced analytics
Multi-region
```

---

# 40. Trigger-Based Feature Roadmap

## Trigger: Product has almost no users

Use:

```text
single server
local Redis
local monitoring
```

Do not add distributed architecture.

---

## Trigger: Concurrent users become significant

Measure:

```text
CPU
RAM
event-loop lag
connections
```

If one instance approaches capacity:

```text
add Node.js replica
```

---

## Trigger: Redis becomes a bottleneck

Move Redis to a separate/managed service.

---

## Trigger: Database grows significantly

Introduce:

- managed database;
- stronger backup strategy;
- storage monitoring;
- retention management.

---

## Trigger: Reports become frequent

Introduce:

- moderation queues;
- escalation;
- administrative tooling;
- potentially human review.

---

## Trigger: Moderation API spend becomes significant

Optimize:

```text
local filter → selective external moderation
```

and measure:

```text
cost per 1,000 messages
```

---

## Trigger: Ad revenue becomes meaningful

Introduce:

- controlled ad experiments;
- frequency optimization;
- revenue dashboards;
- premium/no-ad architecture.

---

## Trigger: Revenue consistently exceeds costs

Build:

```text
operating reserve
```

before significantly increasing infrastructure spending.

---

# 41. Monthly Cost Review

Every month record:

```text
Compute:
₹____

Redis:
₹____

Database:
₹____

Storage:
₹____

Bandwidth:
₹____

Moderation:
₹____

Observability:
₹____

Security:
₹____

Email:
₹____

Domain:
₹____

Other:
₹____

----------------
TOTAL:
₹____
```

Then:

```text
Revenue:
₹____

Net:
₹____
```

---

# 42. Cost Anomaly Alerts

Create alerts for unexpected spending.

Examples:

```text
Daily infrastructure cost > expected threshold
```

```text
Database storage growth > expected rate
```

```text
Moderation API requests > expected rate
```

```text
Bandwidth > expected rate
```

```text
Redis memory > 70–80%
```

```text
CPU > sustained threshold
```

```text
Concurrent connections > expected capacity
```

The exact thresholds should be calibrated from normal operation.

---

# 43. Abuse Is Also a Cost Problem

A malicious user can generate:

```text
connections
messages
reports
moderation requests
database writes
```

Therefore security controls have economic value.

Important controls:

```text
connection rate limits
message rate limits
message size limits
IP/network abuse controls
session limits
automatic disconnects
bot detection
```

Do not evaluate security purely as a compliance expense.

It protects the cost model.

---

# 44. Storage Cost Control

Because conversations are retained, define:

```text
retention period
```

and:

```text
deletion policy
```

For example:

```text
90 days
```

could be a planning choice.

The exact retention period should be driven by:

- safety requirements;
- legal requirements;
- privacy policy;
- operational needs;
- storage economics.

Longer retention directly increases storage and backup footprint.

---

# 45. Backup Cost Control

Backups should not be:

```text
unlimited forever
```

Define:

```text
daily backups
retention period
snapshot frequency
disaster-recovery requirements
```

As the service grows, consider:

```text
primary DB
    ↓
automated backups
    ↓
object storage
    ↓
optional cross-region copy
```

Cross-region backup can be delayed until the data/business value justifies it.

---

# 46. Development vs Production Costs

Keep these separate.

## Development

```text
Docker
local Redis
local PostgreSQL
local Prometheus
local Grafana
```

Cost:

```text
₹0 cloud infrastructure
```

## Early production

```text
small VM
Redis
database
Cloudflare
backups
```

Cost:

```text
low monthly fixed cost
```

## Mature production

```text
multiple application nodes
managed Redis
managed DB
load balancing
centralized observability
advanced security
```

Cost:

```text
traffic-dependent
```

Do not pay mature-production costs while still validating the product.

---

# 47. Recommended Initial Stack From a Cost Perspective

A cost-conscious first production version:

```text
Cloudflare Free
        │
        ▼
One Linux VM
        │
        ├── React static assets
        ├── Node.js
        ├── Redis
        ├── Prometheus
        └── Grafana

Separate small persistent PostgreSQL
        │
        ▼
Automated backups
```

As traffic increases:

```text
One VM
    ↓
stronger VM
    ↓
separate Redis/DB
    ↓
multiple Node.js instances
    ↓
load balancing
    ↓
managed infrastructure
```

Do not jump directly to the final architecture.

---

# 48. Recommended Hosting Decision Table

| Problem | First Response | Later Response |
|---|---|---|
| CPU high | Upgrade VM | Multiple app instances |
| RAM high | Upgrade VM / separate Redis | Independent services |
| Redis memory high | Increase VM | Managed Redis |
| DB storage high | Increase storage / retention policy | Managed DB/storage |
| DB CPU high | Optimize queries/indexes | Larger DB/read replicas |
| WebSocket connections high | Optimize Node.js | Multiple instances |
| Bandwidth high | CDN/cache/static assets | Provider/network optimization |
| Moderation cost high | Local filtering | Selective AI escalation |
| Logs too large | Reduce verbosity/retention | Centralized logging |
| DDoS risk rises | Cloudflare rules | Paid security tier |
| Reports rise | Admin tooling | Human moderation |
| Revenue rises | Maintain margin | Scale based on economics |

---

# 49. The "Do Nothing" Option

A critical optimization is:

> Do nothing until the metric says the feature is necessary.

If:

```text
CPU = 25%
RAM = 40%
Redis = 20%
DB = healthy
```

do not buy another server because a blog says you should.

If:

```text
CPU = 90%
event-loop lag rising
connections approaching capacity
```

then scale.

---

# 50. Financial Guardrails

Define before launch:

```text
Maximum monthly personal subsidy:
₹________

Maximum infrastructure-only cost:
₹________

Target break-even revenue:
₹________

Target operating margin:
________%

Target reserve:
________ months
```

Example:

```text
Personal subsidy limit: ₹10,000
Target break-even: ₹10,000/month revenue
Preferred margin: 25%
Reserve: 3 months
```

These are owner decisions.

---

# 51. Cost Calculation Spreadsheet Structure

Recommended sheets:

```text
1. Assumptions
2. Traffic Scenarios
3. Infrastructure
4. Database Growth
5. Moderation
6. Advertising Revenue
7. Monthly Actuals
8. Break-Even
9. Feature Gates
10. Forecast
```

---

# 52. Assumptions Sheet

Include:

```text
MAU
DAU
Concurrent users
Messages/day
Average message bytes
Retention days
Moderation escalation %
Ad impressions/user
Revenue/1,000 impressions
Compute cost
Redis cost
DB cost
Storage cost
Bandwidth cost
```

Every assumption should have:

```text
value
source
date
confidence
```

For provider prices, record the provider pricing-page date because pricing changes.

---

# 53. Forecast Formula

For a month:

```text
Messages =
DAU × messages/user/day × days
```

Storage growth:

```text
Messages × average stored bytes
```

Moderation requests:

```text
Messages × escalation percentage
```

Ad impressions:

```text
eligible users × ad opportunities
```

Revenue:

```text
ad impressions / 1,000 × realized RPM
```

Total cost:

```text
compute
+ Redis
+ database
+ storage
+ bandwidth
+ moderation
+ observability
+ security
+ other
```

Net:

```text
Revenue - Total Cost
```

---

# 54. Example Forecast

Assume:

```text
10,000 MAU
2,000 DAU
20 messages/user/day
30 days
```

Messages:

```text
2,000 × 20 × 30
= 1,200,000 messages/month
```

If:

```text
500 bytes/message
```

raw payload:

```text
1,200,000 × 500
= 600 MB
```

Actual DB footprint will be higher because of metadata, indexes, row overhead, and backups.

If 10% of messages require external moderation:

```text
1,200,000 × 10%
= 120,000 moderation requests
```

This is the number that should drive moderation cost modeling.

---

# 55. Cost Optimization Priorities

When costs rise, optimize in this order:

## 1. Remove unnecessary traffic

Block:

- bots;
- abusive clients;
- reconnect storms.

## 2. Optimize application efficiency

Fix:

- memory leaks;
- excessive DB queries;
- inefficient Redis operations.

## 3. Optimize storage

Review:

- retention;
- indexes;
- backups;
- logs.

## 4. Optimize moderation

Reduce expensive external checks.

## 5. Right-size infrastructure

Only then scale or change providers.

---

# 56. Do Not Optimize Prematurely

Avoid spending engineering time optimizing a component that costs:

```text
₹200/month
```

while ignoring one that costs:

```text
₹10,000/month
```

Rank costs before optimizing them.

---

# 57. Cost Priority Formula

For every cost category:

```text
Monthly cost
×
growth rate
×
avoidable percentage
```

Use that to prioritize.

A small current cost with extremely high growth may deserve attention.

---

# 58. Final Recommended Roadmap

## Phase 1 — Build

Implement:

```text
React
Node.js/ws
Redis
PostgreSQL
WebSocket protocol
rate limiting
validation
basic safety
Prometheus
Grafana
Docker
```

Run everything locally.

Cost:

```text
₹0 cloud
```

---

## Phase 2 — Private Production

Use:

```text
Cloudflare Free
1 modest VM
Redis on VM
small persistent DB
backups
```

Cost target:

```text
low thousands of rupees/month
```

---

## Phase 3 — Public Validation

Monitor:

```text
DAU
MAU
concurrency
messages
storage
moderation
CPU
RAM
Redis
DB
```

Do not add expensive services yet.

---

## Phase 4 — Monetization Experiment

Once retention is validated:

```text
enable one ad placement
```

Measure:

```text
revenue
retention
session duration
cost/user
```

---

## Phase 5 — Economic Validation

Calculate:

```text
Revenue
-
operating cost
=
net
```

If negative:

```text
optimize
```

If positive:

```text
maintain
```

If consistently positive:

```text
build reserve
```

---

## Phase 6 — Scale Only When Necessary

Add:

```text
separate Redis
multiple Node.js instances
load balancer
managed DB
centralized observability
```

only when traffic/resource/reliability thresholds justify them.

---

# 59. Final Cost Philosophy

The correct architecture for Karobakbak is not:

```text
"Build infrastructure capable of supporting millions of users."
```

It is:

```text
"Build infrastructure that can cheaply and safely support today's users,
while making the next scaling step straightforward."
```

That distinction can save a large amount of money.

---

# 60. Final Decision Rule

For every new infrastructure feature, ask:

```text
Is the problem happening?
        │
       NO ──→ SKIP IT
        │
       YES
        ↓
Can the current system handle it?
        │
       YES ──→ KEEP CURRENT SYSTEM
        │
       NO
        ↓
What is the cheapest reliable solution?
        │
        ▼
Implement it
        │
        ▼
Measure again
```

---

# 61. Final Target

The financial target for Karobakbak should be:

```text
Phase 1:
Keep the hobby cost low.

Phase 2:
Validate that people actually use it.

Phase 3:
Introduce advertising carefully.

Phase 4:
Measure real unit economics.

Phase 5:
Reach operating break-even.

Phase 6:
Maintain a 25%+ safety margin.

Phase 7:
Build a 3–6 month operating reserve.

Phase 8:
Scale infrastructure only when traffic and economics justify it.
```

The key metric is not:

```text
How many users can Karobakbak support?
```

It is:

```text
How much healthy usage can Karobakbak support
for each rupee spent?
```

That is the metric that keeps the website financially justifiable.
