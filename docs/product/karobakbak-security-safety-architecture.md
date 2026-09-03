# Karobakbak --- Security, Safety & Privacy Architecture

## 1. Purpose

This document defines the security, abuse-prevention, user-safety,
privacy, moderation, infrastructure, and operational-security
architecture for Karobakbak.

Karobakbak is a text-only, real-time anonymous random stranger chat
platform.

The system is intentionally designed around the assumption that
anonymous public communication will attract:

-   Spam
-   Bots
-   Harassment
-   Sexual content
-   Grooming attempts
-   Phishing
-   Social engineering
-   Ban evasion
-   Automated abuse
-   Resource-exhaustion attacks
-   Malicious clients
-   Users attempting to bypass moderation
-   Coordinated reporting abuse

Security is therefore not a single feature. It is a layered system
consisting of:

``` text
Prevent
  ↓
Validate
  ↓
Detect
  ↓
Rate-limit
  ↓
Moderate
  ↓
Report
  ↓
Enforce
  ↓
Preserve evidence where necessary
  ↓
Review
  ↓
Delete data when retention expires
```

The system should minimize unnecessary collection while retaining enough
information to operate the service safely, investigate serious abuse,
enforce bans, and satisfy applicable legal obligations.

------------------------------------------------------------------------

# 2. Core Security Philosophy

## 2.1 Defense in depth

No individual control should be treated as a complete solution.

For example:

-   URL blocking does not eliminate phishing.
-   Toxicity classification does not eliminate harassment.
-   IP blocking does not eliminate ban evasion.
-   Age gating does not eliminate minor-safety risk.
-   Cloudflare does not eliminate application-layer abuse.
-   Rate limiting does not eliminate automated attacks.
-   Conversation retention does not guarantee evidence availability.
-   Encryption does not make an insecure access-control model safe.

Controls should overlap.

## 2.2 Server authority

The server is the absolute authority for:

-   Session state
-   Matchmaking
-   Conversation membership
-   Message sender identity
-   Message timestamps
-   Message IDs
-   Rate limits
-   Moderation decisions
-   Ban status
-   Report status
-   Retention metadata

The client is considered untrusted.

A malicious client must not be able to:

-   Declare itself matched.
-   Send messages to arbitrary sessions.
-   Change timestamps.
-   Impersonate another session.
-   Modify another user's state.
-   Bypass rate limits.
-   Skip moderation.
-   Access conversations it does not belong to.

## 2.3 Privacy by design

Karobakbak now intentionally retains conversations for a defined period.

This means the platform is not strictly ephemeral.

The architecture must therefore clearly distinguish:

### Operational data

Data required to operate the service.

### Safety data

Data required to investigate abuse and protect users.

### Security data

Data required to detect attacks and enforce security controls.

### User content

Actual conversation messages.

Each category must have:

-   A defined purpose.
-   A defined retention period.
-   Access restrictions.
-   Encryption requirements where appropriate.
-   Deletion rules.

The platform should never retain data simply because it is technically
possible.

------------------------------------------------------------------------

# 3. Threat Model

Assume an attacker can:

-   Create unlimited anonymous sessions.
-   Open many WebSocket connections.
-   Rapidly reconnect.
-   Send malformed JSON.
-   Send oversized payloads.
-   Flood messages.
-   Flood protocol commands.
-   Manipulate client-side state.
-   Replay old protocol messages.
-   Forge timestamps.
-   Attempt WebSocket origin bypass.
-   Use VPNs/proxies.
-   Rotate IP addresses.
-   Attempt ban evasion.
-   Attempt to phish other users.
-   Attempt to move users off-platform.
-   Send harassment or sexual content.
-   Attempt grooming.
-   Mass-report legitimate users.
-   Attempt to exhaust Redis.
-   Attempt to exhaust Node.js memory.
-   Create slow WebSocket consumers.
-   Attempt to bypass the CDN/WAF.
-   Attempt to compromise moderator accounts.
-   Attempt to exploit frontend vulnerabilities.
-   Attempt to exploit dependencies.
-   Attempt to obtain conversation data.
-   Attempt to access another user's conversation.
-   Attempt to exploit retention/evidence systems.

Security controls should explicitly address each class of threat.

------------------------------------------------------------------------

# 4. Security Boundaries

The production architecture should resemble:

``` text
                         Internet
                            |
                            v
                 ┌─────────────────────┐
                 │ CDN / DDoS / WAF     │
                 │ TLS termination      │
                 │ Edge rate limits     │
                 └──────────┬──────────┘
                            |
                            v
                 ┌─────────────────────┐
                 │ Reverse Proxy / LB  │
                 │ Origin protection   │
                 └──────────┬──────────┘
                            |
                 ┌──────────┴──────────┐
                 │                     │
                 v                     v
        ┌─────────────────┐   ┌─────────────────┐
        │ React Frontend  │   │ Node.js WS API  │
        └─────────────────┘   └────────┬────────┘
                                      |
                       ┌──────────────┼──────────────┐
                       v              v              v
                    Redis       Moderation      Metrics
                       |           Service         |
                       |                            |
                       v                            v
                  Ephemeral /                  Prometheus
                  operational                  / Grafana
                  state
                       |
                       v
               Conversation Store
                       |
                       v
        Retained data on storage with
        encryption at rest + encrypted backups
```

> **Implementation note (DESIGN.md revision 3, R12).** "Encrypted" here means
> storage-layer encryption at rest plus encrypted backups — not application-level
> encryption of message columns. Karobakbak stores message content as plaintext
> application data inside the trusted boundary defined in `DESIGN.md` §2.1. §28
> of this document is conditional ("*If* application-level encryption is used"),
> and that condition is deliberately not met. See `DESIGN.md` §18.2 for the
> resulting threat model.

