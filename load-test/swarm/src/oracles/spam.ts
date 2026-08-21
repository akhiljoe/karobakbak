/**
 * Oracle 6 — serial-spam detection, measured against a roster written in
 * advance.
 *
 * ---------------------------------------------------------------------------
 * THIS ORACLE DOES NOT TEST A FEATURE. IT MEASURES THE ABSENCE OF ONE.
 * ---------------------------------------------------------------------------
 * There is no live serial-spam detector in this system, and that is a stated
 * scope boundary rather than a bug: `RULES` looks at one message at a time, and
 * "hey wanna see something cool" is an unremarkable opener no matter how many
 * hundreds of strangers receive it. Nothing anywhere in the pipeline compares a
 * message to what the same sender said in a different conversation.
 *
 * So this oracle never fails for a missed spammer — failing would be asserting
 * a feature nobody built. What it does instead is produce the four numbers that
 * decide whether that boundary is still acceptable:
 *
 *   1. **What an offline query would have found**, run two ways: grouping by
 *      exact content and grouping by the normalised moderation view. The gap
 *      between them is what mutation buys an evader.
 *   2. **How much reach a spammer got** — distinct strangers per labelled bot.
 *   3. **How long the live signal took** — time from a spammer's first message
 *      to the first block or report anyone aimed at it.
 *   4. **How much reach it got *after* that signal.** This is the number that
 *      matters most and the one nothing else measures. A block protects the
 *      blocker and nobody else, so a spammer keeps meeting new people at full
 *      speed for as long as it likes.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT *DOES* FAIL ON
 * ---------------------------------------------------------------------------
 * Two things, both of which are real requirements rather than aspirations:
 *
 *   - **A block must hold (D18).** Once bot X blocks bot Y, the two must never
 *     share another match, across reconnects on either side. Blocks key on
 *     salted hashes of address and client token precisely so a new session id
 *     changes nothing, and this is the only end-to-end check of that.
 *   - **Precision.** If the offline query would have flagged a bot the roster
 *     labels benign, that is a false positive on real users, and it fails.
 */
import { createInterface } from 'node:readline';
import { createReadStream } from 'node:fs';
import type { BotSpec } from '../bot';
import type { LedgerEvent } from '../ledger';
import type { OracleResult } from './types';

interface BotFacts {
  scenario: string;
  labels: readonly string[];
  /** Distinct matches this bot took part in. */
  matches: Set<string>;
  /** Exact content hashes it sent, with how many distinct matches each reached. */
  exact: Map<string, Set<string>>;
  /** The same, grouped by normalised view. */
  normalised: Map<string, Set<string>>;
  /** The same, grouped by the harness's proposed campaign canonical form. */
  campaign: Map<string, Set<string>>;
  firstMessageAt: number | null;
  /** When somebody first blocked or reported this bot, from the partner's side. */
  firstSanctionAt: number | null;
  sanctionKind: 'block' | 'report' | null;
  /** Matches begun after the first sanction landed. */
  matchesAfterSanction: number;
  /**
   * Times a live server-side control acted on this bot: a message withheld by
   * moderation, or the socket closed for policy abuse.
   *
   * Measured rather than assumed. The expected value for a pattern spammer is
   * zero today, but writing "0" into the report as a constant would mean the
   * report keeps saying it on the day somebody builds a detector.
   */
  liveActions: number;
}

export interface SpamOracleInput {
  readonly ledgerPaths: readonly string[];
  readonly roster: readonly BotSpec[];
  /**
   * Distinct conversations a repeated line must reach before an offline query
   * would call it a campaign. Five is the threshold in the SQL in
   * `docs/LOADTEST-SCENARIOS.md` §6, kept identical so the two agree.
   */
  readonly campaignThreshold: number;
}

export interface SpamOracleResult {
  readonly oracle: OracleResult;
  /** Printed by the report as the headline safety numbers. */
  readonly summary: SpamSummary;
}

export interface SpamSummary {
  labelledSpammers: number;
  /** Labelled spammers a live server-side control acted on. Measured, not assumed. */
  caughtLive: number;
  detectedExact: number;
  detectedNormalised: number;
  /** What a purpose-built canonical form would catch. Not shipped behaviour. */
  detectedCampaign: number;
  falsePositivesExact: number;
  falsePositivesNormalised: number;
  falsePositivesCampaign: number;
  medianReach: number;
  maxReach: number;
  /** Seconds from first message to first sanction, across sanctioned spammers. */
  medianTimeToSanction: number | null;
  sanctionedSpammers: number;
  /** Conversations labelled spammers had *after* being sanctioned. */
  reachAfterSanction: number;
  blockViolations: number;
  /** Blocks the server refused because the match had already ended. */
  blocksRefused: number;
  blocksEffective: number;
  /** Adversarial-but-not-campaign bots the offline query also flagged. */
  otherAdversariesFlagged: number;
}

