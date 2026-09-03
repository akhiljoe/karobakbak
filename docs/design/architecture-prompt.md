# Deep Codebase Architecture & Data Flow Analysis

Act as a Principal Distributed Systems Architect and Senior Software Architect.

I am building a scalable, real-time "Random Chat with Strangers" application. The application is primarily mobile-oriented and supports real-time text chat, with WebRTC-based audio/video capabilities. The system includes anonymous/temporary users, matchmaking, real-time connections, chat sessions, moderation/abuse prevention, persistent data, and horizontally scalable backend services.

I want you to perform a deep architectural analysis of my EXISTING CODEBASE and produce a comprehensive architecture and data-flow document.

This is NOT a greenfield architecture exercise.

Your first responsibility is to understand what the codebase actually does today. Only after you have sufficiently understood the implementation should you document the architecture and recommend improvements.

The codebase is large.

DO NOT attempt to read the entire repository in one pass.

DO NOT produce the final architecture document after reading only a handful of files.

Work through the repository progressively in phases.

---

# Core Rules

## Rule 1 — Understand before documenting

Do not assume an architecture based on filenames, README files, folder structure, technology choices, or conventional patterns.

Trace the actual implementation.

For every important architectural claim, determine where it is implemented.

For example:

Do not say:

> "Redis stores matchmaking state."

unless the code actually demonstrates that.

Instead determine:

* where matchmaking state is created
* which service owns it
* what data structure is used
* how it is written
* how it is read
* how it expires
* how concurrent workers interact with it
* what happens if a worker crashes
* what happens if Redis becomes unavailable

Distinguish clearly between:

* CONFIRMED — directly verified from code/configuration
* INFERRED — strongly implied by implementation
* UNKNOWN — cannot be determined from the repository
* RECOMMENDATION — proposed future architecture

Never present an inference or recommendation as an existing architectural fact.

---

# Phase 0 — Establish the Analysis Plan

Before deeply reading files:

1. Inspect the repository structure.
2. Identify applications/services/packages.
3. Identify entry points.
4. Identify infrastructure/configuration.
5. Identify databases and external dependencies.
6. Identify frontend/mobile clients.
7. Identify backend services.
8. Identify real-time communication mechanisms.
9. Identify deployment/container/infrastructure configuration.
10. Identify tests and integration tests.
11. Identify documentation that already exists.

Create an initial architecture inventory.

Do NOT write the final architecture document yet.

At this stage, create a working map of the repository and determine what needs to be investigated.

---

# Phase 1 — Repository Inventory

Build an inventory covering:

### Applications

For every executable application/service:

* name
* location
* responsibility
* entry point
* language
* framework
* build system
* runtime
* dependencies
* configuration
* deployment mechanism

### Major Components

Identify:

* frontend/client
* API services
* WebSocket services
* matchmaking
* chat/session management
* authentication/session management
* user/profile services
* moderation
* notification systems
* background workers
* scheduled jobs
* databases
* caches
* queues
* event buses
* object storage
* observability
* external APIs
* third-party services

### Infrastructure

Identify:

* CDN
* reverse proxy
* load balancer
* API gateway
* service discovery
* containers
* orchestration
* cloud services
* DNS
* TLS termination
* secrets/configuration
* autoscaling
* health checks

Do not assume a component exists simply because it would normally be used.

---

# Phase 2 — Read the Codebase Progressively

The repository is large.

Read it in logical batches.

Prioritize files based on architectural importance rather than alphabetical order.

Recommended order:

1. application entry points
2. dependency/configuration setup
3. routing
4. API controllers/handlers
5. authentication/session creation
6. WebSocket/realtime connection handling
7. matchmaking
8. chat/session lifecycle
9. WebRTC signaling
10. databases/repositories
11. cache usage
12. queues/events
13. background workers
14. moderation
15. rate limiting/security
16. error handling
17. infrastructure/deployment
18. tests

After each batch, update your internal understanding.

