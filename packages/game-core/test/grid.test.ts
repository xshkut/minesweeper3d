import { describe, expect, it } from "bun:test";
import {
  createGrid,
  FACE_NEIGHBOURS,
  MAX_DIMENSION,
  NEIGHBOURS,
  neighboursOf,
  vec3,
} from "../src/index";
import { at } from "./helpers";

describe("grid", () => {
  it("counts the cells of a box", () => {
    expect(createGrid(vec3(5, 4, 3)).cellCount).toBe(60);
    expect(createGrid(vec3(1, 1, 1)).cellCount).toBe(1);
  });

  it("round-trips offsets and coordinates", () => {
    const grid = createGrid(vec3(4, 5, 6));
    for (let offset = 0; offset < grid.cellCount; offset += 1) {
      expect(grid.offsetOf(grid.cellOf(offset))).toBe(offset);
    }
  });

  it("numbers cells in x-major order", () => {
    const grid = createGrid(vec3(2, 3, 4));
    expect(grid.offsetOf(at(0, 0, 0))).toBe(0);
    expect(grid.offsetOf(at(0, 0, 1))).toBe(1);
    expect(grid.offsetOf(at(0, 1, 0))).toBe(4);
    expect(grid.offsetOf(at(1, 0, 0))).toBe(12);
    expect(grid.cellOf(13)).toEqual(at(1, 0, 1));
  });

  it("only contains cells inside the board", () => {
    const grid = createGrid(vec3(3, 3, 3));
    expect(grid.contains(at(0, 0, 0))).toBe(true);
    expect(grid.contains(at(2, 2, 2))).toBe(true);
    expect(grid.contains(at(3, 0, 0))).toBe(false);
    expect(grid.contains(at(-1, 0, 0))).toBe(false);
    expect(grid.contains(at(0, 3, 0))).toBe(false);
    expect(grid.contains(at(0, 0, 3))).toBe(false);
  });
});

describe("neighbourhoods", () => {
  it("has six face neighbours and twenty-six surrounding cells", () => {
    expect(FACE_NEIGHBOURS).toHaveLength(6);
    expect(NEIGHBOURS).toHaveLength(26);
    expect(NEIGHBOURS).toContainEqual(vec3(1, 1, 1));
    expect(FACE_NEIGHBOURS).not.toContainEqual(vec3(1, 1, 0));
  });

  it("never yields the cell itself or a cell outside the board", () => {
    const grid = createGrid(vec3(3, 3, 3));
    const centre = [...neighboursOf(grid, at(1, 1, 1))];
    expect(centre).toHaveLength(26);
    expect(centre).not.toContainEqual(at(1, 1, 1));

    // A corner only has the 7 cells of its own octant.
    expect([...neighboursOf(grid, at(0, 0, 0))]).toHaveLength(7);
    // A face centre has 17 neighbours, an edge centre 11.
    expect([...neighboursOf(grid, at(0, 1, 1))]).toHaveLength(17);
    expect([...neighboursOf(grid, at(0, 0, 1))]).toHaveLength(11);
  });

  it("yields face neighbours in a stable order", () => {
    const grid = createGrid(vec3(3, 3, 3));
    // Order only matters for reproducible reveal sequences, not for the rules.
    expect([...neighboursOf(grid, at(1, 1, 1), FACE_NEIGHBOURS)]).toEqual([
      at(0, 1, 1),
      at(1, 0, 1),
      at(1, 1, 0),
      at(1, 1, 2),
      at(1, 2, 1),
      at(2, 1, 1),
    ]);
  });

  it("documents the maximum supported board size", () => {
    expect(MAX_DIMENSION).toBe(32);
  });
});
