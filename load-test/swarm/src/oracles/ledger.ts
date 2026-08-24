/**
 * Oracle 1 — pair reconstruction.
 *
 * ---------------------------------------------------------------------------
 * THE STRONGEST CHECK IN THE HARNESS, AND IT NEEDS NO SERVER ACCESS
 * ---------------------------------------------------------------------------
 * Both halves of a conversation receive the same `matchId`. The swarm owns both
 * halves. So for every match in the run, the messages one side was acked for
 * can be lined up against the messages the other side received, and any
 * disagreement is a delivery bug: a reorder, a duplicate, a message delivered
 * into the wrong conversation, or a message the server said it accepted and
 * never handed over.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS A FAILURE AND WHAT IS MERELY TRUE
 * ---------------------------------------------------------------------------
 * A receiver that leaves mid-conversation will not have received the sender's
 * last messages. That is correct behaviour, and asserting strict equality would
 * turn every rage quit into a red run. So the rule is **prefix, not equality**:
 * what the receiver got must be exactly the beginning of what the sender was
 * acked for, in order. Missing tail is counted and reported; a wrong element at
 * any shared position is a failure.
 *
 * Two things are failures with no tolerance at all:
 *   - the same `messageId` received twice (I6/I14 — delivery is once)
 *   - a message received for a `matchId` this bot was never matched into,
 *     which would mean routing crossed a conversation boundary
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import { profileHash } from '../declared';
import type { LedgerEvent } from '../ledger';
import type { OracleResult } from './types';

/** One message the sender was acked for, in send order. */
interface Sent {
  hash: string;
  /** When it was acked. Compared against the partner's socket downtime. */
  t: number;
  /**
   * False when the ack cannot be read as proof of arrival: the socket died
   * holding it, or the partner's seat was being held when it was sent (§28,
   * D43). The receiver is allowed not to have these, and only these.
   *
   * Set from two sources, because neither is sufficient alone. The sender's own
   * `unconfirmed` flag knows only what the sender had been *told* — and it is
   * told by a `partner_reconnecting` frame that takes a round trip to arrive.
   * A message handed to the socket in that gap is acked `delivered: true`,
   * reaches nobody, and carries no flag. The second source closes it: the
   * partner's own ledger says when their socket was down, and anything acked
   * inside that window could not have been delivered. See `downWindows`.
   */
  confirmed: boolean;
}

/** A stretch of time during which one bot had no socket. */
interface Down {
  from: number;
  to: number;
}

/**
 * How far *before* a recorded `closed` a send is still treated as uncertain.
 *
 * The close event is when the **bot** noticed, which lags the socket actually
 * becoming unusable: the run that produced this constant had a message acked
 * 10 ms before its partner recorded the close, and delivered to nobody.
 *
 * 500 ms is roughly ten times the p99 ack latency of a loaded run and well
 * under any persona's think time, so it covers the lag without swallowing a
 * message that had a real conversation happening around it. It is a tolerance,
 * and it is the only one in this oracle: everything outside a partner's
 * downtime is still held to strict order.
 */
const CLOSE_LAG_MS = 500;

interface Side {
  /** Messages the server acked as delivered, in send order. */
  delivered: Sent[];
  /** Hashes of messages this side received, in arrival order. */
  received: string[];
  /** Server message ids received, for the duplicate check. */
  receivedIds: string[];
  /** True when this side ended the conversation itself. */
  endedItself: boolean;
}

interface Match {
  sides: Map<string, Side>;
}

export interface LedgerStats {
  events: number;
  bots: number;
  matches: number;
  messagesSent: number;
  messagesAcked: number;
  /** Acked with `delivered: false` — moderation action `withhold` (D20). */
  messagesWithheld: number;
  /**
   * Refused with `MESSAGE_WITHHELD` — moderation action `block`, the hard rule
   * set. A different code path from the one above and a different number: the
   * sender gets an error rather than an ack, so it never appears in
   * `messagesWithheld` and a report that printed only that one would claim
   * nothing was withheld during a run where hundreds of messages were.
   */
  messagesBlocked: number;
  messagesReceived: number;
  ackLatency: number[];
  matchLatency: number[];
  errorsByCode: Map<string, number>;
  connectRefusals: Map<string, number>;
  routes: Map<string, number>;
  harnessErrors: number;
  /* --- session resumption (section 28, D42) ------------------------------ */
  /** Handshakes that presented a resume token. */
  resumesOffered: number;
  /** Resumes that came back with the conversation attached. */
  resumesSucceeded: number;
  /**
   * Resumes that opened a fresh session instead.
   *
   * Not a failure — a stale token is the common case and the designed answer to
   * it is a new session. Worth watching as a *ratio*: a high one means the
   * grace window is shorter than the reconnections people actually make, and
   * every one of those was a conversation that ended when it did not have to.
   */
  resumesExpired: number;
  /** Times this population was told a partner's seat was being held. */
  partnersHeld: number;
  /** Times a held partner came back. */
  partnersReturned: number;
  /** Messages whose ack could never arrive because the socket died first. */
  acksLost: number;
}