Redis and persistent storage must never be publicly exposed.

------------------------------------------------------------------------

# 5. WebSocket Security

## 5.1 TLS / WSS

Production WebSocket connections must use:

``` text
wss://
```

Never expose production WebSockets through unencrypted:

``` text
ws://
```

Requirements:

-   TLS certificates managed securely.
-   HTTP redirected to HTTPS.
-   WSS used for WebSocket connections.
-   TLS termination handled by the edge/reverse proxy where appropriate.
-   Strong TLS configuration.
-   HSTS enabled for the web application.
-   No mixed-content WebSocket connections.

------------------------------------------------------------------------

# 6. WebSocket Origin Validation

The WebSocket handshake must validate the `Origin` header.

Use an explicit allowlist.

Example:

``` text
https://karobakbak.com
https://www.karobakbak.com
```

Reject:

``` text
https://evil.example
https://karobakbak.com.evil.example
unexpected/null origins where not explicitly supported
```

Do not use:

``` text
*
```

Do not use naive substring checks such as:

``` text
origin.includes("karobakbak.com")
```

Origin validation must occur before a WebSocket session is accepted.

Also consider validating:

-   Host.
-   Upgrade headers.
-   Connection headers.
-   Expected protocol headers.

------------------------------------------------------------------------

# 7. WebSocket Handshake Protection

Apply controls before allocating expensive session resources.

Requirements:

-   Validate HTTP/WebSocket upgrade request.
-   Validate origin.
-   Validate host.
-   Apply connection-attempt rate limits.
-   Reject malformed requests.
-   Limit handshake failures.
-   Avoid expensive database/Redis operations before validation.
-   Protect the origin from direct public access.

The handshake path itself must be treated as an attack surface.

------------------------------------------------------------------------

# 8. Protocol Integrity

All incoming WebSocket messages must follow a strict protocol schema.

Example:

``` json
{
  "type": "message",
  "messageId": "uuid",
  "sequence": 42,
  "text": "hello"
}
```

The exact protocol belongs in the API specification.

Every frame must be validated for:

-   Valid JSON.
-   Correct object shape.
-   Allowed message type.
-   Required fields.
-   Field types.
-   Maximum field length.
-   Maximum frame size.
-   Valid session state.
-   Valid sequence number.
-   Valid message ID.
-   Authorization to perform the operation.

Reject unknown protocol commands.

Do not silently accept malformed fields.

------------------------------------------------------------------------

# 9. State-Based Authorization

Every command must be valid only in the appropriate server-side state.

Example:

``` text
IDLE
 ├── start_match       ✓
 └── send_message      ✗

SEARCHING
 ├── cancel            ✓
 ├── start_match       ✗
 └── send_message      ✗

MATCHED
 ├── send_message      ✓
 ├── next              ✓
 └── cancel_search     ✗
```

The server must enforce these transitions.

The frontend must not be trusted to enforce them.

------------------------------------------------------------------------

# 10. Message Replay Protection

Every client-originated message should include a unique message
identifier and/or sequence number.

The server should reject:

-   Duplicate message IDs.
-   Old sequence numbers.
-   Invalid sequence jumps where applicable.
-   Messages from previous sessions.
-   Messages after a session has ended.
-   Messages referencing a stale match.

The server assigns authoritative timestamps.

The client cannot determine the official message timestamp.

------------------------------------------------------------------------

# 11. Message Size Limits

Apply limits at multiple layers.

At minimum:

``` text
Maximum WebSocket frame size
Maximum JSON payload size
Maximum message text length
Maximum metadata size
Maximum protocol command size
```

Example initial policy:

``` text
Message text: 500 characters
JSON frame: strict bounded maximum
Metadata: strict bounded maximum
```

The exact limits should be validated through load testing.

Reject oversized input before expensive parsing or moderation work where
possible.

------------------------------------------------------------------------

# 12. Protocol Command Rate Limiting

Do not rate-limit only chat messages.

Rate-limit operations independently.

Examples:

``` text
send_message
start_match
cancel_match
next
report
block
typing
reconnect
```

This prevents attackers from abusing cheap protocol commands.

Example:

``` text
start_match → 5/minute
report      → 10/hour
block       → reasonable burst limit
send        → message rate + burst limit
```

Exact limits should be configurable.

------------------------------------------------------------------------

# 13. Distributed Rate Limiting

Use Redis-backed rate limiting where multiple backend instances exist.

Use separate limits for:

### Connection

``` text
connections per IP
connection attempts per IP
handshake failures per IP
```

### Messaging

``` text
messages per session
messages per IP
message burst
```

### Matchmaking

``` text
match requests per session
match requests per IP
```

### Abuse operations

``` text
reports
blocks
reconnect attempts
```

The system should use a sliding-window, token-bucket, or similarly
well-defined algorithm.

------------------------------------------------------------------------

# 14. Connection Exhaustion Protection

Message rate limiting does not prevent WebSocket exhaustion.

Attackers can create thousands of idle sockets.

Implement:

-   Per-IP concurrent connection limits.
-   Connection-attempt limits.
-   Global connection capacity.
-   Per-instance connection capacity.
-   Idle connection timeout.
-   Handshake timeout.
-   Maximum unauthenticated connection lifetime where appropriate.
-   Resource limits per session.
-   Edge-level connection controls.

Avoid relying exclusively on IP because many legitimate users may share
an IP through:

-   Mobile carrier NAT.
-   Universities.
-   Offices.
-   Public Wi-Fi.
-   ISPs using CGNAT.

Use layered signals instead.

------------------------------------------------------------------------

# 15. Heartbeats

Use WebSocket ping/pong heartbeats.

Requirements:

-   Periodic server ping.
-   Expected pong response.
-   Timeout for dead clients.
-   Remove stale sessions.
-   Remove stale matchmaking entries.
-   Clean up Redis state.
-   Notify the partner if necessary.

Heartbeat configuration should be tested under real mobile-network
conditions.

------------------------------------------------------------------------

# 16. Backpressure

A slow receiver must not be able to consume unlimited server memory.

For every WebSocket:

-   Limit outbound queue size.
-   Limit buffered bytes.
-   Detect slow consumers.
-   Drop or disconnect clients exceeding limits.
-   Avoid unlimited in-memory message queues.
-   Monitor event-loop lag.
-   Monitor process memory.

Conceptually:

``` text
Server
   |
   v
Outbound queue
   |
   +-- below limit → continue
   |
   +-- above warning → monitor
   |
   +-- above hard limit → disconnect
```

------------------------------------------------------------------------

# 17. Compression

For a small text-only chat service, WebSocket compression should be
disabled unless testing demonstrates a meaningful benefit.

In particular, avoid enabling compression simply because it is
available.

Compression adds:

-   CPU cost.
-   Memory cost.
-   Complexity.
-   Additional attack considerations.

If compression is enabled later, explicitly assess the security and
performance implications.

------------------------------------------------------------------------

# 18. Plain-Text Rendering

Chat messages must be treated as untrusted plain text.

Do not support arbitrary HTML.

Do not render user messages using:

``` text
dangerouslySetInnerHTML
```

Do not allow:

-   HTML.
-   Arbitrary SVG.
-   Embedded scripts.
-   Arbitrary iframes.
-   Executable content.
-   User-controlled CSS.

React components should render message text through normal safe text
rendering.

------------------------------------------------------------------------

# 19. Message Normalization

Before moderation and policy checks:

1.  Validate encoding.
2.  Normalize Unicode where appropriate.
3.  Detect suspicious control characters.
4.  Detect excessive zero-width characters.
5.  Detect common obfuscation.
6.  Normalize whitespace.
7.  Normalize common URL obfuscation.
8.  Preserve the original message separately if required for retained
    conversation records.

The moderation representation and displayed representation should be
deliberately designed.

Do not blindly mutate user text before storing it if the platform has
decided to retain conversations.

------------------------------------------------------------------------

# 20. URL and Off-Platform Contact Controls

Incoming messages should be inspected for:

-   URLs.
-   Domains.
-   IP addresses.
-   Onion addresses.
-   Email addresses.
-   Phone numbers.
-   Social-media handles.
-   Discord invites.
-   Telegram handles.
-   WhatsApp contact patterns.
-   Cryptocurrency addresses.
-   "DM me" patterns.
-   "Search this username" patterns.
-   Common URL obfuscation techniques.

The system may:

-   Reject.
-   Withhold.
-   Warn.
-   Flag.
-   Deliver with a safety transformation.

The policy should be configurable.

Do not claim that URL filtering completely eliminates phishing or
malicious-content risks.

------------------------------------------------------------------------

# 21. Content Safety Pipeline

Message moderation should use a layered pipeline.

Conceptually:

``` text
Incoming message
       |
       v
Schema validation
       |
       v
Normalization
       |
       v
Spam / abuse checks
       |
       v
URL / contact detection
       |
       v
Content classification
       |
       v
Conversation-context analysis
       |
       v
Policy engine
       |
       +---- Allow
       |
       +---- Flag
       |
       +---- Withhold
       |
       +---- Block
       |
       +---- Escalate
```

Do not make a single classifier the final authority.

------------------------------------------------------------------------

# 22. Moderation Risk Scores

Classifiers should produce signals/risk scores rather than directly
determining permanent enforcement wherever practical.

Example:

``` text
Low
  → deliver

Medium
  → deliver + flag

High
  → withhold + investigate/action

Critical
  → block + escalate + preserve relevant evidence
```

Risk should incorporate context where possible.

Potential signals:

-   Message content.
-   Recent conversation context.
-   Repeated behavior.
-   User reports.
-   Spam patterns.
-   Account/session reputation.
-   Connection behavior.
-   Previous enforcement.

------------------------------------------------------------------------

# 23. Grooming Detection

Grooming must be treated as a dedicated safety problem.

Potential signals can include:

-   Repeated attempts to establish age.
-   Attempts to isolate the user.
-   Sexualization of a potentially minor user.
-   Requests for sexual content.
-   Attempts to move off-platform.
-   Requests for personal information.
-   Repeated secrecy requests.
-   Escalating sexual conversation.

Automated detection is a risk signal, not a legal or human
determination.

High-confidence/critical cases should follow a defined escalation
workflow.

------------------------------------------------------------------------

# 24. Child and Minor Safety

Before public launch, explicitly define:

-   Minimum age policy.
-   Age-gating strategy.
-   Whether minors are permitted.
-   Whether minors can interact with adults.
-   Whether age assurance is required.
-   How suspected minors are handled.
-   Grooming detection.
-   Reporting process.
-   Escalation process.
-   Evidence preservation.
-   Jurisdiction-specific legal obligations.

Do not assume that text-only chat eliminates child-safety risks.

Legal counsel should review the actual product, jurisdictions, user
population, retention policy, moderation model, and reporting
obligations before launch.

