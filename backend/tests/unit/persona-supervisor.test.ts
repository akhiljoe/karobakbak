/**
 * A3 — the fill policy.
 *
 * The gate is one claim: a persona never takes a conversation a human was
 * going to have with another human. Most of this file is that claim attacked
 * from different directions, because it is the only reason the feature is
 * defensible and it is easy to break by accident.
 *
 * The counting is exact rather than estimated, so these tests can assert
 * "never" rather than "usually".
 */

import {
  PersonaSupervisor,
  assertFillPolicyCoherent,
} from '../../src/personas/supervisor';
import type {
  FillPolicy,
  LivePersona,
  QueueView,
  SupervisorOptions,
} from '../../src/personas/supervisor';
import { PersonaControl, ALWAYS_ACTIVE } from '../../src/personas/control';
import type { ControlCache } from '../../src/personas/control';
import { CHARACTERS } from '../../src/personas/characters';
import type { Logger } from '../../src/logger';
import type { Database } from '../../src/storage/pool';

const SEGMENT = 'default';

const POLICY: FillPolicy = {
  waitBeforeFillSeconds: 20,
  maxConcurrent: 5,
  maxPerCharacter: 2,
  minDispatchGapMs: 6000,
  segment: SEGMENT,
};

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

/** A queue whose contents the test sets directly. */
class FakeQueue implements QueueView {
  members: string[] = [];
  enqueued = new Map<string, number>();
  fail = false;

  async searching(): Promise<readonly string[]> {
    if (this.fail) throw new Error('redis down');
    return this.members;
  }

  async enqueuedAt(sessionId: string): Promise<number | null> {
    return this.enqueued.get(sessionId) ?? null;
  }

  /** Put a session in the queue, having waited `agoMs`. */
  add(id: string, at: number): void {
    this.members.push(id);
    this.enqueued.set(id, at);
  }
}

/** Control that is always permissive unless a test says otherwise. */
function permissiveControl(): PersonaControl {
  const store = new Map<string, string>();
  const cache: ControlCache = {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => {
      store.set(k, v);
      return 'OK';
    },
    del: async (k) => {
      store.delete(k);
      return 1;
    },
  };
  // Holds rows rather than discarding them: `set()` writes and `canJoin()`
  // reads back, so a fake that swallowed the upsert would make every control
  // test silently pass by never seeing the switch it just flipped.
  const rows: Array<Record<string, unknown>> = [];
  const db = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.trim().startsWith('select')) return { rows, rowCount: rows.length };
      const [scope, subject, enabled, mode, updated_by, reason] = values;
      const at = rows.findIndex((r) => r['scope'] === scope && r['subject'] === subject);
      const row = { scope, subject, enabled, mode, updated_by, reason };
      if (at >= 0) rows[at] = row;
      else rows.push(row);
      return { rows: [], rowCount: 1 };
    },
  } as unknown as Database;

  return new PersonaControl({
    db,
    redis: cache,
    logger: silentLogger,
    cacheKey: 'test:control',
    cacheTtlSeconds: 30,
    hours: ALWAYS_ACTIVE,
  });
}

interface Harness {
  supervisor: PersonaSupervisor;
  queue: FakeQueue;
  dispatched: string[];
  withdrawn: string[];
  time: { now: number };
  /** Simulate a dispatched persona reaching the queue with a session id. */
  settle(sessionId: string): void;
}

function build(overrides: Partial<SupervisorOptions> = {}, policy: FillPolicy = POLICY): Harness {
  const queue = new FakeQueue();
  const dispatched: string[] = [];
  const withdrawn: string[] = [];
  const time = { now: 1_000_000 };
  const created: LivePersona[] = [];

  const supervisor = new PersonaSupervisor({
    control: permissiveControl(),
    queue,
    logger: silentLogger,
    policy,
    characters: CHARACTERS,
    provider: 'test-provider',
    now: () => time.now,
    dispatch: async (character) => {
      dispatched.push(character.id);
      const persona: LivePersona = {
        characterId: character.id,
        sessionId: null,
        searching: true,
        withdraw: () => {
          withdrawn.push(character.id);
          persona.searching = false;
        },
        stop: () => {
          persona.sessionId = null;
          persona.searching = false;
        },
      };
      created.push(persona);
      return persona;
    },
    ...overrides,
  });

  const settle = (sessionId: string): void => {
    const last = created[created.length - 1];
    if (last === undefined) throw new Error('nothing dispatched to settle');
    last.sessionId = sessionId;
    queue.add(sessionId, time.now);
  };

  return { supervisor, queue, dispatched, withdrawn, time, settle };
}

