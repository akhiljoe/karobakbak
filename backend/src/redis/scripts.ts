/**
 * Every matchmaking state transition, as a Lua script.
 *
 * ---------------------------------------------------------------------------
 * WHY LUA AND NOT TYPESCRIPT
 * ---------------------------------------------------------------------------
 * Node's single thread is not a concurrency argument. Several backend
 * instances mutate this Redis at once, so a read-then-write from TypeScript is
 * a race with every other instance between the read and the write. Redis runs
 * one script at a time to completion, so a transition expressed as one script
 * cannot interleave with another instance's (D1). Every function here that
 * changes matchmaking state names the invariants it preserves.
 *
 * ---------------------------------------------------------------------------
 * KEYS VS ARGV
 * ---------------------------------------------------------------------------
 * `ARGV[1]` is always the key prefix. Scripts declare in KEYS the keys they can
 * name before they run, and derive the rest — a candidate's session row, a
 * partner's dedupe set — from that prefix inside the script, because those keys
 * are not knowable until the script has read something. That is safe here only
 * because this is a single Redis, not a Cluster (D13); a Cluster would require
 * every key up front for slot routing. The derived names are built with the
 * same layout as `keys.ts`, and `keys.test.ts` pins the two together.
 *
 * Redis 7 replicates scripts by their effects, so the non-deterministic
 * commands these scripts depend on — `SRANDMEMBER` for fair sampling (D2/D3)
 * and `TIME` for the clock — are safe to call before a write.
 *
 * ---------------------------------------------------------------------------
 * THE CLOCK
 * ---------------------------------------------------------------------------
 * Scripts read the time from Redis (`TIME`), never from an argument. Queue
 * fairness compares `enqueuedAt` values written by *different* backend
 * instances, and rate-limit buckets are refilled from a timestamp another
 * instance wrote; sourcing those from each instance's own wall clock would make
 * fairness and rate limiting depend on NTP skew between hosts.
 */
import { createHash } from 'node:crypto';

import type { Redis } from 'ioredis';

/**
 * Helpers prepended to every script.
 *
 * `endMatchInline` is shared by `endMatch` and by the two janitor scripts, so
 * that "a match ends" means exactly one thing in Redis no matter who noticed
 * it first. Duplicating that sequence would be how the janitor's version and
 * the skip path's version drift apart.
 */
const PRELUDE = `
local P = ARGV[1]
local function kSession(sid)   return P .. ':session:' .. sid end
local function kSessions()     return P .. ':sessions' end
local function kQueue(seg)     return P .. ':queue:' .. seg end
local function kMatch(mid)     return P .. ':match:' .. mid end
local function kMatches()      return P .. ':matches' end
local function kUserMatch(sid) return P .. ':user_match:' .. sid end
local function kDedupe(mid)    return P .. ':dedupe:' .. mid end
local function kBlocks(b)      return P .. ':blocks:' .. b end
local function kInstance(iid)  return P .. ':instance:' .. iid end
local function kConn(ip)       return P .. ':conn:' .. ip end

local function nowMs()
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local function hashToTable(flat)
  local out = {}
  for i = 1, #flat, 2 do out[flat[i]] = flat[i + 1] end
  return out
end

-- Resolves who a session is talking to, and where that socket lives.
-- Shared by resolvePartner and resolveRoute so that "who is my partner" has
-- one answer: a second copy of this walk is how the message path and the
-- typing path would eventually disagree about who the recipient is.
-- Returns nil when there is no deliverable partner, else
-- { matchId, partnerSessionId, partnerInstanceId } with the instance empty
-- when the partner's session row is gone.
local function resolveRouteInline(sid)
  local mid = redis.call('GET', kUserMatch(sid))
  if not mid then return nil end
  local m = redis.call('HMGET', kMatch(mid), 'a', 'b')
  -- I6: a deleted match can never deliver, even while user_match lingers.
  if not m[1] then return nil end
  local partner
  if m[1] == sid then
    partner = m[2]
  elseif m[2] == sid then
    partner = m[1]
  else
    return nil
  end
  local instance = redis.call('HGET', kSession(partner), 'instanceId')
  return { mid, partner, instance or '' }
end

-- Ends one match, symmetrically, and reports whether this caller was the one
-- that ended it. Preserves I4 (no user_match without a match), I5 and I6 (a
-- deleted match can never deliver again): the match record, both user_match
-- keys and the dedupe set all go in the same atomic script.
-- Returns nil if the match was already gone, else { a, b, segment }.
local function endMatchInline(mid, sessionTtl)
  local mkey = kMatch(mid)
  local flat = redis.call('HGETALL', mkey)
  if #flat == 0 then
    redis.call('SREM', kMatches(), mid)
    redis.call('DEL', kDedupe(mid))
    return nil
  end
  local m = hashToTable(flat)
  -- D6: exactly one caller sees DEL return 1, and that caller notifies the peer.
  if redis.call('DEL', mkey) == 0 then return nil end
  redis.call('SREM', kMatches(), mid)
  redis.call('DEL', kDedupe(mid))
  local seg = m['segment'] or ''
  local sides = { m['a'], m['b'] }
  for i = 1, #sides do
    local sid = sides[i]
    if sid and sid ~= '' then
      redis.call('DEL', kUserMatch(sid))
      if seg ~= '' then redis.call('SREM', kQueue(seg), sid) end
      local sk = kSession(sid)
      if redis.call('EXISTS', sk) == 1 then
        redis.call('HSET', sk, 'state', 'IDLE')
        redis.call('HDEL', sk, 'matchId', 'enqueuedAt')
        redis.call('EXPIRE', sk, sessionTtl)
      end
    end
  end
  return { m['a'] or '', m['b'] or '', seg }
end
`;