Do not treat any single reporting organization or framework as
automatically establishing legal compliance.

------------------------------------------------------------------------

# 25. Conversation Retention

Karobakbak intentionally retains conversations for a defined period.

This changes the privacy architecture substantially.

The retention policy must explicitly define:

``` text
What is stored?
Where is it stored?
Why is it stored?
Who can access it?
How long is it stored?
How is it encrypted?
How is it deleted?
What happens when a report is created?
What happens when a legal preservation request occurs?
```

Do not use vague language such as:

> stored for some time.

Define an exact policy.

Example:

``` text
Normal conversation retention:
30 days

Reported conversation:
90 days or until case closure, subject to policy

Security metadata:
90 days

Moderation events:
90 days

Administrative audit logs:
Defined separately
```

These are examples, not recommended final values.

Retention periods should be determined based on actual operational,
legal, privacy, and safety requirements.

------------------------------------------------------------------------

# 26. Conversation Storage Model

A reasonable architecture is:

``` text
WebSocket
   |
   v
Message validation
   |
   v
Moderation
   |
   +--------------------+
   |                    |
   v                    v
Delivery             Persistent store
                         |
                         v
              Storage with encryption at rest
                         |
                         v
                    TTL / deletion
```

> **Implementation note.** Messages are written as plaintext columns; the
> encryption referenced here is provided by the storage layer and by encrypted
> backups, not by the application (`DESIGN.md` D15, §2.1).

Messages should not be written to ordinary application logs.

Do not duplicate message content into:

-   Debug logs.
-   Metrics.
-   Error traces.
-   Redis unnecessarily.
-   Analytics events.
-   Browser telemetry.
-   Third-party monitoring systems.

------------------------------------------------------------------------

# 27. Message Storage Security

Stored conversation data should have:

-   Encryption at rest.
-   Encryption in transit.
-   Strict access control.
-   Least-privilege database credentials.
-   Separate production credentials.
-   Audit logging for administrative access.
-   Retention enforcement.
-   Secure deletion mechanisms appropriate to the storage technology.

The application should store only the fields actually required.

Potential record:

``` text
conversationId
messageId
senderSessionId
serverTimestamp
messageText
moderationMetadata
```

Avoid unnecessary personal information.

------------------------------------------------------------------------

# 28. Encryption and Key Management

Do not hard-code encryption keys.

Requirements:

-   Dedicated key-management strategy.
-   Keys stored outside source code.
-   Key rotation.
-   Separate environments.
-   Restricted key access.
-   Audit access to keys.
-   Encryption at rest.
-   TLS in transit.

If application-level encryption is used for conversation records:

``` text
Application
   |
   v
KMS / Secret Manager
   |
   v
Encryption key
   |
   v
Encrypted conversation data
```

Do not invent a custom cryptographic scheme.

Use established cryptographic libraries and authenticated encryption.

------------------------------------------------------------------------

# 29. Conversation Access Control

No moderator or administrator should be able to arbitrarily browse all
conversations.

Access should be purpose-limited.

Possible model:

``` text
Normal user
    → own active conversation only

Moderator
    → reported conversations assigned for review

Senior moderator
    → escalated cases

Security administrator
    → security investigations

Infrastructure administrator
    → infrastructure, not conversation content
```

Every access to retained conversation content should be auditable.

------------------------------------------------------------------------

# 30. Evidence Preservation

When a report is created:

``` text
Report
  ↓
Identify relevant conversation
  ↓
Freeze relevant records
  ↓
Mark retention/legal hold state
  ↓
Restrict access
  ↓
Review
  ↓
Resolve
  ↓
Delete when retention/legal requirements permit
```

Do not silently extend retention indefinitely.

If a legal hold or preservation requirement applies, the system should
represent it explicitly.

------------------------------------------------------------------------

# 31. Reporting

Provide an easy report action.

Potential categories:

-   Harassment.
-   Spam.
-   Sexual content.
-   Grooming.
-   Threats.
-   Hate/abuse.
-   Scam/phishing.
-   Other.

The report record should contain relevant metadata such as:

-   Report ID.
-   Conversation ID.
-   Reporting session.
-   Reported session.
-   Timestamp.
-   Reason.
-   Relevant moderation signals.
-   Relevant retained conversation range.
-   Enforcement state.

Do not expose internal moderation information to the reported user.

------------------------------------------------------------------------

# 32. Block

Blocking should:

-   End the current conversation where appropriate.
-   Prevent future matching according to policy.
-   Record an enforcement signal.
-   Avoid exposing unnecessary identity information.

The system should not reveal:

> "This user blocked you."

unless that behavior is explicitly part of the product design.

------------------------------------------------------------------------

# 33. Shadowbanning / Quarantine

Avoid unconditional automatic shadowbanning based solely on reports or a
single classifier.

Instead:

``` text
Signals
   ↓
Risk score
   ↓
Policy engine
   ↓
Progressive enforcement
```

Possible actions:

``` text
Warn
↓
Rate limit
↓
Reduce matchmaking eligibility
↓
Temporary quarantine
↓
Temporary suspension
↓
Permanent ban
```

All automated enforcement should be auditable.

False positives must be considered.

------------------------------------------------------------------------

# 34. Mass-Report Abuse

Users may weaponize the reporting system.

Do not automatically ban someone solely because they receive a certain
number of reports.

Consider:

-   Reporter reputation.
-   Report history.
-   Report similarity.
-   Independent moderation signals.
-   Number of unique reporters.
-   Conversation evidence.
-   Repeated false reports.
-   Coordinated reporting patterns.

