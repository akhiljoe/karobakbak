/**
 * The outage spool (D28, §14.4).
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT DURABLE STORAGE
 * ---------------------------------------------------------------------------
 * It is bounded tolerance for a database outage, and it is never described as
 * anything else — not in a comment, not in a metric name, not in a log line.
 * A host or volume failure loses it. The honest naming is the control: once
 * something is called a "queue" or a "buffer" in conversation, somebody
 * eventually relies on it surviving, and this cannot.
 *
 * ---------------------------------------------------------------------------
 * CRASH SAFETY
 * ---------------------------------------------------------------------------
 * One JSON object per line, appended with a single write. A process killed
 * mid-write leaves a trailing partial line, so the reader **discards a trailing
 * incomplete line rather than trying to repair it** — a half-written record is
 * not evidence, and guessing at its contents would be worse than losing it.
 * Any line that fails to parse is skipped and counted, never allowed to stop
 * the drain: one corrupt record must not strand every record behind it.
 *
 * Drained segments are unlinked, never rewritten in place, so a crash during a
 * drain cannot truncate records that have not been written yet.
 *
 * The file holds plaintext message bodies. Its directory is created 0700 and
 * its files 0600, and §2.1 requires it to sit on storage with encryption at
 * rest.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Config } from '../config';
import { errorFields, type Logger } from '../logger';
import type { QueuedRecord } from './records';

export interface SpoolStats {
  records: number;
  bytes: number;
  /** Lines that could not be parsed and were dropped. */
  corrupt: number;
  /** Records dropped for being older than `SPOOL_MAX_AGE_SECONDS`. */
  expired: number;
  /** Records refused because the spool was already at a bound. */
  refused: number;
}

const SEGMENT = 'spool.jsonl';

export class FileSpool {
  private readonly dir: string;
  private readonly path: string;
  private records = 0;
  private bytes = 0;
  private refused = 0;
  /**
   * Corrupt and expired records are properties of the file's *current*
   * contents, and the file is scanned on every read. Counting them per scan
   * would inflate the metric every cycle a spool sat undrained, which reads as
   * escalating corruption when nothing new has happened. So the counters are
   * split: what the last scan saw, plus what earlier scans saw and a clear has
   * since discarded.
   */
  private lastScanCorrupt = 0;
  private lastScanExpired = 0;
  private discardedCorrupt = 0;
  private discardedExpired = 0;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {
    this.dir = config.spool.dir;
    this.path = join(this.dir, SEGMENT);
  }

