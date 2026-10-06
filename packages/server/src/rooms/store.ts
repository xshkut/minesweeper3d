/**
 * In-memory storage of rooms.
 *
 * A room is the multiplayer unit: a short code players share, a match mode, and
 * the players currently seated in it. It owns the boards of the round - one
 * shared cube in co-op and survival, one private copy each in a race - which
 * keep living in the {@link import("../games/store").GameStore}, so the engine
 * never learns that rooms or modes exist.
 *
 * Records are immutable values, exactly like `StoredGame`: `save` replaces the
 * whole record, which makes "did anything change?" a reference comparison and
 * keeps a future database implementation a drop-in replacement.
 */
import type { DifficultyId, GameConfig, MatchMode, MatchStatus, RoomVisibility } from "@minesweeper3d/game-core";

/** How the current round ended for one player. */
export type PlayerOutcome = "playing" | "cleared" | "out";

/** One player seated in a room. */
export interface PlayerRecord {
  readonly id: string;
  readonly name: string;
  readonly joinedAt: string;
  /**
   * Number of open sockets for this player.
   *
   * Zero means the player is seated but away; presence is derived from this
   * number rather than stored as a flag, so a client with two tabs cannot make
   * itself disappear by closing one of them.
   */
  readonly connections: number;
  /**
   * Where the player stands in the round.
   *
   * `"cleared"` means they finished their board (in a race: they won it),
   * `"out"` means the round kicked them out - a detonated mine in survival, the
   * fatal click of a lost co-op round, or the clock running out.
   */
  readonly outcome: PlayerOutcome;
  /** When the outcome was decided; `null` while the player is still in the round. */
  readonly finishedAt: string | null;
  /**
   * Cells this player personally uncovered.
   *
   * The flood fill of one click can open dozens of cells, and they all count for
   * the player who clicked. On a shared board this is the contribution score;
   * on a private board it is the progress bar.
   */
  readonly revealedCount: number;
}

/** A room as it is stored. */
export interface RoomRecord {
  /** Shareable code, e.g. `"K7QP2M4XZB"`. Long enough that it cannot be guessed. */
  readonly id: string;
  readonly name: string;
  readonly mode: MatchMode;
  /**
   * Whether the lobby lists the room.
   *
   * A private room is unlisted, not locked: with no accounts, its code is the
   * whole of its access control, which is what the code's length is for.
   */
  readonly visibility: RoomVisibility;
  /**
   * Template every board of the current round is built from.
   *
   * It carries the round's seed, which is exactly what makes a race fair: every
   * player's copy of the cube is `createGame(room.config)`.
   */
  readonly config: GameConfig;
  /** Preset the board size came from, or `"custom"`; shown in the lobby list. */
  readonly presetId: string;
  /** Mine tier the room advertises; it is always derived from `config.mineCount`. */
  readonly difficultyId: DifficultyId;
  /** How the round as a whole is doing. */
  readonly status: MatchStatus;
  /** Bumped by every restart, so a client can tell two rounds apart. */
  readonly round: number;
  /** Board co-op and survival share, and the template board of a race. */
  readonly gameId: string;
  /** Race only: one private board per seated player, keyed by player id. */
  readonly boards: Readonly<Record<string, string>>;
  /** Co-op only: when the countdown ends; `null` until the first reveal starts it. */
  readonly deadlineAt: string | null;
  /** Co-op only: length of the countdown in milliseconds. */
  readonly timeLimitMs: number;
  readonly players: readonly PlayerRecord[];
  readonly maxPlayers: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Every board id a room points at: the shared board, then any private copies. */
export function boardIdsOf(room: RoomRecord): readonly string[] {
  return [room.gameId, ...Object.values(room.boards)];
}

/** Everything a room store must be able to do. */
export interface RoomStore {
  /**
   * Stores a new room.
   *
   * @throws Error when the id is already taken
   */
  create(room: RoomRecord): RoomRecord;
  get(id: string): RoomRecord | undefined;
  /**
   * Replaces an existing room.
   *
   * @throws Error when the room is unknown
   */
  save(room: RoomRecord): RoomRecord;
  /**
   * Installs an already-built record, replacing one with the same id.
   *
   * The hydration path: it skips the new/unknown checks `create` and `save`
   * enforce, and a persistence layer must not treat it as a change to write
   * back out (the record came from the durable copy).
   */
  restore(room: RoomRecord): RoomRecord;
  /** @returns `true` when a room was removed */
  delete(id: string): boolean;
  /** Every room, in insertion order. */
  list(): readonly RoomRecord[];
  readonly size: number;
}

/** Creates a store backed by a single `Map`, i.e. state that lives in memory only. */
export function createInMemoryRoomStore(): RoomStore {
  const rooms = new Map<string, RoomRecord>();

  return {
    create(room) {
      if (rooms.has(room.id)) throw new Error(`Room "${room.id}" already exists`);
      rooms.set(room.id, room);
      return room;
    },

    get(id) {
      return rooms.get(id);
    },

    save(room) {
      if (!rooms.has(room.id)) throw new Error(`Cannot save unknown room "${room.id}"`);
      rooms.set(room.id, room);
      return room;
    },

    restore(room) {
      rooms.set(room.id, room);
      return room;
    },

    delete(id) {
      return rooms.delete(id);
    },

    list() {
      return [...rooms.values()];
    },

    get size() {
      return rooms.size;
    },
  };
}