Reporting should generate signals, not automatically determine guilt.

------------------------------------------------------------------------

# 35. Ban Evasion

Anonymous platforms must assume banned users will reconnect.

Potential abuse-prevention signals:

-   Session reputation.
-   IP reputation.
-   Network/subnet signals.
-   Browser/device signals where legally appropriate.
-   Behavioral patterns.
-   Account identity where accounts exist.
-   Previous enforcement history.

Do not rely on a single identifier.

Do not build excessive fingerprinting without a clear privacy
justification.

Abuse-prevention identifiers must be:

-   Purpose-limited.
-   Access-controlled.
-   Retained for defined periods.
-   Documented in the privacy architecture.

------------------------------------------------------------------------

# 36. Redis Security

Redis is security-critical infrastructure.

Requirements:

-   Never expose Redis to the public Internet.
-   Place Redis on a private network.
-   Enable authentication/ACLs.
-   Use least-privilege Redis users.
-   Separate application and administrative access.
-   Use TLS when traffic crosses trust boundaries.
-   Configure memory limits.
-   Monitor memory usage.
-   Configure eviction behavior intentionally.
-   Apply TTLs to temporary data.
-   Prevent unbounded queue growth.
-   Protect Redis from unauthenticated access.

Critically, ensure Redis persistence settings are consistent with the
privacy model.

If message content is intended to be retained in a persistent database,
do not accidentally create a second undocumented copy in Redis.

------------------------------------------------------------------------

# 37. Redis Data Classification

Define which Redis keys contain:

### Ephemeral state

Examples:

``` text
active sessions
match queue
typing state
temporary locks
rate-limit counters
```

### Security/reputation state

Examples:

``` text
rate-limit reputation
temporary bans
abuse scores
```

### Conversation content

Avoid storing long-term conversation history in Redis unless there is a
deliberate architectural reason.

Persistent conversation data should use the designated conversation
store.

------------------------------------------------------------------------

# 38. Frontend Security

Implement:

-   Strict Content Security Policy.
-   Secure security headers.
-   HTTPS-only deployment.
-   Safe React rendering.
-   No unsafe HTML rendering.
-   No inline script execution where avoidable.
-   No secrets embedded in frontend bundles.
-   Secure dependency management.
-   Trusted third-party scripts only.
-   Minimal third-party integrations.

The frontend must assume every message is hostile input.

------------------------------------------------------------------------

# 39. Recommended Security Headers

Evaluate and configure:

``` text
Content-Security-Policy
Strict-Transport-Security
X-Content-Type-Options
Referrer-Policy
Permissions-Policy
```

Also prevent clickjacking using appropriate CSP/frame controls.

Exact policies must match the production deployment and any legitimate
third-party services.

------------------------------------------------------------------------

# 40. Content Security Policy

The final CSP should restrict:

-   Scripts.
-   Connections.
-   Frames.
-   Objects.
-   Images.
-   Styles.
-   Forms.

Conceptual example:

``` text
default-src 'self';
script-src 'self';
connect-src 'self' wss://api.example.com;
object-src 'none';
base-uri 'none';
frame-ancestors 'none';
form-action 'self';
```

The final policy must be tested against:

-   CDN.
-   Ads.
-   Analytics.
-   Monitoring.
-   WebSocket endpoints.

Do not weaken CSP globally merely to accommodate one third-party
dependency.

------------------------------------------------------------------------

# 41. Secrets Management

Never commit:

-   Redis passwords.
-   Database passwords.
-   API keys.
-   Moderation API keys.
-   TLS private keys.
-   Cloudflare credentials.
-   Admin credentials.
-   Encryption keys.

Use environment-specific secret management.

Requirements:

-   Development secrets separate from production.
-   Secret rotation.
-   Least privilege.
-   No secrets in Docker images.
-   No secrets in Git history.
-   Secret scanning in CI.
-   Audit access to sensitive secrets.

------------------------------------------------------------------------

# 42. Dependency and Supply-Chain Security

Implement:

-   Lockfiles.
-   Automated dependency updates.
-   Vulnerability scanning.
-   Dependency review.
-   Container image scanning.
-   Secret scanning.
-   SAST where appropriate.
-   SBOM generation for production artifacts.
-   Regular security patching.

Pay particular attention to:

-   Node.js.
-   `ws`.
-   React.
-   Redis clients.
-   Reverse proxy.
-   Container base images.
-   Moderation libraries.
-   Third-party SDKs.

Do not automatically install packages into production without dependency
review.

------------------------------------------------------------------------

# 43. Docker Security

Production containers should:

-   Run as non-root.
-   Use minimal base images.
-   Avoid unnecessary packages.
-   Use read-only filesystems where practical.
-   Drop unnecessary Linux capabilities.
-   Set resource limits.
-   Avoid privileged containers.
-   Avoid mounting the Docker socket.
-   Scan images.
-   Pin production image versions appropriately.

Separate:

``` text
frontend
backend
redis
database
monitoring
```

into appropriately isolated services.

------------------------------------------------------------------------

# 44. Origin Protection

If Cloudflare or another edge provider is used:

``` text
Internet
   ↓
Cloudflare
   ↓
Origin
```

The origin should not remain freely accessible from the public Internet.

Configure the firewall/security group so that direct origin traffic is
blocked except where explicitly required.

Otherwise attackers can bypass:

-   WAF.
-   Edge rate limiting.
-   DDoS controls.
-   Bot protection.

This is a critical deployment requirement.

------------------------------------------------------------------------

# 45. WAF and Edge Controls

Use edge controls for:

