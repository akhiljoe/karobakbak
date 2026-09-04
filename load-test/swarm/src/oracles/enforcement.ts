/**
 * Oracle 7 — enforcement at the door.
 *
 * ---------------------------------------------------------------------------
 * THE TWO QUESTIONS, AND WHY BOTH ARE NEEDED
 * ---------------------------------------------------------------------------
 * `PHASES.md` names the banned-identity gap as the sharpest one in this harness
 * and says exactly why it matters: "a ban misfiring at the edge would present
 * as a capacity problem in a run rather than as a safety bug".
 *
 * That is two failures with one symptom, so this asks two questions:
 *
 *  1. **Did the ban hold?** Every A14 bot must have been refused, and none of
 *     them may have opened a session. A banned identity that connects is a
 *     safety failure and the obvious one.
 *
 *  2. **Did it hold only there?** No other bot may have been refused with 403.
 *     Every bot in a run shares one host, so a ban keyed on the wrong thing —
 *     the generator's real address rather than the claimed one, the wrong hop
 *     of `X-Forwarded-For` — refuses the entire population. The run does not
 *     error; it shrinks. And a smaller population passes every other oracle in
 *     this suite, which is precisely how this would have gone unnoticed.
 *
 * Question 2 is the one that could not previously be asked at all, and it is
 * the reason this is an oracle rather than an integration test.
 *
 * ---------------------------------------------------------------------------
 * A CLEAN RUN IS NOT ENOUGH
 * ---------------------------------------------------------------------------
 * The dangerous outcome here is a scenario that passes for the wrong reason. If
 * the ban never actually applied — a changed hash function, a wrong salt, a
 * Redis container that was not there — then nobody is refused, nothing looks
 * wrong, and the oracle would report a clean run while testing nothing.
 *
 * So the absence of refusals is a **failure**, not a pass. The oracle requires
 * the refusals it expects before it will consider whether anyone else got one.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import type { LedgerEvent } from '../ledger';
import type { OracleResult } from './types';

export interface EnforcementOracleInput {
  readonly ledgerPaths: readonly string[];
  /** Bots the orchestrator banned before the run, by ledger id. */
  readonly bannedBots: readonly string[];
  /** How many ban keys actually landed in Redis. */
  readonly bansApplied: number;
  /** Why bans were not applied, when they were not. */
  readonly skipped: string | null;
}

interface BotFacts {
  refusedForbidden: number;
  /**
   * Refused at the edge with 451 — the geo-block in `frontend/nginx.conf`,
   * which runs in nginx and answers before the upgrade ever reaches a backend.
   * A bot stopped here never had its ban tested, so it belongs in neither
   * column of question 1. See the partition below.
   */
  refusedGeo: number;
  refusedOther: number;
  connected: number;
  matched: number;
}

function factsFor(map: Map<string, BotFacts>, bot: string): BotFacts {
  let facts = map.get(bot);
  if (!facts) {
    facts = { refusedForbidden: 0, refusedGeo: 0, refusedOther: 0, connected: 0, matched: 0 };
    map.set(bot, facts);
  }
  return facts;
}

