import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ORBIT_LIMITS,
  WHEEL_LINE_HEIGHT,
  applyOrbitInput,
  deriveOrbit,
  normalizeAzimuth,
  normalizeWheelDelta,
  orbitToPosition,
  withTarget,
  zoomForPinch,
} from "./orbit";
import type { OrbitState } from "./orbit";

const TARGET = { x: 25, y: 25, z: 25 };

function orbit(partial: Partial<OrbitState> = {}): OrbitState {
  return { azimuth: Math.PI / 4, polar: 0.6, radius: 130, target: TARGET, ...partial };
}

function expectClose(actual: number, expected: number, precision = 9): void {
  expect(Math.abs(actual - expected)).toBeLessThan(10 ** -precision);
}

describe("orbit", () => {
  test("position and state round trip", () => {
    for (const azimuth of [-1.4, -Math.PI / 4, 0, Math.PI / 4, 2.2, 4.5]) {
      for (const polar of [-1.2, -0.4, 0, 0.37, 1.3]) {
        const state = orbit({ azimuth, polar, radius: 42 });
        const roundTrip = deriveOrbit(orbitToPosition(state), TARGET);
        expectClose(roundTrip.azimuth, state.azimuth);
        expectClose(roundTrip.polar, state.polar);
        expectClose(roundTrip.radius, state.radius);
      }
    }
  });

  test("position matches the prototype formulas", () => {
    // Prototype: x = cos(fi)cos(fi2)r, y = sin(fi2)r, z = sin(fi)cos(fi2)r.
    const state = orbit({ azimuth: 0, polar: 0, radius: 10 });
    expect(orbitToPosition(state)).toEqual({ x: TARGET.x + 10, y: TARGET.y, z: TARGET.z });

    // Straight above the target the azimuth is undefined: the fallback wins
    // and the elevation is clamped just short of the pole.
    const top = deriveOrbit({ x: 0, y: 10, z: 0 }, { x: 0, y: 0, z: 0 }, DEFAULT_ORBIT_LIMITS, 1.234);
    expect(top.polar).toBe(DEFAULT_ORBIT_LIMITS.maxPolar);
    expect(top.azimuth).toBeCloseTo(1.234, 6);
  });

  test("polar is clamped to the configured band", () => {
    const steep = deriveOrbit({ x: 0, y: 1000, z: 0 }, TARGET);
    expect(steep.polar).toBeLessThanOrEqual(DEFAULT_ORBIT_LIMITS.maxPolar);
    expect(steep.polar).toBeGreaterThan(0);

    const below = deriveOrbit({ x: 0, y: -1000, z: 0 }, TARGET);
    expect(below.polar).toBeGreaterThanOrEqual(-DEFAULT_ORBIT_LIMITS.maxPolar);
    expect(below.polar).toBeLessThan(0);

    const dragged = applyOrbitInput(orbit({ polar: 0 }), { dragging: true, deltaX: 0, deltaY: 10_000, zoom: 0 });
    expect(dragged.polar).toBeCloseTo(DEFAULT_ORBIT_LIMITS.maxPolar, 9);
  });

  test("zoom never goes below the minimum radius", () => {
    let state = orbit({ radius: 20 });
    for (let i = 0; i < 50; i += 1) {
      state = applyOrbitInput(state, { dragging: false, deltaX: 0, deltaY: 0, zoom: -400 });
    }
    expect(state.radius).toBe(DEFAULT_ORBIT_LIMITS.minRadius);

    const derived = deriveOrbit({ x: TARGET.x + 1, y: TARGET.y, z: TARGET.z }, TARGET);
    expect(derived.radius).toBe(DEFAULT_ORBIT_LIMITS.minRadius);
  });

  test("drag rotates azimuth and polar, zoom changes distance", () => {
    const dragged = applyOrbitInput(orbit(), { dragging: true, deltaX: 100, deltaY: 50, zoom: 0 });
    expectClose(dragged.azimuth, Math.PI / 4 + 1);
    expectClose(dragged.polar, 1.1);

    // One notch out pushes the camera away, one notch in pulls it closer.
    const out = applyOrbitInput(orbit(), { dragging: false, deltaX: 0, deltaY: 0, zoom: 100 });
    const back = applyOrbitInput(out, { dragging: false, deltaX: 0, deltaY: 0, zoom: -100 });
    expect(out.radius).toBeGreaterThan(130);
    expectClose(back.radius, 130);

    // Not dragging and not zooming is a no-op that keeps the reference.
    const state = orbit();
    expect(applyOrbitInput(state, { dragging: false, deltaX: 500, deltaY: 500, zoom: 0 })).toBe(state);
  });

  test("zoom is proportional, so a notch feels the same at any distance", () => {
    const near = orbit({ radius: 20 });
    const far = orbit({ radius: 800 });
    const zoomedNear = applyOrbitInput(near, { dragging: false, deltaX: 0, deltaY: 0, zoom: 100 });
    const zoomedFar = applyOrbitInput(far, { dragging: false, deltaX: 0, deltaY: 0, zoom: 100 });
    expectClose(zoomedFar.radius / far.radius, zoomedNear.radius / near.radius);

    // The prototype's additive zoom moved a fixed 2.5 units per notch on the
    // opening framing of a 5x5x5 board (radius 130); this must be a clearly
    // bigger move than that at the same distance.
    const framing = orbit({ radius: 130 });
    const stepped = applyOrbitInput(framing, { dragging: false, deltaX: 0, deltaY: 0, zoom: 100 });
    expect(stepped.radius - framing.radius).toBeGreaterThan(15);
  });

  test("a wheel delta is normalised to pixels before it zooms", () => {
    // Pixels pass through untouched.
    expect(normalizeWheelDelta(100, 0)).toBe(100);
    // Firefox reports lines, which are ~30x smaller than Chrome's pixels.
    expect(normalizeWheelDelta(3, 1)).toBe(3 * WHEEL_LINE_HEIGHT);
    // Pages need the element height, with a fallback when it is not known.
    expect(normalizeWheelDelta(1, 2, 720)).toBe(720);
    expect(normalizeWheelDelta(1, 2)).toBe(800);
  });

  test("azimuth wraps without leaving the canonical band", () => {
    let state = orbit({ azimuth: 1.4 });
    for (let i = 0; i < 100; i += 1) {
      state = applyOrbitInput(state, { dragging: true, deltaX: 100, deltaY: 0, zoom: 0 });
      expect(state.azimuth).toBeGreaterThanOrEqual(-Math.PI / 2);
      expect(state.azimuth).toBeLessThan(1.5 * Math.PI);
    }
    expectClose(normalizeAzimuth(-Math.PI / 2), -Math.PI / 2);
    expectClose(normalizeAzimuth(1.5 * Math.PI), -Math.PI / 2);
  });

  test("recentring keeps the framing and only moves the target", () => {
    const state = orbit();
    const moved = withTarget(state, { x: 0, y: 0, z: 0 });
    expect(moved.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(moved.radius).toBe(state.radius);
    expect(withTarget(state, TARGET)).toBe(state);
  });
});

/**
 * Pinch-to-zoom.
 *
 * A touch screen has no wheel, so the same zoom has to come out of the distance
 * between two fingers. The gesture is converted into the wheel's units here -
 * the pure half of it - which is what lets the camera rig push both through
 * {@link applyOrbitInput} without knowing which one happened.
 */
describe("pinch zoom", () => {
  test("spreading the fingers halves the distance to the board", () => {
    const state = orbit({ radius: 200 });

    const closer = applyOrbitInput(state, { dragging: false, deltaX: 0, deltaY: 0, zoom: zoomForPinch(2) });
    // Twice as far apart means twice as close: zooming in.
    expectClose(closer.radius, 100);

    const further = applyOrbitInput(state, { dragging: false, deltaX: 0, deltaY: 0, zoom: zoomForPinch(0.5) });
    expectClose(further.radius, 400);
  });

  test("a gesture composes, so it does not depend on the event rate", () => {
    // A pinch that ends four times as wide, delivered as three frames instead
    // of one, has to land in exactly the same place.
    let stepped = orbit({ radius: 200 });
    for (const ratio of [1.5, 2, 4 / 3]) {
      stepped = applyOrbitInput(stepped, { dragging: false, deltaX: 0, deltaY: 0, zoom: zoomForPinch(ratio) });
    }

    const oneFrame = applyOrbitInput(orbit({ radius: 200 }), {
      dragging: false,
      deltaX: 0,
      deltaY: 0,
      zoom: zoomForPinch(1.5 * 2 * (4 / 3)),
    });

    expectClose(stepped.radius, oneFrame.radius, 6);
    expectClose(stepped.radius, 50, 6);
  });

  test("a pinch with no distance to measure is no input at all", () => {
    // Two fingers on top of each other (ratio 0), a stale ratio, or a no-op
    // gesture must not fling the camera at the radius limits.
    for (const ratio of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1]) {
      expect(zoomForPinch(ratio)).toBe(0);
    }
  });

  test("a pinch is clamped like any other zoom, however hard it is squeezed", () => {
    const state = orbit({ radius: 200 });
    const tiny = applyOrbitInput(state, { dragging: false, deltaX: 0, deltaY: 0, zoom: zoomForPinch(1000) });
    const huge = applyOrbitInput(state, { dragging: false, deltaX: 0, deltaY: 0, zoom: zoomForPinch(0.001) });

    expect(tiny.radius).toBe(DEFAULT_ORBIT_LIMITS.minRadius);
    expect(huge.radius).toBe(DEFAULT_ORBIT_LIMITS.maxRadius);
  });
});
