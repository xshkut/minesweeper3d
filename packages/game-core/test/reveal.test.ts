import { describe, expect, it } from "bun:test";
import { revealCell, toggleFlag, vec3 } from "../src/index";
import { at, cell, eventTypes, game, gameWithMines, revealedKeys } from "./helpers";

describe("revealing a cell", () => {
  it("opens a single numbered cell and starts the game", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)]);
    expect(state.status).toBe("ready");

    const transition = revealCell(state, at(0, 0, 1));

    expect(transition.state.status).toBe("playing");
    expect(transition.state.revealedCount).toBe(1);
    expect(cell(transition.state, 0, 0, 1).isRevealed).toBe(true);
    expect(cell(transition.state, 0, 0, 1).adjacentMines).toBe(1);
    expect(eventTypes(transition.events)).toEqual(["cellsRevealed"]);
    expect(transition.events[0]).toEqual({ type: "cellsRevealed", cells: [at(0, 0, 1)] });
  });

  it("floods the connected safe region from an empty cell", () => {
    // Six mines wall in (2,2,2) - a cell that can therefore never be opened, so
    // the fill below stops short of winning and the mines stay covered.
    const wall = [at(1, 2, 2), at(3, 2, 2), at(2, 1, 2), at(2, 3, 2), at(2, 2, 1), at(2, 2, 3)];
    const state = gameWithMines(vec3(6, 6, 6), [...wall, at(5, 5, 5), at(5, 5, 4), at(5, 4, 5)]);
    const transition = revealCell(state, at(0, 0, 0));

    const revealed = revealedKeys(transition.state);
    expect(revealed.length).toBeGreaterThan(100);
    expect(revealed).toContain("0,0,0");
    expect(revealed).toContain("1,1,1");
    // Numbered cells next to the mines are opened, but never the mines.
    expect(revealed).toContain("4,4,4");
    expect(cell(transition.state, 4, 4, 4).adjacentMines).toBe(3);
    expect(revealed).not.toContain("5,5,5");
    expect(revealed).not.toContain("2,2,2");
    expect(transition.state.status).toBe("playing");
  });

  it("reports every opened cell exactly once, starting with the clicked one", () => {
    const state = gameWithMines(vec3(4, 4, 4), [at(3, 3, 3)], { firstRevealSafe: false });
    const transition = revealCell(state, at(0, 0, 0));
    const event = transition.events[0];

    expect(event?.type).toBe("cellsRevealed");
    if (event?.type !== "cellsRevealed") throw new Error("expected a reveal event");

    const keys = event.cells.map((entry) => `${entry.x},${entry.y},${entry.z}`);
    expect(keys[0]).toBe("0,0,0");
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(transition.state.revealedCount);
  });

  it("opens the whole safe region around a single mine", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(2, 2, 2)]);
    const transition = revealCell(state, at(0, 0, 0));

    expect(revealedKeys(transition.state)).toContain("1,1,1");
    expect(transition.state.revealedCount).toBe(26);
    expect(transition.state.status).toBe("won");
  });

  it("does not open flagged cells", () => {
    const flagged = toggleFlag(game(vec3(3, 3, 3), 0, { seed: 1 }), at(1, 1, 1)).state;
    expect(flagged.flagCount).toBe(1);

    const transition = revealCell(flagged, at(0, 0, 0));

    expect(cell(transition.state, 1, 1, 1).isRevealed).toBe(false);
    expect(cell(transition.state, 1, 1, 1).isFlagged).toBe(true);
    // One cell short of a win, because the flag blocks the fill.
    expect(transition.state.revealedCount).toBe(26);
    expect(transition.state.status).toBe("playing");
  });

  it("ignores clicks on already revealed cells", () => {
    const state = revealCell(gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)]), at(0, 0, 1)).state;
    const transition = revealCell(state, at(0, 0, 1));

    expect(transition.state).toBe(state);
    expect(transition.events).toEqual([]);
  });

  it("ignores clicks outside the board", () => {
    const state = game(vec3(3, 3, 3), 1, { seed: 1 });
    expect(revealCell(state, at(3, 0, 0)).state).toBe(state);
    expect(revealCell(state, at(-1, 0, 0)).state).toBe(state);
  });
});