/** One loaded script: its source, its SHA and the arity its caller must honour. */
export interface LuaScript {
  readonly name: string;
  readonly keys: number;
  readonly argv: number;
  readonly source: string;
  readonly sha: string;
}

function define(name: string, keys: number, argv: number, body: string): LuaScript {
  const source = `${PRELUDE}\n${body}`;
  return {
    name,
    keys,
    argv,
    source,
    sha: createHash('sha1').update(source).digest('hex'),
  };
}

/* -------------------------------------------------------------------------- */
/* Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Create the session row. KEYS: session, sessions.
 * ARGV: prefix, sid, instanceId, segment, ipHash, clientHash, sessionTtl.
 *
 * Preserves I1: the row is created in exactly one state, IDLE.
 */
const createSession = define(
  'createSession',
  2,
  7,
  `
local now = nowMs()
redis.call('HSET', KEYS[1],
  'sid', ARGV[2],
  'state', 'IDLE',
  'instanceId', ARGV[3],
  'segment', ARGV[4],
  'ipHash', ARGV[5],
  'clientHash', ARGV[6],
  'createdAt', now,
  'lastSeenAt', now)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[7]))
redis.call('SADD', KEYS[2], ARGV[2])
return { 'OK', tostring(now) }
`,
);

/**
 * Refresh every TTL this session depends on. KEYS: session, user_match.
 * ARGV: prefix, sid, sessionTtl, matchTtl.
 *
 * Preserves I7: a session stops being matchable within one TTL of its socket
 * going away, because only a live connection refreshes it.
 */
const heartbeat = define(
  'heartbeat',
  2,
  4,
  `
if redis.call('EXISTS', KEYS[1]) == 0 then return { 'SESSION_GONE' } end
redis.call('HSET', KEYS[1], 'lastSeenAt', nowMs())
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
local state = redis.call('HGET', KEYS[1], 'state')
local mid = redis.call('GET', KEYS[2])
if mid then
  local matchTtl = tonumber(ARGV[4])
  redis.call('EXPIRE', KEYS[2], matchTtl)
  redis.call('EXPIRE', kMatch(mid), matchTtl)
  redis.call('EXPIRE', kDedupe(mid), matchTtl)
end
return { 'OK', state or '', mid or '' }
`,
);

/**
 * Remove every trace of a session except its match, which the caller ends
 * separately so that both sides are cleaned by one script (§13).
 * KEYS: session, sessions, user_match, conn:{ipHash}.
 * ARGV: prefix, sid.
 *
 * Idempotent: running it twice returns GONE the second time and changes
 * nothing, which is what makes the close handler safe to run from both the
 * 'close' and 'error' paths.
 */
