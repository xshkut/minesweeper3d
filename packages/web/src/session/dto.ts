/**
 * Runtime parsing of the server contract.
 *
 * The client validates every payload it receives before trusting it, so a
 * misbehaving or outdated server produces a readable error message instead of
 * a broken board.
 */
import { DEFAULT_ROOM_VISIBILITY, ROOM_VISIBILITIES, findDifficulty, isVec3 } from "@minesweeper3d/game-core";
import type {
  CellMark,
  ClientCell,
  ClientGameState,
  DifficultyId,
  GameEvent,
  GameStatus,
  MatchMode,
  RoomVisibility,
  Vec3,
} from "@minesweeper3d/game-core";

/** What happened to a player in the round the room is playing. */
export type PlayerOutcome = "playing" | "cleared" | "out";

/** `GameDto` as defined by the server contract. */
export interface GameDto {
  readonly id: string;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: ClientGameState;
}

/** A player seated in a room, as defined by the server contract. */
export interface PlayerDto {
  readonly id: string;
  readonly name: string;
  readonly joinedAt: string;
  readonly connected: boolean;
  readonly outcome: PlayerOutcome;
  readonly finishedAt: string | null;
  /** Cells this player opened this round; the score the room panel shows. */
  readonly revealedCount: number;
}

/**
 * The setup a room is playing: which mode, on what board, and how hard.
 *
 * `difficultyId`/`difficultyLabel` are derived by the server from the mine
 * count rather than sent as a separate choice, so the tier a player sees can
 * never disagree with the board they are actually playing.
 */
export interface RoomSetupDto {
  readonly mode: MatchMode;
  /** `"private"` rooms are unlisted but still joinable by their code. */
  readonly visibility: RoomVisibility;
  readonly status: GameStatus;
  readonly round: number;
  readonly presetId: string;
  readonly difficultyId: DifficultyId;
  readonly difficultyLabel: string;
  readonly mineCount: number;
  readonly size: Vec3;
  /** Charges the free-reveal aid grants; `0` when the aid is off. */
  readonly freeReveals: number;
}

/** A room and its seats. The board itself lives in {@link GameDto}. */
export interface RoomDto extends RoomSetupDto {
  readonly id: string;
  readonly name: string;
  readonly gameId: string;
  readonly players: readonly PlayerDto[];
  readonly maxPlayers: number;
  /** When the co-op clock runs out; `null` until the first reveal. */
  readonly deadlineAt: string | null;
  readonly timeLimitMs: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A room as it appears in the lobby list. */
export interface RoomSummaryDto extends RoomSetupDto {
  readonly id: string;
  readonly name: string;
  readonly gameId: string;
  readonly playerCount: number;
  readonly maxPlayers: number;
  readonly createdAt: string;
}

/** The payload of create/join: everything needed to start playing. */
export interface RoomJoinDto {
  readonly room: RoomDto;
  readonly player: PlayerDto;
  readonly game: GameDto;
}

/** Everything the server can push over the WebSocket. */
export type ServerMessage =
  | { readonly type: "welcome"; readonly game: GameDto; readonly room?: RoomDto; readonly playerId?: string }
  | {
      readonly type: "update";
      readonly game: GameDto;
      readonly events: readonly GameEvent[];
      readonly actor?: string;
      /** Set when the update is for one player's private board in a race. */
      readonly board?: string;
    }
  | { readonly type: "room"; readonly room: RoomDto }
  | {
      /**
       * Where another seat of the room is pointing; `null` when that player
       * stopped pointing or disconnected.
       *
       * Deliberately not part of {@link RoomDto}: a pointer moves far more
       * often than a seat does, and its frames must never trigger a re-render.
       */
      readonly type: "cursor";
      readonly playerId: string;
      readonly cell: Vec3 | null;
    }
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

/** Validates a `PlayerDto`; `null` when it is malformed. */
export function parsePlayerDto(value: unknown): PlayerDto | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record["id"];
  const name = record["name"];
  if (typeof id !== "string" || typeof name !== "string") return null;
  const outcome = record["outcome"];
  return {
    id,
    name,
    joinedAt: typeof record["joinedAt"] === "string" ? record["joinedAt"] : "",
    connected: record["connected"] === true,
    outcome:
      typeof outcome === "string" && OUTCOMES.includes(outcome as PlayerOutcome)
        ? (outcome as PlayerOutcome)
        : "playing",
    finishedAt: typeof record["finishedAt"] === "string" ? record["finishedAt"] : null,
    revealedCount: typeof record["revealedCount"] === "number" ? record["revealedCount"] : 0,
  };
}

