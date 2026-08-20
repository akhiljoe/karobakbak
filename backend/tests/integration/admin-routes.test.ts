/**
 * The console API end to end: guard, routes, both stores.
 *
 * The test that earns its place here is the one asserting a request body
 * cannot name its own ban subject. Everything else is plumbing; that one is a
 * privilege-escalation check.
 */
import { AdminAuth } from '../../src/admin/auth';
import { EnforcementService } from '../../src/admin/enforce';
import { hashPassword } from '../../src/admin/password';
import { ReviewService } from '../../src/admin/review';
import { createConsoleRoutes } from '../../src/admin/routes';
import {
  ADMIN_SESSION_COOKIE,
  createAdminServer,
  readCookie,
  type AdminServer,
} from '../../src/admin/server';
import { hotp, newTotpSecret, totpCounter } from '../../src/admin/totp';
import { newAdminAccountId, newMatchId, newMessageId } from '../../src/util/ids';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';
import { createTestContext, fakeHash, type TestContext } from '../helpers/redis';

let pg: PostgresContext;
let redis: TestContext;
let server: AdminServer;
let base: string;
let cookie: string;

const PASSWORD = 'a-long-enough-console-password';
const REASON = 'reviewing a reported conversation';

interface Fixture {
  reportId: string;
  conversationId: string;
  ipHash: string;
  clientHash: string;
}

async function seedReport(): Promise<Fixture> {
  const conversationId = newMatchId();
  const reportId = `rep_${conversationId.slice(2)}`;
  const reported = `s_reported_${conversationId.slice(2, 10)}`;
  const reporter = `s_reporter_${conversationId.slice(2, 10)}`;
  const ipHash = fakeHash(`ip${conversationId.slice(2, 8)}`);
  const clientHash = fakeHash(`ct${conversationId.slice(2, 8)}`);
  const now = new Date();
  const expires = new Date(Date.now() + 30 * 86_400_000);

  await pg.db.query(
    `insert into conversations (conversation_id, session_a, session_b, segment, started_at,
                                ended_at, end_reason, message_count, retention_expires_at)
     values ($1, $2, $3, 'default', $4, $4, 'block', 1, $5)`,
    [conversationId, reported, reporter, now, expires],
  );
  await pg.db.query(
    `insert into messages (message_id, conversation_id, sender_session_id, server_timestamp,
                           type, body, char_length, moderation_action, retention_expires_at)
     values ($1, $2, $3, $4, 'text', 'buy my thing', 12, 'flag', $5)`,
    [newMessageId(), conversationId, reported, now, expires],
  );
  await pg.db.query(
    `insert into reports (report_id, conversation_id, reporter_session_id, reported_session_id,
                          category, note, created_at, retention_expires_at)
     values ($1, $2, $3, $4, 'spam', 'kept advertising', $5, $6)`,
    [reportId, conversationId, reporter, reported, now, expires],
  );
  await pg.db.query(
    `insert into blocks (block_id, blocker_key, blocked_key, dimension, conversation_id,
                         created_at, expires_at)
     values ($1, 'blocker', $2, 'ip', $3, $4, $5), ($6, 'blocker', $7, 'client', $3, $4, $5)`,
    [
      `blk_${newMatchId().slice(2)}`,
      ipHash,
      conversationId,
      now,
      expires,
      `blk_${newMatchId().slice(2)}`,
      clientHash,
    ],
  );

  return { reportId, conversationId, ipHash, clientHash };
}

async function api(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
  });
  return {
    status: response.status,
    body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
  };
}

beforeAll(async () => {
  pg = await createPostgresContext({
    ADMIN_CONSOLE_ENABLED: 'true',
    ADMIN_CONSOLE_PORT: '0',
    ADMIN_LOGIN_ATTEMPTS_PER_MINUTE: '1000',
  });
  redis = await createTestContext();

  const auth = new AdminAuth(pg.db, pg.config, pg.logger);
  const review = new ReviewService(pg.db, pg.config, pg.logger);
  const enforcement = new EnforcementService(pg.db, redis.store, pg.config, pg.logger);
  const routes = createConsoleRoutes({
    config: pg.config,
    logger: pg.logger,
    review,
    enforcement,
  });

  server = createAdminServer({ config: pg.config, logger: pg.logger, auth, routes });
  const port = await server.listen();
  base = `http://127.0.0.1:${port}`;

  const username = 'moderator';
  const secret = newTotpSecret();
  await pg.db.query(
    `insert into admin_accounts (account_id, username, password_hash, totp_secret, role, created_at)
     values ($1, $2, $3, $4, 'moderator', now())`,
    [newAdminAccountId(), username, await hashPassword(PASSWORD), secret],
  );

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD, code: hotp(secret, totpCounter(Date.now())) }),
  });
  const token = readCookie((login.headers.get('set-cookie') ?? '').split(';')[0], ADMIN_SESSION_COOKIE);
  cookie = `${ADMIN_SESSION_COOKIE}=${token}`;
});

afterEach(async () => {
  await pg.db.query('delete from admin_audit');
  await pg.db.query('delete from enforcement');
  await pg.db.query('delete from blocks');
  await pg.db.query('delete from reports');
  await pg.db.query('delete from messages');
  await pg.db.query('delete from conversations');
  await redis.flush();
});

afterAll(async () => {
  await server.close();
  await redis.close();
  await pg.close();
});

