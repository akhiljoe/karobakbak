/**
 * The local socket table.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS NOT
 * ---------------------------------------------------------------------------
 * This is **not** a routing table and it is not state. It answers exactly one
 * question — "is this session's socket attached to *this* process?" — and it is
 * consulted only after Redis has already decided what should happen. Every
 * matchmaking decision is made by a Lua script against state shared by all
 * instances; nothing here participates in one.
 *
 * That distinction is what keeps the design instance-count agnostic. A routing
 * table mapping sessions to instances would have to be invalidated, and would
 * be wrong for as long as it was stale. Cross-instance delivery instead
 * publishes to `chat:ev:session:{sid}`, where the channel name *is* the routing
 * key (D8), and the instance holding that socket is by definition the one
 * subscribed to it.
 */
import type { Logger } from '../logger';

/**
 * One attached WebSocket, reduced to what the lifecycle actually needs.
 *
 * Deliberately not the `ws` socket type: the lifecycle must be testable without
 * a server, and it must be impossible for lifecycle code to reach into socket
 * internals and start making transport decisions.
 */
export interface Connection {
  readonly sessionId: string;
  /** Salted hash of the client IP. The raw address never leaves the upgrade handler. */
  readonly ipHash: string;
  /** Salted hash of the browser's persistent token. A block dimension, never a credential. */
  readonly clientHash: string;
  /** True while the socket can still accept a frame. */
  readonly isOpen: boolean;
  /** Send one encoded frame. Returns false if the socket could not take it. */
  send(frame: string): boolean;
  /** Close with a protocol close code. */
  close(code: number, reason: string): void;
}

export class ConnectionRegistry {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly logger: Logger) {}

  /**
   * Attach a socket. A session id is server-generated and used once, so a
   * collision here means a bug rather than a race; the older connection is
   * closed rather than silently orphaned with no way to reach it.
   */
  add(connection: Connection): void {
    const existing = this.connections.get(connection.sessionId);
    if (existing && existing !== connection) {
      this.logger.error('duplicate session id in the local registry', {
        sessionId: connection.sessionId,
      });
      existing.close(1011, 'duplicate session');
    }
    this.connections.set(connection.sessionId, connection);
  }

  get(sessionId: string): Connection | undefined {
    return this.connections.get(sessionId);
  }

  /**
   * Detach a socket. Idempotent, and only removes the connection it was given:
   * a late close handler for a previous connection must not evict the session
   * that replaced it.
   */
  remove(sessionId: string, connection?: Connection): boolean {
    if (connection) {
      const current = this.connections.get(sessionId);
      if (current !== connection) return false;
    }
    return this.connections.delete(sessionId);
  }

  has(sessionId: string): boolean {
    return this.connections.has(sessionId);
  }

  get size(): number {
    return this.connections.size;
  }

  /** Snapshot of attached session ids. Copied, so iteration cannot be disturbed. */
  sessionIds(): string[] {
    return [...this.connections.keys()];
  }

  /** Snapshot of attached connections, for shutdown and heartbeat sweeps. */
  all(): Connection[] {
    return [...this.connections.values()];
  }

  clear(): void {
    this.connections.clear();
  }
}
