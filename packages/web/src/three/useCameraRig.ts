/**
 * Camera rig: orbit input, smoothing and the frame loop.
 *
 * The maths lives in `orbit.ts`/`motion.ts` (both pure); this hook only wires
 * it to DOM events and to `useFrame`, which is where three.js is unavoidable.
 * All state sits in refs - the rig never re-renders React.
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useFrame, useThree } from "@react-three/fiber";
import type { Vec3 } from "@minesweeper3d/game-core";
import { MotionVector } from "./motion";
import { DEFAULT_ORBIT_LIMITS, applyOrbitInput, orbitToPosition, withTarget } from "./orbit";
import type { OrbitState, Point3 } from "./orbit";
import { boardCenter, initialOrientation, initialRadius } from "./board";
import { createPointerState, pointerDown, pointerMove, pointerUp } from "./pointerState";
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

/** Wires the orbit camera to the canvas. Must be used inside `<Canvas>`. */
export function useCameraRig(options: CameraRigOptions): CameraRig {
  const { camera, gl } = useThree();
  const pointer = useMemo(createPointerState, []);
  const orbitRef = useRef<OrbitState | null>(null);
  const lastSizeKey = useRef<string | null>(null);
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

    const handleDown = (event: PointerEvent): void => {
      pointerDown(pointer, event.button);
      if (event.button === 2) {
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is a nicety; dragging still works without it.
        }
      }
    };

    const handleMove = (event: PointerEvent): void => {
      pointerMove(pointer, event.movementX, event.movementY);
      if (!pointer.down || pointer.button !== 2 || orbitRef.current === null) return;
      orbitRef.current = applyOrbitInput(
        orbitRef.current,
        { dragging: true, deltaX: event.movementX, deltaY: event.movementY, zoom: 0 },
        DEFAULT_ORBIT_LIMITS,
      );
    };

    const handleUp = (event: PointerEvent): void => {
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
      orbitRef.current = applyOrbitInput(
        orbitRef.current,
        { dragging: false, deltaX: 0, deltaY: 0, zoom: event.deltaY },
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