/**
 * Reads the setup fields shared by a room and a room summary.
 *
 * Everything has a fallback because the lobby renders rooms it did not create:
 * an older server should still produce a usable card, not a parse error.
 */
function readRoomSetup(record: Record<string, unknown>): RoomSetupDto {
  const mode = record["mode"];
  const difficulty = record["difficultyId"];
  const difficultyId =
    typeof difficulty === "string" && DIFFICULTY_IDS.includes(difficulty as DifficultyId)
      ? (difficulty as DifficultyId)
      : "normal";
  const status = record["status"];
  const size = record["size"];

  return {
    mode: typeof mode === "string" && MATCH_MODES.includes(mode as MatchMode) ? (mode as MatchMode) : "coop",
    // An older server does not know about privacy, so an absent field means a
    // listed room rather than a room the client refuses to render.
    visibility:
      typeof record["visibility"] === "string" && ROOM_VISIBILITIES.some((entry) => entry.id === record["visibility"])
        ? (record["visibility"] as RoomVisibility)
        : DEFAULT_ROOM_VISIBILITY,
    status:
      typeof status === "string" && STATUSES.includes(status as GameStatus) ? (status as GameStatus) : "ready",
    round: typeof record["round"] === "number" ? record["round"] : 1,
    presetId: typeof record["presetId"] === "string" ? record["presetId"] : "",
    difficultyId,
    difficultyLabel:
      typeof record["difficultyLabel"] === "string"
        ? record["difficultyLabel"]
        : (findDifficulty(difficultyId)?.label ?? difficultyId),
    mineCount: typeof record["mineCount"] === "number" ? record["mineCount"] : 0,
    size: isVec3(size) ? size : { x: 0, y: 0, z: 0 },
    // An older server has no aid to speak of, which is the same as not granting one.
    freeReveals: typeof record["freeReveals"] === "number" ? record["freeReveals"] : 0,
  };
}

/**
 * Validates a `RoomDto`.
 *
 * @throws Error when the payload is not a room
 */
export function parseRoomDto(value: unknown): RoomDto {
  const record = asRecord(value);
  if (record === null) throw new Error("Server sent a room that is not an object");
  const id = record["id"];
  if (typeof id !== "string" || id.length === 0) throw new Error("Server sent a room without an id");

  const players: PlayerDto[] = [];
  if (Array.isArray(record["players"])) {
    for (const entry of record["players"]) {
      const player = parsePlayerDto(entry);
      if (player !== null) players.push(player);
    }
  }

  return {
    ...readRoomSetup(record),
    id,
    name: typeof record["name"] === "string" ? record["name"] : "",
    gameId: typeof record["gameId"] === "string" ? record["gameId"] : "",
    players,
    maxPlayers: typeof record["maxPlayers"] === "number" ? record["maxPlayers"] : players.length,
    deadlineAt: typeof record["deadlineAt"] === "string" ? record["deadlineAt"] : null,
    timeLimitMs: typeof record["timeLimitMs"] === "number" ? record["timeLimitMs"] : 0,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : "",
  };
}

/**
 * Parses a `{ room, player, game }` envelope from create/join.
 *
 * @throws Error when any part is missing or malformed
 */
export function parseRoomJoin(payload: unknown): RoomJoinDto {
  const record = asRecord(payload);
  if (record === null) throw new Error("Server sent a session that is not an object");
  const player = parsePlayerDto(record["player"]);
  if (player === null) throw new Error("Server sent a join without a player");
  return { room: parseRoomDto(record["room"]), player, game: parseGameDto(record["game"]) };
}

