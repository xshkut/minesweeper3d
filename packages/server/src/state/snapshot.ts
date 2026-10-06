/**
 * The on-disk shape of the server's state, and the two directions across it.
 *
 * Rooms and games are already plain immutable records, so "persisting" is just
 * projecting them into one JSON document and reading it back. Two rules make
 * that safe:
 *
 *  - **Never trust the file.** It is a temporary file on a shared machine: it
 *    can be truncated by a crash, hand-edited, or left behind by an older
 *    build. Every record is re-validated through the engine's own parsers, and
 *    a bad record is reported and left out rather than taken down the process.
 *  - **Live state is not written down.** A player's socket count belongs to the
 *    running process; after a restart it is a lie, so it is projected away on
 *    write and forced to zero on read. The tier a room advertises is
 *    re-derived from its mine count for the same reason: a stale copy of a
 *    derived value is a mislabelled board.
 */
import { difficultyOf, isMatchMode, isMatchStatus, isRoomVisibility, parseGameConfig, parseGameState } from "@minesweeper3d/game-core";
import type { GameConfig } from "@minesweeper3d/game-core";
import { isRecord } from "../games/requests";
import type { GameStore, StoredGame } from "../games/store";
import { boardIdsOf } from "../rooms/store";
import type { PlayerOutcome, PlayerRecord, RoomRecord, RoomStore } from "../rooms/store";

/**
 * Version of the document {@link buildSnapshot} writes.
 *
 * A reader refuses anything else instead of guessing at an older layout: the
 * file is a cache of live state, so the safe answer to "I do not understand
 * this" is to start empty.
 */
export const STATE_SCHEMA_VERSION = 1;

/** The whole persisted state: every board, every room. */
export interface StateSnapshot {
  readonly version: number;
  readonly savedAt: string;
  readonly games: readonly StoredGame[];
  readonly rooms: readonly RoomRecord[];
}

/** Where the two stores live; both are only read. */
export interface StateSource {
  readonly games: GameStore;
  readonly rooms: RoomStore;
}

/** What a state file turned into, plus what had to be left out. */
export interface LoadedState {
  /** When the snapshot was written, when the file said so. */
  readonly savedAt: string | undefined;
  readonly games: readonly StoredGame[];
  readonly rooms: readonly RoomRecord[];
  /** One human-readable reason per record that was dropped. */
  readonly skipped: readonly string[];
}

/** Thrown when the file as a whole is unusable (not JSON, wrong version). */
export class InvalidStateSnapshotError extends Error {
  override readonly name = "InvalidStateSnapshotError";

  constructor(message: string) {
    super(message);
  }
}

const PLAYER_OUTCOMES: readonly PlayerOutcome[] = ["playing", "cleared", "out"];

function isPlayerOutcome(value: unknown): value is PlayerOutcome {
  return typeof value === "string" && PLAYER_OUTCOMES.some((outcome) => outcome === value);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requireCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
  return value;
}

/** A timestamp is kept as the string it was; only its readability is checked. */
function requireTimestamp(value: unknown, path: string): string {
  const timestamp = requireString(value, path);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`${path} must be an ISO 8601 timestamp`);
  return timestamp;
}

function optionalTimestamp(value: unknown, path: string): string | undefined {
  return value === undefined || value === null ? undefined : requireTimestamp(value, path);
}

function requireNullableTimestamp(value: unknown, path: string): string | null {
  return value === undefined || value === null ? null : requireTimestamp(value, path);
}

/**
 * A room as it is written to disk.
 *
 * Only presence is projected away: a socket count describes the process that
 * wrote the file, not the room.
 */
export function toStoredRoom(room: RoomRecord): RoomRecord {
  return {
    ...room,
    players: room.players.map((player) => ({ ...player, connections: 0 })),
  };
}