describe('the queue and the replay', () => {
  it('lists open reports without any user text', async () => {
    await seedReport();
    const result = await api('GET', '/api/reports');
    expect(result.status).toBe(200);
    const reports = result.body.reports as Array<Record<string, unknown>>;
    expect(reports).toHaveLength(1);
    expect(JSON.stringify(reports)).not.toContain('kept advertising');
    expect(JSON.stringify(reports)).not.toContain('buy my thing');
  });

  it('returns the transcript, and audits the disclosure', async () => {
    const fixture = await seedReport();
    const result = await api('POST', '/api/reports/open', {
      reportId: fixture.reportId,
      justification: REASON,
    });
    expect(result.status).toBe(200);
    expect(JSON.stringify(result.body)).toContain('buy my thing');

    const audit = await pg.rows<{ action: string; case_id: string }>(
      'select action, case_id from admin_audit',
    );
    expect(audit).toEqual([{ action: 'viewed_conversation', case_id: fixture.reportId }]);
  });

  it('refuses to disclose anything without a justification', async () => {
    const fixture = await seedReport();
    for (const justification of [undefined, '', '   ', 'short']) {
      const result = await api('POST', '/api/reports/open', {
        reportId: fixture.reportId,
        justification,
      });
      expect(result.status).toBe(400);
    }
    expect(await pg.count('admin_audit')).toBe(0);
  });

  it('reports a conflict when someone else already decided', async () => {
    const fixture = await seedReport();
    const first = await api('POST', '/api/reports/resolve', {
      reportId: fixture.reportId,
      outcome: 'DISMISSED',
      resolution: 'no action needed',
      justification: REASON,
    });
    expect(first.status).toBe(200);

    const second = await api('POST', '/api/reports/resolve', {
      reportId: fixture.reportId,
      outcome: 'ACTIONED',
      resolution: 'banned',
      justification: REASON,
    });
    expect(second.status).toBe(409);
  });
});

describe('issuing a sanction', () => {
  it('bans the party the report names', async () => {
    const fixture = await seedReport();
    const result = await api('POST', '/api/enforcement/ban', {
      reportId: fixture.reportId,
      seconds: 86_400,
      reason: 'spam',
      justification: 'confirmed advertising to many strangers',
    });
    expect(result.status).toBe(200);
    expect(result.body.dimensions).toBe(2);

    expect((await redis.store.checkBan(fixture.ipHash, fakeHash('other'))).banned).toBe(true);
    expect((await redis.store.checkBan(fakeHash('other'), fixture.clientHash)).banned).toBe(true);
  });

  it('ignores an identity supplied by the caller', async () => {
    // The privilege-escalation check. A console session that could name its own
    // subject could ban a hash it observed or guessed, and the audit row would
    // record a well-formed decision with nothing to show it was forged.
    const fixture = await seedReport();
    const victim = fakeHash('innocentbystander');

    const result = await api('POST', '/api/enforcement/ban', {
      reportId: fixture.reportId,
      ipHash: victim,
      clientHash: victim,
      subjectKey: victim,
      seconds: 86_400,
      justification: 'attempting to name my own subject',
    });
    expect(result.status).toBe(200);

    // The named hash is untouched; the report's own subject is banned.
    expect((await redis.store.checkBan(victim, fakeHash('x'))).banned).toBe(false);
    expect((await redis.store.checkBan(fixture.ipHash, fakeHash('x'))).banned).toBe(true);

    const rows = await pg.rows<{ subject_key: string }>(
      'select subject_key from enforcement order by subject_key',
    );
    expect(rows.map((row) => row.subject_key).sort()).toEqual(
      [fixture.ipHash, fixture.clientHash].sort(),
    );
  });

  it('says plainly when there is nothing to ban', async () => {
    const fixture = await seedReport();
    await pg.db.query('delete from blocks');
    const result = await api('POST', '/api/enforcement/ban', {
      reportId: fixture.reportId,
      justification: 'no identity was recorded here',
    });
    expect(result.status).toBe(422);
    expect(result.body.error).toBe('no_subject');
  });

  it('refuses a duration outside the configured bounds', async () => {
    const fixture = await seedReport();
    const result = await api('POST', '/api/enforcement/ban', {
      reportId: fixture.reportId,
      seconds: 5,
      justification: 'trying a five second ban',
    });
    expect(result.status).toBe(400);
    expect(await pg.count('enforcement')).toBe(0);
  });

  it('lifts a ban and leaves the record', async () => {
    const fixture = await seedReport();
    const issued = await api('POST', '/api/enforcement/ban', {
      reportId: fixture.reportId,
      justification: 'confirmed advertising to many strangers',
    });
    const enforcementId = issued.body.enforcementId as string;

    const lifted = await api('POST', '/api/enforcement/revoke', {
      enforcementId,
      justification: 'lifted after a second look',
    });
    expect(lifted.status).toBe(200);
    expect((await redis.store.checkBan(fixture.ipHash, fixture.clientHash)).banned).toBe(false);
    expect(await pg.count('enforcement')).toBe(2);
  });

  it('needs a session like everything else', async () => {
    const fixture = await seedReport();
    const response = await fetch(`${base}/api/enforcement/ban`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reportId: fixture.reportId, justification: REASON }),
    });
    expect(response.status).toBe(401);
    expect(await pg.count('enforcement')).toBe(0);
  });
});