export async function runEnforcementOracle(
  input: EnforcementOracleInput,
): Promise<OracleResult> {
  const name = 'enforcement at the door';

  if (input.skipped !== null) {
    return {
      name,
      status: 'skipped',
      summary: input.skipped,
      details: [
        'No identity was banned, so nothing about enforcement was exercised.',
        'This is reported rather than passed: an unexercised control is not a working one.',
      ],
    };
  }

  if (input.bannedBots.length === 0) {
    return {
      name,
      status: 'skipped',
      summary: 'no A14 bots in this profile',
      details: ['Run `--profile adversarial` to include them.'],
    };
  }

  const banned = new Set(input.bannedBots);
  const facts = new Map<string, BotFacts>();

  for (const path of input.ledgerPaths) {
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

      const bot = factsFor(facts, event.bot);
      if (event.type === 'connect_refused') {
        if (event.code === 403) bot.refusedForbidden += 1;
        else if (event.code === 451) bot.refusedGeo += 1;
        else bot.refusedOther += 1;
      } else if (event.type === 'connected') {
        bot.connected += 1;
      } else if (event.type === 'matched') {
        bot.matched += 1;
      }
    }
  }

  const details: string[] = [];

  // Question 1 — did the ban hold, for everyone it was applied to.
  //
  // A banned bot that only ever met the edge is *not* evidence either way. The
  // geo-block in `frontend/nginx.conf` answers 451 in nginx, before the upgrade
  // reaches a backend and therefore before `chat:ban:{key}` is read at all: the
  // bot was refused harder than the ban would have refused it, and the ban was
  // never asked. Counting it as a miss reports a safety bug that did not
  // happen, which is what this did on 2026-09-04 — five of eighteen, every one
  // of them carrying a 451 in the ledger.
  //
  // Counting it as a pass would be the worse mistake, and it is the one this
  // file's own header warns about: a run where the whole A14 cohort drew an
  // EEA country would then "prove" enforcement while testing nothing. So they
  // are excluded and named, and an empty tested set fails below.
  const admitted: string[] = [];
  const neverRefused: string[] = [];
  const untested: string[] = [];
  for (const bot of banned) {
    const bot_ = facts.get(bot);
    if (bot_ && (bot_.connected > 0 || bot_.matched > 0)) {
      // Checked first and over the whole cohort: a banned identity that opened
      // a session is a failure whatever else happened to it.
      admitted.push(bot);
      continue;
    }
    if (bot_ && bot_.refusedForbidden === 0 && bot_.refusedGeo > 0) {
      untested.push(bot);
      continue;
    }
    if (!bot_ || bot_.refusedForbidden === 0) neverRefused.push(bot);
  }
  const tested = banned.size - untested.length;

  // Question 2 — did it hold only there.
  const collateral: string[] = [];
  for (const [bot, bot_] of facts) {
    if (banned.has(bot)) continue;
    if (bot_.refusedForbidden > 0) collateral.push(bot);
  }

  details.push(`${input.bansApplied} identities banned before the run`);
  details.push(`${banned.size} bots carried a banned identity`);
  details.push(`${tested} of them reached the door and had the ban tested`);
  if (untested.length > 0) {
    details.push(
      `${untested.length} never reached it: refused 451 by the edge geo-block — ` +
        `${untested.slice(0, 10).join(', ')}`,
    );
  }
  details.push(`${collateral.length} other bots were refused with 403`);

  if (tested === 0) {
    // The failure this file's header describes, reached by a different road.
    return {
      name,
      status: 'fail',
      summary: 'no banned identity reached the door, so nothing was tested',
      details: [
        ...details,
        'Every A14 bot was stopped by the edge before the ban could apply. That is',
        'the geo-block working and the ban question going unasked — a clean-looking',
        'run that demonstrates nothing. Re-run with a seed whose A14 cohort draws a',
        'country the edge admits.',
      ],
    };
  }

  if (admitted.length > 0) {
    return {
      name,
      status: 'fail',
      summary: `${admitted.length} banned identities opened a session`,
      details: [
        ...details,
        `admitted: ${admitted.slice(0, 10).join(', ')}`,
        'A ban is read at the upgrade, before a session exists. One that connected',
        'means the check did not run, read the wrong identity, or lost a race.',
      ],
    };
  }

  if (neverRefused.length > 0) {
    // Not a pass. Silence here means the ban never applied, which is the way
    // this scenario fails while looking clean.
    return {
      name,
      status: 'fail',
      summary: `${neverRefused.length} banned identities were never refused`,
      details: [
        ...details,
        `never refused: ${neverRefused.slice(0, 10).join(', ')}`,
        'The bot never attempted, or the ban key never matched the identity the',
        'server computed. Check that `hashIp` here still matches the backend and',
        'that IP_HASH_SALT is the one the stack is running with.',
      ],
    };
  }

  if (collateral.length > 0) {
    return {
      name,
      status: 'fail',
      summary: `${collateral.length} unbanned bots were refused with 403`,
      details: [
        ...details,
        `refused: ${collateral.slice(0, 10).join(', ')}`,
        'This is the failure that reads as capacity pressure rather than as a',
        'safety bug: the population shrinks, and every other oracle passes on',
        'what is left. Most likely the ban matched a shared identity — the',
        'generator address rather than the claimed one, or the wrong hop of',
        'X-Forwarded-For.',
      ],
    };
  }

  return {
    name,
    status: 'pass',
    summary: `${banned.size} banned identities refused, nobody else`,
    details: [
      ...details,
      'Refused at the upgrade, before a session was allocated, and no other bot',
      'was caught by it.',
    ],
  };
}
