import { FACE_NEIGHBOURS, type Grid } from "./grid";
import type { Cell, GameConfig, GameStatus } from "./types";
import { addVec3 } from "./vec3";

/** Rules used when the caller does not override them. */
export const DEFAULT_RULES = Object.freeze({
  /** The opening reveal of a game never hits a mine. */
  firstRevealSafe: true,
  /** Opening a mine ends the game. */
  minesFatal: true,
  /** Free reveals are an aid, so they are off unless a board asks for them. */
  freeReveals: 0,
});

/**
 * The 3D twist of this minesweeper: a covered cell can only be opened once it
 * is *exposed*, that is when at least one of its six face neighbours is either
 * outside the board or already revealed. Players therefore have to dig in from
 * the surface of the cube instead of clicking anywhere.
 *
 * This is the rule the original prototype implemented with its
 * `if (around == 6) return;` guard, extracted here so it can be named, tested
 * and reused by the client for hints.
 */
export function isExposed(grid: Grid, cells: readonly Cell[], offset: number): boolean {
  const cell = cells[offset];
  if (cell === undefined) return false;

  for (const direction of FACE_NEIGHBOURS) {
    const neighbour = addVec3(cell.index, direction);
    if (!grid.contains(neighbour)) return true;
    if (cells[grid.offsetOf(neighbour)]?.isRevealed === true) return true;
  }
  return false;
}

/** A game is won once every mine-free cell has been revealed. */
export function hasRevealedAllSafeCells(grid: Grid, config: GameConfig, revealedCount: number): boolean {
  return revealedCount >= grid.cellCount - config.mineCount;
}

/** A game is over once it is won or lost; no further action has an effect. */
export function isGameOver(status: GameStatus): boolean {
  return status === "won" || status === "lost";
}