/** A human who queued long enough ago to qualify. */
function patientHuman(h: Harness, id: string): void {
  h.queue.add(id, h.time.now - POLICY.waitBeforeFillSeconds * 1000 - 1);
}

describe('never taking a conversation from a human', () => {
  it('does not dispatch when two humans are waiting for each other', async () => {
    const h = build();
    patientHuman(h, 's_human_a');
    patientHuman(h, 's_human_b');

    const outcome = await h.supervisor.tick();
    expect(outcome).toEqual({ action: 'skipped', reason: 'humans_available' });
    expect(h.dispatched).toEqual([]);
  });

  it('does not dispatch when a crowd is waiting', async () => {
    const h = build();
    for (let i = 0; i < 8; i += 1) patientHuman(h, `s_human_${i}`);

    expect(await h.supervisor.tick()).toEqual({ action: 'skipped', reason: 'humans_available' });
    expect(h.dispatched).toEqual([]);
  });

  it('does not dispatch when nobody is waiting', async () => {
    const h = build();
    expect(await h.supervisor.tick()).toEqual({ action: 'skipped', reason: 'nobody_waiting' });
  });

  it('does not dispatch before the wait threshold', async () => {
    const h = build();
    h.queue.add('s_human', h.time.now - 5000);

    expect(await h.supervisor.tick()).toEqual({
      action: 'skipped',
      reason: 'not_waited_long_enough',
    });
  });

  it('dispatches for one human who has waited long enough', async () => {
    const h = build();
    patientHuman(h, 's_human');

    const outcome = await h.supervisor.tick();
    expect(outcome.action).toBe('dispatched');
    expect(h.dispatched).toHaveLength(1);
  });

  it('counts its own personas by identity, not by estimate', async () => {
    // The queue holds personas too. If the supervisor subtracted a guess, a
    // miscount would make the queue look emptier than it is — which is exactly
    // when a bad dispatch happens.
    const h = build();
    patientHuman(h, 's_human');
    await h.supervisor.tick();
    h.settle('s_persona_1');

    // Queue now: one human, one persona. A second human arrives.
    patientHuman(h, 's_human_2');
    h.time.now += POLICY.minDispatchGapMs + 1;

    // Two humans can pair. The persona must get out of the way, not add another.
    const outcome = await h.supervisor.tick();
    expect(outcome).toEqual({ action: 'withdrew', count: 1 });
    expect(h.dispatched).toHaveLength(1);
  });

  it('refuses to dispatch when the queue cannot be read', async () => {
    // An unreadable queue means an unknown number of humans, and dispatching
    // into that is the case this class exists to prevent.
    const h = build();
    h.queue.fail = true;

    expect(await h.supervisor.tick()).toEqual({
      action: 'skipped',
      reason: 'queue_unreadable',
    });
    expect(h.dispatched).toEqual([]);
  });
});

describe('withdrawing when humans arrive', () => {
  it('pulls a searching persona out once two humans are waiting', async () => {
    const h = build();
    patientHuman(h, 's_human');
    await h.supervisor.tick();
    h.settle('s_persona_1');

    patientHuman(h, 's_human_2');
    const outcome = await h.supervisor.tick();

    expect(outcome).toEqual({ action: 'withdrew', count: 1 });
    expect(h.withdrawn).toHaveLength(1);
  });

  it('does not withdraw a persona that is already in a conversation', async () => {
    const h = build();
    patientHuman(h, 's_human');
    await h.supervisor.tick();
    h.settle('s_persona_1');

    // It matched: no longer searching.
    const live = h.supervisor.livePersonas()[0];
    if (live === undefined) throw new Error('nothing live');
    live.searching = false;

    patientHuman(h, 's_human_2');
    patientHuman(h, 's_human_3');

    const outcome = await h.supervisor.tick();
    expect(outcome.action).not.toBe('withdrew');
    expect(h.withdrawn).toEqual([]);
  });

  it('does not withdraw on an unreadable queue, because that costs a real match too', async () => {
    const h = build();
    patientHuman(h, 's_human');
    await h.supervisor.tick();
    h.settle('s_persona_1');

    h.queue.fail = true;
    const outcome = await h.supervisor.tick();

    expect(h.withdrawn).toEqual([]);
    expect(outcome.action).toBe('skipped');
  });
});

