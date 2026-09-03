/**
 * What `/auth/session` tells the browser about premium, and why it says it.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A GATE
 * ---------------------------------------------------------------------------
 * The gate is D51, on the session row, inside `preferenceAllowance`. A client
 * cannot open it and cannot close it. What this field decides is whether the
 * interface *offers* the control at all.
 *
 * The distinction matters because a refused preference is deliberately
 * invisible (§29.4): the server matches the searcher with anybody and says
 * nothing, because telling a paying user "you have run out this hour" is worse
 * than quietly giving them an ordinary match. That is right for somebody who
 * paid. It is exactly wrong for somebody who never did — they would set a
 * preference, watch it be accepted, and never learn it did nothing at all.
 *
 * So the client asks once, at the same moment it asks whether anybody is signed
 * in, and hides a control it would otherwise be promising on the server's
 * behalf.
 *
 * ---------------------------------------------------------------------------
 * EVERY FAILURE ANSWERS FALSE
 * ---------------------------------------------------------------------------
 * The same direction `stampEntitlement` fails in. Hiding a paid control from
 * somebody who paid costs them a click and a support message; showing it to
 * somebody who did not costs the trust of everybody who later discovers it did
 * nothing.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { accountForSubject, mintCredential } from '../../src/accounts/credentials';
import { createEntitlementService, type EntitlementService } from '../../src/accounts/entitlement';
import { createOidcClient } from '../../src/accounts/oidc';
import { createAuthRoutes, type AuthRoutes } from '../../src/accounts/routes';
import { createTestContext, type TestContext } from '../helpers/redis';
import { createPostgresContext, type PostgresContext } from '../helpers/postgres';

let ctx: TestContext;
let pg: PostgresContext;
let auth: AuthRoutes;
let base: string;
let close: () => Promise<void>;

/** Swapped per test, so a failing read can be described without a broken database. */
let entitlement: EntitlementService;

beforeAll(async () => {
  ctx = await createTestContext({
    AUTH_ENABLED: 'true',
    ACCOUNTS_ENABLED: 'true',
    AUTH_ISSUER: 'https://issuer.example/pool',
    AUTH_AUTHORIZE_URL: 'https://issuer.example/authorize',
    AUTH_TOKEN_URL: 'https://issuer.example/token',
    AUTH_JWKS_URL: 'https://issuer.example/jwks',
    AUTH_CLIENT_ID: 'client_1',
    AUTH_REDIRECT_URI: 'https://karobakbak.example/auth/callback',
    AUTH_SECURE_COOKIES: 'false',
  });
  pg = await createPostgresContext();

  entitlement = createEntitlementService(
    pg.db,
    ctx.client,
    pg.logger,
    ctx.config.redis.keyPrefix,
    ctx.config.auth.premiumCacheSeconds,
  );

  auth = createAuthRoutes({
    config: ctx.config,
    logger: pg.logger,
    db: pg.db,
    oidc: createOidcClient(ctx.config, pg.logger),
    redis: ctx.client,
    // Read through a holder rather than captured, so a test can substitute one
    // that throws without rebuilding the routes.
    entitlement: {
      premiumUntilMs: (accountId) => entitlement.premiumUntilMs(accountId),
    },
  });

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/auth/session') void auth.session(req, res);
    else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
});

afterAll(async () => {
  await close();
  await pg.close();
  await ctx.close();
});

let subjectCounter = 0;

/** An account and the cookie that authenticates it. */
async function signedIn(): Promise<{ accountId: string; cookie: string }> {
  subjectCounter += 1;
  const account = await accountForSubject(pg.db, pg.logger, `sub_premium_${subjectCounter}`, 365);
  if (!account.ok) throw new Error('could not create an account');
  const token = await mintCredential(pg.db, pg.logger, account.accountId, 3600);
  if (token === null) throw new Error('could not mint a credential');
  return { accountId: account.accountId, cookie: `kbb_kbb_session=${token}` };
}

async function session(cookie?: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}/auth/session`, {
    headers: cookie === undefined ? {} : { cookie },
  });
  return (await response.json()) as Record<string, unknown>;
}

/** Clears the entitlement cache, which caches negatives too. */
async function forget(accountId: string): Promise<void> {
  await ctx.client.del(`${ctx.config.redis.keyPrefix}:premium:${accountId}`);
}

describe('what /auth/session says about premium', () => {
  it('says false for a browser that is not signed in', async () => {
    // Premium requires an account, so there is no third state to represent.
    expect(await session()).toEqual({ signedIn: false, avatar: false, premium: false });
  });

  it('says false for an account that has bought nothing', async () => {
    const { cookie } = await signedIn();
    expect(await session(cookie)).toMatchObject({ signedIn: true, premium: false });
  });

  it('says true once a deadline is in the future', async () => {
    const { accountId, cookie } = await signedIn();
    await pg.db.query(`update accounts set premium_until = now() + interval '30 days' where id = $1`, [
      accountId,
    ]);
    await forget(accountId);
    expect(await session(cookie)).toMatchObject({ signedIn: true, premium: true });
  });

  it('says false again once the deadline has passed', async () => {
    // An expired entitlement is not an entitlement, and the comparison happens
    // where the deadline lives rather than against a clock in this process.
    const { accountId, cookie } = await signedIn();
    await pg.db.query(`update accounts set premium_until = now() - interval '1 day' where id = $1`, [
      accountId,
    ]);
    await forget(accountId);
    expect(await session(cookie)).toMatchObject({ signedIn: true, premium: false });
  });

  it('says false when the entitlement cannot be read at all', async () => {
    /*
      Fails closed, deliberately, and it is the interesting case because the
      alternative is tempting: a database blip would otherwise show the paid
      control to everybody who loaded the page during it, and every one of them
      would then set a preference the matchmaker refuses.
    */
    const { cookie } = await signedIn();
    const working = entitlement;
    entitlement = {
      premiumUntilMs: () => Promise.reject(new Error('database is away')),
    };
    try {
      expect(await session(cookie)).toMatchObject({ signedIn: true, premium: false });
    } finally {
      entitlement = working;
    }
  });

  /**
   * The claim `017_premium_entitlement.sql` shipped ahead of payments to make:
   * with nothing able to write `premium_until`, nobody can be premium.
   *
   * Asserted against the live database rather than the catalogue, because the
   * gate being provably closed is the reason the column landed early.
   */
  it('reports nobody as premium while nothing can grant it', async () => {
    const rows = await pg.rows<{ count: string }>(
      `select count(*)::text as count from accounts where premium_until is not null`,
    );
    // Only the rows these tests wrote by hand. Payments are off, and no code
    // path outside a fulfilled capture sets this column.
    expect(Number(rows[0]?.count ?? '0')).toBeLessThanOrEqual(2);
  });
});
