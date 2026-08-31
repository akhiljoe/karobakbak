-- Saved connections — mutual consent, and nothing about the conversation.
--
-- ---------------------------------------------------------------------------
-- THE LINE 010 SAID TO DEFEND IN REVIEW
-- ---------------------------------------------------------------------------
-- `010_accounts.sql` names it exactly: "if a foreign key from here to a
-- conversation ever appears, the separation is gone and so is the claim."
--
-- This is the table most likely to grow one, because the natural way to
-- describe the feature is "we met in conversation X and saved each other". It
-- has no `conversation_id`, no `match_id`, no session reference and no message
-- reference, and it never will. Two people are connected or they are not; where
-- it happened is not recorded, and recording it would build the per-person
-- history of who-talked-to-whom that §24.3 and D34 exist to prevent.
--
-- What is deliberately NOT here is as load-bearing as what is:
--
--   no conversation_id   where they met
--   no created_by        who asked first
--   no last_talked_at    an activity trail, and half a presence signal
--   no nickname          a label one person applies to another, unmoderated
--
-- `created_by` is the subtle one. It looks harmless and it is a record of who
-- initiated, which turns a symmetric relationship into an asymmetric one and
-- answers a question neither party agreed to answer.
--
-- ---------------------------------------------------------------------------
-- CANONICAL ORDERED PAIR
-- ---------------------------------------------------------------------------
-- A connection is symmetric, so the obvious shapes are both wrong. Two rows
-- (A,B) and (B,A) can disagree — one deleted and not the other leaves a
-- half-connection with no meaning. One unordered row needs every query to try
-- both column orders and every uniqueness check to be written by hand.
--
-- Storing the pair sorted, with the ordering enforced by a check constraint,
-- makes the primary key do the work: one row per relationship, a duplicate is a
-- constraint violation rather than a silent second row, and "are these two
-- connected" is a single index probe with no OR in it.
--
-- The ordering is on the opaque id and means nothing. It is not "first" or
-- "owner" — see `created_by` above for why that distinction is not recorded.
create table if not exists connections (
  -- Sorted so that lo < hi, always. Which id sorts lower is an accident of
  -- `crypto.randomBytes` and carries no meaning about either party.
  account_lo          text not null references accounts (id) on delete cascade,
  account_hi          text not null references accounts (id) on delete cascade,

  created_at          timestamptz not null default now(),

  primary key (account_lo, account_hi),

  -- Strict, not <=. An account cannot connect to itself: the pair would satisfy
  -- a <= check and produce a row that every "list my friends" query returns.
  constraint connections_ordered check (account_lo < account_hi)
);

-- "List everyone I am connected to" reads both columns, because a person may be
-- on either side of the pair. The primary key already serves `account_lo`, so
-- only the other direction needs its own index.
create index if not exists connections_hi_idx
  on connections (account_hi);

comment on table connections is
  'Mutually saved connections. Deliberately carries no reference to the '
  'conversation the two people met in — see the header of 010_accounts.sql.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The chat role inserts (both sides consented), selects (the friend list) and
-- deletes (somebody removed a friend). Delete is a hard delete rather than a
-- tombstone, and that is the privacy-respecting choice rather than a shortcut:
-- a `removed_at` column would keep a record of a relationship that one person
-- explicitly ended, which is a worse thing to hold than the connection was.
--
-- Row scoping is enforced in the application, as it is for every other table
-- here. A column grant cannot express "only rows naming you", and row-level
-- security for one table would be a second authorisation system to keep in step
-- with the first.
grant select, insert, delete on connections to karobakbak_app;

-- The console may read and remove, never create. A moderator severing a
-- connection is an enforcement action; a moderator manufacturing one is not an
-- action with any legitimate meaning, so the grant does not exist to be misused.
grant select, delete on connections to karobakbak_console;
