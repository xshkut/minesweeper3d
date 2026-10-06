/**
 * Regression test for picking a cell out of a ray.
 *
 * The covered cells are one instanced mesh, so a single ray that enters the
 * board crosses the front cell *and every covered cell behind it*: three.js
 * reports each crossing and r3f hands the event to the handlers once per
 * crossing, nearest first (`handleIntersects` in `@react-three/fiber`). This
 * used to turn one flag click into a flag on every cell along the trajectory.
 *
 * The dispatcher below mirrors that contract: every test here is about which
 * cell the handlers act on (the nearest crossing), so a fix that drops the
 * deeper crossings - by stopping the event, by filtering them, or both - passes
 * either way. The one exception is "delivered exactly once", which pins the
 * propagation stop itself: that is what keeps r3f from also booking the cells
 * behind the front one as hovered.
 *
 * A click is resolved twice: the press records the cell it landed on, and the
 * release falls back to its own nearest crossing only when that record is
 * missing (the press started off the board) or belongs to another pointer. The
 * tests that pass no `onPointerDown` before the release therefore still cover
 * the fallback path.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import {
  createGame,
  createGrid,
  cycleMark,
  presetConfig,
  probeCell,
  revealCell,
  toClientView,
} from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState, Vec3 } from "@minesweeper3d/game-core";
import type { ThreeEvent } from "@react-three/fiber";

// The hook only reaches into r3f for the canvas it sets the cursor on; the rest
// of this file is plain React.
const canvas = { style: { cursor: "default" } };
mock.module("@react-three/fiber", () => ({
  useThree: (select: (state: { gl: { domElement: typeof canvas } }) => unknown) =>
    select({ gl: { domElement: canvas } }),
}));

const { LONG_PRESS_MS, useBoardPointer } = await import("./useBoardPointer");
type BoardTool = import("./useBoardPointer").BoardTool;
const { createHoverSlot } = await import("./hover");
const { createPointerState, pointerDown, pointerGesture, pointerMove } = await import("./pointerState");
const { cellKey } = await import("@minesweeper3d/game-core");

/** Board used by every test; nothing is revealed, so all cells are covered. */
const STATE: ClientGameState = toClientView(createGame(presetConfig("classic", { seed: 7 })));
/** Same board, but with the free-reveal detector charged. */
const PROBE_STATE: ClientGameState = toClientView(
  createGame(presetConfig("classic", { seed: 7, freeReveals: 3 })),
);
const GRID = createGrid(STATE.config.size);

/** A ray entering on the board's diagonal: (0,0,0) first, two cells behind it. */
const TRAJECTORY: readonly CellIndex[] = [
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 1, z: 1 },
  { x: 2, y: 2, z: 2 },
];

/** A ray whose nearest crossing is a buried cell (2,2,2) that cannot be opened. */
const BURIED: readonly CellIndex[] = [{ x: 2, y: 2, z: 2 }];

/**
 * Replays one pointer event the way r3f does: the same list of intersections is
 * delivered once per hit, nearest first, and delivery stops as soon as a
 * handler calls `stopPropagation`.
 *
 * Returns how many times the handler was reached and whether delivery stopped,
 * which is what "one click acts on one cell" ultimately rests on.
 */
function dispatch(
  handlers: ReturnType<typeof useBoardPointer>,
  name: "onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerOut" | "onContextMenu",
  trajectory: readonly CellIndex[],
  extras: {
    readonly button?: number;
    readonly altKey?: boolean;
    readonly pointerId?: number;
    readonly pointerType?: string;
  } = {},
): { readonly deliveries: number; readonly stopped: boolean } {
  const hits = trajectory.map((cell) => ({
    instanceId: GRID.offsetOf(cell),
    // A point inside the cell makes "recentre on the nearest hit" observable.
    point: { x: cell.x, y: cell.y, z: cell.z },
  }));
  let stopped = false;
  let deliveries = 0;

  for (const hit of hits) {
    const event = {
      ...hit,
      intersections: hits,
      button: extras.button ?? 0,
      pointerId: extras.pointerId ?? 1,
      altKey: extras.altKey ?? false,
      pointerType: extras.pointerType,
      // r3f spreads the native event onto the event it hands a handler; a
      // `pointerType` rides along on both shapes here.
      nativeEvent: { preventDefault: () => undefined, pointerType: extras.pointerType },
      stopPropagation: () => {
        stopped = true;
      },
      stopped: false,
    };
    const handler = handlers[name] as (event: ThreeEvent<PointerEvent>) => void;
    deliveries += 1;
    handler(event as unknown as ThreeEvent<PointerEvent>);
    if (stopped) break;
  }

  return { deliveries, stopped };
}

