-- When an account was last here, for the people it connected with (D65).
--
-- ---------------------------------------------------------------------------
-- THIS REVERSES "THERE IS NO LAST-SEEN", DELIBERATELY
-- ---------------------------------------------------------------------------
-- `016_connection_labels.sql` and `accounts/presence.ts` said there would never
-- be a last-seen, because "when were they last here" is a history of somebody's
-- habits rather than a fact about this moment. The operator decided otherwise:
-- a friends list that can only say "online" or nothing is one most people stop
-- opening. D65 records the reversal and the four limits that make it tolerable,
-- three of which are this column's shape:
--
--   * Coarse. Truncated to the hour when written, and only ever shown as a
--     bucket ("3 hours ago", "2 weeks ago") — the route never sends the value.
--   * Written only while the account shares presence, and cleared the moment
--     it stops. Hiding means not being remembered, the rule presence tokens
--     already follow.
--   * Seen only by connections, and only by connections who share their own
--     (enforced in the route, not here).
--   * At most one write per account per hour, gated in Redis, so the heartbeat
--     that carries it never waits on this table.
--
-- Not `last_seen_at`. That column already exists (010) and means the last
-- sign-in; it decides retention and is never shown to anybody. The two answer
-- different questions and are kept apart so neither changes meaning.
--
-- Nullable with no default: null is "nothing to show", which is the honest
-- value for every account that has not been here since this shipped.

alter table accounts add column if not exists last_active_at timestamptz;

comment on column accounts.last_active_at is
  'Start of the last hour this account was online while sharing presence. '
  'Null when hidden or never recorded. Shown to connections as a bucket only (D65).';

-- The heartbeat writes it and turning presence off clears it; both are the
-- chat role acting on the account's own behalf.
grant update (last_active_at) on accounts to karobakbak_app;