export interface LedgerAnalysis {
  stats: LedgerStats;
  oracle: OracleResult;
  /** Oracle 6 — see `analyseLedger`. Skipped when nobody declared anything. */
  profiles: OracleResult;
}

function side(match: Match, bot: string): Side {
  let existing = match.sides.get(bot);
  if (!existing) {
    existing = { delivered: [], received: [], receivedIds: [], endedItself: false };
    match.sides.set(bot, existing);
  }
  return existing;
}

/**
 * What one bot declared, and what its partner was shown, for one match.
 *
 * Hashes throughout — see `ledger.ts`. The check is triangular and each leg
 * fails differently:
 *
 *   declared -> `you`      the server kept what this bot sent on `join_queue`
 *   `you`    -> partner's  the same profile reached the other side's identity
 *
 * A break in the first leg is validation or storage losing a field. A break in
 * the second is the matchmaking read handing one side a stale or crossed
 * profile — which, in a product where the profile is the only thing one
 * stranger knows about another, is the worst of the two.
 */
interface Declaration {
  /** Hash of the profile this bot sent on its most recent `join_queue`. */
  declared: string | undefined;
  /** Hash of `you.profile` in the `matched` frame. */
  echoed: string | undefined;
  /** Hash of `partner.profile` in the `matched` frame. */
  sawPartner: string | undefined;
}

