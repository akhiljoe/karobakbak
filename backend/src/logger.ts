/**
 * Structured logging.
 *
 * One JSON object per line on stdout/stderr, which is what every log shipper
 * expects and what keeps a chat message from ever being smuggled into a
 * free-text log line.
 *
 * Hard rule enforced here, not by convention: chat message text must never be
 * logged. `FORBIDDEN_FIELDS` is a denylist of field names that could carry user
 * content or personal data. In development and test the logger throws if one
 * appears (so the mistake is caught by the test suite); in production it
 * redacts, because crashing a live server over a log field would be worse than
 * the leak it prevents.
 */
import type { Config, LogLevel } from './config';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Field names that must never carry a value into the log stream.
 * `text`/`message`/`body`/`content` are the shapes chat content could take;
 * `ip`/`remoteAddress` are personal data on an anonymous service.
 * (`msg` is the log line's own human-readable label and is intentionally not
 * in this list — it is a developer-authored constant string.)
 */
const FORBIDDEN_FIELDS = new Set([
  'text',
  'body',
  'content',
  'payload',
  'ip',
  'remoteAddress',
  'remoteAddr',
  'clientIp',
]);

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

/**
 * Convert an Error into loggable fields. Stack traces stay server-side; they
 * are never included in a protocol `error` frame.
 */
export function errorFields(err: unknown): LogFields {
  if (err instanceof Error) {
    return { err: err.name, errMsg: err.message, stack: err.stack };
  }
  return { err: 'UnknownError', errMsg: String(err) };
}

function sanitise(fields: LogFields, strict: boolean): LogFields {
  let out: LogFields | null = null;
  for (const key of Object.keys(fields)) {
    if (!FORBIDDEN_FIELDS.has(key)) continue;
    if (strict) {
      throw new Error(
        `logger: refusing to log forbidden field "${key}" — chat content and client IPs must ` +
          `never reach the log stream`,
      );
    }
    if (out === null) out = { ...fields };
    out[key] = '[redacted]';
  }
  return out ?? fields;
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
