-- What each side declared about themselves (phase 14).
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS STORED AT ALL
-- ---------------------------------------------------------------------------
-- A report is frequently *about* the declaration. "They said they were 19",
-- "they claimed to be in my city", "the name was a phone number" — none of
-- those are answerable from the transcript alone, because the declaration never
-- appears in a message. Without these columns a moderator reads a conversation
-- and cannot see the thing being complained about.
--
-- ---------------------------------------------------------------------------
-- WHAT IT IS NOT
-- ---------------------------------------------------------------------------
-- Not an attribute of a person. Every value here was typed by an anonymous
-- stranger with no verification of any kind, and `age` in particular is **not
-- age assurance** (security §24). The console renders these as "declared:", and
-- any future code that reads them must treat them as a claim.
--
-- `name` is user-generated content and carries a message body's protection
-- class (I8): never a log line, never a metric label, never an error message.
--
-- ---------------------------------------------------------------------------
-- WHY JSONB AND NOT SIX COLUMNS
-- ---------------------------------------------------------------------------
-- The declaration is a single thing that is read and rendered whole, never
-- queried field by field — there is no "find conversations where age > 30",
-- and there must not be one, because that would be an analytics view over
-- unverified claims about people. One column per side keeps the row readable
-- and means adding a declared field later is not another migration on a table
-- that holds every conversation.
--
-- No index, deliberately. An index here would exist to search by declaration,
-- which is exactly the query this data should not make easy.
--
-- Idempotent, because migrations are re-run against existing databases.

alter table conversations add column if not exists profile_a jsonb;
alter table conversations add column if not exists profile_b jsonb;

comment on column conversations.profile_a is
  'Self-declared, unverified claims by session_a. Not identity, not age assurance.';
comment on column conversations.profile_b is
  'Self-declared, unverified claims by session_b. Not identity, not age assurance.';