export async function analyseLedger(paths: readonly string[]): Promise<LedgerAnalysis> {
  const matches = new Map<string, Match>();
  const bots = new Set<string>();
  /** Every (bot, matchId) the server actually told this bot about. */
  const membership = new Set<string>();
  const stats: LedgerStats = {
    events: 0,
    bots: 0,
    matches: 0,
    messagesSent: 0,
    messagesAcked: 0,
    messagesWithheld: 0,
    messagesBlocked: 0,
    messagesReceived: 0,
    ackLatency: [],
    matchLatency: [],
    errorsByCode: new Map(),
    connectRefusals: new Map(),
    routes: new Map(),
    harnessErrors: 0,
    resumesOffered: 0,
    resumesSucceeded: 0,
    resumesExpired: 0,
    partnersHeld: 0,
    partnersReturned: 0,
    acksLost: 0,
  };

  const strayDeliveries: string[] = [];
  const duplicateDeliveries: string[] = [];
  /** The profile each bot most recently sent on `join_queue`. */
  const lastDeclared = new Map<string, string>();
  /** When each bot had no socket, in order. Closed by the next `connected`. */
  const downWindows = new Map<string, Down[]>();
  /** One entry per (bot, match) that reported identities. */
  const declarations = new Map<string, Declaration>();

  for (const path of paths) {
    const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const raw of reader) {
      if (raw.length === 0) continue;
      let event: LedgerEvent;
      try {
        event = JSON.parse(raw) as LedgerEvent;
      } catch {
        // A truncated final line is what a killed worker leaves behind.
        continue;
      }
      stats.events += 1;
      bots.add(event.bot);

      const match = ((): Match | null => {
        if (event.matchId === undefined) return null;
        let existing = matches.get(event.matchId);
        if (!existing) {
          existing = { sides: new Map() };
          matches.set(event.matchId, existing);
        }
        return existing;
      })();

      switch (event.type) {
        case 'connected': {
          // Closes whichever downtime this connection ended. A bot's first
          // `connected` has no open window, which is why this is guarded.
          const windows = downWindows.get(event.bot);
          const open = windows?.[windows.length - 1];
          if (open && open.to === Number.POSITIVE_INFINITY) open.to = event.t;
          break;
        }

        case 'queued':
          if (event.hash !== undefined) lastDeclared.set(event.bot, event.hash);
          break;

        case 'matched':
          if (match && event.matchId !== undefined) {
            membership.add(`${event.bot}|${event.matchId}`);
            if (event.myProfile !== undefined || event.theirProfile !== undefined) {
              declarations.set(`${event.bot}|${event.matchId}`, {
                declared: lastDeclared.get(event.bot),
                echoed: event.myProfile,
                sawPartner: event.theirProfile,
              });
            }
            // Register the side when the pair forms, not on its first message.
            // A conversation where nobody spoke is still one this harness saw
            // both halves of, and counting it as "one-sided" would bury the
            // cases where a half is genuinely missing under dozens that are
            // simply quiet.
            side(match, event.bot);
            if (event.ms !== undefined) stats.matchLatency.push(event.ms);
          }
          break;

        case 'sent':
          stats.messagesSent += 1;
          break;

        case 'ack': {
          stats.messagesAcked += 1;
          if (event.ms !== undefined) stats.ackLatency.push(event.ms);
          if (event.route) stats.routes.set(event.route, (stats.routes.get(event.route) ?? 0) + 1);
          // `withheld` only. `undelivered` is not a moderation outcome — the
          // message was allowed and nobody was there — and folding the two
          // together would report a held seat as a policy action.
          if (event.ackStatus === 'withheld') {
            stats.messagesWithheld += 1;
            break;
          }
          if (match && event.hash) {
            side(match, event.bot).delivered.push({
              hash: event.hash,
              t: event.t,
              confirmed: event.unconfirmed !== true,
            });
          }
          break;
        }

        case 'received': {
          stats.messagesReceived += 1;
          if (!match || event.matchId === undefined) break;
          if (!membership.has(`${event.bot}|${event.matchId}`)) {
            strayDeliveries.push(`${event.bot} received a message for ${event.matchId}, never matched into it`);
            break;
          }
          const receiver = side(match, event.bot);
          if (event.messageId !== undefined) {
            if (receiver.receivedIds.includes(event.messageId)) {
              duplicateDeliveries.push(`${event.bot} received ${event.messageId} more than once`);
              break;
            }
            receiver.receivedIds.push(event.messageId);
          }
          if (event.hash) receiver.received.push(event.hash);
          break;
        }

        case 'ack_lost': {
          stats.acksLost += 1;
          // Spliced into the sender's sequence at the point it was sent, and
          // counted, so the comparison below can tell "the receiver has one
          // more than the sender was acked for" (a delivery bug) from "the
          // socket died holding the ack" (a Tuesday).
          if (!match || !event.hash) break;
          side(match, event.bot).delivered.push({ hash: event.hash, t: event.t, confirmed: false });
          break;
        }

        case 'closed': {
          const windows = downWindows.get(event.bot) ?? [];
          windows.push({ from: event.t - CLOSE_LAG_MS, to: Number.POSITIVE_INFINITY });
          downWindows.set(event.bot, windows);
          break;
        }

        case 'resume_offered':
          stats.resumesOffered += 1;
          break;

        case 'resumed':
          stats.resumesSucceeded += 1;
          // The conversation came back with the session, so this bot is a
          // member of it again — and on a *new* connection, which is exactly
          // the state a stray-delivery check must not mistake for routing into
          // a conversation this bot was never in.
          if (event.matchId !== undefined) membership.add(`${event.bot}|${event.matchId}`);
          break;

        case 'resume_expired':
          stats.resumesExpired += 1;
          break;

        case 'partner_away':
          stats.partnersHeld += 1;
          break;

        case 'partner_back':
          stats.partnersReturned += 1;
          break;

        case 'skipped':
        case 'left_chat':
        case 'blocked':
          if (match) side(match, event.bot).endedItself = true;
          break;

        case 'protocol_error':
          if (event.code !== undefined) {
            const code = String(event.code);
            stats.errorsByCode.set(code, (stats.errorsByCode.get(code) ?? 0) + 1);
            if (code === 'MESSAGE_WITHHELD') stats.messagesBlocked += 1;
          }
          break;

        case 'connect_refused':
          if (event.code !== undefined) {
            const code = String(event.code);
            stats.connectRefusals.set(code, (stats.connectRefusals.get(code) ?? 0) + 1);
          }
          break;

        case 'harness_error':
          stats.harnessErrors += 1;
          break;

        default:
          break;
      }
    }
    reader.close();
  }

  stats.bots = bots.size;
  stats.matches = matches.size;

  // --- the comparison ------------------------------------------------------
  const mismatches: string[] = [];
  let comparedPairs = 0;
  let comparedMessages = 0;
  let missingTail = 0;
  let oneSidedMatches = 0;
  let droppedInGap = 0;
  let unprovenTail = 0;

  for (const [matchId, match] of matches) {
    const parties = [...match.sides.entries()];
    if (parties.length !== 2) {
      // With sides registered at match time, this means the partner's own
      // `matched` frame is genuinely absent from the ledger: the run drained
      // between the two notifications, or a worker died. Counted rather than
      // failed, because the drain boundary produces it legitimately.
      oneSidedMatches += 1;
      continue;
    }
    comparedPairs += 1;
    const [first, second] = parties;
    if (!first || !second) continue;

    for (const [sender, receiver] of [
      [first, second],
      [second, first],
    ] as const) {
      const sent = sender[1].delivered;
      const got = receiver[1].received;

      // A message acked while the receiver had no socket was routed at a
      // session that could not take it, and nothing is buffered (D43). The
      // sender's own flag misses the messages sent in the gap between the
      // socket dying and `partner_reconnecting` arriving; the receiver's own
      // ledger closes that gap, because it says exactly when it was away.
      const away = downWindows.get(receiver[0]) ?? [];
      if (away.length > 0) {
        for (const entry of sent) {
          if (!entry.confirmed) continue;
          if (away.some((window) => entry.t >= window.from && entry.t <= window.to)) {
            entry.confirmed = false;
          }
        }
      }

      // Two pointers rather than index alignment.
      //
      // Index alignment assumes the receiver's list is a prefix of the
      // sender's, and §28 breaks that assumption in the middle rather than at
      // the end: a message sent while the partner's seat was held is acked and
      // then dropped, so what the receiver has is the sender's list *with a
      // hole in it*. Aligned by index, every message after the hole reads as a
      // mismatch and one absent message becomes a whole conversation's worth of
      // reported delivery bugs.
      //
      // So an unconfirmed send may be skipped, and nothing else may be. A
      // confirmed message that is out of order, missing from the middle, or not
      // what the sender was acked for is still a failure with no tolerance.
      let s = 0;
      let r = 0;
      let broke = false;
      while (s < sent.length && r < got.length) {
        const expected = sent[s];
        if (expected === undefined) break;
        if (expected.hash === got[r]) {
          comparedMessages += 1;
          s += 1;
          r += 1;
          continue;
        }
        if (!expected.confirmed) {
          // Never arrived, and never could be proved to have arrived.
          droppedInGap += 1;
          s += 1;
          continue;
        }
        mismatches.push(
          `match ${matchId}: ${receiver[0]} position ${r} does not match what ${sender[0]} was acked for`,
        );
        broke = true;
        break;
      }

      if (broke) continue;
      // Whatever the sender has left is a tail the receiver never got: they
      // left first, or the run drained. Counted, not failed.
      for (let i = s; i < sent.length; i += 1) {
        const trailing = sent[i];
        if (trailing === undefined) continue;
        // A *trailing* unconfirmed send is unknown, not lost: the socket may
        // have died holding an ack for a message the partner did in fact get.
        // Only an unconfirmed send the receiver overtook — one with a message
        // after it that did arrive — is proof of a drop, and those are counted
        // in the loop above.
        if (trailing.confirmed) missingTail += 1;
        else unprovenTail += 1;
      }
      if (r < got.length) {
        mismatches.push(
          `match ${matchId}: ${receiver[0]} received ${got.length - r} message(s) ${sender[0]} was never acked for`,
        );
      }
    }
  }

  const failures = [...mismatches, ...strayDeliveries, ...duplicateDeliveries];
  const details = [
    `conversations reconstructed: ${comparedPairs}`,
    `message positions compared: ${comparedMessages}`,
    `messages sent but not received (partner left first): ${missingTail}`,
    `matches with only one side in the ledger: ${oneSidedMatches} (drain boundary)`,
    `messages withheld by moderation: ${stats.messagesWithheld} acked-undelivered, ${stats.messagesBlocked} refused outright`,
    `acked and provably never delivered: ${droppedInGap} — sent while the partner's seat was held, and not buffered (D43)`,
    `acked with no proof either way: ${unprovenTail} (the socket died holding the ack)`,
  ];
  for (const failure of failures.slice(0, 20)) details.push(failure);
  if (failures.length > 20) details.push(`... and ${failures.length - 20} more`);

  const oracle: OracleResult = {
    name: 'pair reconstruction',
    status: failures.length > 0 ? 'fail' : comparedPairs === 0 ? 'skipped' : 'pass',
    summary:
      failures.length > 0
        ? `${failures.length} delivery disagreement(s) across ${comparedPairs} conversations`
        : comparedPairs === 0
          ? 'no conversation had both sides in the ledger'
          : `${comparedMessages} message positions agree across ${comparedPairs} conversations`,
    details,
  };

  return { stats, oracle, profiles: judgeProfiles(declarations) };
}

