import { cellAt, createGame, createGameWithMines, mineCells } from "../src/index";
import type { Cell, CellIndex, GameConfig, GameState, Vec3 } from "../src/index";
import { vec3 } from "../src/index";

/** Test fixtures: small, explicit boards beat random ones in unit tests. */
export const at = (x: number, y: number, z: number): CellIndex => vec3(x, y, z);

/** Rules config with a pinned seed and the game-y "safe opening" rule off. */
export function testConfig(
  size: Vec3,
  mineCount: number,
  options: { seed?: number; firstRevealSafe?: boolean } = {},
): GameConfig {
  return {
    size,
    mineCount,
    seed: options.seed ?? 1,
    firstRevealSafe: options.firstRevealSafe ?? false,
  };
}

/** A game with an exact, hand written mine layout. */
export function gameWithMines(
  size: Vec3,
  mines: readonly CellIndex[],
  options: { seed?: number; firstRevealSafe?: boolean } = {},
): GameState {
  return createGameWithMines(testConfig(size, mines.length, options), mines);
}

/** A game with randomly placed mines (deterministic for a given seed). */
export function game(
  size: Vec3,
  mineCount: number,
  options: { seed?: number; firstRevealSafe?: boolean } = {},
): GameState {
  return createGame(testConfig(size, mineCount, options));
}

/** The cell at the given coordinates; fails loudly when out of bounds. */
export function cell(state: GameState, x: number, y: number, z: number): Cell {
  const found = cellAt(state, at(x, y, z));
  if (found === undefined) throw new Error(`No cell at (${x}, ${y}, ${z})`);
  return found;
}

/** Stable key of a cell or cell index, e.g. `"1,2,3"`. */
export function keyOf(cellOrIndex: Cell | CellIndex): string {
  const index = "index" in cellOrIndex ? cellOrIndex.index : cellOrIndex;
  return `${index.x},${index.y},${index.z}`;
}

/** Keys of all revealed cells, sorted, for order-independent assertions. */
export function revealedKeys(state: GameState): string[] {
  return state.cells.filter((entry) => entry.isRevealed).map(keyOf).sort();
}

/** Keys of all flagged cells, sorted. */
export function flaggedKeys(state: GameState): string[] {
  return state.cells.filter((entry) => entry.isFlagged).map(keyOf).sort();
}

/** Keys of all mines, sorted. */
export function mineKeys(state: GameState): string[] {
  return mineCells(state).map(keyOf).sort();
}

/** Keys of all covered cells, sorted. */
export function coveredKeys(state: GameState): string[] {
  return state.cells.filter((entry) => !entry.isRevealed).map(keyOf).sort();
}

/** Deep snapshot used to prove that actions never mutate their input. */
export function snapshot(state: GameState): string {
  return JSON.stringify(state);
}

/** Types of a batch of events, in order. */
export function eventTypes(events: readonly { type: string }[]): string[] {
  return events.map((event) => event.type);
}
