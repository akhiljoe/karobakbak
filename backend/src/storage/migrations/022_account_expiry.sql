-- Dormant accounts are deleted (D66).
--
-- ---------------------------------------------------------------------------
-- WHAT WAS WRONG
-- ---------------------------------------------------------------------------
-- `010_accounts.sql` describes `retention_expires_at` as "stamped at insert and
-- extended on use", and indexes it for "the sweep". Neither half existed:
--
--   * Nothing extended it. A returning sign-in touched `last_seen_at` only.
--   * Nothing swept it. The deletion worker never read `accounts`.
--   * The stamp came from `PAYMENT_RECORD_RETENTION_DAYS` — seven years, a
--     bookkeeping period with no connection to how long an unused account and
--     the friendships hanging off it should outlive their owner.
--
-- So every account was kept for ever in practice, and a sweep added on its own
-- would have deleted every account — active or not — seven years after it was
-- made, friends and all, on a date nobody would be watching.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DOES
-- ---------------------------------------------------------------------------
-- The deadline now follows use: each sign-in restamps it to now plus
-- `AUTH_ACCOUNT_RETENTION_DAYS` (default 365). A sign-in is valid for at most
-- `AUTH_SESSION_TTL_SECONDS` (thirty days), so anybody still using the site
-- signs in again long before their account could lapse, and no write is needed
-- on ordinary visits. Stamped at the moment of use from the setting in force
-- then, which is D17's rule — never computed at deletion time.
--
-- The worker removes accounts past their deadline through `expire_accounts`,
-- because the chat role it runs as holds no delete on `accounts` and must not:
-- it is the same shape as `expire_admin_audit` (018). The cascade takes the
-- account's credentials, connections (so the friend loses the row too), its
-- labels in both directions, and its block records. Payment orders, once the
-- staged 011_payments.sql is applied, keep their row with the account set to
-- null, because a financial record outlives the account it was paid from.
--
-- Only `active` accounts are swept. A suspended account is a moderation
-- decision, and deleting it on dormancy would let somebody suspended wait out
-- the period and return under the same provider identity with a clean record.
-- `closed` is a tombstone with its own rule (010) and is left alone here.

-- Sign-in restamps it, as the chat role.
grant update (retention_expires_at) on accounts to karobakbak_app;

-- Existing accounts: from seven years after creation to a year after their last
-- sign-in, and never later than the deadline they already had. Shortening a
-- deadline is the direction D17 permits; this is the default the setting ships
-- with, written out because a migration cannot read configuration.
update accounts
   set retention_expires_at = least(retention_expires_at, last_seen_at + interval '365 days')
 where status = 'active';

do $migration$
declare
  target_schema text := current_schema();
begin
  execute format($fn$
    create or replace function expire_accounts(batch_size integer)
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
      delete from accounts
       where id in (
         select id
           from accounts
          where status = 'active'
            and retention_expires_at < now()
          limit least(batch_size, 10000));
      get diagnostics removed = row_count;
      return removed;
    end
    $body$
  $fn$, target_schema);
end
$migration$;

revoke all on function expire_accounts(integer) from public;
grant execute on function expire_accounts(integer) to karobakbak_app;
