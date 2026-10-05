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

/** Client asks to reveal a cell. */
export interface ClientRevealMessage {
  readonly type: "reveal";
  readonly cell: CellIndex;
}

/** Client asks to toggle a flag. */
export interface ClientFlagMessage {
  readonly type: "flag";
  readonly cell: CellIndex;
}

/** Client liveness probe. */
export interface ClientPingMessage {
  readonly type: "ping";
}

/** Messages a client may send. */
export type ClientMessage = ClientRevealMessage | ClientFlagMessage | ClientPingMessage;

/** First frame after a successful upgrade; carries the redacted game. */
export interface WelcomeMessage {
  readonly type: "welcome";
  readonly game: GameDto;
}

/** A mutation accepted by the server, broadcast to every socket of the game. */
export interface UpdateMessage {
  readonly type: "update";
  readonly game: GameDto;
  readonly events: readonly GameEvent[];
}

/** Recoverable problem with a client frame; the socket stays open. */
export interface ErrorMessage {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
}

/** Reply to {@link ClientPingMessage}. */
export interface PongMessage {
  readonly type: "pong";
}

/** Messages the server may send. */
export type ServerMessage = WelcomeMessage | UpdateMessage | ErrorMessage | PongMessage;

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
      "supported types: reveal, flag, ping",
    ]);
  }

  switch (type) {
    case "ping":
      return { ok: true, message: { type: "ping" } };

    case "reveal":
    case "flag": {
      const cell = input["cell"];
      if (!isCellIndex(cell)) {
        return rejected(INVALID_CELL, `"${type}" requires an integer cell {x, y, z}`, [
          "expected a JSON object like { \"x\": 0, \"y\": 0, \"z\": 0 }",
        ]);
      }
      return { ok: true, message: { type, cell: { x: cell.x, y: cell.y, z: cell.z } } };
    }

    default:
      return rejected(INVALID_MESSAGE, `Unknown message type "${type}"`, ["supported types: reveal, flag, ping"]);
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
