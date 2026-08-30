/**
 * Payment persistence.
 *
 * ---------------------------------------------------------------------------
 * THIS IS THE ONE PLACE WHERE CHAT *DOES* WAIT ON POSTGRESQL
 * ---------------------------------------------------------------------------
 * D16 says never make chat wait on the database, and the retention path is
 * write-behind for exactly that reason. This is not the chat path. A payment
 * route is an ordinary HTTP request that is allowed to fail, and a webhook that
 * cannot be recorded *must* fail — Razorpay retries a non-2xx, which is the
 * behaviour we want when the database is down. Queueing a fulfilment and
 * answering 200 would tell the payment provider the money was handled while the
 * grant sat in a lossy buffer.
 *
 * So: synchronous, transactional, and it returns an error the caller can turn
 * into a retry. The circuit breaker is deliberately not in front of it for the
 * same reason.
 *
 * ---------------------------------------------------------------------------
 * THE SUBJECT IS RESOLVED HERE, FROM OUR OWN ROW
 * ---------------------------------------------------------------------------
 * `fulfilCapture` is handed an order id and nothing else about who benefits.
 * The account comes from `payment_orders`, written by us when the order was
 * created. This mirrors `issueBanForReport` (§25.3): the route names the
 * *record*, and the server resolves the subject from it.
 */
import type { PoolClient } from 'pg';

import { dbErrorFields, type Logger } from '../logger';
import type { Database } from '../storage/pool';
import { capturedAmountMatches, findProduct } from './products';

export interface NewOrder {
  readonly orderId: string;
  /** Null only for products that grant nothing. */
  readonly accountId: string | null;
  readonly product: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly retentionExpiresAt: Date;
}

/**
 * What happened to one webhook delivery.
 *
 * `duplicate` is a success: it is the idempotency guarantee working, and the
 * caller answers 200 so Razorpay stops retrying. Only `error` is a retry.
 */
export type FulfilOutcome =
  | 'fulfilled'
  | 'duplicate'
  | 'unknown_order'
  | 'amount_mismatch'
  | 'no_subject'
  | 'error';

