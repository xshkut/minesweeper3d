/**
 * Runtime parsing of the server contract.
 *
 * The client validates every payload it receives before trusting it, so a
 * misbehaving or outdated server produces a readable error message instead of
 * a broken board.
 */
import { isVec3 } from "@minesweeper3d/game-core";
import type { ClientCell, ClientGameState, GameEvent, GameStatus } from "@minesweeper3d/game-core";

/** `GameDto` as defined by the server contract. */
export interface GameDto {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ClientGameState;
}

/** Everything the server can push over the WebSocket. */
export type ServerMessage =
  | { readonly type: "welcome"; readonly game: GameDto }
  | { readonly type: "update"; readonly game: GameDto; readonly events: readonly GameEvent[] }
  | { readonly type: "error"; readonly code: string; readonly message: string }
  | { readonly type: "pong" };

/**
 * Parses a `{ game }` envelope.
 *
 * @throws Error when the payload does not look like a game
 */
export function parseGameEnvelope(payload: unknown): GameDto {
  const record = asRecord(payload);
  return parseGameDto(record?.["game"]);
}

/**
 * Validates a `GameDto`.
 *
 * @throws Error when required fields are missing or malformed
 */
export function parseGameDto(value: unknown): GameDto {
  const record = asRecord(value);
  if (record === null) throw new Error("Server sent a game that is not an object");

  const id = record["id"];
  const state = record["state"];
  if (typeof id !== "string" || id.length === 0) throw new Error("Server sent a game without an id");
  if (!isClientGameState(state)) throw new Error("Server sent a game with an unexpected state");

  return {
    id,
    revision: typeof record["revision"] === "number" ? record["revision"] : 0,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : "",
    state,
  };
}

/** Parses an incoming socket frame; `null` when it is not a known message. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }

  const record = asRecord(payload);
  if (record === null) return null;

  switch (record["type"]) {
    case "welcome":
      return { type: "welcome", game: parseGameDto(record["game"]) };
    case "update":
      return {
        type: "update",
        game: parseGameDto(record["game"]),
        events: parseEvents(record["events"]),
      };
    case "error": {
      const code = typeof record["code"] === "string" ? record["code"] : "error";
      const message = typeof record["message"] === "string" ? record["message"] : "Unknown server error";
      return { type: "error", code, message };
    }
    case "pong":
      return { type: "pong" };
    default:
      return null;
  }
}

/** Keeps only the events the client understands. */
export function parseEvents(value: unknown): readonly GameEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isGameEvent);
}

/** Pulls the server's `{ error: { code, message } }` message out of a payload. */
export function parseErrorMessage(payload: unknown): string | null {
  const error = asRecord(asRecord(payload)?.["error"]);
  const message = error?.["message"];
  if (typeof message !== "string" || message.length === 0) return null;
  const code = error?.["code"];
  return typeof code === "string" && code.length > 0 ? `${code}: ${message}` : message;
}

/** Turns any thrown value into a message a player can act on. */
export function describeError(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) return `${fallback} (${cause.message})`;
  if (typeof cause === "string" && cause.length > 0) return `${fallback} (${cause})`;
  return fallback;
}

const STATUSES: readonly GameStatus[] = ["ready", "playing", "won", "lost"];

function isClientGameState(value: unknown): value is ClientGameState {
  const record = asRecord(value);
  if (record === null) return false;

  const config = asRecord(record["config"]);
  const status = record["status"];
  return (
    config !== null &&
    isVec3(config["size"]) &&
    typeof config["mineCount"] === "number" &&
    typeof config["seed"] === "number" &&
    typeof config["firstRevealSafe"] === "boolean" &&
    typeof status === "string" &&
    STATUSES.includes(status as GameStatus) &&
    Array.isArray(record["cells"]) &&
    record["cells"].every(isClientCell) &&
    typeof record["revealedCount"] === "number" &&
    typeof record["flagCount"] === "number" &&
    (record["explodedAt"] === null || isVec3(record["explodedAt"]))
  );
}

function isClientCell(value: unknown): value is ClientCell {
  const record = asRecord(value);
  return (
    record !== null &&
    isVec3(record["index"]) &&
    typeof record["adjacentMines"] === "number" &&
    typeof record["isRevealed"] === "boolean" &&
    typeof record["isFlagged"] === "boolean" &&
    typeof record["hasMine"] === "boolean"
  );
}

function isGameEvent(value: unknown): value is GameEvent {
  const record = asRecord(value);
  if (record === null) return false;

  switch (record["type"]) {
    case "cellsRevealed":
    case "minesRevealed":
      return Array.isArray(record["cells"]) && record["cells"].every(isVec3);
    case "flagChanged":
      return isVec3(record["cell"]) && typeof record["flagged"] === "boolean";
    case "mineExploded":
      return isVec3(record["cell"]);
    case "gameWon":
    case "gameLost":
      return true;
    default:
      return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
