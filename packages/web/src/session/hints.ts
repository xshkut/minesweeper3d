/**
 * Client-side mirror of the rules the player is allowed to know.
 *
 * `@minesweeper3d/game-core` exposes `isCellExposed` for a full `GameState`,
 * but the UI only ever holds the redacted `ClientGameState`. This module
 * re-derives the "can I dig here?" answer from public information so the HUD
 * can explain a refused click instead of silently ignoring it.
 */
import { FACE_NEIGHBOURS, createGrid } from "@minesweeper3d/game-core";
import type { CellIndex, ClientCell, ClientGameState, Vec3 } from "@minesweeper3d/game-core";

/** The cell at `cell`, or `undefined` when it lies outside the board. */
export function clientCellAt(state: ClientGameState, cell: CellIndex): ClientCell | undefined {
  const grid = createGrid(state.config.size);
  if (!grid.contains(cell)) return undefined;
  return state.cells[grid.offsetOf(cell)];
}

/**
 * `true` when a covered cell touches the board's surface or a revealed cell.
 *
 * This is the 3D rule of the game: players dig in from the outside, so the
 * interior of the cube only opens up as the surface around it is cleared.
 */
export function isClientCellExposed(state: ClientGameState, cell: CellIndex): boolean {
  const grid = createGrid(state.config.size);
  if (!grid.contains(cell)) return false;

  for (const direction of FACE_NEIGHBOURS) {
    const neighbour = {
      x: cell.x + direction.x,
      y: cell.y + direction.y,
      z: cell.z + direction.z,
    };
    if (!grid.contains(neighbour)) return true;
    if (state.cells[grid.offsetOf(neighbour)]?.isRevealed === true) return true;
  }
  return false;
}

/** Number of cells a player has to clear to win. */
export function safeCellCount(size: Vec3, mineCount: number): number {
  return size.x * size.y * size.z - mineCount;
}
