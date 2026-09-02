/**
 * The tracing pipeline's I8 control.
 *
 * There is no application-level message encryption (D15), so the observability
 * pipeline is the most likely path for content to leave the trusted boundary.
 * `logger.test.ts` has asserted that for logs since the beginning. This is the
 * same assertion for the path phase 29 added.
 *
 * The point of the file is the negative cases. A validator nobody has watched
 * reject a bad value is a validator nobody knows is running — and the failure
 * mode here is silent by construction: a span carrying a message body exports
 * successfully, looks like every other span, and is discovered by whoever reads
 * the tracing backend rather than by anything that fails.
 */
import type { Attributes } from '@opentelemetry/api';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-node';

import {
  ForbiddenSpanAttributeError,
  REDACTED,
  ScrubbingSpanProcessor,
  scrubAttributes,
} from '../../src/tracing/scrub';
import { isForbiddenAttributeKey } from '../../src/redaction';
import { isForbiddenLogField } from '../../src/logger';

describe('attribute keys that may never carry a value', () => {
  /**
   * The one the whole phase is about (D53).
   *
   * `pg`'s `enhancedDatabaseReporting` puts the statement on every span. On
   * this system that statement is `insert into messages (…, body, …)`, so the
   * stock setting ships every retained conversation to a tracing backend. It is
   * off at the instrumentation *and* denied here, because the instrumentation
   * setting is a setting — somebody can turn it back on while looking for
   * detail during an incident.
   */
  it('denies the database statement and its parameters', () => {
    expect(isForbiddenAttributeKey('db.statement')).toBe(true);
    expect(isForbiddenAttributeKey('db.query.text')).toBe(true);
    expect(isForbiddenAttributeKey('db.query.parameter.0')).toBe(true);
  });

  /**
   * F-036 arriving a second time through a different pipe.
   *
   * `/auth/callback?code=…&state=…` is proxied through this origin, so any
   * attribute carrying a request line carries an OIDC authorization code. The
   * nginx access log was fixed by removing the query string from the format;
   * there is no equivalent knob on every instrumentation, so the keys are
   * denied outright.
   */
  it('denies anything carrying a full URL or a query string', () => {
    for (const key of ['http.url', 'url.full', 'url.query', 'http.target']) {
      expect(isForbiddenAttributeKey(key)).toBe(true);
    }
  });

  it('denies request and response headers, however deep', () => {
    expect(isForbiddenAttributeKey('http.request.header.cookie')).toBe(true);
    expect(isForbiddenAttributeKey('http.response.header.set-cookie')).toBe(true);
  });

  /**
   * The segment check, which is what makes this robust against namespaces
   * nobody has invented yet.
   *
   * Span attributes are a flat map of dotted keys; the logger walks a nested
   * object. The same field names arrive in a different shape, so a check
   * written for one does not catch the other unless it splits.
   */
  it('denies a forbidden field name in any dotted segment', () => {
    expect(isForbiddenAttributeKey('chat.message.body')).toBe(true);
    expect(isForbiddenAttributeKey('persona.transcript')).toBe(true);
    expect(isForbiddenAttributeKey('report.note')).toBe(true);
    expect(isForbiddenAttributeKey('frame')).toBe(true);
    expect(isForbiddenAttributeKey('auth.token')).toBe(true);
  });

  it('allows the attributes an operator actually needs', () => {
    for (const key of [
      'db.system',
      'db.operation',
      'http.method',
      'http.status_code',
      'net.peer.name',
      'service.instance.id',
      'session.ipHash',
      'match.id',
    ]) {
      expect(isForbiddenAttributeKey(key)).toBe(false);
    }
  });

  /**
   * D52: one list, two consumers.
   *
   * Two denylists drift, and the one that drifts is the one nobody is looking
   * at. This asserts they are the same list rather than two lists that happen
   * to agree today.
   */
  it('shares the logger denylist rather than keeping its own', () => {
    for (const field of ['body', 'text', 'note', 'apiKey', 'totpSecret']) {
      expect(isForbiddenLogField(field)).toBe(true);
      expect(isForbiddenAttributeKey(field)).toBe(true);
    }
  });
});