-   IP reputation.
-   Bot detection.
-   Request rate limiting.
-   Connection abuse.
-   Known attack patterns.
-   Geographic controls where justified.
-   DDoS mitigation.

Application-level controls remain necessary.

The edge should absorb obvious abuse before it reaches Node.js.

------------------------------------------------------------------------

# 46. DDoS Protection

Use a reputable edge/DDoS protection provider.

Requirements:

-   Layer 3/4 protection.
-   Layer 7 protection.
-   Rate limiting.
-   Bot management where appropriate.
-   Origin shielding.
-   Traffic analytics.
-   Emergency blocking capability.

Test the architecture under simulated load.

Do not conduct uncontrolled attacks against production infrastructure.

------------------------------------------------------------------------

# 47. Logging Policy

Security logging is required, but conversation logging should be
deliberate.

Log security events such as:

``` text
connection accepted
connection rejected
origin rejected
rate limit triggered
invalid protocol message
oversized payload
moderation flag
report created
block created
ban applied
admin evidence access
security configuration change
```

Avoid logging:

``` text
message text
authentication tokens
session secrets
cookies
encryption keys
unnecessary personal information
```

Conversation content belongs in the designated conversation store, not
general application logs.

------------------------------------------------------------------------

# 48. Security Metrics

Expose metrics such as:

``` text
websocket_connections_active
websocket_connection_attempts_total
websocket_connections_rejected_total

websocket_invalid_messages_total
websocket_oversized_messages_total

rate_limit_messages_total
rate_limit_connections_total
rate_limit_protocol_commands_total

origin_rejections_total
reconnects_total

moderation_flags_total
moderation_blocks_total

reports_total
blocks_total
bans_total

matchmaking_queue_depth
matchmaking_failures_total

redis_latency
redis_memory_usage
event_loop_lag
process_memory_usage
```

Do not expose sensitive user information through Prometheus labels.

Never use:

``` text
userId
messageText
IP
conversationId
```

as high-cardinality metric labels unless there is a very deliberate
security/privacy reason.

------------------------------------------------------------------------

# 49. Admin Security

The moderation/admin interface must be treated as a separate security
boundary.

Requirements:

-   Strong authentication.
-   MFA.
-   Role-based access control.
-   Least privilege.
-   Session timeout.
-   Secure admin cookies.
-   Audit logs.
-   Evidence-access logging.
-   No shared admin accounts.
-   Separate production/admin credentials.

Example roles:

``` text
Moderator
  → reported content

Senior Moderator
  → escalated cases

Security Administrator
  → bans / security investigations

Infrastructure Administrator
  → infrastructure only
```

Infrastructure administrators should not automatically receive
conversation-content access.

------------------------------------------------------------------------

# 50. Admin Audit Trail

Record:

``` text
who
what
when
why
which case
what action
```

Examples:

``` text
Moderator opened report #123
Moderator viewed retained conversation
Moderator issued temporary ban
Senior moderator escalated case
Administrator placed legal hold
Administrator released legal hold
```

Admin audit records must themselves be protected against modification.

------------------------------------------------------------------------

# 51. Incident Response

Create an incident-response process before launch.

Define procedures for:

-   Data breach.
-   Database compromise.
-   Redis compromise.
-   Moderator-account compromise.
-   Mass spam.
-   Bot attack.
-   DDoS.
-   Child-safety incident.
-   Large-scale harassment.
-   Moderation outage.
-   Accidental data exposure.
-   Retention/deletion failure.

At minimum define:

``` text
Detect
 ↓
Contain
 ↓
Investigate
 ↓
Preserve evidence
 ↓
Remediate
 ↓
Recover
 ↓
Review
```

------------------------------------------------------------------------

# 52. Security Testing

Security testing should include:

## Unit tests

-   Rate limiting.
-   Protocol validation.
-   State transitions.
-   Authorization.
-   URL detection.
-   Moderation policy.
-   Retention logic.

## Integration tests

-   WebSocket handshake.
-   Origin validation.
-   Redis behavior.
-   Matchmaking.
-   Disconnect handling.
-   Message persistence.
-   Report flow.

## Abuse tests

-   Message flood.
-   Connection flood.
-   Reconnect flood.
-   Protocol-command flood.
-   Slow consumer.
-   Oversized payload.
-   Malformed JSON.
-   Duplicate message IDs.
-   Replay attempts.
-   Queue abuse.
-   Mass reporting.

## Security tests

-   XSS attempts.
-   CSWSH attempts.
-   Origin bypass.
-   Header injection.
-   Dependency vulnerabilities.
-   Container vulnerabilities.
-   Authentication bypass.
-   Authorization bypass.

## Fuzzing

Fuzz:

-   JSON payloads.
-   Protocol commands.
-   Unicode.
-   Message lengths.
-   Malformed WebSocket frames where practical.

------------------------------------------------------------------------

# 53. Load Testing

Use k6 or an equivalent tool to test:

-   Concurrent connections.
-   Matchmaking throughput.
-   Message throughput.
-   Redis load.
-   Moderation throughput.
-   Slow clients.
-   Connection churn.
-   Reconnect storms.

Test both normal and adversarial traffic.

Track:

``` text
CPU
Memory
Event-loop lag
Redis latency
Message latency
Matchmaking latency
Connection success rate
Connection rejection rate
```

------------------------------------------------------------------------

# 54. Privacy and Retention Model

The final privacy architecture should maintain a data inventory.

