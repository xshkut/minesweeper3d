/**
 * Wire protocol of the realtime channel.
 *
 * The parsers here are the trust boundary: a socket payload is untrusted input
 * exactly like an HTTP body, so a malformed frame produces a typed rejection
 * that the app answers with an `error` message instead of crashing the server.
 */
import { isCellIndex } from "@minesweeper3d/game-core";
import type { CellIndex, GameEvent } from "@minesweeper3d/game-core";
import type { GameDto } from "../games/dto";
import type { RoomDto } from "../rooms/dto";

/** Client asks to reveal a cell. */
export interface ClientRevealMessage {
  readonly type: "reveal";
  readonly cell: CellIndex;
}

/** Client asks to cycle a cell's mark: flag, question, none. */
export interface ClientMarkMessage {
  readonly type: "mark";
  readonly cell: CellIndex;
}

/** Client spends a free reveal on a cell to learn whether it hides a mine. */
export interface ClientProbeMessage {
  readonly type: "probe";
  readonly cell: CellIndex;
}

/**
 * The cell this player is pointing at, so the other seats can draw their
 * pointer. `null` means "no longer pointing anywhere".
 *
 * This is a hint, not a game action: it is relayed to the room as-is, never
 * validated against the board beyond being a cell index, and never persisted.
 */
export interface ClientCursorMessage {
  readonly type: "cursor";
  readonly cell: CellIndex | null;
}

/** Client liveness probe. */
export interface ClientPingMessage {
  readonly type: "ping";
}

/** Messages a client may send. */
export type ClientMessage =
  | ClientRevealMessage
  | ClientMarkMessage
  | ClientProbeMessage
  | ClientCursorMessage
  | ClientPingMessage;

/** First frame after a successful upgrade; carries the redacted game. */
export interface WelcomeMessage {
  readonly type: "welcome";
  readonly game: GameDto;
  /** Present on room sockets: the room, its players and the caller's seat. */
  readonly room?: RoomDto;
  /** Present on room sockets when the client identified itself as a player. */
  readonly playerId?: string;
}

/** A mutation accepted by the server, broadcast to every socket of the game. */
export interface UpdateMessage {
  readonly type: "update";
  readonly game: GameDto;
  readonly events: readonly GameEvent[];
  /**
   * Player whose private board this is.
   *
   * Absent for the board a room shares, present for every board of a race: each
   * player only ever receives updates for their own copy, plus a `room` frame
   * carrying everybody's progress.
   */
  readonly board?: string;
  /** Player whose socket caused the change, when the socket spoke for one. */
  readonly actor?: string;
}

/** Presence changed in a room: someone joined, left or connected. */
export interface RoomPresenceMessage {
  readonly type: "room";
  readonly room: RoomDto;
}

/** Recoverable problem with a client frame; the socket stays open. */
export interface ErrorMessage {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
}

/**
 * Where another seat of the room is pointing; `cell` is `null` when that player
 * stopped pointing or disconnected.
 *
 * Kept out of the room DTO on purpose: a pointer moves dozens of times a
 * second, so it travels only over the socket, only to the room, and is dropped
 * when the room empties.
 */
export interface CursorMessage {
  readonly type: "cursor";
  readonly playerId: string;
  readonly cell: CellIndex | null;
}

/** Reply to {@link ClientPingMessage}. */
export interface PongMessage {
  readonly type: "pong";
}

/** Messages the server may send. */
export type ServerMessage =
  | WelcomeMessage
  | UpdateMessage
  | RoomPresenceMessage
  | CursorMessage
  | ErrorMessage
  | PongMessage;

/** Successful parse of a client frame. */
export interface ClientMessageAccepted {
  readonly ok: true;
  readonly message: ClientMessage;
}

/** Rejected client frame, with the error to report back. */
export interface ClientMessageRejected {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly details: readonly string[];
}

/** Result of {@link parseClientMessage}. */
export type ClientMessageParseResult = ClientMessageAccepted | ClientMessageRejected;

/** Message types a client may send, for the two rejection messages. */
const SUPPORTED_TYPES = "reveal, mark, probe, cursor, ping";

/** Codes used when a frame cannot be understood. */
export const INVALID_JSON = "invalid_json";
export const INVALID_MESSAGE = "invalid_message";
export const INVALID_CELL = "invalid_cell";

/**
 * Parses an already decoded frame value.
 *
 * @returns the message, or the error payload to send back
 */
export function parseClientMessage(input: unknown): ClientMessageParseResult {
  if (!isRecord(input)) {
    return rejected(INVALID_MESSAGE, "Message must be a JSON object", ["expected { \"type\": \"ping\" } or similar"]);
  }

  const type = input["type"];
  if (typeof type !== "string") {
    return rejected(INVALID_MESSAGE, "Message must have a string \"type\" field", [
      `supported types: ${SUPPORTED_TYPES}`,
    ]);
  }

  switch (type) {
    case "ping":
      return { ok: true, message: { type: "ping" } };

    case "reveal":
    case "mark":
    case "probe": {
      const cell = input["cell"];
      if (!isCellIndex(cell)) {
        return rejected(INVALID_CELL, `"${type}" requires an integer cell {x, y, z}`, [
          "expected a JSON object like { \"x\": 0, \"y\": 0, \"z\": 0 }",
        ]);
      }
      return { ok: true, message: { type, cell: { x: cell.x, y: cell.y, z: cell.z } } };
    }

    case "cursor": {
      const cell = input["cell"];
      if (cell === null) return { ok: true, message: { type: "cursor", cell: null } };
      if (!isCellIndex(cell)) {
        return rejected(INVALID_CELL, `"cursor" requires an integer cell {x, y, z} or null`, [
          "expected a JSON object like { \"x\": 0, \"y\": 0, \"z\": 0 }, or null to stop pointing",
        ]);
      }
      return { ok: true, message: { type: "cursor", cell: { x: cell.x, y: cell.y, z: cell.z } } };
    }

    default:
      return rejected(INVALID_MESSAGE, `Unknown message type "${type}"`, [`supported types: ${SUPPORTED_TYPES}`]);
  }
}

/**
 * Parses a raw text frame (JSON decode plus {@link parseClientMessage}).
 *
 * @returns the message, or the error payload to send back
 */
export function parseClientMessageText(text: string): ClientMessageParseResult {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return rejected(INVALID_JSON, "Message must be valid JSON", ["expected a JSON object such as { \"type\": \"ping\" }"]);
  }
  return parseClientMessage(value);
}

/** Serialises a server message; broadcast uses this once per frame. */
export function serializeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

function rejected(code: string, message: string, details: readonly string[]): ClientMessageRejected {
  return { ok: false, code, message, details };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