const closeSession = define(
  'closeSession',
  4,
  2,
  `
local sid = ARGV[2]
local flat = redis.call('HGETALL', KEYS[1])
local h = hashToTable(flat)
if h['segment'] and h['segment'] ~= '' then
  redis.call('SREM', kQueue(h['segment']), sid)
end
redis.call('SREM', KEYS[2], sid)
redis.call('SREM', KEYS[4], sid)
if redis.call('SCARD', KEYS[4]) == 0 then redis.call('DEL', KEYS[4]) end
-- user_match is deliberately left in place: endMatch clears both sides, and
-- clearing only ours here would strand the partner pointing at a match record
-- nobody is going to take down.
local mid = redis.call('GET', KEYS[3])
redis.call('DEL', KEYS[1])
if #flat == 0 then return { 'GONE', mid or '' } end
return { 'CLOSED', mid or '' }
`,
);

/* -------------------------------------------------------------------------- */
/* Matchmaking                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Enter the queue. KEYS: session, user_match, queue, segments.
 * ARGV: prefix, sid, segment, sessionTtl.
 *
 * Preserves I3 (queue membership implies SEARCHING and no match) and D4: the
 * caller is in the SET before it scans, so two simultaneous joiners cannot both
 * see an empty queue.
 */
const joinQueue = define(
  'joinQueue',
  4,
  4,
  `
if redis.call('EXISTS', KEYS[1]) == 0 then return { 'SESSION_GONE' } end
local existing = redis.call('GET', KEYS[2])
if existing then return { 'ALREADY_MATCHED', existing } end
local sessionTtl = tonumber(ARGV[4])
local state = redis.call('HGET', KEYS[1], 'state')
redis.call('SADD', KEYS[4], ARGV[3])
if state == 'SEARCHING' then
  -- Idempotent, and self-repairing: if the queue entry was reaped while the
  -- session still says SEARCHING, this puts it back rather than leaving a
  -- session that believes it is queued and never matches.
  redis.call('SADD', KEYS[3], ARGV[2])
  redis.call('EXPIRE', KEYS[1], sessionTtl)
  return { 'ALREADY_SEARCHING', redis.call('SCARD', KEYS[3]) }
end
redis.call('HSET', KEYS[1],
  'state', 'SEARCHING',
  'segment', ARGV[3],
  'enqueuedAt', nowMs(),
  'lastSeenAt', nowMs())
redis.call('EXPIRE', KEYS[1], sessionTtl)
redis.call('SADD', KEYS[3], ARGV[2])
return { 'OK', redis.call('SCARD', KEYS[3]) }
`,
);

/**
 * Leave the queue without disconnecting. KEYS: session, user_match, queue.
 * ARGV: prefix, sid, sessionTtl.
 *
 * Idempotent: an already-IDLE session returns OK rather than an error, so a
 * client that sends `leave_queue` twice is not told it did something wrong.
 */
const leaveQueue = define(
  'leaveQueue',
  3,
  3,
  `
if redis.call('EXISTS', KEYS[1]) == 0 then return { 'SESSION_GONE' } end
local mid = redis.call('GET', KEYS[2])
if mid then return { 'ALREADY_MATCHED', mid } end
redis.call('SREM', KEYS[3], ARGV[2])
redis.call('HSET', KEYS[1], 'state', 'IDLE', 'lastSeenAt', nowMs())
redis.call('HDEL', KEYS[1], 'enqueuedAt')
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return { 'OK' }
`,
);

/**
 * Attempt to pair the caller with someone already waiting.
 * KEYS: queue, session, user_match, matches, match(mid).
 * ARGV: prefix, sid, segment, mid, sampleK, matchTtl, sessionTtl,
 *       ipDimension, clientDimension.
 *
 * Preserves I2, I3, I4, I5 and I12. Every branch that decides the caller is not
 * matchable removes it from the queue first, so an ABORT never leaves a stale
 * entry behind for the next searcher to trip over.
 */
