#!/usr/bin/env bun
/**
 * Bootstrap: configuration in, listening server out, signals handled.
 *
 * The module deliberately does nothing on import (the `import.meta.main` guard
 * at the bottom), so tests can call {@link startServer} on an ephemeral port
 * without ever binding the configured one.
 */
import { GAME_PRESETS } from "@minesweeper3d/game-core";
import type { Server } from "bun";
import { createApp } from "./app";
import { loadServerConfig } from "./config";
import type { ServerConfig, ServerEnv } from "./config";
import { createGameService } from "./games/service";
import type { GameService } from "./games/service";
import { createInMemoryGameStore } from "./games/store";
import { createLogger } from "./logger";
import type { Logger } from "./logger";
import { createRealtimeHub } from "./realtime/hub";
import type { SocketData } from "./realtime/hub";

export { loadServerConfig } from "./config";
export type { ServerConfig, ServerEnv } from "./config";

/** A server that is already listening and can be shut down cleanly. */
export interface RunningServer {
  readonly server: Server<SocketData>;
  /** Base URL clients should use, with `0.0.0.0` translated to `localhost`. */
  readonly url: string;
  readonly config: ServerConfig;
  readonly logger: Logger;
  readonly service: GameService;
  /** Idempotent graceful shutdown: sockets, listeners, store, then the listener. */
  stop(): Promise<void>;
}

/** Options of {@link startServer}; every one of them has a production default. */
export interface StartServerOptions {
  /** Pre-validated config; takes precedence over `env`. */
  readonly config?: ServerConfig;
  /** Environment to read when `config` is absent; defaults to `process.env`. */
  readonly env?: ServerEnv;
  /** Logger override, mainly for tests. */
  readonly logger?: Logger;
}

/**
 * Builds the store/service/app and binds the port.
 *
 * @throws Error when the port is taken or the configuration is invalid
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const config = options.config ?? loadServerConfig(options.env ?? process.env);
  const logger =
    options.logger ?? createLogger({ level: config.logLevel, bindings: { service: "server" } });

  const store = createInMemoryGameStore();
  const service = createGameService({ store, logger });
  const hub = createRealtimeHub({ logger });
  const app = createApp({ config, logger, service, hub });
  const server = Bun.serve({ port: config.port, hostname: config.host, ...app });

  const url = `http://${displayHost(config.host)}:${server.port}`;
  logger.info("listening", {
    url,
    env: config.nodeEnv,
    logLevel: config.logLevel,
    webDist: config.webDist,
  });
  logger.info("presets available", {
    presets: GAME_PRESETS.map(
      (preset) => `${preset.id}(${preset.size.x}x${preset.size.y}x${preset.size.z}, ${preset.mineCount} mines)`,
    ).join(" "),
  });

  let stopped = false;
  return {
    server,
    url,
    config,
    logger,
    service,
    async stop() {
      if (stopped) return;
      stopped = true;
      // The listener is stopped first: Bun's `stop(true)` does not resolve for
      // sockets that were terminated server-side just before. The hub is
      // cleaned up afterwards, which is bookkeeping only.
      service.close();
      await server.stop(true);
      hub.closeAll();
      logger.info("server stopped", { url });
    },
  };
}

/** Wildcard binds are not dialable; log something a human can click. */
function displayHost(host: string): string {
  return host === "0.0.0.0" || host === "::" || host === "" ? "localhost" : host;
}

async function main(): Promise<void> {
  const running = await startServer();
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    running.logger.info("shutdown requested", { signal });
    await running.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Failed to start server: ${message}\n`);
    process.exit(1);
  });
}