  /**
   * Prepare the directory and count what a previous process left behind.
   *
   * Called at startup, before anything can write: a file spool survives a
   * process restart, which is most of the point of choosing it over the Redis
   * backend.
   */
  open(): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (!existsSync(this.path)) {
      closeSync(openSync(this.path, 'a', 0o600));
      return;
    }
    const existing = this.readAll();
    this.records = existing.length;
    this.bytes = statSync(this.path).size;
    if (this.records > 0) {
      this.logger.warn('spool contains records from a previous run', {
        spoolRecords: this.records,
        spoolBytes: this.bytes,
      });
    }
  }

  stats(): SpoolStats {
    return {
      records: this.records,
      bytes: this.bytes,
      corrupt: this.discardedCorrupt + this.lastScanCorrupt,
      expired: this.discardedExpired + this.lastScanExpired,
      refused: this.refused,
    };
  }

  /**
   * Append records. Returns how many were written; anything not written was
   * refused because a bound was already reached, and is counted.
   *
   * Whichever bound binds first wins. Refusing rather than evicting is
   * deliberate here: the spool is already the degraded path, and silently
   * discarding the oldest evidence to make room for newer evidence is a worse
   * failure than declining the newer.
   */
  write(entries: readonly QueuedRecord[]): number {
    let written = 0;
    for (const entry of entries) {
      const line = `${JSON.stringify(entry)}\n`;
      const size = Buffer.byteLength(line);

      if (this.records + 1 > this.config.spool.maxRecords) {
        this.refused += entries.length - written;
        break;
      }
      if (this.bytes + size > this.config.spool.maxBytes) {
        this.refused += entries.length - written;
        break;
      }

      try {
        appendFileSync(this.path, line, { mode: 0o600 });
      } catch (err) {
        this.logger.error('failed to write to the spool', errorFields(err));
        this.refused += entries.length - written;
        break;
      }

      this.records += 1;
      this.bytes += size;
      written += 1;
    }
    return written;
  }

  /**
   * Read everything back, dropping records past `SPOOL_MAX_AGE_SECONDS`.
   *
   * Reading does not remove anything: the caller clears the spool only once
   * the records are safely written, so a failure part-way through a drain
   * leaves the spool intact rather than half-consumed.
   */
  read(nowMs = Date.now()): QueuedRecord[] {
    const maxAgeMs = this.config.spool.maxAgeSeconds * 1000;
    const kept: QueuedRecord[] = [];
    let expired = 0;
    for (const entry of this.readAll()) {
      if (nowMs - entry.enqueuedAtMs > maxAgeMs) {
        expired += 1;
        continue;
      }
      kept.push(entry);
    }
    this.lastScanExpired = expired;
    return kept;
  }

  /**
   * Discard the spooled records.
   *
   * By rotating and unlinking rather than truncating: a crash between a
   * truncate and the next write would lose whatever arrived in between, while
   * an unlink of a file nobody is appending to cannot.
   */
  clear(): void {
    if (!existsSync(this.path)) {
      this.records = 0;
      this.bytes = 0;
      return;
    }
    const drained = `${this.path}.drained`;
    try {
      renameSync(this.path, drained);
      closeSync(openSync(this.path, 'a', 0o600));
      unlinkSync(drained);
    } catch (err) {
      this.logger.error('failed to clear the spool', errorFields(err));
    }
    // Whatever the last scan found is now gone for good, so it moves from
    // "currently in the file" to "already discarded" and stops being re-counted.
    this.discardedCorrupt += this.lastScanCorrupt;
    this.discardedExpired += this.lastScanExpired;
    this.lastScanCorrupt = 0;
    this.lastScanExpired = 0;
    this.records = 0;
    this.bytes = 0;
  }

  get isEmpty(): boolean {
    return this.records === 0;
  }

  /* --- internals ----------------------------------------------------------- */

  private readAll(): QueuedRecord[] {
    let contents: string;
    try {
      contents = readFileSync(this.path, 'utf8');
    } catch {
      return [];
    }
    if (contents.length === 0) return [];

    // Split always leaves a trailing element: an empty string when the file
    // ends cleanly, and the fragment of an interrupted write when it does not.
    // Dropping the last element handles both — the fragment is discarded, not
    // repaired, because a half-written record is not evidence.
    const lines = contents.split('\n');
    const complete = lines.slice(0, -1);
    let corrupt = 0;
    if (!contents.endsWith('\n')) {
      corrupt += 1;
      this.logger.warn('discarded a partially written spool record');
    }

    const records: QueuedRecord[] = [];
    for (const line of complete) {
      if (line.length === 0) continue;
      const parsed = parseLine(line);
      if (parsed === null) {
        // Skipped, counted, and the drain continues: one bad line must not
        // strand every record behind it.
        corrupt += 1;
        continue;
      }
      records.push(parsed);
    }
    this.lastScanCorrupt = corrupt;
    return records;
  }
}

/** Parse one line, never throwing and never trusting its shape. */
function parseLine(line: string): QueuedRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const entry = parsed as Partial<QueuedRecord>;
  if (typeof entry.priority !== 'string') return null;
  if (typeof entry.sessionId !== 'string') return null;
  if (typeof entry.enqueuedAtMs !== 'number') return null;
  if (typeof entry.record !== 'object' || entry.record === null) return null;
  if (typeof (entry.record as { kind?: unknown }).kind !== 'string') return null;
  return entry as QueuedRecord;
}

/** Writes nothing. Used when `SPOOL_ENABLED=false`. */
export class DisabledSpool {
  private refused = 0;

  open(): void {
    // Nothing to prepare.
  }

  stats(): SpoolStats {
    return { records: 0, bytes: 0, corrupt: 0, expired: 0, refused: this.refused };
  }

  write(entries: readonly QueuedRecord[]): number {
    this.refused += entries.length;
    return 0;
  }

  read(): QueuedRecord[] {
    return [];
  }

  clear(): void {
    // Nothing to clear.
  }

  get isEmpty(): boolean {
    return true;
  }
}

export type Spool = FileSpool | DisabledSpool;
