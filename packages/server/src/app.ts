/**
 * Composition root of the HTTP + WebSocket server.
 *
 * `createApp` wires logging, the `/api` router, the WebSocket upgrades and the
 * static client into the `fetch`/`websocket` pair `Bun.serve` expects. It never
 * binds a port itself, so tests can run it on an ephemeral port and the
 * bootstrap in `index.ts` owns the actual listener.
 *
 * Two kinds of socket exist. A *game* socket (`/api/games/:id/ws`) watches one
 * board and is the older, single-player entry point. A *room* socket
 * (`/api/rooms/:id/ws?player=<id>`) watches the room's current board *and*
 * receives presence frames, which is what the welcome screen uses: a room
 * outlives the game it plays when the host restarts the board.
 */
import type { Server, WebSocketHandler } from "bun";
import type { CellIndex } from "@minesweeper3d/game-core";
import type { ServerConfig } from "./config";
import { toGameDto } from "./games/dto";
import { toHttpError } from "./games/errors";
import { registerGameRoutes } from "./games/routes";
import type { GameService } from "./games/service";
import { errorResponse, HttpError } from "./http";
import type { Logger } from "./logger";
import { createRouter } from "./router";
import type { RouteContext } from "./router";
import { createRealtimeHub, roomChannel } from "./realtime/hub";
import type { ClientSocket, RealtimeHub, SocketData } from "./realtime/hub";
import { parseClientMessageText } from "./realtime/protocol";
import type { CursorMessage, UpdateMessage } from "./realtime/protocol";
import { toRoomDto } from "./rooms/dto";
import { registerRoomRoutes } from "./rooms/routes";
import { toRoomHttpError } from "./rooms/errors";
import type { RoomService } from "./rooms/service";
import { createStaticHandler } from "./static";
import type { StaticHandler } from "./static";

/** Everything `createApp` needs; only `service`, `rooms`, `logger` and `config` are required. */
export interface AppDependencies {
  readonly service: GameService;
  readonly rooms: RoomService;
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
  const { service, rooms, logger, config } = dependencies;
  const hub = dependencies.hub ?? createRealtimeHub({ logger });
  const staticHandler =
    dependencies.staticHandler ?? createStaticHandler({ distDir: config.webDist, logger });
  const router = createRouter();

  registerGameRoutes(router, {
    service,
    version: config.version,
    ...(dependencies.uptimeSeconds === undefined ? {} : { uptimeSeconds: dependencies.uptimeSeconds }),
  });
  registerRoomRoutes(router, { rooms });
  router.get("/api/games/:id/ws", (context) => upgradeToGame(context, service));
  router.get("/api/rooms/:id/ws", (context) => upgradeToRoom(context, rooms));

  /**
   * Who caused the mutation currently being applied.
   *
   * The service is synchronous and does not model actors - it only knows a
   * game changed. Setting this immediately before a socket-driven action and
   * reading it inside the subscription callback is enough to attribute the
   * frame, and unlike threading an actor through the engine it keeps the pure
   * core untouched.
   */
  let pendingActor: string | undefined;

  /**
   * Games that currently have at least one socket listening, per channel.
   *
   * The hub is a transport adapter, not a second source of truth: it relays
   * whatever the service reports. Subscribing here - rather than broadcasting
   * next to each mutation - is what makes an HTTP action (a REST client, a
   * future bot) reach every socket watching the game, and keeps the fan-out in
   * exactly one place.
   */
  const watchedGames = new Map<string, () => void>();

  const gameKey = (channel: string, gameId: string): string => `${channel}\u0000${gameId}`;

  const watchGame = (channel: string, gameId: string): void => {
    const key = gameKey(channel, gameId);
    if (watchedGames.has(key)) return;
    watchedGames.set(
      key,
      service.subscribe(gameId, (update) => {
        if (!update.changed) return;
        hub.broadcast(channel, {
          type: "update",
          game: toGameDto(update.game),
          events: update.events,
          ...(pendingActor === undefined ? {} : { actor: pendingActor }),
        });
      }),
    );
  };

  const unwatchGame = (channel: string, gameId: string): void => {
    const key = gameKey(channel, gameId);
    watchedGames.get(key)?.();
    watchedGames.delete(key);
  };

  /**
   * Rooms whose changes are currently relayed.
   *
   * Room boards are moved by the room service, not by the games service
   * directly, because only the room knows *who* acted - and survival cannot be
   * scored without that. Every accepted change therefore arrives here already
   * attributed, and the app only has to decide who may see which board.
   */
  const watchedRooms = new Map<string, () => void>();

