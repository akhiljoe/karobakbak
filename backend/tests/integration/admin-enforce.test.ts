/**
 * Issuing and lifting sanctions, across both stores.
 *
 * The interesting cases are the disagreements: what happens when the decision
 * commits and the effect does not, and what happens after Redis — which holds
 * no persistence by design (D12) — loses every key it had.
 */
import {
  EnforcementService,
  IMPLEMENTED_ACTIONS,
  InvalidBanDurationError,
  isEnforceable,
} from '../../src/admin/enforce';
import type { AdminIdentity } from '../../src/admin/auth';
import type { RedisStore } from '../../src/redis/store';
import { newAdminAccountId, newEnforcementId } from '../../src/util/ids';
import { createTestContext, fakeHash, type TestContext } from '../helpers/redis';
import { silentLogger } from '../helpers/fakes';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let pg: PostgresContext;
let redis: TestContext;
let enforcement: EnforcementService;

const NOW = 1_700_000_000_000;
const REASON = 'issued after reviewing the report';

const MODERATOR: AdminIdentity = {
  accountId: newAdminAccountId(),
  username: 'moderator',
  role: 'moderator',
};

function request(overrides: Partial<Parameters<EnforcementService['issueBan']>[0]> = {}) {
  return {
    reportId: 'rep_example',
    ipHash: fakeHash('subjectip'),
    clientHash: fakeHash('subjectclient'),
    reason: 'spam',
    seconds: 2_592_000,
    justification: REASON,
    identity: MODERATOR,
    ...overrides,
  };
}

beforeAll(async () => {
  pg = await createPostgresContext();
  redis = await createTestContext();
  enforcement = new EnforcementService(pg.db, redis.store, pg.config, pg.logger);
});

afterEach(async () => {
  await pg.db.query('delete from admin_audit');
  await pg.db.query('delete from enforcement');
  await redis.flush();
});

afterAll(async () => {
  await redis.close();
  await pg.close();
});

describe('issuing a ban', () => {
  it('writes both dimensions and makes both refuse a connection', async () => {
    const input = request();
    const result = await enforcement.issueBan(input, NOW);
    expect(result.status).toBe('applied');
    if (result.status !== 'applied') return;
    expect(result.dimensions).toBe(2);

    // Either dimension alone is enough to refuse.
    expect((await redis.store.checkBan(input.ipHash!, fakeHash('other'))).banned).toBe(true);
    expect((await redis.store.checkBan(fakeHash('other'), input.clientHash!)).banned).toBe(true);
  });

  it('records the decision, the reason and who ordered it', async () => {
    const result = await enforcement.issueBan(request(), NOW);
    if (result.status !== 'applied') throw new Error('expected a ban');

    const rows = await pg.rows<{ subject_key: string; action: string; source: string; expires_at: Date }>(
      'select subject_key, action, source, expires_at from enforcement order by subject_key',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.action === 'ban' && row.source === 'moderator')).toBe(true);

    const audit = await pg.rows<{ action: string; actor: string; case_id: string; justification: string }>(
      'select action, actor, case_id, justification from admin_audit',
    );
    expect(audit).toEqual([
      {
        action: 'issued_ban',
        actor: MODERATOR.accountId,
        case_id: 'rep_example',
        justification: REASON,
      },
    ]);
  });

  it('links the Redis key to the row that ordered it', async () => {
    // A refusal observed in production has to be traceable to its
    // justification, or it is an unexplained outage for the person refused.
    const input = request();
    await enforcement.issueBan(input, NOW);

    const check = await redis.store.checkBan(input.ipHash!, fakeHash('other'));
    if (!check.banned) throw new Error('expected a ban');
    const [row] = await pg.rows<{ enforcement_id: string }>(
      'select enforcement_id from enforcement where subject_key = $1',
      [input.ipHash],
    );
    expect(check.enforcementId).toBe(row!.enforcement_id);
  });

  it('refuses when there is no subject to attach to', async () => {
    // The reported party's session had expired and nobody blocked them, so
    // there are no hashes. Better to say so than to write a row with no effect.
    const result = await enforcement.issueBan(
      request({ ipHash: null, clientHash: null }),
      NOW,
    );
    expect(result).toEqual({ status: 'no_subject' });
    expect(await pg.count('enforcement')).toBe(0);
    expect(await pg.count('admin_audit')).toBe(0);
  });

  it('refuses a duration outside the configured bounds', async () => {
    await expect(enforcement.issueBan(request({ seconds: 30 }), NOW)).rejects.toBeInstanceOf(
      InvalidBanDurationError,
    );
    await expect(
      enforcement.issueBan(request({ seconds: pg.config.enforcement.maxBanSeconds + 1 }), NOW),
    ).rejects.toBeInstanceOf(InvalidBanDurationError);
    expect(await pg.count('enforcement')).toBe(0);
  });

  it('revokes its own row when the effect cannot be applied', async () => {
    // The decision committed and the key did not. Leaving the two disagreeing
    // would mean a row that says "banned" with nothing enforcing it.
    const broken = {
      ...redis.store,
      applyBan: async () => {
        throw new Error('redis unavailable');
      },
    } as unknown as RedisStore;
    const failing = new EnforcementService(pg.db, broken, pg.config, pg.logger);

    const result = await failing.issueBan(request(), NOW);
    expect(result.status).toBe('apply_failed');

    const rows = await pg.rows<{ revoked_by: string | null }>(
      'select revoked_by from enforcement',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revoked_by === 'system:apply_failed')).toBe(true);
  });
});