function facts(map: Map<string, BotFacts>, bot: string, spec?: BotSpec): BotFacts {
  let existing = map.get(bot);
  if (!existing) {
    existing = {
      scenario: spec?.scenario ?? '??',
      labels: spec?.labels ?? [],
      matches: new Set(),
      exact: new Map(),
      normalised: new Map(),
      campaign: new Map(),
      firstMessageAt: null,
      firstSanctionAt: null,
      sanctionKind: null,
      matchesAfterSanction: 0,
      liveActions: 0,
    };
    map.set(bot, existing);
  }
  return existing;
}

function track(index: Map<string, Set<string>>, key: string, matchId: string): void {
  let matches = index.get(key);
  if (!matches) {
    matches = new Set();
    index.set(key, matches);
  }
  matches.add(matchId);
}

/** Largest number of distinct matches any single line of this bot reached. */
function widestCampaign(index: Map<string, Set<string>>): number {
  let widest = 0;
  for (const matches of index.values()) widest = Math.max(widest, matches.size);
  return widest;
}

/**
 * How many block attempts actually reached Redis.
 *
 * A refused block is not a server fault — the match had already ended — but the
 * number is worth printing, because it is the size of a real product question:
 * a user who presses Block as their partner leaves does not get a block.
 */
function summaryBlocksEffective(effective: number, attempted: number): string {
  if (attempted === 0) return 'none attempted';
  const lost = attempted - effective;
  return lost === 0
    ? `${effective}/${attempted}`
    : `${effective}/${attempted} — ${lost} attempt(s) wrote nothing`;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle] ?? 0;
}

