/**
 * Shared fixtures for the server tests.
 *
 * Everything here is designed so a test can talk to a *real* HTTP/WebSocket
 * server on an ephemeral port while staying silent and leaving nothing behind:
 * one call starts the app, `stop()` closes sockets, listeners and the store.
 */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createApp } from "../src/app";
import type { App } from "../src/app";
import { createGameService } from "../src/games/service";
import type { GameService } from "../src/games/service";
import { createInMemoryGameStore } from "../src/games/store";
import type { GameStore } from "../src/games/store";
import { createLogger, NOOP_SINK } from "../src/logger";
import type { LogLevel, Logger } from "../src/logger";
import { createRealtimeHub } from "../src/realtime/hub";
import type { RealtimeHub } from "../src/realtime/hub";
import type { StaticHandler } from "../src/static";

/** Repository root, derived from this file's location (`packages/server/test`). */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");

/** Scratch space for temp dist fixtures; `.tmp` is git-ignored. */
export const TMP_ROOT = resolve(REPO_ROOT, ".tmp");

/** A logger that formats nothing and writes nothing. */
export function silentLogger(): Logger {
  return createLogger({ level: "error", sink: NOOP_SINK });
}

/** A logger that records every line, for assertions about logging. */
export function recordingLogger(level: LogLevel = "debug"): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = createLogger({ level, sink: (line) => lines.push(line) });
  return { logger, lines };
}

/** A `webDist` path that intentionally does not exist. */
export function missingDistDir(): string {
  return resolve(TMP_ROOT, "server-test-dist-missing");
}

/** Options of {@link startTestServer}. */
export interface TestServerOptions {
  /** Built-client directory; defaults to a path that does not exist. */
  readonly webDist?: string;
  readonly logger?: Logger;
  readonly service?: GameService;
  readonly store?: GameStore;
  readonly staticHandler?: StaticHandler;
  /** ISO clock injected into a fresh service. */
  readonly now?: () => string;
}

/** A running server plus the collaborators a test may want to poke at. */
export interface TestServer {
  readonly url: string;
  readonly port: number;
  readonly service: GameService;
  readonly store: GameStore;
  readonly hub: RealtimeHub;
  readonly logger: Logger;
  readonly app: App;
  /** Closes sockets, drops subscribers and stops the listener. Idempotent. */
  stop(): Promise<void>;
}

/** Starts the app on `127.0.0.1:0`; the OS picks a free port. */
export async function startTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const logger = options.logger ?? silentLogger();
  const store = options.store ?? createInMemoryGameStore();
  const service =
    options.service ??
    createGameService({ store, logger, ...(options.now === undefined ? {} : { now: options.now }) });
  const hub = createRealtimeHub({ logger });
  const app = createApp({
    service,
    logger,
    hub,
    config: { webDist: options.webDist ?? missingDistDir(), version: "test" },
    ...(options.staticHandler === undefined ? {} : { staticHandler: options.staticHandler }),
  });

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", ...app });
  const port = server.port;
  if (port === undefined) throw new Error("Bun.serve did not bind a port");

  let stopped = false;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    service,
    store,
    hub,
    logger,
    app,
    async stop() {
      if (stopped) return;
      stopped = true;
      // Order matters: Bun's `server.stop(true)` does not resolve when the
      // sockets were terminated server-side just before, so the listener goes
      // down first and the hub is only cleaned up afterwards.
      service.close();
      await server.stop(true);
      hub.closeAll();
    },
  };
}

/** Result of a raw HTTP call, decoded for assertions. */
export interface HttpResult {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  /** Parsed JSON body, or `undefined` when the body is not JSON. */
  readonly body: unknown;
}

