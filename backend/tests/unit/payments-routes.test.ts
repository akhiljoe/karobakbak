import { EventEmitter } from 'node:events';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { loadConfig, type Config, type Env } from '../../src/config';
import { createNullLogger } from '../../src/logger';
import type { CreateOrderRequest, PaymentGateway } from '../../src/payments/gateway';
import type { FulfilOutcome, NewOrder, PaymentRepository } from '../../src/payments/repository';
import { createPaymentRoutes, type PaymentRoutes } from '../../src/payments/routes';
import type { Database } from '../../src/storage/pool';

const WEBHOOK_SECRET = 'whsec_unit_test';

function config(overrides: Env = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'error',
    INSTANCE_ID: 'i_test',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    PAYMENTS_ENABLED: 'true',
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'secret',
    RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ...overrides,
  });
}

/* --- doubles -------------------------------------------------------------- */

interface RecordedResponse {
  status: number;
  body: Record<string, unknown>;
}

/** A `ServerResponse` that records what was written instead of writing it. */
function fakeResponse(): { res: ServerResponse; recorded: () => RecordedResponse } {
  let status = 0;
  let raw = '';
  const res = {
    headersSent: false,
    writeHead(code: number) {
      status = code;
      (this as { headersSent: boolean }).headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (typeof chunk === 'string') raw = chunk;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    recorded: () => ({ status, body: raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>) }),
  };
}

/**
 * A request that emits `body` on the next tick.
 *
 * Emitted as several chunks on purpose: the size ceiling counts bytes as they
 * arrive, and a single-chunk fake would not exercise the accumulation.
 */
function fakeRequest(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage & { destroy(): void };
  (req as unknown as { headers: unknown }).headers = headers;
  (req as unknown as { socket: unknown }).socket = { remoteAddress: '203.0.113.7' };
  (req as unknown as { destroy: () => void }).destroy = () => undefined;

  setImmediate(() => {
    const buffer = Buffer.from(body, 'utf8');
    for (let offset = 0; offset < buffer.length; offset += 8) {
      req.emit('data', buffer.subarray(offset, offset + 8));
    }
    req.emit('end');
  });
  return req;
}

function signed(body: string, secret = WEBHOOK_SECRET): Record<string, string> {
  return { 'x-razorpay-signature': createHmac('sha256', secret).update(body).digest('hex') };
}

class FakeGateway implements PaymentGateway {
  readonly seen: CreateOrderRequest[] = [];
  next: string | null = 'order_ABC123';

  async createOrder(request: CreateOrderRequest) {
    this.seen.push(request);
    if (this.next === null) return null;
    return {
      orderId: this.next,
      amountPaise: request.amountPaise,
      currency: request.currency,
    };
  }
}

class FakeRepository {
  readonly orders: NewOrder[] = [];
  readonly captures: Array<[string, string, number]> = [];
  readonly refunds: Array<[string, string, number]> = [];
  readonly failures: Array<[string, string, number]> = [];
  captureOutcome: FulfilOutcome = 'fulfilled';
  recordOrderOk = true;

  async recordOrder(order: NewOrder): Promise<boolean> {
    this.orders.push(order);
    return this.recordOrderOk;
  }
  async fulfilCapture(p: string, o: string, a: number): Promise<FulfilOutcome> {
    this.captures.push([p, o, a]);
    return this.captureOutcome;
  }
  async recordRefund(p: string, o: string, a: number): Promise<FulfilOutcome> {
    this.refunds.push([p, o, a]);
    return 'fulfilled';
  }
  async recordFailure(p: string, o: string, a: number): Promise<void> {
    this.failures.push([p, o, a]);
  }
}

/** A database that answers the credential lookup and nothing else. */
function fakeDatabase(rows: Array<{ account_id: string; status: string }>): Database {
  return {
    pool: {} as Database['pool'],
    async query(text: string) {
      if (text.includes('account_credentials') && text.trim().startsWith('select')) {
        return { rows: rows as never[], rowCount: rows.length };
      }
      return { rows: [], rowCount: 0 };
    },
    async transaction() {
      throw new Error('not used');
    },
    async close() {},
  } as unknown as Database;
}

