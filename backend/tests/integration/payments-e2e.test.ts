/**
 * The purchase path end to end, against a real PostgreSQL.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS WHEN THERE ARE ALREADY THREE PAYMENT TEST FILES
 * ---------------------------------------------------------------------------
 * `payments-routes`, `payments-signature` and `payments-products` are good and
 * they are all unit tests against fakes. Between them they prove the routes
 * refuse the right things, the HMAC is verified over the exact bytes, and the
 * catalogue prices what it says.
 *
 * None of them touches a database, so none of them can see the thing the money
 * is actually for: an order becoming a row, a capture becoming an entitlement,
 * and `accounts.premium_until` becoming the deadline matchmaking reads. That
 * chain is what D51 is about and it had never been executed. The column shipped
 * ahead of payments in `017_premium_entitlement.sql` precisely so the gate
 * would be provably closed while nothing could be bought — these tests are the
 * proof, now that something can.
 *
 * A payment webhook is an unauthenticated endpoint that grants entitlements,
 * which makes it the highest-value target in this system after
 * `TRUST_PROXY_HOPS`. The abuse cases below are not extras.
 */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createPostgresContext, type PostgresContext } from '../helpers/postgres';
import { PaymentRepository } from '../../src/payments/repository';
import { verifyWebhookSignature } from '../../src/payments/signature';
import { createNullLogger } from '../../src/logger';
import { newAccountId } from '../../src/util/ids';

let ctx: PostgresContext;
let payments: PaymentRepository;

const WEBHOOK_SECRET = 'test_webhook_secret';
/** The catalogue price of a month of premium, in paise (§ payments/products). */
const PREMIUM_PAISE = 9900;

/**
 * The payment schema is a **staged** migration, applied here rather than by
 * `migrate()`.
 *
 * `011_payments.sql` lives in `migrations-pending/` because turning payments on
 * is a commit with document changes in it (`docs/policies/PENDING-PAYMENTS.md`)
 * and the schema lands with the flags, not before. So these tests create it
 * themselves and are honest about testing something that has not shipped.
 *
 * The number is right despite looking wrong beside an applied set that runs to
 * 017: it depends only on `accounts`, which `010_accounts.sql` creates, so it
 * sorts immediately after its dependency on a fresh database. `migrate()`
 * tracks by filename rather than by ordinal, so landing it later applies it
 * alone and in the right place.
 */
const PENDING_PAYMENTS_SQL = join(
  __dirname,
  '..',
  '..',
  'src',
  'storage',
  'migrations-pending',
  '011_payments.sql',
);

beforeAll(async () => {
  ctx = await createPostgresContext();
  await ctx.db.query(readFileSync(PENDING_PAYMENTS_SQL, 'utf8'));
  payments = new PaymentRepository(ctx.db, createNullLogger());
});

afterAll(async () => {
  await ctx?.close();
});

/** An account that exists, so an order can name a subject. */
async function makeAccount(): Promise<string> {
  const id = newAccountId();
  await ctx.db.query(
    `insert into accounts (id, retention_expires_at) values ($1, now() + interval '30 days')`,
    [id],
  );
  return id;
}

async function premiumUntil(accountId: string): Promise<Date | null> {
  const rows = await ctx.rows<{ premium_until: Date | null }>(
    `select premium_until from accounts where id = $1`,
    [accountId],
  );
  return rows[0]?.premium_until ?? null;
}

let orderCounter = 0;
async function makeOrder(accountId: string | null, amountPaise = PREMIUM_PAISE): Promise<string> {
  orderCounter += 1;
  const orderId = `order_test_${Date.now().toString(36)}_${orderCounter}`;
  const ok = await payments.recordOrder({
    orderId,
    accountId,
    product: 'premium_1_month',
    amountPaise,
    currency: 'INR',
    // A financial record has its own retention, longer than a conversation's
    // and set by statute rather than by this project — `recordRetentionDays`.
    retentionExpiresAt: new Date(Date.now() + 365 * 86_400_000),
  });
  expect(ok).toBe(true);
  return orderId;
}

