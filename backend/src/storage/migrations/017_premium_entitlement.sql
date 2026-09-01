-- The premium entitlement, split out from the staged payments migration.
--
-- ---------------------------------------------------------------------------
-- WHY THIS LANDS BEFORE PAYMENTS DO
-- ---------------------------------------------------------------------------
-- `011_payments.sql` is staged in `migrations-pending/` and lands in the commit
-- that flips `PAYMENTS_ENABLED`. It used to add this column too, which coupled
-- two things that do not need to be coupled: *writing* an entitlement, which is
-- the payment provider's business, and *enforcing* one, which is matchmaking's.
--
-- Enforcement was the gap. `premium_until` was written by the webhook and read
-- by nothing — preferences were gated on `FILTERS_ENABLED`, a process-wide
-- flag, so paying changed nothing either way. That is the same shape as
-- `SPOOL_BACKEND=redis` accepted and ignored (F-006), and it would have been
-- discovered by the first person who paid.
--
-- Splitting the column out means the gate ships, is tested, and is provably
-- closed *before* anything can be bought: with no payments there is no row with
-- a future deadline, so every account reads as not premium and the preference
-- is never applied. Payments then start writing a column something already
-- reads, rather than the reverse.
--
-- ---------------------------------------------------------------------------
-- A DEADLINE, NOT A SUBSCRIPTION TABLE
-- ---------------------------------------------------------------------------
-- One entitlement, and it is a date. A table would model a billing history the
-- payment provider already holds authoritatively; this column answers the only
-- question the running server ever asks, which is whether this account is
-- premium right now.
--
-- Null means never subscribed. A past timestamp means lapsed. The two stay
-- distinguishable on purpose: a support conversation needs to tell them apart,
-- and a boolean would lose it.
alter table accounts add column if not exists premium_until timestamptz;

-- Partial, because the interesting set is small and stays small. A plain index
-- over a column that is null for almost every row is mostly a list of nulls.
create index if not exists accounts_premium_idx
  on accounts (premium_until)
  where premium_until is not null;
