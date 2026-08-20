/**
 * What the server thinks a bot *is*.
 *
 * ---------------------------------------------------------------------------
 * THE ADDRESS
 * ---------------------------------------------------------------------------
 * Every bot in a run shares one host, and therefore one source address. That
 * is fatal for this product's block model, not merely unrealistic: a block
 * records `SADD chat:blocks:{blockerIpHash} {blockedIpHash}`, so the first
 * block issued by any bot writes one address into its own block set, and
 * `tryMatch`'s `isBlocked` then refuses **every pair in the swarm**. The run
 * does not error; it goes quiet, which takes far longer to notice.
 *
 * The fix is to give each bot its own address the same way a real deployment
 * does — through `X-Forwarded-For` — and to make the server trust exactly the
 * hop that produces it. The loadtest stack runs `TRUST_PROXY_HOPS=2`: nginx
 * appends the generator's real address on the right, `clientAddress()` counts
 * from the right, and the entry the bot chose is selected.
 *
 * This is a load-generator affordance in the same class as the raised per-IP
 * limits that were already there, and it lives only in `.env.loadtest`.
 * Production trusts one hop and reads the address nginx saw.
 *
 * Addresses come from 198.18.0.0/15 — the IETF benchmarking range (RFC 2544),
 * which exists for exactly this and is not routable anywhere real.
 *
 * ---------------------------------------------------------------------------
 * THE COOKIE
 * ---------------------------------------------------------------------------
 * The server mints a block token in a `Set-Cookie` on the upgrade response and
 * that token is the *second* block dimension. A bot that drops it on reconnect
 * is a different person to the server, which would quietly delete every
 * scenario about a block outlasting a session. So a bot captures its token
 * once and sends it back for the rest of its life.
 */

/** The cookie the server mints. Matches `CLIENT_TOKEN_COOKIE` in the backend. */
export const CLIENT_TOKEN_COOKIE = 'kbb_ct';

/**
 * A stable synthetic address for one bot.
 *
 * Derived from the index rather than drawn randomly, so a bot keeps its address
 * across reconnects and across runs with the same seed — which is what makes
 * "this blocked party came back" a testable statement.
 */
export function syntheticAddress(botIndex: number): string {
  // 198.18.0.0/15 is 131,072 addresses: two /16s, ample for any run this
  // harness can generate from one host.
  const offset = botIndex % 131072;
  const second = 18 + Math.floor(offset / 65536);
  const third = Math.floor((offset % 65536) / 256);
  const fourth = offset % 256;
  return `198.${second}.${third}.${fourth}`;
}

/**
 * Bots that must *share* an address, for the scenarios that exist to trip the
 * per-IP controls (L7's herd, the connection-rate personas).
 */
export function sharedAddress(group: number): string {
  return `198.19.255.${group % 256}`;
}

/** Read the block token out of the upgrade response's `Set-Cookie` headers. */
export function readClientToken(setCookie: string[] | undefined): string | null {
  if (!setCookie) return null;
  for (const header of setCookie) {
    const first = header.split(';', 1)[0] ?? '';
    const separator = first.indexOf('=');
    if (separator === -1) continue;
    if (first.slice(0, separator).trim() !== CLIENT_TOKEN_COOKIE) continue;
    const value = first.slice(separator + 1).trim();
    if (value.length > 0) return value;
  }
  return null;
}
