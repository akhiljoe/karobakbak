-- karobakbak initial schema (DESIGN.md §8).
--
-- Run by the migration role, never by the application role (§8.1). The
-- application role gets DML on these tables and nothing else: no CREATE, no
-- SUPERUSER, no access to other databases.
--
-- Every retained table carries `retention_expires_at`, stamped at INSERT time
-- (I9, D17). It is deliberately not a computed default here: the deadline is
-- decided by application configuration at the moment of writing, so a later
-- config change can never retroactively extend the life of a row already
-- stored.

create table if not exists conversations (
  conversation_id       uuid primary key,          -- equals the matchId
  session_a             text not null,
  session_b             text not null,
  segment               text not null,
  started_at            timestamptz not null,
  ended_at              timestamptz,
  end_reason            text,                      -- skip|block|disconnect|reap|shutdown
  message_count         integer not null default 0,
  retention_expires_at  timestamptz not null,
  legal_hold            boolean not null default false
);

create index if not exists conversations_expiry_idx
  on conversations (retention_expires_at) where legal_hold = false;

create table if not exists messages (
  message_id            uuid primary key,
  conversation_id       uuid not null references conversations on delete cascade,
  sender_session_id     text not null,
  server_timestamp      timestamptz not null,      -- server authority, never the client's
  -- The content-type seam (§23.3). The CHECK lists exactly the types the
  -- application implements, so neither a bug nor a direct database write can
  -- introduce a type the code cannot render or moderate. Adding one is a
  -- two-line migration; there is deliberately no media_id or metadata column,
  -- because dead schema is worse than a later migration.
  type                  text not null default 'text' check (type in ('text')),
  body                  text not null,             -- plaintext application data (D15)
  -- So telemetry, cost modelling and abuse heuristics never read the body.
  char_length           integer not null,
  moderation_action     text not null default 'allow'
                          check (moderation_action in ('allow', 'flag', 'withhold', 'block')),
  -- Rule ids and severities. Never excerpts, never text (I8).
  moderation_flags      jsonb not null default '[]'::jsonb,
  retention_expires_at  timestamptz not null,
  legal_hold            boolean not null default false
);

create index if not exists messages_conversation_idx
  on messages (conversation_id, server_timestamp);
create index if not exists messages_expiry_idx
  on messages (retention_expires_at) where legal_hold = false;

create table if not exists reports (
  report_id             uuid primary key,
  conversation_id       uuid not null references conversations,
  reporter_session_id   text not null,
  reported_session_id   text not null,
  category              text not null,
  -- The reporter's own words. User-generated content, handled exactly like a
  -- message body for every logging, metrics and access-control purpose (I8).
  note                  text,
  created_at            timestamptz not null,
  state                 text not null default 'OPEN'
                          check (state in ('OPEN', 'TRIAGED', 'ACTIONED', 'DISMISSED')),
  resolution            text,
  retention_expires_at  timestamptz not null,
  legal_hold            boolean not null default false
);

create index if not exists reports_conversation_idx on reports (conversation_id);
create index if not exists reports_open_idx on reports (state) where state = 'OPEN';
create index if not exists reports_expiry_idx
  on reports (retention_expires_at) where legal_hold = false;

-- Salted hashes only. No IP addresses, no user agents, no fingerprints
-- (data minimisation, security §57).
create table if not exists blocks (
  block_id              uuid primary key,
  blocker_key           text not null,             -- ipHash or clientHash (D18)
  blocked_key           text not null,
  dimension             text not null check (dimension in ('ip', 'client')),
  conversation_id       uuid,
  created_at            timestamptz not null,
  expires_at            timestamptz not null
);

create index if not exists blocks_pair_idx on blocks (blocker_key, blocked_key);
create index if not exists blocks_expiry_idx on blocks (expires_at);

create table if not exists moderation_events (
  event_id              uuid primary key,
  conversation_id       uuid,
  message_id            uuid,
  rule                  text not null,             -- which local rule fired
  action                text not null
                          check (action in ('allow', 'flag', 'withhold', 'block')),
  severity              text not null check (severity in ('low', 'medium', 'high')),
  created_at            timestamptz not null,
  retention_expires_at  timestamptz not null
);

create index if not exists moderation_events_message_idx on moderation_events (message_id);
create index if not exists moderation_events_expiry_idx
  on moderation_events (retention_expires_at);

-- Append-only (I11). Every read of retained conversation content writes a row
-- here; "why" is mandatory, which is what makes the log worth keeping.
create table if not exists admin_audit (
  audit_id              uuid primary key,
  actor                 text not null,
  role                  text not null,
  action                text not null,             -- viewed_conversation|issued_ban|...
  subject_type          text not null,
  subject_id            text not null,
  case_id               text,
  justification         text not null,
  created_at            timestamptz not null,
  retention_expires_at  timestamptz not null
);

create index if not exists admin_audit_subject_idx on admin_audit (subject_type, subject_id);
create index if not exists admin_audit_expiry_idx on admin_audit (retention_expires_at);

-- Progressive and reversible (§16.3). Nothing becomes permanent automatically:
-- every action carries an expiry or an explicit revocation.
create table if not exists enforcement (
  enforcement_id        uuid primary key,
  subject_key           text not null,             -- ipHash or clientHash
  action                text not null
                          check (action in ('warn', 'ratelimit', 'quarantine', 'suspend', 'ban')),
  reason                text not null,
  source                text not null check (source in ('automated', 'moderator')),
  created_at            timestamptz not null,
  expires_at            timestamptz,
  revoked_at            timestamptz,
  revoked_by            text,
  retention_expires_at  timestamptz not null
);

create index if not exists enforcement_subject_idx on enforcement (subject_key);
create index if not exists enforcement_expiry_idx on enforcement (retention_expires_at);
