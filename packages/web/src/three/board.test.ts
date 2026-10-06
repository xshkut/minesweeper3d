import { describe, expect, test } from "bun:test";
import { BOARD_COLORS, CELL_SIZE, CORNER_RADIUS, MARK_OFFSET, cellCenter } from "./board";

/**
 * Distance from a cube's centre to its furthest point, i.e. its corner.
 *
 * A mark pushed towards the camera has to beat this to be drawn at all: a cube
 * is opaque, so anything inside it is simply occluded.
 */
const HALF_DIAGONAL = (CELL_SIZE * Math.sqrt(3)) / 2;

describe("board geometry", () => {
  test("a mark clears the cube it belongs to", () => {
    // The regression this pins: `MARK_OFFSET = CELL_SIZE * 0.75` looks tidier
    // than the shipped value and is *less* than the half-diagonal, so every
    // question mark and probe result is buried inside its own cube and the
    // board just looks like it has a few oddly tinted cells.
    expect(MARK_OFFSET).toBeGreaterThan(HALF_DIAGONAL);
  });

  test("a mark clears it with room to spare, not merely tangent", () => {
    // Touching the corner is still half-swallowed for a ball of any radius, so
    // the offset has to overshoot the bound rather than meet it.
    expect(MARK_OFFSET - HALF_DIAGONAL).toBeGreaterThan(CELL_SIZE * 0.5);
  });

  test("rounding the corners leaves the cubes separate objects", () => {
    // Cubes sit exactly one cell apart. A corner radius at or over half a cell
    // would round them into spheres that no longer meet, and at zero the board
    // reads as one block with lines drawn on it.
    expect(CORNER_RADIUS).toBeGreaterThan(0);
    expect(CORNER_RADIUS).toBeLessThan(CELL_SIZE / 2);
  });

  test("the three mark tints are distinct", () => {
    const tints = new Set([BOARD_COLORS.flag, BOARD_COLORS.questioned, BOARD_COLORS.probedMine, BOARD_COLORS.probedSafe]);
    expect(tints.size).toBe(4);
  });
});

describe("cellCenter", () => {
  test("maps the first and last cell onto the board's own corners", () => {
    const size = { x: 3, y: 3, z: 3 };
    expect(cellCenter({ x: 0, y: 0, z: 0 }, size)).toEqual({
      x: -CELL_SIZE,
      y: -CELL_SIZE,
      z: -CELL_SIZE,
    });
    expect(cellCenter({ x: 2, y: 2, z: 2 }, size)).toEqual({ x: CELL_SIZE, y: CELL_SIZE, z: CELL_SIZE });
  });
});
