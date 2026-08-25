-- The persona kill switch (D-AI-9, phase A2).
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A TABLE AND NOT A REDIS KEY
-- ---------------------------------------------------------------------------
-- Redis runs with persistence off (D12), deliberately, so that no Redis
-- structure — including a Pub/Sub payload — can reach disk. Every key dies with
-- a restart.
--
-- For live matchmaking state that is correct: it is reconstructible and the
-- clients reconnect. For a switch that governs spending money it is a trap in
-- both directions. A switch stored only in Redis returns to its compiled-in
-- default on restart, which means either personas silently turn themselves back
-- on after somebody turned them off, or they silently stay off after somebody
-- turned them on. Both are discovered late and neither announces itself.
--
-- So PostgreSQL is the source of truth and Redis is a cache, exactly as bans
-- are (D31). The reconciler replays this table at startup and on an interval.
--
-- ---------------------------------------------------------------------------
-- WHY ONE TABLE FOR THREE LEVERS
-- ---------------------------------------------------------------------------
-- Global, per-character and per-provider are the same question asked about
-- different subjects: "may this thing run?". Three tables would triple the
-- reconciler, the cache and the audit surface to express one idea.
--
-- Active hours are deliberately NOT here. A schedule is an operating setting
-- that changes when the traffic pattern changes, not a lever anybody reaches
-- for at 2am, and `loadConfig` is where settings live in this codebase.
--
-- ---------------------------------------------------------------------------
-- ABSENCE MEANS ENABLED, AND THAT IS NOT THE FAIL-OPEN IT LOOKS LIKE
-- ---------------------------------------------------------------------------
-- A missing row means "not disabled". The fail-closed behaviour lives one level
-- up: if the control state cannot be *read* at all, no persona joins. That is a
-- different condition from "read successfully, found nothing", and conflating
-- them would mean writing a row for every character just to say nothing is
-- wrong.

create table if not exists persona_control (
  -- 'global' | 'character' | 'provider'. Checked in application code rather
  -- than by an enum type, so adding a scope is not a migration on a live table.
  scope         text        not null,

  -- The character id or provider name. Empty string for the global switch,
  -- rather than null, so the primary key stays simple and a global row cannot
  -- be duplicated.
  subject       text        not null,

  enabled       boolean     not null,

  -- 'drain' | 'hard'. How a disable behaves for conversations already running.
  --
  -- 'drain' stops new joins and lets live conversations finish, because ending
  -- a conversation mid-sentence looks like a bug to the person on the other end
  -- and destroys the thing the feature exists to create. It mirrors
  -- `holdSeat: !draining` in the WebSocket close handler.
  --
  -- 'hard' ends them immediately, for when that is the point.
  mode          text        not null default 'drain',

  updated_at    timestamptz not null default now(),

  -- Who flipped it. An admin username, or 'system' for the boot-time default.
  -- Never a user identifier: nothing a chat user does reaches this table.
  updated_by    text        not null,

  -- Free text from the operator. Not user content, so it carries no I8
  -- protection class — but it is written by a human and shown in the console,
  -- so it is length-capped rather than unbounded.
  reason        text,

  primary key (scope, subject),

  constraint persona_control_scope_known
    check (scope in ('global', 'character', 'provider')),
  constraint persona_control_mode_known
    check (mode in ('drain', 'hard')),
  constraint persona_control_global_has_no_subject
    check (scope <> 'global' or subject = ''),
  constraint persona_control_subject_present
    check (scope = 'global' or length(subject) between 1 and 64),
  constraint persona_control_reason_bounded
    check (reason is null or length(reason) <= 500)
);

comment on table persona_control is
  'Enable/disable switches for AI personas (D-AI-9). PostgreSQL is the source of truth; Redis caches it.';

-- The reconciler reads every row on every pass, and the table has single-digit
-- rows, so no index beyond the primary key earns its keep.

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- The chat role reads the switch on the join path and must never write it: a
-- compromised chat process should not be able to turn personas on.
--
-- The console role writes it, because flipping the switch is a moderation
-- action and belongs with the other audited ones. This mirrors the split
-- asserted in tests/integration/storage.test.ts, where the app role is denied
-- admin_accounts outright and the console role cannot delete a conversation.
grant select on persona_control to karobakbak_app;
grant select, insert, update on persona_control to karobakbak_console;

-- The global switch starts **disabled**.
--
-- A feature that spends money per message must not become active because a
-- migration ran. Turning personas on is a deliberate act with a name attached
-- to it, and this row is what makes the first such act visible in the audit
-- trail rather than implicit in a deploy.
insert into persona_control (scope, subject, enabled, mode, updated_by, reason)
values ('global', '', false, 'drain', 'system', 'Personas start disabled; enable deliberately.')
on conflict (scope, subject) do nothing;
