/**
 * The Razorpay checkout, and the only place a third-party script is loaded.
 *
 * ---------------------------------------------------------------------------
 * THE SCRIPT IS LOADED ON DEMAND, NOT FROM `index.html`
 * ---------------------------------------------------------------------------
 * A `<script src="checkout.razorpay.com/...">` in the document head runs on
 * every page view — the landing screen, the chat, the policy pages — for a
 * feature two pages use and almost nobody reaches. That is a third party
 * executing in the origin that renders message content, all day, to serve a
 * button that is currently disabled.
 *
 * Loading it when somebody actually chooses to pay means the privacy claim on
 * every other page stays true without qualification, and the cost is one round
 * trip at the moment a person has already decided to wait for a payment form.
 *
 * ---------------------------------------------------------------------------
 * NOTHING HERE DECIDES A PRICE, AND NOTHING HERE NAMES A BUYER
 * ---------------------------------------------------------------------------
 * The request carries a product key and, for a donation, an amount. It does not
 * carry an account id: the server resolves that from the bearer credential in
 * the `Authorization` header. A field naming the beneficiary would be the same
 * mistake as a client frame naming its own session (protocol rule 3), and no
 * amount of it being "only the frontend" changes what the server would then be
 * trusting.
 *
 * ---------------------------------------------------------------------------
 * NO `alert()`
 * ---------------------------------------------------------------------------
 * A browser modal blocks the event loop and, on this origin, would sit on top
 * of a live conversation. Every path returns a result the caller renders in the
 * page, which is also the only way the copy stays reviewable.
 */

/*
 * Imported here rather than `@import`-ed from `index.css`, for two reasons.
 * There is no `postcss-import` in this build and a CSS `@import` must precede
 * every rule in the file — appended at the bottom, as the prototype had it, the
 * browser ignores it entirely and the styling silently does nothing. And this
 * way the stylesheet travels with the only module that can make it matter.
 */
import './razorpay-override.css';

const CHECKOUT_SRC = 'https://checkout.razorpay.com/v1/checkout.js';

/** Beyond this, the network is not going to produce a checkout worth waiting for. */
const LOAD_TIMEOUT_MS = 15_000;

export type CheckoutOutcome =
  | { readonly status: 'paid' }
  /** The person closed the checkout. Not an error, and never reported as one. */
  | { readonly status: 'dismissed' }
  | { readonly status: 'failed'; readonly message: string }
  | { readonly status: 'unavailable'; readonly message: string };

interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  handler: () => void;
  modal: { ondismiss: () => void };
  theme: { color: string; backdrop_color: string };
}

interface RazorpayInstance {
  open(): void;
  on(event: string, handler: (response: unknown) => void): void;
}

type RazorpayConstructor = new (options: RazorpayOptions) => RazorpayInstance;

function razorpayGlobal(): RazorpayConstructor | null {
  const candidate = (window as unknown as { Razorpay?: unknown }).Razorpay;
  return typeof candidate === 'function' ? (candidate as RazorpayConstructor) : null;
}

/**
 * Load the checkout script once.
 *
 * The promise is cached on success and **cleared on failure**, so a person who
 * lost their connection and tries again gets a fresh attempt rather than the
 * cached rejection of the first one. Getting that backwards means the retry
 * button never works and nothing says why.
 */
let loading: Promise<boolean> | null = null;

export function loadCheckout(): Promise<boolean> {
  if (razorpayGlobal() !== null) return Promise.resolve(true);
  if (loading !== null) return loading;

  loading = new Promise<boolean>((resolve) => {
    const script = document.createElement('script');
    let settled = false;

    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      if (!ok) loading = null;
      resolve(ok);
    };

    // A script tag that never fires either event — a captive portal, a
    // filtering proxy — otherwise leaves the button spinning forever.
    const timer = window.setTimeout(() => settle(false), LOAD_TIMEOUT_MS);

    script.src = CHECKOUT_SRC;
    script.async = true;
    script.onload = () => settle(razorpayGlobal() !== null);
    script.onerror = () => settle(false);
    document.head.appendChild(script);
  });

  return loading;
}

