-- Operator accounts for the moderation console (phase 13).
--
-- ---------------------------------------------------------------------------
-- WHY A SECOND ROLE AND NOT A GRANT TO THE APPLICATION
-- ---------------------------------------------------------------------------
-- These two tables hold the only credentials in the system: a password hash
-- and a TOTP secret that together are the login to everything retained. The
-- chat backend has no reason to read either, and giving it the grant would
-- mean a compromised chat process could mint itself an operator session and
-- then use it to read every conversation through the audited path — writing
-- plausible audit rows on its way.
--
-- So the console connects as `karobakbak_console`, a role that can read
-- conversations but cannot delete them, and the chat role is left with no
-- access to accounts at all. The two processes hold different credentials
-- because they are different trust levels, which is the same argument §8.1
-- already makes for keeping the migration role separate from both.
--
-- Neither role gets a password here. Credentials live in secret management,
-- never in a migration in git.
--
-- Idempotent, because migrations are re-run against existing databases.

create table if not exists admin_accounts (
  account_id            text primary key,
  -- Case-sensitive on purpose. A console with two accounts is already unusual;
  -- silently folding case would make `Alice` and `alice` the same login and
  -- the audit trail ambiguous about which human acted.
  username              text not null unique,
  -- `scrypt$N$r$p$salt$hash`. Parameters travel with the hash so the cost can
  -- be raised later without locking out an account created before the change.
  password_hash         text not null,
  -- Base32, as an authenticator app consumes it. A read of this column is a
  -- full compromise of the second factor, which is why the chat role has no
  -- select on this table.
  totp_secret           text not null,
  -- The last TOTP counter accepted. A code stays valid for a whole step and
  -- the verifier accepts one step of drift either side, so without this a code
  -- observed over someone's shoulder is replayable for up to ninety seconds.
  -- bigint because the counter passes 2^31 in the year 4000 — cheap now,
  -- impossible to migrate quietly later.
  totp_last_counter     bigint not null default 0,
  -- The ladder from security §29. Only `moderator` is issued today; the others
  -- exist so the audit rows written now are still meaningful when senior
  -- review and security investigation become separate scopes.
  role                  text not null default 'moderator'
                          check (role in ('moderator', 'senior_moderator', 'security_admin')),
  created_at            timestamptz not null,
  last_login_at         timestamptz,
  -- Disabling rather than deleting: an account that acted must remain
  -- resolvable from the audit rows it wrote, and `admin_audit` outlives
  -- everything else at 365 days.
  disabled_at           timestamptz,
  -- Throttling, so an exposed console cannot be ground down offline-style.
  -- Counted per account rather than per address: the console has no origin
  -- allowlist to lean on and an attacker rotating addresses is the expected
  -- case, not the exotic one.
  failed_attempts       integer not null default 0,
  locked_until          timestamptz
);

create table if not exists admin_sessions (
  -- The *hash* of the session cookie, never the cookie. Same reasoning as the
  -- password column: a database read — a backup, a support query, a replica —
  -- must not hand over the ability to act as a logged-in operator.
  token_hash            text primary key,
  account_id            text not null references admin_accounts on delete cascade,
  created_at            timestamptz not null,
  -- Absolute expiry, set at creation and never extended. A sliding window
  -- would keep a stolen cookie alive for as long as it was being used, which
  -- is precisely the case it needs to expire in.
  expires_at            timestamptz not null,
  last_seen_at          timestamptz not null,
  -- Set on logout and on a password change, so revocation is a fact in the
  -- table rather than a hope that the browser dropped the cookie.
  revoked_at            timestamptz
);

create index if not exists admin_sessions_account_idx on admin_sessions (account_id);
create index if not exists admin_sessions_expiry_idx on admin_sessions (expires_at);

-- ---------------------------------------------------------------------------
-- The console role
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'karobakbak_console') then
    create role karobakbak_console nologin;
  end if;
end
$$;

grant usage on schema public to karobakbak_console;

-- Its own accounts and sessions: full lifecycle, because logging in updates
-- the counter, the attempt count and the last-seen stamp.
grant select, insert, update, delete on admin_accounts, admin_sessions to karobakbak_console;

-- Retained content: read only. A moderator reviews conversations; deleting
-- them is the retention worker's job, running as the application role, driven
-- by deadlines stamped at insert time (D17). A console that could delete a
-- conversation could destroy the evidence in the case it was opened for.
grant select on conversations, messages to karobakbak_console;

-- Reports move through their state machine; moderation events are read as
-- triage context and written by the automated pipeline, not by a human.
grant select, update on reports to karobakbak_console;
grant select on moderation_events to karobakbak_console;
grant select on blocks to karobakbak_console;

-- Enforcement: issue and revoke. `update` rather than `delete` so a lifted ban
-- leaves `revoked_at` and `revoked_by` behind instead of vanishing.
grant select, insert, update on enforcement to karobakbak_console;

-- Append-only, by grant rather than by convention (I11). The console is the
-- main writer of this table and must not be able to edit what it wrote.
grant select, insert on admin_audit to karobakbak_console;

grant select on legal_holds to karobakbak_console;

revoke create on schema public from karobakbak_console;

-- The chat role gets nothing here, stated rather than left implicit so a later
-- `grant all` by habit reads as the mistake it would be.
revoke all on admin_accounts, admin_sessions from karobakbak_app;