function build(options: {
  gateway?: FakeGateway;
  repository?: FakeRepository;
  db?: Database;
  allowed?: boolean;
  cfg?: Config;
}): {
  routes: PaymentRoutes;
  gateway: FakeGateway;
  repository: FakeRepository;
} {
  const gateway = options.gateway ?? new FakeGateway();
  const repository = options.repository ?? new FakeRepository();
  const routes = createPaymentRoutes({
    config: options.cfg ?? config(),
    logger: createNullLogger(),
    db: options.db ?? fakeDatabase([{ account_id: 'acc_1', status: 'active' }]),
    store: { paymentRateLimit: async () => ({ allowed: options.allowed ?? true }) },
    gateway,
    repository: repository as unknown as PaymentRepository,
  });
  return { routes, gateway, repository };
}

async function post(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  body: string,
  headers: Record<string, string> = {},
): Promise<RecordedResponse> {
  const { res, recorded } = fakeResponse();
  await handler(fakeRequest(body, headers), res);
  return recorded();
}

/* --- create-order --------------------------------------------------------- */

describe('POST /api/payments/create-order', () => {
  it('creates an order at the catalogue price and returns the publishable key only', async () => {
    const { routes, gateway, repository } = build({});
    const result = await post(
      routes.createOrder,
      JSON.stringify({ product: 'premium_1_month' }),
      { authorization: 'Bearer live-token' },
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      orderId: 'order_ABC123',
      amountPaise: 9900,
      currency: 'INR',
      keyId: 'rzp_test_key',
    });
    expect(gateway.seen[0]?.amountPaise).toBe(9900);
    expect(repository.orders[0]?.accountId).toBe('acc_1');
    // Nothing secret leaves the process.
    expect(JSON.stringify(result.body)).not.toContain('whsec');
    expect(Object.keys(result.body)).not.toContain('keySecret');
  });

  /** Server-authoritative pricing: the body cannot lower the charge. */
  it('ignores an amount supplied for a fixed-price product', async () => {
    const { routes, gateway } = build({});
    const result = await post(
      routes.createOrder,
      JSON.stringify({ product: 'premium_1_month', amountPaise: 1 }),
      { authorization: 'Bearer live-token' },
    );
    expect(result.status).toBe(200);
    expect(gateway.seen[0]?.amountPaise).toBe(9900);
  });

  /**
   * Protocol rule 3, applied to HTTP. The rejected prototype read `userId`
   * straight from the body and put it in the provider's notes.
   */
  it('never reads the subject from the request body', async () => {
    const { routes, repository } = build({});
    await post(
      routes.createOrder,
      JSON.stringify({ product: 'premium_1_month', accountId: 'acc_victim', userId: 'acc_victim' }),
      { authorization: 'Bearer live-token' },
    );
    expect(repository.orders[0]?.accountId).toBe('acc_1');
  });

  it('refuses an entitlement purchase with no credential, and says nothing about why', async () => {
    const { routes, gateway } = build({});
    const noHeader = await post(routes.createOrder, JSON.stringify({ product: 'premium_1_month' }));
    expect(noHeader.status).toBe(401);
    expect(noHeader.body).toEqual({ error: 'unauthorized' });

    const unknown = build({ db: fakeDatabase([]) });
    const badToken = await post(
      unknown.routes.createOrder,
      JSON.stringify({ product: 'premium_1_month' }),
      { authorization: 'Bearer nope' },
    );
    // Identical response, so a caller cannot tell a revoked token from one that
    // never existed.
    expect(badToken.status).toBe(401);
    expect(badToken.body).toEqual(noHeader.body);
    expect(gateway.seen).toHaveLength(0);
  });

  it('refuses a suspended account before taking its money', async () => {
    const { routes, gateway } = build({
      db: fakeDatabase([{ account_id: 'acc_1', status: 'suspended' }]),
    });
    const result = await post(routes.createOrder, JSON.stringify({ product: 'premium_1_month' }), {
      authorization: 'Bearer live-token',
    });
    expect(result.status).toBe(401);
    expect(gateway.seen).toHaveLength(0);
  });

  it('takes a donation without an account and grants nothing', async () => {
    const { routes, gateway, repository } = build({});
    const result = await post(
      routes.createOrder,
      JSON.stringify({ product: 'donation', amountPaise: 20_000 }),
    );
    expect(result.status).toBe(200);
    expect(gateway.seen[0]?.amountPaise).toBe(20_000);
    expect(repository.orders[0]?.accountId).toBeNull();
  });

  it('refuses a donation below the floor', async () => {
    const { routes, gateway } = build({});
    const result = await post(
      routes.createOrder,
      JSON.stringify({ product: 'donation', amountPaise: 100 }),
    );
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'invalid_amount', reason: 'below_minimum' });
    expect(gateway.seen).toHaveLength(0);
  });

  it('rate limits before it reads a body or calls the provider', async () => {
    const { routes, gateway } = build({ allowed: false });
    const result = await post(routes.createOrder, JSON.stringify({ product: 'premium_1_month' }), {
      authorization: 'Bearer live-token',
    });
    expect(result.status).toBe(429);
    expect(gateway.seen).toHaveLength(0);
  });

  it('refuses a body over the ceiling instead of buffering it', async () => {
    const { routes, gateway } = build({ cfg: config({ PAYMENTS_MAX_BODY_BYTES: '512' }) });
    const result = await post(routes.createOrder, 'x'.repeat(4096), {
      authorization: 'Bearer live-token',
    });
    expect(result.status).toBe(413);
    expect(gateway.seen).toHaveLength(0);
  });

  it('refuses an unknown product without enumerating the catalogue', async () => {
    const { routes } = build({});
    const result = await post(routes.createOrder, JSON.stringify({ product: 'premium_1_decade' }));
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: 'unknown_product' });
  });

  it('does not tell the browser an order exists when it could not be recorded', async () => {
    const repository = new FakeRepository();
    repository.recordOrderOk = false;
    const { routes } = build({ repository });
    const result = await post(routes.createOrder, JSON.stringify({ product: 'premium_1_month' }), {
      authorization: 'Bearer live-token',
    });
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('orderId');
  });

  /** Our account ids must not end up in a third party's dashboard. */
  it('sends the provider a receipt that carries no internal identifier', async () => {
    const { routes, gateway } = build({});
    await post(routes.createOrder, JSON.stringify({ product: 'premium_1_month' }), {
      authorization: 'Bearer live-token',
    });
    const receipt = gateway.seen[0]?.receipt ?? '';
    expect(receipt).toMatch(/^rcpt_/);
    expect(receipt).not.toContain('acc_1');
  });
});

