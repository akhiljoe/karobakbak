/**
 * The OIDC seam — the only file that talks to the identity provider (§32, D48).
 *
 * ---------------------------------------------------------------------------
 * NO SDK, AND NO JWT LIBRARY EITHER
 * ---------------------------------------------------------------------------
 * The whole of what is needed is: build an authorize URL, POST a form to the
 * token endpoint, and verify an RS256 signature against a published JWK. Node
 * has done the last of those natively since 16 — `createPublicKey` accepts a
 * JWK directly — so a JWT library would add a dependency, a transitive tree and
 * a CVE feed to save about forty lines.
 *
 * That is a real trade and it cuts both ways: hand-written token validation is
 * exactly where authentication bugs live. What makes it acceptable here is that
 * the checks are enumerable and every one of them is tested for its **failing**
 * case, which is the half that matters. A validator nobody has watched reject a
 * bad token is a validator nobody knows is running.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS CHECKED, AND WHY EACH ONE
 * ---------------------------------------------------------------------------
 *   alg      RS256 only. `none` is the original JWT vulnerability and an
 *            attacker-chosen algorithm is the second: accepting HS256 would let
 *            somebody sign a token with the *public* key, which is public.
 *   kid      Must name a key in the live JWKS. Rotation is normal, so an
 *            unknown kid refetches once rather than failing.
 *   sig      Over the exact `header.payload` bytes as received, never a
 *            re-encoding — canonicalising first is how signatures get bypassed.
 *   iss      Must equal the configured issuer. This is what stops a token from
 *            a different user pool, which is otherwise perfectly valid.
 *   aud      Must equal our client id. A token minted for another client of the
 *            same pool is also perfectly valid, and is not for us.
 *   exp/iat  With a small skew allowance in one direction only.
 *   nonce    Must equal the one this server generated for this flow. Without it
 *            a token captured from any other sign-in can be replayed here.
 *
 * `sub` is read only after all of that passes.
 */
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';

import type { Config } from '../config';
import { errorFields, type Logger } from '../logger';

/** Never interpolated with token material — see the I8 rule on `errMsg`. */
export class TokenError extends Error {}

const BAD_JWT = 'id token is not a well-formed JWT';
const BAD_ALG = 'id token algorithm is not RS256';
const BAD_KID = 'id token names an unknown signing key';
const BAD_SIG = 'id token signature did not verify';
const BAD_ISS = 'id token issuer does not match the configured provider';
const BAD_AUD = 'id token audience is not this client';
const BAD_EXP = 'id token has expired';
const BAD_IAT = 'id token is issued in the future';
const BAD_NONCE = 'id token nonce does not match this sign-in';
const BAD_SUB = 'id token carries no subject';

/** Tolerance for clock drift between this host and the provider. */
const SKEW_SECONDS = 60;

export interface StartedFlow {
  readonly authorizeUrl: string;
  readonly state: string;
  readonly nonce: string;
  readonly codeVerifier: string;
}

export interface VerifiedIdentity {
  /** The OIDC `sub`. Opaque, stable, and never shown to anybody. */
  readonly subject: string;
  /**
   * The verified email, or null.
   *
   * Read but deliberately **not stored** by the caller. The account holds an
   * `external_id` and nothing describing a person, which keeps the Privacy
   * Policy's new data row a single line. It is here because the claim exists
   * and pretending otherwise in the type would be a lie about what crossed the
   * wire.
   */
  readonly email: string | null;
}

export interface OidcClient {
  start(): StartedFlow;
  exchange(code: string, codeVerifier: string, nonce: string): Promise<VerifiedIdentity>;
}