Do not repeatedly reread files that have already been understood unless another file changes their interpretation.

When you discover an important dependency, trace it.

For example:

HTTP endpoint
→ controller
→ service
→ repository
→ database

or:

Client
→ WebSocket
→ connection manager
→ matchmaking
→ session
→ peer signaling
→ WebRTC

Follow the chain through the implementation.

---

# Phase 3 — Build the Architecture Model

Once enough of the repository has been understood, construct an explicit architecture model.

Cover at least:

## Logical Architecture

Show:

Client applications
→ Edge
→ API/Realtime entry points
→ services
→ data stores
→ external services

Identify ownership boundaries.

Explain what each service is responsible for and what it should NOT be responsible for.

## Deployment Architecture

Document:

* processes
* containers
* instances
* availability zones/regions if evident
* load balancers
* networking
* internal/external boundaries
* scaling units
* stateful vs stateless components

## Data Architecture

For every important data store explain:

* what data is stored
* schema/entities
* ownership
* read/write paths
* consistency expectations
* TTL/expiration
* indexes
* transactions
* concurrency behavior
* backup/recovery implications
* deletion/retention behavior

The application retains conversations for a defined period, so explicitly analyze conversation storage, retention, access control, deletion, and privacy implications.

## State Architecture

Distinguish:

* client state
* connection state
* matchmaking state
* user presence state
* chat/session state
* WebRTC signaling state
* persistent state
* ephemeral state

For every state category identify its source of truth.

---

# Phase 4 — Trace the Major End-to-End Data Flows

This is one of the most important parts of the document.

Trace actual code paths, not hypothetical flows.

For each flow provide:

1. initiating actor
2. request/event
3. component receiving it
4. validation
5. authentication/authorization
6. state changes
7. database/cache operations
8. messages/events
9. response
10. failure paths
11. retry behavior
12. timeout behavior
13. cleanup behavior

Document at minimum:

### Flow A — Application Startup

Client starts
→ configuration
→ authentication/session establishment
→ backend connection
→ initial state

### Flow B — Anonymous Session Creation

Trace exactly how an anonymous user/session is created and represented.

### Flow C — Enter Matchmaking

Client
→ API/realtime endpoint
→ matchmaking service
→ queue/state store
→ matching decision

Explain concurrency and race-condition handling.

### Flow D — Successful Match

User A
↔ matchmaking
↔ User B

Explain:

* match creation
* session creation
* notifications
* state transitions
* persistence
* reconnect behavior

### Flow E — Real-Time Chat

Client
→ realtime connection
→ backend
→ recipient

Document:

* message routing
* persistence
* ordering
* acknowledgements
* retries
* duplicate handling
* disconnect behavior

### Flow F — WebRTC Signaling

Trace:

peer discovery
→ signaling
→ SDP offer
→ SDP answer
→ ICE candidates
→ STUN
→ TURN fallback
→ peer connection

Clearly separate:

SIGNALING PLANE

from

MEDIA PLANE

Explain which traffic goes through the backend and which does not.

### Flow G — Skip / Next Stranger

Trace exactly what happens when a user skips.

Document:

* session termination
* matchmaking cleanup
* socket cleanup
* database changes
* notification to peer
* race conditions
* next matchmaking attempt

### Flow H — Disconnect / Reconnect

Analyze:

* normal disconnect
* network failure
* app backgrounding
* mobile network transition
* backend restart
* WebSocket disconnect
* reconnect
* stale session cleanup

### Flow I — Moderation / Reporting

Trace:

message
→ moderation
→ decision
→ storage
→ user/report action

Also analyze asynchronous vs synchronous moderation.

### Flow J — Conversation Lifecycle

Document:

creation
→ active conversation
→ messages
→ participant changes
→ termination
→ retention period
→ deletion

---

# Phase 5 — State Machines

Create state diagrams for important entities.

At minimum:

## User/Connection State

Example:

OFFLINE
→ CONNECTING
→ ONLINE
→ SEARCHING
→ MATCHED
→ IN_CHAT
→ DISCONNECTING
→ OFFLINE

Do not blindly use these states.

Derive the real states from the codebase.

## Matchmaking State

Document the actual state transitions.

## Chat Session State

Document the actual lifecycle.

## WebRTC State

Document signaling and connection states.

For every state machine identify:

* valid transitions
* invalid transitions
* timeout transitions
* failure transitions
* cleanup transitions
* race conditions

---

# Phase 6 — Concurrency & Distributed Systems Analysis

This application will eventually run across multiple instances.

Analyze distributed-systems behavior in detail.

Look specifically for:

* race conditions
* duplicate matchmaking
* double matching
* stale users
* stale sockets
* split-brain state
* distributed locks
* atomic operations
* idempotency
* retries
* duplicate events
* message ordering
* eventual consistency
* cache invalidation
* clock assumptions
* timeout handling
* failure recovery

For matchmaking, explicitly answer:

> What prevents two workers from matching the same user simultaneously?

If the code does not adequately prevent it, identify the exact risk.

---

# Phase 7 — Failure Analysis

For every major component ask:

"What happens if this component disappears right now?"

Analyze failures involving:

* database
* Redis/cache
* message queue
* WebSocket server
* matchmaking worker
* API server
* TURN server
* external moderation provider
* network
* client crash
* process restart
* deployment
* partial regional outage

Document:

* detection
* timeout
* retry
* fallback
* cleanup
* user-visible behavior
* data consistency implications

---

# Phase 8 — Security & Abuse Architecture

Analyze the implemented security model.

Cover:

* anonymous authentication
* session tokens
* JWT/session lifetime
* token rotation
* authorization
* API rate limiting
* WebSocket abuse
* matchmaking abuse
* spam
* bots
* scraping
* IP-based controls
* device/session fingerprinting if present
* CSRF/CORS
* input validation
* message validation
* WebRTC security
* TURN credential security
* secrets
* internal service exposure
* database access
* logging of sensitive information

Also identify security controls that are missing.

Do not invent controls that do not exist.

---

# Phase 9 — Observability

Determine what the current system exposes for:

* logs
* metrics
* traces
* request IDs
* correlation IDs
* WebSocket/session IDs
* matchmaking metrics
* connection metrics
* message metrics
* error rates
* latency
* queue depth
* database performance
* WebRTC metrics

Then identify the minimum observability needed to operate this system reliably at scale.

---

# Phase 10 — Architecture Diagrams

Create Mermaid diagrams.

At minimum include:

1. High-level system architecture
2. Deployment architecture
3. Component/service architecture
4. Network topology
5. Authentication/session flow
6. Matchmaking sequence diagram
7. Chat message sequence diagram
8. WebRTC signaling sequence diagram
9. Skip/disconnect sequence diagram
10. Conversation lifecycle
11. State machines
12. Major data stores and relationships
13. Failure/recovery flow

Diagrams must represent the architecture discovered in the codebase.

Do not create impressive-looking diagrams containing components that do not actually exist.

Where future recommendations are shown, clearly label them as TARGET/FUTURE architecture.

---

# Phase 11 — Current Architecture vs Target Architecture

Separate the final document into:

## CURRENT STATE

What the codebase actually implements today.

## PROBLEMS / RISKS

Issues discovered during analysis.

## TARGET STATE

Recommended architecture for scaling the application.

Do not blur these three sections.

For every recommended change explain:

* current problem
* proposed solution
* why it helps
* complexity
* operational cost
* migration difficulty
* trade-offs
* whether it is necessary now or only at larger scale

Avoid premature microservices.

If the current architecture would be better served by a modular monolith or fewer services, say so.

---

# Phase 12 — Technology Evaluation

Only after understanding the existing implementation, evaluate technologies for:

* CDN/edge
* reverse proxy
* load balancing
* API gateway
* WebSocket infrastructure
* matchmaking
* Redis/cache
* relational database
* message broker
* event streaming
* WebRTC/STUN/TURN
* object storage
* observability
* moderation
* deployment/orchestration

Do not recommend technologies merely because they are popular.

For each recommendation explain:

* why
* expected scale
* operational complexity
* failure characteristics
* cost implications
* alternatives
* migration impact

---

# Phase 13 — Scalability Model

Analyze how the system behaves as it grows.

Consider at least:

* 1,000 concurrent users
* 10,000
* 100,000
* 1 million

Estimate bottlenecks in:

* HTTP requests
* WebSocket connections
* matchmaking
* Redis
* database
* message throughput
* WebRTC signaling
* TURN bandwidth
* moderation
* logging
* storage

Do not invent precise benchmark numbers.

Where measurements are unavailable, clearly label estimates as assumptions.

---

# Phase 14 — Architecture Decisions

Create an Architecture Decision Record-style section for major decisions.

For each decision:

* Decision
* Context
* Options considered
* Selected approach
* Reason
* Trade-offs
* Consequences

Focus particularly on:

* state ownership
* matchmaking
* real-time transport
* persistence
* WebRTC architecture
* scaling
* consistency
* failure recovery
* moderation
* security

---

# Phase 15 — Final Architecture Document

Only after all relevant code has been inspected should you generate the final document.

The final document should have this structure:

# System Architecture

## 1. Executive Summary

## 2. System Overview

## 3. Repository / Service Inventory

## 4. Current Architecture

## 5. Deployment Architecture

## 6. Network Architecture

## 7. Service Responsibilities

## 8. Data Architecture

## 9. State Management

## 10. Authentication & Session Architecture

## 11. Matchmaking Architecture

## 12. Real-Time Communication Architecture

## 13. WebRTC Architecture

## 14. Conversation Architecture

## 15. Moderation & Abuse Prevention

## 16. Security Architecture

## 17. Detailed Data Flows

## 18. State Machines

## 19. Concurrency & Distributed Systems

## 20. Failure & Recovery

## 21. Observability

## 22. Scalability Analysis

## 23. Current Architecture Problems

## 24. Target Architecture

## 25. Technology Recommendations

## 26. Architecture Trade-offs

## 27. Architecture Decisions

## 28. Migration Roadmap

## 29. Open Questions / Unknowns

## 30. Appendix — Important Code References

---

# Code References

Whenever possible, reference the actual implementation.

Use:

`path/to/file.ts:123-160`

or the equivalent format supported by the environment.

For important architectural claims, include the relevant code/configuration reference.

The final document should allow another engineer to move from:

ARCHITECTURE DIAGRAM

→ COMPONENT

→ DATA FLOW

→ IMPLEMENTATION

→ SOURCE FILE

without guessing.

---

# Analysis Discipline

Do not rush.

Do not try to finish the analysis in one pass.

If context/window limits prevent complete analysis:

1. stop at a logical boundary
2. record what has been understood
3. record what remains
4. continue from there in the next phase

Maintain an internal analysis checklist so that important directories and architectural components are not accidentally skipped.

Prefer depth over breadth.

Reading 20 highly relevant files deeply is better than superficially scanning 500 files.

However, do not prematurely conclude that a subsystem is understood until its important callers, dependencies, state transitions, and persistence paths have been traced.

---

# Important Output Constraint

Do not start by generating the final architecture document.

First perform the phased repository analysis.

After each phase, briefly report:

* what you inspected
* what you learned
* important architectural discoveries
* uncertainties
* what you will inspect next

Only produce the final comprehensive architecture document when you have sufficient evidence from the repository.

The final document must describe the SYSTEM THAT ACTUALLY EXISTS first, and then clearly distinguish the SYSTEM THAT SHOULD EXIST from the recommendations.

Accuracy is more important than completeness.

Never invent architecture.
