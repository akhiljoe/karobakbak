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
import type { LedgerEvent } from '../ledger';
import type { OracleResult } from './types';

interface Side {
  /** Hashes of messages the server acked as delivered, in send order. */
  delivered: string[];
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
}

export interface LedgerAnalysis {
  stats: LedgerStats;
  oracle: OracleResult;
}

function side(match: Match, bot: string): Side {
  let existing = match.sides.get(bot);
  if (!existing) {
    existing = { delivered: [], received: [], receivedIds: [], endedItself: false };
    match.sides.set(bot, existing);
  }
  return existing;
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
  };

  const strayDeliveries: string[] = [];
  const duplicateDeliveries: string[] = [];

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
        case 'matched':
          if (match && event.matchId !== undefined) {
            membership.add(`${event.bot}|${event.matchId}`);
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
          if (event.delivered === false) {
            stats.messagesWithheld += 1;
            break;
          }
          if (match && event.hash) side(match, event.bot).delivered.push(event.hash);
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
      const shared = Math.min(sent.length, got.length);
      for (let i = 0; i < shared; i += 1) {
        comparedMessages += 1;
        if (sent[i] !== got[i]) {
          mismatches.push(
            `match ${matchId}: ${receiver[0]} position ${i} does not match what ${sender[0]} was acked for`,
          );
          break;
        }
      }
      if (got.length < sent.length) missingTail += sent.length - got.length;
      if (got.length > sent.length) {
        mismatches.push(
          `match ${matchId}: ${receiver[0]} received ${got.length - sent.length} message(s) ${sender[0]} was never acked for`,
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

  return { stats, oracle };
}

/** Percentile from an unsorted sample. Returns 0 for an empty one. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}
