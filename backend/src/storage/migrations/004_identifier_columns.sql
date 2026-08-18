-- Identifier columns become `text` (phase 11).
--
-- ---------------------------------------------------------------------------
-- WHY
-- ---------------------------------------------------------------------------
-- The initial schema declared every id `uuid`, and the design said
-- `conversation_id uuid -- equals matchId`. Those two statements were never
-- compatible: `util/ids.ts` generates 128 bits of `crypto.randomBytes` encoded
-- as base64url with a type prefix — `m_Muz7kC9O7-lEyLDpU_9HsQ`, not
-- `550e8400-e29b-41d4-a716-446655440000`. The `uuid` type was written in
-- revision 2, before the id format existed, and nothing had put a real id in
-- front of it until the compose stack ran under load.
--
-- The id format is the one that stays. base64url was chosen deliberately: it is
-- safe in a Redis key, a Pub/Sub channel name and JSON, it is shorter than a
-- UUID at the same entropy, and it carries a type prefix that makes a match id
-- distinguishable from a message id at a glance in a log line. The column type
-- is the thing that was wrong.
--
-- The ids stay validated — `keys.ts` refuses anything outside
-- `[A-Za-z0-9_-]{1,128}` before it can reach a Redis key, and every id in the
-- system comes from one generator. What is lost is PostgreSQL's own parse of
-- the format, which was rejecting every row the application actually wrote.

alter table messages drop constraint if exists messages_conversation_id_fkey;
alter table reports drop constraint if exists reports_conversation_id_fkey;

alter table conversations alter column conversation_id type text;

alter table messages alter column message_id type text;
alter table messages alter column conversation_id type text;

alter table reports alter column report_id type text;
alter table reports alter column conversation_id type text;

alter table blocks alter column block_id type text;
alter table blocks alter column conversation_id type text;

alter table moderation_events alter column event_id type text;
alter table moderation_events alter column conversation_id type text;
alter table moderation_events alter column message_id type text;

alter table enforcement alter column enforcement_id type text;
alter table admin_audit alter column audit_id type text;
alter table legal_holds alter column subject_id type text;

alter table messages
  add constraint messages_conversation_id_fkey
  foreign key (conversation_id) references conversations on delete cascade;

alter table reports
  add constraint reports_conversation_id_fkey
  foreign key (conversation_id) references conversations;
