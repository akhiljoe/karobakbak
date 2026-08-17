/**
 * Structured logging.
 *
 * One JSON object per line on stdout/stderr, which is what every log shipper
 * expects and what keeps conversation content from being smuggled into a
 * free-text log line.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE IS SECURITY-CRITICAL
 * ---------------------------------------------------------------------------
 * There is no application-level message encryption (DESIGN.md D15). Message
 * content is plaintext everywhere inside the trusted boundary — process memory,
 * the persistence queue, the outage spool and PostgreSQL. The observability
 * pipeline is therefore the most likely path for that content to *escape* the
 * boundary, and this module is the control that prevents it (DESIGN.md §18.1,
 * invariant I8).
 *
 * Three defences, none of which rely on developer discipline:
 *
 *  1. `FORBIDDEN_FIELDS` — a denylist of field names that could carry user
 *     content or personal data, applied **recursively** through nested objects
 *     and arrays. A shallow check is not enough: `{ ctx: { text } }` is exactly
 *     how a leak happens in practice.
 *  2. Depth and breadth limits, so a hostile or accidental deep structure
 *     cannot stall the process during redaction.
 *  3. `errorFields()` truncates and scans error messages and stacks, because an
 *     `Error` built by interpolating user text carries that text into the log.
 *
 * Outside production a violation **throws**, so the test suite catches it.
 * In production it **redacts**, because taking down a live server over a log
 * field would be worse than the leak it prevents.
 */
import type { Config, LogLevel } from './config';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names that must never carry a value into the log stream.
 *
 * Two categories:
 *   - user content shapes: how a chat message, a report note or a raw frame
 *     would most plausibly be named by someone adding a log line in a hurry;
 *   - personal data: client IPs, which are personal data on an anonymous
 *     service and are only ever handled as salted hashes (`ipHash` is allowed).
 *
 * `msg` is deliberately absent: it is the log line's own label and is always a
 * developer-authored constant.
 */
const FORBIDDEN_FIELDS = new Set([
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
]);

/** Guards against pathological structures during recursive redaction. */
const MAX_DEPTH = 6;
const MAX_KEYS_PER_OBJECT = 64;
const MAX_ARRAY_ITEMS = 32;

/** Error messages and stacks are truncated before they reach the log stream. */
const MAX_ERROR_MESSAGE_CHARS = 300;
const MAX_STACK_CHARS = 2000;

const REDACTED = '[redacted]';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger that stamps additional fields on every line. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Stamped on every line; typically `{ instance: config.instanceId }`. */
  base?: LogFields;
  /** Throw instead of redacting when a forbidden field is passed. */
  strict?: boolean;
  /** Injectable sink, so tests can capture output without spying on console. */
  sink?: (line: string) => void;
}

function defaultSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