const tryMatch = define(
  'tryMatch',
  5,
  9,
  `
local sid = ARGV[2]
local seg = ARGV[3]
local mid = ARGV[4]
local sample = tonumber(ARGV[5])
local matchTtl = tonumber(ARGV[6])
local sessionTtl = tonumber(ARGV[7])
local ipOn = ARGV[8] == '1'
local clientOn = ARGV[9] == '1'

if redis.call('EXISTS', KEYS[2]) == 0 then
  redis.call('SREM', KEYS[1], sid)
  return { 'ABORT', 'SESSION_GONE' }
end
if redis.call('GET', KEYS[3]) then
  -- A peer matched us between joining and scanning. The 'matched' event is
  -- already on its way to us; this attempt has nothing left to do (§10.1).
  redis.call('SREM', KEYS[1], sid)
  return { 'ABORT', 'ALREADY_MATCHED' }
end
local mine = redis.call('HMGET', KEYS[2], 'state', 'ipHash', 'clientHash')
if mine[1] ~= 'SEARCHING' then
  redis.call('SREM', KEYS[1], sid)
  return { 'ABORT', 'NOT_SEARCHING' }
end
local myIp, myClient = mine[2], mine[3]

-- I12: either direction of either dimension is enough to refuse the pair.
local function isBlocked(cIp, cClient)
  if ipOn and myIp and cIp then
    if redis.call('SISMEMBER', kBlocks(myIp), cIp) == 1 then return true end
    if redis.call('SISMEMBER', kBlocks(cIp), myIp) == 1 then return true end
  end
  if clientOn and myClient and cClient then
    if redis.call('SISMEMBER', kBlocks(myClient), cClient) == 1 then return true end
    if redis.call('SISMEMBER', kBlocks(cClient), myClient) == 1 then return true end
  end
  return false
end

local cands = redis.call('SRANDMEMBER', KEYS[1], sample + 1)
local cleaned = 0
local blockedSkipped = 0
local best = nil
local bestAt = nil
for i = 1, #cands do
  local c = cands[i]
  if c ~= sid then
    local ch = redis.call('HMGET', kSession(c), 'state', 'ipHash', 'clientHash', 'enqueuedAt')
    if (not ch[1]) or ch[1] ~= 'SEARCHING' or redis.call('GET', kUserMatch(c)) then
      -- Stale entry GC (§10.11): the queue is repaired by every scan that
      -- walks over it, so a crashed instance's entries do not accumulate.
      redis.call('SREM', KEYS[1], c)
      cleaned = cleaned + 1
    elseif isBlocked(ch[2], ch[3]) then
      -- Skipped, NOT removed: this candidate is blocked relative to the caller
      -- only, and must stay matchable for everyone else.
      blockedSkipped = blockedSkipped + 1
    else
      local at = tonumber(ch[4]) or 0
      if (not best) or at < bestAt then
        best = c
        bestAt = at
      end
    end
  end
end

if not best then
  return { 'WAITING', cleaned, blockedSkipped, redis.call('SCARD', KEYS[1]) }
end

local now = nowMs()
redis.call('SREM', KEYS[1], sid, best)
redis.call('SET', KEYS[3], mid, 'EX', matchTtl)
redis.call('SET', kUserMatch(best), mid, 'EX', matchTtl)
redis.call('HSET', KEYS[5], 'a', sid, 'b', best, 'segment', seg, 'createdAt', now)
redis.call('EXPIRE', KEYS[5], matchTtl)
redis.call('SADD', KEYS[4], mid)
local sides = { sid, best }
for i = 1, #sides do
  local sk = kSession(sides[i])
  redis.call('HSET', sk, 'state', 'MATCHED', 'matchId', mid)
  redis.call('HDEL', sk, 'enqueuedAt')
  redis.call('EXPIRE', sk, sessionTtl)
end
return { 'MATCHED', mid, best, cleaned, blockedSkipped }
`,
);

/**
 * End a match, symmetrically. KEYS: match(mid). ARGV: prefix, mid, sessionTtl.
 *
 * The winner (the caller whose DEL removed the record) is the one that notifies
 * the peer; every other caller gets ALREADY_ENDED and treats it as success
 * (D6). Both sides are cleaned by whichever call wins, so a losing caller never
 * has to clean anything up.
 */
