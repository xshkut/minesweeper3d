/**
 * Domain errors of the games module and their HTTP mapping.
 *
 * The service speaks in domain terms ("no such game", "that request is
 * invalid") and knows nothing about status codes; the HTTP and WebSocket layers
 * call {@link toHttpError} to turn any thrown value into a status, a stable code
 * and a message. Keeping the mapping in one function is what guarantees that
 * neither layer can accidentally leak a 500 for a client mistake.
 */
import { InvalidGameStateError } from "@minesweeper3d/game-core";
import { HttpError } from "../http";

/** Thrown when an operation addresses a game id the store does not know. */
export class GameNotFoundError extends Error {
  override readonly name = "GameNotFoundError";
  readonly gameId: string;

  constructor(gameId: string) {
    super(`Game "${gameId}" does not exist`);
    this.gameId = gameId;
  }
}

/**
 * Thrown when a request payload cannot be used: unknown preset, malformed
 * config, non-integer cell. Carries the machine readable code and the issue
 * list the API reports back to the client.
 */
export class InvalidGameRequestError extends Error {
  override readonly name = "InvalidGameRequestError";
  readonly code: string;
  readonly details: readonly string[];

  constructor(code: string, message: string, details: readonly string[] = []) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/** Thrown by mutating operations once {@link import("./service").GameService.close} ran. */
export class GameServiceClosedError extends Error {
  override readonly name = "GameServiceClosedError";

  constructor() {
    super("Game service is shut down");
  }
}

/**
 * Maps any thrown value to an {@link HttpError}.
 *
 * Unknown errors become a generic 500: internals are logged, never sent.
 */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;

  if (error instanceof GameNotFoundError) {
    return new HttpError(404, "game_not_found", error.message);
  }
  if (error instanceof InvalidGameRequestError) {
    return new HttpError(400, error.code, error.message, { details: error.details });
  }
  if (error instanceof InvalidGameStateError) {
    return new HttpError(400, "invalid_config", error.message);
  }
  if (error instanceof GameServiceClosedError) {
    return new HttpError(503, "service_unavailable", error.message);
  }
  return new HttpError(500, "internal_error", "Internal server error");
}
