/**
 * The two payment routes.
 *
 * `POST /api/payments/create-order` — outbound. Decides the price server-side,
 * asks the provider for an order id, writes the binding, hands the browser the
 * three fields the checkout needs.
 *
 * `POST /api/webhooks/razorpay` — inbound, and the only unauthenticated
 * state-changing route in this process. Everything it is allowed to do is
 * gated on an HMAC over the exact bytes received.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS AUTHORITATIVE, AND WHAT IS MERELY PRESENT
 * ---------------------------------------------------------------------------
 * Protocol rule 3 says the server never reads identity, routing or ordering
 * from a client frame. The same applies here, and it is easy to get wrong
 * because the webhook body *looks* authoritative — it is signed, after all.
 *
 * The signature proves the bytes came from Razorpay. It does not make the
 * `notes` inside them a safe place to learn who gets premium, because those
 * notes were originally set from a request body. So:
 *
 *   authoritative:  the order id (the provider mints it), the captured amount,
 *                   the event name, the payment id
 *   never trusted:  who the payment is for, what it was for, what it should
 *                   have cost — all read from `payment_orders`, which we wrote
 *
 * The only client-supplied field that survives anywhere is a donation amount,
 * which is bounded on both sides in `products.ts`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { Config } from '../config';
import { errorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';
import { hashIp, newPaymentReceipt } from '../util/ids';
import { clientAddress } from '../ws/upgrade';
import { bearerToken, resolveAccount } from '../accounts/credentials';
import type { PaymentGateway } from './gateway';
import { findProduct, resolveAmountPaise } from './products';
import type { PaymentRepository } from './repository';
import { verifyWebhookSignature } from './signature';

/** Only what this module needs, so a test does not have to build a RedisStore. */
export interface PaymentRateLimiter {
  paymentRateLimit(ipHash: string): Promise<{ allowed: boolean }>;
}

export interface PaymentRoutesDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly db: Database;
  readonly store: PaymentRateLimiter;
  readonly gateway: PaymentGateway;
  readonly repository: PaymentRepository;
}

export interface PaymentRoutes {
  createOrder(req: IncomingMessage, res: ServerResponse): Promise<void>;
  webhook(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

export function createPaymentRoutes(deps: PaymentRoutesDeps): PaymentRoutes {
  const { config, logger, db, store, gateway, repository } = deps;

  /**
   * Read a request body, refusing anything over the configured ceiling.
   *
   * Modelled on `handleBackupReport` in `server.ts`, and for the same reason:
   * an unbounded read on an unauthenticated route lets an anonymous caller
   * decide how much memory this process allocates. Bytes are counted, not
   * characters — a multi-byte body would otherwise pass a character-count
   * check while being several times larger — and the chunks are collected as
   * `Buffer`s because the webhook signature covers the exact bytes and any
   * decode-then-re-encode would change them.
   */
  function readBody(req: IncomingMessage): Promise<Buffer | 'too_large' | 'aborted'> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let settled = false;

      const finish = (outcome: Buffer | 'too_large' | 'aborted'): void => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };

      req.on('data', (chunk: Buffer) => {
        if (settled) return;
        total += chunk.length;
        if (total > config.payments.maxBodyBytes) {
          // Stop reading and stop holding what has arrived. `destroy` rather
          // than a flag that keeps draining: the point is to stop paying for
          // the request, not to read it politely to the end.
          chunks.length = 0;
          finish('too_large');
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => finish(Buffer.concat(chunks)));
      req.on('error', () => finish('aborted'));
      req.on('aborted', () => finish('aborted'));
    });
  }

