/**
 * Camera rig: orbit input, smoothing and the frame loop.
 *
 * The maths lives in `orbit.ts`/`motion.ts` (both pure); this hook only wires
 * it to DOM events and to `useFrame`, which is where three.js is unavoidable.
 * All state sits in refs - the rig never re-renders React.
 *
 * Mouse and touch are one gesture with two spellings. A mouse drags the camera
 * with its right button; a finger has no such button, so a *drag* is the camera
 * gesture and a *tap* belongs to the board. Both are the same press to this
 * hook: it accumulates travel for either (see `pointerState.ts`), and the board
 * reads the resulting `dragged` flag to tell a tap from an orbit. Two fingers
 * add pinch-to-zoom on top, and turn the tap off entirely.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Vec3 } from "@minesweeper3d/game-core";
import { MotionVector } from "./motion";
import {
  DEFAULT_ORBIT_LIMITS,
  applyOrbitInput,
  normalizeWheelDelta,
  orbitToPosition,
  withTarget,
  zoomForPinch,
} from "./orbit";
import type { OrbitState, Point3 } from "./orbit";
import { boardCenter, initialOrientation, initialRadius } from "./board";
import {
  createPointerState,
  pointerDown,
  pointerGesture,
  pointerMove,
  pointerUp,
} from "./pointerState";
import type { PointerState } from "./pointerState";

/** Imperative handle the board uses to talk to the camera. */
export interface CameraRig {
  /** Shared pointer record; the board uses it to ignore camera drags. */
  readonly pointer: PointerState;
  /** Smoothly re-centres the orbit on a world point (right click on a cell). */
  recenter(target: Point3): void;
}

/** Options of {@link useCameraRig}. */
export interface CameraRigOptions {
  /** Size of the board being shown, or `null` before the first state arrives. */
  readonly size: Vec3 | null;
  /** Bumping this token re-frames the board, e.g. after "reset view". */
  readonly resetToken: number;
}

/** Time constant of the camera position spring (prototype values, in seconds). */
const POSITION_T1 = 0.2;
const POSITION_T2 = 0.1;
/** The aim follows faster and without a spring, like the prototype's aim motion. */
const AIM_T1 = 0.1;

/** A pointer's position, in client coordinates. */
interface Contact {
  readonly x: number;
  readonly y: number;
}

/** Distance and midpoint of the two fingers of a pinch, at one frame. */
interface Pinch {
  readonly distance: number;
  readonly x: number;
  readonly y: number;
}

/**
 * `true` for a pointer that has no second button to give the camera.
 *
 * A finger is obvious; a stylus is treated the same way because touching the
 * screen is the only gesture it shares with a mouse, and its barrel button is
 * not something a player can be asked to find.
 */
function isFinger(pointerType: string): boolean {
  return pointerType === "touch" || pointerType === "pen";
}

