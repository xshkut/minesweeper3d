/**
 * Service level tests: the engine transitions, the "nothing happened" fast path,
 * revision bookkeeping, subscribers and shutdown - all without any I/O.
 */
import { describe, expect, test } from "bun:test";
import {
  cellKey,
  isCellExposed,
  mineCells,
  vec3,
  type CellIndex,
  type GameState,
} from "@minesweeper3d/game-core";
import { GameNotFoundError, GameServiceClosedError, InvalidGameRequestError } from "../src/games/errors";
import { createGameService } from "../src/games/service";
import type { GameMutationResult, GameService } from "../src/games/service";
import { createInMemoryGameStore } from "../src/games/store";
import type { GameStore } from "../src/games/store";
import { silentLogger } from "./support";

interface Harness {
  readonly service: GameService;
  readonly store: GameStore;
}

/** A service with deterministic ids (`game-1`, ...) and a stepping clock. */
function makeService(): Harness {
  const store = createInMemoryGameStore();
  let ids = 0;
  let seconds = 0;

  const service = createGameService({
    store,
    logger: silentLogger(),
    generateId: () => `game-${(ids += 1)}`,
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds++)).toISOString(),
  });
  return { service, store };
}

/** Current state of a stored game, failing loudly when the id is unknown. */
function stateOf(store: GameStore, id: string): GameState {
  const game = store.get(id);
  if (game === undefined) throw new Error(`test expected game ${id} to exist`);
  return game.state;
}

/** Sorted mine positions, for layout comparisons. */
function mineKeys(state: GameState): string[] {
  return mineCells(state)
    .map((cell) => cellKey(cell))
    .sort();
}

/** Runs an operation that must throw and returns the error. */
function caught(operation: () => unknown): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`expected an Error, received ${String(error)}`);
  }
  throw new Error("expected the operation to throw");
}

/** Like {@link caught}, but narrows to the request-validation error. */
function caughtInvalid(operation: () => unknown): InvalidGameRequestError {
  const error = caught(operation);
  expect(error).toBeInstanceOf(InvalidGameRequestError);
  return error as InvalidGameRequestError;
}

/** First covered, unflagged cell that may be opened right now. */
function exposedCoveredCell(state: GameState): CellIndex {
  const cell = state.cells.find(
    (candidate) =>
      !candidate.isRevealed && !candidate.isFlagged && isCellExposed(state, candidate.index),
  );
  if (cell === undefined) throw new Error("test expected an exposed covered cell");
  return cell.index;
}

