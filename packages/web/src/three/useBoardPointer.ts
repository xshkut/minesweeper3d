/**
 * Board interaction: turns r3f pointer events on the covered-cell instances
 * into reveal / mark / probe / recentre actions.
 *
 * The board renders every covered cell in a single instanced mesh, so there is
 * exactly one set of handlers for the whole board (`event.instanceId` says
 * which cell was hit) instead of a thousand closures.
 *
 * Which action a left click performs comes from the active {@link BoardTool},
 * because three of them act on the same covered cells. The Chrome-and-mouse
 * conventions survive regardless of the tool: the middle button and Alt+click
 * always cycle the mark, and a right click still recentres the board.
 *
 * Touch gets the same actions through the gestures it actually has. A *tap*
 * acts on the cell it landed on, a *rest* on a cell marks it (a finger has no
 * Alt or middle button), and anything that travelled is left alone: that was
 * the player pushing the camera around, and `pointerState.ts` says so.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
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

/** Why an action was refused, so the HUD can explain it. */
export type BlockedReason = "flagged" | "buried" | "no-charges" | "probed";

/** What a left click does to a covered cell. */
export type BoardTool = "reveal" | "flag" | "probe";

/**
 * How long a finger has to rest on a cell before the cell is marked.
 *
 * Long enough that a tap never turns into a mark by accident, short enough that
 * holding a cell does not feel like waiting; the same ballpark as the platform
 * long-press a phone user already knows.
 */
export const LONG_PRESS_MS = 450;

/** Options of {@link useBoardPointer}. */
export interface BoardPointerOptions {
  readonly state: ClientGameState;
  readonly hover: HoverSlot;
  readonly pointer: PointerState;
  readonly tool: BoardTool;
  readonly onReveal: (cell: CellIndex) => void;
  readonly onMark: (cell: CellIndex) => void;
  readonly onProbe: (cell: CellIndex) => void;
  readonly onBlocked: (cell: CellIndex, reason: BlockedReason) => void;
  readonly onRecenter: (point: Point3) => void;
  /**
   * Reports the cell this player is pointing at, or `null` when they lifted the
   * pointer off the board.
   *
   * Optional, and deliberately the whole of what this layer knows about other
   * players: in a room the cell is published to the server, in a private game
   * there is nothing to subscribe to it and the option is simply absent.
   */
  readonly onCursor?: ((cell: CellIndex | null) => void) | undefined;
}

/** r3f event handlers to spread onto the covered-cell mesh. */
export interface BoardPointerHandlers {
  onPointerDown(event: ThreeEvent<PointerEvent>): void;
  onPointerMove(event: ThreeEvent<PointerEvent>): void;
  onPointerOut(): void;
  onPointerUp(event: ThreeEvent<PointerEvent>): void;
  onContextMenu(event: ThreeEvent<MouseEvent>): void;
}

/** A press that has not come back up yet: the cell it started on is fixed. */
interface Press {
  readonly pointerId: number;
  readonly button: number;
  readonly cell: CellIndex;
  /** Set once the press has acted already, so its release must not act again. */
  consumed: boolean;
}

/**
 * `pointerType` of an r3f event, whichever of the two shapes carries it.
 *
 * r3f spreads the native event's own properties onto the event it hands to a
 * handler, but not every browser (or every test double) fills in `nativeEvent`
 * the same way, so both are read and an absent type counts as a mouse.
 */
function pointerTypeOf(event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): string | undefined {
  const native = event.nativeEvent as { pointerType?: string } | undefined;
  return native?.pointerType ?? (event as { pointerType?: string }).pointerType;
}

/** `true` for a press from a finger or a stylus, which has no buttons of its own. */
function isFingerPress(event: ThreeEvent<PointerEvent>, pointer: PointerState): boolean {
  if (pointer.touch) return true;
  const type = pointerTypeOf(event);
  return type === "touch" || type === "pen";
}

/** Short haptic tick, on the devices that have one. */
function vibrate(): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  navigator.vibrate(10);
}