const endMatch = define(
  'endMatch',
  1,
  3,
  `
local r = endMatchInline(ARGV[2], tonumber(ARGV[3]))
if not r then return { 'ALREADY_ENDED' } end
return { 'ENDED', r[1], r[2], r[3] }
`,
);

/* -------------------------------------------------------------------------- */
/* Message routing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Resolve who a message goes to, and reject a replay of it, in one script.
 * KEYS: user_match(sid).
 * ARGV: prefix, sid, clientMsgId, dedupeMax, matchTtl.
 *
 * Preserves I6 and I14. The two questions are answered together deliberately:
 * if the dedupe check were a separate round trip, two concurrent copies of the
 * same frame could both pass it and both be delivered (§10.17).
 *
 * The dedupe entry is written last, after the partner has been resolved, so a
 * message that could not be routed does not burn its id and can be retried.
 */
const resolvePartner = define(
  'resolvePartner',
  1,
  5,
  `
local route = resolveRouteInline(ARGV[2])
if not route then return { 'NOT_MATCHED' } end
local mid, partner, partnerInstance = route[1], route[2], route[3]
if partnerInstance == '' then return { 'PARTNER_GONE', mid } end
local dk = kDedupe(mid)
if redis.call('SCARD', dk) >= tonumber(ARGV[4]) then return { 'DEDUPE_FULL', mid } end
if redis.call('SADD', dk, ARGV[3]) == 0 then return { 'DUPLICATE', mid } end
redis.call('EXPIRE', dk, tonumber(ARGV[5]))
return { 'OK', mid, partner, partnerInstance }
`,
);

/**
 * Resolve the recipient without touching the dedupe set.
 * KEYS: user_match(sid). ARGV: prefix, sid.
 *
 * For advisory traffic — a typing indicator — which has no replay to protect
 * against and must not consume a message id. Sharing `resolveRouteInline` with
 * `resolvePartner` is the point: two copies of "who is my partner" would
 * eventually answer differently.
 */
const resolveRoute = define(
  'resolveRoute',
  1,
  2,
  `
local route = resolveRouteInline(ARGV[2])
if not route then return { 'NOT_MATCHED' } end
if route[3] == '' then return { 'PARTNER_GONE', route[1] } end
return { 'OK', route[1], route[2], route[3] }
`,
);

/* -------------------------------------------------------------------------- */
/* Limits                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Token bucket. KEYS: rl:{command}:{sid}.
 * ARGV: prefix, perSecond, burst, ttlSeconds, cost.
 *
 * Tokens are stored as a string because Redis Lua converts a returned number to
 * an integer, which would truncate a partly-refilled bucket to zero on every
 * pass and make every limit stricter than configured.
 */
const rateLimit = define(
  'rateLimit',
  1,
  5,
  `
local rate = tonumber(ARGV[2])
local burst = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local cost = tonumber(ARGV[5])
local now = nowMs()
local h = redis.call('HMGET', KEYS[1], 't', 'ts')
local tokens = tonumber(h[1])
local ts = tonumber(h[2])
if (not tokens) or (not ts) then
  tokens = burst
  ts = now
end
local elapsed = (now - ts) / 1000
-- Redis is the single clock, so this can only be negative if the server's own
-- clock stepped backwards. Treat it as no elapsed time rather than as credit.
if elapsed < 0 then elapsed = 0 end
tokens = math.min(burst, tokens + elapsed * rate)
local allowed = 0
local retryAfterMs = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retryAfterMs = math.ceil(((cost - tokens) / rate) * 1000)
end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'ts', tostring(now))
redis.call('EXPIRE', KEYS[1], ttl)
return { allowed, retryAfterMs, tostring(tokens) }
`,
);

/**
 * Connection attempts from one IP hash per fixed window.
 * KEYS: rl:conn:{ipHash}. ARGV: prefix, limit, windowSeconds.
 */
const connRateLimit = define(
  'connRateLimit',
  1,
  3,
  `
local window = tonumber(ARGV[3])
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], window)
  ttl = window
end
if count > tonumber(ARGV[2]) then return { 0, count, ttl } end
return { 1, count, ttl }
`,
);