/** base64url without padding, which is what JOSE uses throughout. */
function b64url(input: Buffer): string {
  return input.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export function createOidcClient(config: Config, logger: Logger): OidcClient {
  const auth = config.auth;

  /**
   * Cached signing keys.
   *
   * Refetched when a token names a kid that is not held, and at most once per
   * `JWKS_MIN_REFETCH_MS` — so a stream of tokens with forged kids cannot turn
   * a sign-in endpoint into a request amplifier pointed at the provider.
   */
  let keys: Jwk[] = [];
  let lastFetch = 0;
  const JWKS_MIN_REFETCH_MS = 60_000;

  async function loadKeys(force: boolean): Promise<void> {
    const now = Date.now();
    if (!force && keys.length > 0) return;
    if (force && now - lastFetch < JWKS_MIN_REFETCH_MS) return;
    lastFetch = now;

    const response = await fetch(auth.jwksUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new TokenError('could not fetch the provider signing keys');
    const body = (await response.json()) as { keys?: Jwk[] };
    keys = Array.isArray(body.keys) ? body.keys : [];
  }

  async function keyFor(kid: string): Promise<Jwk> {
    await loadKeys(false);
    let found = keys.find((key) => key.kid === kid);
    if (!found) {
      // Rotation is routine, so an unknown kid is a refetch rather than a
      // failure. Rate-limited above so it cannot be used as an amplifier.
      await loadKeys(true);
      found = keys.find((key) => key.kid === kid);
    }
    if (!found) throw new TokenError(BAD_KID);
    return found;
  }

  function verifySignature(key: Jwk, signingInput: string, signature: Buffer): boolean {
    if (key.kty !== 'RSA' || typeof key.n !== 'string' || typeof key.e !== 'string') return false;
    const publicKey = createPublicKey({
      key: { kty: 'RSA', n: key.n, e: key.e },
      format: 'jwk',
    });
    const verifier = createVerify('RSA-SHA256');
    verifier.update(signingInput);
    verifier.end();
    return verifier.verify(publicKey, signature);
  }

  async function verifyIdToken(token: string, nonce: string): Promise<VerifiedIdentity> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError(BAD_JWT);
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];

    let header: { alg?: unknown; kid?: unknown };
    let claims: Record<string, unknown>;
    try {
      header = JSON.parse(fromB64url(rawHeader).toString('utf8')) as typeof header;
      claims = JSON.parse(fromB64url(rawPayload).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new TokenError(BAD_JWT);
    }

    // Before anything else. An attacker-chosen algorithm is the second-oldest
    // JWT vulnerability, and `none` is the oldest.
    if (header.alg !== 'RS256') throw new TokenError(BAD_ALG);
    if (typeof header.kid !== 'string') throw new TokenError(BAD_KID);

    const key = await keyFor(header.kid);
    // The exact bytes as received. Re-encoding the header or payload before
    // verifying is how signature checks get bypassed.
    const signingInput = `${rawHeader}.${rawPayload}`;
    if (!verifySignature(key, signingInput, fromB64url(rawSignature))) {
      throw new TokenError(BAD_SIG);
    }

    if (claims.iss !== auth.issuer) throw new TokenError(BAD_ISS);

    // `aud` is a string or an array of them, per the spec.
    const audience = claims.aud;
    const audienceOk = Array.isArray(audience)
      ? audience.includes(auth.clientId)
      : audience === auth.clientId;
    if (!audienceOk) throw new TokenError(BAD_AUD);

    const now = Math.floor(Date.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + SKEW_SECONDS < now) {
      throw new TokenError(BAD_EXP);
    }
    if (typeof claims.iat === 'number' && claims.iat - SKEW_SECONDS > now) {
      throw new TokenError(BAD_IAT);
    }

    // The replay check. Without it a token captured from any other sign-in
    // against this pool and client is accepted here.
    if (claims.nonce !== nonce) throw new TokenError(BAD_NONCE);

    if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new TokenError(BAD_SUB);

    const emailVerified = claims.email_verified;
    const email =
      typeof claims.email === 'string' && (emailVerified === true || emailVerified === 'true')
        ? claims.email
        : null;

    return { subject: claims.sub, email };
  }

  return {
    /**
     * Begin a sign-in.
     *
     * `state`, `nonce` and the PKCE verifier are all 256 bits of
     * `randomBytes` — the same reasoning as the resume token, and the reason
     * none of them needs a salt when hashed.
     *
     * The verifier never leaves this server: only its S256 challenge goes to
     * the provider, and the verifier itself rides an httpOnly cookie back to
     * the callback.
     */
    start(): StartedFlow {
      const state = b64url(randomBytes(32));
      const nonce = b64url(randomBytes(32));
      const codeVerifier = b64url(randomBytes(32));
      const challenge = b64url(createHash('sha256').update(codeVerifier).digest());

      const url = new URL(auth.authorizeUrl);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('client_id', auth.clientId);
      url.searchParams.set('redirect_uri', auth.redirectUri);
      // Email is the only claim asked for, and it is asked for so the provider
      // can verify it — not so this service can keep it. Every extra scope
      // becomes a row in the Privacy Policy's data table with its own retention
      // period, on a service whose central claim is that it holds nothing.
      url.searchParams.set('scope', 'openid email');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      url.searchParams.set('code_challenge', challenge);
      url.searchParams.set('code_challenge_method', 'S256');

      return { authorizeUrl: url.toString(), state, nonce, codeVerifier };
    },

    /**
     * Exchange the code and verify what comes back.
     *
     * A confidential client authenticates with HTTP Basic, which is what the
     * spec prefers over form parameters — a secret in a form body is a secret
     * in more logs.
     */
    async exchange(code: string, codeVerifier: string, nonce: string): Promise<VerifiedIdentity> {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: auth.clientId,
        code,
        redirect_uri: auth.redirectUri,
        code_verifier: codeVerifier,
      });

      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
      };
      if (auth.clientSecret !== '') {
        const basic = Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64');
        headers.authorization = `Basic ${basic}`;
      }

      let response: Response;
      try {
        response = await fetch(auth.tokenUrl, {
          method: 'POST',
          headers,
          body: body.toString(),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        // The provider being unreachable must not read as a rejected sign-in.
        logger.warn('token endpoint unreachable', errorFields(err));
        throw new TokenError('the identity provider could not be reached');
      }

      if (!response.ok) {
        // The body can carry the code itself back in an error description, so
        // it is never logged. The status is enough to tell a misconfiguration
        // from a refusal.
        logger.warn('token exchange refused', { status: response.status });
        throw new TokenError('the identity provider refused the sign-in');
      }

      const payload = (await response.json()) as { id_token?: unknown };
      if (typeof payload.id_token !== 'string') {
        throw new TokenError('the identity provider returned no id token');
      }
      return verifyIdToken(payload.id_token, nonce);
    },
  };
}
