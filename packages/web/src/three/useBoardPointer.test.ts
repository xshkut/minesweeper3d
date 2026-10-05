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
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { createGame, createGrid, presetConfig, toClientView } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState, Vec3 } from "@minesweeper3d/game-core";
import type { ThreeEvent } from "@react-three/fiber";

// The hook only reaches into r3f for the canvas it sets the cursor on; the rest
// of this file is plain React.
const canvas = { style: { cursor: "default" } };
mock.module("@react-three/fiber", () => ({
  useThree: (select: (state: { gl: { domElement: typeof canvas } }) => unknown) =>
    select({ gl: { domElement: canvas } }),
}));

const { useBoardPointer } = await import("./useBoardPointer");
const { createHoverSlot } = await import("./hover");
const { createPointerState } = await import("./pointerState");
const { cellKey } = await import("@minesweeper3d/game-core");

/** Board used by every test; nothing is revealed, so all cells are covered. */
const STATE: ClientGameState = toClientView(createGame(presetConfig("classic", { seed: 7 })));
const GRID = createGrid(STATE.config.size);

/** A ray entering on the board's diagonal: (0,0,0) first, two cells behind it. */
const TRAJECTORY: readonly CellIndex[] = [
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 1, z: 1 },
  { x: 2, y: 2, z: 2 },
];

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
  name: "onPointerMove" | "onPointerUp" | "onContextMenu",
  trajectory: readonly CellIndex[],
  extras: { readonly button?: number; readonly altKey?: boolean } = {},
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
      altKey: extras.altKey ?? false,
      nativeEvent: { preventDefault: () => undefined },
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
  flagMode: boolean,
  state: ClientGameState = STATE,
): {
  readonly handlers: ReturnType<typeof useBoardPointer>;
  readonly calls: string[];
  readonly hover: ReturnType<typeof createHoverSlot>;
  readonly pointer: ReturnType<typeof createPointerState>;
} {
  const calls: string[] = [];
  const hover = createHoverSlot();
  const pointer = createPointerState();

  const { result } = renderHook(() =>
    useBoardPointer({
      state,
      hover,
      pointer,
      flagMode,
      onReveal: (cell) => calls.push(`reveal ${cellKey(cell)}`),
      onFlag: (cell) => calls.push(`flag ${cellKey(cell)}`),
      onBlocked: (cell, reason) => calls.push(`blocked ${reason} ${cellKey(cell)}`),
      onRecenter: (point: Vec3) => calls.push(`recenter ${point.x},${point.y},${point.z}`),
    }),
  );

  return { handlers: result.current, calls, hover, pointer };
}

afterEach(cleanup);

describe("useBoardPointer", () => {
  test("flagging a ray that crosses three cells flags only the nearest one", () => {
    const { handlers, calls } = mountPointer(true);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    expect(calls).toEqual(["flag 0,0,0"]);
  });

  test("alt-click flags the nearest cell too", () => {
    const { handlers, calls } = mountPointer(false);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0, altKey: true });

    expect(calls).toEqual(["flag 0,0,0"]);
  });

  test("middle-click flags the nearest cell too", () => {
    const { handlers, calls } = mountPointer(false);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 1 });

    expect(calls).toEqual(["flag 0,0,0"]);
  });

  test("a click is delivered exactly once, however many cells the ray crosses", () => {
    const { handlers } = mountPointer(true);

    const { deliveries, stopped } = dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    // Stopping the first delivery is what keeps r3f from handing the event to
    // the cells behind it (and from booking them as hovered).
    expect(deliveries).toBe(1);
    expect(stopped).toBe(true);
  });

  test("revealing a ray affects only the nearest cell", () => {
    const { handlers, calls } = mountPointer(false);

    dispatch(handlers, "onPointerUp", TRAJECTORY, { button: 0 });

    // (0,0,0) is on the surface and can be opened; the cells behind it are
    // buried, so they must not even reach the "blocked" report.
    expect(calls).toEqual(["reveal 0,0,0"]);
  });

  test("hover and recentring follow the nearest hit", () => {
    const { handlers, calls, hover } = mountPointer(false);

    dispatch(handlers, "onPointerMove", TRAJECTORY);
    expect(hover.cell).toEqual({ x: 0, y: 0, z: 0 });

    dispatch(handlers, "onContextMenu", TRAJECTORY);
    expect(calls).toEqual(["recenter 0,0,0"]);
  });
});
