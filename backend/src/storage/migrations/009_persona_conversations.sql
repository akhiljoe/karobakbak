-- Which conversations had a persona in them (D-AI-12, phase A6).
--
-- ---------------------------------------------------------------------------
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON `conversations`
-- ---------------------------------------------------------------------------
-- The chat server does not know a persona exists, and that is the whole of
-- D-AI-6: a persona is an ordinary client, matched by the ordinary path, with
-- no branch anywhere in matchmaking. Adding an `is_persona` column would mean
-- the server learning to tell them apart, which is the coupling the design
-- spent a phase avoiding.
--
-- The persona process knows perfectly well what it is, and it knows the
-- conversation id because `conversationId` is the match id it was handed. So it
-- writes its own row, here, and nothing on the chat path changes.
--
-- ---------------------------------------------------------------------------
-- NO USER CONTENT, DELIBERATELY
-- ---------------------------------------------------------------------------
-- Nothing in this table is anything the stranger typed. `surface` is the
-- persona's own generated identity — a name this service invented — and the
-- rest is counts, cost and flags. The transcript lives in `messages` and is
-- reached the audited way.
--
-- That distinction matters for what this table is *for*: it is an index, so the
-- console can answer "show me persona conversations" without scanning every
-- conversation and guessing.
--
-- ---------------------------------------------------------------------------
-- WHY NO FOREIGN KEY
-- ---------------------------------------------------------------------------
-- The obvious `references conversations(conversation_id) on delete cascade`
-- would give free expiry, and it would also break constantly. Conversation rows
-- arrive through the write-behind path (D16) and may not have landed when the
-- persona writes this. That is exactly F-032, where one message whose parent
-- had not arrived destroyed every record sharing its batch.
--
-- So the deadline is stamped here at insert instead, the way every other
-- retained table does it (D17) — never computed at deletion time, because that
-- would let a config change retroactively extend the life of stored data.

create table if not exists persona_conversations (
  -- The match id. Equal to `conversations.conversation_id`, joined at read time
  -- rather than enforced, for the reason above.
  conversation_id   text        not null primary key,

  -- Which character, from `characters.ts`. A source constant, never user input.
  persona_id        text        not null,

  -- The generated surface: name, age, gender, country (D-AI-3). Ours, not
  -- theirs. Stored so the console can show what the stranger actually saw,
  -- which is otherwise unrecoverable — the surface is regenerated per
  -- conversation and kept nowhere else.
  surface           jsonb,

  -- Which session in the transcript was the persona.
  --
  -- Without it the console cannot tell the two sides apart, and a transcript
  -- with the speakers swapped is worse than none: it would attribute the
  -- stranger's words to the operator and vice versa, in the one view whose
  -- whole purpose is judging what the persona said.
  --
  -- Ephemeral and useless outside this row: session ids are per-connection, and
  -- this one expires with the record.
  persona_session_id text,

  provider          text,
  model             text,

  started_at        timestamptz not null default now(),
  ended_at          timestamptz,
  replies           integer     not null default 0,
  cost_micro_cents  bigint      not null default 0,

  -- Which of the six D-AI-5 limits fired, by name. An array rather than a join
  -- table: it is read whole, never queried element by element, and the set is
  -- closed at six.
  limits_tripped    text[]      not null default '{}',

  -- Set when a limit that needs a person to look at it fired — a minor signal
  -- or a crisis. What the console sorts by.
  flagged           boolean     not null default false,

  -- Stamped at insert (D17). Matches the conversation's own window so this
  -- index cannot outlive the thing it indexes: a durable record of who spoke to
  -- a persona, surviving the transcript, would be the cross-conversation
  -- correlator §24.3 forbids.
  retention_expires_at timestamptz not null,

  constraint persona_conversations_replies_non_negative check (replies >= 0),
  constraint persona_conversations_cost_non_negative check (cost_micro_cents >= 0)
);

comment on table persona_conversations is
  'Index of conversations that had an AI persona in them (D-AI-12). No user content; the transcript is reached through the audited path.';

-- The console lists flagged first, then most recent. One index serves both.
create index if not exists persona_conversations_flagged_started_idx
  on persona_conversations (flagged desc, started_at desc);

-- The deletion worker's sweep.
create index if not exists persona_conversations_expiry_idx
  on persona_conversations (retention_expires_at);

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- The persona process writes it and the deletion worker clears it, both under
-- the chat role. The console reads it and never writes: a console that could
-- edit this could unflag a conversation somebody needed to look at.
grant select, insert, update, delete on persona_conversations to karobakbak_app;
grant select on persona_conversations to karobakbak_console;
