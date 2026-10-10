-- Where a signed-in browser's profile picture lives, on the credential.
--
-- ---------------------------------------------------------------------------
-- WHY IT MOVED OUT OF REDIS
-- ---------------------------------------------------------------------------
-- The provider's picture URL used to be cached in Redis under the session's
-- TTL. Redis has persistence off (D12), and production runs on a laptop that
-- restarts as a matter of routine — so every restart left every signed-in
-- person signed in (the credential is here) and faceless (the URL was not),
-- until they signed out and in again. Nothing told them why.
--
-- ---------------------------------------------------------------------------
-- WHY ON THE CREDENTIAL, NOT THE ACCOUNT
-- ---------------------------------------------------------------------------
-- `accounts` deliberately holds nothing describing a person. A credential is
-- one browser's sign-in: it already expires on its own, is revoked on sign-out,
-- and two browsers hold two of them. The URL inherits all of that. It is the
-- address of an image on the provider's CDN, never the image — the bytes are
-- still relayed on demand and stored nowhere (`accounts/avatar.ts`).
--
-- It is cleared rather than kept once the credential is dead: on sign-out by
-- `revokeCredential`, and on expiry by the deletion worker, because credential
-- rows themselves are kept after revocation (010_accounts.sql) and the picture
-- has no reason to be. Both are updates of this one column, which is all the
-- chat role is granted below.

alter table account_credentials add column if not exists picture_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'account_credentials_picture_url_shape'
  ) then
    -- https and bounded. The route re-checks the host against its allowlist
    -- before fetching; this only keeps the column from holding anything else.
    alter table account_credentials add constraint account_credentials_picture_url_shape
      check (picture_url is null or (picture_url like 'https://%' and length(picture_url) <= 2048));
  end if;
end $$;

-- Sign-out clears it; the insert grant (014) already covers setting it.
grant update (picture_url) on account_credentials to karobakbak_app;

create index if not exists account_credentials_dead_picture_idx
  on account_credentials (expires_at) where picture_url is not null;