describe("createGame", () => {
  test("creates a game from a preset", () => {
    const { service, store } = makeService();
    const game = service.createGame({ presetId: "tiny" });

    expect(game.id).toBe("game-1");
    expect(game.revision).toBe(0);
    expect(game.createdAt).toBe(game.updatedAt);
    expect(game.state.status).toBe("ready");
    expect(game.state.config.size).toEqual(vec3(3, 3, 3));
    expect(game.state.config.mineCount).toBe(3);
    expect(game.state.cells).toHaveLength(27);
    expect(store.size).toBe(1);
  });

  test("falls back to the default preset and accepts an empty body", () => {
    const { service } = makeService();
    const game = service.createGame({});

    expect(game.state.config.size).toEqual(vec3(5, 5, 5));
    expect(game.state.config.mineCount).toBe(10);
  });

  test("accepts an explicit config", () => {
    const { service } = makeService();
    const game = service.createGame({
      config: { size: vec3(2, 2, 2), mineCount: 1, seed: 4, firstRevealSafe: false },
    });

    expect(game.state.cells).toHaveLength(8);
    expect(game.state.config.seed).toBe(4);
    expect(game.state.config.firstRevealSafe).toBe(false);
  });

  test("lets seed and firstRevealSafe override preset and config", () => {
    const { service } = makeService();
    const fromPreset = service.createGame({ presetId: "tiny", seed: 99, firstRevealSafe: false });
    expect(fromPreset.state.config.seed).toBe(99);
    expect(fromPreset.state.config.firstRevealSafe).toBe(false);

    const fromConfig = service.createGame({
      config: { size: vec3(2, 2, 2), mineCount: 1, seed: 1, firstRevealSafe: true },
      seed: 77,
      firstRevealSafe: false,
    });
    expect(fromConfig.state.config.seed).toBe(77);
    expect(fromConfig.state.config.firstRevealSafe).toBe(false);
  });

  test("lays out mines deterministically per seed", () => {
    const { service } = makeService();
    const first = service.createGame({ presetId: "tiny", seed: 4242 });
    const same = service.createGame({ presetId: "tiny", seed: 4242 });
    const other = service.createGame({ presetId: "tiny", seed: 4243 });

    expect(mineKeys(same.state)).toEqual(mineKeys(first.state));
    expect(mineKeys(other.state)).not.toEqual(mineKeys(first.state));
  });

  test("rejects a bad request with the engine's issue list", () => {
    const { service } = makeService();

    expect(caught(() => service.createGame("nope"))).toBeInstanceOf(InvalidGameRequestError);

    const badSeed = caughtInvalid(() => service.createGame({ seed: "soon" }));
    expect(badSeed.code).toBe("invalid_body");
    expect(badSeed.details.join(" ")).toContain("seed");

    const badSafe = caughtInvalid(() => service.createGame({ firstRevealSafe: "yes" }));
    expect(badSafe.details.join(" ")).toContain("firstRevealSafe");

    const badPresetId = caughtInvalid(() => service.createGame({ presetId: 7 }));
    expect(badPresetId.details.join(" ")).toContain("presetId");

    const badConfig = caughtInvalid(() =>
      service.createGame({ config: { size: vec3(0, 3, 3), mineCount: 3, seed: 1, firstRevealSafe: true } }),
    );
    expect(badConfig.code).toBe("invalid_config");
    expect(badConfig.details.join(" ")).toMatch(/size\.x/);
  });

  test("rejects an unknown preset with the known ids", () => {
    const { service } = makeService();

    try {
      service.createGame({ presetId: "gigantic" });
      throw new Error("expected createGame to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidGameRequestError);
      const invalid = error as InvalidGameRequestError;
      expect(invalid.code).toBe("unknown_preset");
      expect(invalid.details.join(" ")).toContain("tiny");
    }
  });
});

describe("actions", () => {
  test("reveals a cell, bumps the revision and reports events", () => {
    const { service, store } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });

    const result = service.reveal(created.id, vec3(0, 0, 0));

    expect(result.changed).toBe(true);
    expect(result.game.revision).toBe(1);
    expect(result.game.updatedAt).not.toBe(created.updatedAt);
    expect(store.get(created.id)).toBe(result.game);
    expect(stateOf(store, created.id).status).toBe("playing");

    const [event] = result.events;
    expect(event?.type).toBe("cellsRevealed");
    if (event?.type === "cellsRevealed") {
      expect(event.cells).toContainEqual(vec3(0, 0, 0));
      expect(event.cells.length).toBeGreaterThan(0);
    }
  });

  test("cycles a mark and reports the change", () => {
    const { service, store } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });
    service.reveal(created.id, vec3(0, 0, 0));

    const cell = exposedCoveredCell(stateOf(store, created.id));
    const flagged = service.cycleMark(created.id, cell);

    expect(flagged.changed).toBe(true);
    expect(flagged.events).toEqual([{ type: "markChanged", cell, mark: "flag" }]);
    expect(stateOf(store, created.id).flagCount).toBe(1);

    const questioned = service.cycleMark(created.id, cell);
    expect(questioned.events).toEqual([{ type: "markChanged", cell, mark: "question" }]);
    expect(stateOf(store, created.id).flagCount).toBe(0);

    const cleared = service.cycleMark(created.id, cell);
    expect(cleared.events).toEqual([{ type: "markChanged", cell, mark: "none" }]);
    expect(cleared.game.revision).toBe(4);
  });

  test("spends a free reveal and reports what it found", () => {
    const { service, store } = makeService();
    const created = service.createGame({
      config: { size: vec3(3, 3, 3), mineCount: 1, seed: 7, firstRevealSafe: false, freeReveals: 2 },
    });
    const mine = stateOf(store, created.id).cells.find((cell) => cell.hasMine);
    if (mine === undefined) throw new Error("expected a mine");

    const probed = service.probe(created.id, mine.index);

    expect(probed.changed).toBe(true);
    expect(probed.events).toEqual([{ type: "cellProbed", cell: mine.index, hasMine: true }]);
    expect(stateOf(store, created.id).freeRevealsLeft).toBe(1);

    // A second look at the same cube is a no-op, so no charge is wasted on it.
    const repeated = service.probe(created.id, mine.index);
    expect(repeated.changed).toBe(false);
    expect(repeated.events).toEqual([]);
    expect(repeated.game).toBe(probed.game);
  });

  test("carries free reveals from the request body", () => {
    const { service, store } = makeService();

    const fromPreset = service.createGame({ presetId: "tiny", seed: 1, freeReveals: 2 });
    expect(stateOf(store, fromPreset.id).config.freeReveals).toBe(2);
    expect(stateOf(store, fromPreset.id).freeRevealsLeft).toBe(2);

    const fromConfig = service.createGame({
      config: { size: vec3(3, 3, 3), mineCount: 1, seed: 1, firstRevealSafe: true, minesFatal: true, freeReveals: 1 },
    });
    expect(stateOf(store, fromConfig.id).config.freeReveals).toBe(1);

    // The body wins over the config it is sent with, like `seed` does.
    const overridden = service.createGame({
      config: { size: vec3(3, 3, 3), mineCount: 1, seed: 1, firstRevealSafe: true, minesFatal: true, freeReveals: 5 },
      freeReveals: 3,
    });
    expect(stateOf(store, overridden.id).config.freeReveals).toBe(3);
  });

  test("rejects a free reveal count the engine cannot use", () => {
    const { service } = makeService();

    expect(() => service.createGame({ presetId: "tiny", freeReveals: -1 })).toThrow(InvalidGameRequestError);
    expect(() => service.createGame({ presetId: "tiny", freeReveals: 1.5 })).toThrow(InvalidGameRequestError);
    expect(() => service.createGame({ presetId: "tiny", freeReveals: "2" })).toThrow(InvalidGameRequestError);
    // The engine's own bound: a tiny board has 27 cells, so 28 charges cannot be used.
    expect(() => service.createGame({ presetId: "tiny", freeReveals: 28 })).toThrow(InvalidGameRequestError);
  });

  test("ignored actions keep the same game object and change nothing", () => {
    const { service, store } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });
    const revealed = service.reveal(created.id, vec3(0, 0, 0));
    const before = revealed.game;

    // Same cell twice is a no-op in the engine: identical state, no events.
    const repeated = service.reveal(created.id, vec3(0, 0, 0));
    expect(repeated.changed).toBe(false);
    expect(repeated.events).toEqual([]);
    expect(repeated.game).toBe(before);
    expect(repeated.game.revision).toBe(1);
    expect(repeated.game.updatedAt).toBe(before.updatedAt);
    expect(store.get(created.id)).toBe(before);

    // A cell far outside the board is ignored as well, not an error.
    const outside = service.reveal(created.id, vec3(99, 99, 99));
    expect(outside.changed).toBe(false);
    expect(outside.game).toBe(before);
  });

  test("rejects malformed cells without touching the game", () => {
    const { service, store } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1 });

    for (const bad of [undefined, null, "0,0,0", { x: 0, y: 0 }, { x: 0.5, y: 0, z: 0 }, { x: "0", y: 0, z: 0 }]) {
      expect(() => service.reveal(created.id, bad)).toThrow(InvalidGameRequestError);
      expect(() => service.cycleMark(created.id, bad)).toThrow(InvalidGameRequestError);
      expect(() => service.probe(created.id, bad)).toThrow(InvalidGameRequestError);
    }
    expect(store.get(created.id)?.revision).toBe(0);
  });

  test("reports unknown games with a typed error", () => {
    const { service } = makeService();

    expect(() => service.getGame("missing")).toThrow(GameNotFoundError);
    expect(() => service.reveal("missing", vec3(0, 0, 0))).toThrow(GameNotFoundError);
    expect(() => service.cycleMark("missing", vec3(0, 0, 0))).toThrow(GameNotFoundError);
    expect(() => service.probe("missing", vec3(0, 0, 0))).toThrow(GameNotFoundError);
  });

  test("reports gameWon once every safe cell is revealed", () => {
    const { service, store } = makeService();
    const created = service.createGame({
      config: { size: vec3(2, 2, 2), mineCount: 1, seed: 7, firstRevealSafe: false },
    });

    let last: GameMutationResult | undefined;
    for (const cell of stateOf(store, created.id).cells) {
      if (cell.hasMine) continue;
      last = service.reveal(created.id, cell.index);
    }

    expect(stateOf(store, created.id).status).toBe("won");
    expect(last?.events.some((event) => event.type === "gameWon")).toBe(true);
  });
});