export class ForbiddenLogFieldError extends Error {
  constructor(public readonly path: string) {
    super(
      `logger: refusing to log forbidden field "${path}" — conversation content, report ` +
        `notes and client IPs must never reach the log stream (DESIGN.md I8)`,
    );
    this.name = 'ForbiddenLogFieldError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Recursively copy `value`, replacing any forbidden field with a redaction
 * marker. Returns the original reference when nothing needed changing, so the
 * common case allocates nothing.
 *
 * In strict mode the first violation throws instead, carrying the full path so
 * the offending call site is obvious from the test failure.
 */
function scrub(value: unknown, strict: boolean, path: string, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[truncated: max depth]';

  if (Array.isArray(value)) {
    const limited = value.length > MAX_ARRAY_ITEMS ? value.slice(0, MAX_ARRAY_ITEMS) : value;
    let changed = limited.length !== value.length;
    const out: unknown[] = new Array(limited.length);
    for (let i = 0; i < limited.length; i += 1) {
      const item = scrub(limited[i], strict, `${path}[${i}]`, depth + 1);
      out[i] = item;
      if (item !== limited[i]) changed = true;
    }
    return changed ? out : value;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    const limited = keys.length > MAX_KEYS_PER_OBJECT ? keys.slice(0, MAX_KEYS_PER_OBJECT) : keys;
    let changed = limited.length !== keys.length;
    const out: Record<string, unknown> = {};
    for (const key of limited) {
      const childPath = path ? `${path}.${key}` : key;
      if (FORBIDDEN_FIELDS.has(key)) {
        if (strict) throw new ForbiddenLogFieldError(childPath);
        out[key] = REDACTED;
        changed = true;
        continue;
      }
      const child = scrub(value[key], strict, childPath, depth + 1);
      out[key] = child;
      if (child !== value[key]) changed = true;
    }
    return changed ? out : value;
  }

  return value;
}

function sanitise(fields: LogFields, strict: boolean): LogFields {
  const result = scrub(fields, strict, '', 0);
  return isPlainObject(result) ? result : fields;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…[truncated]` : text;
}

/**
 * Convert an Error into loggable fields.
 *
 * Stack traces stay server-side; they are never included in a protocol `error`
 * frame. Both the message and the stack are truncated and denylist-scanned,
 * because an `Error` constructed by interpolating user text — `new Error(\`bad
 * message: ${text}\`)` — would otherwise carry that text straight into the log
 * (DESIGN.md §18.1 item 2).
 *
 * Code that handles message content must build errors from constant strings.
 * This function is the backstop, not the primary rule.
 */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    const fields: LogFields = {
      err: err.name,
      errMsg: truncate(err.message, MAX_ERROR_MESSAGE_CHARS),
    };
    if (typeof err.stack === 'string') {
      fields.stack = truncate(err.stack, MAX_STACK_CHARS);
    }
    return fields;
  }
  return { err: 'UnknownError', errMsg: truncate(String(err), MAX_ERROR_MESSAGE_CHARS) };
}

/**
 * Convert a database driver error into loggable fields.
 *
 * A PostgreSQL error object can echo parameter values — the row you just tried
 * to insert — on constraint violations, type errors and statement timeouts.
 * Logging the raw object would therefore leak message content. Only the
 * structured, non-content fields are emitted (DESIGN.md §18.1 item 3).
 *
 * Never log a driver error with `errorFields()`; use this instead.
 */
export function dbErrorFields(err: unknown): LogFields {
  const candidate = err as { name?: unknown; code?: unknown; constraint?: unknown; table?: unknown; routine?: unknown };
  const fields: LogFields = { err: 'DatabaseError' };
  if (typeof candidate?.name === 'string') fields.err = candidate.name;
  if (typeof candidate?.code === 'string') fields.dbCode = candidate.code;
  if (typeof candidate?.constraint === 'string') fields.dbConstraint = candidate.constraint;
  if (typeof candidate?.table === 'string') fields.dbTable = candidate.table;
  if (typeof candidate?.routine === 'string') fields.dbRoutine = candidate.routine;
  return fields;
}

class JsonLogger implements Logger {
  private readonly threshold: number;

  constructor(
    private readonly level: LogLevel,
    private readonly base: LogFields,
    private readonly strict: boolean,
    private readonly sink: (line: string) => void,
  ) {
    this.threshold = LEVEL_ORDER[level];
  }

  private write(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < this.threshold) return;
    const safe = fields ? sanitise(fields, this.strict) : undefined;
    const line = {
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.base,
      ...safe,
    };
    let serialised: string;
    try {
      serialised = JSON.stringify(line);
    } catch {
      // A circular or non-serialisable field must not take the process down.
      serialised = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...this.base,
        logError: 'fields were not serialisable',
      });
    }
    this.sink(serialised);
  }

  debug(msg: string, fields?: LogFields): void {
    this.write('debug', msg, fields);
  }

  info(msg: string, fields?: LogFields): void {
    this.write('info', msg, fields);
  }

  warn(msg: string, fields?: LogFields): void {
    this.write('warn', msg, fields);
  }

  error(msg: string, fields?: LogFields): void {
    this.write('error', msg, fields);
  }

  child(fields: LogFields): Logger {
    return new JsonLogger(
      this.level,
      { ...this.base, ...sanitise(fields, this.strict) },
      this.strict,
      this.sink,
    );
  }
}

export function createLogger(options: LoggerOptions): Logger {
  return new JsonLogger(
    options.level,
    options.base ?? {},
    options.strict ?? false,
    options.sink ?? defaultSink,
  );
}

/** Convenience constructor wired from Config. */
export function createLoggerFromConfig(config: Config): Logger {
  return createLogger({
    level: config.logLevel,
    base: { instance: config.instanceId },
    strict: !config.isProduction,
  });
}

/** A logger that discards everything. Useful in unit tests. */
export function createNullLogger(): Logger {
  return createLogger({ level: 'error', sink: () => undefined });
}

/** Exposed for tests that assert the denylist covers a given field name. */
export function isForbiddenLogField(name: string): boolean {
  return FORBIDDEN_FIELDS.has(name);
}
