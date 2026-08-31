import { COUNTRY_NAMES } from '../protocol/types';

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
  started: 'Connected to a stranger. Say hi.',
  reported: 'Reported. A reviewer has this conversation.',
};

/**
 * Where they are connecting from, when the edge could tell us.
 *
 * The country is resolved from the connection rather than declared (protocol
 * rule 3), which makes it the one thing on screen about a stranger that they
 * did not choose — and the only one worth putting in an opening line for that
 * reason. It is still not proof of anything: a VPN moves it, and no copy here
 * may suggest otherwise.
 *
 * Null on a laptop, where there is no CDN to set the header, so the line has to
 * read correctly without it rather than treat its absence as a gap.
 */
export function SystemMessage({
  kind,
  country,
}: {
  kind: SystemKind;
  country?: string | null;
}): JSX.Element {
  const text =
    kind === 'started' && country
      ? `Connected to someone in ${COUNTRY_NAMES[country as keyof typeof COUNTRY_NAMES] ?? country}. Say hi.`
      : COPY[kind];

  return (
    <li className="my-3 flex animate-fade-in justify-center">
      <span className="rounded-full bg-ink-900/70 px-3 py-1 text-center text-xs text-ink-400 ring-1 ring-ink-800">
        {text}
      </span>
    </li>
  );
}