Example:

  ------------------------------------------------------------------------
  Data              Purpose           Retention          Access
  ----------------- ----------------- ------------------ -----------------
  Conversation text Safety / service  Defined period     Restricted
                    operation                            

  Session ID        Operations        Defined period     Restricted

  IP address        Abuse prevention  Defined period     Restricted
                    / security                           

  Connection        Security /        Defined period     Restricted
  timestamps        operations                           

  Moderation        Safety            Defined period     Moderation
  signals                                                

  Reports           Safety            Defined period     Moderation

  Admin audit logs  Accountability    Defined period     Security

  Rate-limit state  Abuse prevention  Short TTL          Backend

  Matchmaking queue Service operation Until              Backend
                                      consumed/expired   
  ------------------------------------------------------------------------

The actual retention periods must be explicitly chosen before launch.

------------------------------------------------------------------------

# 55. Data Deletion

Retention must have an enforcement mechanism.

Do not rely on:

> We intend to delete it after 30 days.

Implement automatic deletion.

Conceptually:

``` text
Conversation created
        ↓
Retention deadline assigned
        ↓
Storage
        ↓
Deletion worker
        ↓
Deleted
        ↓
Deletion verification / metrics
```

Monitor deletion failures.

A failed deletion job should generate an operational alert.

------------------------------------------------------------------------

# 56. Legal Holds

If the service receives a valid legal preservation requirement:

``` text
Normal retention
      ↓
Legal hold
      ↓
Normal deletion suspended
      ↓
Case resolved
      ↓
Retention resumes / deletion occurs
```

Legal holds must be explicit, audited, and narrowly scoped.

Do not indefinitely retain all data because of hypothetical future legal
requests.

------------------------------------------------------------------------

# 57. Data Minimization

Even with conversation retention, avoid unnecessary collection.

Do not collect:

-   Precise location unless required.
-   Contacts.
-   Camera access.
-   Microphone access.
-   Unnecessary browser fingerprint data.
-   Unnecessary device identifiers.

For every collected field ask:

``` text
Why do we need this?
How long do we need it?
Who needs access?
What happens if we don't collect it?
```

------------------------------------------------------------------------

# 58. Privacy-Safe Analytics

Analytics systems must not receive raw conversation content.

Do not send chat text to:

-   Analytics providers.
-   Session replay tools.
-   Error trackers.
-   Advertising systems.
-   Third-party telemetry.

Be especially careful with session replay tools because they may
accidentally capture:

-   Message text.
-   User inputs.
-   Reports.
-   IP information.

Mask or disable sensitive fields.

------------------------------------------------------------------------

# 59. Third-Party Moderation Services

If an external moderation API is used, explicitly assess:

-   Whether message text leaves Karobakbak infrastructure.
-   Whether the provider stores submitted text.
-   Data retention.
-   Data processing terms.
-   Geographic processing location.
-   Security.
-   Contractual obligations.
-   Failure behavior.
-   Rate limits.
-   Cost under abuse.

Do not send user conversations to third parties without understanding
their data-retention behavior.

------------------------------------------------------------------------

# 60. Moderation Service Failure

The platform must define what happens if moderation is unavailable.

Possible policies:

### Fail closed

Messages are temporarily withheld.

### Fail open

Messages continue while logging the moderation failure.

### Degraded mode

Only high-speed deterministic checks run.

For a stranger-chat platform, the preferred behavior should be
explicitly decided per risk category.

Do not accidentally default to fail-open behavior for high-risk safety
controls.

------------------------------------------------------------------------

# 61. Security Configuration Management

Security-sensitive configuration must be centralized and auditable.

Examples:

``` text
message limits
rate limits
connection limits
retention period
moderation thresholds
ban thresholds
allowed origins
WAF rules
admin roles
```

Do not scatter security constants throughout the codebase.

Configuration changes should be:

-   Reviewed.
-   Version-controlled where appropriate.
-   Audited.
-   Tested.

------------------------------------------------------------------------

# 62. Graceful Degradation

When non-critical services fail, the chat platform should remain stable.

Examples:

``` text
Metrics unavailable
    → Chat continues

Analytics unavailable
    → Chat continues

Icebreaker service unavailable
    → Chat continues

Moderation unavailable
    → Apply defined safety fallback

Redis unavailable
    → Stop or degrade matchmaking safely
```

Never continue in a way that violates the security model simply because
a dependency failed.

------------------------------------------------------------------------

# 63. Security Invariants

The following must always be true.

### Invariant 1

A client can never send a message to a session it is not currently
paired with.

### Invariant 2

A client can never declare itself matched.

### Invariant 3

A client cannot bypass message rate limits.

### Invariant 4

A client cannot submit arbitrarily large payloads.

### Invariant 5

A client cannot keep an unlimited outbound queue alive.

### Invariant 6

A WebSocket from an unauthorized origin cannot establish a session.

### Invariant 7

Conversation content is never written to ordinary logs.

### Invariant 8

Retained conversation content can only be accessed by authorized
systems/users.

### Invariant 9

Expired conversation content is automatically deleted.

### Invariant 10

Moderators cannot arbitrarily access every conversation.

### Invariant 11

Automated moderation does not silently become an irreversible
enforcement mechanism without policy justification.

### Invariant 12

The public Internet cannot directly bypass the protected origin.

------------------------------------------------------------------------

# 64. Pre-Launch Security Checklist

## Application

-   [ ] Server-authoritative state
-   [ ] Strict protocol schema
-   [ ] Message size limits
-   [ ] Frame size limits
-   [ ] Protocol command rate limits
-   [ ] Message rate limits
-   [ ] Replay protection
-   [ ] State-based authorization
-   [ ] Safe text rendering
-   [ ] CSP
-   [ ] Security headers