/** Must be used inside `<Canvas>`. */
export function useBoardPointer(options: BoardPointerOptions): BoardPointerHandlers {
  const { state, hover, pointer, tool, onReveal, onMark, onProbe, onBlocked, onRecenter, onCursor } = options;
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

  /** Cell under the nearest intersection of an event, or `null` for a deeper hit. */
  const nearestCell = useCallback(
    (event: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): CellIndex | null => {
      const hit = nearestHit(event);
      return hit === null ? null : cellOf(hit.instanceId);
    },
    [cellOf, nearestHit],
  );

  /**
   * The press that is still waiting for its release.
   *
   * Which cell a click acts on is decided when the button goes down, not when
   * it comes back up. A fast click never holds the mouse perfectly still, so
   * re-picking at the release point would act on whichever cell the pointer
   * drifted onto - and nothing at all once it drifted onto revealed space.
   */
  const pressRef = useRef<Press | null>(null);
  /** Pending "the finger is resting on a cell" timer, if one is armed. */
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelLongPress = useCallback((): void => {
    if (longPressTimer.current === null) return;
    clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }, []);

  /** Publishes the cell under this player's pointer; a no-op in a private game. */
  const publishCursor = useCallback(
    (cell: CellIndex | null): void => {
      onCursor?.(cell);
    },
    [onCursor],
  );

  useEffect(() => {
    // A press that does not land on the board must not leave a stale press
    // behind for a later release to consume. Capture phase, so this runs before
    // the canvas listener that records the press. It is also what stops a
    // second finger from letting the first one's rest mark a cell.
    const forget = (): void => {
      pressRef.current = null;
      cancelLongPress();
    };
    // A cancelled pointer never comes back up, so it is also the only place that
    // can clear where the finger was.
    const cancel = (): void => {
      forget();
      publishCursor(null);
    };
    window.addEventListener("pointerdown", forget, true);
    window.addEventListener("pointercancel", cancel, true);
    return () => {
      window.removeEventListener("pointerdown", forget, true);
      window.removeEventListener("pointercancel", cancel, true);
      cancelLongPress();
    };
  }, [cancelLongPress, publishCursor]);

  const setCursor = useCallback(
    (cursor: string): void => {
      canvas.style.cursor = cursor;
    },
    [canvas],
  );

  const onPointerMove = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      // A finger has no hover: it covers the cell it is about to act on, so a
      // highlight that followed it around the board would only be noise left
      // behind when the finger lifts. The rest of the room still gets to see
      // where the finger is, though.
      if (isFingerPress(event, pointer)) {
        const finger = nearestCell(event);
        if (finger !== null) publishCursor(finger);
        return;
      }
      const cell = nearestCell(event);
      if (cell === null) return;
      publishCursor(cell);
      if (setHover(hover, cell)) setCursor("pointer");
    },
    [hover, nearestCell, pointer, publishCursor, setCursor],
  );

  const onPointerOut = useCallback((): void => {
    setHover(hover, null);
    setCursor("default");
    // The board let the pointer go, so the room stops seeing it here.
    publishCursor(null);
  }, [hover, publishCursor, setCursor]);

  const onPointerDown = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      // One ray crosses every covered cell behind the front one, and r3f calls
      // the handler once per crossing. Stop the first (nearest) delivery so the
      // press is not overwritten by the cells further back.
      event.stopPropagation();
      const cell = nearestCell(event);
      if (cell === null) return;

      const press: Press = { pointerId: event.pointerId, button: event.button, cell, consumed: false };
      pressRef.current = press;
      cancelLongPress();
      // Pressing is the one moment a pointer can appear without having moved
      // first (a click on an already-hovered cell, or the first touch of a tap).
      publishCursor(cell);

      if (!isFingerPress(event, pointer)) return;

      // Preview the cell under the finger; the release clears it again.
      setHover(hover, cell);
      longPressTimer.current = setTimeout(() => {
        longPressTimer.current = null;
        // Only the press that armed the timer still counts, and only while it
        // is still a rest - a finger that travelled is orbiting the camera.
        if (pressRef.current !== press || pointer.dragged) return;
        press.consumed = true;
        vibrate();
        onMark(cell);
      }, LONG_PRESS_MS);
    },
    [cancelLongPress, hover, nearestCell, onMark, pointer, publishCursor],
  );

  const onPointerUp = useCallback(
    (event: ThreeEvent<PointerEvent>): void => {
      event.stopPropagation();
      cancelLongPress();

      // A finger that travelled was pushing the camera around, not tapping: the
      // cell it happens to come up over is wherever the orbit ended.
      if (pointer.touch && pointer.dragged) {
        pressRef.current = null;
        setHover(hover, null);
        publishCursor(null);
        return;
      }

      const press = pressRef.current;
      pressRef.current = null;

      // The cell the button went down on, falling back to the release point
      // only when the press went missing (it started outside the board).
      let cell: CellIndex | null;
      if (press !== null && press.pointerId === event.pointerId && press.button === event.button) {
        // The long press already marked this cell; its release is just the end
        // of that gesture and must not mark or dig a second time.
        if (press.consumed) {
          setHover(hover, null);
          publishCursor(null);
          return;
        }
        cell = press.cell;
      } else {
        cell = nearestCell(event);
      }
      if (isFingerPress(event, pointer)) {
        setHover(hover, null);
        // The finger left the board; the room stops seeing it there.
        publishCursor(null);
      }
      if (cell === null) return;

      // The middle button and Alt+click are a shortcut for the mark tool, so the
      // classic flagging gesture keeps working whatever tool is selected.
      if (event.button === 1 || (event.button === 0 && event.altKey)) {
        onMark(cell);
        return;
      }
      if (event.button !== 0) return;

      const target = state.cells[grid.offsetOf(cell)];
      if (tool === "probe") {
        // A detector answers a question about the board, not about the digging
        // frontier, so a buried cell is a legitimate target here - unlike a reveal.
        if (target?.isRevealed === true) return;
        if (target?.isProbed === true) {
          onBlocked(cell, "probed");
          return;
        }
        if (state.freeRevealsLeft <= 0) {
          onBlocked(cell, "no-charges");
          return;
        }
        onProbe(cell);
        return;
      }

      if (tool === "flag") {
        // Marking a revealed cell has nothing to mark, and the engine would
        // refuse it anyway; skipping the click keeps the notice quiet.
        if (target?.isRevealed === true) return;
        onMark(cell);
        return;
      }

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
    [cancelLongPress, grid, hover, nearestCell, onBlocked, onMark, onProbe, onReveal, pointer, publishCursor, state, tool],
  );

  const onContextMenu = useCallback(
    (event: ThreeEvent<MouseEvent>): void => {
      event.nativeEvent.preventDefault();
      // A phone sends a contextmenu for its own long press, which is the mark
      // gesture here; re-centring the board out from under the flag would be a
      // surprise, and touch has no right button to have asked for it.
      const type = pointerTypeOf(event);
      if (type === "touch" || type === "pen") return;
      const hit = nearestHit(event);
      if (hit === null || pointer.dragged) return;
      // Recentre on the exact point that was hit, like the prototype did.
      onRecenter({ x: hit.point.x, y: hit.point.y, z: hit.point.z });
    },
    [nearestHit, onRecenter, pointer],
  );

  return useMemo(
    () => ({ onPointerDown, onPointerMove, onPointerOut, onPointerUp, onContextMenu }),
    [onPointerDown, onPointerMove, onPointerOut, onPointerUp, onContextMenu],
  );
}
