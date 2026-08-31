-- The external identity an account signs in with (§32, D48).
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A COLUMN AND NOT THE PRIMARY KEY
-- ---------------------------------------------------------------------------
-- The obvious shape is to use the provider's `sub` as `accounts.id` — one less
-- column, one less index, no join. It is refused for the reason the intake gave
-- when deciding where a payment attaches: "Cognito is the credential, not the
-- account."
--
-- `accounts.id` is generated here, by `util/ids.ts`, and payments reference it.
-- Handing that key to a vendor means the identifier the payment record is built
-- on is defined by a system this project does not control, and a provider
-- migration would rewrite every foreign key rather than one column. The extra
-- index is the cheapest insurance in the schema.
--
-- ---------------------------------------------------------------------------
-- ONE PROVIDER, DELIBERATELY UNNAMED
-- ---------------------------------------------------------------------------
-- There is no `provider` column and the vendor is not named here. Cognito is
-- the intended one and the schema describes plain OIDC, matching the way the
-- model adapters are split (D-AI-10): the vendor lives behind one seam.
--
-- A second provider is a **policy change before it is a schema change**. The
-- Privacy Policy names each processor individually and requires a 14-day
-- notice, so a `provider` column added "for later" would make a schema decision
-- ahead of a legal one. When that decision is taken, this becomes
-- (provider, subject) and the migration is three lines.
alter table accounts
  add column if not exists external_id text;

-- Unique, not the primary key. Two accounts resolving from one `sub` would mean
-- a sign-in that returns a different account depending on row order, which is
-- the kind of fault that shows up as "my friends disappeared".
--
-- Partial, because the column is null for every account that predates sign-in
-- and for any created by another route: a plain unique index would collapse
-- all of them into one.
create unique index if not exists accounts_external_id_idx
  on accounts (external_id)
  where external_id is not null;

comment on column accounts.external_id is
  'The OIDC subject from the single configured provider. Never the primary key '
  '— see the header of this migration.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The chat role reads it to resolve a session, and **inserts** an account,
-- because sign-in is the one path that creates one. It still may not close an
-- account or change its risk state — those stay moderation actions, which is
-- the split `010_accounts.sql` established and the same shape as the persona
-- spend ceiling: the process that spends may add to the counter and may not
-- move the limit.
grant insert on accounts to karobakbak_app;
grant update (external_id, last_seen_at) on accounts to karobakbak_app;
grant insert, delete on account_credentials to karobakbak_app;
grant update (last_used_at, revoked_at) on account_credentials to karobakbak_app;
