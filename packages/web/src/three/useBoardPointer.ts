/**
 * Board interaction: turns r3f pointer events on the covered-cell instances
 * into reveal / flag / recentre actions.
 *
 * The board renders every covered cell in a single instanced mesh, so there is
 * exactly one set of handlers for the whole board (`event.instanceId` says
 * which cell was hit) instead of a thousand closures.
 */
import { useCallback, useMemo } from "react";
import { useThree } from "@react-three/fiber";
import type { ThreeEvent } from "@react-three/fiber";
import type { Intersection } from "three";
import { createGrid } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { isClientCellExposed } from "../session/hints";
import { setHover } from "./hover";
import type { HoverSlot } from "./hover";
import type { PointerState } from "./pointerState";
import type { Point3 } from "./orbit";

/** Why a reveal was refused, so the HUD can explain it. */
export type BlockedReason = "flagged" | "buried";

/** Options of {@link useBoardPointer}. */
export interface BoardPointerOptions {
  readonly state: ClientGameState;
  readonly hover: HoverSlot;
  readonly pointer: PointerState;
  readonly flagMode: boolean;
  readonly onReveal: (cell: CellIndex) => void;
  readonly onFlag: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
  readonly onRecenter: (point: Point3) => void;
}

/** r3f event handlers to spread onto the covered-cell mesh. */
export interface BoardPointerHandlers {
  onPointerMove(event: ThreeEvent<PointerEvent>): void;
  onPointerOut(): void;
  onPointerUp(event: ThreeEvent<PointerEvent>): void;
  onContextMenu(event: ThreeEvent<MouseEvent>): void;
}

/** Must be used inside `<Canvas>`. */
export function useBoardPointer(options: BoardPointerOptions): BoardPointerHandlers {
  const { state, hover, pointer, flagMode, onReveal, onFlag, onBlocked, onRecenter } = options;
  const canvas = useThree((three) => three.gl.domElement);

  const grid = useMemo(
    () => createGrid(state.config.size),
    // The size object is replaced with the state, so its parts are the identity.
    [state.config.size.x, state.config.size.y, state.config.size.z],
  );

  const cellOf = useCallback(
    (instanceId: number | undefined): CellIndex | null => {
      if (instanceId === undefined) return null;
      const cell = grid.cellOf(instanceId);
      return grid.contains(cell) ? cell : null;
    },
    [grid],
  );

  /**
   * Nearest intersection of a pointer event, or `null` when the event is about
   * one of the cells behind it.
   *
   * The board is a single instanced mesh, so a ray that enters it crosses the
   * front covered cell *and every covered cell behind it*. three.js reports
   * each crossing as an intersection and r3f calls the handlers once per
   * intersection, nearest first - so without this, one click would flag (or
   * reveal) every cell along the trajectory.
   *
   * Only the first crossing is a pick, so the event is stopped before r3f can
   * hand it to the deeper hits (which also keeps r3f from tracking them as
   * hovered) and the invocations that carry a deeper `instanceId` are dropped.
   */
  const nearestHit = useCallback(
    (event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): Intersection | null => {
      event.stopPropagation();
      const hit = event.intersections[0];
      const instanceId = hit?.instanceId;
      if (instanceId === undefined || instanceId !== event.instanceId) return null;
      return hit ?? null;
    },
    [],
  );

  const setCursor = useCallback(
    (cursor: string): void => {
      canvas.style.cursor = cursor;
    },
    [canvas],
  );

  const onPointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      const hit = nearestHit(event);
      if (hit === null) return;
      const cell = cellOf(hit.instanceId);
      if (cell === null) return;
      if (setHover(hover, cell)) setCursor("pointer");
    },
    [cellOf, hover, nearestHit, setCursor],
  );

  const onPointerOut = useCallback((): void => {
    setHover(hover, null);
    setCursor("default");
  }, [hover, setCursor]);

  const onPointerUp = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      const hit = nearestHit(event);
      if (hit === null) return;
      const cell = cellOf(hit.instanceId);
      if (cell === null) return;
      // A press that turned into a camera drag is not a click.
      if (pointer.dragged) return;

      const wantsFlag = event.button === 1 || (event.button === 0 && (flagMode || event.altKey));
      if (wantsFlag) {
        onFlag(cell);
        return;
      }
      if (event.button !== 0) return;

      const target = state.cells[grid.offsetOf(cell)];
      if (target?.isFlagged === true) {
        onBlocked(cell, "flagged");
        return;
      }
      if (!isClientCellExposed(state, cell)) {
        onBlocked(cell, "buried");
        return;
      }
      onReveal(cell);
    },
    [cellOf, flagMode, grid, nearestHit, onBlocked, onFlag, onReveal, pointer, state],
  );

  const onContextMenu = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      event.nativeEvent.preventDefault();
      const hit = nearestHit(event);
      if (hit === null || pointer.dragged) return;
      // Recentre on the exact point that was hit, like the prototype did.
      onRecenter({ x: hit.point.x, y: hit.point.y, z: hit.point.z });
    },
    [nearestHit, onRecenter, pointer],
  );

  return useMemo(
    () => ({ onPointerMove, onPointerOut, onPointerUp, onContextMenu }),
    [onPointerMove, onPointerOut, onPointerUp, onContextMenu],
  );
}