## WebSocket

-   [ ] WSS
-   [ ] Origin allowlist
-   [ ] Host validation
-   [ ] Handshake rate limiting
-   [ ] Connection limits
-   [ ] Heartbeats
-   [ ] Slow-consumer detection
-   [ ] Backpressure
-   [ ] Compression decision documented

## Infrastructure

-   [ ] Cloudflare/CDN or equivalent
-   [ ] DDoS protection
-   [ ] WAF
-   [ ] Edge rate limiting
-   [ ] Origin firewall
-   [ ] Direct-origin access blocked
-   [ ] TLS
-   [ ] Private Redis
-   [ ] Secure database

## Abuse

-   [ ] Spam detection
-   [ ] URL/contact detection
-   [ ] Toxicity detection
-   [ ] Grooming detection
-   [ ] Reporting
-   [ ] Blocking
-   [ ] Progressive enforcement
-   [ ] Ban evasion strategy
-   [ ] Mass-report protection

## Child safety

-   [ ] Minimum-age policy
-   [ ] Age-gating strategy
-   [ ] Minor-safety policy
-   [ ] Grooming escalation
-   [ ] Evidence preservation process
-   [ ] Legal review
-   [ ] Mandatory reporting analysis

## Data

-   [ ] Conversation retention period defined
-   [ ] Metadata retention defined
-   [ ] Encryption at rest
-   [ ] Encryption in transit
-   [ ] Access control
-   [ ] Admin audit logging
-   [ ] Automatic deletion
-   [ ] Deletion monitoring
-   [ ] Legal hold mechanism

## Admin

-   [ ] MFA
-   [ ] RBAC
-   [ ] Least privilege
-   [ ] Audit logs
-   [ ] Evidence access logging
-   [ ] Separate admin credentials

## Supply chain

-   [ ] Lockfiles
-   [ ] Dependency scanning
-   [ ] Container scanning
-   [ ] Secret scanning
-   [ ] SAST
-   [ ] SBOM
-   [ ] Dependency update process

## Testing

-   [ ] WebSocket integration tests
-   [ ] Fuzz testing
-   [ ] Rate-limit tests
-   [ ] Connection-flood tests
-   [ ] Slow-client tests
-   [ ] Replay tests
-   [ ] Origin bypass tests
-   [ ] XSS tests
-   [ ] Authorization tests
-   [ ] Load tests
-   [ ] Security review / penetration test

------------------------------------------------------------------------

# 65. Recommended Implementation Order

Do not attempt to build every security feature simultaneously.

## Phase 1 --- Secure foundation

Implement first:

1.  TLS/WSS.
2.  Server-authoritative protocol.
3.  Strict schema validation.
4.  Message/frame limits.
5.  State-based authorization.
6.  Origin validation.
7.  Heartbeats.
8.  Connection limits.
9.  Message/protocol rate limiting.
10. Backpressure.
11. Safe text rendering.
12. Security headers/CSP.

## Phase 2 --- Abuse prevention

Then:

1.  Spam controls.
2.  URL/contact detection.
3.  Toxicity classification.
4.  Reporting.
5.  Blocking.
6.  Progressive enforcement.
7.  Ban-evasion signals.
8.  Security metrics.

## Phase 3 --- Conversation retention

Then:

1.  Persistent conversation store.
2.  Encryption at rest.
3.  Retention metadata.
4.  Automatic deletion.
5.  Access control.
6.  Admin audit trail.
7.  Evidence preservation.
8.  Legal-hold capability.

## Phase 4 --- Child safety and moderation operations

Then:

1.  Age policy.
2.  Minor-safety design.
3.  Grooming detection.
4.  Escalation workflow.
5.  Moderator tooling.
6.  Evidence review.
7.  Legal/compliance review.

## Phase 5 --- Production hardening

Finally:

1.  Cloudflare/DDoS.
2.  WAF.
3.  Origin firewall.
4.  Container hardening.
5.  Dependency scanning.
6.  Secret management.
7.  Security testing.
8.  Load testing.
9.  Incident-response procedures.
10. Penetration testing.

------------------------------------------------------------------------

# 66. Final Security Philosophy

Karobakbak should not attempt to promise:

> "We have eliminated abuse."

That is not achievable for anonymous communication.

The goal is:

> Make abuse harder, detect dangerous behavior quickly, limit its reach,
> protect users, give moderators the tools to respond, preserve
> necessary evidence, minimize unnecessary data collection, and reliably
> delete retained data when its purpose expires.

The security architecture should therefore be built around five
principles:

``` text
               ┌───────────────────┐
               │    PREVENT        │
               │ validation        │
               │ rate limits       │
               │ WAF               │
               └─────────┬─────────┘
                         ↓
               ┌───────────────────┐
               │     DETECT        │
               │ moderation        │
               │ abuse signals     │
               │ reports           │
               └─────────┬─────────┘
                         ↓
               ┌───────────────────┐
               │    RESPOND        │
               │ block             │
               │ quarantine        │
               │ escalate          │
               └─────────┬─────────┘
                         ↓
               ┌───────────────────┐
               │    PRESERVE       │
               │ reported evidence │
               │ audit trail       │
               │ legal holds       │
               └─────────┬─────────┘
                         ↓
               ┌───────────────────┐
               │     DELETE        │
               │ retention policy  │
               │ automated expiry  │
               │ deletion monitor  │
               └───────────────────┘
```

The result should be a platform where anonymity does not mean lack of
accountability, while accountability does not require collecting
everything about everyone.