/* --- webhook -------------------------------------------------------------- */

function capturedBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    event: 'payment.captured',
    payload: {
      payment: {
        entity: { id: 'pay_1', order_id: 'order_ABC123', amount: 9900, ...overrides },
      },
    },
  });
}

describe('POST /api/webhooks/razorpay', () => {
  it('fulfils a correctly signed capture', async () => {
    const { routes, repository } = build({});
    const body = capturedBody();
    const result = await post(routes.webhook, body, signed(body));

    expect(result.status).toBe(200);
    expect(repository.captures).toEqual([['pay_1', 'order_ABC123', 9900]]);
  });

  it('refuses an unsigned or wrongly signed delivery and changes nothing', async () => {
    const { routes, repository } = build({});
    const body = capturedBody();

    expect((await post(routes.webhook, body)).status).toBe(401);
    expect((await post(routes.webhook, body, signed(body, 'wrong'))).status).toBe(401);
    expect(
      (await post(routes.webhook, body, { 'x-razorpay-signature': 'a'.repeat(64) })).status,
    ).toBe(401);
    expect(repository.captures).toHaveLength(0);
  });

  /**
   * The forgery the whole ledger design exists to prevent: a body naming its
   * own beneficiary. It is refused at the signature, before anything reads it.
   */
  it('refuses a self-signed body that names its own subject', async () => {
    const { routes, repository } = build({});
    const forged = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: 'pay_forged',
            order_id: 'order_ABC123',
            amount: 9900,
            notes: { accountId: 'acc_attacker' },
          },
        },
      },
    });
    const result = await post(routes.webhook, forged, signed(forged, 'guessed'));
    expect(result.status).toBe(401);
    expect(repository.captures).toHaveLength(0);
  });

  it('answers 200 for a duplicate so the provider stops retrying', async () => {
    const repository = new FakeRepository();
    repository.captureOutcome = 'duplicate';
    const { routes } = build({ repository });
    const body = capturedBody();
    const result = await post(routes.webhook, body, signed(body));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'duplicate' });
  });

  /** The one outcome that must not be a 200: a retry is what we want. */
  it('answers 500 when the delivery could not be recorded', async () => {
    const repository = new FakeRepository();
    repository.captureOutcome = 'error';
    const { routes } = build({ repository });
    const body = capturedBody();
    const result = await post(routes.webhook, body, signed(body));
    expect(result.status).toBe(500);
  });

  it('records a refund with the refund amount, not the payment amount', async () => {
    const { routes, repository } = build({});
    // A ₹40 refund against a ₹99 payment. Reading the payment entity would file
    // this as a full refund.
    const body = JSON.stringify({
      event: 'refund.processed',
      payload: {
        refund: { entity: { id: 'rfnd_1', payment_id: 'pay_1', amount: 4000 } },
        payment: { entity: { id: 'pay_1', order_id: 'order_ABC123', amount: 9900 } },
      },
    });
    const result = await post(routes.webhook, body, signed(body));
    expect(result.status).toBe(200);
    expect(repository.refunds).toEqual([['rfnd_1', 'order_ABC123', 4000]]);
  });

  it('records a failed payment', async () => {
    const { routes, repository } = build({});
    const body = JSON.stringify({
      event: 'payment.failed',
      payload: { payment: { entity: { id: 'pay_2', order_id: 'order_ABC123', amount: 9900 } } },
    });
    const result = await post(routes.webhook, body, signed(body));
    expect(result.status).toBe(200);
    expect(repository.failures).toEqual([['pay_2', 'order_ABC123', 9900]]);
  });

  it('ignores an event it does not handle without failing it', async () => {
    const { routes, repository } = build({});
    const body = JSON.stringify({
      event: 'subscription.activated',
      payload: { payment: { entity: { id: 'pay_3', order_id: 'o', amount: 1 } } },
    });
    const result = await post(routes.webhook, body, signed(body));
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: 'ignored' });
    expect(repository.captures).toHaveLength(0);
  });

  it('ignores a signed body whose entity is missing or malformed', async () => {
    const { routes, repository } = build({});
    for (const body of [
      JSON.stringify({ event: 'payment.captured' }),
      JSON.stringify({ event: 'payment.captured', payload: {} }),
      capturedBody({ amount: '9900' }),
      capturedBody({ order_id: '' }),
      capturedBody({ id: null }),
    ]) {
      const result = await post(routes.webhook, body, signed(body));
      expect([body, result.status]).toEqual([body, 200]);
    }
    expect(repository.captures).toHaveLength(0);
  });

  it('refuses an oversized delivery before verifying anything', async () => {
    const { routes, repository } = build({ cfg: config({ PAYMENTS_MAX_BODY_BYTES: '512' }) });
    const body = JSON.stringify({ event: 'payment.captured', pad: 'x'.repeat(4096) });
    const result = await post(routes.webhook, body, signed(body));
    expect(result.status).toBe(413);
    expect(repository.captures).toHaveLength(0);
  });
});