/**
 * Claim one of an IP hash's concurrent connection slots (R8).
 * KEYS: conn:{ipHash}. ARGV: prefix, sid, max, ttlSeconds.
 *
 * The slot holder is the session id, not a counter. A counter cannot be
 * reconciled after a SIGKILL without a global scan of every session; a set of
 * session ids can be repaired in place by checking which members still have a
 * session row — and that cost is paid only by an IP that has actually reached
 * its limit (§10.20).
 */
const connAcquire = define(
  'connAcquire',
  1,
  4,
  `
local sid = ARGV[2]
local max = tonumber(ARGV[3])
redis.call('SADD', KEYS[1], sid)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
local n = redis.call('SCARD', KEYS[1])
if n > max then
  local members = redis.call('SMEMBERS', KEYS[1])
  for i = 1, #members do
    local m = members[i]
    if m ~= sid and redis.call('EXISTS', kSession(m)) == 0 then
      redis.call('SREM', KEYS[1], m)
    end
  end
  n = redis.call('SCARD', KEYS[1])
  if n > max then
    redis.call('SREM', KEYS[1], sid)
    return { 0, redis.call('SCARD', KEYS[1]) }
  end
end
return { 1, n }
`,
);

/** Release a concurrency slot. KEYS: conn:{ipHash}. ARGV: prefix, sid. */
const connRelease = define(
  'connRelease',
  1,
  2,
  `
redis.call('SREM', KEYS[1], ARGV[2])
local n = redis.call('SCARD', KEYS[1])
if n == 0 then redis.call('DEL', KEYS[1]) end
return { n }
`,
);

/* -------------------------------------------------------------------------- */
/* Safety                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Block the current partner and end the match, atomically.
 * KEYS: user_match(sid).
 * ARGV: prefix, sid, blockTtl, ipDimension, clientDimension, sessionTtl.
 *
 * Resolving the partner and recording the block have to be one script. Doing
 * them as two round trips leaves a window in which the match ends and a new one
 * begins between the read and the write, so the user blocks somebody they were
 * never talking to — rare, silent, and impossible to explain to whoever gets
 * blocked (§10.16).
 *
 * The block is stored in one direction only: the blocker refuses the blocked.
 * `tryMatch` checks both directions, so the refusal is mutual in effect without
 * being mutual in storage — which matters, because a record written under the
 * blocked user's key is a record they could observe.
 *
 * A partner whose session row has already expired cannot be blocked: their
 * hashes are gone. The script reports what it actually recorded rather than
 * claiming success, so the caller never tells a user they are protected when
 * nothing was written.
 */
const blockPartner = define(
  'blockPartner',
  1,
  6,
  `
local sid = ARGV[2]
local mid = redis.call('GET', KEYS[1])
if not mid then return { 'NOT_MATCHED' } end
local m = redis.call('HMGET', kMatch(mid), 'a', 'b')
if not m[1] then return { 'NOT_MATCHED' } end
local partner
if m[1] == sid then
  partner = m[2]
elseif m[2] == sid then
  partner = m[1]
else
  return { 'NOT_MATCHED' }
end

local ttl = tonumber(ARGV[3])
local mine = redis.call('HMGET', kSession(sid), 'ipHash', 'clientHash')
local theirs = redis.call('HMGET', kSession(partner), 'ipHash', 'clientHash')
local recorded = 0
if ARGV[4] == '1' and mine[1] and theirs[1] then
  redis.call('SADD', kBlocks(mine[1]), theirs[1])
  redis.call('EXPIRE', kBlocks(mine[1]), ttl)
  recorded = recorded + 1
end
if ARGV[5] == '1' and mine[2] and theirs[2] then
  redis.call('SADD', kBlocks(mine[2]), theirs[2])
  redis.call('EXPIRE', kBlocks(mine[2]), ttl)
  recorded = recorded + 1
end

local ended = 0
if endMatchInline(mid, tonumber(ARGV[6])) then ended = 1 end
-- The blocked party's hashes are returned so the caller can write a truthful
-- database row. They are salted hashes the server computed itself, and they
-- never reach a client.
return { 'BLOCKED', mid, partner, recorded, ended, theirs[1] or '', theirs[2] or '' }
`,
);

