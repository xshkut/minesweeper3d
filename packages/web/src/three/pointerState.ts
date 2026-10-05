/**
 * Pointer bookkeeping shared by the camera rig and the board.
 *
 * The board has to ignore clicks that were really camera drags, and the camera
 * rig has to ignore drags that started as a click on a cell; both read the same
 * small mutable record here instead of talking to each other through React.
 */

/** State of the primary pointer, tracked at the canvas level. */
export interface PointerState {
  /** `true` while a button is held down on the canvas. */
  down: boolean;
  /** Button that started the current press, `-1` when none. */
  button: number;
  /** Cumulative movement in pixels since the press started. */
  travel: number;
  /** `true` once the pointer moved far enough to count as a drag. */
  dragged: boolean;
}

/** Movement in pixels above which a press is treated as a drag. */
export const DRAG_THRESHOLD_PX = 5;

/** Creates a fresh pointer record. */
export function createPointerState(): PointerState {
  return { down: false, button: -1, travel: 0, dragged: false };
}

/** Records a button press. */
export function pointerDown(state: PointerState, button: number): void {
  state.down = true;
  state.button = button;
  state.travel = 0;
  state.dragged = false;
}

/** Records movement, promoting the press to a drag once it travels far enough. */
export function pointerMove(state: PointerState, deltaX: number, deltaY: number): void {
  if (!state.down) return;
  state.travel += Math.abs(deltaX) + Math.abs(deltaY);
  if (state.travel > DRAG_THRESHOLD_PX) state.dragged = true;
}

/** Ends the current press. */
export function pointerUp(state: PointerState): void {
  state.down = false;
  state.button = -1;
}