/** Projects the live stores into the document that gets written. */
export function buildSnapshot(source: StateSource, savedAt: string): StateSnapshot {
  return {
    version: STATE_SCHEMA_VERSION,
    savedAt,
    games: source.games.list(),
    rooms: source.rooms.list().map(toStoredRoom),
  };
}

/** Serialises a snapshot; the result is what lands in the file. */
export function serializeSnapshot(snapshot: StateSnapshot): string {
  return JSON.stringify(snapshot);
}

/** One parsed record, or the reason it could not be trusted. */
type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

function attempt<T>(parse: () => T): Parsed<T> {
  try {
    return { ok: true, value: parse() };
  } catch (error) {
    return { ok: false, reason: messageOf(error) };
  }
}

function parseStoredGame(raw: unknown, path: string): StoredGame {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  return {
    id: requireString(raw["id"], `${path}.id`),
    // The engine's parser is the only thing that knows what a playable state is.
    state: parseGameState(raw["state"]),
    revision: requireCount(raw["revision"], `${path}.revision`),
    createdAt: requireTimestamp(raw["createdAt"], `${path}.createdAt`),
    updatedAt: requireTimestamp(raw["updatedAt"], `${path}.updatedAt`),
  };
}

function parsePlayer(raw: unknown, path: string): PlayerRecord {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const outcome = raw["outcome"];
  if (!isPlayerOutcome(outcome)) {
    throw new Error(`${path}.outcome must be one of ${PLAYER_OUTCOMES.join(", ")} (got ${String(outcome)})`);
  }
  return {
    id: requireString(raw["id"], `${path}.id`),
    name: requireString(raw["name"], `${path}.name`),
    joinedAt: requireTimestamp(raw["joinedAt"], `${path}.joinedAt`),
    // Presence is per-process: nobody is connected yet, whatever the file says.
    connections: 0,
    outcome,
    finishedAt: requireNullableTimestamp(raw["finishedAt"], `${path}.finishedAt`),
    revealedCount: requireCount(raw["revealedCount"], `${path}.revealedCount`),
  };
}

function parseBoards(raw: unknown, path: string): Readonly<Record<string, string>> {
  if (raw === undefined || raw === null) return {};
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);
  const boards: Record<string, string> = {};
  for (const [playerId, boardId] of Object.entries(raw)) {
    boards[playerId] = requireString(boardId, `${path}.${playerId}`);
  }
  return boards;
}

function parseRoom(raw: unknown, path: string): RoomRecord {
  if (!isRecord(raw)) throw new Error(`${path} must be an object`);

  const mode = raw["mode"];
  if (!isMatchMode(mode)) throw new Error(`${path}.mode must be one of coop, race, survival (got ${String(mode)})`);

  const visibility = raw["visibility"];
  if (!isRoomVisibility(visibility)) {
    throw new Error(`${path}.visibility must be one of public, private (got ${String(visibility)})`);
  }

  const status = raw["status"];
  if (!isMatchStatus(status)) {
    throw new Error(`${path}.status must be one of ready, playing, won, lost (got ${String(status)})`);
  }

  const config = parseStoredGameConfig(raw["config"], `${path}.config`);
  const players = parsePlayers(raw["players"], `${path}.players`);
  const maxPlayers = requireCount(raw["maxPlayers"], `${path}.maxPlayers`);
  if (maxPlayers < 1) throw new Error(`${path}.maxPlayers must be at least 1`);
  if (players.length > maxPlayers) {
    throw new Error(`${path}.players holds ${players.length} seats but maxPlayers is ${maxPlayers}`);
  }

  return {
    id: requireString(raw["id"], `${path}.id`),
    name: requireString(raw["name"], `${path}.name`),
    mode,
    visibility,
    config,
    presetId: requireString(raw["presetId"], `${path}.presetId`),
    // Derived, never believed: a stored tier that disagreed with the mine count
    // would mislabel the board in the lobby.
    difficultyId: difficultyOf(config.size, config.mineCount).id,
    status,
    round: requireCount(raw["round"], `${path}.round`),
    gameId: requireString(raw["gameId"], `${path}.gameId`),
    boards: parseBoards(raw["boards"], `${path}.boards`),
    deadlineAt: requireNullableTimestamp(raw["deadlineAt"], `${path}.deadlineAt`),
    timeLimitMs: requireCount(raw["timeLimitMs"], `${path}.timeLimitMs`),
    players,
    maxPlayers,
    createdAt: requireTimestamp(raw["createdAt"], `${path}.createdAt`),
    updatedAt: requireTimestamp(raw["updatedAt"], `${path}.updatedAt`),
  };
}