/* -------------------------------------------------------------------------- */
/* Janitor                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Drop queue entries that no longer satisfy I3. KEYS: queue. ARGV: prefix, batch.
 *
 * `tryMatch` already repairs whatever it walks over; this exists for a queue
 * whose entries are all stale, where nobody is scanning because nobody is
 * matching.
 */
const janitorQueue = define(
  'janitorQueue',
  1,
  2,
  `
local members = redis.call('SRANDMEMBER', KEYS[1], tonumber(ARGV[2]))
local removed = 0
for i = 1, #members do
  local sid = members[i]
  local state = redis.call('HGET', kSession(sid), 'state')
  if (not state) or state ~= 'SEARCHING' or redis.call('GET', kUserMatch(sid)) then
    redis.call('SREM', KEYS[1], sid)
    removed = removed + 1
  end
end
return { removed, redis.call('SCARD', KEYS[1]) }
`,
);

/**
 * Drop expired matches and end matches that have lost a participant.
 * KEYS: matches. ARGV: prefix, batch, sessionTtl.
 *
 * Returns `{ dropped, ended, survivorSid, matchId, ... }`. The survivors are
 * returned rather than notified here because notification is a Pub/Sub publish,
 * which a Lua script must not do: a script that published would have its
 * effects replicated to a replica that has no subscribers.
 */
const janitorMatches = define(
  'janitorMatches',
  1,
  3,
  `
local mids = redis.call('SRANDMEMBER', KEYS[1], tonumber(ARGV[2]))
local sessionTtl = tonumber(ARGV[3])
local dropped = 0
local ended = 0
local survivors = {}
for i = 1, #mids do
  local mid = mids[i]
  local m = redis.call('HMGET', kMatch(mid), 'a', 'b')
  if not m[1] then
    redis.call('SREM', KEYS[1], mid)
    redis.call('DEL', kDedupe(mid))
    dropped = dropped + 1
  else
    local aAlive = redis.call('EXISTS', kSession(m[1])) == 1
    local bAlive = redis.call('EXISTS', kSession(m[2])) == 1
    if not (aAlive and bAlive) then
      if endMatchInline(mid, sessionTtl) then
        ended = ended + 1
        if aAlive then
          survivors[#survivors + 1] = m[1]
          survivors[#survivors + 1] = mid
        end
        if bAlive then
          survivors[#survivors + 1] = m[2]
          survivors[#survivors + 1] = mid
        end
      end
    end
  end
end
local out = { dropped, ended }
for i = 1, #survivors do out[#out + 1] = survivors[i] end
return out
`,
);

/**
 * Reap sessions whose row is gone, and sessions owned by an instance whose
 * liveness beacon has expired (§10.13). KEYS: sessions. ARGV: prefix, batch,
 * sessionTtl.
 *
 * Returns `{ reaped, ended, survivorSid, matchId, ... }`.
 */
const janitorSessions = define(
  'janitorSessions',
  1,
  3,
  `
local sids = redis.call('SRANDMEMBER', KEYS[1], tonumber(ARGV[2]))
local sessionTtl = tonumber(ARGV[3])
local reaped = 0
local ended = 0
local survivors = {}
for i = 1, #sids do
  local sid = sids[i]
  local iid = redis.call('HGET', kSession(sid), 'instanceId')
  local dead = false
  if not iid then
    dead = true
  elseif redis.call('EXISTS', kInstance(iid)) == 0 then
    dead = true
  end
  if dead then
    reaped = reaped + 1
    redis.call('SREM', KEYS[1], sid)
    local mid = redis.call('GET', kUserMatch(sid))
    -- Delete the row before ending the match, so the survivor's next scan
    -- cannot pick this session back up in between.
    redis.call('DEL', kSession(sid))
    if mid then
      local m = redis.call('HMGET', kMatch(mid), 'a', 'b')
      local survivor = ''
      if m[1] == sid then
        survivor = m[2] or ''
      elseif m[2] == sid then
        survivor = m[1] or ''
      end
      if endMatchInline(mid, sessionTtl) then
        ended = ended + 1
        if survivor ~= '' and redis.call('EXISTS', kSession(survivor)) == 1 then
          survivors[#survivors + 1] = survivor
          survivors[#survivors + 1] = mid
        end
      end
      redis.call('DEL', kUserMatch(sid))
    end
  end
end
-- A survivor named early in the sweep can itself be reaped later in the same
-- sweep — two sessions of one crashed instance are exactly that case. Filter
-- once at the end so the caller is never told to notify a session this pass
-- has already deleted.
local out = { reaped, ended }
for i = 1, #survivors, 2 do
  if redis.call('EXISTS', kSession(survivors[i])) == 1 then
    out[#out + 1] = survivors[i]
    out[#out + 1] = survivors[i + 1]
  end
end
return out
`,
);