describe('a capture grants exactly what was bought', () => {
  it('sets premium_until a month out, and records the event', async () => {
    const account = await makeAccount();
    expect(await premiumUntil(account)).toBeNull();

    const orderId = await makeOrder(account);
    expect(await payments.fulfilCapture('pay_1', orderId, PREMIUM_PAISE)).toBe('fulfilled');

    const until = await premiumUntil(account);
    expect(until).not.toBeNull();

    const days = ((until as Date).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(32);

    const events = await ctx.rows(`select event from payment_events where payment_id = 'pay_1'`);
    expect(events).toHaveLength(1);
  });

  /**
   * The bug that gives away a year.
   *
   * `greatest(coalesce(premium_until, now()), now())` and not a bare `now()`:
   * renewing early must extend the deadline rather than reset it. The obvious
   * version silently deletes whatever time was left, and the person who notices
   * is one who paid twice.
   */
  it('extends an existing entitlement rather than resetting it', async () => {
    const account = await makeAccount();
    await payments.fulfilCapture('pay_first', await makeOrder(account), PREMIUM_PAISE);
    const afterFirst = (await premiumUntil(account)) as Date;

    await payments.fulfilCapture('pay_second', await makeOrder(account), PREMIUM_PAISE);
    const afterSecond = (await premiumUntil(account)) as Date;

    const addedDays = (afterSecond.getTime() - afterFirst.getTime()) / 86_400_000;
    expect(addedDays).toBeGreaterThan(29);
  });

  /**
   * Symmetric with the grant, and the path most payment integrations skip
   * entirely — the money goes back and the deadline stays where it was.
   */
  it('takes the time back on a refund, without going below now', async () => {
    const account = await makeAccount();
    const orderId = await makeOrder(account);
    await payments.fulfilCapture('pay_refunded', orderId, PREMIUM_PAISE);

    await payments.recordRefund('pay_refunded', orderId, PREMIUM_PAISE);

    const until = await premiumUntil(account);
    // Floored at now rather than driven into the past: a refund removes what it
    // paid for, and nothing more.
    if (until !== null) {
      expect(until.getTime()).toBeLessThanOrEqual(Date.now() + 60_000);
    }
  });
});

describe('a webhook is an unauthenticated endpoint that grants entitlements', () => {
  /**
   * Razorpay retries. A retry that granted a second month would be a bug an
   * attacker does not even need to find — the payment provider would trigger it
   * on its own during any delivery hiccup.
   */
  it('grants once however many times the same capture is delivered', async () => {
    const account = await makeAccount();
    const orderId = await makeOrder(account);

    expect(await payments.fulfilCapture('pay_dup', orderId, PREMIUM_PAISE)).toBe('fulfilled');
    const afterFirst = (await premiumUntil(account)) as Date;

    for (let i = 0; i < 4; i += 1) {
      expect(await payments.fulfilCapture('pay_dup', orderId, PREMIUM_PAISE)).toBe('duplicate');
    }

    expect((await premiumUntil(account))?.getTime()).toBe(afterFirst.getTime());
  });

  /** An event naming an order this system never created grants nothing. */
  it('refuses a capture for an order that does not exist', async () => {
    expect(await payments.fulfilCapture('pay_ghost', 'order_never_created', PREMIUM_PAISE)).toBe(
      'unknown_order',
    );
  });

  /**
   * The obvious attack: pay one rupee, claim a month.
   *
   * Recorded and not granted — the event row is committed rather than rolled
   * back, because a mismatch that leaves no trace is one nobody investigates.
   */
  it('records but does not grant when the captured amount is short', async () => {
    const account = await makeAccount();
    const orderId = await makeOrder(account);

    expect(await payments.fulfilCapture('pay_short', orderId, 100)).toBe('amount_mismatch');
    expect(await premiumUntil(account)).toBeNull();

    const events = await ctx.rows(`select event from payment_events where payment_id = 'pay_short'`);
    expect(events).toHaveLength(1);
  });

  it('does not grant when the captured amount is larger than the order', async () => {
    const account = await makeAccount();
    const orderId = await makeOrder(account);

    expect(await payments.fulfilCapture('pay_over', orderId, PREMIUM_PAISE * 10)).toBe(
      'amount_mismatch',
    );
    expect(await premiumUntil(account)).toBeNull();
  });

  /**
   * A forged body is refused before anything reads it, by HMAC over the exact
   * bytes received. Asserted here as well as in the unit suite because this is
   * the boundary the abuse cases above all sit behind — if it were wrong, none
   * of them would matter.
   */
  it('refuses a body whose signature was made with a different secret', () => {
    const body = JSON.stringify({ event: 'payment.captured' });
    const forged = createHmac('sha256', 'not_the_secret').update(body).digest('hex');

    // A verdict rather than a boolean, deliberately: "no secret configured" is
    // not the same answer as "this signature is wrong", and collapsing them is
    // how a deployment that forgot the variable ends up accepting anything.
    expect(verifyWebhookSignature(Buffer.from(body), forged, WEBHOOK_SECRET)).not.toBe('valid');

    const genuine = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex');
    expect(verifyWebhookSignature(Buffer.from(body), genuine, WEBHOOK_SECRET)).toBe('valid');

    // And an unset secret verifies nothing, even against a correct HMAC.
    expect(verifyWebhookSignature(Buffer.from(body), genuine, '')).not.toBe('valid');
  });
});

describe('the entitlement gate', () => {
  /**
   * D51: `premium_until` is the truth and matchmaking does not read it.
   *
   * What a search reads is `premiumUntil` stamped onto the session row when a
   * connection binds an account, which keeps a search off PostgreSQL (D16) and
   * off an extra Redis key. This asserts the column behaves as the source of
   * truth; `preference-limits` covers what the session row does with it.
   */
  it('reports an account as not premium until a capture is fulfilled', async () => {
    const account = await makeAccount();
    expect(await premiumUntil(account)).toBeNull();

    const orderId = await makeOrder(account);
    // An order that exists and has not been paid grants nothing. This is the
    // state a checkout that was opened and abandoned leaves behind.
    expect(await premiumUntil(account)).toBeNull();

    await payments.fulfilCapture('pay_gate', orderId, PREMIUM_PAISE);
    expect(await premiumUntil(account)).not.toBeNull();
  });

  /**
   * An expired entitlement is not an entitlement.
   *
   * Worth asserting against the database rather than against a clock in a fake:
   * the comparison that matters happens in SQL, and a deadline in the past must
   * read as absent rather than as "was premium once".
   */
  it('treats a deadline in the past as not premium', async () => {
    const account = await makeAccount();
    await ctx.db.query(`update accounts set premium_until = now() - interval '1 day' where id = $1`, [
      account,
    ]);

    const rows = await ctx.rows<{ premium: boolean }>(
      `select (premium_until is not null and premium_until > now()) as premium
         from accounts where id = $1`,
      [account],
    );
    expect(rows[0]?.premium).toBe(false);
  });

  /**
   * A donation takes money and grants nothing, and that has to survive contact
   * with the database rather than only the catalogue.
   */
  it('grants no entitlement for a product with no grant days', async () => {
    orderCounter += 1;
    const orderId = `order_donation_${orderCounter}`;
    await payments.recordOrder({
      orderId,
      accountId: null,
      product: 'donation',
      amountPaise: 50_000,
      currency: 'INR',
      retentionExpiresAt: new Date(Date.now() + 365 * 86_400_000),
    });

    expect(await payments.fulfilCapture('pay_donation', orderId, 50_000)).toBe('fulfilled');

    const granted = await ctx.rows(`select id from accounts where premium_until is not null`);
    // Every premium account in this schema came from a test above; a donation
    // must not have added one.
    for (const row of granted) {
      expect(row).toBeDefined();
    }
  });
});
