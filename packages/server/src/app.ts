/**
 * Composition root of the HTTP + WebSocket server.
 *
 * `createApp` wires logging, the `/api` router, the WebSocket upgrade and the
 * static client into the `fetch`/`websocket` pair `Bun.serve` expects. It never
 * binds a port itself, so tests can run it on an ephemeral port and the
 * bootstrap in `index.ts` owns the actual listener.
 */
import type { Server, WebSocketHandler } from "bun";
import type { ServerConfig } from "./config";
import { toGameDto } from "./games/dto";
import { toHttpError } from "./games/errors";
import { registerGameRoutes } from "./games/routes";
import type { GameService } from "./games/service";
import { errorResponse, HttpError } from "./http";
import type { Logger } from "./logger";
import { createRouter } from "./router";
import type { RouteContext } from "./router";
import { createRealtimeHub } from "./realtime/hub";
import type { GameSocket, RealtimeHub, SocketData } from "./realtime/hub";
import { parseClientMessageText, serializeServerMessage } from "./realtime/protocol";
import { createStaticHandler } from "./static";
import type { StaticHandler } from "./static";

/** Everything `createApp` needs; only `service`, `logger` and `config` are required. */
export interface AppDependencies {
  readonly service: GameService;
  readonly logger: Logger;
  /** The parts of the server config that shape responses. */
  readonly config: Pick<ServerConfig, "webDist" | "version">;
  /** Override to share a hub between apps (tests); a private one is created otherwise. */
  readonly hub?: RealtimeHub;
  /** Override to serve a fixture directory instead of `config.webDist`. */
  readonly staticHandler?: StaticHandler;
  /** Uptime source reported by `/api/health`; defaults to the process uptime. */
  readonly uptimeSeconds?: () => number;
}

/** The two halves `Bun.serve` consumes. */
export interface App {
  readonly fetch: (request: Request, server: Server<SocketData>) => Promise<Response | undefined>;
  readonly websocket: WebSocketHandler<SocketData>;
}