/** Drop instance ids whose beacon has expired. KEYS: instances. ARGV: prefix, batch. */
const janitorInstances = define(
  'janitorInstances',
  1,
  2,
  `
local iids = redis.call('SRANDMEMBER', KEYS[1], tonumber(ARGV[2]))
local removed = 0
for i = 1, #iids do
  if redis.call('EXISTS', kInstance(iids[i])) == 0 then
    redis.call('SREM', KEYS[1], iids[i])
    removed = removed + 1
  end
end
return { removed, redis.call('SCARD', KEYS[1]) }
`,
);

/** Refresh this instance's liveness beacon. KEYS: instance, instances. ARGV: prefix, iid, ttl. */
const instanceBeacon = define(
  'instanceBeacon',
  2,
  3,
  `
redis.call('SET', KEYS[1], tostring(nowMs()), 'EX', tonumber(ARGV[3]))
redis.call('SADD', KEYS[2], ARGV[2])
return { 'OK' }
`,
);

export const SCRIPTS = {
  createSession,
  heartbeat,
  closeSession,
  joinQueue,
  leaveQueue,
  tryMatch,
  endMatch,
  resolvePartner,
  resolveRoute,
  rateLimit,
  connRateLimit,
  connAcquire,
  connRelease,
  blockPartner,
  janitorQueue,
  janitorMatches,
  janitorSessions,
  janitorInstances,
  instanceBeacon,
} as const;

export type ScriptName = keyof typeof SCRIPTS;

/** Raw Redis reply shape: scripts always return a flat or nested array. */
export type ScriptReply = (string | number | ScriptReply)[];

export class ScriptArityError extends Error {
  constructor(name: string, what: string, expected: number, actual: number) {
    super(`redis script ${name}: expected ${expected} ${what}, got ${actual}`);
    this.name = 'ScriptArityError';
  }
}

/**
 * Runs the scripts, preferring `EVALSHA`.
 *
 * `SCRIPT LOAD` at startup is not enough on its own: `SCRIPT FLUSH`, a failover
 * to a replica that never loaded them, or a Redis restart (which happens
 * routinely here — persistence is off, D12) all leave the cache empty. The
 * NOSCRIPT fallback means that recovery is one retry rather than an outage.
 */
export class ScriptRunner {
  private readonly loaded = new Set<string>();

  constructor(private readonly client: Redis) {}

  /** Pre-load every script. Optional: a NOSCRIPT reply reloads on demand. */
  async loadAll(): Promise<void> {
    for (const script of Object.values(SCRIPTS)) {
      const sha = await this.client.script('LOAD', script.source);
      if (typeof sha === 'string') this.loaded.add(sha);
    }
  }

  /** Forget which scripts are cached. Used after a reconnect in tests. */
  reset(): void {
    this.loaded.clear();
  }

  async run(name: ScriptName, keys: string[], argv: (string | number)[]): Promise<ScriptReply> {
    const script = SCRIPTS[name];
    if (keys.length !== script.keys) {
      throw new ScriptArityError(name, 'KEYS', script.keys, keys.length);
    }
    if (argv.length !== script.argv) {
      throw new ScriptArityError(name, 'ARGV', script.argv, argv.length);
    }

    const args = [...keys, ...argv.map(String)];
    try {
      const reply = await this.client.evalsha(script.sha, keys.length, ...args);
      this.loaded.add(script.sha);
      return reply as ScriptReply;
    } catch (err) {
      if (!isNoScriptError(err)) throw err;
      this.loaded.delete(script.sha);
      const reply = await this.client.eval(script.source, keys.length, ...args);
      this.loaded.add(script.sha);
      return reply as ScriptReply;
    }
  }
}

function isNoScriptError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('NOSCRIPT');
}
