/**
 * A2 — the persona kill switch (D-AI-9).
 *
 * The four claims that matter, each tested by making it fail rather than by
 * watching it succeed:
 *
 *   - disabling stops new joins and does NOT cut live conversations
 *   - `hard` does cut them, because that is the whole distinction
 *   - an unreadable control state refuses to join (fail closed)
 *   - a Redis flush loses nothing, because PostgreSQL is the truth
 *
 * The narrow `ControlCache` interface is what makes the failure paths testable
 * here at all. A test that needs a live Redis to prove "behaves correctly when
 * Redis is broken" tends not to get written.
 */

import { PersonaControl, withinHours, ALWAYS_ACTIVE } from '../../src/personas/control';
import type { ActiveHours, ControlCache, ControlRow } from '../../src/personas/control';
import type { Logger } from '../../src/logger';
import type { Database } from '../../src/storage/pool';

/** A cache that can be told to fail, and that can be "flushed". */
class FakeCache implements ControlCache {
  private store = new Map<string, string>();
  failGet = false;
  failSet = false;
  getCalls = 0;

  async get(key: string): Promise<string | null> {
    this.getCalls += 1;
    if (this.failGet) throw new Error('redis down');
    return this.store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<unknown> {
    if (this.failSet) throw new Error('redis down');
    this.store.set(key, value);
    return 'OK';
  }

  async del(key: string): Promise<unknown> {
    this.store.delete(key);
    return 1;
  }

  /** What a Redis restart does, given persistence is off (D12). */
  flush(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/** A database holding rows in memory, able to fail on demand. */
class FakeDb {
  rows: ControlRow[] = [];
  failQuery = false;
  selectCalls = 0;

  async query<T extends Record<string, unknown>>(
    text: string,
    values: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number }> {
    if (this.failQuery) throw new Error('database unavailable');

    if (text.trim().startsWith('select')) {
      this.selectCalls += 1;
      const rows = this.rows.map((r) => ({
        scope: r.scope,
        subject: r.subject,
        enabled: r.enabled,
        mode: r.mode,
        updated_by: r.updatedBy,
        reason: r.reason,
      })) as unknown as T[];
      return { rows, rowCount: rows.length };
    }

    // The upsert.
    const [scope, subject, enabled, mode, updatedBy, reason] = values as [
      ControlRow['scope'],
      string,
      boolean,
      ControlRow['mode'],
      string,
      string | null,
    ];
    const existing = this.rows.findIndex((r) => r.scope === scope && r.subject === subject);
    const row: ControlRow = { scope, subject, enabled, mode, updatedBy, reason };
    if (existing >= 0) this.rows[existing] = row;
    else this.rows.push(row);
    return { rows: [], rowCount: 1 };
  }
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

function build(hours: ActiveHours = ALWAYS_ACTIVE): {
  control: PersonaControl;
  db: FakeDb;
  cache: FakeCache;
} {
  const db = new FakeDb();
  const cache = new FakeCache();
  const control = new PersonaControl({
    db: db as unknown as Database,
    redis: cache,
    logger: silentLogger,
    cacheKey: 'test:persona:control',
    cacheTtlSeconds: 30,
    hours,
  });
  return { control, db, cache };
}

describe('the switch, by default', () => {
  it('allows a join when nothing is disabled', async () => {
    const { control } = build();
    const decision = await control.canJoin('nadia-nightshift', 'anthropic');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it('treats an empty table as enabled, not as unreadable', async () => {
    // "Read successfully, found nothing" and "could not read" are different
    // conditions. Conflating them would need a row per character to say that
    // nothing is wrong.
    const { control, db } = build();
    expect(db.rows).toEqual([]);
    expect((await control.canJoin('any', 'any')).allowed).toBe(true);
  });
});

describe('the levers', () => {
  it('refuses everything when the global switch is off', async () => {
    const { control } = build();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: 'costs',
    });

    const decision = await control.canJoin('nadia-nightshift', 'anthropic');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('global_disabled');
  });

  it('refuses one character without touching the others', async () => {
    const { control } = build();
    await control.set({
      scope: 'character',
      subject: 'marco-forward',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: 'behaving badly',
    });

    expect((await control.canJoin('marco-forward', 'anthropic')).reason).toBe('character_disabled');
    expect((await control.canJoin('nadia-nightshift', 'anthropic')).allowed).toBe(true);
  });

  it('refuses one provider without touching the others', async () => {
    const { control } = build();
    await control.set({
      scope: 'provider',
      subject: 'vendor-b',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: 'refusal storm',
    });

    expect((await control.canJoin('nadia-nightshift', 'vendor-b')).reason).toBe('provider_disabled');
    expect((await control.canJoin('nadia-nightshift', 'vendor-a')).allowed).toBe(true);
  });

  it('names the explicit disable rather than the schedule when both apply', async () => {
    // Whoever is debugging at 3am should be sent to the switch somebody pulled,
    // not to the clock.
    const { control } = build({ startHour: 9, endHour: 17, utcOffsetMinutes: 0 });
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: null,
    });

    const midnight = new Date('2026-08-25T00:00:00Z');
    expect((await control.canJoin('x', 'y', midnight)).reason).toBe('global_disabled');
  });
});

describe('drain versus hard', () => {
  it('drain stops new joins but lets a live conversation finish', async () => {
    const { control } = build();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: null,
    });

    const decision = await control.canJoin('nadia-nightshift', 'anthropic');
    expect(decision.allowed).toBe(false);
    expect(decision.stopExisting).toBe(false);
    expect(await control.shouldContinue('nadia-nightshift', 'anthropic')).toBe(true);
  });

  it('hard stops new joins and ends live conversations', async () => {
    const { control } = build();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'hard',
      updatedBy: 'operator',
      reason: 'emergency',
    });

    const decision = await control.canJoin('nadia-nightshift', 'anthropic');
    expect(decision.allowed).toBe(false);
    expect(decision.stopExisting).toBe(true);
    expect(await control.shouldContinue('nadia-nightshift', 'anthropic')).toBe(false);
  });

  it('a hard disable on one character does not end another character conversation', async () => {
    const { control } = build();
    await control.set({
      scope: 'character',
      subject: 'marco-forward',
      enabled: false,
      mode: 'hard',
      updatedBy: 'operator',
      reason: null,
    });

    expect(await control.shouldContinue('marco-forward', 'anthropic')).toBe(false);
    expect(await control.shouldContinue('bea-tangent', 'anthropic')).toBe(true);
  });
});

