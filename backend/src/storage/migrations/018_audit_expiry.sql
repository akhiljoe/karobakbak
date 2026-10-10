-- The audit log expires, and the chat role still cannot delete from it.
--
-- ---------------------------------------------------------------------------
-- THE DEFECT
-- ---------------------------------------------------------------------------
-- `002_roles.sql` gives `karobakbak_app` select and insert on `admin_audit` and
-- nothing else, on purpose: an audit log the process that writes it can also
-- rewrite is evidence of nothing (I11). The deletion worker, which runs as that
-- same role, then issued `delete from admin_audit ...` on every pass. PostgreSQL
-- checks privileges before it looks at a single row, so the statement failed
-- with 42501 every time — expired or not — and every pass ended there.
--
-- The steps before it (messages, conversations, reports, moderation events,
-- enforcement) had already run, so expired chat content was deleted on time.
-- What never ran: audit expiry, and the payment-order sweep after it. It failed
-- from the first deployment and was seen only when alert delivery first worked
-- (`RetentionDeletionFailing`, 2026-10-10). The integration suite connects as a
-- superuser, which is why it never failed there; deletion.test.ts now also runs
-- a pass as this role.
--
-- ---------------------------------------------------------------------------
-- WHY A FUNCTION RATHER THAN A GRANT
-- ---------------------------------------------------------------------------
-- `grant delete on admin_audit` would fix the pass and give the chat process
-- the power to erase any audit row, including the record of who read which
-- conversation — the one control left on browsing persona conversations
-- (D-AI-12) and the subject of D33. So the role gets a function instead, and
-- the function can do exactly one thing: remove rows whose own
-- `retention_expires_at` has passed. It takes no row identifiers and no
-- predicate. The append-only guarantee becomes "nothing can remove an audit row
-- before its deadline", which is the guarantee that mattered all along.
--
-- SECURITY DEFINER runs it with the migration role's rights. Two rules make
-- that safe, and both are applied below:
--
-- * The search path is pinned to this schema and then pg_temp, so a caller
--   cannot shadow `admin_audit` with a temporary table of the same name.
--   The schema is read at creation rather than written as `public`, because
--   the integration suite migrates every context into a schema of its own.
-- * EXECUTE is revoked from PUBLIC and granted to the chat role alone. The
--   console role is deliberately not granted it: the console must never be
--   able to remove audit rows, expired or not (D32).

do $migration$
declare
  target_schema text := current_schema();
begin
  execute format($fn$
    create or replace function expire_admin_audit(batch_size integer)
    returns integer
    language plpgsql
    security definer
    set search_path = %I, pg_temp
    as $body$
    declare
      removed integer;
    begin
      -- Bounded, so a caller cannot turn one call into an unbounded delete.
      if batch_size is null or batch_size < 1 then
        return 0;
      end if;
      delete from admin_audit
       where audit_id in (
         select audit_id
           from admin_audit
          where retention_expires_at < now()
          limit least(batch_size, 10000));
      get diagnostics removed = row_count;
      return removed;
    end
    $body$
  $fn$, target_schema);
end
$migration$;

revoke all on function expire_admin_audit(integer) from public;
grant execute on function expire_admin_audit(integer) to karobakbak_app;
