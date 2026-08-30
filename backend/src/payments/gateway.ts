/**
 * The Razorpay adapter.
 *
 * **The only file in this repository that imports the `razorpay` SDK.** Same
 * rule as the model providers (D-AI-10), for the same reason: a vendor SDK
 * scattered across a codebase is a vendor that cannot be changed, and this one
 * lives inside the process that owns every WebSocket file descriptor.
 *
 * ---------------------------------------------------------------------------
 * WHY THE IMPORT IS LAZY
 * ---------------------------------------------------------------------------
 * `PAYMENTS_ENABLED` is false and the default configuration has no keys, so the
 * overwhelmingly common case is a process that will never create an order. A
 * top-level import would still load the SDK and its transitive dependencies
 * into the chat process at boot — more code in the address space that owns the
 * sockets, for a feature that is off.
 *
 * `require` inside the constructor means an unconfigured deployment never
 * touches it, and a configured one pays the cost once at startup rather than on
 * the first request. It is `require` rather than a dynamic `import()` because
 * this package compiles to CommonJS (`module: node16`), where `import()` of a
 * CommonJS dependency is the awkward path and buys nothing here.
 *
 * ---------------------------------------------------------------------------
 * NOTHING INBOUND COMES THROUGH HERE
 * ---------------------------------------------------------------------------
 * Webhook verification is in `signature.ts` and uses `node:crypto` only. The
 * SDK is reached on the outbound path exclusively, so a request from the
 * network never enters vendor code before it has been authenticated.
 */
import type { Logger } from '../logger';
import { errorFields } from '../logger';

export interface CreateOrderRequest {
  readonly amountPaise: number;
  readonly currency: string;
  /** Ours, opaque, and never derived from anything a client sent. */
  readonly receipt: string;
}

export interface CreatedOrder {
  readonly orderId: string;
  readonly amountPaise: number;
  readonly currency: string;
}

export interface PaymentGateway {
  createOrder(request: CreateOrderRequest): Promise<CreatedOrder | null>;
}

export interface RazorpayGatewayOptions {
  readonly keyId: string;
  readonly keySecret: string;
}

/**
 * Shape of the vendor client, narrowed to what is called.
 *
 * Declared here rather than imported so the type-check does not require the
 * dependency to be installed — the package is optional in a build that never
 * turns payments on, and a hard type import would make it mandatory.
 */
interface RazorpayClient {
  orders: {
    create(options: {
      amount: number;
      currency: string;
      receipt: string;
    }): Promise<{ id?: unknown; amount?: unknown; currency?: unknown }>;
  };
}

export class RazorpayGateway implements PaymentGateway {
  private readonly client: RazorpayClient;

  constructor(
    options: RazorpayGatewayOptions,
    private readonly logger: Logger,
  ) {
    type RazorpayCtor = new (o: { key_id: string; key_secret: string }) => RazorpayClient;
    let Razorpay: RazorpayCtor;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      Razorpay = require('razorpay') as RazorpayCtor;
    } catch {
      // A bare MODULE_NOT_FOUND here is genuinely confusing: `assertCoherent`
      // has already passed, the credentials are all present, and the process
      // dies at the last step of startup for a reason that names a file rather
      // than a cause. The dependency is lazy precisely so a payments-off
      // process never needs it, and the cost of that is this message.
      throw new Error(
        'PAYMENTS_ENABLED is set but the `razorpay` package is not installed. ' +
          'It is loaded lazily so a deployment with payments off never needs it — ' +
          'run npm install in backend/.',
      );
    }
    this.client = new Razorpay({ key_id: options.keyId, key_secret: options.keySecret });
  }

  /**
   * Ask Razorpay for an order id.
   *
   * Returns null on any failure rather than throwing, because the caller turns
   * that into a 503 and there is nothing a stack trace at the route would add.
   * The reply is validated rather than trusted: a vendor response that is
   * missing an id, or that came back with an amount other than the one asked
   * for, is treated as a failure. The second check is the one that matters —
   * an order created for a different amount than the row we are about to write
   * would make the webhook amount check compare against the wrong number.
   */
  async createOrder(request: CreateOrderRequest): Promise<CreatedOrder | null> {
    try {
      const order = await this.client.orders.create({
        amount: request.amountPaise,
        currency: request.currency,
        receipt: request.receipt,
      });

      const orderId = order.id;
      if (typeof orderId !== 'string' || orderId === '') {
        this.logger.error('payment gateway returned an order without an id');
        return null;
      }
      if (order.amount !== request.amountPaise) {
        this.logger.error('payment gateway returned an order for a different amount', {
          requestedPaise: request.amountPaise,
        });
        return null;
      }

      return {
        orderId,
        amountPaise: request.amountPaise,
        currency: typeof order.currency === 'string' ? order.currency : request.currency,
      };
    } catch (err) {
      // `errorFields` and not the raw error: an SDK failure carries the request
      // it was making, and the receipt in that request contains an account id.
      this.logger.error('payment gateway rejected an order', errorFields(err));
      return null;
    }
  }
}
