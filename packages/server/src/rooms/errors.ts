/**
 * Domain errors of the rooms module and their HTTP mapping.
 *
 * Rooms add three failure modes to the ones the games module already has: an
 * unknown room, a full room and a request that names a player the room does not
 * seat. Like the games module, the service throws in domain terms and the HTTP
 * and WebSocket layers translate with {@link toRoomHttpError}, so no handler can
 * leak a 500 for a client mistake.
 */
import { HttpError } from "../http";
import { toHttpError } from "../games/errors";

/** Thrown when an operation addresses a room code the store does not know. */
export class RoomNotFoundError extends Error {
  override readonly name = "RoomNotFoundError";
  readonly roomId: string;

  constructor(roomId: string) {
    super(`Room "${roomId}" does not exist`);
    this.roomId = roomId;
  }
}

/** Thrown when a join would exceed the room's player limit. */
export class RoomFullError extends Error {
  override readonly name = "RoomFullError";
  readonly roomId: string;
  readonly maxPlayers: number;

  constructor(roomId: string, maxPlayers: number) {
    super(`Room "${roomId}" is full (${maxPlayers} players)`);
    this.roomId = roomId;
    this.maxPlayers = maxPlayers;
  }
}

/** Thrown when a request names a player the room does not seat. */
export class PlayerNotInRoomError extends Error {
  override readonly name = "PlayerNotInRoomError";
  readonly roomId: string;
  readonly playerId: string;

  constructor(roomId: string, playerId: string) {
    super(`Player "${playerId}" is not in room "${roomId}"`);
    this.roomId = roomId;
    this.playerId = playerId;
  }
}

/** Thrown when a room payload cannot be used; carries the wire code and issues. */
export class InvalidRoomRequestError extends Error {
  override readonly name = "InvalidRoomRequestError";
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Thrown by mutating operations once {@link import("./service").RoomService.close} ran. */
export class RoomServiceClosedError extends Error {
  override readonly name = "RoomServiceClosedError";

  constructor() {
    super("Room service is shut down");
  }
}

/** Maps any thrown value to an {@link HttpError}, falling back to the games mapping. */
export function toRoomHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof RoomNotFoundError) return new HttpError(404, "room_not_found", error.message);
  if (error instanceof RoomFullError) return new HttpError(409, "room_full", error.message);
  if (error instanceof PlayerNotInRoomError) return new HttpError(403, "unknown_player", error.message);
  if (error instanceof InvalidRoomRequestError) {
    return new HttpError(400, error.code, error.message, { details: error.details });
  }
  if (error instanceof RoomServiceClosedError) {
    return new HttpError(503, "service_unavailable", error.message);
  }
  // Games errors (unknown preset, bad config, no such game) flow through here.
  return toHttpError(error);
}