describe('scrubbing attributes', () => {
  it('replaces the value and reports only the key', () => {
    const attributes: Attributes = {
      'db.statement': 'insert into messages (body) values ($1)',
      'db.system': 'postgresql',
    };
    const hit = scrubAttributes(attributes);

    expect(hit).toEqual(['db.statement']);
    expect(attributes['db.statement']).toBe(REDACTED);
    // Untouched, because an operator needs it and it says nothing about anyone.
    expect(attributes['db.system']).toBe('postgresql');
  });

  it('leaves a clean attribute set alone', () => {
    const attributes: Attributes = { 'http.method': 'POST', 'http.status_code': 200 };
    expect(scrubAttributes(attributes)).toEqual([]);
    expect(attributes).toEqual({ 'http.method': 'POST', 'http.status_code': 200 });
  });
});

function spanWith(attributes: Attributes): ReadableSpan {
  return { name: 'pg.query', attributes } as unknown as ReadableSpan;
}

function recordingInner(): SpanProcessor & { seen: ReadableSpan[] } {
  const seen: ReadableSpan[] = [];
  return {
    seen,
    onStart: () => undefined,
    onEnd: (span: ReadableSpan) => {
      seen.push(span);
    },
    forceFlush: () => Promise.resolve(),
    shutdown: () => Promise.resolve(),
  };
}

describe('ScrubbingSpanProcessor', () => {
  /**
   * Outside production a violation must be impossible to miss, exactly as the
   * logger's does. This is where new instrumentation is added, and a leak
   * should be something somebody trips over immediately rather than something
   * discovered in a tracing backend later.
   */
  it('throws outside production, naming the attribute and not its value', () => {
    const processor = new ScrubbingSpanProcessor(recordingInner(), { strict: true });
    const secret = 'insert into messages (body) values ($1)';

    expect(() => processor.onEnd(spanWith({ 'db.statement': secret }))).toThrow(
      ForbiddenSpanAttributeError,
    );

    try {
      processor.onEnd(spanWith({ 'db.statement': secret }));
    } catch (err) {
      expect((err as Error).message).toContain('db.statement');
      // The message must never carry the value, or the control that catches a
      // leak becomes the second copy of it.
      expect((err as Error).message).not.toContain('insert into messages');
    }
  });

  /**
   * In production it redacts instead, because taking down a live server over a
   * span attribute would be worse than the leak it prevents. Same trade the
   * logger makes, for the same reason.
   */
  it('redacts in production and still exports the span', () => {
    const inner = recordingInner();
    const processor = new ScrubbingSpanProcessor(inner, { strict: false });

    processor.onEnd(spanWith({ 'db.statement': 'insert into messages (body)', 'db.system': 'postgresql' }));

    expect(inner.seen).toHaveLength(1);
    expect(inner.seen[0]?.attributes['db.statement']).toBe(REDACTED);
    expect(inner.seen[0]?.attributes['db.system']).toBe('postgresql');
  });

  it('reports a violation without the value', () => {
    const reported: Array<[string, string]> = [];
    const processor = new ScrubbingSpanProcessor(recordingInner(), {
      strict: false,
      onViolation: (spanName, attribute) => reported.push([spanName, attribute]),
    });

    processor.onEnd(spanWith({ 'http.url': 'https://x/auth/callback?code=SECRET' }));

    expect(reported).toEqual([['pg.query', 'http.url']]);
    expect(JSON.stringify(reported)).not.toContain('SECRET');
  });

  it('passes a clean span straight through', () => {
    const inner = recordingInner();
    const processor = new ScrubbingSpanProcessor(inner, { strict: true });

    expect(() => processor.onEnd(spanWith({ 'db.operation': 'insert' }))).not.toThrow();
    expect(inner.seen).toHaveLength(1);
  });
});