/**
 * Warm the script up without opening anything.
 *
 * Called when a page that can take a payment is shown, so the click itself does
 * not wait on a download. It deliberately does not create an order: the
 * rejected prototype pre-generated one per tier on every page load, which meant
 * two calls to the payment provider and two database rows for every visitor who
 * merely looked at the pricing.
 */
export function preloadCheckout(): void {
  void loadCheckout();
}

export interface CheckoutRequest {
  /** A catalogue key the server knows. Never a price. */
  readonly product: string;
  /** Donations only, in paise. Ignored by the server for fixed products. */
  readonly amountPaise?: number;
  /** The account bearer credential, for anything that grants an entitlement. */
  readonly credential?: string | null;
  /** Shown in the checkout. Developer-authored copy, never user text. */
  readonly description: string;
  readonly themeColor: string;
}

interface CreatedOrder {
  readonly orderId: string;
  readonly amountPaise: number;
  readonly currency: string;
  readonly keyId: string;
}

async function createOrder(request: CheckoutRequest): Promise<CreatedOrder | string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (typeof request.credential === 'string' && request.credential !== '') {
    headers.authorization = `Bearer ${request.credential}`;
  }

  let response: Response;
  try {
    response = await fetch('/api/payments/create-order', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        product: request.product,
        ...(request.amountPaise === undefined ? {} : { amountPaise: request.amountPaise }),
      }),
    });
  } catch {
    return 'We could not reach the payment service. Check your connection and try again.';
  }

  if (!response.ok) {
    // Mapped to copy here rather than showing the server's error key. The codes
    // are for logs; a person needs to know whether to retry, sign in, or wait.
    if (response.status === 401) return 'Sign in first — a subscription belongs to an account.';
    if (response.status === 429) return 'Too many attempts. Try again in a little while.';
    if (response.status === 400) return 'That is not something we can charge for.';
    return 'The payment service is not available right now. Please try again later.';
  }

  try {
    return (await response.json()) as CreatedOrder;
  } catch {
    return 'The payment service returned something we could not read.';
  }
}

/**
 * Open the checkout and resolve when it closes.
 *
 * ---------------------------------------------------------------------------
 * `paid` MEANS THE CHECKOUT SAID SO, NOT THAT ANYTHING WAS GRANTED
 * ---------------------------------------------------------------------------
 * The entitlement is granted by the webhook, server to server, and that can
 * land after this resolves. So the caller shows "payment received, it may take
 * a moment to appear" rather than "you are premium" — the second is a claim
 * this code is in no position to make, and the browser handler is the one part
 * of the flow an attacker fully controls.
 */
export async function openCheckout(request: CheckoutRequest): Promise<CheckoutOutcome> {
  const loaded = await loadCheckout();
  if (!loaded) {
    return {
      status: 'unavailable',
      message: 'The payment form could not load. It may be blocked by an extension or a network.',
    };
  }

  const order = await createOrder(request);
  if (typeof order === 'string') return { status: 'unavailable', message: order };

  const Razorpay = razorpayGlobal();
  if (Razorpay === null) {
    return { status: 'unavailable', message: 'The payment form could not start.' };
  }

  return new Promise<CheckoutOutcome>((resolve) => {
    let settled = false;
    const settle = (outcome: CheckoutOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    const checkout = new Razorpay({
      key: order.keyId,
      amount: order.amountPaise,
      currency: order.currency,
      name: 'karobakbak',
      description: request.description,
      order_id: order.orderId,
      handler: () => settle({ status: 'paid' }),
      modal: { ondismiss: () => settle({ status: 'dismissed' }) },
      theme: { color: request.themeColor, backdrop_color: 'rgba(0, 0, 0, 0.82)' },
    });

    checkout.on('payment.failed', () =>
      // The provider's own description is deliberately not shown. It is written
      // for a developer, it varies by bank, and it is the one string in this
      // flow that arrives from outside and would be rendered to a person.
      settle({ status: 'failed', message: 'The payment did not go through. Nothing was charged.' }),
    );

    checkout.open();
  });
}
