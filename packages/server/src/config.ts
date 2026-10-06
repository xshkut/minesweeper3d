/**
 * Server configuration: the single place where environment variables are read.
 *
 * Keeping every `process.env` lookup here means the rest of the server takes a
 * plain, frozen object, which is trivial to construct in tests and impossible
 * to mutate at runtime. Invalid values fail fast at boot with a message that
 * names the variable and the accepted range.
 */
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isLogLevel, LOG_LEVELS, type LogLevel } from "./logger";
import { ROOM_TTL_MS } from "./rooms/service";

/** Version reported by `GET /api/health`; mirrors packages/server/package.json. */
export const SERVER_VERSION = "1.0.0";

/** Port used when `PORT` is unset. */
export const DEFAULT_PORT = 8000;

/** Interface bound when `HOST` is unset; all interfaces by default. */
export const DEFAULT_HOST = "0.0.0.0";

/** Level used when `LOG_LEVEL` is unset. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/**
 * Values of `STATE_FILE` that turn persistence off.
 *
 * A file is the default, so switching it off has to be said on purpose. `off`
 * reads best; the others are here because "no file" has many natural spellings
 * and a silently ignored one would leave someone wondering why a file appeared.
 */
const DISABLED_STATE_FILES: readonly string[] = ["off", "none", "memory", "disabled"];

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
  /**
   * File the in-memory state is snapshotted to, or `undefined` to keep it in
   * memory only.
   */
  readonly stateFile: string | undefined;
  /** How long a room outlives its last change. */
  readonly roomTtlMs: number;
}

/**
 * Reads and validates the configuration.
 *
 * @param env defaults to `process.env`
 * @throws Error when `PORT` is not an integer in 1..65535, `LOG_LEVEL` is
 * unknown, or `ROOM_TTL_MS` is not a positive integer
 */
export function loadServerConfig(env: ServerEnv = process.env): ServerConfig {
  const port = parsePort(env["PORT"]);
  return Object.freeze({
    port,
    host: optional(env["HOST"]) ?? DEFAULT_HOST,
    nodeEnv: optional(env["NODE_ENV"]) ?? "development",
    webDist: resolve(optional(env["WEB_DIST"]) ?? defaultWebDist()),
    logLevel: parseLogLevel(env["LOG_LEVEL"]),
    version: optional(env["SERVER_VERSION"]) ?? SERVER_VERSION,
    stateFile: parseStateFile(env["STATE_FILE"], port),
    roomTtlMs: parseRoomTtl(env["ROOM_TTL_MS"]),
  });
}

/**
 * Where the state file lives when `STATE_FILE` is unset.
 *
 * A temporary directory, as asked for: the state is a convenience that makes a
 * restart painless, not a database, so it does not belong in the checkout and
 * the operating system may clear it whenever it likes. The port is part of the
 * name so two servers on one host do not overwrite each other's rooms.
 */
export function defaultStateFile(port: number): string {
  return join(tmpdir(), "minesweeper3d", `state-${port}.json`);
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

/**
 * Resolves `STATE_FILE`: a path, or `off`/`none`/`memory`/`disabled` for none.
 *
 * A relative path is resolved against the working directory, like `WEB_DIST`,
 * so `STATE_FILE=.tmp/state.json` means what it looks like.
 */
function parseStateFile(raw: string | undefined, port: number): string | undefined {
  const value = optional(raw);
  if (value === undefined) return defaultStateFile(port);
  if (DISABLED_STATE_FILES.includes(value.toLowerCase())) return undefined;
  return resolve(value);
}

function parseRoomTtl(raw: string | undefined): number {
  const value = optional(raw);
  if (value === undefined) return ROOM_TTL_MS;

  const ttl = Number(value);
  if (!Number.isSafeInteger(ttl) || ttl < 1) {
    throw new Error(`Invalid ROOM_TTL_MS "${value}": expected a whole number of milliseconds of at least 1`);
  }
  return ttl;
}

/** Treats unset and blank variables alike, so `PORT=""` falls back to the default. */
function optional(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
