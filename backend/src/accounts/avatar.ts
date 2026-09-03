/**
 * Serve the sign-in provider's profile image from this origin.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER FETCHES IT AND THE BROWSER NEVER DOES
 * ---------------------------------------------------------------------------
 * The claim is a URL on the provider's CDN. Rendering an `<img>` at it would be
 * blocked outright — `img-src` is `'self' data:` plus the payment provider —
 * and widening the policy is the smaller half of the objection. The larger half
 * is that such an image reports every visitor's IP and referring page to the
 * vendor on every render, for a signed-in user, on every page they open, with
 * no click and no consent. The Privacy Policy says the browser makes no
 * third-party requests, and it should keep being true.
 *
 * So this runs once, on the server, on a request where the person was signing
 * in to that provider anyway — a request the provider already knows about.
 *
 * ---------------------------------------------------------------------------
 * NOTHING STORES THE IMAGE
 * ---------------------------------------------------------------------------
 * Not PostgreSQL: an avatar describes a person, so a durable column would put a
 * row in the Privacy Policy's data table and give the account its first field
 * about *who* somebody is — for a picture nobody but its owner ever sees.
 *
 * Not Redis either. Ten kilobytes per signed-in account is a different class of
 * value from everything else on that instance, which holds ids and counters,
 * and it is the same Redis every matchmaking transition runs a Lua script
 * against. What is cached there is the **URL** — 120 bytes, the same size as
 * the tokens already beside it — under the session's own TTL.
 *
 * The bytes are streamed through this origin on demand and cached by the
 * browser for a day, so the steady state is one request per person per day,
 * made by this server rather than by them.
 *
 * Redis has persistence off (D12), so a restart drops the URL and the next
 * sign-in refills it. Acceptable precisely because the absence is already an
 * ordinary state, handled everywhere.
 *
 * It is account-scoped and never part of the declared `Profile`, so no chat
 * partner and no matchmaking path can reach it. Putting a face in front of
 * strangers on a service with no age assurance is a different decision, and one
 * that would need `minor-safety-policy.md` revisited before any code.
 *
 * ---------------------------------------------------------------------------
 * A URL FROM OUTSIDE, USED TO MAKE A REQUEST — SO IT IS PINNED
 * ---------------------------------------------------------------------------
 * `picture` arrives inside a token. The token is signed and verified, so this
 * is not attacker-controlled in the ordinary sense; but "a URL we were handed,
 * which we then fetch" is the shape of every server-side request forgery, and a
 * misconfigured or compromised IdP is exactly the case worth being boring
 * about. Every one of these is enforced below rather than assumed:
 *
 *   * **https only**, checked again here and not merely at the claim.
 *   * **an allowlisted host**, so the fetch cannot be aimed at link-local
 *     metadata, a private range, or anything else this network can reach.
 *   * **no redirects followed** — an allowlisted host that answers 302 to
 *     somewhere else would otherwise walk straight past the allowlist.
 *   * **a short timeout**, so a hanging CDN cannot hold a sign-in open.
 *   * **a declared image content type**, and a **size ceiling** enforced on the
 *     bytes actually read rather than on the `Content-Length` header, which the
 *     sender chooses.
 *
 * Every failure answers null. An avatar is decoration: a provider that returns
 * none, an image too large to accept, and a CDN that timed out are all the same
 * to every reader, and none of them may cost somebody their sign-in.
 */
import type { Logger } from '../logger';

/**
 * Hosts whose images may be fetched.
 *
 * Suffix-matched against the parsed hostname with a leading dot, so
 * `evil-googleusercontent.com` does not match and `lh3.googleusercontent.com`
 * does. Adding a provider means adding its CDN here deliberately — which is the
 * point, because the alternative is a fetch aimed wherever a token says.
 */
const ALLOWED_IMAGE_HOSTS = ['.googleusercontent.com', '.gravatar.com'] as const;

/**
 * What the caller decides.
 *
 * Passed rather than read from a module constant so a deployment can move them
 * (`AVATAR_MAX_BYTES`, `AVATAR_FETCH_TIMEOUT_MS`) and so a test can describe a
 * tiny ceiling without a 128 KB fixture. The defaults live in `config.ts`,
 * which is the one place a default belongs.
 */
export interface AvatarLimits {
  /** A ceiling on what this origin will relay. Generous for a 96px avatar. */
  readonly maxBytes: number;
  /** A sign-in is a person waiting. A slow CDN must not become a slow sign-in. */
  readonly timeoutMs: number;
}

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

/** True when this host is one we are willing to make a request to. */
export function isAllowedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return ALLOWED_IMAGE_HOSTS.some((suffix) => host.endsWith(suffix));
}

/** An image this origin is willing to relay. */
export interface FetchedImage {
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * The image at `url`, or null for every failure.
 *
 * Exported for its own tests; the `/auth/avatar` route is the only caller in
 * production.
 */
export async function fetchAvatar(
  url: string,
  logger: Logger,
  limits: AvatarLimits,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchedImage | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'https:') return null;
  if (!isAllowedImageHost(parsed.hostname)) {
    // Worth a line: it means the provider changed where it hosts images, and
    // the symptom otherwise is avatars quietly disappearing for new sign-ins.
    // The host is provider infrastructure, not user content — it is not an I8
    // field and carries nothing about who signed in.
    logger.warn('avatar host is not allowlisted', { host: parsed.hostname });
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);

  try {
    const response = await fetchImpl(parsed.toString(), {
      // An allowlisted host that redirects elsewhere would otherwise step
      // around the allowlist entirely.
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type === undefined || !ALLOWED_TYPES.includes(type as (typeof ALLOWED_TYPES)[number])) {
      return null;
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    // Checked on what arrived, not on `Content-Length` — the sender writes that
    // header and a lying one is the whole trick.
    if (bytes.byteLength === 0 || bytes.byteLength > limits.maxBytes) return null;

    return { contentType: type, body: Buffer.from(bytes) };
  } catch {
    // Timeout, abort, refused redirect, DNS, TLS. All the same to the caller.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
