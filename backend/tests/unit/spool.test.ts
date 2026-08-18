/**
 * The outage spool (D28): bounds, partial writes and corruption.
 *
 * Uses a real temporary directory, because the behaviour under test *is* the
 * file handling — a mocked filesystem would test the mock.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { silentLogger } from '../helpers/fakes';
import { loadConfig, type Config, type Env } from '../../src/config';
import { FileSpool } from '../../src/storage/spool';
import type { QueuedRecord } from '../../src/storage/records';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kbb-spool-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    SPOOL_DIR: dir,
    ...overrides,
  });
}

function spool(overrides: Env = {}): FileSpool {
  const instance = new FileSpool(config(overrides), silentLogger());
  instance.open();
  return instance;
}

let counter = 0;

function entry(sessionId = 's_a', body = 'hello'): QueuedRecord {
  counter += 1;
  return {
    priority: 'p3',
    sessionId,
    enqueuedAtMs: Date.now(),
    record: {
      kind: 'message',
      messageId: `msg_${counter}`,
      conversationId: 'c1',
      senderSessionId: sessionId,
      serverTimestamp: '2026-08-18T12:00:00.000Z',
      type: 'text',
      body,
      moderationAction: 'allow',
      moderationFlags: [],
    },
  };
}

const spoolPath = (): string => join(dir, 'spool.jsonl');

describe('writing and reading', () => {
  it('round-trips records', () => {
    const instance = spool();
    const written = [entry('s_a'), entry('s_b')];
    expect(instance.write(written)).toBe(2);

    const read = instance.read();
    expect(read).toHaveLength(2);
    expect(read[0]?.record).toMatchObject({ kind: 'message', body: 'hello' });
  });

  it('creates the directory restrictively', () => {
    spool();
    const mode = statSync(dir).mode & 0o777;
    // The spool holds plaintext message bodies. 0700 on the directory is the
    // part this process controls; encryption at rest is the platform's (§2.1).
    if (process.platform !== 'win32') expect(mode).toBe(0o700);
    expect(statSync(spoolPath()).isFile()).toBe(true);
  });

  it('writes one line per record, so a partial write costs one record', () => {
    const instance = spool();
    instance.write([entry(), entry()]);
    const lines = readFileSync(spoolPath(), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it('reads back what a previous process left behind', () => {
    const first = spool();
    first.write([entry(), entry()]);

    // A backend restart: a file spool survives it, which is most of the point
    // of choosing it over the Redis backend.
    const second = spool();
    expect(second.stats().records).toBe(2);
    expect(second.read()).toHaveLength(2);
  });

  it('does not remove records on read', () => {
    const instance = spool();
    instance.write([entry()]);
    instance.read();
    // The caller clears only once the records are safely written, so a failure
    // part-way through a drain leaves the spool intact rather than half-eaten.
    expect(instance.read()).toHaveLength(1);
  });

  it('clears by rotating and unlinking', () => {
    const instance = spool();
    instance.write([entry()]);
    instance.clear();
    expect(instance.isEmpty).toBe(true);
    expect(instance.read()).toEqual([]);
    expect(readFileSync(spoolPath(), 'utf8')).toBe('');
  });
});

describe('bounds', () => {
  it('stops at the record limit and counts what it refused', () => {
    const instance = spool({ SPOOL_MAX_RECORDS: '2' });
    expect(instance.write([entry(), entry(), entry(), entry()])).toBe(2);
    expect(instance.stats().refused).toBe(2);
  });

  it('stops at the byte limit', () => {
    const instance = spool({ SPOOL_MAX_BYTES: '2048' });
    const big = entry('s_a', 'x'.repeat(500));
    const written = instance.write([big, big, big, big, big, big]);
    expect(written).toBeLessThan(6);
    expect(instance.stats().bytes).toBeLessThanOrEqual(2048);
    expect(instance.stats().refused).toBeGreaterThan(0);
  });

  it('refuses rather than evicting when full', () => {
    const instance = spool({ SPOOL_MAX_RECORDS: '1' });
    const first = entry('s_first');
    instance.write([first]);
    instance.write([entry('s_second')]);

    // The spool is already the degraded path; silently discarding older
    // evidence to make room for newer evidence is the worse failure.
    const read = instance.read();
    expect(read).toHaveLength(1);
    expect(read[0]?.sessionId).toBe('s_first');
  });

  it('drops records past the age limit on read, and counts them', () => {
    const instance = spool({ SPOOL_MAX_AGE_SECONDS: '60' });
    const old = { ...entry(), enqueuedAtMs: Date.now() - 120_000 };
    instance.write([old, entry()]);

    const read = instance.read();
    expect(read).toHaveLength(1);
    expect(instance.stats().expired).toBe(1);
  });
});

describe('crash safety', () => {
  it('discards a trailing partial line rather than repairing it', () => {
    const instance = spool();
    instance.write([entry('s_complete')]);
    // Exactly what a process killed mid-write leaves behind.
    appendFileSync(spoolPath(), '{"priority":"p3","sessionId":"s_trunc","enqu');

    const reopened = spool();
    const read = reopened.read();
    // A half-written record is not evidence, and guessing at its contents
    // would be worse than losing it.
    expect(read).toHaveLength(1);
    expect(read[0]?.sessionId).toBe('s_complete');
    expect(reopened.stats().corrupt).toBeGreaterThanOrEqual(1);
  });

  it('skips a corrupt line and keeps every record behind it', () => {
    writeFileSync(
      spoolPath(),
      [
        JSON.stringify(entry('s_before')),
        'this is not json at all',
        JSON.stringify(entry('s_after')),
        '',
      ].join('\n'),
    );

    const instance = spool();
    const read = instance.read();
    // One bad line must not strand every record behind it.
    expect(read.map((record) => record.sessionId)).toEqual(['s_before', 's_after']);
    expect(instance.stats().corrupt).toBe(1);
  });

  it('skips a line that parses but is not a record', () => {
    writeFileSync(
      spoolPath(),
      [JSON.stringify({ hello: 'world' }), JSON.stringify(entry('s_good')), ''].join('\n'),
    );
    const instance = spool();
    expect(instance.read().map((record) => record.sessionId)).toEqual(['s_good']);
    expect(instance.stats().corrupt).toBe(1);
  });

  it('tolerates an empty and an absent spool', () => {
    const instance = spool();
    expect(instance.read()).toEqual([]);
    rmSync(spoolPath());
    expect(instance.read()).toEqual([]);
  });
});
