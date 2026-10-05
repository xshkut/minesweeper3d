/**
 * Tiny levelled logger with an injectable sink.
 *
 * The server needs to be observable in production and completely silent in
 * tests. A dependency-free logger whose output goes through one function keeps
 * both possible: production writes one line per record to stdout/stderr, while
 * a test injects a sink that collects lines (or drops them).
 */

/** Severity of a log record, ordered from most to least verbose. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** All levels in ascending severity; used for validation and filtering. */
export const LOG_LEVELS: readonly LogLevel[] = Object.freeze(["debug", "info", "warn", "error"]);

const LEVEL_WEIGHT: Readonly<Record<LogLevel, number>> = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

/** Structured context attached to a record, formatted as `key=value` pairs. */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * Receives one fully formatted line per record.
 *
 * The level is passed along so a sink can route warnings to stderr, colourise
 * them, or forward them to an external collector.
 */
export type LogSink = (line: string, level: LogLevel) => void;

/** Public logger handle; `child` inherits the level, sink and clock. */
export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Derives a logger that attaches `bindings` to every subsequent record. */
  child(bindings: LogFields): Logger;
}

/** Construction options of {@link createLogger}. */
export interface LoggerOptions {
  /** Records below this level are dropped. */
  readonly level: LogLevel;
  /** Defaults to stdout for debug/info and stderr for warn/error. */
  readonly sink?: LogSink;
  /** Fields added to every record, e.g. `{ service: "server" }`. */
  readonly bindings?: LogFields;
  /** Injectable clock, so tests can pin timestamps. */
  readonly now?: () => Date;
}

/** Narrows an untrusted value (an env var, a query parameter) to a level. */
export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LOG_LEVELS as readonly string[]).includes(value);
}

/** Creates a logger writing one `timestamp LEVEL message key=value` line per record. */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_WEIGHT[options.level];
  const sink = options.sink ?? writeToStdStreams;
  const bindings = options.bindings ?? {};
  const now = options.now ?? (() => new Date());

  const log = (level: LogLevel, message: string, fields?: LogFields): void => {
    if (LEVEL_WEIGHT[level] < threshold) return;
    sink(formatRecord(level, message, { ...bindings, ...fields }, now()), level);
  };

  return {
    debug: (message, fields) => log("debug", message, fields),
    info: (message, fields) => log("info", message, fields),
    warn: (message, fields) => log("warn", message, fields),
    error: (message, fields) => log("error", message, fields),
    child: (extra) =>
      createLogger({ level: options.level, sink, now, bindings: { ...bindings, ...extra } }),
  };
}

/** Silences every record; the usual choice in tests and for a `null` logger. */
export const NOOP_SINK: LogSink = () => {
  // Intentionally empty: records are formatted and then dropped.
};

function formatRecord(level: LogLevel, message: string, fields: LogFields, date: Date): string {
  const parts = [date.toISOString(), level.toUpperCase().padEnd(5, " "), message];
  // Sorted keys keep records stable across runs, which makes them diffable.
  for (const key of Object.keys(fields).sort()) {
    parts.push(`${key}=${formatValue(fields[key])}`);
  }
  return parts.join(" ");
}

function formatValue(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 0 && /^[A-Za-z0-9_./:@+-]+$/.test(value) ? value : JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`);
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular structures must never break logging.
    return String(value);
  }
}

function writeToStdStreams(line: string, level: LogLevel): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}