describe('failing closed', () => {
  it('refuses to join when neither store can be read', async () => {
    const { control, db, cache } = build();
    cache.failGet = true;
    db.failQuery = true;

    const decision = await control.canJoin('nadia-nightshift', 'anthropic');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unreadable');
  });

  it('does not tear down live conversations when the state is unreadable', async () => {
    // The failure is ours. Guessing wrong on `canJoin` costs one bot
    // conversation that never started; guessing wrong here cuts somebody off
    // mid-sentence.
    const { control, db, cache } = build();
    cache.failGet = true;
    db.failQuery = true;

    expect(await control.shouldContinue('nadia-nightshift', 'anthropic')).toBe(true);
  });

  it('still answers from PostgreSQL when Redis is down', async () => {
    const { control, db, cache } = build();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: null,
    });

    cache.failGet = true;
    cache.failSet = true;

    const decision = await control.canJoin('nadia-nightshift', 'anthropic');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('global_disabled');
  });
});

describe('surviving a Redis restart', () => {
  it('keeps the switch off after a flush, because Postgres is the truth', async () => {
    // This is the D12 trap. A switch living only in Redis returns to its
    // compiled-in default on restart, and personas silently turn themselves
    // back on after somebody turned them off.
    const { control, cache } = build();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: 'turned off deliberately',
    });
    expect((await control.canJoin('x', 'y')).allowed).toBe(false);

    cache.flush();

    const afterRestart = await control.canJoin('x', 'y');
    expect(afterRestart.allowed).toBe(false);
    expect(afterRestart.reason).toBe('global_disabled');
  });

  it('repopulates the cache on the read that follows a flush', async () => {
    const { control, cache } = build();
    await control.set({
      scope: 'character',
      subject: 'bea-tangent',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: null,
    });

    cache.flush();
    expect(cache.size()).toBe(0);

    await control.canJoin('bea-tangent', 'anthropic');
    expect(cache.size()).toBe(1);
  });

  it('reconcile writes the table into the cache and reports the count', async () => {
    const { control, db, cache } = build();
    db.rows = [
      { scope: 'global', subject: '', enabled: true, mode: 'drain', updatedBy: 'system', reason: null },
      { scope: 'character', subject: 'bea-tangent', enabled: false, mode: 'hard', updatedBy: 'operator', reason: null },
    ];
    cache.flush();

    expect(await control.reconcile()).toBe(2);
    expect(cache.size()).toBe(1);
  });

  it('reconcile reports failure rather than pretending it worked', async () => {
    const { control, db } = build();
    db.failQuery = true;
    expect(await control.reconcile()).toBe(-1);
  });

  it('serves later reads from the cache rather than the database', async () => {
    const { control, db } = build();
    await control.canJoin('x', 'y');
    const afterFirst = db.selectCalls;

    await control.canJoin('x', 'y');
    await control.canJoin('x', 'y');

    expect(db.selectCalls).toBe(afterFirst);
  });
});