/** Performs a request and decodes a JSON body when there is one. */
export async function call(
  method: string,
  url: string,
  options: { readonly body?: string; readonly headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  const response = await fetch(url, {
    method,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = undefined;
  }
  return { status: response.status, headers: response.headers, text, body };
}

/** `GET` a URL. */
export function get(url: string): Promise<HttpResult> {
  return call("GET", url);
}

/** `POST` a JSON body (or nothing at all). */
export function postJson(url: string, body?: unknown): Promise<HttpResult> {
  return call("POST", url, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: { "content-type": "application/json" },
  });
}

/** Polls until `predicate` holds; used for events that cross the socket layer. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out waiting for condition");
}

/** A connected test socket with a message queue on top. */
export interface TestSocket {
  readonly socket: WebSocket;
  /** Next message, waiting up to `timeoutMs`; rejects on timeout. */
  next(timeoutMs?: number): Promise<unknown>;
  /** Sends a JSON frame (or a raw string for malformed-message tests). */
  send(data: unknown): void;
  close(): void;
}

/** Opens a WebSocket and resolves once it is open. */
export async function connectSocket(url: string): Promise<TestSocket> {
  const socket = new WebSocket(url);
  const queue: unknown[] = [];
  const waiters: Array<(value: unknown) => void> = [];

  socket.addEventListener("message", (event) => {
    const value = decodeFrame(event.data);
    const waiter = waiters.shift();
    if (waiter === undefined) queue.push(value);
    else waiter(value);
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error(`timed out connecting to ${url}`)), 3000);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolveOpen();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        rejectOpen(new Error(`websocket error while connecting to ${url}`));
      },
      { once: true },
    );
  });

  return {
    socket,
    next(timeoutMs = 2000) {
      const queued = queue.shift();
      if (queued !== undefined) return Promise.resolve(queued);

      return new Promise<unknown>((resolveMessage, rejectMessage) => {
        let timer: ReturnType<typeof setTimeout>;
        const waiter = (value: unknown): void => {
          clearTimeout(timer);
          resolveMessage(value);
        };

        timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          rejectMessage(new Error("timed out waiting for a websocket message"));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    send(data) {
      socket.send(typeof data === "string" ? data : JSON.stringify(data));
    },
    close() {
      socket.close();
    },
  };
}

/**
 * Attempts a connection that must be refused (unknown game, wrong endpoint).
 *
 * @returns the close code the client observed
 */
export async function refusedUpgrade(url: string): Promise<number> {
  return new Promise<number>((resolveRefused, rejectRefused) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.close();
      rejectRefused(new Error(`timed out waiting for ${url} to be refused`));
    }, 3000);

    socket.addEventListener("open", () => {
      clearTimeout(timer);
      socket.close();
      rejectRefused(new Error(`expected the upgrade to ${url} to be refused`));
    });
    socket.addEventListener("close", (event) => {
      clearTimeout(timer);
      resolveRefused(event.code);
    });
    socket.addEventListener("error", () => {
      // Bun reports a refused handshake as an error followed by a close; the
      // close listener settles the promise.
    });
  });
}

/** A temporary `WEB_DIST` containing an index page and one hashed asset. */
export interface WebDistFixture {
  readonly dir: string;
  readonly indexHtml: string;
  readonly assetPath: string;
  readonly assetBody: string;
  remove(): Promise<void>;
}

/** Creates a throwaway dist directory under `.tmp`. */
export async function createWebDistFixture(): Promise<WebDistFixture> {
  const dir = await mkdtemp(resolve(TMP_ROOT, "server-test-dist-"));
  const indexHtml = "<!doctype html><title>minesweeper3d test client</title>";
  const assetBody = "export const boot = 'test';\n";
  const assetPath = "/assets/app-abc123.js";

  await mkdir(resolve(dir, "assets"), { recursive: true });
  await writeFile(resolve(dir, "index.html"), indexHtml);
  await writeFile(resolve(dir, "assets/app-abc123.js"), assetBody);
  await writeFile(resolve(dir, "favicon.ico"), "icon");

  return {
    dir,
    indexHtml,
    assetPath,
    assetBody,
    remove: () => rm(dir, { recursive: true, force: true }),
  };
}

function decodeFrame(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return JSON.parse(data) as unknown;
    } catch {
      return data;
    }
  }
  return data;
}
