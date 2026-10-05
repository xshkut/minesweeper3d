import { type Grid, neighboursOf } from "./grid";
import { randomInt } from "./random";
import type { Cell, CellIndex } from "./types";

/** Result of laying out mines: the occupied offsets plus the advanced RNG state. */
export interface MineLayout {
  readonly mineOffsets: readonly number[];
  readonly rngState: number;
}

/**
 * Picks `mineCount` distinct cells uniformly at random (partial Fisher-Yates
 * shuffle) and reports the advanced generator state.
 *
 * Unlike the prototype - which looped until enough random cells happened to be
 * free - this always terminates and cannot place two mines on one cell.
 *
 * @param forbidden cells that must stay mine free (used for safe openings)
 */
export function placeMines(
  grid: Grid,
  mineCount: number,
  rngState: number,
  forbidden: readonly CellIndex[] = [],
): MineLayout {
  const excluded = new Set(forbidden.map((cell) => grid.offsetOf(cell)));
  const available: number[] = [];
  for (let offset = 0; offset < grid.cellCount; offset += 1) {
    if (!excluded.has(offset)) available.push(offset);
  }

  if (mineCount < 0 || mineCount > available.length) {
    throw new RangeError(`Cannot place ${mineCount} mines on ${available.length} available cells`);
  }

  let state = rngState;
  const mineOffsets: number[] = [];
  for (let i = 0; i < mineCount; i += 1) {
    const draw = randomInt(state, i, available.length - 1);
    state = draw.state;
    const swap = available[i] as number;
    available[i] = available[draw.value] as number;
    available[draw.value] = swap;
    mineOffsets.push(available[i] as number);
  }

  return { mineOffsets, rngState: state };
}

/**
 * Counts, for every cell, how many mines sit in the 26 surrounding cells.
 *
 * A mine cell itself reports the number of *other* mines around it, matching
 * the prototype's bookkeeping.
 */
export function computeAdjacency(grid: Grid, mineOffsets: readonly number[]): Uint8Array {
  const adjacency = new Uint8Array(grid.cellCount);
  for (const offset of mineOffsets) {
    for (const neighbour of neighboursOf(grid, grid.cellOf(offset))) {
      const neighbourOffset = grid.offsetOf(neighbour);
      adjacency[neighbourOffset] = Math.min(255, (adjacency[neighbourOffset] ?? 0) + 1);
    }
  }
  return adjacency;
}

/** Builds the initial, fully covered cells for a mine layout. */
export function createCells(grid: Grid, mineOffsets: readonly number[], adjacency: Uint8Array): Cell[] {
  const mineSet = new Set(mineOffsets);
  const cells: Cell[] = new Array<Cell>(grid.cellCount);
  for (let offset = 0; offset < grid.cellCount; offset += 1) {
    cells[offset] = {
      index: grid.cellOf(offset),
      hasMine: mineSet.has(offset),
      adjacentMines: adjacency[offset] ?? 0,
      isRevealed: false,
      isFlagged: false,
    };
  }
  return cells;
}

/** Indices of all mines on the board. */
export function mineCellsOf(cells: readonly Cell[]): CellIndex[] {
  const mines: CellIndex[] = [];
  for (const cell of cells) {
    if (cell.hasMine) mines.push(cell.index);
  }
  return mines;
}

/** Offsets (into the flat cell array) of all mines on the board. */
export function mineOffsetsOf(cells: readonly Cell[]): number[] {
  const offsets: number[] = [];
  for (let offset = 0; offset < cells.length; offset += 1) {
    if (cells[offset]?.hasMine === true) offsets.push(offset);
  }
  return offsets;
}
