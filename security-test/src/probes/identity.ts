/**
 * Can a visitor choose which rate-limit bucket they land in?
 *
 * ---------------------------------------------------------------------------
 * THE HIGHEST-VALUE TARGET IN THIS SYSTEM
 * ---------------------------------------------------------------------------
 * `clientAddress()` counts `TRUST_PROXY_HOPS` entries from the right of
 * `X-Forwarded-For`. Every rate limit, every per-IP connection cap and half of
 * every block key is derived from what it returns. If the configured hop count
 * is **lower** than the number of proxies actually in front, the entry it reads
 * is one the *client* wrote — and then a visitor picks their own bucket, sheds
 * their blocks with a header, and nothing anywhere reports a problem.
 *
 * `upgrade.test.ts` already proves the counting is correct at every hop count.
 * What it cannot prove is that the configured count matches the deployed chain,
 * because that is a fact about topology rather than about code. This measures
 * it against the stack that is actually running.
 *
 * ---------------------------------------------------------------------------
 * HOW IT IS MEASURED
 * ---------------------------------------------------------------------------
 * Through `MAX_CONNECTIONS_PER_IP`, which is the cheapest observable that is
 * keyed on the derived address. Two questions, asked by counting refusals:
 *
 *  1. Do many sockets sharing **one** forged address share a bucket? If the
 *     forged value is being read, they do, and the cap refuses the surplus.
 *  2. Do many sockets with **distinct** forged addresses avoid the cap?
 *
 * Both yes means the header is trusted: whoever sends it is choosing their own
 * identity. Whether that is correct depends on whether a proxy in front
 * overwrites it — which is exactly the judgement this cannot make and the
 * operator can.
 */
import { WebSocket } from 'ws';

import { fail, info, pass, syntheticAddress, type Context, type Probe, type Result } from '../probe';

interface Attempt {
  readonly socket: WebSocket;
  readonly outcome: Promise<'open' | 'refused' | 'error'>;
}

function attempt(ctx: Context, forwardedFor: string): Attempt {
  const socket = new WebSocket(ctx.wsUrl, ['kbb.v1'], {
    headers: { 'X-Forwarded-For': forwardedFor, Origin: ctx.origin },
    handshakeTimeout: 8000,
  });
  const outcome = new Promise<'open' | 'refused' | 'error'>((resolve) => {
    let settled = false;
    const done = (v: 'open' | 'refused' | 'error'): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    socket.on('open', () => done('open'));
    socket.on('unexpected-response', () => done('refused'));
    socket.on('error', () => done('error'));
    setTimeout(() => done('error'), 9000);
  });
  return { socket, outcome };
}

async function openMany(
  ctx: Context,
  count: number,
  addressFor: (i: number) => string,
): Promise<{ open: number; refused: number; close: () => void }> {
  const attempts: Attempt[] = [];
  for (let i = 0; i < count; i += 1) attempts.push(attempt(ctx, addressFor(i)));

  const outcomes = await Promise.all(attempts.map((a) => a.outcome));
  const close = (): void => {
    for (const a of attempts) {
      try {
        a.socket.close();
      } catch {
        /* already gone */
      }
    }
  };
  return {
    open: outcomes.filter((o) => o === 'open').length,
    refused: outcomes.filter((o) => o !== 'open').length,
    close,
  };
}

/**
 * Deliberately above any sane `MAX_CONNECTIONS_PER_IP`, so the shared-bucket
 * case is refused whatever the cap is set to. The load stack's is 40.
 */
const BURST = 60;

export const forwardedForTrust: Probe = {
  id: 'IDENT-1',
  name: 'X-Forwarded-For decides the rate-limit bucket',
  proves:
    'Whether a visitor can choose their own rate-limit and block identity by sending a header. ' +
    'Correct only if a proxy in front overwrites it — see TRUST_PROXY_HOPS.',
  async run(ctx): Promise<Result> {
    const shared = await openMany(ctx, BURST, () => syntheticAddress(7));
    shared.close();
    // Let the per-IP registry drain before the second half, or the first half's
    // sockets are still counted against it.
    await new Promise((r) => setTimeout(r, 1500));

    const distinct = await openMany(ctx, BURST, (i) => syntheticAddress(1000 + i));
    distinct.close();

    const notes = [
      `one forged address x${BURST}: ${shared.open} opened, ${shared.refused} refused`,
      `distinct forged addresses x${BURST}: ${distinct.open} opened, ${distinct.refused} refused`,
    ];

    // The unambiguous failure: sharing an address costs nothing AND distinct
    // addresses cost nothing. Then the cap is not keyed on anything the header
    // influences and is also not doing its job.
    if (shared.refused === 0 && distinct.refused === 0) {
      return fail(
        'the per-IP connection cap refused nothing in either arrangement',
        [...notes, 'MAX_CONNECTIONS_PER_IP appears not to be enforced at all'],
      );
    }

    if (shared.refused > 0 && distinct.refused === 0) {
      return info(
        'the forged header is trusted: sockets sharing it share a bucket, distinct ones do not',
        [
          ...notes,
          'This is CORRECT when a proxy in front overwrites X-Forwarded-For and',
          'TRUST_PROXY_HOPS matches the real chain length. It is a serious hole when it',
          'does not: every visitor picks their own bucket and sheds their blocks.',
          'Count the proxies in front of the backend and compare to TRUST_PROXY_HOPS.',
        ],
      );
    }

    if (shared.refused > 0 && distinct.refused > 0) {
      return pass('the forged header did not buy a fresh bucket', notes);
    }

    return info('inconclusive', notes);
  },
};

/**
 * The origin allowlist matches scheme, host and port exactly.
 *
 * Worth a probe rather than only a unit test because the failure is invisible
 * from outside: the upgrade returns 403, the client retries as it would after
 * any dropped connection, and the UI sits on "connecting" — identical to a
 * server that is down. Swarm handoff trap 20.
 */
export const originExactness: Probe = {
  id: 'IDENT-2',
  name: 'the origin allowlist matches scheme, host and port exactly',
  proves: 'A page served from another origin cannot open a socket against this backend.',
  async run(ctx): Promise<Result> {
    const hostile = ['http://evil.example', 'https://localhost:8090', 'http://localhost:9999'];
    const refused: string[] = [];
    const allowed: string[] = [];

    for (const origin of hostile) {
      const outcome = await new Promise<'open' | 'refused'>((resolve) => {
        let settled = false;
        const done = (v: 'open' | 'refused'): void => {
          if (!settled) {
            settled = true;
            resolve(v);
          }
        };
        const socket = new WebSocket(ctx.wsUrl, ['kbb.v1'], {
          headers: { Origin: origin, 'X-Forwarded-For': syntheticAddress(99) },
          handshakeTimeout: 8000,
        });
        socket.on('open', () => {
          socket.close();
          done('open');
        });
        socket.on('unexpected-response', () => done('refused'));
        socket.on('error', () => done('refused'));
        setTimeout(() => done('refused'), 9000);
      });
      if (outcome === 'open') allowed.push(origin);
      else refused.push(origin);
    }

    if (allowed.length > 0) {
      return fail(`accepted ${allowed.length} origin(s) that are not on the allowlist`, allowed);
    }
    return pass(`refused all ${refused.length} off-allowlist origins`, refused);
  },
};
