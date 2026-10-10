-- An automated urgency reading for each report (D-AI-14).
--
-- ---------------------------------------------------------------------------
-- COLUMNS ON THE REPORT, NOT A TABLE BESIDE IT
-- ---------------------------------------------------------------------------
-- A triage verdict has no life of its own. It is about one report, it is read
-- only beside that report, and it must die when the report does. As columns it
-- inherits the report's retention deadline, legal hold and deletion for free;
-- as a table it would need its own deadline, its own expiry path and its own
-- grants, and every one of those is a place for the two to disagree.
--
-- ---------------------------------------------------------------------------
-- WHAT IS AND IS NOT STORED
-- ---------------------------------------------------------------------------
-- Numbers and closed labels only. Jev returns probabilities over options the
-- code defined, never text, so nothing here can carry content (I8). The
-- conversation was read to produce these, and that read is in `admin_audit`
-- (D33) with actor `system:jev-triage`.
--
-- Shadow mode: these are written and shown, and the queue is still ordered by
-- arrival unless `JEV_TRIAGE_SORT` says otherwise.

alter table reports add column if not exists triage_urgency    real;
alter table reports add column if not exists triage_category   text;
alter table reports add column if not exists triage_confidence real;
-- Probability that a participant stated or implied they are under 18.
alter table reports add column if not exists triage_minor      real;
alter table reports add column if not exists triage_model      text;
alter table reports add column if not exists triaged_at        timestamptz;
-- Failed attempts, so a report Jev cannot read is not retried forever.
alter table reports add column if not exists triage_attempts   smallint not null default 0;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reports_triage_urgency_range'
  ) then
    alter table reports add constraint reports_triage_urgency_range
      check (triage_urgency is null or (triage_urgency >= 0 and triage_urgency <= 3));
  end if;
end $$;

create index if not exists reports_untriaged_idx
  on reports (created_at) where state = 'OPEN' and triaged_at is null;
