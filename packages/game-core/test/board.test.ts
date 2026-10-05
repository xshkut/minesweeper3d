import { describe, expect, it } from "bun:test";
import { createGameWithMines, createGrid, placeMines, vec3 } from "../src/index";
import { at, game, gameWithMines, testConfig } from "./helpers";

describe("mine layout", () => {
  it("places exactly the requested number of mines on distinct cells", () => {
    const grid = createGrid(vec3(4, 4, 4));
    const layout = placeMines(grid, 20, 7);
    expect(layout.mineOffsets).toHaveLength(20);
    expect(new Set(layout.mineOffsets).size).toBe(20);
    for (const offset of layout.mineOffsets) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(grid.cellCount);
    }
  });

  it("is deterministic for a given seed", () => {
    const grid = createGrid(vec3(5, 5, 5));
    expect(placeMines(grid, 10, 42)).toEqual(placeMines(grid, 10, 42));
    expect(placeMines(grid, 10, 42).mineOffsets).not.toEqual(placeMines(grid, 10, 43).mineOffsets);
  });

  it("keeps forbidden cells mine free", () => {
    const grid = createGrid(vec3(3, 3, 3));
    const forbidden = [at(0, 0, 0), at(1, 1, 1)];
    const layout = placeMines(grid, 20, 3, forbidden);
    const forbiddenOffsets = forbidden.map((cell) => grid.offsetOf(cell));
    for (const offset of forbiddenOffsets) {
      expect(layout.mineOffsets).not.toContain(offset);
    }
  });

  it("refuses impossible layouts instead of looping forever", () => {
    const grid = createGrid(vec3(2, 2, 2));
    expect(() => placeMines(grid, 9, 1)).toThrow(RangeError);
    expect(() => placeMines(grid, -1, 1)).toThrow(RangeError);
    expect(placeMines(grid, 8, 1).mineOffsets).toHaveLength(8);
  });
});

describe("adjacency counts", () => {
  it("counts the mines of the 26 surrounding cells", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)]);
    // The seven cells of the corner octant touch the mine.
    for (const [x, y, z] of [
      [0, 0, 1],
      [0, 1, 0],
      [0, 1, 1],
      [1, 0, 0],
      [1, 0, 1],
      [1, 1, 0],
      [1, 1, 1],
    ] as const) {
      expect(state.cells[createGrid(vec3(3, 3, 3)).offsetOf(at(x, y, z))]?.adjacentMines).toBe(1);
    }
    // The mine itself reports the number of *other* mines around it.
    expect(state.cells[0]?.adjacentMines).toBe(0);
    // A far corner sees nothing.
    expect(state.cells[26]?.adjacentMines).toBe(0);
  });

  it("adds up for neighbouring mines", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(0, 0, 2)]);
    const grid = createGrid(vec3(3, 3, 3));
    expect(state.cells[grid.offsetOf(at(0, 0, 1))]?.adjacentMines).toBe(2);
    expect(state.cells[grid.offsetOf(at(1, 1, 1))]?.adjacentMines).toBe(2);
    expect(state.cells[grid.offsetOf(at(0, 1, 1))]?.adjacentMines).toBe(2);
    expect(state.cells[grid.offsetOf(at(2, 2, 2))]?.adjacentMines).toBe(0);
  });

  it("matches a brute force count on a larger board", () => {
    const size = vec3(6, 6, 6);
    const grid = createGrid(size);
    const state = game(size, 30, { seed: 2024 });
    const mineOffsets = new Set(state.cells.filter((cell) => cell.hasMine).map((cell) => grid.offsetOf(cell.index)));

    for (const cell of state.cells) {
      let expected = 0;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const neighbour = at(cell.index.x + dx, cell.index.y + dy, cell.index.z + dz);
            if (!grid.contains(neighbour)) continue;
            if (mineOffsets.has(grid.offsetOf(neighbour))) expected += 1;
          }
        }
      }
      expect(cell.adjacentMines).toBe(expected);
    }
  });

  it("keeps every count inside the 0..26 range", () => {
    const state = game(vec3(4, 4, 4), 40, { seed: 11 });
    for (const cell of state.cells) {
      expect(cell.adjacentMines).toBeGreaterThanOrEqual(0);
      expect(cell.adjacentMines).toBeLessThanOrEqual(26);
    }
  });
});

describe("game creation", () => {
  it("starts ready, fully covered and flag free", () => {
    const state = game(vec3(5, 5, 5), 10, { seed: 5 });
    expect(state.status).toBe("ready");
    expect(state.revealedCount).toBe(0);
    expect(state.flagCount).toBe(0);
    expect(state.explodedAt).toBeNull();
    expect(state.cells).toHaveLength(125);
    expect(state.cells.every((cell) => !cell.isRevealed && !cell.isFlagged)).toBe(true);
    expect(state.cells.filter((cell) => cell.hasMine)).toHaveLength(10);
  });

  it("is reproducible from its seed", () => {
    const first = game(vec3(5, 5, 5), 10, { seed: 777 });
    const second = game(vec3(5, 5, 5), 10, { seed: 777 });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("builds explicit layouts and rejects broken ones", () => {
    const state = gameWithMines(vec3(3, 3, 3), [at(1, 1, 1)]);
    expect(state.cells[createGrid(vec3(3, 3, 3)).offsetOf(at(1, 1, 1))]?.hasMine).toBe(true);

    expect(() => gameWithMines(vec3(3, 3, 3), [at(1, 1, 1), at(1, 1, 1)])).toThrow(RangeError);
    expect(() => gameWithMines(vec3(3, 3, 3), [at(3, 0, 0)])).toThrow(RangeError);
    expect(() => createGameWithMines(testConfig(vec3(3, 3, 3), 3), [at(1, 1, 1), at(0, 0, 0)])).toThrow(
      /declares 3/,
    );
  });

  it("supports boards without mines", () => {
    const state = game(vec3(3, 3, 3), 0, { seed: 1 });
    expect(state.cells.every((cell) => !cell.hasMine)).toBe(true);
  });
});