describe("subscribers", () => {
  test("notify on accepted mutations and stop after unsubscribe", () => {
    const { service, store } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });
    const seen: GameMutationResult[] = [];
    const unsubscribe = service.subscribe(created.id, (result) => seen.push(result));

    service.reveal(created.id, vec3(0, 0, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.game.revision).toBe(1);
    expect(seen[0]?.events.length).toBeGreaterThan(0);

    // Ignored actions must not wake subscribers up.
    service.reveal(created.id, vec3(0, 0, 0));
    expect(seen).toHaveLength(1);

    unsubscribe();
    const cell = exposedCoveredCell(stateOf(store, created.id));
    service.cycleMark(created.id, cell);
    expect(seen).toHaveLength(1);
  });

  test("a throwing listener cannot break the action", () => {
    const { service } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });
    const seen: number[] = [];

    service.subscribe(created.id, () => {
      throw new Error("listener exploded");
    });
    service.subscribe(created.id, (result) => seen.push(result.game.revision));

    const result = service.reveal(created.id, vec3(0, 0, 0));
    expect(result.changed).toBe(true);
    expect(seen).toEqual([1]);
  });

  test("only notify subscribers of the affected game", () => {
    const { service } = makeService();
    const first = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });
    const second = service.createGame({ presetId: "tiny", seed: 2, firstRevealSafe: true });
    const seen: string[] = [];

    service.subscribe(first.id, () => seen.push("first"));
    service.subscribe(second.id, () => seen.push("second"));

    service.reveal(first.id, vec3(0, 0, 0));
    expect(seen).toEqual(["first"]);
  });
});

describe("close", () => {
  test("drops subscribers and rejects further mutations", () => {
    const { service } = makeService();
    const created = service.createGame({ presetId: "tiny", seed: 1, firstRevealSafe: true });
    const seen: GameMutationResult[] = [];
    const unsubscribe = service.subscribe(created.id, (result) => seen.push(result));

    expect(service.closed).toBe(false);
    service.close();
    expect(service.closed).toBe(true);

    expect(() => service.reveal(created.id, vec3(0, 0, 0))).toThrow(GameServiceClosedError);
    expect(() => service.createGame({})).toThrow(GameServiceClosedError);
    expect(seen).toHaveLength(0);

    // Idempotent, and unsubscribing after shutdown is harmless.
    service.close();
    expect(() => unsubscribe()).not.toThrow();
    expect(() => service.subscribe(created.id, () => undefined)()).not.toThrow();
  });
});
