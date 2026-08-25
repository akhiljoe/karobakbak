-- The persona spend ledger (D-AI-7, phase A4).
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS NOT A REDIS COUNTER
-- ---------------------------------------------------------------------------
-- The obvious implementation is INCRBY on a Redis key. It is also wrong here,
-- for the same reason the control switch is not a Redis key: persistence is off
-- (D12), so every key dies with a restart.
--
-- A spend counter that resets to zero on restart is not a budget. It is a
-- budget that silently refills, and the failure mode is the one that matters —
-- the ceiling stops binding exactly when something is wrong enough to have
-- restarted the process.
--
-- ---------------------------------------------------------------------------
-- WHY ONE ROW PER MONTH AND NOT ONE PER CALL
-- ---------------------------------------------------------------------------
-- A row per call is a better audit trail and a worse budget: reading the
-- current total becomes an aggregate over an unbounded table, on a path that
-- runs before every model call.
--
-- One row per month, updated atomically with `spent = spent + $1 RETURNING
-- spent`, makes the read and the write the same statement. It is correct across
-- instances without a lock, because PostgreSQL serialises the row update, and
-- it returns the new total so the caller learns immediately whether it has just
-- crossed the ceiling.
--
-- The per-call detail that a ledger would give lives in metrics instead
-- (`chat_persona_cost_micros_total` by provider and model), where it is a time
-- series rather than a table nobody prunes.
--
-- ---------------------------------------------------------------------------
-- WHY MICRO-CENTS AND A BIGINT
-- ---------------------------------------------------------------------------
-- Money is never a float here. One reply costs on the order of 80 micro-cents;
-- accumulating those in a double and comparing against a ceiling is how a
-- budget check ends up wrong by a rounding error in whichever direction nobody
-- wanted. A bigint of micro-cents holds a spend of ninety trillion dollars,
-- which is enough.

create table if not exists persona_spend (
  -- First day of the month, in UTC. A date rather than a text label so the
  -- ordering is real and a range query is possible later.
  --
  -- UTC rather than the operator's local month deliberately: the boundary must
  -- be the same on every instance, and "when does the month roll over" should
  -- not depend on which server answered.
  period          date        not null primary key,

  spent_micro_cents bigint    not null default 0,

  -- The ceiling in force for this period, copied in when the row is created.
  --
  -- Stored rather than read from config at check time so that lowering the
  -- limit mid-month cannot retroactively make past spending "over budget", and
  -- so the console can show what the ceiling actually was when something
  -- stopped. Changing it is an explicit update.
  limit_micro_cents bigint    not null,

  -- Set the first time the ceiling is reached, and never cleared within the
  -- period. Its presence is what the console shows and what an alert fires on.
  exhausted_at    timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint persona_spend_non_negative check (spent_micro_cents >= 0),
  constraint persona_spend_limit_positive check (limit_micro_cents > 0)
);

comment on table persona_spend is
  'Monthly AI persona spend against a ceiling (D-AI-7). Micro-cents; PostgreSQL is the truth because Redis has no persistence.';

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- The persona process runs under the chat role and must be able to add to the
-- total — that is the whole mechanism. It must NOT be able to change the
-- ceiling, which is what stops a compromised or buggy process from raising its
-- own limit.
--
-- Hence column-level grants: update on the counter, not on the limit. The
-- console can change the ceiling, because doing so is an operator decision that
-- belongs with the other audited ones.
grant select, insert on persona_spend to karobakbak_app;
grant update (spent_micro_cents, exhausted_at, updated_at) on persona_spend to karobakbak_app;

grant select, insert, update on persona_spend to karobakbak_console;
