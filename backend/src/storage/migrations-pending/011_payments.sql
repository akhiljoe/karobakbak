-- Payments — orders, the webhook ledger, and the premium entitlement.
--
-- Staged beside `010_accounts.sql` rather than in `migrations/`, because it
-- references `accounts` and because `PAYMENTS_ENABLED` is still false. Both
-- land together or neither does.
--
-- ---------------------------------------------------------------------------
-- WHY THERE IS AN ORDER TABLE AT ALL
-- ---------------------------------------------------------------------------
-- The obvious integration does without one: put the account id in the Razorpay
-- order notes, read it back off the webhook, grant premium to whoever it names.
-- That is the same mistake as a console route that accepts an identity hash
-- (§25.3) and the same mistake as reading a session id off a client frame
-- (protocol rule 3) — the subject of a state change arriving from outside.
--
-- The notes field is echoed by Razorpay, so it is not attacker-controlled in
-- the direct sense. But it is *set* from a request body, it survives a round
-- trip through a third party, and the only thing standing between "grant
-- premium to account X" and an attacker is that they would have to pay for it.
-- That is a business control, not a security one, and it fails the moment a
-- refund, a test-mode key or a partial capture enters the picture.
--
-- So the binding is written here, by us, at order-creation time, keyed on the
-- order id Razorpay generates. The webhook resolves the account by joining to
-- this row. Nothing about who gets premium is ever read from the network.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY NOT HERE
-- ---------------------------------------------------------------------------
-- No card number, no last four, no cardholder name, no billing address, no
-- email. Razorpay holds all of it and we never receive it — which is what lets
-- the Privacy Policy say the payment provider handles payment credentials
-- directly. A column here for any of it would make that sentence false, and
-- would drag this database into PCI scope it is currently outside of.
--
-- No free-text note column either. The Support page lets somebody type a note
-- that rides along to the payment provider, and that page already promises "We
-- do not store it". A column would be the obvious place to put it and the
-- promise would quietly stop being true.

-- ---------------------------------------------------------------------------
-- The entitlement lives in `017_premium_entitlement.sql`, already applied
-- ---------------------------------------------------------------------------
-- `premium_until` and its index used to be added here, which coupled writing an
-- entitlement to enforcing one. Enforcement was the half that was missing: the
-- column was written by the webhook below and read by nothing, while
-- preferences were gated on the process-wide `FILTERS_ENABLED`. Paying would
-- have changed nothing either way, and the first person to notice would have
-- been the first person to pay.
--
-- The column now ships ahead of payments so the gate can be tested closed —
-- with nothing purchasable, no account has a future deadline and no preference
-- is ever applied. Nothing in this file needs it to be here; the repository
-- writes a column that already exists.

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
create table if not exists payment_orders (
  -- Razorpay order id, not one of ours. It is the join key the webhook arrives
  -- with, and minting a second id beside it would mean a lookup table whose
  -- only purpose is to hide that fact.
  order_id             text primary key,

  -- Null for a donation, which is anonymous and grants nothing. Not null for
  -- anything that confers an entitlement — enforced by the check below, because
  -- "the order that grants premium knows whose premium it is" is the property
  -- this whole table exists for.
  account_id           text references accounts (id) on delete set null,

  -- The catalogue key. Validated against `payments/products.ts` on the way in;
  -- stored as text rather than an enum so adding a product is a code change and
  -- not a migration that locks the table.
  product              text not null,

  -- What we asked Razorpay to charge, in paise. Integer, never a float: money
  -- compared by a double is how a total ends up wrong by a rounding error,
  -- which is the same argument the persona spend counter makes.
  amount_paise         integer not null check (amount_paise > 0),

  currency             text not null default 'INR',

  -- created -> paid, or created -> failed, or paid -> refunded. A refund does
  -- not rewrite the fact that money moved; it adds a state after it.
  status               text not null default 'created'
                       check (status in ('created', 'paid', 'failed', 'refunded')),

  created_at           timestamptz not null default now(),
  paid_at              timestamptz,

  -- Stamped at insert, never computed at deletion time (D17). The period for a
  -- financial record is a statutory question and is longer than anything else
  -- in this schema — see row 22 of the decision register in
  -- `docs/policies/README.md`.
  --
  -- Seven years, chosen by the operator on 2026-09-04, and the deletion worker
  -- sweeps this table on it. Two years was considered and rejected: it sits
  -- below the periods usually cited for Indian tax and GST records, and a row
  -- deleted before somebody with a statutory right to see it asks for it is not
  -- a privacy win. Counsel can still shorten it — that is one environment
  -- variable — and nothing can recover rows deleted early.
  retention_expires_at timestamptz not null,

  -- An order that grants an entitlement must know who it grants it to.
  constraint payment_orders_entitlement_has_subject
    check (product = 'donation' or account_id is not null)
);

create index if not exists payment_orders_account_idx
  on payment_orders (account_id)
  where account_id is not null;

create index if not exists payment_orders_retention_idx
  on payment_orders (retention_expires_at);

-- ---------------------------------------------------------------------------
-- The webhook ledger
-- ---------------------------------------------------------------------------
-- Idempotency and audit in one table. Razorpay retries webhooks — documented
-- behaviour, not an edge case — and a retry must not grant a second month. The
-- primary key is the vendor payment id together with the event name, so a
-- duplicate delivery loses an insert race with itself and the fulfilment never
-- runs twice, while a capture and a later refund remain two rows about one
-- payment.
--
-- Append-only, enforced by the grant rather than by convention, for the same
-- reason `admin_audit` is (I11): a ledger the application can rewrite answers
-- no question anybody would ask it.
create table if not exists payment_events (
  payment_id           text not null,
  event                text not null,

  order_id             text not null references payment_orders (order_id) on delete cascade,

  -- What Razorpay says was actually moved, which is not necessarily what we
  -- asked for. The mismatch is the interesting case and is checked in code.
  amount_paise         integer not null,

  received_at          timestamptz not null default now(),

  primary key (payment_id, event)
);

create index if not exists payment_events_order_idx
  on payment_events (order_id);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
-- The chat role may create an order, record an event, and move `premium_until`.
-- It may not delete from either table, and the column-level grant on `accounts`
-- means it can set the entitlement without being able to touch `status` or
-- `risk_state` — the same shape as the persona spend ceiling, where the process
-- that spends may add to the counter and may not move the limit.
grant select, insert on payment_orders to karobakbak_app;
grant update (status, paid_at) on payment_orders to karobakbak_app;

-- Append-only. No update, no delete: this is the record that says a retry was
-- a retry.
grant select, insert on payment_events to karobakbak_app;

grant update (premium_until) on accounts to karobakbak_app;

-- The console reads payments to answer "did this person pay" during a support
-- or refund conversation. It may not write them: a moderator who can mint a
-- payment row can mint evidence that money moved.
grant select on payment_orders to karobakbak_console;
grant select on payment_events to karobakbak_console;
