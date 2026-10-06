/**
 * Pointer bookkeeping shared by the camera rig and the board.
 *
 * The board has to ignore clicks that were really camera drags, and the camera
 * rig has to ignore drags that started as a click on a cell; both read the same
 * small mutable record here instead of talking to each other through React.
 *
 * A finger has none of the mouse's buttons - no right button to orbit with and
 * no middle button to mark with - so a touch press is both the tap that acts on
 * a cell *and* the drag that turns the camera. Which one it turned out to be is
 * decided here, once, by how far it travelled: {@link PointerState.dragged}.
 */

/** State of the primary pointer, tracked at the canvas level. */
export interface PointerState {
  /** `true` while a button or finger is held down on the canvas. */
  down: boolean;
  /** Button that started the current press, `-1` when none. */
  button: number;
  /** Cumulative movement in pixels since the press started. */
  travel: number;
  /** `true` once the pointer moved far enough to count as a drag. */
  dragged: boolean;
  /** `true` when the press came from a finger or a stylus instead of a mouse. */
  touch: boolean;
}

/** Movement in pixels above which a mouse press is treated as a drag. */
export const DRAG_THRESHOLD_PX = 5;

/**
 * The same threshold for a finger, with room for the wobble of a fingertip.
 *
 * A finger rolls and shifts as it lands, so a press that never left the cell is
 * rarely perfectly still. Reusing the mouse threshold here would turn a tap on
 * a phone into a camera orbit before it could ever act on the cell - the same
 * failure that once made fast mouse clicks feel swallowed.
 */
export const TOUCH_DRAG_THRESHOLD_PX = 10;

/**
 * The only mouse button that moves the camera, so the only one that can turn a
 * press into a drag.
 *
 * The board has to tell clicks from camera drags, and the camera orbit is the
 * right button. A left press reveals the cell it started on however far the
 * pointer wanders before the button comes back up, so tracking travel for it
 * would only throw away clicks: a fast click is never perfectly still, and the
 * faster the player clicks the further the mouse drifts mid-press.
 *
 * Touch presses are the exception: they have no other way to reach the camera,
 * so they accumulate travel too (see {@link pointerMove}).
 */
export const ORBIT_BUTTON = 2;

/** Creates a fresh pointer record. */
export function createPointerState(): PointerState {
  return { down: false, button: -1, travel: 0, dragged: false, touch: false };
}

/** Records a press. `touch` marks a finger or stylus, which has no buttons. */
export function pointerDown(state: PointerState, button: number, touch = false): void {
  state.down = true;
  state.button = button;
  state.travel = 0;
  state.dragged = false;
  state.touch = touch;
}

/**
 * Records movement, promoting the press to a drag once it travels far enough.
 *
 * Only a press that could move the camera accumulates travel - the orbit button
 * or any finger. Every other button stays a click no matter how much it moves.
 */
export function pointerMove(state: PointerState, deltaX: number, deltaY: number): void {
  if (!state.down) return;
  if (state.button !== ORBIT_BUTTON && !state.touch) return;
  state.travel += Math.abs(deltaX) + Math.abs(deltaY);
  const threshold = state.touch ? TOUCH_DRAG_THRESHOLD_PX : DRAG_THRESHOLD_PX;
  if (state.travel > threshold) state.dragged = true;
}

/**
 * Marks the current press as a gesture that must not act on release.
 *
 * A second finger landing turns a tap into a pinch, but the first finger still
 * comes up over some cell: without this, that release would count as a tap on
 * whatever the finger happened to be covering when the pinch ended.
 */
export function pointerGesture(state: PointerState): void {
  if (!state.down) return;
  state.dragged = true;
}

/** Ends the current press. */
export function pointerUp(state: PointerState): void {
  state.down = false;
  state.button = -1;
}
