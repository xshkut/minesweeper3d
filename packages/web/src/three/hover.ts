/**
 * Hover bookkeeping shared between the pointer layer and the highlight visuals.
 *
 * Hovering changes on every mouse move; putting it in React state would
 * re-render the whole board (up to a thousand cells) for nothing. Instead the
 * slot is a mutable box that the render loop polls once per frame.
 */
import { cellKey } from "@minesweeper3d/game-core";
import type { CellIndex } from "@minesweeper3d/game-core";

/**
 * Mutable holder of the currently hovered cell.
 *
 * Fields are public because the render loop reads them every frame; only the
 * functions in this module write to them.
 */
export interface HoverSlot {
  cell: CellIndex | null;
  /** Bumped on every change so per-frame code can detect it cheaply. */
  revision: number;
}

/** Creates an empty slot. */
export function createHoverSlot(): HoverSlot {
  return { cell: null, revision: 0 };
}

/**
 * Points the slot at another cell.
 *
 * @returns `true` when the hovered cell actually changed
 */
export function setHover(slot: HoverSlot, cell: CellIndex | null): boolean {
  const current = slot.cell;
  if (current === null && cell === null) return false;
  if (current !== null && cell !== null && cellKey(current) === cellKey(cell)) return false;

  slot.cell = cell;
  slot.revision += 1;
  return true;
}
