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
    connSessions: (ipHash) => `${prefix}:conn:${assertComponent(ipHash, 'ip hash')}`,
    blocks: (blockKey) => `${prefix}:blocks:${assertComponent(blockKey, 'block key')}`,
    ban: (subjectKey) => `${prefix}:ban:${assertComponent(subjectKey, 'subject key')}`,
    resume: (tokenHash) => `${prefix}:resume:${assertComponent(tokenHash, 'resume hash')}`,
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