/**
 * Parses a `{ room, game }` envelope (fetch/restart).
 *
 * @throws Error when any part is missing or malformed
 */
export function parseRoomEnvelope(payload: unknown): { readonly room: RoomDto; readonly game: GameDto } {
  const record = asRecord(payload);
  if (record === null) throw new Error("Server sent a room that is not an object");
  return { room: parseRoomDto(record["room"]), game: parseGameDto(record["game"]) };
}

/**
 * Parses a `{ rooms: [...] }` envelope.
 *
 * @throws Error when the payload is not a room list
 */
export function parseRoomList(payload: unknown): readonly RoomSummaryDto[] {
  const record = asRecord(payload);
  if (record === null || !Array.isArray(record["rooms"])) {
    throw new Error("Server sent an unexpected room list");
  }
  return record["rooms"].map(parseRoomSummary).filter((room): room is RoomSummaryDto => room !== null);
}

function parseRoomSummary(value: unknown): RoomSummaryDto | null {
  const record = asRecord(value);
  if (record === null) return null;
  const id = record["id"];
  const status = record["status"];
  if (typeof id !== "string" || typeof status !== "string" || !STATUSES.includes(status as GameStatus)) {
    return null;
  }
  return {
    ...readRoomSetup(record),
    id,
    name: typeof record["name"] === "string" ? record["name"] : "",
    gameId: typeof record["gameId"] === "string" ? record["gameId"] : "",
    playerCount: typeof record["playerCount"] === "number" ? record["playerCount"] : 0,
    maxPlayers: typeof record["maxPlayers"] === "number" ? record["maxPlayers"] : 0,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
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
      return {
        type: "welcome",
        game: parseGameDto(record["game"]),
        ...(record["room"] === undefined ? {} : { room: parseRoomDto(record["room"]) }),
        ...(typeof record["playerId"] === "string" ? { playerId: record["playerId"] } : {}),
      };
    case "update":
      return {
        type: "update",
        game: parseGameDto(record["game"]),
        events: parseEvents(record["events"]),
        ...(typeof record["actor"] === "string" ? { actor: record["actor"] } : {}),
        ...(typeof record["board"] === "string" ? { board: record["board"] } : {}),
      };
    case "room":
      return { type: "room", room: parseRoomDto(record["room"]) };
    case "cursor": {
      const playerId = record["playerId"];
      if (typeof playerId !== "string" || playerId.length === 0) return null;
      // A cell this client cannot read is treated as "not pointing": a marker
      // in the wrong place is worse than no marker at all.
      const cell = record["cell"];
      return { type: "cursor", playerId, cell: isVec3(cell) ? { x: cell.x, y: cell.y, z: cell.z } : null };
    }
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
const MATCH_MODES: readonly MatchMode[] = ["coop", "race", "survival"];
const DIFFICULTY_IDS: readonly DifficultyId[] = ["easy", "normal", "hard", "super-hard"];
const OUTCOMES: readonly PlayerOutcome[] = ["playing", "cleared", "out"];
const CELL_MARKS: readonly CellMark[] = ["none", "flag", "question"];

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
    typeof config["freeReveals"] === "number" &&
    typeof status === "string" &&
    STATUSES.includes(status as GameStatus) &&
    Array.isArray(record["cells"]) &&
    record["cells"].every(isClientCell) &&
    typeof record["revealedCount"] === "number" &&
    typeof record["flagCount"] === "number" &&
    typeof record["freeRevealsLeft"] === "number" &&
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
    typeof record["isQuestioned"] === "boolean" &&
    typeof record["isProbed"] === "boolean" &&
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
    case "markChanged":
      return isVec3(record["cell"]) && CELL_MARKS.includes(record["mark"] as CellMark);
    case "cellProbed":
      return isVec3(record["cell"]) && typeof record["hasMine"] === "boolean";
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
