/**
 * Server configuration: the single place where environment variables are read.
 *
 * Keeping every `process.env` lookup here means the rest of the server takes a
 * plain, frozen object, which is trivial to construct in tests and impossible
 * to mutate at runtime. Invalid values fail fast at boot with a message that
 * names the variable and the accepted range.
 */
import { resolve } from "node:path";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "./logger";

/** Version reported by `GET /api/health`; mirrors packages/server/package.json. */
export const SERVER_VERSION = "1.0.0";

/** Port used when `PORT` is unset. */
export const DEFAULT_PORT = 8000;

/** Interface bound when `HOST` is unset; all interfaces by default. */
export const DEFAULT_HOST = "0.0.0.0";

/** Level used when `LOG_LEVEL` is unset. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** Read-only view of the process environment (`process.env` fits this shape). */
export type ServerEnv = Readonly<Record<string, string | undefined>>;

/** Validated, frozen runtime configuration of the HTTP server. */
export interface ServerConfig {
  readonly port: number;
  readonly host: string;
  readonly nodeEnv: string;
  /** Absolute path of the built web client served at `/`. */
  readonly webDist: string;
  readonly logLevel: LogLevel;
  /** Reported by the health endpoint so deployments can identify a build. */
  readonly version: string;
}

/**
 * Reads and validates the configuration.
 *
 * @param env defaults to `process.env`
 * @throws Error when `PORT` is not an integer in 1..65535 or `LOG_LEVEL` is unknown
 */
export function loadServerConfig(env: ServerEnv = process.env): ServerConfig {
  return Object.freeze({
    port: parsePort(env["PORT"]),
    host: optional(env["HOST"]) ?? DEFAULT_HOST,
    nodeEnv: optional(env["NODE_ENV"]) ?? "development",
    webDist: resolve(optional(env["WEB_DIST"]) ?? defaultWebDist()),
    logLevel: parseLogLevel(env["LOG_LEVEL"]),
    version: optional(env["SERVER_VERSION"]) ?? SERVER_VERSION,
  });
}

/** `<repo>/packages/web/dist`, derived from this file's location. */
export function defaultWebDist(): string {
  // src/ -> packages/server -> packages -> packages/web/dist
  return resolve(import.meta.dir, "..", "..", "web", "dist");
}

function parsePort(raw: string | undefined): number {
  const value = optional(raw);
  if (value === undefined) return DEFAULT_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT "${value}": expected an integer between 1 and 65535`);
  }
  return port;
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const value = optional(raw)?.toLowerCase();
  if (value === undefined) return DEFAULT_LOG_LEVEL;
  if (!isLogLevel(value)) {
    throw new Error(`Invalid LOG_LEVEL "${value}": expected one of ${LOG_LEVELS.join(", ")}`);
  }
  return value;
}

/** Treats unset and blank variables alike, so `PORT=""` falls back to the default. */
function optional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