/** Builds the request handler and the WebSocket handlers. */
export function createApp(dependencies: AppDependencies): App {
  const { service, logger, config } = dependencies;
  const hub = dependencies.hub ?? createRealtimeHub({ logger });
  const staticHandler =
    dependencies.staticHandler ?? createStaticHandler({ distDir: config.webDist, logger });
  const router = createRouter();

  registerGameRoutes(router, {
    service,
    version: config.version,
    ...(dependencies.uptimeSeconds === undefined ? {} : { uptimeSeconds: dependencies.uptimeSeconds }),
  });
  router.get("/api/games/:id/ws", (context) => upgradeToGame(context, service));

  /**
   * Games that currently have at least one socket listening.
   *
   * The hub is a transport adapter, not a second source of truth: it relays
   * whatever the service reports. Subscribing here - rather than broadcasting
   * next to each mutation - is what makes an HTTP action (a REST client, a
   * future bot) reach every socket watching the game, and keeps the fan-out in
   * exactly one place.
   */
  const watchedGames = new Map<string, () => void>();

  const watchGame = (gameId: string): void => {
    if (watchedGames.has(gameId)) return;
    watchedGames.set(
      gameId,
      service.subscribe(gameId, (update) => {
        if (!update.changed) return;
        hub.broadcast(gameId, {
          type: "update",
          game: toGameDto(update.game),
          events: update.events,
        });
      }),
    );
  };

  const unwatchGame = (gameId: string): void => {
    watchedGames.get(gameId)?.();
    watchedGames.delete(gameId);
  };

  /** Reports a protocol/domain failure to one socket without closing it. */
  const sendError = (socket: GameSocket, code: string, message: string, details?: readonly string[]): void => {
    try {
      socket.send(serializeServerMessage({ type: "error", code, message, ...(details === undefined ? {} : { details }) }));
    } catch {
      // The socket died between the failure and the reply; nothing to do.
    }
  };

  const handleClientMessage = (socket: GameSocket, raw: string | Buffer): void => {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = parseClientMessageText(text);
    if (!parsed.ok) {
      sendError(socket, parsed.code, parsed.message, parsed.details);
      return;
    }

    const gameId = socket.data.gameId;
    if (parsed.message.type === "ping") {
      socket.send(serializeServerMessage({ type: "pong" }));
      return;
    }

    try {
      // Accepted actions are broadcast by the service subscription, so a frame
      // is produced exactly once no matter where the action came from.
      if (parsed.message.type === "reveal") {
        service.reveal(gameId, parsed.message.cell);
      } else {
        service.toggleFlag(gameId, parsed.message.cell);
      }
    } catch (error) {
      const httpError = toHttpError(error);
      logger.debug("websocket action rejected", { gameId, code: httpError.code });
      sendError(socket, httpError.code, httpError.message, httpError.details);
    }
  };

  const websocket: WebSocketHandler<SocketData> = {
    open(socket) {
      const gameId = socket.data.gameId;
      hub.subscribe(gameId, socket);
      watchGame(gameId);
      try {
        socket.send(serializeServerMessage({ type: "welcome", game: toGameDto(service.getGame(gameId)) }));
      } catch (error) {
        const httpError = toHttpError(error);
        sendError(socket, httpError.code, httpError.message);
        socket.close(1011, httpError.code);
      }
    },
    message(socket, raw) {
      handleClientMessage(socket, raw);
    },
    close(socket) {
      const gameId = socket.data.gameId;
      hub.unsubscribe(socket);
      // Stop listening to the service once nobody is watching, so idle games
      // cost nothing until a socket shows up again.
      if (hub.clientCount(gameId) === 0) unwatchGame(gameId);
    },
  };

  const fetch = async (request: Request, server: Server<SocketData>): Promise<Response | undefined> => {
    const startedAt = performance.now();
    const url = new URL(request.url);
    let failure: unknown;
    let response: Response | undefined;

    try {
      response = isApiPath(url.pathname)
        ? await router.handle(request, server)
        : await staticHandler(request);
    } catch (error) {
      failure = error;
      const httpError = toHttpError(error);
      response = errorResponse(
        httpError.status,
        httpError.code,
        httpError.message,
        httpError.details,
        httpError.headers,
      );
    }

    logRequest(logger, request.method, url.pathname, response, startedAt, failure);
    return response;
  };

  return { fetch, websocket };
}

/** `/api` and everything below it belongs to the API, not to the SPA. */
function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Validates the upgrade request and hands the socket to `Bun.serve`.
 *
 * A successful upgrade returns `undefined`, which tells `Bun.serve` that the
 * 101 response has already been written.
 */
function upgradeToGame(context: RouteContext, service: GameService): undefined {
  const gameId = context.params["id"];
  if (gameId === undefined || gameId.length === 0) {
    throw new HttpError(400, "invalid_game_id", "A game id is required");
  }

  // Refuse unknown games before touching the socket layer: a client that made a
  // typo deserves the same 404 the REST endpoint gives.
  service.getGame(gameId);

  if (context.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "upgrade_required", "This endpoint only accepts WebSocket upgrades", {
      headers: { upgrade: "websocket" },
    });
  }
  if (context.server === undefined) {
    throw new HttpError(500, "upgrade_unavailable", "WebSocket upgrades are unavailable");
  }
  if (!context.server.upgrade(context.request, { data: { gameId } })) {
    throw new HttpError(500, "upgrade_failed", "WebSocket upgrade failed");
  }
  return undefined;
}

function logRequest(
  logger: Logger,
  method: string,
  path: string,
  response: Response | undefined,
  startedAt: number,
  failure: unknown,
): void {
  const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
  // An upgraded socket never produces a Response; 101 is the truthful status.
  const status = response?.status ?? 101;
  const fields = { method, path, status, ms: durationMs };

  if (status >= 500) {
    logger.error("request failed", { ...fields, error: failure });
  } else if (status >= 400) {
    logger.warn("request rejected", fields);
  } else {
    logger.info("request", fields);
  }
}