/**
 * Oracle 6 — profile agreement.
 *
 * A declared profile is the only thing one stranger in this product knows about
 * another, and it travels a long way for something so small: validated at the
 * edge, moderated, written onto the session hash, read back beside `tryMatch`
 * on both sides, and built into two different identities. Every one of those
 * steps can lose a field or hand over the wrong one, and none of them would
 * produce an error — the conversation works perfectly, and one person is simply
 * shown somebody else's name.
 *
 * Two failures, and they are not the same fault:
 *
 *   * **not echoed** — what the server built for this bot does not match what
 *     this bot declared. Validation dropped a field, or the session hash lost
 *     one.
 *   * **crossed** — what one side was shown does not match what the other side
 *     was given as its own. This is the serious one: it means a profile reached
 *     the wrong conversation.
 *
 * Both are proved with hashes, so the check runs without the ledger ever
 * holding a name (see the note at the top of `ledger.ts`).
 */
function judgeProfiles(declarations: Map<string, Declaration>): OracleResult {
  const failures: string[] = [];
  let echoChecks = 0;
  let crossChecks = 0;
  let declaredSomething = 0;

  const byMatch = new Map<string, { bot: string; declaration: Declaration }[]>();
  for (const [key, declaration] of declarations) {
    const separator = key.indexOf('|');
    const bot = key.slice(0, separator);
    const matchId = key.slice(separator + 1);
    const entries = byMatch.get(matchId) ?? [];
    entries.push({ bot, declaration });
    byMatch.set(matchId, entries);

    if (declaration.declared !== undefined && declaration.echoed !== undefined) {
      echoChecks += 1;
      if (declaration.declared !== declaration.echoed) {
        failures.push(
          `${bot} in ${matchId}: the server did not echo the profile this bot declared`,
        );
      }
    }
  }

  for (const [matchId, entries] of byMatch) {
    if (entries.length !== 2) continue;
    const [first, second] = entries;
    if (!first || !second) continue;
    for (const [a, b] of [
      [first, second],
      [second, first],
    ] as const) {
      if (a.declaration.echoed === undefined || b.declaration.sawPartner === undefined) continue;
      crossChecks += 1;
      if (a.declaration.echoed !== b.declaration.sawPartner) {
        failures.push(
          `match ${matchId}: ${b.bot} was shown a profile that is not the one ${a.bot} declared`,
        );
      }
    }
  }

  // The empty profile hashes to a stable value, so "everybody declined" is
  // distinguishable from "nobody was checked" — and a run where it is the only
  // value seen is a run where this oracle proved almost nothing.
  const emptyHash = profileHash(null);
  for (const { echoed } of declarations.values()) {
    if (echoed !== undefined && echoed !== emptyHash) declaredSomething += 1;
  }

  const details = [
    `declarations echoed back to their owner: ${echoChecks}`,
    `declarations checked across a match: ${crossChecks}`,
    `sides that declared something rather than nothing: ${declaredSomething}`,
  ];
  for (const failure of failures.slice(0, 20)) details.push(failure);
  if (failures.length > 20) details.push(`... and ${failures.length - 20} more`);

  return {
    name: 'profile agreement',
    status: failures.length > 0 ? 'fail' : crossChecks === 0 ? 'skipped' : 'pass',
    summary:
      failures.length > 0
        ? `${failures.length} profile(s) did not survive the round trip`
        : crossChecks === 0
          ? 'no match had both sides declaring in the ledger'
          : `${crossChecks} declarations agree on both sides of a match`,
    details,
  };
}

/** Percentile from an unsorted sample. Returns 0 for an empty one. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}
