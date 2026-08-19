/**
 * A system line inside the transcript.
 *
 * ---------------------------------------------------------------------------
 * ONLY WHAT THE STATE ACTUALLY KNOWS
 * ---------------------------------------------------------------------------
 * The design this came from carried a longer list of these — the stranger
 * left, you skipped, nobody is around. Those are not rendered here, because
 * every one of them ends the conversation, and this transcript is cleared when
 * that happens (`clearedConversation` in the reducer). A line saying "your
 * stranger left" would be drawn into a list that is about to be emptied; the
 * landing screen says it instead, which is where the user actually is.
 *
 * That leaves the two that are true *while a conversation is open*, and both
 * are derived from state rather than recorded as events — so nothing has to be
 * appended to the message list, and the list stays exactly what the server
 * sent.
 */
type SystemKind = 'started' | 'reported';

const COPY: Record<SystemKind, string> = {
  started: 'You are now chatting with a stranger. Say hi.',
  reported: 'Reported. A reviewer has this conversation.',
};

export function SystemMessage({ kind }: { kind: SystemKind }): JSX.Element {
  return (
    <li className="my-3 flex animate-fade-in justify-center">
      <span className="rounded-full bg-ink-900/70 px-3 py-1 text-center text-xs text-ink-400 ring-1 ring-ink-800">
        {COPY[kind]}
      </span>
    </li>
  );
}
