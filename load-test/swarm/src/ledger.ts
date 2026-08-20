/**
 * The run ledger: one NDJSON line per observable event, per bot.
 *
 * ---------------------------------------------------------------------------
 * WHY THE LEDGER STORES HASHES AND NOT TEXT
 * ---------------------------------------------------------------------------
 * The strongest oracle this harness has is pair reconstruction: for one match,
 * what the sender was acked for must equal what the partner received, in order.
 * That comparison needs *identity*, not content — a 12-character hash proves
 * two messages are the same message just as well as the body does.
 *
 * So the ledger carries `hash` and `chars`, never `text`. This repository's
 * rule about message content (CLAUDE.md #1, invariant I8) is written about the
 * server, and a harness file is not inside that boundary. But a load-test
 * artefact full of chat bodies is a file someone will eventually paste into an
 * issue, and the oracle does not need it. Cheaper to never have it.
 *
 * The one place text still exists is the corpus itself, which is a static file
 * of synthetic lines — and that is exactly what makes oracle 5 possible: known
 * strings to grep the server's logs for.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname } from 'node:path';

/** Every event kind the oracles know how to read. */
export type LedgerEventType =
  /** A socket upgrade was attempted. */
  | 'connect_attempt'
  /** The upgrade succeeded and `connected` arrived. */
  | 'connected'
  /** The upgrade was refused. `status` says how. */
  | 'connect_refused'
  | 'queued'
  | 'matched'
  /** This bot handed a message to the socket. */
  | 'sent'
  /** The server acked a message this bot sent. */
  | 'ack'
  /** A message arrived from the partner. */
  | 'received'
  | 'skipped'
  | 'left_chat'
  | 'left_queue'
  | 'blocked'
  | 'reported'
  | 'partner_gone'
  | 'protocol_error'
  | 'closed'
  /** The harness itself misbehaved — recorded so a bad run cannot look clean. */
  | 'harness_error';

export interface LedgerEvent {
  /** Milliseconds since the epoch, taken once at the moment the event happened. */
  t: number;
  /** Stable bot identifier: `b` + zero-padded index. */
  bot: string;
  /** Scenario id from the catalogue, e.g. `N1`. */
  scenario: string;
  type: LedgerEventType;
  /** Server-assigned match id. The join key for pair reconstruction. */
  matchId?: string;
  /** Server session id, for correlating against backend logs. */
  sessionId?: string;
  /** Client correlation token on a `sent`/`ack` pair. */
  cid?: string;
  /** Server message id on `ack`/`received`. */
  messageId?: string;
  /** Content identity. See the note at the top of this file. */
  hash?: string;
  /** Character count of the body, which is safe and occasionally diagnostic. */
  chars?: number;
  /** Per-match monotonic counter, so ordering survives a merge across workers. */
  seq?: number;
  /** `message_ack.delivered` — false means moderation withheld it (D20). */
  delivered?: boolean;
  /** `message_ack.route` — local or remote, i.e. whether Pub/Sub carried it. */
  route?: string;
  /** Protocol error code, or a close code, or an HTTP status. */
  code?: string | number;
  /** Free-form, never message content: a reason label from a fixed set. */
  reason?: string;
  /** Milliseconds, for latency events (ack round trip, queue to match). */
  ms?: number;
}

/** Content identity. Truncated because collisions across one run are not a risk. */
export function contentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16);
}

/**
 * A buffered NDJSON writer.
 *
 * Buffered because a worker holding a thousand sockets cannot afford a syscall
 * per event: the harness would start measuring its own I/O and report it as
 * server latency. Flushed on a timer and on close, so a killed run still leaves
 * most of its evidence behind.
 */
export class Ledger {
  private readonly stream: WriteStream;
  private buffer: string[] = [];
  private readonly flushTimer: NodeJS.Timeout;
  private closed = false;

  constructor(
    private readonly path: string,
    flushIntervalMs = 500,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.stream = createWriteStream(path, { flags: 'w', encoding: 'utf8' });
    this.flushTimer = setInterval(() => this.flush(), flushIntervalMs);
    this.flushTimer.unref();
  }

  record(event: LedgerEvent): void {
    if (this.closed) return;
    this.buffer.push(JSON.stringify(event));
    // A large buffer is a large loss window if the process dies. 512 lines is
    // roughly one flush per busy second per worker.
    if (this.buffer.length >= 512) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const chunk = `${this.buffer.join('\n')}\n`;
    this.buffer = [];
    this.stream.write(chunk);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.flushTimer);
    this.flush();
    await new Promise<void>((resolve, reject) => {
      this.stream.once('error', reject);
      this.stream.end(() => resolve());
    });
  }

  get file(): string {
    return this.path;
  }
}