/** Renders the hook and returns its handlers plus everything it was asked to do. */
function mountPointer(
  tool: BoardTool,
  state: ClientGameState = STATE,
): {
  readonly handlers: ReturnType<typeof useBoardPointer>;
  readonly calls: string[];
  readonly cursors: (CellIndex | null)[];
  readonly hover: ReturnType<typeof createHoverSlot>;
  readonly pointer: ReturnType<typeof createPointerState>;
} {
  const calls: string[] = [];
  const cursors: (CellIndex | null)[] = [];
  const hover = createHoverSlot();
  const pointer = createPointerState();

  const { result } = renderHook(() =>
    useBoardPointer({
      state,
      hover,
      pointer,
      tool,
      onReveal: (cell) => calls.push(`reveal ${cellKey(cell)}`),
      onMark: (cell) => calls.push(`mark ${cellKey(cell)}`),
      onProbe: (cell) => calls.push(`probe ${cellKey(cell)}`),
      onBlocked: (cell, reason) => calls.push(`blocked ${reason} ${cellKey(cell)}`),
      onRecenter: (point: Vec3) => calls.push(`recenter ${point.x},${point.y},${point.z}`),
      onCursor: (cell) => cursors.push(cell),
    }),
  );

  return { handlers: result.current, calls, cursors, hover, pointer };
}

afterEach(cleanup);

describe("useBoardPointer", () => {
  test("the mark tool marks only the nearest cell of a ray that crosses three", () => {
    const { handlers, calls } = mountPointer("flag");

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    expect(calls).toEqual(["mark 0,0,0"]);
  });

  test("alt-click flags the nearest cell too", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, altKey: true });

    expect(calls).toEqual(["mark 0,0,0"]);
  });

  test("middle-click flags the nearest cell too", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 1 });

    expect(calls).toEqual(["mark 0,0,0"]);
  });

  test("a click is delivered exactly once, however many cells the ray crosses", () => {
    const { handlers } = mountPointer("flag");

    const { deliveries, stopped } = dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    // Stopping the first delivery is what keeps r3f from handing the event to
    // the cells behind it (and from booking them as hovered).
    expect(deliveries).toBe(1);
    expect(stopped).toBe(true);
  });

  test("revealing a ray affects only the nearest cell", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    // (0,0,0) is on the surface and can be opened; the cells behind it are
    // buried, so they must not even reach the "blocked" report.
    expect(calls).toEqual(["reveal 0,0,0"]);
  });

  test("hover and recentring follow the nearest hit", () => {
    const { handlers, calls, hover } = mountPointer("reveal");

    dispatch(handlers, "onPointerMove", TRAJECTORY);
    expect(hover.cell).toEqual({ x: 0, y: 0, z: 0 });

    dispatch(handlers, "onContextMenu", TRAJECTORY);
    expect(calls).toEqual(["recenter 0,0,0"]);
  });

  test("a press is recorded once, for the nearest cell of the ray", () => {
    const { handlers, calls } = mountPointer("reveal");

    const { deliveries, stopped } = dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0 });

    // Without the stop, the deeper crossings would overwrite the press and the
    // click would land on the cell at the far end of the ray.
    expect(deliveries).toBe(1);
    expect(stopped).toBe(true);

    dispatch(handlers, "onPointerUp", BURIED, { button: 0 });
    expect(calls).toEqual(["reveal 0,0,0"]);
  });

  test("a click acts on the cell the press started on, not the one the pointer drifted onto", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0 });
    // A fast click never holds the mouse perfectly still: by the time the button
    // comes back up the ray may enter the board on a completely different cell.
    dispatch(handlers, "onPointerUp", BURIED, { button: 0 });

    expect(calls).toEqual(["reveal 0,0,0"]);
  });

  test("an alt-click marks the cell the press started on", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0 });
    dispatch(handlers, "onPointerUp", BURIED, { button: 0, altKey: true });

    expect(calls).toEqual(["mark 0,0,0"]);
  });

  test("a press released by another pointer is not consumed", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerId: 1 });
    // A second finger releasing must not fire the first finger's press.
    dispatch(handlers, "onPointerUp", BURIED, { button: 0, pointerId: 2 });

    expect(calls).toEqual(["blocked buried 2,2,2"]);
  });

  test("a press that landed off the board cannot be consumed by a later release", () => {
    const { handlers, calls } = mountPointer("reveal");

    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0 });
    // A second press, this time over the HUD: the board never sees it, so the
    // recorded press has to be discarded instead of firing on release.
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, button: 0 }));
    dispatch(handlers, "onPointerUp", BURIED, { button: 0 });

    expect(calls).toEqual(["blocked buried 2,2,2"]);
  });

  test("the detector probes a buried cell, which digging would refuse", () => {
    const { handlers, calls } = mountPointer("probe", PROBE_STATE);

    // (2,2,2) is buried: a reveal would report "blocked buried", but a detector
    // answers a question about the board rather than about the digging frontier.
    dispatch(handlers, "onPointerUp", BURIED, { button: 0 });

    expect(calls).toEqual(["probe 2,2,2"]);
  });

  test("the detector reports an already-probed cell instead of spending a second charge", () => {
    const probed = toClientView(
      probeCell(createGame(presetConfig("classic", { seed: 7, freeReveals: 3 })), { x: 0, y: 0, z: 0 })
        .state,
    );
    const { handlers, calls } = mountPointer("probe", probed);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    expect(calls).toEqual(["blocked probed 0,0,0"]);
  });

  test("the detector reports running out of charges instead of probing", () => {
    // STATE grants no free reveals at all.
    const { handlers, calls } = mountPointer("probe", STATE);

    dispatch(handlers, "onPointerUp", BURIED, { button: 0 });

    expect(calls).toEqual(["blocked no-charges 2,2,2"]);
  });

  test("the detector ignores a cell that is already open", () => {
    const opened = toClientView(
      revealCell(createGame(presetConfig("classic", { seed: 7, freeReveals: 3 })), { x: 0, y: 0, z: 0 })
        .state,
    );
    const { handlers, calls } = mountPointer("probe", opened);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    expect(calls).toEqual([]);
  });

  test("the mark tool leaves an open cell alone", () => {
    const opened = toClientView(
      revealCell(createGame(presetConfig("classic", { seed: 7 })), { x: 0, y: 0, z: 0 }).state,
    );
    const { handlers, calls } = mountPointer("flag", opened);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    expect(calls).toEqual([]);
  });

  test("digging reports a flagged cell instead of revealing the mine under it", () => {
    const marked = toClientView(
      cycleMark(createGame(presetConfig("classic", { seed: 7 })), { x: 0, y: 0, z: 0 }).state,
    );
    const { handlers, calls } = mountPointer("reveal", marked);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    expect(calls).toEqual(["blocked flagged 0,0,0"]);
  });
});

