/**
 * Every Redis key and Pub/Sub channel name this service uses.
 *
 * One function per key, built from the configured prefix. Nothing concatenates
 * a key at a call site, so the namespace is greppable, renameable and provably
 * complete — and no code path can invent a key the janitor does not know about.
 *
 * ---------------------------------------------------------------------------
 * WHY COMPONENTS ARE ASSERTED
 * ---------------------------------------------------------------------------
 * A Redis key is a flat byte string: a `:` inside a component silently creates
 * a key in a different logical namespace, and a wildcard inside one turns a
 * later `SCAN MATCH` into a wider scan than its author intended. Every id that
 * reaches these functions is server-generated (`util/ids.ts`, base64url) or a
 * salted hex hash, so `assertComponent` should never fire — it exists so that
 * a future code path which passes something client-derived fails loudly here
 * rather than quietly writing into someone else's namespace.
 *
 * The assertion message never includes the offending value: a component could
 * one day be derived from user input, which is exactly the case the assertion
 * is there to catch, and an error message is not a safe place for it.
 */

/** base64url ids, hex hashes and segment names all fit this. */
const SAFE_COMPONENT = /^[A-Za-z0-9_-]{1,128}$/;

export class UnsafeKeyComponentError extends Error {
  constructor(public readonly role: string) {
    super(
      `redis keys: refusing to build a key from an unsafe ${role} component — ` +
        'ids must be server-generated and match [A-Za-z0-9_-]{1,128}',
    );
    this.name = 'UnsafeKeyComponentError';
  }
}

function assertComponent(value: string, role: string): string {
  if (!SAFE_COMPONENT.test(value)) {
    throw new UnsafeKeyComponentError(role);
  }
  return value;
}

/**
 * The key namespace for one configured prefix.
 *
 * Built as a value rather than exported as module-level functions for the same
 * reason `Config` is injected: tests build their own namespace with a unique
 * prefix so parallel suites cannot collide.
 */
export interface RedisKeys {
  readonly prefix: string;

  /** HASH — the authoritative record for one session. */
  session(sid: string): string;
  /** SET — every known session id, for the janitor. */
  sessions(): string;
  /** SET — session ids currently SEARCHING in one segment. */
  queue(segment: string): string;
  /** SET — segment names that have been used at least once. */
  segments(): string;
  /** HASH — one live match: `a`, `b`, `segment`, `createdAt`. */
  match(mid: string): string;
  /** SET — live match ids, for the janitor. */
  matches(): string;
  /** STRING — the match id a session is in. The hot-path authorisation read (D5). */
  userMatch(sid: string): string;
  /** SET — client message ids already accepted for one match (I14). */
  dedupe(mid: string): string;
  /** HASH — one token bucket: `t` tokens, `ts` last refill. */
  rateLimit(command: string, sid: string): string;
  /** STRING — connection attempts from one IP hash in the current window. */
  connRate(ipHash: string): string;
  /**
   * STRING — order-creation attempts from one IP hash in the current window.
   *
   * A separate window from `connRate` on purpose. Creating an order costs a
   * round trip to the payment provider and a row in `payment_orders`, so it is
   * far more expensive per request than opening a socket and wants a far
   * tighter limit; sharing a bucket would mean one of the two numbers being
   * wrong for the other.
   */
  paymentRate(ipHash: string): string;
  /** SET — session ids currently connected from one IP hash (R8). */
  connSessions(ipHash: string): string;
  /** SET — the block keys that this block key refuses to be matched with (D18). */
  blocks(blockKey: string): string;
  /**
   * STRING — a moderator-issued ban on one subject key, checked at upgrade.
   *
   * Distinct from `blocks` in both shape and meaning. A block is *relative*: a
   * set of peers one user refuses, consulted inside `tryMatch`. A ban is
   * *absolute*: the holder of this key does not get a session at all, so it is
   * a single key with a TTL, read before a session exists. Keeping them apart
   * means a ban can never be mistaken for a peer relationship by the matching
   * path, and revoking one cannot disturb the other.
   */
  ban(subjectKey: string): string;
  /** STRING — resume-token hash to session id, so a returning socket can find its seat. */
  resume(tokenHash: string): string;
  /**
   * Where a signed-in account's avatar lives on the provider's CDN.
   *
   * **The URL, never the image.** A data URI would be about ten kilobytes on an
   * instance whose other values are ids and counters — `resume` is 44 bytes —
   * and this is the same Redis every matchmaking transition runs a Lua script
   * against. Image bytes do not belong beside the hot path; the URL is the same
   * class of value as everything else here.
   *
   * A **cache and not a record**: never written to PostgreSQL, and Redis has
   * persistence off (D12), so a restart drops it and the next sign-in refills
   * it. Every reader already treats an absent avatar as ordinary, because a
   * provider that returns none, an image too large to accept and a fetch that
   * failed are all the same to the interface.
   */
  avatar(accountId: string): string;
  /**
   * Whether an account is online *right now*.
   *
   * A key with a short TTL, refreshed while a session carrying that account is
   * connected. There is deliberately no last-seen and there will not be one:
   * "when were they last here" is a far more revealing claim than "are they
   * here", and only the second is offered.
   *
   * Redis is the right home precisely because it forgets. Presence that
   * survived a restart would be presence that was wrong.
   */
  presence(accountId: string): string;
  /** STRING — liveness beacon for one backend instance. */
  instance(iid: string): string;
  /** SET — known instance ids. */
  instances(): string;
  /** STRING — the distributed janitor lock. */
  janitorLock(): string;
  /** STRING — the deletion worker's own lock, separate so the two never contend. */
  deletionLock(): string;
  /** Pub/Sub channel for one session. The channel name IS the routing key (D8). */
  sessionChannel(sid: string): string;
  /** Parse a session id back out of a channel name, or null if it is not ours. */
  sessionIdFromChannel(channel: string): string | null;
}

