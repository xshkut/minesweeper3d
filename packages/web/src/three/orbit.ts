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
/**
 * Fraction of the current distance one wheel notch moves the camera.
 *
 * The prototype divided the raw delta by 40, i.e. a notch on a 5x5x5 board
 * (radius ~130) moved the camera 2.5 units - about 2%, which felt sluggish and
 * was asymmetric: the same step is a huge jump once you are zoomed in close.
 * Multiplying instead makes every notch the same *fraction*, so zooming in and
 * out feel alike at any distance.
 */
const ZOOM_STEP = 0.15;
/** Wheel delta, in pixels, that counts as one notch of {@link ZOOM_STEP}. */
const ZOOM_NOTCH = 100;
/** Fallback height in pixels of one page, for `DOM_DELTA_PAGE` wheel events. */
const WHEEL_PAGE_HEIGHT = 800;
/** Height in pixels of one text line, for `DOM_DELTA_LINE` wheel events. */
export const WHEEL_LINE_HEIGHT = 16;
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
    radius = clampRadius(radius * Math.exp((input.zoom / ZOOM_NOTCH) * ZOOM_STEP), limits);
  }

  if (azimuth === orbit.azimuth && polar === orbit.polar && radius === orbit.radius) return orbit;
  return { azimuth, polar, radius, target: orbit.target };
}

/**
 * Zoom delta equivalent to spreading or closing two fingers by `ratio`.
 *
 * The wheel and a pinch have to end up in the same unit or {@link applyOrbitInput}
 * could not tell them apart. One wheel notch is `ZOOM_NOTCH` pixels into
 * `ZOOM_STEP` of radius, and a pinch of `ratio` has to scale the radius by
 * exactly `1 / ratio` - a finger that doubles the distance between two fingers
 * halves the distance to the board - so the ratio is turned inside out with a
 * logarithm rather than approximated per frame. Applying that per move event
 * composes: the deltas of a whole gesture add up to the log of its total ratio.
 *
 * A non-positive or non-finite ratio means the two touches are on top of each
 * other, where a pinch has no meaning; it returns `0`, which moves nothing.
 */
export function zoomForPinch(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return 0;
  return -(Math.log(ratio) * ZOOM_NOTCH) / ZOOM_STEP;
}

/** Keeps the framing but looks at another point (right click on a cell). */
export function withTarget(orbit: OrbitState, target: Point3): OrbitState {
  if (orbit.target.x === target.x && orbit.target.y === target.y && orbit.target.z === target.z) return orbit;
  return { ...orbit, target };
}

/**
 * Converts a wheel event's raw delta into pixels.
 *
 * Browsers disagree about the unit: Chrome and Safari report pixels
 * (`deltaMode === 0`, ~100 per notch), Firefox reports *lines*
 * (`deltaMode === 1`, ~3 per notch) and a few report pages (`deltaMode === 2`).
 * Passing them all through unchanged made the same gesture zoom ~30x weaker in
 * Firefox, so the delta is scaled by this module before it reaches
 * {@link applyOrbitInput}.
 */
export function normalizeWheelDelta(deltaY: number, deltaMode: number, pageHeight = 0): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_HEIGHT;
  if (deltaMode === 2) return deltaY * (pageHeight > 0 ? pageHeight : WHEEL_PAGE_HEIGHT);
  return deltaY;
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