  /**
   * Where each seated player of a room is pointing, keyed by room then player.
   *
   * A pointer is ephemeral by nature: it lives in memory only, is never
   * persisted with the room, and is dropped as soon as the room has no socket
   * left. The room DTO deliberately does not carry it either, because it moves
   * dozens of times a second and would bloat every presence frame.
   */
  const cursorsByRoom = new Map<string, Map<string, CellIndex>>();

  const sameCell = (a: CellIndex | undefined, b: CellIndex): boolean =>
    a !== undefined && a.x === b.x && a.y === b.y && a.z === b.z;

  /**
   * Relays one player's pointer to their room; a no-op when nothing changed.
   *
   * The mover is skipped: it already knows where its own pointer is, and a
   * pointer moves often enough that echoing it back would be pure noise.
   */
  const setRoomCursor = (
    roomId: string,
    playerId: string,
    cell: CellIndex | null,
    except?: ClientSocket,
  ): void => {
    const cursors = cursorsByRoom.get(roomId);
    if (cell === null) {
      if (cursors === undefined || !cursors.delete(playerId)) return;
    } else {
      if (cursors !== undefined && sameCell(cursors.get(playerId), cell)) return;
      const next = { x: cell.x, y: cell.y, z: cell.z };
      if (cursors === undefined) cursorsByRoom.set(roomId, new Map([[playerId, next]]));
      else cursors.set(playerId, next);
    }
    const channel = roomChannel(roomId);
    const message: CursorMessage = { type: "cursor", playerId, cell };
    if (except === undefined) {
      hub.broadcast(channel, message);
      return;
    }
    for (const peer of hub.socketsIn(channel)) {
      if (peer !== except) hub.send(peer, message);
    }
  };

  const watchRoom = (roomId: string): void => {
    if (watchedRooms.has(roomId)) return;
    const channel = roomChannel(roomId);
    const unsubscribe = rooms.subscribe(roomId, (change) => {
      for (const update of change.updates) {
        const message: UpdateMessage = {
          type: "update",
          game: toGameDto(update.game),
          events: update.events,
          ...(update.ownerId === null ? {} : { board: update.ownerId }),
          ...(update.actor === null ? {} : { actor: update.actor }),
        };
        if (update.ownerId === null) {
          // One cube for the whole room: everybody sees every move.
          hub.broadcast(channel, message);
          continue;
        }
        // A race board belongs to exactly one player. Sending it to the whole
        // room would multiply the traffic by the number of players, so each
        // socket only ever receives the cube it is actually playing.
        for (const socket of hub.socketsIn(channel)) {
          if (socket.data.playerId === update.ownerId) hub.send(socket, message);
        }
      }
      hub.broadcast(channel, { type: "room", room: toRoomDto(change.room) });
      // A player who left cannot clear their own pointer, so the frame that
      // just announced the new seating is also the moment to forget it.
      const cursors = cursorsByRoom.get(roomId);
      if (cursors !== undefined) {
        const seated = new Set(change.room.players.map((player) => player.id));
        for (const id of [...cursors.keys()]) if (!seated.has(id)) cursors.delete(id);
      }
    });
    watchedRooms.set(roomId, unsubscribe);
  };

  const unwatchRoom = (roomId: string): void => {
    watchedRooms.get(roomId)?.();
    watchedRooms.delete(roomId);
  };

  /** Reports a protocol/domain failure to one socket without closing it. */
  const sendError = (socket: ClientSocket, code: string, message: string, details?: readonly string[]): void => {
    hub.send(socket, { type: "error", code, message, ...(details === undefined ? {} : { details }) });
  };

  const handleClientMessage = (socket: ClientSocket, raw: string | Buffer): void => {
    const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const parsed = parseClientMessageText(text);
    if (!parsed.ok) {
      sendError(socket, parsed.code, parsed.message, parsed.details);
      return;
    }

    if (parsed.message.type === "ping") {
      hub.send(socket, { type: "pong" });
      return;
    }

    if (parsed.message.type === "cursor") {
      // A pointer is meaningful only for a seated player of a room: a spectator
      // or a private-game socket has nobody to show it to, and is simply
      // ignored rather than answered with an error.
      const { roomId, playerId } = socket.data;
      if (roomId !== undefined && playerId !== undefined) setRoomCursor(roomId, playerId, parsed.message.cell, socket);
      return;
    }

    const roomId = socket.data.roomId;
    try {
      if (roomId !== undefined) {
        // Room actions carry the seat of the socket. A spectator (no `?player=`)
        // is told so by the domain error rather than silently ignored.
        const playerId = socket.data.playerId ?? "";
        const { cell } = parsed.message;
        if (parsed.message.type === "reveal") rooms.reveal(roomId, playerId, cell);
        else if (parsed.message.type === "mark") rooms.cycleMark(roomId, playerId, cell);
        else rooms.probe(roomId, playerId, cell);
        return;
      }

      // A private game socket has no room to attribute through, so the actor is
      // set around the synchronous call for the subscription to read.
      pendingActor = socket.data.playerId;
      try {
        const { cell } = parsed.message;
        if (parsed.message.type === "reveal") service.reveal(socket.data.channel, cell);
        else if (parsed.message.type === "mark") service.cycleMark(socket.data.channel, cell);
        else service.probe(socket.data.channel, cell);
      } finally {
        pendingActor = undefined;
      }
    } catch (error) {
      const httpError = roomId === undefined ? toHttpError(error) : toRoomHttpError(error);
      logger.debug("websocket action rejected", { channel: socket.data.channel, code: httpError.code });
      sendError(socket, httpError.code, httpError.message, httpError.details);
    }
  };

