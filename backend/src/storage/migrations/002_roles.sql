-- Least-privilege grants for the application role (§8.1).
--
-- This runs as the migration role. The application connects as a *different*,
-- lower-privileged role that can only touch these tables and can create
-- nothing — so a compromised application process cannot add a table, read
-- another database, or reach `pg_read_server_files`.
--
-- The role is created here rather than assumed, but its password is not set
-- here: credentials live in secret management, never in a migration in git
-- (§8.1). A deployment sets the password out of band, and the role is left
-- unable to log in until it does.
--
-- Idempotent, because migrations are re-run against existing databases.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'karobakbak_app') then
    create role karobakbak_app nologin;
  end if;
end
$$;

-- Connect and use the schema, and nothing beyond it.
grant usage on schema public to karobakbak_app;

grant select, insert, update, delete on
  conversations,
  messages,
  reports,
  blocks,
  moderation_events,
  enforcement
to karobakbak_app;

-- Append-only, enforced by the grant rather than by convention: the audit log
-- is worthless if the process that writes it can also rewrite it (I11).
grant select, insert on admin_audit to karobakbak_app;

-- Explicitly withheld, so the intent survives a future `grant all` by habit.
revoke create on schema public from karobakbak_app;