describe('caps', () => {
  it('stops at the concurrency cap', async () => {
    const h = build();
    for (let i = 0; i < POLICY.maxConcurrent; i += 1) {
      h.queue.members = [];
      patientHuman(h, `s_human_${i}`);
      await h.supervisor.tick();
      h.settle(`s_persona_${i}`);
      h.time.now += POLICY.minDispatchGapMs + 1;
      h.queue.members = h.queue.members.filter((m) => m.startsWith('s_persona'));
    }
    expect(h.supervisor.liveCount()).toBe(POLICY.maxConcurrent);

    h.queue.members = [];
    patientHuman(h, 's_human_extra');
    expect(await h.supervisor.tick()).toEqual({ action: 'skipped', reason: 'at_capacity' });
  });

  it('respects the gap between dispatches, so a burst cannot outrun the join limiter', async () => {
    const h = build();
    patientHuman(h, 's_human');
    expect((await h.supervisor.tick()).action).toBe('dispatched');

    h.queue.members = [];
    patientHuman(h, 's_human_2');
    expect(await h.supervisor.tick()).toEqual({ action: 'skipped', reason: 'too_soon' });

    h.time.now += POLICY.minDispatchGapMs + 1;
    expect((await h.supervisor.tick()).action).toBe('dispatched');
  });

  it('will not run the same character past its per-character cap', async () => {
    const oneCharacter = CHARACTERS.slice(0, 1);
    const h = build({ characters: oneCharacter }, { ...POLICY, maxPerCharacter: 1 });

    patientHuman(h, 's_human');
    expect((await h.supervisor.tick()).action).toBe('dispatched');
    h.settle('s_persona_1');

    h.queue.members = ['s_persona_1'];
    patientHuman(h, 's_human_2');
    h.time.now += POLICY.minDispatchGapMs + 1;

    expect(await h.supervisor.tick()).toEqual({
      action: 'skipped',
      reason: 'character_at_capacity',
    });
  });
});

describe('the control plane has the last word', () => {
  it('does not dispatch when personas are disabled', async () => {
    const control = permissiveControl();
    await control.set({
      scope: 'global',
      subject: '',
      enabled: false,
      mode: 'drain',
      updatedBy: '***REMOVED***',
      reason: 'testing',
    });

    const h = build({ control });
    patientHuman(h, 's_human');

    expect(await h.supervisor.tick()).toEqual({ action: 'skipped', reason: 'disabled' });
    expect(h.dispatched).toEqual([]);
  });

  it('reports "disabled" rather than hiding it behind another reason', async () => {
    // Whoever is debugging should be sent to the switch somebody pulled.
    const control = permissiveControl();
    await control.set({
      scope: 'character',
      subject: CHARACTERS[0]?.id ?? 'x',
      enabled: false,
      mode: 'drain',
      updatedBy: '***REMOVED***',
      reason: null,
    });

    const h = build({ control, characters: CHARACTERS.slice(0, 1) });
    patientHuman(h, 's_human');

    expect(await h.supervisor.tick()).toEqual({ action: 'skipped', reason: 'disabled' });
  });
});

describe('shutdown', () => {
  it('stops every live persona and reports how many', async () => {
    const h = build();
    patientHuman(h, 's_human');
    await h.supervisor.tick();
    h.settle('s_persona_1');

    expect(h.supervisor.stopAll()).toBe(1);
    expect(h.supervisor.liveCount()).toBe(0);
  });
});

describe('the coherence checks', () => {
  it('refuses a concurrency cap at or above the per-IP connection limit', () => {
    // Every persona connects from one address, so they share one bucket. A cap
    // above the connection limit is a setting that looks applied and is not.
    expect(() => assertFillPolicyCoherent({ ...POLICY, maxConcurrent: 40 }, 40)).toThrow(
      /must be below/,
    );
    expect(() => assertFillPolicyCoherent({ ...POLICY, maxConcurrent: 41 }, 40)).toThrow(
      /must be below/,
    );
    expect(() => assertFillPolicyCoherent({ ...POLICY, maxConcurrent: 39 }, 40)).not.toThrow();
  });

  it('refuses a per-character cap that can never bind', () => {
    expect(() =>
      assertFillPolicyCoherent({ ...POLICY, maxConcurrent: 3, maxPerCharacter: 5 }, 40),
    ).toThrow(/can never bind/);
  });

  it('refuses a zero wait, which would race every real match', () => {
    expect(() =>
      assertFillPolicyCoherent({ ...POLICY, waitBeforeFillSeconds: 0 }, 40),
    ).toThrow(/must be positive/);
  });
});
