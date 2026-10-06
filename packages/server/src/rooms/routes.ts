/**
 * HTTP endpoints of the rooms API.
 *
 * Thin handlers: parse with the shared HTTP helpers, delegate to the room
 * service, map domain errors through {@link toRoomHttpError}. They are registered
 * onto a router supplied by the app, which keeps the module free of `Bun.serve`.
 *
 * `POST /api/rooms` both creates the room and seats the caller, so a client that
 * wants to host needs exactly one request. `POST /api/rooms/:id/join` does the
 * same for an existing room. Both answer with `{room, player, game}` - the three
 * things a client needs before it can open a socket and play, where `game` is
 * the caller's own board (a private copy of the cube in a race).
 *
 * Reveals and flags do not go through HTTP at all: only the socket knows which
 * player is acting, and survival cannot be scored without that.
 */
import { HttpError, jsonResponse, readJsonBody } from "../http";
import type { Router } from "../router";
import { toGameDto } from "../games/dto";
import { toRoomHttpError } from "./errors";
import type { RoomService } from "./service";
import { toPlayerDto, toRoomDto, toRoomSummaryDto } from "./dto";

/** Collaborators of the room routes. */
export interface RoomRoutesDependencies {
  readonly rooms: RoomService;
}

/** Registers every `/api/rooms` route on an existing router. */
export function registerRoomRoutes(router: Router, dependencies: RoomRoutesDependencies): void {
  const { rooms } = dependencies;

  router.get("/api/rooms", () => {
    // Private rooms are unlisted: browsing the lobby must not reveal them.
    return jsonResponse({ rooms: rooms.listRooms({ visibility: "public" }).map(toRoomSummaryDto) });
  });

  router.post("/api/rooms", async ({ request }) => {
    // An empty body is allowed and means "co-op, default board, default name".
    const body = await readJsonBody(request, { allowEmpty: true });
    const session = guard(() => rooms.createRoom(body));
    return jsonResponse(
      { room: toRoomDto(session.room), player: toPlayerDto(session.player), game: toGameDto(session.game) },
      { status: 201 },
    );
  });

  router.get("/api/rooms/:id", ({ params }) => {
    const room = guard(() => rooms.getRoom(roomIdOf(params)));
    const game = guard(() => rooms.getBoard(room.id, null));
    return jsonResponse({ room: toRoomDto(room), game: toGameDto(game) });
  });

  router.post("/api/rooms/:id/join", async ({ params, request }) => {
    const body = await readJsonBody(request, { allowEmpty: true });
    const session = guard(() => rooms.joinRoom(roomIdOf(params), body));
    return jsonResponse({
      room: toRoomDto(session.room),
      player: toPlayerDto(session.player),
      game: toGameDto(session.game),
    });
  });

  router.post("/api/rooms/:id/leave", async ({ params, request }) => {
    const body = await readJsonBody(request, { allowEmpty: true });
    const playerId = playerIdOf(body);
    const room = guard(() => rooms.leaveRoom(roomIdOf(params), playerId));
    return jsonResponse({ ok: true, room: room === undefined ? null : toRoomDto(room) });
  });

  router.post("/api/rooms/:id/restart", async ({ params, request }) => {
    const body = await readJsonBody(request, { allowEmpty: true });
    const session = guard(() => rooms.restart(roomIdOf(params), body));
    return jsonResponse({
      room: toRoomDto(session.room),
      player: toPlayerDto(session.player),
      game: toGameDto(session.game),
    });
  });
}

/** Runs a service call, converting domain errors into HTTP errors. */
function guard<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toRoomHttpError(error);
  }
}

/** The `:id` capture is guaranteed by the pattern; guard the type anyway. */
function roomIdOf(params: Readonly<Record<string, string>>): string {
  const id = params["id"];
  if (id === undefined || id.length === 0) {
    throw new HttpError(400, "invalid_room_id", "A room id is required");
  }
  return id.toUpperCase();
}

/** Reads the mandatory `playerId` used by leave. */
function playerIdOf(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  const playerId = (body as Record<string, unknown>)["playerId"];
  if (typeof playerId !== "string" || playerId.length === 0) {
    throw new HttpError(400, "invalid_body", "playerId must be a non-empty string");
  }
  return playerId;
}