describe("losing", () => {
  it("uncovers every mine and marks the cell that exploded", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(2, 2, 2)], { firstRevealSafe: false });
    const transition = revealCell(state, at(0, 0, 0));

    expect(transition.state.status).toBe("lost");
    expect(transition.state.explodedAt).toEqual(at(0, 0, 0));
    expect(cell(transition.state, 0, 0, 0).isRevealed).toBe(true);
    expect(cell(transition.state, 2, 2, 2).isRevealed).toBe(true);
    expect(eventTypes(transition.events)).toEqual(["mineExploded", "minesRevealed", "gameLost"]);
  });

  it("freezes the game afterwards", () => {
    const lost = revealCell(
      gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)], { firstRevealSafe: false }),
      at(0, 0, 0),
    ).state;

    expect(revealCell(lost, at(0, 0, 1)).state).toBe(lost);
    expect(revealCell(lost, at(1, 1, 1)).state).toBe(lost);
  });
});

describe("winning", () => {
  it("wins when every safe cell is open and uncovers the remaining mines", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)]);
    const transition = revealCell(state, at(2, 2, 2));

    expect(transition.state.status).toBe("won");
    expect(transition.state.revealedCount).toBe(26);
    expect(cell(transition.state, 0, 0, 0).isRevealed).toBe(true);
    expect(eventTypes(transition.events)).toEqual(["cellsRevealed", "minesRevealed", "gameWon"]);
  });

  it("wins a mine free board with a single click", () => {
    const transition = revealCell(game(vec3(3, 3, 3), 0, { seed: 9 }), at(0, 0, 0));

    expect(transition.state.status).toBe("won");
    expect(transition.state.revealedCount).toBe(27);
  });

  it("freezes the game afterwards", () => {
    const won = revealCell(game(vec3(3, 3, 3), 0, { seed: 9 }), at(0, 0, 0)).state;
    expect(revealCell(won, at(1, 1, 1)).state).toBe(won);
    expect(toggleFlag(won, at(1, 1, 1)).state).toBe(won);
  });
});

describe("safe opening", () => {
  it("relocates the mine instead of ending the game", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)], { seed: 5, firstRevealSafe: true });
    const transition = revealCell(state, at(0, 0, 0));

    expect(transition.state.status).not.toBe("lost");
    expect(cell(transition.state, 0, 0, 0).isRevealed).toBe(true);
    expect(cell(transition.state, 0, 0, 0).hasMine).toBe(false);
    // The mine is still on the board, just somewhere else.
    expect(transition.state.cells.filter((entry) => entry.hasMine)).toHaveLength(1);
  });

  it("prefers to clear the whole neighbourhood of the opening click", () => {
    const state = gameWithMines(vec3(5, 5, 5), [at(0, 0, 0)], { seed: 8, firstRevealSafe: true });
    const transition = revealCell(state, at(0, 0, 0));

    for (let x = 0; x <= 1; x += 1) {
      for (let y = 0; y <= 1; y += 1) {
        for (let z = 0; z <= 1; z += 1) {
          expect(cell(transition.state, x, y, z).hasMine).toBe(false);
        }
      }
    }
    expect(cell(transition.state, 0, 0, 0).adjacentMines).toBe(0);
  });

  it("only applies to the opening click", () => {
    // Six mines enclose (2,2,2), which - by the digging rule - can never be
    // opened, so the game cannot be won before the second click below.
    const wall = [at(1, 2, 2), at(3, 2, 2), at(2, 1, 2), at(2, 3, 2), at(2, 2, 1), at(2, 2, 3)];
    const state = gameWithMines(vec3(5, 5, 5), [at(0, 0, 0), ...wall], { seed: 3, firstRevealSafe: true });

    const opened = revealCell(state, at(0, 0, 0));
    expect(opened.state.status).toBe("playing");
    expect(cell(opened.state, 0, 0, 0).hasMine).toBe(false);

    const boom = revealCell(opened.state, at(1, 2, 2));
    expect(boom.state.status).toBe("lost");
    expect(boom.state.explodedAt).toEqual(at(1, 2, 2));
  });

  it("still respects the digging rule", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(1, 1, 1)], { seed: 1, firstRevealSafe: true });
    // (1,1,1) is hidden inside the cube: the rule wins over the safety net.
    expect(revealCell(state, at(1, 1, 1)).events).toEqual([]);
  });

  it("is off by default in the raw config", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)]);
    expect(state.config.firstRevealSafe).toBe(false);
    expect(revealCell(state, at(0, 0, 0)).state.status).toBe("lost");
  });
});