/**
 * Touch.
 *
 * A finger has none of the mouse's buttons: the tap that opens a cell and the
 * drag that turns the camera are the same press, and the only thing telling
 * them apart is how far it travelled (`pointerState.ts`). A *rest* on a cell
 * takes over the role Alt+click and the middle button play for a mouse, since
 * a finger has neither.
 */
describe("touch presses", () => {
  test("a tap acts on the cell under the finger", () => {
    const { handlers, calls, pointer } = mountPointer("reveal");
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    pointerDown(pointer, 0, true);
    // A fingertip rolls as it lands; this is still a tap on the same cell.
    pointerMove(pointer, 2, 0);

    dispatch(handlers, "onPointerUp", BURIED, { button: 0, pointerType: "touch" });

    expect(calls).toEqual(["reveal 0,0,0"]);
  });

  test("a finger that travelled orbits instead of acting on the cell it ends over", () => {
    const { handlers, calls, pointer } = mountPointer("reveal");
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    pointerDown(pointer, 0, true);
    pointerMove(pointer, 40, 0);

    dispatch(handlers, "onPointerUp", BURIED, { button: 0, pointerType: "touch" });

    expect(calls).toEqual([]);
  });

  test("a second finger landing cancels the first finger's tap", () => {
    const { handlers, calls, pointer } = mountPointer("flag");
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    pointerDown(pointer, 0, true);
    // The pinch begins: the rig closes the press off before any release.
    pointerGesture(pointer);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, pointerType: "touch" });

    expect(calls).toEqual([]);
  });

  test("resting a finger on a cell marks it, and the release does not act again", async () => {
    const { handlers, calls, pointer } = mountPointer("reveal");
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    pointerDown(pointer, 0, true);
    await Bun.sleep(LONG_PRESS_MS + 60);

    expect(calls).toEqual(["mark 0,0,0"]);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, pointerType: "touch" });
    expect(calls).toEqual(["mark 0,0,0"]);
  });

  test("a finger that travelled before the hold expired orbits instead of marking", async () => {
    const { handlers, calls, pointer } = mountPointer("reveal");
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    pointerDown(pointer, 0, true);
    pointerMove(pointer, 40, 0);
    await Bun.sleep(LONG_PRESS_MS + 60);

    expect(calls).toEqual([]);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, pointerType: "touch" });
    expect(calls).toEqual([]);
  });

  test("a mouse press never arms the resting mark", async () => {
    const { handlers, calls } = mountPointer("reveal");
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0 });
    await Bun.sleep(LONG_PRESS_MS + 60);

    expect(calls).toEqual([]);
  });

  test("the finger previews the cell it rests on and clears it on release", () => {
    const { handlers, hover, pointer } = mountPointer("reveal");
    pointerDown(pointer, 0, true);
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    expect(hover.cell).toEqual({ x: 0, y: 0, z: 0 });

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, pointerType: "touch" });
    expect(hover.cell).toBeNull();
  });

  test("a finger never leaves a hover highlight behind", () => {
    const { handlers, hover, pointer } = mountPointer("reveal");
    pointerDown(pointer, 0, true);
    dispatch(handlers, "onPointerMove", TRAJECTORY, { pointerType: "touch" });

    expect(hover.cell).toBeNull();
  });

  test("a phone's long-press menu does not re-centre the board", () => {
    const { handlers, calls } = mountPointer("reveal");
    dispatch(handlers, "onContextMenu", TRAJECTORY, { pointerType: "touch" });

    expect(calls).toEqual([]);
  });
});