export async function checkSpamDetection(input: SpamOracleInput): Promise<SpamOracleResult> {
  const specs = new Map(input.roster.map((spec) => [spec.id, spec]));
  const bots = new Map<string, BotFacts>();

  /** matchId -> the bots that were in it. Used to resolve "who blocked whom". */
  const participants = new Map<string, Set<string>>();
  /** Every block attempt. The partner is resolved afterwards from the match. */
  const blocks: { bot: string; matchId: string; at: number }[] = [];
  /**
   * Blocks the server acknowledged, keyed `bot|matchId`.
   *
   * The durability check binds on **confirmation only**, never on the attempt.
   * A `blocked` line in the ledger is an intent: the bot logs it when the frame
   * leaves the socket, and the server may answer `NOT_MATCHED` (the match ended
   * first) or `RATE_LIMITED` (the block bucket is 3 burst, 20/hour). In an
   * adversarial run most attempts are refused, and treating them as facts
   * reported a stream of D18 violations for pairs that were never blocked.
   *
   * The trade is deliberate: a block that *was* recorded but whose confirmation
   * the harness failed to correlate is not checked, so this can miss a real
   * violation. It cannot invent one, which is the direction that matters — a
   * durability check nobody believes is worth nothing.
   */
  const confirmedBlocks = new Set<string>();
  const reports: { bot: string; matchId: string; at: number }[] = [];
  /** Blocks the server refused, keyed `bot|matchId`. See LedgerEventType. */
  const refusedBlocks = new Set<string>();
  /** Why blocks were refused, by protocol error code. */
  const refusalReasons = new Map<string, number>();
  /** matchId -> when each bot entered it, for the after-sanction reach count. */
  const matchStart = new Map<string, number>();

  for (const path of input.ledgerPaths) {
    const reader = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
    for await (const raw of reader) {
      if (raw.length === 0) continue;
      let event: LedgerEvent;
      try {
        event = JSON.parse(raw) as LedgerEvent;
      } catch {
        continue;
      }

      const bot = facts(bots, event.bot, specs.get(event.bot));

      switch (event.type) {
        case 'matched': {
          if (event.matchId === undefined) break;
          bot.matches.add(event.matchId);
          let inMatch = participants.get(event.matchId);
          if (!inMatch) {
            inMatch = new Set();
            participants.set(event.matchId, inMatch);
          }
          inMatch.add(event.bot);
          if (!matchStart.has(event.matchId)) matchStart.set(event.matchId, event.t);
          break;
        }

        case 'sent': {
          if (event.matchId === undefined) break;
          if (bot.firstMessageAt === null) bot.firstMessageAt = event.t;
          if (event.hash) track(bot.exact, event.hash, event.matchId);
          if (event.nhash) track(bot.normalised, event.nhash, event.matchId);
          if (event.chash) track(bot.campaign, event.chash, event.matchId);
          break;
        }

        case 'ack':
          // `delivered: false` is moderation withholding the message (D20) —
          // the one live control that can act on content today.
          if (event.delivered === false) bot.liveActions += 1;
          break;

        case 'closed':
          // 4002 POLICY_VIOLATION, 4003 PROTOCOL_ABUSE: the server ended it.
          if (event.code === 4002 || event.code === 4003) bot.liveActions += 1;
          break;

        case 'blocked':
          if (event.matchId !== undefined) {
            blocks.push({ bot: event.bot, matchId: event.matchId, at: event.t });
          }
          break;

        case 'block_refused':
          // NOT_MATCHED or RATE_LIMITED: nothing was written to Redis, so this
          // attempt binds nobody and must not be held against the server.
          if (event.matchId !== undefined) {
            refusedBlocks.add(`${event.bot}|${event.matchId}`);
            const code = String(event.code ?? 'unknown');
            refusalReasons.set(code, (refusalReasons.get(code) ?? 0) + 1);
          }
          break;

        case 'block_confirmed':
          if (event.matchId !== undefined) confirmedBlocks.add(`${event.bot}|${event.matchId}`);
          break;

        case 'reported':
          if (event.matchId !== undefined) {
            reports.push({ bot: event.bot, matchId: event.matchId, at: event.t });
          }
          break;

        default:
          break;
      }
    }
    reader.close();
  }

  // --- who was sanctioned, and when -----------------------------------------
  const partnerOf = (matchId: string, bot: string): string | null => {
    const inMatch = participants.get(matchId);
    if (!inMatch) return null;
    for (const candidate of inMatch) if (candidate !== bot) return candidate;
    return null;
  };

  const sanction = (target: string, at: number, kind: 'block' | 'report'): void => {
    const victimFacts = bots.get(target);
    if (!victimFacts) return;
    if (victimFacts.firstSanctionAt === null || at < victimFacts.firstSanctionAt) {
      victimFacts.firstSanctionAt = at;
      victimFacts.sanctionKind = kind;
    }
  };

  const effectiveBlocks = blocks.filter((entry) =>
    confirmedBlocks.has(`${entry.bot}|${entry.matchId}`),
  );

  for (const entry of effectiveBlocks) {
    const target = partnerOf(entry.matchId, entry.bot);
    if (target) sanction(target, entry.at, 'block');
  }
  for (const entry of reports) {
    const target = partnerOf(entry.matchId, entry.bot);
    if (target) sanction(target, entry.at, 'report');
  }

  for (const [, entry] of bots) {
    if (entry.firstSanctionAt === null) continue;
    for (const matchId of entry.matches) {
      const started = matchStart.get(matchId);
      if (started !== undefined && started > entry.firstSanctionAt) {
        entry.matchesAfterSanction += 1;
      }
    }
  }

  // --- the block-holds requirement (D18) ------------------------------------
  const blockViolations: string[] = [];
  const blockedPairs = new Map<string, number>();
  for (const entry of effectiveBlocks) {
    const target = partnerOf(entry.matchId, entry.bot);
    if (!target) continue;
    // Order-independent, because `isBlocked` checks both directions.
    const pair = [entry.bot, target].sort().join('~');
    const existing = blockedPairs.get(pair);
    if (existing === undefined || entry.at < existing) blockedPairs.set(pair, entry.at);
  }

  for (const [matchId, inMatch] of participants) {
    if (inMatch.size !== 2) continue;
    const [first, second] = [...inMatch].sort();
    if (first === undefined || second === undefined) continue;
    const blockedAt = blockedPairs.get(`${first}~${second}`);
    if (blockedAt === undefined) continue;
    const started = matchStart.get(matchId);
    // A match that *began* after the block was recorded is the violation. The
    // match the block happened in obviously contains both of them.
    if (started !== undefined && started > blockedAt + 1_000) {
      blockViolations.push(
        `${first} and ${second} matched again ${Math.round((started - blockedAt) / 1000)}s after a block between them`,
      );
    }
  }

  // --- detection, both ways -------------------------------------------------
  const isSpammer = (entry: BotFacts): boolean => entry.labels.includes('spammer');
  /**
   * Only a bot the roster calls benign can be a false positive.
   *
   * A first version counted every non-spammer, which put A5, A6 and A9 in the
   * false-positive column — bots that are labelled `abusive` and genuinely do
   * repeat themselves across conversations. Flagging them is not a mistake, it
   * is the query working on a different kind of adversary, and counting it as
   * error made the precision number meaningless.
   *
   * A false positive is what it says: an ordinary user the query would accuse.
   */
  const isBenign = (entry: BotFacts): boolean => entry.labels.includes('benign');

  let labelledSpammers = 0;
  let caughtLive = 0;
  let detectedExact = 0;
  let detectedNormalised = 0;
  let detectedCampaign = 0;
  let falsePositivesExact = 0;
  let falsePositivesNormalised = 0;
  let falsePositivesCampaign = 0;
  let otherAdversariesFlagged = 0;
  const reach: number[] = [];
  const timeToSanction: number[] = [];
  let sanctionedSpammers = 0;
  let reachAfterSanction = 0;
  const missed: string[] = [];
  const falsePositives: string[] = [];

  for (const [id, entry] of bots) {
    const flaggedExact = widestCampaign(entry.exact) >= input.campaignThreshold;
    const flaggedNormalised = widestCampaign(entry.normalised) >= input.campaignThreshold;
    const flaggedCampaign = widestCampaign(entry.campaign) >= input.campaignThreshold;

    if (isSpammer(entry)) {
      labelledSpammers += 1;
      if (entry.liveActions > 0) caughtLive += 1;
      reach.push(entry.matches.size);
      if (flaggedExact) detectedExact += 1;
      if (flaggedNormalised) detectedNormalised += 1;
      if (flaggedCampaign) detectedCampaign += 1;
      if (!flaggedCampaign) {
        missed.push(`${id} (${entry.scenario}) reached ${entry.matches.size} strangers undetected`);
      }
      if (entry.firstSanctionAt !== null && entry.firstMessageAt !== null) {
        sanctionedSpammers += 1;
        timeToSanction.push((entry.firstSanctionAt - entry.firstMessageAt) / 1000);
        reachAfterSanction += entry.matchesAfterSanction;
      }
    } else if (isBenign(entry)) {
      if (flaggedExact) falsePositivesExact += 1;
      if (flaggedCampaign) falsePositivesCampaign += 1;
      if (flaggedNormalised) {
        falsePositivesNormalised += 1;
        falsePositives.push(
          `${id} (${entry.scenario}) is an ordinary user the offline query would accuse`,
        );
      }
    } else if (flaggedNormalised) {
      // Labelled adversarial but not a campaign spammer — A6 and A9 repeat
      // themselves while flooding, A5 repeats deny-list lines. Caught, but not
      // what the recall number is about, so counted on its own.
      otherAdversariesFlagged += 1;
    }
  }

  const summary: SpamSummary = {
    labelledSpammers,
    caughtLive,
    detectedExact,
    detectedNormalised,
    detectedCampaign,
    falsePositivesExact,
    falsePositivesNormalised,
    falsePositivesCampaign,
    medianReach: median(reach),
    maxReach: reach.reduce((most, value) => Math.max(most, value), 0),
    medianTimeToSanction: timeToSanction.length > 0 ? median(timeToSanction) : null,
    sanctionedSpammers,
    reachAfterSanction,
    blockViolations: blockViolations.length,
    blocksRefused: blocks.length - effectiveBlocks.length,
    blocksEffective: effectiveBlocks.length,
    otherAdversariesFlagged,
  };

  // Denominators for the false-positive line. A count on its own is unreadable:
  // "251 flagged" means one thing out of 260 benign bots and another out of
  // 4,000, and it means something different again when each of them held six
  // hundred conversations rather than six.
  const benignMatchCounts = [...bots.values()]
    .filter((entry) => isBenign(entry))
    .map((entry) => entry.matches.size)
    .sort((a, b) => a - b);
  const benignBots = benignMatchCounts.length;
  const medianBenignMatches =
    benignBots === 0 ? 0 : (benignMatchCounts[Math.floor(benignBots / 2)] ?? 0);

  const details: string[] = [];

  if (labelledSpammers === 0) {
    details.push('no labelled spammers in this profile; run --profile adversarial for the safety numbers');
  } else {
    const pct = (part: number): string =>
      `${part}/${labelledSpammers} (${Math.round((part / labelledSpammers) * 100)}%)`;
    details.push(`labelled spammers: ${labelledSpammers}`);
    details.push(
      `acted on by a live control (withheld or disconnected): ${caughtLive}/${labelledSpammers}`,
    );
    details.push(`offline query, exact content:     would catch ${pct(detectedExact)}`);
    details.push(`offline query, normalised view:   would catch ${pct(detectedNormalised)}`);
    details.push(`a campaign-specific canonical form: would catch ${pct(detectedCampaign)}`);
    details.push(
      `false positives on benign bots:   ${falsePositivesExact} exact, ` +
        `${falsePositivesNormalised} normalised, ${falsePositivesCampaign} campaign form`,
    );
    details.push(
      `other adversarial bots also flagged: ${otherAdversariesFlagged} (repetition, but not a campaign)`,
    );
    details.push(
      `blocks recorded ${summaryBlocksEffective(effectiveBlocks.length, blocks.length)}`,
    );
    if (refusalReasons.size > 0) {
      const reasons = [...refusalReasons.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => `${code} ${count}`)
        .join(', ');
      details.push(`block attempts refused by the server: ${reasons}`);
    }
    details.push(`reach per spammer: median ${summary.medianReach} strangers, worst ${summary.maxReach}`);
    if (summary.medianTimeToSanction === null) {
      details.push('no labelled spammer was blocked or reported by anyone during this run');
    } else {
      details.push(
        `first block or report after a median of ${summary.medianTimeToSanction.toFixed(1)}s, ` +
          `for ${sanctionedSpammers}/${labelledSpammers} of them`,
      );
      details.push(
        `strangers reached AFTER being sanctioned: ${reachAfterSanction} — a block protects the blocker only`,
      );
    }
    for (const line of missed.slice(0, 8)) details.push(`  missed: ${line}`);
    if (missed.length > 8) details.push(`  ... and ${missed.length - 8} more`);
  }

  for (const line of falsePositives.slice(0, 8)) details.push(`  false positive: ${line}`);
  if (falsePositives.length > 8) {
    details.push(`  ... and ${falsePositives.length - 8} more`);
  }
  if (falsePositives.length > 0) {
    // Stated in full every time, because a false-positive count reads as an
    // accusation against the detector and it is at least as often the run.
    details.push(
      `  ${falsePositives.length} of ${benignBots} benign bots, over a median of ${medianBenignMatches} conversations each.`,
    );
    details.push(
      '  This number rises with run length and falls with corpus size, and it does not',
    );
    details.push(
      '  fail the run: it is a property of a detector nobody has built yet, not of the',
    );
    details.push(
      '  server. A benign bot draws from a finite vocabulary, so given enough',
    );
    details.push(
      '  conversations it repeats a line into five of them by arithmetic — and so do',
    );
    details.push(
      '  real users, who say the same greeting to more than five strangers. Read it as',
    );
    details.push(
      '  the precision budget any campaign detector would have to pay. See §6.',
    );
  }
  for (const line of blockViolations.slice(0, 8)) details.push(`  BLOCK VIOLATION: ${line}`);
  if (blockViolations.length > 8) {
    details.push(`  ... and ${blockViolations.length - 8} more block violations`);
  }

  // ---------------------------------------------------------------------------
  // WHAT FAILS THIS ORACLE, AND WHAT ONLY GETS REPORTED
  // ---------------------------------------------------------------------------
  // Only a **block durability violation** fails: a pair that matched again
  // after a confirmed block between them. That is a property of the server, it
  // is invariant D18, and it is either true or it is not.
  //
  // The false-positive count used to fail the run too, and that was wrong in a
  // way that took a long run to expose. A 90-second run produced two of them
  // and looked like a corpus problem; a 25-minute run produced 251 out of 400
  // benign bots, because the criterion — the same line in five distinct
  // conversations — is met by *any* bot with a finite vocabulary given enough
  // conversations. The number scales with run length and corpus size, and moves
  // not at all with anything the server does. Gating on it meant the oracle
  // could not pass an endurance run (E10) no matter how correct the product
  // was, which is the definition of a bad test.
  //
  // It is still printed loudly, and it is arguably the most interesting number
  // here: it is the precision budget a real campaign detector would have to
  // pay, measured rather than guessed.
  const failures = blockViolations.length;

  return {
    summary,
    oracle: {
      name: 'spam detection and block durability',
      status: failures > 0 ? 'fail' : labelledSpammers === 0 ? 'skipped' : 'pass',
      summary:
        blockViolations.length > 0
          ? `${blockViolations.length} pair(s) matched again after a block between them (D18)`
          : labelledSpammers === 0
            ? 'no labelled spammers in this profile'
            : `blocks held; ${detectedCampaign}/${labelledSpammers} spammers detectable offline, ${caughtLive} live` +
              (falsePositivesNormalised > 0
                ? `, at a cost of ${falsePositivesNormalised} benign bot(s) flagged`
                : ''),
      details,
    },
  };
}