describe('writes go to PostgreSQL first', () => {
  it('invalidates the cache so the next read sees the new value', async () => {
    const { control } = build();
    expect((await control.canJoin('x', 'y')).allowed).toBe(true);

    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: 'operator',
      reason: null,
    });

    // Without invalidation this still reads `true` from the warm cache.
    expect((await control.canJoin('x', 'y')).allowed).toBe(false);
  });

  it('records who flipped it and why', async () => {
    const { control } = build();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'hard',
      updatedBy: 'operator',
      reason: 'bill',
    });

    const rows = await control.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.updatedBy).toBe('operator');
    expect(rows[0]?.reason).toBe('bill');
    expect(rows[0]?.mode).toBe('hard');
  });

  it('updates an existing switch rather than duplicating it', async () => {
    const { control } = build();
    const row = { scope: 'global', subject: '', mode: 'drain', updatedBy: 'operator', reason: null } as const;

    await control.set({ ...row, enabled: false });
    await control.set({ ...row, enabled: true });

    const rows = await control.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.enabled).toBe(true);
  });
});

describe('active hours', () => {
  it('treats an empty window as always active', () => {
    expect(withinHours(ALWAYS_ACTIVE, new Date('2026-08-25T03:00:00Z'))).toBe(true);
    expect(withinHours(ALWAYS_ACTIVE, new Date('2026-08-25T15:00:00Z'))).toBe(true);
  });

  it('is half-open, so the end hour is already outside', () => {
    const nine2five: ActiveHours = { startHour: 9, endHour: 17, utcOffsetMinutes: 0 };
    expect(withinHours(nine2five, new Date('2026-08-25T09:00:00Z'))).toBe(true);
    expect(withinHours(nine2five, new Date('2026-08-25T16:59:00Z'))).toBe(true);
    expect(withinHours(nine2five, new Date('2026-08-25T17:00:00Z'))).toBe(false);
    expect(withinHours(nine2five, new Date('2026-08-25T08:59:00Z'))).toBe(false);
  });

  it('handles a window that wraps midnight, which is the normal case here', () => {
    // 20:00 to 02:00 is exactly what a chat product wants, and the naive
    // comparison gets it backwards.
    const evening: ActiveHours = { startHour: 20, endHour: 2, utcOffsetMinutes: 0 };
    expect(withinHours(evening, new Date('2026-08-25T21:00:00Z'))).toBe(true);
    expect(withinHours(evening, new Date('2026-08-25T01:00:00Z'))).toBe(true);
    expect(withinHours(evening, new Date('2026-08-25T02:00:00Z'))).toBe(false);
    expect(withinHours(evening, new Date('2026-08-25T12:00:00Z'))).toBe(false);
  });

  it('applies the offset, so IST evening is not UTC evening', () => {
    const istEvening: ActiveHours = { startHour: 20, endHour: 23, utcOffsetMinutes: 330 };
    // 15:00 UTC is 20:30 IST.
    expect(withinHours(istEvening, new Date('2026-08-25T15:00:00Z'))).toBe(true);
    // 20:00 UTC is 01:30 IST, which is outside.
    expect(withinHours(istEvening, new Date('2026-08-25T20:00:00Z'))).toBe(false);
  });

  it('refuses a join outside the window and says so', async () => {
    const { control } = build({ startHour: 20, endHour: 23, utcOffsetMinutes: 330 });
    const decision = await control.canJoin('x', 'y', new Date('2026-08-25T20:00:00Z'));
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('outside_hours');
  });

  it('lets a conversation that began inside the window finish outside it', async () => {
    // Ending a chat because the clock struck ten is the mid-sentence cut this
    // whole design exists to avoid.
    const { control } = build({ startHour: 20, endHour: 23, utcOffsetMinutes: 330 });
    expect(await control.shouldContinue('x', 'y')).toBe(true);
  });
});
