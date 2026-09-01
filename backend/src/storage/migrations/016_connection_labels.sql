-- What you call somebody, and whether you appear online (§31).
--
-- ---------------------------------------------------------------------------
-- WHY A LABEL IS NOT A COLUMN ON `connections`
-- ---------------------------------------------------------------------------
-- `connections` is a canonical ordered pair with `check (lo < hi)` and nothing
-- else. `010_accounts.sql` refused `created_by` on it for a reason that applies
-- here twice over: it looks harmless and turns a symmetric relationship
-- asymmetric by answering who asked first.
--
-- A label is asymmetric by nature — it is *your* name for *them*, and they have
-- their own, and neither is visible to the other. Putting it on the pair row
-- would mean either one label shared between two people, which is wrong, or two
-- nullable columns whose meaning depends on which side of the pair you are,
-- which is worse. Its own table keeps the pair row exactly what it was.
--
-- ---------------------------------------------------------------------------
-- IT IS YOUR WORD, NOT THEIR IDENTITY
-- ---------------------------------------------------------------------------
-- This is the first thing stored that describes another person in words, and it
-- is deliberately the safest possible version: written by you, about somebody
-- you already agreed to connect with, shown only to you, and never sent to
-- them. It records nothing the provider told us and nothing they typed. If they
-- remove the connection it goes with it, because there is no relationship left
-- for a label to belong to.
--
-- It is not the declared profile and must never be fed from it. A name typed
-- into a chat is a claim the other person made about themselves (§26.4); this
-- is a note you made about them. Conflating the two would put somebody's own
-- words into a durable record they never agreed to.
create table if not exists connection_labels (
  owner_account_id  text not null references accounts (id) on delete cascade,
  other_account_id  text not null references accounts (id) on delete cascade,
  label             text not null check (length(label) between 1 and 40),
  updated_at        timestamptz not null default now(),

  -- One label per direction. The pair is not ordered here, unlike `connections`
  -- — the whole point is that (a → b) and (b → a) are different rows holding
  -- different words.
  primary key (owner_account_id, other_account_id),

  -- A label for yourself is not a thing. The connection table forbids self-pairs
  -- by its `lo < hi` check; this needs its own.
  check (owner_account_id <> other_account_id)
);

comment on table connection_labels is
  'What one account calls another. One-sided, never shown to the person it '
  'names, and deleted with the connection — see the header of this migration.';

-- ---------------------------------------------------------------------------
-- Appearing online
-- ---------------------------------------------------------------------------
-- Presence itself lives in Redis under a heartbeat TTL: it is true for seconds
-- at a time and there is nothing to keep. What is durable is the *choice*,
-- because a setting that resets on a restart is a setting nobody can rely on —
-- the same reasoning that keeps the persona kill switch in PostgreSQL rather
-- than only in Redis.
--
-- Default true, which is the weaker default and is chosen deliberately: the
-- feature is only useful if it usually works, and it is disclosed only to
-- people this user already agreed to connect with. The opt-out is one tap and
-- takes effect immediately, including removing presence already published.
--
-- What it hides is being online *now*. Nothing here records history: there is no
-- last-seen, and there will not be one — "when were they last here" is a
-- different and far more revealing claim than "are they here".
alter table accounts
  add column if not exists share_presence boolean not null default true;

comment on column accounts.share_presence is
  'Whether this account appears online to its connections. Hides presence now; '
  'no last-seen exists to hide.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- Both are things a user does to their own account, not moderation actions, so
-- the chat role owns them. It still may not touch `status` or `risk_state` —
-- the split `010_accounts.sql` drew and `storage.test.ts` asserts.
grant select, insert, update, delete on connection_labels to karobakbak_app;
-- `avatar` is deliberately absent from this list: the profile picture is not a
-- column. It is fetched at sign-in, cached in Redis as a URL and relayed by
-- this origin, because an avatar describes a person and a durable column would
-- make it the first stored field that does.
grant update (external_id, last_seen_at, share_presence) on accounts to karobakbak_app;