export function createKeys(prefix: string): RedisKeys {
  assertComponent(prefix, 'prefix');
  const channelPrefix = `${prefix}:ev:session:`;

  return {
    prefix,

    session: (sid) => `${prefix}:session:${assertComponent(sid, 'session id')}`,
    sessions: () => `${prefix}:sessions`,
    queue: (segment) => `${prefix}:queue:${assertComponent(segment, 'segment')}`,
    segments: () => `${prefix}:segments`,
    match: (mid) => `${prefix}:match:${assertComponent(mid, 'match id')}`,
    matches: () => `${prefix}:matches`,
    userMatch: (sid) => `${prefix}:user_match:${assertComponent(sid, 'session id')}`,
    dedupe: (mid) => `${prefix}:dedupe:${assertComponent(mid, 'match id')}`,
    rateLimit: (command, sid) =>
      `${prefix}:rl:${assertComponent(command, 'command')}:${assertComponent(sid, 'session id')}`,
    connRate: (ipHash) => `${prefix}:rl:conn:${assertComponent(ipHash, 'ip hash')}`,
    paymentRate: (ipHash) => `${prefix}:rl:pay:${assertComponent(ipHash, 'ip hash')}`,
    connSessions: (ipHash) => `${prefix}:conn:${assertComponent(ipHash, 'ip hash')}`,
    blocks: (blockKey) => `${prefix}:blocks:${assertComponent(blockKey, 'block key')}`,
    ban: (subjectKey) => `${prefix}:ban:${assertComponent(subjectKey, 'subject key')}`,
    resume: (tokenHash) => `${prefix}:resume:${assertComponent(tokenHash, 'resume hash')}`,
    avatar: (accountId) => `${prefix}:avatar:${assertComponent(accountId, 'account id')}`,
    presence: (accountId) => `${prefix}:online:${assertComponent(accountId, 'account id')}`,
    instance: (iid) => `${prefix}:instance:${assertComponent(iid, 'instance id')}`,
    instances: () => `${prefix}:instances`,
    janitorLock: () => `${prefix}:janitor:lock`,
    deletionLock: () => `${prefix}:deletion:lock`,
    sessionChannel: (sid) => `${channelPrefix}${assertComponent(sid, 'session id')}`,

    sessionIdFromChannel: (channel) => {
      if (!channel.startsWith(channelPrefix)) return null;
      const sid = channel.slice(channelPrefix.length);
      // A channel name arrives from Redis, not from a client, but it is still
      // parsed defensively: a malformed one resolves to no session rather than
      // to a lookup with a strange key.
      return SAFE_COMPONENT.test(sid) ? sid : null;
    },
  };
}
