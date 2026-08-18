/**
 * Hermetic fakes for the lifecycle unit tests.
 *
 * `FakeStore` is a small in-memory model of the Redis layer, not a mock: tests
 * assert on the state it holds rather than on which methods were called, so
 * they describe what the lifecycle *did* instead of how it was implemented.
 *
 * It also exposes knobs for the situations a real Redis makes tedious to
 * arrange on demand — a session that vanishes between two calls, a match that
 * someone else ends first, a connection slot that is full.
 */
import type { Logger } from '../../src/logger';
import type {
  BlockPartnerResult,
  CloseSessionResult,
  ConnRateResult,
  ConnSlotResult,
  CreateSessionResult,
  EndMatchResult,
  HeartbeatResult,
  JoinQueueResult,
  LeaveQueueResult,
  SessionIdentity,
  TryMatchResult,
} from '../../src/redis/store';
import type { LifecycleStore } from '../../src/ws/lifecycle';
import type { Connection } from '../../src/ws/registry';

export interface FakeSession {
  sessionId: string;
  instanceId: string;
  ipHash: string;
  clientHash: string;
  state: 'IDLE' | 'SEARCHING' | 'MATCHED';
  matchId: string | null;
  enqueuedAt: number;
}

export class FakeStore implements LifecycleStore {
  readonly sessions = new Map<string, FakeSession>();
  readonly queue = new Set<string>();
  readonly matches = new Map<string, { a: string; b: string; segment: string }>();
  readonly blocks = new Map<string, Set<string>>();
  readonly connSlots = new Map<string, Set<string>>();

  /** Deny the next connection-attempt check. */
  connectionRateAllowed = true;
  /** Deny the next concurrency-slot claim. */
  connectionSlotAllowed = true;
  /** Reported by the concurrency check when it denies. */
  connectionSlotCount = 0;
  /** Cleaned/blocked counts the next tryMatch should report while waiting. */
  nextWaitingCleaned = 0;
  nextWaitingBlockedSkipped = 0;
  /** Every tryMatch call, for asserting on retry behaviour. */
  readonly tryMatchCalls: string[] = [];

  private clock = 1_000;

  /* --- construction helpers ------------------------------------------------ */

  seedSession(overrides: Partial<FakeSession> & { sessionId: string }): FakeSession {
    const session: FakeSession = {
      instanceId: 'i_one',
      ipHash: `ip-${overrides.sessionId}`,
      clientHash: `cl-${overrides.sessionId}`,
      state: 'IDLE',
      matchId: null,
      enqueuedAt: 0,
      ...overrides,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  seedMatch(matchId: string, a: string, b: string, segment = 'default'): void {
    this.matches.set(matchId, { a, b, segment });
    for (const sid of [a, b]) {
      const session = this.sessions.get(sid);
      if (session) {
        session.state = 'MATCHED';
        session.matchId = matchId;
      }
      this.queue.delete(sid);
    }
  }

  blockedBy(blockerKey: string): string[] {
    return [...(this.blocks.get(blockerKey) ?? [])];
  }

  /* --- LifecycleStore ------------------------------------------------------ */

  async createSession(identity: SessionIdentity, _segment: string): Promise<CreateSessionResult> {
    void _segment;
    this.seedSession({ ...identity });
    return { status: 'ok', createdAtMs: (this.clock += 1) };
  }

  async heartbeat(sessionId: string): Promise<HeartbeatResult> {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'session_gone' };
    return { status: 'ok', state: session.state, matchId: session.matchId };
  }

  async closeSession(sessionId: string, ipHash: string): Promise<CloseSessionResult> {
    const session = this.sessions.get(sessionId);
    this.queue.delete(sessionId);
    this.connSlots.get(ipHash)?.delete(sessionId);
    this.sessions.delete(sessionId);
    if (!session) return { status: 'gone', matchId: null };
    // Mirrors the real script: the match is left for endMatch to clean, so both
    // sides are taken down by one call.
    return { status: 'closed', matchId: session.matchId };
  }

  async joinQueue(sessionId: string, _segment: string): Promise<JoinQueueResult> {
    void _segment;
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'session_gone' };
    if (session.matchId) return { status: 'already_matched', matchId: session.matchId };
    if (session.state === 'SEARCHING') {
      this.queue.add(sessionId);
      return { status: 'already_searching', waiting: this.queue.size };
    }
    session.state = 'SEARCHING';
    session.enqueuedAt = this.clock += 1;
    this.queue.add(sessionId);
    return { status: 'ok', waiting: this.queue.size };
  }

  async leaveQueue(sessionId: string, _segment: string): Promise<LeaveQueueResult> {
    void _segment;
    const session = this.sessions.get(sessionId);
    if (!session) return { status: 'session_gone' };
    if (session.matchId) return { status: 'already_matched', matchId: session.matchId };
    this.queue.delete(sessionId);
    session.state = 'IDLE';
    return { status: 'ok' };
  }

  async tryMatch(sessionId: string, segment: string, matchId: string): Promise<TryMatchResult> {
    this.tryMatchCalls.push(matchId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.queue.delete(sessionId);
      return { status: 'abort', reason: 'session_gone' };
    }
    if (session.matchId) {
      this.queue.delete(sessionId);
      return { status: 'abort', reason: 'already_matched' };
    }
    if (session.state !== 'SEARCHING') {
      this.queue.delete(sessionId);
      return { status: 'abort', reason: 'not_searching' };
    }

    const candidates = [...this.queue]
      .filter((sid) => sid !== sessionId)
      .map((sid) => this.sessions.get(sid))
      .filter((candidate): candidate is FakeSession => candidate !== undefined)
      .filter((candidate) => candidate.state === 'SEARCHING' && candidate.matchId === null)
      .filter((candidate) => !this.isBlocked(session, candidate))
      .sort((left, right) => left.enqueuedAt - right.enqueuedAt);

    const best = candidates[0];
    if (!best) {
      return {
        status: 'waiting',
        cleaned: this.nextWaitingCleaned,
        blockedSkipped: this.nextWaitingBlockedSkipped,
        queueDepth: this.queue.size,
      };
    }

    this.seedMatch(matchId, sessionId, best.sessionId, segment);
    return {
      status: 'matched',
      matchId,
      partnerSessionId: best.sessionId,
      cleaned: 0,
      blockedSkipped: 0,
    };
  }

