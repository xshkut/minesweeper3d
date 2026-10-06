/**
 * Storage seam of the game service.
 *
 * A game is a small JSON document, so an in-memory `Map` is the right default:
 * no dependency, no setup, instant in tests. The interface exists so a durable
 * implementation (Redis with a TTL, Postgres, Cloudflare KV) can be dropped in
 * without touching the service or the routes - only `create`/`save` need to
 * touch I/O, and both are already called from a single place.
 */
import type { GameState } from "@minesweeper3d/game-core";

/**
 * A persisted game plus the bookkeeping the wire format needs.
 *
 * Treated as immutable: an update produces a new object, which is what makes
 * "did anything change?" checks and revision numbers reliable.
 */
export interface StoredGame {
  readonly id: string;
  readonly state: GameState;
  /**
   * Incremented once per accepted mutation; `0` right after creation. Clients
   * can compare revisions to drop out-of-order updates.
   */
  readonly revision: number;
  /** ISO 8601 timestamps, injected by the service so tests can pin them. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Optional identity of a new record; both fields default to host values. */
export interface GameRecordInit {
  readonly id?: string;
  /** Defaults to `new Date().toISOString()`. */
  readonly createdAt?: string;
}

/** Persistence port used by the game service. */
export interface GameStore {
  /** Stores a new record for `state`; throws when the id is already taken. */
  create(state: GameState, init?: GameRecordInit): StoredGame;
  /** The record with that id, or `undefined`. */
  get(id: string): StoredGame | undefined;
  /** Replaces an existing record; throws when it was never created. */
  save(game: StoredGame): StoredGame;
  /**
   * Installs an already-built record, replacing one with the same id.
   *
   * This is the hydration path, not a way to write games: it skips the
   * new/existing checks `create` and `save` enforce, and it must not be
   * observed as a change by a persistence layer (a restored record came from
   * the durable copy in the first place).
   */
  restore(game: StoredGame): StoredGame;
  /** @returns `true` when a record was removed */
  delete(id: string): boolean;
  /** Every record, in insertion order; the snapshot writer walks this. */
  list(): readonly StoredGame[];
  /** Number of stored games; useful for logging and tests. */
  readonly size: number;
}

/** Creates the default process-local store (one `Map`, no eviction yet). */
export function createInMemoryGameStore(): GameStore {
  const games = new Map<string, StoredGame>();

  return {
    create(state, init = {}) {
      const id = init.id ?? crypto.randomUUID();
      if (games.has(id)) throw new Error(`Game "${id}" already exists`);

      const createdAt = init.createdAt ?? new Date().toISOString();
      const game: StoredGame = { id, state, revision: 0, createdAt, updatedAt: createdAt };
      games.set(id, game);
      return game;
    },

    get(id) {
      return games.get(id);
    },

    save(game) {
      if (!games.has(game.id)) throw new Error(`Cannot save unknown game "${game.id}"`);
      games.set(game.id, game);
      return game;
    },

    restore(game) {
      games.set(game.id, game);
      return game;
    },

    delete(id) {
      return games.delete(id);
    },

    list() {
      return [...games.values()];
    },

    get size() {
      return games.size;
    },
  };
}