/**
 * What the rest of the room is told.
 *
 * In a multiplayer game the board also carries where every other player is
 * pointing, so this layer has to report where *this* player's pointer is - and
 * just as importantly report when there is none, because a marker that outlives
 * the pointer is worse than no marker at all. Out-of-room games pass no
 * `onCursor` and pay nothing for it.
 */
describe("the pointer the room is told about", () => {
  test("a mouse publishes the cell it is over", () => {
    const { handlers, cursors } = mountPointer("reveal");

    dispatch(handlers, "onPointerMove", TRAJECTORY);

    expect(cursors).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  test("a press publishes the cell immediately, with no move first", () => {
    const { handlers, cursors } = mountPointer("reveal");

    dispatch(handlers, "onPointerDown", TRAJECTORY);

    expect(cursors).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  test("a mouse release leaves the pointer where it was", () => {
    const { handlers, cursors } = mountPointer("reveal");

    dispatch(handlers, "onPointerDown", TRAJECTORY);
    dispatch(handlers, "onPointerUp", TRAJECTORY);

    // No null: a mouse is still hovering there. Only the press is reported.
    expect(cursors).toEqual([{ x: 0, y: 0, z: 0 }]);
  });

  test("leaving the board clears the pointer", () => {
    const { handlers, cursors } = mountPointer("reveal");

    dispatch(handlers, "onPointerMove", TRAJECTORY);
    dispatch(handlers, "onPointerOut", BURIED);

    expect(cursors).toEqual([{ x: 0, y: 0, z: 0 }, null]);
  });

  test("a finger publishes where it is as it moves", () => {
    const { handlers, cursors, pointer } = mountPointer("reveal");
    pointerDown(pointer, 0, true);
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    dispatch(handlers, "onPointerMove", TRAJECTORY, { pointerType: "touch" });

    expect(cursors.at(-1)).toEqual({ x: 0, y: 0, z: 0 });
  });

  test("a finger that lifted after dragging is gone from the room", () => {
    const { handlers, cursors, pointer } = mountPointer("reveal");
    pointerDown(pointer, 0, true);
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    pointerMove(pointer, 40, 0);

    dispatch(handlers, "onPointerUp", BURIED, { button: 0, pointerType: "touch" });

    // The orbit ended somewhere else entirely; nothing is left pointing.
    expect(cursors.at(-1)).toBeNull();
  });

  test("a lifted tap clears the pointer", () => {
    const { handlers, cursors, pointer } = mountPointer("reveal");
    pointerDown(pointer, 0, true);
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, pointerType: "touch" });

    expect(cursors).toEqual([{ x: 0, y: 0, z: 0 }, null]);
  });

  test("the release of a resting mark clears the pointer too", async () => {
    const { handlers, cursors, pointer } = mountPointer("reveal");
    pointerDown(pointer, 0, true);
    dispatch(handlers, "onPointerDown", TRAJECTORY, { button: 0, pointerType: "touch" });
    await Bun.sleep(LONG_PRESS_MS + 60);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, pointerType: "touch" });

    expect(cursors.at(-1)).toBeNull();
  });

  test("a cancelled pointer is cleared", () => {
    const { handlers, cursors } = mountPointer("reveal");
    dispatch(handlers, "onPointerMove", TRAJECTORY);

    // A cancelled pointer never sends a release, so this is the only chance to
    // retire the marker.
    window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));

    expect(cursors).toEqual([{ x: 0, y: 0, z: 0 }, null]);
  });
});
