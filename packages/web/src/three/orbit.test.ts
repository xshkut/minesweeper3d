import { describe, expect, test } from "bun:test";
import {
  DEFAULT_ORBIT_LIMITS,
  applyOrbitInput,
  deriveOrbit,
  normalizeAzimuth,
  orbitToPosition,
  withTarget,
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

    const zoomed = applyOrbitInput(orbit(), { dragging: false, deltaX: 0, deltaY: 0, zoom: 400 });
    expectClose(zoomed.radius, 140);

    // Not dragging and not zooming is a no-op that keeps the reference.
    const state = orbit();
    expect(applyOrbitInput(state, { dragging: false, deltaX: 500, deltaY: 500, zoom: 0 })).toBe(state);
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
