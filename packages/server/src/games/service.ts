/**
 * The game service: the only place that mutates games.
 *
 * It applies pure engine transitions to stored state, skips all work when the
 * engine reports "nothing happened" (identity check on the state object), bumps
 * the revision only for real changes and fans the result out to subscribers -
 * which is the seam the WebSocket hub plugs into. Storage, clock and id
 * generation are injected, so the service is deterministic under test and can
 * be moved to Redis/Postgres by swapping the store.
 */
import { createGame, formatVec3, revealCell, toggleFlag } from "@minesweeper3d/game-core";
import type { GameConfig, GameEvent } from "@minesweeper3d/game-core";
import type { Logger } from "../logger";
import { GameNotFoundError, GameServiceClosedError, InvalidGameRequestError } from "./errors";
import { isRecord, parseCell, readCreateOptions, resolveConfig } from "./requests";
import type { GameStore, StoredGame } from "./store";

/** Body of `POST /api/games`, all fields optional. */
export interface CreateGameRequest {
  /** Preset id; ignored when `config` is present. Defaults to the "classic" preset. */
  readonly presetId?: string;
  /** Overrides the seed of the preset or the explicit config. */
  readonly seed?: number;
  /** Overrides the "first reveal is safe" rule. */
  readonly firstRevealSafe?: boolean;
  /** Full rules config; wins over `presetId` when present. */
  readonly config?: GameConfig;
}

/** Outcome of a mutating action. */
export interface GameMutationResult {
  /** The stored game after the action (unchanged when `changed` is `false`). */
  readonly game: StoredGame;
  /** Events the engine reported; empty when the action was ignored. */
  readonly events: readonly GameEvent[];
  /** `false` when the engine returned the very same state, i.e. a no-op. */
  readonly changed: boolean;
}

/** Receives every accepted mutation of one game. */
export type GameListener = (result: GameMutationResult) => void;

/** Injected collaborators; all optional ones have sensible defaults. */
export interface GameServiceDependencies {
  readonly store: GameStore;
  readonly logger: Logger;
  /** ISO timestamp source; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** Id source; defaults to `crypto.randomUUID()`. */
  readonly generateId?: () => string;
}

/** Public surface of the games module. */
export interface GameService {
  /** Creates a game from a preset and/or an explicit config; throws on bad input. */
  createGame(request: unknown): StoredGame;
  /** @throws GameNotFoundError when the id is unknown */
  getGame(id: string): StoredGame;
  /** Reveals a cell; a no-op transition is neither persisted nor broadcast. */
  reveal(id: string, cell: unknown): GameMutationResult;
  /** Toggles a flag; a no-op transition is neither persisted nor broadcast. */
  toggleFlag(id: string, cell: unknown): GameMutationResult;
  /**
   * Registers a listener for accepted mutations of one game.
   *
   * @returns an idempotent unsubscribe function
   */
  subscribe(id: string, listener: GameListener): () => void;
  /** Drops every subscriber and rejects further mutations; idempotent. */
  close(): void;
  /** `true` once {@link GameService.close} ran. */
  readonly closed: boolean;
}

/** Creates the service. */
export function createGameService(dependencies: GameServiceDependencies): GameService {
  const { store, logger } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const generateId = dependencies.generateId ?? (() => crypto.randomUUID());
  const subscribers = new Map<string, Set<GameListener>>();
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new GameServiceClosedError();
  };

  const notify = (id: string, result: GameMutationResult): void => {
    const listeners = subscribers.get(id);
    if (listeners === undefined) return;
    // Copy: a listener may unsubscribe itself while being notified.
    for (const listener of [...listeners]) {
      try {
        listener(result);
      } catch (error) {
        logger.warn("game subscriber failed", { gameId: id, error });
      }
    }
  };

  const getGame = (id: string): StoredGame => {
    const game = store.get(id);
    if (game === undefined) throw new GameNotFoundError(id);
    return game;
  };

  const mutate = (id: string, action: "reveal" | "flag", cell: unknown): GameMutationResult => {
    assertOpen();
    const game = getGame(id);
    const index = parseCell(cell);
    const transition = action === "reveal" ? revealCell(game.state, index) : toggleFlag(game.state, index);

    if (transition.state === game.state) {
      logger.debug("action ignored", {
        gameId: id,
        action,
        cell: formatVec3(index),
        status: game.state.status,
      });
      return { game, events: [], changed: false };
    }

    const next = store.save({
      ...game,
      state: transition.state,
      revision: game.revision + 1,
      updatedAt: now(),
    });
    const result: GameMutationResult = { game: next, events: transition.events, changed: true };
    logger.debug("action applied", {
      gameId: id,
      action,
      cell: formatVec3(index),
      revision: next.revision,
      events: transition.events.length,
    });
    notify(id, result);
    return result;
  };

  return {
    createGame(request) {
      assertOpen();
      if (!isRecord(request)) {
        throw new InvalidGameRequestError("invalid_body", "Request body must be a JSON object");
      }

      const options = readCreateOptions(request);
      const { config, presetId } = resolveConfig(request, options);
      const game = store.create(createGame(config), { id: generateId(), createdAt: now() });

      logger.info("game created", {
        gameId: game.id,
        presetId: presetId ?? "custom",
        size: `${config.size.x}x${config.size.y}x${config.size.z}`,
        mineCount: config.mineCount,
        seed: config.seed,
      });
      return game;
    },

    getGame,

    reveal(id, cell) {
      return mutate(id, "reveal", cell);
    },

    toggleFlag(id, cell) {
      return mutate(id, "flag", cell);
    },

    subscribe(id, listener) {
      if (closed) return () => undefined;
      let listeners = subscribers.get(id);
      if (listeners === undefined) {
        listeners = new Set();
        subscribers.set(id, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(id);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      subscribers.clear();
      logger.debug("game service closed", { games: store.size });
    },

    get closed() {
      return closed;
    },
  };
}