  function json(res: ServerResponse, status: number, body: unknown): void {
    const serialised = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(serialised),
      'cache-control': 'no-store',
    });
    res.end(serialised);
  }

  function parseJsonObject(body: Buffer): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(body.toString('utf8'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
      return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  async function createOrder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ipHash = hashIp(
      clientAddress(req, config.http.trustProxyHops),
      config.security.ipHashSalt,
    );

    // Rate limit before the body is read, so a limited caller costs one Redis
    // round trip rather than a buffered body and a call to the provider.
    let allowed = false;
    try {
      ({ allowed } = await store.paymentRateLimit(ipHash));
    } catch (err) {
      // Redis is the thing this server cannot run without, and `/ready`
      // already reflects that. Refusing the order is the conservative answer:
      // the alternative is an unlimited route whenever Redis blips.
      logger.error('payment rate limiter unavailable', errorFields(err));
      json(res, 503, { error: 'unavailable' });
      return;
    }
    if (!allowed) {
      json(res, 429, { error: 'rate_limited' });
      return;
    }

    const body = await readBody(req);
    if (body === 'too_large') {
      json(res, 413, { error: 'payload_too_large' });
      return;
    }
    if (body === 'aborted') return;

    const parsed = parseJsonObject(body);
    if (parsed === null) {
      json(res, 400, { error: 'bad_json' });
      return;
    }

    const product = findProduct(parsed.product);
    if (product === null) {
      // The catalogue is not enumerated in the refusal. There is no reason a
      // caller needs to discover product keys by probing.
      json(res, 400, { error: 'unknown_product' });
      return;
    }

    // Who this is for, resolved from a credential and never from the body.
    let accountId: string | null = null;
    if (product.requiresAccount) {
      const resolution = await resolveAccount(db, logger, bearerToken(req.headers.authorization));
      if (!resolution.ok) {
        if (resolution.reason === 'error') {
          json(res, 503, { error: 'unavailable' });
          return;
        }
        // `absent`, `unknown` and `suspended` share one response. A caller that
        // can tell them apart can probe which credentials were ever real.
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      accountId = resolution.accountId;
    }

    const amount = resolveAmountPaise(product, parsed.amountPaise);
    if (!amount.ok) {
      json(res, 400, { error: 'invalid_amount', reason: amount.refusal.reason });
      return;
    }

    const created = await gateway.createOrder({
      amountPaise: amount.amountPaise,
      currency: config.payments.currency,
      receipt: newPaymentReceipt(),
    });
    if (created === null) {
      json(res, 502, { error: 'gateway_unavailable' });
      return;
    }

    // Written before the browser is told the order exists. If this fails the
    // order is abandoned at the provider unpaid, which costs nothing; the
    // reverse — a checkout opened for an order we have no row for — is a
    // payment that arrives with nowhere to land.
    const retentionExpiresAt = new Date(
      Date.now() + config.payments.recordRetentionDays * 86_400_000,
    );
    const recorded = await repository.recordOrder({
      orderId: created.orderId,
      accountId,
      product: String(parsed.product),
      amountPaise: created.amountPaise,
      currency: created.currency,
      retentionExpiresAt,
    });
    if (!recorded) {
      json(res, 503, { error: 'unavailable' });
      return;
    }

    logger.info('created a payment order', {
      orderId: created.orderId,
      productKey: String(parsed.product),
      amountPaise: created.amountPaise,
    });

    // `keyId` is the publishable key and is meant to reach the browser. The
    // API secret and the webhook secret never appear in a response, and there
    // is no route that would return them.
    json(res, 200, {
      orderId: created.orderId,
      amountPaise: created.amountPaise,
      currency: created.currency,
      keyId: config.payments.keyId,
    });
  }

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    if (body === 'too_large') {
      json(res, 413, { error: 'payload_too_large' });
      return;
    }
    if (body === 'aborted') return;

    const verdict = verifyWebhookSignature(
      body,
      req.headers['x-razorpay-signature'],
      config.payments.webhookSecret,
    );
    if (verdict !== 'valid') {
      // One response for every failure, and no detail about which. The count is
      // worth having in the log because a run of them is either a
      // misconfiguration or somebody trying; the verdict is not echoed to the
      // caller.
      logger.warn('refused a payment webhook', { verdict });
      json(res, 401, { error: 'unauthorized' });
      return;
    }

    const parsed = parseJsonObject(body);
    if (parsed === null) {
      json(res, 400, { error: 'bad_json' });
      return;
    }

    const event = typeof parsed.event === 'string' ? parsed.event : '';
    const isRefund = event === 'refund.processed' || event === 'refund.created';
    const entity = isRefund ? refundEntity(parsed) : paymentEntity(parsed);
    if (entity === null) {
      // Signed, well-formed JSON, and not a shape this handler understands.
      // Answered 200 so Razorpay stops retrying something no retry will fix,
      // and logged so an unhandled event type is discoverable.
      logger.info('ignored a payment webhook with no usable entity', { paymentEvent: event });
      json(res, 200, { status: 'ignored' });
      return;
    }

    let outcome: string;
    switch (event) {
      case 'payment.captured':
        outcome = await repository.fulfilCapture(entity.paymentId, entity.orderId, entity.amount);
        break;
      case 'payment.failed':
        await repository.recordFailure(entity.paymentId, entity.orderId, entity.amount);
        outcome = 'recorded';
        break;
      case 'refund.processed':
      case 'refund.created':
        outcome = await repository.recordRefund(entity.paymentId, entity.orderId, entity.amount);
        break;
      default:
        // Razorpay sends whatever the dashboard is subscribed to. An unknown
        // event is not an error; it is a subscription somebody enabled.
        logger.info('ignored an unhandled payment event', { paymentEvent: event });
        json(res, 200, { status: 'ignored' });
        return;
    }

    if (outcome === 'error') {
      // The one case that must not be a 200. A non-2xx makes Razorpay retry,
      // which is exactly right for a database that was briefly unavailable —
      // and answering 200 would mean the retry never comes and the payment is
      // silently unrecorded.
      json(res, 500, { error: 'not_recorded' });
      return;
    }

    logger.info('handled a payment webhook', {
      paymentEvent: event,
      orderId: entity.orderId,
      paymentId: entity.paymentId,
      outcome,
    });
    json(res, 200, { status: outcome });
  }

  return { createOrder, webhook };
}