  async endMatch(matchId: string): Promise<EndMatchResult> {
    const match = this.matches.get(matchId);
    if (!match) return { status: 'already_ended' };
    this.matches.delete(matchId);
    for (const sid of [match.a, match.b]) {
      const session = this.sessions.get(sid);
      if (session) {
        session.state = 'IDLE';
        session.matchId = null;
      }
      this.queue.delete(sid);
    }
    return { status: 'ended', a: match.a, b: match.b, segment: match.segment };
  }

  async blockPartner(sessionId: string): Promise<BlockPartnerResult> {
    const session = this.sessions.get(sessionId);
    const matchId = session?.matchId ?? null;
    if (!session || !matchId) return { status: 'not_matched' };
    const match = this.matches.get(matchId);
    if (!match) return { status: 'not_matched' };

    const partnerId = match.a === sessionId ? match.b : match.a;
    const partner = this.sessions.get(partnerId);
    let recorded = 0;
    if (partner) {
      this.addBlock(session.ipHash, partner.ipHash);
      this.addBlock(session.clientHash, partner.clientHash);
      recorded = 2;
    }
    const ended = await this.endMatch(matchId);
    return {
      status: 'blocked',
      matchId,
      partnerSessionId: partnerId,
      recorded,
      endedByUs: ended.status === 'ended',
      blockedIpHash: partner?.ipHash ?? '',
      blockedClientHash: partner?.clientHash ?? '',
    };
  }

  async connectionRateLimit(_ipHash: string): Promise<ConnRateResult> {
    void _ipHash;
    return this.connectionRateAllowed
      ? { allowed: true, count: 1, resetSeconds: 60 }
      : { allowed: false, count: 99, resetSeconds: 42 };
  }

  async acquireConnectionSlot(ipHash: string, sessionId: string): Promise<ConnSlotResult> {
    if (!this.connectionSlotAllowed) {
      return { allowed: false, count: this.connectionSlotCount };
    }
    const slots = this.connSlots.get(ipHash) ?? new Set<string>();
    slots.add(sessionId);
    this.connSlots.set(ipHash, slots);
    return { allowed: true, count: slots.size };
  }

  async queueDepth(_segment: string): Promise<number> {
    void _segment;
    return this.queue.size;
  }

  /* --- internals ----------------------------------------------------------- */

  private addBlock(blockerKey: string, blockedKey: string): void {
    const set = this.blocks.get(blockerKey) ?? new Set<string>();
    set.add(blockedKey);
    this.blocks.set(blockerKey, set);
  }

  private isBlocked(one: FakeSession, other: FakeSession): boolean {
    const pairs: Array<[string, string]> = [
      [one.ipHash, other.ipHash],
      [other.ipHash, one.ipHash],
      [one.clientHash, other.clientHash],
      [other.clientHash, one.clientHash],
    ];
    return pairs.some(([blocker, blocked]) => this.blocks.get(blocker)?.has(blocked) === true);
  }
}

/** Records what it publishes, so a test can assert on cross-instance delivery. */
export class FakePublisher {
  readonly published: Array<{ sessionId: string; payload: string }> = [];
  /** Session ids that have a subscriber. Anything else publishes to nobody. */
  readonly subscribed = new Set<string>();
  /** Make the next publish throw, as a Redis outage would. */
  failNextPublish = false;

  async publishToSession(sessionId: string, payload: string): Promise<number> {
    if (this.failNextPublish) {
      this.failNextPublish = false;
      throw new Error('redis unavailable');
    }
    this.published.push({ sessionId, payload });
    return this.subscribed.has(sessionId) ? 1 : 0;
  }
}

/** A socket that collects the frames written to it. */
export class FakeConnection implements Connection {
  readonly frames: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  isOpen = true;
  /** Refuse the next send, as a socket over its backpressure limit would. */
  refuseSend = false;

  constructor(
    readonly sessionId: string,
    readonly ipHash = `ip-${sessionId}`,
    readonly clientHash = `cl-${sessionId}`,
  ) {}

  send(frame: string): boolean {
    if (!this.isOpen || this.refuseSend) return false;
    this.frames.push(frame);
    return true;
  }

  close(code: number, reason: string): void {
    this.isOpen = false;
    this.closes.push({ code, reason });
  }

  /** Parsed frames, for assertions that care about payloads. */
  parsed(): Array<{ type: string; payload: Record<string, unknown> }> {
    return this.frames.map((frame) => JSON.parse(frame));
  }
}

/** A logger that captures instead of writing, so tests can assert on redaction. */
export function silentLogger(): Logger & { lines: Array<{ msg: string; fields?: unknown }> } {
  const lines: Array<{ msg: string; fields?: unknown }> = [];
  const logger: Logger = {
    debug: (msg, fields) => lines.push({ msg, fields }),
    info: (msg, fields) => lines.push({ msg, fields }),
    warn: (msg, fields) => lines.push({ msg, fields }),
    error: (msg, fields) => lines.push({ msg, fields }),
    child: () => logger,
  };
  return Object.assign(logger, { lines });
}