/** The engine validates the config; the wrapper only names the path in errors. */
function parseStoredGameConfig(raw: unknown, path: string): GameConfig {
  try {
    return parseGameConfig(raw);
  } catch (error) {
    throw new Error(`${path} is not a valid game config (${messageOf(error)})`);
  }
}

function parsePlayers(raw: unknown, path: string): readonly PlayerRecord[] {
  if (!Array.isArray(raw)) throw new Error(`${path} must be an array`);
  if (raw.length === 0) throw new Error(`${path} must hold at least one player`);
  const players = raw.map((entry, index) => parsePlayer(entry, `${path}[${index}]`));
  const seen = new Set<string>();
  for (const player of players) {
    if (seen.has(player.id)) throw new Error(`${path} seats player ${player.id} twice`);
    seen.add(player.id);
  }
  return players;
}

/**
 * Reads a state file.
 *
 * @throws InvalidStateSnapshotError when the document as a whole is unusable;
 * individual bad records are reported in `skipped` instead.
 */
export function parseStateSnapshot(text: string): LoadedState {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new InvalidStateSnapshotError(`state file is not JSON (${messageOf(error)})`);
  }
  if (!isRecord(raw)) throw new InvalidStateSnapshotError("state file must hold a JSON object");
  if (raw["version"] !== STATE_SCHEMA_VERSION) {
    throw new InvalidStateSnapshotError(
      `state file is version ${String(raw["version"])}, this build reads and writes ${STATE_SCHEMA_VERSION}`,
    );
  }

  const savedAt = optionalTimestamp(raw["savedAt"], "savedAt");
  const skipped: string[] = [];

  const rawGames = raw["games"];
  if (!Array.isArray(rawGames)) throw new InvalidStateSnapshotError("state file must hold a games array");
  const games: StoredGame[] = [];
  const gameIds = new Set<string>();
  rawGames.forEach((entry, index) => {
    const parsed = attempt(() => parseStoredGame(entry, `games[${index}]`));
    if (!parsed.ok) {
      skipped.push(parsed.reason);
      return;
    }
    if (gameIds.has(parsed.value.id)) {
      skipped.push(`games[${index}] repeats game ${parsed.value.id}`);
      return;
    }
    gameIds.add(parsed.value.id);
    games.push(parsed.value);
  });

  const rawRooms = raw["rooms"];
  if (!Array.isArray(rawRooms)) throw new InvalidStateSnapshotError("state file must hold a rooms array");
  const rooms: RoomRecord[] = [];
  const roomIds = new Set<string>();
  rawRooms.forEach((entry, index) => {
    const parsed = attempt(() => parseRoom(entry, `rooms[${index}]`));
    if (!parsed.ok) {
      skipped.push(parsed.reason);
      return;
    }
    const room = parsed.value;
    if (roomIds.has(room.id)) {
      skipped.push(`rooms[${index}] repeats room ${room.id}`);
      return;
    }
    // A room whose boards are gone cannot be played, and silently falling back
    // to the shared board would hand two racers the same cube.
    const missing = boardIdsOf(room).filter((boardId) => !gameIds.has(boardId));
    if (missing.length > 0) {
      skipped.push(`rooms[${index}] points at missing board ${missing[0]}`);
      return;
    }
    roomIds.add(room.id);
    rooms.push(room);
  });

  return { savedAt, games, rooms, skipped };
}
