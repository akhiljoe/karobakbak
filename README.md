# karobakbak

Anonymous, real-time, text-only random stranger chat. Two strangers are paired
at random, exchange messages, and either one can skip, report or block at any
time. Conversations are **retained for a defined period** to support abuse
investigation and then deleted automatically. Retained content is plaintext
inside the trusted boundary of [`DESIGN.md`](./DESIGN.md) §2.1 and never leaves
it: **no message content is ever logged, labelled on a metric, or exported to
any other system.**

> **Status: under construction, built in phases.** See [`PHASES.md`](./PHASES.md)
> for what is done and what is next. The full operator README (setup, commands,
> troubleshooting, production hardening) lands in phase 9.

## Design

The authoritative design record — invariants, state machine, WebSocket
protocol, Redis data model, matchmaking algorithm, concurrency analysis and
cross-instance communication — is [`DESIGN.md`](./DESIGN.md). Read it first; the
implementation is written to match it.

## Repository layout

```
karobakbak/
├── backend/                 Node + TypeScript + ws + ioredis + prom-client
│   ├── src/
│   │   ├── protocol/        wire types, validation (source of truth)
│   │   ├── redis/           keys, client, Lua scripts, typed store
│   │   ├── ws/              connection handling, session lifecycle
│   │   └── util/            ids, time, small helpers
│   └── tests/
│       ├── unit/            fast, no external dependencies
│       ├── integration/     real Redis, real WebSockets
│       └── helpers/         shared test fixtures
├── frontend/                React + TypeScript + Vite, native WebSocket API
│   └── src/
│       ├── protocol/        byte-identical copy of the backend protocol types
│       ├── components/      presentational components
│       └── hooks/           useChat — WebSocket client + UI state machine
├── load-test/               k6 WebSocket load test
├── monitoring/
│   ├── prometheus/          scrape config
│   └── grafana/             provisioned datasource + dashboards
├── scripts/                 repo-level verification scripts
├── docs/                    supplementary documentation
├── DESIGN.md                architecture and correctness record
├── PHASES.md                build plan and status
├── .env.example             every environment variable, documented
└── docker-compose.yml       frontend, 2× backend, redis, prometheus, grafana
```

## Quick start (once phase 8 lands)

```bash
cp .env.example .env
docker compose up --build -d
```

## License

MIT
