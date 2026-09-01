-- Attach a block to the account that made it, when there was one (§31).
--
-- ---------------------------------------------------------------------------
-- WHY THE ROW ALREADY EXISTED AND THIS IS ONE COLUMN
-- ---------------------------------------------------------------------------
-- `blocks` has been durable since `001_initial.sql`: every block is written to
-- PostgreSQL through the retention queue with both keys, its dimension and its
-- expiry. What was missing was never the record — it was a way to ask "which of
-- these are mine", because `blocker_key` is a salted hash of an IP or a client
-- token, and both of those change.
--
-- An account id does not. That is the whole of this migration: the one durable
-- identity in the system, recorded beside a block so the person who made it can
-- find it again from another network, another device, or after clearing a
-- cookie.
--
-- ---------------------------------------------------------------------------
-- NULLABLE, AND MOST ROWS WILL HAVE NONE
-- ---------------------------------------------------------------------------
-- Chatting requires no account and always will, so a block made while signed
-- out has no account to attach. Those rows keep working exactly as they do
-- today: enforced from Redis, expired by TTL, invisible to any list. The column
-- adds a capability for people who signed in and takes nothing from anybody who
-- did not.
--
-- It is the blocker's account and never the blocked person's. There is no
-- `blocked_account_id` and there must not be: the person being blocked may not
-- have an account, and resolving one for them would mean turning a pair of key
-- hashes into an identity — the cross-chat correlation §24.3 exists to prevent.
-- What is stored about them stays what was always stored: an opaque hash.
--
-- ---------------------------------------------------------------------------
-- IT IS A JUDGEMENT ABOUT SOMEBODY, ATTACHED TO A LASTING IDENTITY
-- ---------------------------------------------------------------------------
-- Worth saying plainly, because it is the first row of its kind. "Account X
-- blocked key Y" is a durable negative record about another person tied to a
-- name that persists — which every product with a block list holds, and which
-- this one has so far avoided by keeping blocks keyed to things that expire.
-- It gets its own line in the Privacy Policy's table for that reason.
--
-- It inherits the block's existing retention rather than acquiring its own: the
-- row is deleted when `expires_at` passes, exactly as before, so the account
-- link cannot outlive the block it describes.
alter table blocks
  add column if not exists blocker_account_id text references accounts (id) on delete cascade;

-- The only query this column exists to serve: "my blocks, still in force".
-- Partial, because the vast majority of rows have no account and indexing them
-- would be indexing an absence.
create index if not exists blocks_account_idx
  on blocks (blocker_account_id, expires_at)
  where blocker_account_id is not null;

comment on column blocks.blocker_account_id is
  'The account that made this block, when it was made while signed in. Never '
  'the blocked person''s account — see the header of this migration.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The chat role already inserts blocks. It now also deletes its own: unblocking
-- is a thing a user does to their own record, not a moderation action, and it
-- is a hard delete for the reason removing a connection is — a tombstone would
-- keep a record of a judgement somebody explicitly withdrew.
grant delete on blocks to karobakbak_app;
