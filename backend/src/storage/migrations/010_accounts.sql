-- Anonymous accounts — the foundation only (§41 phase 1).
--
-- ---------------------------------------------------------------------------
-- THIS TABLE IS THE THING THE REST OF THE DESIGN AVOIDS
-- ---------------------------------------------------------------------------
-- Every other part of this product is built so that no durable per-person
-- record exists. `DESIGN.md` §24.3 and D34 forbid one on the chat path
-- specifically, because a stable identifier across conversations is the
-- cross-chat correlator the whole anonymity claim rests on not having. The
-- declared profile is re-sent by the browser on every join for exactly that
-- reason, and the age acknowledgement is a local flag rather than a row.
--
-- This is that identifier. It is being added deliberately, and the only thing
-- that keeps the original property true is that **it is optional and separate**:
--
--   * Chatting never requires an account, and the anonymous path is unchanged.
--   * No column here references a session, a conversation or a message, and
--     nothing in the chat path writes to this table.
--   * A person with an account and a person without one are matched by the same
--     code, which cannot tell them apart.
--
-- If a foreign key from here to a conversation ever appears, the separation is
-- gone and so is the claim. That is the line to defend in review.
--
-- ---------------------------------------------------------------------------
-- WHAT PHASE 1 DELIBERATELY DOES NOT CONTAIN
-- ---------------------------------------------------------------------------
-- No friend requests, no connections, no recent-chat metadata, no email. Those
-- are phases 2 to 4 and each one widens what an account *knows*. Shipping the
-- entity first means the lifecycle, the credential and the abuse signals are
-- proven before anything hangs off them.
--
-- §42 lists what must never be built on top of this: searchable usernames,
-- public friend lists, activity feeds, follower graphs, contact import,
-- friend-of-friend suggestion. This table has no column that would support any
-- of them, which is the cheapest way to keep it that way.
--
-- ---------------------------------------------------------------------------
-- THE CONSEQUENCE THIS UNLOCKS, STATED SO IT IS NOT DISCOVERED LATER
-- ---------------------------------------------------------------------------
-- Accounts make reconnection possible, and reconnection is what the
-- minor-safety position on grooming detection currently rests on being
-- impossible: `docs/policies/` register #5 accepts no grooming detection
-- explicitly *because* a user cannot re-find a partner. The moment friend
-- requests ship (phase 3), that sentence becomes false and both
-- `minor-safety-policy.md` §6 and `DESIGN.md` §24.6 need rewriting in the same
-- change. Phase 1 alone does not break it — an account with no connections
-- still cannot find anybody.

create table if not exists accounts (
  -- Opaque, from `util/ids.ts`. Never sequential: an incrementing id leaks how
  -- many accounts exist and lets one be guessed from another.
  id                  text primary key,

  created_at          timestamptz not null default now(),

  -- Touched on use, and the input to the dormancy sweep below. Deliberately not
  -- an activity log: one timestamp cannot reconstruct when somebody was online,
  -- which a table of sessions could.
  last_seen_at        timestamptz not null default now(),

  -- active | suspended | closed.
  --
  -- `closed` is a tombstone rather than a delete, so a credential presented
  -- after closure resolves to a closed account instead of silently minting a
  -- new one. The row carries nothing about a person, so keeping it costs no
  -- privacy.
  status              text not null default 'active'
                      check (status in ('active', 'suspended', 'closed')),

  -- none | watch | restricted.
  --
  -- Set by moderation, read by matchmaking. Kept as a coarse state rather than
  -- a score: a number invites tuning against outcomes nobody measured, and a
  -- three-value column forces the question "what changes at each state" to be
  -- answered in code that can be read.
  risk_state          text not null default 'none'
                      check (risk_state in ('none', 'watch', 'restricted')),

  -- When this row may be removed if untouched. Stamped at insert and extended
  -- on use — never computed at deletion time, which is D17: a config change
  -- must not retroactively extend the life of data already stored.
  retention_expires_at timestamptz not null
);

-- The sweep reads this, so it is the index that matters. Partial, because
-- closed accounts are already tombstones and are removed on a different rule.
create index if not exists accounts_retention_idx
  on accounts (retention_expires_at)
  where status <> 'closed';

create index if not exists accounts_risk_idx
  on accounts (risk_state)
  where risk_state <> 'none';

-- ---------------------------------------------------------------------------
-- The credential
-- ---------------------------------------------------------------------------
-- One account may hold several, because a person may use two browsers. Each is
-- a bearer token and is treated the way the resume token already is (§28):
-- stored only as a hash, rotated on redemption, and expiring on its own.
--
-- The plaintext token exists in exactly two places — the browser that holds it
-- and the response that issued it. It is never logged, and there is no column
-- here that could hold it.
create table if not exists account_credentials (
  -- SHA-256 of the bearer token. The primary key *is* the hash, so a lookup is
  -- a hash comparison and there is no path that reads a credential by account.
  token_hash          bytea primary key,

  account_id          text not null references accounts (id) on delete cascade,

  created_at          timestamptz not null default now(),
  last_used_at        timestamptz,

  -- Absolute, not sliding. A credential that renews itself on every use never
  -- expires for an active user, which is the property an attacker who stole one
  -- benefits from most.
  expires_at          timestamptz not null,

  -- Set rather than deleted, so a presented-after-revocation token is
  -- distinguishable from one that never existed. The two want different
  -- responses and only one of them is interesting.
  revoked_at          timestamptz
);

create index if not exists account_credentials_account_idx
  on account_credentials (account_id);

create index if not exists account_credentials_expiry_idx
  on account_credentials (expires_at)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The chat role may read an account and touch `last_seen_at`, because rate
-- limiting and matchmaking need to know an account exists and what state it is
-- in. It may **not** create, close or change risk — those are moderation
-- actions, and a chat process that can raise or lower its own risk state does
-- not have one.
--
-- Same shape as the persona spend ceiling: the process that spends may add to
-- the counter and may not move the limit.
grant select on accounts to karobakbak_app;
grant update (last_seen_at) on accounts to karobakbak_app;
grant select on account_credentials to karobakbak_app;
grant update (last_used_at) on account_credentials to karobakbak_app;

grant select, insert, update, delete on accounts to karobakbak_console;
grant select, insert, update, delete on account_credentials to karobakbak_console;