/** Wires the orbit camera to the canvas. Must be used inside `<Canvas>`. */
export function useCameraRig(options: CameraRigOptions): CameraRig {
  const { camera, gl } = useThree();
  const pointer = useMemo(createPointerState, []);
  const orbitRef = useRef<OrbitState | null>(null);
  const lastSizeKey = useRef<string | null>(null);
  /**
   * Every pointer currently down, by pointer id.
   *
   * Movement is measured from these stored positions rather than from
   * `movementX`/`movementY`, which several browsers report as `0` for touch
   * (and older Safari does not report at all for touch events).
   */
  const contacts = useRef(new Map<number, Contact>());
  /** Previous frame of a two-finger pinch; `null` outside one. */
  const pinch = useRef<Pinch | null>(null);
  const positionMotion = useMemo(
    () => new MotionVector({ value: camera.position, T1: POSITION_T1, T2: POSITION_T2 }),
    [camera],
  );
  const aimMotion = useMemo(() => new MotionVector({ value: boardCenter(), T1: AIM_T1 }), []);

  const sizeKey = options.size === null ? null : `${options.size.x}x${options.size.y}x${options.size.z}`;

  // Framing: a new board snaps into view, "reset view" glides back to it.
  useEffect(() => {
    const size = options.size;
    if (size === null) return;

    const framing: OrbitState = {
      ...initialOrientation(),
      radius: initialRadius(size),
      target: boardCenter(),
    };
    const isNewBoard = lastSizeKey.current !== sizeKey;
    lastSizeKey.current = sizeKey;
    orbitRef.current = framing;

    if (!isNewBoard) return;
    const position = orbitToPosition(framing);
    positionMotion.reset(position);
    aimMotion.reset(framing.target);
    camera.position.set(position.x, position.y, position.z);
    camera.lookAt(framing.target.x, framing.target.y, framing.target.z);
    // `resetToken` is intentionally a dependency: bumping it re-frames the view.
  }, [sizeKey, options.resetToken, camera, positionMotion, aimMotion]);

  useFrame((_, delta) => {
    const orbit = orbitRef.current;
    if (orbit === null) return;

    positionMotion.setTarget(orbitToPosition(orbit));
    aimMotion.setTarget(orbit.target);

    const position = positionMotion.step(delta);
    camera.position.set(position.x, position.y, position.z);
    const aim = aimMotion.step(delta);
    camera.lookAt(aim.x, aim.y, aim.z);
  });

  useEffect(() => {
    const element = gl.domElement;
    const preventContextMenu = (event: Event): void => event.preventDefault();

    /** Orbits by a pointer delta, or does nothing when the camera is not framed yet. */
    const orbitBy = (deltaX: number, deltaY: number, zoom: number): void => {
      if (orbitRef.current === null) return;
      orbitRef.current = applyOrbitInput(
        orbitRef.current,
        { dragging: true, deltaX, deltaY, zoom },
        DEFAULT_ORBIT_LIMITS,
      );
    };

    const handleDown = (event: PointerEvent): void => {
      const finger = isFinger(event.pointerType);
      contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      // A new contact invalidates the pinch baseline: the next frame starts a
      // fresh one instead of measuring the distance to a finger that just left.
      pinch.current = null;

      if (finger) {
        // The first finger is a tap until it travels; a second one means the
        // player is pinching, so neither finger may act on a cell any more.
        if (contacts.current.size === 1) pointerDown(pointer, 0, true);
        else pointerGesture(pointer);
      } else {
        pointerDown(pointer, event.button, false);
      }

      if (finger || event.button === 2) {
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is a nicety; dragging still works without it.
        }
      }
    };

    /** One finger: orbit once it has travelled, so a tap stays a tap. */
    const moveFinger = (deltaX: number, deltaY: number): void => {
      pointerMove(pointer, deltaX, deltaY);
      if (!pointer.dragged) return;
      orbitBy(deltaX, deltaY, 0);
    };

    /** Two fingers: pinch to zoom, and drag the midpoint to orbit. */
    const movePinch = (): void => {
      const points = [...contacts.current.values()];
      const first = points[0];
      const second = points[1];
      if (first === undefined || second === undefined) return;

      const distance = Math.hypot(first.x - second.x, first.y - second.y);
      const x = (first.x + second.x) / 2;
      const y = (first.y + second.y) / 2;
      const previous = pinch.current;
      pinch.current = { distance, x, y };
      if (previous === null) return;

      orbitBy(x - previous.x, y - previous.y, zoomForPinch(distance / previous.distance));
    };

    const handleMove = (event: PointerEvent): void => {
      const from = contacts.current.get(event.pointerId);
      if (from === undefined) return;
      contacts.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const deltaX = event.clientX - from.x;
      const deltaY = event.clientY - from.y;

      if (!isFinger(event.pointerType)) {
        pointerMove(pointer, deltaX, deltaY);
        if (!pointer.down || pointer.button !== 2) return;
        orbitBy(deltaX, deltaY, 0);
        return;
      }

      if (contacts.current.size >= 2) movePinch();
      else moveFinger(deltaX, deltaY);
    };

    const handleUp = (event: PointerEvent): void => {
      contacts.current.delete(event.pointerId);
      pinch.current = null;
      // Lifting one of two fingers ends the pinch but not the press: the finger
      // still down keeps orbiting, and neither of them was ever a tap.
      if (contacts.current.size > 0) return;
      pointerUp(pointer);
      try {
        if (element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore: capture may never have been taken.
      }
    };

    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      if (orbitRef.current === null) return;
      // Firefox reports wheel movement in lines, not pixels; normalise first so
      // one notch zooms the same amount in every browser.
      const zoom = normalizeWheelDelta(event.deltaY, event.deltaMode, element.clientHeight);
      orbitRef.current = applyOrbitInput(
        orbitRef.current,
        { dragging: false, deltaX: 0, deltaY: 0, zoom },
        DEFAULT_ORBIT_LIMITS,
      );
    };

    element.addEventListener("contextmenu", preventContextMenu);
    element.addEventListener("pointerdown", handleDown);
    element.addEventListener("wheel", handleWheel, { passive: false });
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleUp);

    return () => {
      element.removeEventListener("contextmenu", preventContextMenu);
      element.removeEventListener("pointerdown", handleDown);
      element.removeEventListener("wheel", handleWheel);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };
  }, [gl, pointer]);

  const recenter = useCallback((target: Point3) => {
    if (orbitRef.current === null) return;
    orbitRef.current = withTarget(orbitRef.current, target);
  }, []);

  return useMemo(() => ({ pointer, recenter }), [pointer, recenter]);
}
