/**
 * Issuing and lifting sanctions, across both stores.
 *
 * The interesting cases are the disagreements: what happens when the decision
 * commits and the effect does not, and what happens after Redis — which holds
 * no persistence by design (D12) — loses every key it had.
 */
import { EnforcementService, InvalidBanDurationError } from '../../src/admin/enforce';
import type { AdminIdentity } from '../../src/admin/auth';
import type { RedisStore } from '../../src/redis/store';
import { newAdminAccountId, newEnforcementId } from '../../src/util/ids';
import { createTestContext, fakeHash, type TestContext } from '../helpers/redis';
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

  it('reports a no-op rather than claiming success', async () => {
    expect(await enforcement.revokeBan(newEnforcementId(), 'nothing there', MODERATOR, NOW)).toBe(
      false,
    );
    expect(await pg.count('admin_audit')).toBe(0);
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
