import { describe, expect, it } from "bun:test";
import { createGame, isFinished, mineCells, revealCell, toClientView, vec3 } from "../src/index";
import type { CellIndex, GameState } from "../src/index";
import { at, cell, gameWithMines, revealedKeys } from "./helpers";

const ORIGIN = at(0, 0, 0);
const FAR = at(2, 2, 2);

/** Mines are fatal unless a test says otherwise. */
function nonFatal(mines: readonly CellIndex[], size = vec3(3, 3, 3)): GameState {
  return gameWithMines(size, mines, { minesFatal: false });
}

describe("non-fatal mines", () => {
  it("uncovers the mine and keeps the game running", () => {
    const before = nonFatal([ORIGIN]);
    const { state, events } = revealCell(before, ORIGIN);

    expect(state.status).toBe("playing");
    expect(isFinished(state)).toBe(false);
    expect(cell(state, 0, 0, 0).isRevealed).toBe(true);
    expect(state.explodedAt).toEqual(ORIGIN);
    expect(events).toEqual([{ type: "mineExploded", cell: ORIGIN }]);
  });

  it("does not count the mine as a cleared cell", () => {
    const { state } = revealCell(nonFatal([ORIGIN]), ORIGIN);
    // `revealedCount` tracks mine-free cells only, which is what the win
    // condition compares against.
    expect(state.revealedCount).toBe(0);
  });

  it("leaves the other mines covered", () => {
    const { state } = revealCell(nonFatal([ORIGIN, FAR]), ORIGIN);

    expect(revealedKeys(state)).toEqual(["0,0,0"]);
    expect(cell(state, 2, 2, 2).isRevealed).toBe(false);
    expect(mineCells(state)).toHaveLength(2);
  });

  it("ignores a second click on a mine that already went off", () => {
    const { state } = revealCell(nonFatal([ORIGIN]), ORIGIN);
    const again = revealCell(state, ORIGIN);

    expect(again.state).toBe(state);
    expect(again.events).toEqual([]);
  });

  it("still ends the game when mines are fatal", () => {
    const fatal = gameWithMines(vec3(3, 3, 3), [ORIGIN, FAR]);
    const { state, events } = revealCell(fatal, ORIGIN);

    expect(state.status).toBe("lost");
    expect(events.map((event) => event.type)).toEqual(["mineExploded", "minesRevealed", "gameLost"]);
    expect(revealedKeys(state)).toEqual(["0,0,0", "2,2,2"]);
  });

  it("can still be won after a mine went off", () => {
    let state = nonFatal([ORIGIN], vec3(2, 2, 2));
    ({ state } = revealCell(state, ORIGIN));
    expect(state.status).toBe("playing");

    for (let x = 0; x < 2; x += 1) {
      for (let y = 0; y < 2; y += 1) {
        for (let z = 0; z < 2; z += 1) {
          if (x === 0 && y === 0 && z === 0) continue;
          ({ state } = revealCell(state, at(x, y, z)));
        }
      }
    }

    expect(state.status).toBe("won");
    expect(state.revealedCount).toBe(7);
  });

  it("shows the spent mine to everyone while play continues", () => {
    const { state } = revealCell(nonFatal([ORIGIN, FAR]), ORIGIN);
    const view = toClientView(state);

    const spent = view.cells.find((entry) => entry.index.x === 0 && entry.index.y === 0 && entry.index.z === 0);
    expect(spent?.hasMine).toBe(true);
    expect(spent?.isRevealed).toBe(true);

    // Covered cells keep hiding their mine, exactly as in a fatal game.
    const hidden = view.cells.find((entry) => entry.index.x === 2 && entry.index.y === 2 && entry.index.z === 2);
    expect(hidden?.hasMine).toBe(false);
    expect(hidden?.isRevealed).toBe(false);
  });

  it("lets the safe opening rule win over a non-fatal mine", () => {
    const state = createGame({
      size: vec3(3, 3, 3),
      mineCount: 1,
      seed: 7,
      firstRevealSafe: true,
      minesFatal: false,
      freeReveals: 0,
    });
    // Whatever seed places the mine, the opening move never detonates.
    const opening = at(0, 0, 0);
    const { state: after, events } = revealCell(state, opening);

    expect(events.some((event) => event.type === "mineExploded")).toBe(false);
    expect(after.status).not.toBe("lost");
    expect(cell(after, 0, 0, 0).hasMine).toBe(false);
  });
});