interface PaymentEntity {
  readonly paymentId: string;
  readonly orderId: string;
  readonly amount: number;
}

/** Reach `payload.<name>.entity` without trusting any level of it to exist. */
function entityAt(body: Record<string, unknown>, name: string): Record<string, unknown> | null {
  const payload = body.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const wrapper = (payload as Record<string, unknown>)[name];
  if (typeof wrapper !== 'object' || wrapper === null) return null;
  const entity = (wrapper as Record<string, unknown>).entity;
  if (typeof entity !== 'object' || entity === null) return null;
  return entity as Record<string, unknown>;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Pull the three authoritative fields out of a verified payment webhook.
 *
 * Every field is type-checked rather than assumed. The body is signed, so this
 * is not defending against forgery — it is defending against a schema change at
 * the provider turning into an `undefined` that reaches SQL as a null and
 * violates a not-null constraint at three in the morning.
 */
function paymentEntity(body: Record<string, unknown>): PaymentEntity | null {
  const entity = entityAt(body, 'payment');
  if (entity === null) return null;
  const paymentId = nonEmptyString(entity.id);
  const orderId = nonEmptyString(entity.order_id);
  const amount = wholeNumber(entity.amount);
  if (paymentId === null || orderId === null || amount === null) return null;
  return { paymentId, orderId, amount };
}

/**
 * The same for a refund, which is shaped differently in two ways that both
 * matter and are only ever learned by receiving one.
 *
 * The refund entity carries its own id and its own amount, and that amount is
 * the one to record: a partial refund of ₹40 against a ₹99 payment reports 9900
 * under `payload.payment.entity.amount` and 4000 under the refund. Taking the
 * payment amount would file every partial refund as a full one.
 *
 * The order id, though, is only on the payment entity — so both are needed, and
 * a body carrying one without the other is not something to guess at.
 *
 * The ledger key is the *refund* id rather than the payment id, because one
 * payment can be refunded more than once and the two refunds are two events.
 * Keying on the payment id would make the second refund look like a duplicate
 * delivery of the first and silently drop it.
 */
function refundEntity(body: Record<string, unknown>): PaymentEntity | null {
  const refund = entityAt(body, 'refund');
  const payment = entityAt(body, 'payment');
  if (refund === null || payment === null) return null;
  const refundId = nonEmptyString(refund.id);
  const orderId = nonEmptyString(payment.order_id);
  const amount = wholeNumber(refund.amount);
  if (refundId === null || orderId === null || amount === null) return null;
  return { paymentId: refundId, orderId, amount };
}