  const websocket: WebSocketHandler<SocketData> = {
    open(socket) {
      const { channel, roomId, playerId } = socket.data;
      hub.subscribe(channel, socket);
      try {
        if (roomId === undefined) {
          watchGame(channel, channel);
          hub.send(socket, { type: "welcome", game: toGameDto(service.getGame(channel)) });
          return;
        }

        watchRoom(roomId);
        if (playerId !== undefined) rooms.connect(roomId, playerId);
        const room = rooms.getRoom(roomId);
        hub.send(socket, {
          type: "welcome",
          game: toGameDto(service.getGame(room.gameId)),
          room: toRoomDto(room),
          ...(playerId === undefined ? {} : { playerId }),
        });
        // A late joiner has missed every pointer movement so far; replaying
        // the current one keeps their first rendered frame truthful.
        const cursors = cursorsByRoom.get(roomId);
        if (cursors !== undefined) {
          for (const [id, cell] of cursors) {
            if (id !== playerId) hub.send(socket, { type: "cursor", playerId: id, cell });
          }
        }
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
      const { channel, roomId, playerId } = socket.data;
      hub.unsubscribe(socket);
      if (roomId !== undefined) {
        if (playerId !== undefined) {
          // Clearing before the disconnect frame keeps the order the other
          // seats observe consistent: the pointer goes, then the seat does.
          // A second socket of the same player (another tab) still points.
          const stillConnected = hub.socketsIn(channel).some((peer) => peer.data.playerId === playerId);
          if (!stillConnected) setRoomCursor(roomId, playerId, null);
          try {
            rooms.disconnect(roomId, playerId);
          } catch (error) {
            logger.debug("room disconnect ignored", { roomId, error });
          }
        }
        // Stop listening once nobody is watching, so idle rooms and games cost
        // nothing until a socket shows up again. Pointers go with them.
        if (hub.clientCount(channel) === 0) {
          unwatchRoom(roomId);
          cursorsByRoom.delete(roomId);
        }
        return;
      }
      if (hub.clientCount(channel) === 0) unwatchGame(channel, channel);
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
 * Validates a game upgrade request and hands the socket to `Bun.serve`.
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
  requireUpgrade(context, "WebSocket upgrades are unavailable");

  if (!context.server!.upgrade(context.request, { data: { channel: gameId } })) {
    throw new HttpError(500, "upgrade_failed", "WebSocket upgrade failed");
  }
  return undefined;
}

/** Validates a room upgrade request, resolving the caller's seat from `?player=`. */
function upgradeToRoom(context: RouteContext, rooms: RoomService): undefined {
  const roomId = context.params["id"]?.toUpperCase();
  if (roomId === undefined || roomId.length === 0) {
    throw new HttpError(400, "invalid_room_id", "A room id is required");
  }

  const room = rooms.getRoom(roomId);
  requireUpgrade(context, "WebSocket upgrades are unavailable");

  const playerId = context.url.searchParams.get("player") ?? undefined;
  if (playerId !== undefined && !room.players.some((player) => player.id === playerId)) {
    throw new HttpError(403, "unknown_player", `Player "${playerId}" is not in room "${roomId}"`);
  }

  if (
    !context.server!.upgrade(context.request, {
      data: { channel: roomChannel(roomId), roomId, ...(playerId === undefined ? {} : { playerId }) },
    })
  ) {
    throw new HttpError(500, "upgrade_failed", "WebSocket upgrade failed");
  }
  return undefined;
}

/** Shared upgrade guard: the endpoint only answers WebSocket handshakes. */
function requireUpgrade(context: RouteContext, unavailableMessage: string): void {
  if (context.request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw new HttpError(426, "upgrade_required", "This endpoint only accepts WebSocket upgrades", {
      headers: { upgrade: "websocket" },
    });
  }
  if (context.server === undefined) {
    throw new HttpError(500, "upgrade_unavailable", unavailableMessage);
  }
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
