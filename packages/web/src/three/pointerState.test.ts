/**
 * Regression test for the click/drag split.
 *
 * The board and the camera rig share this record: the board drops a click that
 * looks like a camera drag, and the rig only orbits on the right button. Travel
 * used to be counted for *every* button, so a fast left click - which is never
 * perfectly still - drifted past the threshold, was flagged as a drag and threw
 * the reveal away even though a left drag does nothing at all. That is the
 * "throttle": the faster the player clicked, the more clicks vanished.
 */
import { describe, expect, test } from "bun:test";
import {
  DRAG_THRESHOLD_PX,
  ORBIT_BUTTON,
  TOUCH_DRAG_THRESHOLD_PX,
  createPointerState,
  pointerDown,
  pointerGesture,
  pointerMove,
  pointerUp,
} from "./pointerState";

/** Presses `button` and moves the pointer `distance` px in a straight line. */
function pressAndMove(button: number, distance: number): ReturnType<typeof createPointerState> {
  const state = createPointerState();
  pointerDown(state, button);
  pointerMove(state, distance, 0);
  return state;
}

describe("pointerState", () => {
  test("a drag needs more travel than the threshold", () => {
    expect(pressAndMove(ORBIT_BUTTON, DRAG_THRESHOLD_PX).dragged).toBe(false);
    expect(pressAndMove(ORBIT_BUTTON, DRAG_THRESHOLD_PX + 1).dragged).toBe(true);
  });

  test("travel accumulates across moves", () => {
    const state = createPointerState();
    pointerDown(state, ORBIT_BUTTON);
    // Each move is under the threshold on its own; together they add up to a drag.
    for (let i = 0; i <= DRAG_THRESHOLD_PX; i += 1) pointerMove(state, 1, 0);

    expect(state.travel).toBe(DRAG_THRESHOLD_PX + 1);
    expect(state.dragged).toBe(true);
  });

  test("a left press never becomes a drag, however far it travels", () => {
    const state = pressAndMove(0, 500);

    expect(state.dragged).toBe(false);
    expect(state.button).toBe(0);
  });

  test("a middle press never becomes a drag either", () => {
    expect(pressAndMove(1, 500).dragged).toBe(false);
  });

  test("movement is ignored while no button is down", () => {
    const state = pressAndMove(ORBIT_BUTTON, 1);
    pointerUp(state);
    pointerMove(state, 500, 500);

    expect(state.travel).toBe(1);
    expect(state.dragged).toBe(false);
  });

  test("a new press starts a fresh travel count", () => {
    const state = createPointerState();
    pointerDown(state, ORBIT_BUTTON);
    pointerMove(state, 100, 0);
    expect(state.dragged).toBe(true);

    pointerDown(state, ORBIT_BUTTON);
    expect(state.travel).toBe(0);
    expect(state.dragged).toBe(false);
  });

  test("the release keeps the drag flag so the menu still recentres only on a click", () => {
    const state = createPointerState();
    pointerDown(state, ORBIT_BUTTON);
    pointerMove(state, 100, 0);
    pointerUp(state);

    // `onContextMenu` runs after the release and reads this flag.
    expect(state.down).toBe(false);
    expect(state.button).toBe(-1);
    expect(state.dragged).toBe(true);
  });
});

/**
 * The touch half of the same record.
 *
 * A finger has no buttons: it is the tap that opens a cell *and* the drag that
 * turns the camera, so travel is counted for it too - but against a threshold
 * that forgives the wobble of a fingertip. Without the split, a tap on a phone
 * would be swallowed by the orbit exactly like the fast left click was.
 */
describe("touch presses", () => {
  test("a finger accumulates travel although it has no button", () => {
    const state = createPointerState();
    pointerDown(state, 0, true);
    pointerMove(state, TOUCH_DRAG_THRESHOLD_PX, 0);
    expect(state.dragged).toBe(false);

    pointerMove(state, 1, 0);
    expect(state.dragged).toBe(true);
  });

  test("a fingertip's wobble stays a tap", () => {
    const state = createPointerState();
    pointerDown(state, 0, true);
    // Past the mouse threshold but not the finger's: a finger rolls as it lands,
    // so a tap that never left the cell must still act on it.
    pointerMove(state, DRAG_THRESHOLD_PX + 1, 0);

    expect(state.touch).toBe(true);
    expect(state.dragged).toBe(false);
  });

  test("a second finger closes the press off so its release cannot act", () => {
    const state = createPointerState();
    pointerDown(state, 0, true);
    pointerGesture(state);

    expect(state.dragged).toBe(true);
    pointerUp(state);
    // Kept after the release, so the board still reads a gesture, not a tap.
    expect(state.dragged).toBe(true);
  });

  test("a gesture on a press that never happened changes nothing", () => {
    const state = createPointerState();
    pointerGesture(state);

    expect(state.dragged).toBe(false);
  });

  test("a mouse press after a finger is a mouse press again", () => {
    const state = createPointerState();
    pointerDown(state, 0, true);
    pointerMove(state, 100, 0);
    expect(state.dragged).toBe(true);

    pointerDown(state, 0);
    expect(state.touch).toBe(false);
    expect(state.dragged).toBe(false);
    // And the left button is back to never dragging.
    pointerMove(state, 500, 0);
    expect(state.dragged).toBe(false);
  });
});