describe('revoking a ban', () => {
  it('lifts both dimensions and leaves the record behind', async () => {
    const input = request();
    const issued = await enforcement.issueBan(input, NOW);
    if (issued.status !== 'applied') throw new Error('expected a ban');

    expect(await enforcement.revokeBan(issued.enforcementId, 'appealed', MODERATOR, NOW)).toBe(true);

    expect((await redis.store.checkBan(input.ipHash!, input.clientHash!)).banned).toBe(false);
    // The row survives: a ban that vanishes takes with it the evidence it was
    // issued, and the reason someone lifted it.
    const rows = await pg.rows<{ revoked_at: Date | null; revoked_by: string | null }>(
      'select revoked_at, revoked_by from enforcement',
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
    expect(rows.every((row) => row.revoked_by === MODERATOR.accountId)).toBe(true);
  });

  it('audits the revocation', async () => {
    const issued = await enforcement.issueBan(request(), NOW);
    if (issued.status !== 'applied') throw new Error('expected a ban');
    await enforcement.revokeBan(issued.enforcementId, 'appealed by the user', MODERATOR, NOW);

    const audit = await pg.rows<{ action: string }>(
      'select action from admin_audit order by created_at asc, action asc',
    );
    expect(audit.map((row) => row.action).sort()).toEqual(['issued_ban', 'revoked_ban']);
  });

  /**
   * The console's revoke route accepts a string from a request body. That
   * string used to become a SQL `LIKE` pattern — `enforcement_id like $1 ||
   * '%'` — for both the database update and the Redis key removal, so a
   * console session submitting `%` lifted every non-revoked sanction in the
   * system in one request, and the audit row recorded the wildcard rather than
   * the decisions it undid.
   */
  it('refuses a wildcard instead of revoking every sanction in the table', async () => {
    const first = await enforcement.issueBan(request(), NOW);
    const second = await enforcement.issueBan(
      request({ ipHash: fakeHash('secondip'), clientHash: fakeHash('secondclient') }),
      NOW,
    );
    if (first.status !== 'applied' || second.status !== 'applied') {
      throw new Error('expected two bans');
    }

    for (const hostile of ['%', 'enf_%', '_', 'enf_', '%_ip']) {
      expect(await enforcement.revokeBan(hostile, 'lift everything', MODERATOR, NOW)).toBe(false);
    }

    // Nothing lifted, in either store.
    const rows = await pg.rows<{ revoked_at: Date | null }>('select revoked_at from enforcement');
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.revoked_at === null)).toBe(true);
    expect((await redis.store.checkBan(request().ipHash!, fakeHash('other'))).banned).toBe(true);
    expect((await redis.store.checkBan(fakeHash('secondip'), fakeHash('other'))).banned).toBe(true);

    // And nothing recorded: a refusal is not a decision, so it leaves no audit
    // row claiming one was made.
    expect(await pg.count('admin_audit')).toBe(2);
  });

  it('lifts only the decision it was given, never its neighbours', async () => {
    const target = await enforcement.issueBan(request(), NOW);
    const bystander = await enforcement.issueBan(
      request({ ipHash: fakeHash('bystanderip'), clientHash: fakeHash('bystanderclient') }),
      NOW,
    );
    if (target.status !== 'applied' || bystander.status !== 'applied') {
      throw new Error('expected two bans');
    }

    expect(await enforcement.revokeBan(target.enforcementId, 'appealed', MODERATOR, NOW)).toBe(true);

    const rows = await pg.rows<{ enforcement_id: string; revoked_at: Date | null }>(
      'select enforcement_id, revoked_at from enforcement',
    );
    const lifted = rows.filter((row) => row.revoked_at !== null).map((row) => row.enforcement_id);
    expect(lifted.sort()).toEqual(
      [`${target.enforcementId}_client`, `${target.enforcementId}_ip`].sort(),
    );
    expect((await redis.store.checkBan(fakeHash('bystanderip'), fakeHash('other'))).banned).toBe(
      true,
    );
  });

  it('accepts a per-dimension id and still lifts both dimensions', async () => {
    // `issueBan` hands back the base id; the listings hand back per-dimension
    // ids. Both circulate in the console and both must mean the same decision.
    const input = request();
    const issued = await enforcement.issueBan(input, NOW);
    if (issued.status !== 'applied') throw new Error('expected a ban');

    expect(
      await enforcement.revokeBan(`${issued.enforcementId}_client`, 'appealed', MODERATOR, NOW),
    ).toBe(true);

    expect((await redis.store.checkBan(input.ipHash!, input.clientHash!)).banned).toBe(false);
    const rows = await pg.rows<{ revoked_at: Date | null }>('select revoked_at from enforcement');
    expect(rows.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it('reports a no-op rather than claiming success', async () => {
    expect(await enforcement.revokeBan(newEnforcementId(), 'nothing there', MODERATOR, NOW)).toBe(
      false,
    );
    expect(await pg.count('admin_audit')).toBe(0);
  });
});

/**
 * The gap between what the schema allows and what this build can carry out.
 *
 * `enforcement.action` accepts five words and `source` already accepts
 * `'automated'`, so the table is ready for sanctions nothing implements. A row
 * written with one of those would be recorded, would report success, and would
 * change nothing — the moderator believes the user was dealt with and the user
 * notices no difference. That failure is completely silent, so it is made loud
 * here instead.
 */
describe('sanctions this build cannot carry out', () => {
  async function writeSanction(action: string): Promise<void> {
    await pg.db.query(
      `insert into enforcement
         (enforcement_id, subject_key, action, reason, source, created_at, expires_at,
          retention_expires_at)
       values ($1, $2, $3, 'spam', 'automated', now(), now() + interval '1 day',
               now() + interval '90 days')`,
      [newEnforcementId() + '_ip', fakeHash('subjectip'), action],
    );
  }

  it('names every action it declares, so a new one must be classified', () => {
    // Adding a word to `EnforcementAction` without deciding whether this build
    // can perform it is the mistake this guards. The set below is the decision.
    for (const action of IMPLEMENTED_ACTIONS) {
      expect(isEnforceable(action)).toBe(true);
    }
    for (const action of ['warn', 'ratelimit', 'quarantine']) {
      expect(isEnforceable(action)).toBe(false);
    }
    expect(isEnforceable('ban')).toBe(true);
    expect(isEnforceable('nonsense')).toBe(false);
  });

  it('does not apply one, and does not silently ignore it either', async () => {
    await writeSanction('quarantine');

    // Its own service with a recording logger: the shared context uses a null
    // one, and the whole point of this test is what gets said.
    const recorder = silentLogger();
    const watched = new EnforcementService(pg.db, redis.store, pg.config, recorder);
    const applied = await watched.reapplyActiveBans(NOW);

    // Nothing was applied, because nothing can apply it.
    expect(applied).toBe(0);
    expect((await redis.store.checkBan(fakeHash('subjectip'), fakeHash('other'))).banned).toBe(
      false,
    );
    // And it was reported rather than passed over — a live sanction that does
    // nothing is exactly what an operator must be told about, because no other
    // number will move.
    const reported = recorder.lines.find((line) => line.msg.includes('cannot be carried out'));
    expect(reported).toBeDefined();
    expect(reported?.fields).toMatchObject({ enforcementAction: 'quarantine', count: 1 });
  });

  it('still applies a suspension, which is a ban with an end date', async () => {
    await writeSanction('suspend');

    const applied = await enforcement.reapplyActiveBans(NOW);

    expect(applied).toBe(1);
    expect((await redis.store.checkBan(fakeHash('subjectip'), fakeHash('other'))).banned).toBe(true);
  });
});

describe('surviving a Redis restart', () => {
  it('reapplies live bans from the database', async () => {
    // Redis runs with persistence off (D12), so every ban key dies with a
    // restart. Without the reconciler each sanction would last only until the
    // next one, and nothing would report that it had gone.
    const input = request();
    await enforcement.issueBan(input, NOW);
    await redis.flush();
    expect((await redis.store.checkBan(input.ipHash!, input.clientHash!)).banned).toBe(false);

    expect(await enforcement.reapplyActiveBans(NOW)).toBe(2);
    expect((await redis.store.checkBan(input.ipHash!, fakeHash('other'))).banned).toBe(true);
    expect((await redis.store.checkBan(fakeHash('other'), input.clientHash!)).banned).toBe(true);
  });

  it('does not extend a sanction that was half spent', async () => {
    // The remaining life is recomputed from `expires_at`, not reissued from
    // the original duration, or every restart would silently renew every ban.
    const input = request({ seconds: 1000 });
    await enforcement.issueBan(input, NOW);
    await redis.flush();

    const halfway = NOW + 600_000;
    await enforcement.reapplyActiveBans(halfway);
    const ttl = await redis.client.ttl(redis.keys.ban(input.ipHash!));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
  });

  it('skips revoked and expired sanctions', async () => {
    const revoked = request({ ipHash: fakeHash('revokedip'), clientHash: null });
    const issued = await enforcement.issueBan(revoked, NOW);
    if (issued.status !== 'applied') throw new Error('expected a ban');
    await enforcement.revokeBan(issued.enforcementId, 'lifted on appeal', MODERATOR, NOW);

    const expiring = request({ ipHash: fakeHash('expiredip'), clientHash: null, seconds: 60 });
    await enforcement.issueBan(expiring, NOW);
    await redis.flush();

    // Well past the short ban's expiry.
    expect(await enforcement.reapplyActiveBans(NOW + 120_000)).toBe(0);
    expect((await redis.store.checkBan(revoked.ipHash!, fakeHash('x'))).banned).toBe(false);
    expect((await redis.store.checkBan(expiring.ipHash!, fakeHash('x'))).banned).toBe(false);
  });

  it('is safe to run twice, and from more than one instance', async () => {
    const input = request();
    await enforcement.issueBan(input, NOW);
    await redis.flush();

    const [first, second] = await Promise.all([
      enforcement.reapplyActiveBans(NOW),
      enforcement.reapplyActiveBans(NOW),
    ]);
    expect(first).toBe(2);
    expect(second).toBe(2);
    expect((await redis.store.checkBan(input.ipHash!, fakeHash('other'))).banned).toBe(true);
  });
});
