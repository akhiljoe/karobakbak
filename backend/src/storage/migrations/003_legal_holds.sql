-- Legal holds (§15).
--
-- The `legal_hold` boolean on a retained row answers "may the deletion worker
-- touch this". It cannot answer "who placed this, under what case, and why" —
-- and a hold nobody can attribute is how "retain everything forever because
-- someone might ask" starts. So the boolean stays as the fast predicate the
-- deletion query reads, and every hold that sets it has a row here with an
-- owner, a case id and a justification.
--
-- Releasing a hold restores the normal expiry rather than deleting the row: the
-- record that data *was* held, by whom and why, outlives the hold itself.

create table if not exists legal_holds (
  hold_id               uuid primary key,
  subject_type          text not null
                          check (subject_type in ('conversation', 'message', 'report')),
  subject_id            uuid not null,
  case_id               text not null,
  owner                 text not null,
  -- Mandatory, like the audit log's. A hold without a stated reason is a hold
  -- nobody can review.
  justification         text not null,
  created_at            timestamptz not null,
  released_at           timestamptz,
  released_by           text
);

-- The predicate the release path asks: "is anything else still holding this?"
create index if not exists legal_holds_active_idx
  on legal_holds (subject_type, subject_id) where released_at is null;
create index if not exists legal_holds_case_idx on legal_holds (case_id);

grant select, insert, update on legal_holds to karobakbak_app;
