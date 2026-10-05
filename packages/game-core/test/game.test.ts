import { describe, expect, it } from "bun:test";
import {
  cellAt,
  createConfig,
  createGame,
  InvalidGameStateError,
  mineCells,
  remainingMineCount,
  revealCell,
  toggleFlag,
  toClientView,
  vec3,
} from "../src/index";
import { at, cell, eventTypes, game, gameWithMines, snapshot } from "./helpers";

describe("flags", () => {
  it("toggles on and off and keeps the counter in sync", () => {
    const state = game(vec3(3, 3, 3), 2, { seed: 1 });

    const flagged = toggleFlag(state, at(0, 0, 0));
    expect(flagged.state.flagCount).toBe(1);
    expect(cell(flagged.state, 0, 0, 0).isFlagged).toBe(true);
    expect(eventTypes(flagged.events)).toEqual(["flagChanged"]);
    expect(flagged.events[0]).toEqual({ type: "flagChanged", cell: at(0, 0, 0), flagged: true });
    expect(remainingMineCount(flagged.state)).toBe(1);

    const unflagged = toggleFlag(flagged.state, at(0, 0, 0));
    expect(unflagged.state.flagCount).toBe(0);
    expect(cell(unflagged.state, 0, 0, 0).isFlagged).toBe(false);
    expect(remainingMineCount(unflagged.state)).toBe(2);
  });

  it("does not start the clock", () => {
    const flagged = toggleFlag(game(vec3(3, 3, 3), 2, { seed: 1 }), at(0, 0, 0)).state;
    expect(flagged.status).toBe("ready");
  });

  it("protects a cell from being revealed", () => {
    const state = toggleFlag(gameWithMines(vec3(3, 3, 3), [at(2, 2, 2)]), at(2, 2, 2)).state;
    const transition = revealCell(state, at(2, 2, 2));

    expect(transition.state).toBe(state);
    expect(transition.state.status).toBe("ready");
  });

  it("is ignored on revealed cells and after the game is over", () => {
    const revealed = revealCell(gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)]), at(0, 0, 1)).state;
    expect(toggleFlag(revealed, at(0, 0, 1)).state).toBe(revealed);

    const lost = revealCell(
      gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)], { firstRevealSafe: false }),
      at(0, 0, 0),
    ).state;
    expect(toggleFlag(lost, at(1, 1, 1)).state).toBe(lost);
  });

  it("is ignored outside the board", () => {
    const state = game(vec3(3, 3, 3), 2, { seed: 1 });
    expect(toggleFlag(state, at(9, 9, 9)).state).toBe(state);
  });

  it("allows more flags than mines", () => {
    const state = game(vec3(3, 3, 3), 1, { seed: 1 });
    const over = [
      at(0, 0, 1),
      at(0, 1, 0),
      at(1, 0, 0),
    ].reduce((current, position) => toggleFlag(current, position).state, state);

    expect(over.flagCount).toBe(3);
    expect(remainingMineCount(over)).toBe(-2);
  });
});

describe("state handling", () => {
  it("never mutates the state it is given", () => {
    const state = game(vec3(4, 4, 4), 8, { seed: 12 });
    const before = snapshot(state);

    const afterReveal = revealCell(state, at(0, 0, 0));
    const afterFlag = toggleFlag(afterReveal.state, at(3, 3, 3));

    expect(snapshot(state)).toBe(before);
    expect(afterReveal.state).not.toBe(state);
    expect(afterFlag.state).not.toBe(afterReveal.state);
  });

  it("returns the very same state for ignored actions", () => {
    const state = game(vec3(3, 3, 3), 2, { seed: 1 });
    expect(revealCell(state, at(1, 1, 1)).state).toBe(state);
    expect(revealCell(state, at(-1, 0, 0)).state).toBe(state);
    expect(toggleFlag(state, at(-1, 0, 0)).state).toBe(state);
  });

  it("answers cell lookups inside and outside the board", () => {
    const state = game(vec3(2, 2, 2), 1, { seed: 1 });
    expect(cellAt(state, at(1, 1, 1))?.index).toEqual(at(1, 1, 1));
    expect(cellAt(state, at(2, 0, 0))).toBeUndefined();
  });
});

describe("client view", () => {
  it("hides the mine layout while the game runs", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(2, 2, 2)]);
    const started = revealCell(state, at(0, 0, 1)).state;
    const view = toClientView(started);

    expect(view.cells.filter((entry) => entry.hasMine)).toHaveLength(0);
    expect(view.cells).toHaveLength(27);
    expect(view.status).toBe("playing");
    expect(view.config).toEqual(started.config);
  });

  it("reveals the layout once the game is over", () => {
    const lost = revealCell(
      gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(2, 2, 2)], { firstRevealSafe: false }),
      at(0, 0, 0),
    ).state;
    const view = toClientView(lost);

    expect(view.cells.filter((entry) => entry.hasMine)).toHaveLength(2);
    expect(view.status).toBe("lost");
    expect(view.explodedAt).toEqual(at(0, 0, 0));
  });

  it("hides the danger count of covered cells as well", () => {
    // Mines in one corner, so plenty of cells carry a non-zero count.
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(0, 0, 1), at(0, 1, 0)]);
    const started = revealCell(state, at(2, 2, 2)).state;
    const view = toClientView(started);

    const covered = view.cells.filter((entry) => !entry.isRevealed);
    expect(covered.length).toBeGreaterThan(0);
    expect(covered.every((entry) => entry.adjacentMines === 0)).toBe(true);

    // The full state still knows the real counts.
    expect(started.cells.some((entry) => entry.adjacentMines > 0)).toBe(true);

    // Revealed cells report their count, which is what the renderer draws.
    const revealed = view.cells.filter((entry) => entry.isRevealed);
    expect(revealed.some((entry) => entry.adjacentMines > 0)).toBe(true);
  });

  it("keeps the counters and flags of the full state", () => {
    const state = toggleFlag(game(vec3(3, 3, 3), 2, { seed: 1 }), at(0, 0, 0)).state;
    const view = toClientView(state);

    expect(view.flagCount).toBe(state.flagCount);
    expect(view.revealedCount).toBe(state.revealedCount);
    expect(view.cells.filter((entry) => entry.isFlagged)).toHaveLength(1);
  });
});

describe("exposed helpers", () => {
  it("lists the mines of a board", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(2, 2, 2)]);
    expect(mineCells(state)).toHaveLength(2);
  });

  it("creates configs with a random seed by default", () => {
    const first = createConfig({ size: vec3(3, 3, 3), mineCount: 1 });
    const second = createConfig({ size: vec3(3, 3, 3), mineCount: 1 });

    expect(first.seed).not.toBe(second.seed);
    expect(first.firstRevealSafe).toBe(true);
  });

  it("rejects configs that cannot produce a playable board", () => {
    // Eight mines on eight cells would leave nothing to open.
    expect(() =>
      createGame({ size: vec3(2, 2, 2), mineCount: 8, seed: 1, firstRevealSafe: true }),
    ).toThrow(InvalidGameStateError);
    // Seven mines on eight cells is the smallest playable board.
    expect(
      createGame({ size: vec3(2, 2, 2), mineCount: 7, seed: 1, firstRevealSafe: true }).cells,
    ).toHaveLength(8);
  });
});