export class PaymentRepository {
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  /**
   * Record an order before the browser is ever told it exists.
   *
   * Called after Razorpay has minted the id and before the response is written,
   * so there is no window in which a checkout can be opened for an order this
   * database has never heard of. If this insert fails the caller returns an
   * error and the order is simply abandoned at the provider — an unpaid order
   * costs nothing and expires on its own.
   */
  async recordOrder(order: NewOrder): Promise<boolean> {
    try {
      await this.db.query(
        `insert into payment_orders
           (order_id, account_id, product, amount_paise, currency, retention_expires_at)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          order.orderId,
          order.accountId,
          order.product,
          order.amountPaise,
          order.currency,
          order.retentionExpiresAt,
        ],
      );
      return true;
    } catch (err) {
      this.logger.error('could not record a payment order', dbErrorFields(err));
      return false;
    }
  }

  /**
   * Apply one captured payment, exactly once.
   *
   * The whole thing is one transaction and the order row is locked first, so
   * two simultaneous deliveries of the same webhook serialise: the second finds
   * the ledger row already present and returns `duplicate` without granting a
   * second month.
   */
  async fulfilCapture(
    paymentId: string,
    orderId: string,
    capturedPaise: number,
  ): Promise<FulfilOutcome> {
    try {
      return await this.db.transaction(async (client: PoolClient) => {
        const order = await lockOrder(client, orderId);
        if (order === null) return 'unknown_order';

        // The ledger row goes in before anything is granted. A crash between
        // the two leaves a recorded event and no entitlement, which a person
        // can complain about and an operator can fix; the other order leaves a
        // granted month with nothing saying why, which nobody can even find.
        const inserted = await client.query(
          `insert into payment_events (payment_id, event, order_id, amount_paise)
           values ($1, 'captured', $2, $3)
           on conflict (payment_id, event) do nothing`,
          [paymentId, orderId, capturedPaise],
        );
        if (inserted.rowCount === 0) return 'duplicate';

        if (!capturedAmountMatches(order.amountPaise, capturedPaise)) {
          // Recorded and not granted. The event row is the evidence, and it is
          // committed rather than rolled back — a mismatch that leaves no trace
          // is one nobody investigates.
          this.logger.error('captured amount did not match the order', {
            orderId,
            paymentId,
            expectedPaise: order.amountPaise,
            capturedPaise,
          });
          return 'amount_mismatch';
        }

        const product = findProduct(order.product);
        if (product === null) {
          // The catalogue changed under a live order. Recorded, not granted.
          this.logger.error('captured a payment for a product that no longer exists', {
            orderId,
            paymentId,
          });
          return 'amount_mismatch';
        }

        await client.query(
          `update payment_orders set status = 'paid', paid_at = now() where order_id = $1`,
          [orderId],
        );

        if (product.grantDays === 0) return 'fulfilled';
        if (order.accountId === null) {
          // A grant-bearing product with no subject should be impossible: the
          // table has a check constraint for it. Refused loudly rather than
          // guessed at.
          this.logger.error('an entitlement order has no account', { orderId, paymentId });
          return 'no_subject';
        }

        // `greatest(premium_until, now())` and not a bare `now()`: renewing a
        // month early must extend the deadline, not reset it. The obvious
        // version silently deletes whatever time was left, and the person who
        // notices is one who paid twice.
        await client.query(
          `update accounts
              set premium_until = greatest(coalesce(premium_until, now()), now())
                                  + make_interval(days => $2)
            where id = $1`,
          [order.accountId, product.grantDays],
        );

        return 'fulfilled';
      });
    } catch (err) {
      this.logger.error('could not fulfil a captured payment', {
        orderId,
        paymentId,
        ...dbErrorFields(err),
      });
      return 'error';
    }
  }

  /**
   * Record a refund and take back what it paid for.
   *
   * Symmetric with the grant: the same number of days is subtracted, floored at
   * now, so a refund of a renewal removes the renewal rather than the whole
   * entitlement. Missing this path entirely is the most common way a payment
   * integration ends up giving away a year of product — the money goes back and
   * the deadline stays where it was.
   */
  async recordRefund(
    paymentId: string,
    orderId: string,
    refundedPaise: number,
  ): Promise<FulfilOutcome> {
    try {
      return await this.db.transaction(async (client: PoolClient) => {
        const order = await lockOrder(client, orderId);
        if (order === null) return 'unknown_order';

        const inserted = await client.query(
          `insert into payment_events (payment_id, event, order_id, amount_paise)
           values ($1, 'refunded', $2, $3)
           on conflict (payment_id, event) do nothing`,
          [paymentId, orderId, refundedPaise],
        );
        if (inserted.rowCount === 0) return 'duplicate';

        await client.query(
          `update payment_orders set status = 'refunded' where order_id = $1`,
          [orderId],
        );

        const product = findProduct(order.product);
        if (product === null || product.grantDays === 0 || order.accountId === null) {
          return 'fulfilled';
        }

        await client.query(
          `update accounts
              set premium_until = greatest(now(), coalesce(premium_until, now())
                                                  - make_interval(days => $2))
            where id = $1`,
          [order.accountId, product.grantDays],
        );

        return 'fulfilled';
      });
    } catch (err) {
      this.logger.error('could not record a refund', {
        orderId,
        paymentId,
        ...dbErrorFields(err),
      });
      return 'error';
    }
  }

  /**
   * Mark an order failed. Best effort, and never a reason to retry a webhook:
   * a failed payment grants nothing, so losing the status update costs only a
   * row that stays `created` and expires.
   */
  async recordFailure(paymentId: string, orderId: string, amountPaise: number): Promise<void> {
    try {
      await this.db.transaction(async (client: PoolClient) => {
        const inserted = await client.query(
          `insert into payment_events (payment_id, event, order_id, amount_paise)
           values ($1, 'failed', $2, $3)
           on conflict (payment_id, event) do nothing`,
          [paymentId, orderId, amountPaise],
        );
        if (inserted.rowCount === 0) return;
        await client.query(
          `update payment_orders set status = 'failed'
            where order_id = $1 and status = 'created'`,
          [orderId],
        );
      });
    } catch (err) {
      this.logger.warn('could not record a failed payment', {
        orderId,
        paymentId,
        ...dbErrorFields(err),
      });
    }
  }
}

interface LockedOrder {
  readonly accountId: string | null;
  readonly product: string;
  readonly amountPaise: number;
}

/**
 * Read the order and hold it for the rest of the transaction.
 *
 * `for update` is what makes two concurrent deliveries of the same webhook
 * serialise rather than race. Without it both would find no ledger row, both
 * would insert, one would lose on the primary key — which is still correct, but
 * only because the unique index catches it. Locking makes the correctness
 * explicit instead of incidental.
 */
async function lockOrder(client: PoolClient, orderId: string): Promise<LockedOrder | null> {
  const found = await client.query<{
    account_id: string | null;
    product: string;
    amount_paise: number;
  }>(
    `select account_id, product, amount_paise
       from payment_orders where order_id = $1 for update`,
    [orderId],
  );
  const row = found.rows[0];
  if (row === undefined) return null;
  return {
    accountId: row.account_id,
    product: row.product,
    // `pg` returns int4 as a number; the cast documents the assumption rather
    // than relying on it silently.
    amountPaise: Number(row.amount_paise),
  };
}
