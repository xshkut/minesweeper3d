/**
 * Spherical orbit camera maths - a three.js free port of the prototype's
 * `scripts/cameraControl.js` so it can be unit tested.
 *
 * The prototype stored three loose variables (`fi`, `fi2`, `r`) on a singleton;
 * here they are plain data (`azimuth`, `polar`, `radius`) plus the point the
 * camera looks at, which makes recentring trivial and keeps the camera rig free
 * of hidden state.
 */

/** A point in world space. */
export interface Point3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Camera placement around a target point. */
export interface OrbitState {
  /** Rotation around the world Y axis, radians. */
  readonly azimuth: number;
  /** Elevation above the XZ plane, radians, clamped to `±maxPolar`. */
  readonly polar: number;
  /** Distance from the target. */
  readonly radius: number;
  readonly target: Point3;
}

/** Constraints applied to every orbit update. */
export interface OrbitLimits {
  readonly minRadius: number;
  readonly maxRadius: number;
  /** Highest absolute elevation; keeps the camera off the poles. */
  readonly maxPolar: number;
}

/** Limits ported from the prototype (radius floor 5, polar 0.2 rad off the pole). */
export const DEFAULT_ORBIT_LIMITS: OrbitLimits = Object.freeze({
  minRadius: 5,
  maxRadius: 4000,
  maxPolar: Math.PI / 2 - 0.2,
});

/** Pointer deltas are divided by this, exactly like the prototype did. */
const DRAG_DIVISOR = 100;
/** Wheel deltas are divided by this, exactly like the prototype did. */
const ZOOM_DIVISOR = 40;
const EPSILON = 1e-6;
const TWO_PI = Math.PI * 2;

/** One frame of user input for {@link applyOrbitInput}. */
export interface OrbitInput {
  /** `true` while the orbit button is held down. */
  readonly dragging: boolean;
  /** Horizontal pointer movement in pixels since the last frame. */
  readonly deltaX: number;
  /** Vertical pointer movement in pixels since the last frame. */
  readonly deltaY: number;
  /** Wheel delta; positive zooms out. */
  readonly zoom: number;
}

/** World space position of the camera for an orbit state. */
export function orbitToPosition(orbit: OrbitState): Point3 {
  const horizontal = Math.cos(orbit.polar) * orbit.radius;
  return {
    x: Math.cos(orbit.azimuth) * horizontal + orbit.target.x,
    y: Math.sin(orbit.polar) * orbit.radius + orbit.target.y,
    z: Math.sin(orbit.azimuth) * horizontal + orbit.target.z,
  };
}

/**
 * Inverse of {@link orbitToPosition}.
 *
 * `fallbackAzimuth` is used when the camera sits exactly above the target,
 * where the azimuth is undefined; the caller passes the previous value so the
 * view never jumps.
 */
export function deriveOrbit(
  position: Point3,
  target: Point3,
  limits: OrbitLimits = DEFAULT_ORBIT_LIMITS,
  fallbackAzimuth = 0,
): OrbitState {
  const dx = position.x - target.x;
  const dy = position.y - target.y;
  const dz = position.z - target.z;
  const horizontal = Math.hypot(dx, dz);
  const radius = Math.hypot(horizontal, dy);

  if (radius < EPSILON) {
    return { azimuth: normalizeAzimuth(fallbackAzimuth), polar: 0, radius: limits.minRadius, target };
  }

  const elevation = Math.acos(Math.min(1, horizontal / radius));
  const polar = dy < 0 ? -elevation : elevation;
  const azimuth =
    horizontal < EPSILON
      ? fallbackAzimuth
      : dx > 0
        ? Math.asin(clampUnit(dz / horizontal))
        : Math.PI - Math.asin(clampUnit(dz / horizontal));

  return {
    azimuth: normalizeAzimuth(azimuth),
    polar: clampPolar(polar, limits),
    radius: clampRadius(radius, limits),
    target,
  };
}

/** Applies pointer input, clamping polar and radius. Returns the same object when nothing moved. */
export function applyOrbitInput(
  orbit: OrbitState,
  input: OrbitInput,
  limits: OrbitLimits = DEFAULT_ORBIT_LIMITS,
): OrbitState {
  let azimuth = orbit.azimuth;
  let polar = orbit.polar;
  let radius = orbit.radius;

  if (input.dragging) {
    azimuth = normalizeAzimuth(azimuth + input.deltaX / DRAG_DIVISOR);
    polar = clampPolar(polar + input.deltaY / DRAG_DIVISOR, limits);
  }
  if (input.zoom !== 0) {
    radius = clampRadius(radius + input.zoom / ZOOM_DIVISOR, limits);
  }

  if (azimuth === orbit.azimuth && polar === orbit.polar && radius === orbit.radius) return orbit;
  return { azimuth, polar, radius, target: orbit.target };
}

/** Keeps the framing but looks at another point (right click on a cell). */
export function withTarget(orbit: OrbitState, target: Point3): OrbitState {
  if (orbit.target.x === target.x && orbit.target.y === target.y && orbit.target.z === target.z) return orbit;
  return { ...orbit, target };
}

/** Clamps an elevation to the configured band. */
export function clampPolar(polar: number, limits: OrbitLimits = DEFAULT_ORBIT_LIMITS): number {
  return Math.max(-limits.maxPolar, Math.min(limits.maxPolar, polar));
}

/** Clamps a distance to the configured band. */
export function clampRadius(radius: number, limits: OrbitLimits = DEFAULT_ORBIT_LIMITS): number {
  return Math.max(limits.minRadius, Math.min(limits.maxRadius, radius));
}

/**
 * Wraps an azimuth into `[-π/2, 3π/2)`.
 *
 * That band is exactly the range {@link deriveOrbit} can produce, so a
 * derive/orbit round trip is lossless while dragging can wrap forever.
 */
export function normalizeAzimuth(azimuth: number): number {
  const shifted = azimuth + Math.PI / 2;
  const wrapped = ((shifted % TWO_PI) + TWO_PI) % TWO_PI;
  return wrapped - Math.PI / 2;
}

function clampUnit(value: number): number {
  return Math.max(-1, Math.min(1, value));
}
