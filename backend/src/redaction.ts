/**
 * The field-name denylist, shared by every path out of the trusted boundary.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ITS OWN MODULE (D52)
 * ---------------------------------------------------------------------------
 * It lived in `logger.ts` and was the only control of its kind, because logs
 * were the only structured thing this process emitted. Tracing adds a second
 * path with the same problem and none of the protection: a span attribute is a
 * key and a value, written by a library, and there is no reason to expect a
 * vendor's instrumentation to know what this system considers content.
 *
 * Two denylists would drift, and the one that drifts is the one nobody is
 * looking at. So the list moved here, unchanged, and both import it. The check
 * that the move was mechanical is that `logger.test.ts` passes untouched.
 *
 * There is deliberately no re-export from `logger.ts`. A module that can reach
 * the list through two names is a module where somebody edits the wrong one.
 */

/**
 * Field names that must never carry a value out of the trusted boundary.
 *
 * Three categories:
 *   - user content shapes: how a chat message, a report note or a raw frame
 *     would most plausibly be named by someone adding a log line in a hurry;
 *   - personal data: client IPs, which are personal data on an anonymous
 *     service and are only ever handled as salted hashes (`ipHash` is allowed);
 *   - credentials: a leaked TOTP secret is worse than a leaked message — the
 *     message is one conversation, the secret is every future login.
 *
 * `msg` is deliberately absent: it is the log line's own label and is always a
 * developer-authored constant.
 *
 * **Case-sensitive, exact match, and that is a documented limit rather than an
 * oversight.** `Password` is no more redacted than `ApiKey`. Making it
 * case-insensitive is a security change and deserves its own decision;
 * `logger.test.ts` documents the limit instead of widening it.
 */
export const FORBIDDEN_FIELDS = new Set([
  // chat / report content
  'text',
  'body',
  'content',
  'message',
  'messages',
  'note',
  'notes',
  'payload',
  'frame',
  'raw',
  'rawFrame',
  'input',
  'value',
  'excerpt',
  'preview',
  'snippet',
  'sample',
  'transcript',
  'conversation',
  // personal data (hashed forms such as ipHash / clientHash are allowed)
  'ip',
  'ipAddress',
  'remoteAddress',
  'remoteAddr',
  'clientIp',
  'userAgent',
  // credentials (phase 13). Until the moderation console there was nothing in
  // this process worth stealing from a log line — no password, no shared
  // secret, no bearer value. There is now, and a leaked TOTP secret is worse
  // than a leaked message: the message is one conversation, the secret is
  // every future login. `clientToken` stays absent on purpose, because it is
  // already only ever handled as `clientHash`.
  'password',
  'passwordHash',
  'secret',
  'totpSecret',
  'otp',
  'code',
  'token',
  'sessionToken',
  'credential',
  'authorization',
  'cookie',
  // The model provider's key (A4). Not user content, but a leaked one is
  // somebody else's bill and the whole persona budget stops meaning anything —
  // the same class of harm as `secret`, so it belongs on the same list rather
  // than relying on nobody ever putting a config object in a log line.
  'apiKey',
  'api_key',
  // The moderator's own words on an enforcement action. Not user content, but
  // it is free text typed while reading a conversation, so the most natural
  // thing to write in it is a quote from the conversation (I8).
  'justification',
]);

/** Exposed for tests that assert the denylist covers a given field name. */
export function isForbiddenField(name: string): boolean {
  return FORBIDDEN_FIELDS.has(name);
}

/**
 * Span attributes that carry content on **this** system, whatever they carry
 * elsewhere (D53).
 *
 * These are OpenTelemetry semantic-convention keys. None of them looks like a
 * content field, and every one of them is one here:
 *
 *  * `db.statement` — the instrumented query. On this system that is
 *    `insert into messages (conversation_id, body, ...)`, so a stock
 *    `pg` instrumentation ships every retained message body to a tracing
 *    backend. It is switched off at the instrumentation as well; this entry is
 *    the second control, because the first one is a setting somebody can
 *    re-enable while looking for detail during an incident.
 *  * `http.url`, `url.full`, `http.target`, `url.query` — the request line
 *    *including the query string*. `/auth/callback?code=...&state=...` is
 *    proxied through this origin, so these carry an OIDC authorization code —
 *    exactly the leak F-036 found in nginx's access log, arriving a second time
 *    through a different pipe.
 *  * `db.query.parameter` — parameterised values, which for the retention path
 *    are the message rows themselves.
 *  * header captures — opt-in in the instrumentation and off, but a key prefix
 *    is cheaper to deny than to police.
 */
export const FORBIDDEN_ATTRIBUTE_KEYS = new Set([
  'db.statement',
  'db.query.text',
  'http.url',
  'url.full',
  'url.query',
  'http.target',
  'http.request.body',
  'http.response.body',
]);

/** Key prefixes that are denied along with everything beneath them. */
export const FORBIDDEN_ATTRIBUTE_PREFIXES = [
  'db.query.parameter',
  'http.request.header',
  'http.response.header',
];

/**
 * Whether a span attribute key may carry a value.
 *
 * Checks three things, and the middle one is the reason this is not just
 * `FORBIDDEN_FIELDS.has(key)`:
 *
 *  1. the exact key, against the span-specific list above;
 *  2. a prefix match, for the families that are unbounded (`http.request.header.*`);
 *  3. **every dotted segment** against the shared field denylist, so
 *     `chat.message.body`, `frame`, and `persona.transcript` are all caught
 *     without anybody having to predict the namespace somebody will invent.
 *
 * Segment-wise rather than whole-key, because span attributes are a flat map of
 * dotted keys while the logger walks a nested object — the same names arrive in
 * a different shape, and a check written for one does not catch the other.
 */
export function isForbiddenAttributeKey(key: string): boolean {
  if (FORBIDDEN_ATTRIBUTE_KEYS.has(key)) return true;
  for (const prefix of FORBIDDEN_ATTRIBUTE_PREFIXES) {
    if (key === prefix || key.startsWith(`${prefix}.`)) return true;
  }
  for (const segment of key.split('.')) {
    if (FORBIDDEN_FIELDS.has(segment)) return true;
  }
  return false;
}
