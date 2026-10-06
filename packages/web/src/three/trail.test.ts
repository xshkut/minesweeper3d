/**
 * The maths of a remote pointer's trail.
 *
 * These are the properties the renderer relies on without checking: the point
 * *slides* rather than teleports, the tail is made of positions rather than
 * frames, a lifted pointer fades instead of vanishing, and none of it can grow
 * without bound in a room where somebody swipes across the board.
 */
import { describe, expect, test } from "bun:test";
import {
  FADE_OUT_SECONDS,
  MAX_SAMPLES,
  TRAIL_LIFE_SECONDS,
  advanceCursorTrail,
  createCursorTrail,
  trailIsVisible,
} from "./trail";
import type { CursorTrail, TrailPoint } from "./trail";

/** One frame at 60Hz, the step every test here advances by. */
const FRAME = 1 / 60;

function at(x: number, y: number, z: number): TrailPoint {
  return { x, y, z };
}

/** Runs `frames` frames of `dt` towards the same target. */
function advance(trail: CursorTrail, target: TrailPoint | null, frames: number, dt = FRAME): void {
  for (let i = 0; i < frames; i += 1) advanceCursorTrail(trail, target, dt);
}

/** A trail that is already on screen at the origin. */
function appeared(): CursorTrail {
  const trail = createCursorTrail();
  advance(trail, at(0, 0, 0), 4);
  return trail;
}

describe("a pointer appearing", () => {
  test("a fresh trail draws nothing", () => {
    expect(trailIsVisible(createCursorTrail())).toBe(false);
  });

  test("appears where it points, fading in", () => {
    const trail = createCursorTrail();

    advanceCursorTrail(trail, at(8, 0, 8), FRAME);

    expect(trail.active).toBe(true);
    expect(trail.head).toEqual({ x: 8, y: 0, z: 8 });
    // Half a dozen frames to be fully drawn, so a pointer does not pop in.
    expect(trail.opacity).toBeGreaterThan(0);
    expect(trail.opacity).toBeLessThan(1);
    expect(trailIsVisible(trail)).toBe(true);
  });

  test("reaches full opacity within its fade-in time", () => {
    const trail = createCursorTrail();
    advance(trail, at(1, 1, 1), 30);

    expect(trail.opacity).toBe(1);
  });
});

describe("the head", () => {
  test("slides towards a target instead of teleporting to it", () => {
    const trail = appeared();

    advanceCursorTrail(trail, at(10, 0, 0), FRAME);

    expect(trail.head.x).toBeGreaterThan(0);
    expect(trail.head.x).toBeLessThan(10);
  });

  test("closes the distance in about the same time however far the hop is", () => {
    const near = appeared();
    const far = appeared();

    advance(near, at(1, 0, 0), 20);
    advance(far, at(10, 0, 0), 20);

    // Exponential easing: after the same time the same *fraction* is left.
    expect(near.head.x / 1).toBeCloseTo(far.head.x / 10, 3);
  });

  test("settles on the cell it was given", () => {
    const trail = appeared();

    advance(trail, at(9, 4, 2), 90);

    expect(trail.head.x).toBeCloseTo(9, 3);
    expect(trail.head.y).toBeCloseTo(4, 3);
    expect(trail.head.z).toBeCloseTo(2, 3);
  });

  test("a step of no time does not move it", () => {
    const trail = appeared();
    const before = { ...trail.head };

    advanceCursorTrail(trail, at(9, 9, 9), 0);

    expect(trail.head).toEqual(before);
  });

  test("a negative step is treated as no time at all", () => {
    const trail = appeared();
    const before = { ...trail.head };
    const opacity = trail.opacity;

    advanceCursorTrail(trail, at(9, 9, 9), -5);

    expect(trail.head).toEqual(before);
    expect(trail.opacity).toBe(opacity);
  });
});

describe("the tail", () => {
  test("a pointer resting in one cell leaves exactly one bead", () => {
    const trail = appeared();

    advance(trail, at(0, 0, 0), 120);

    // Beads are spaced by *distance*, so standing still does not pile up an
    // invisible heap of them.
    expect(trail.samples).toHaveLength(1);
  });

  test("a moving pointer leaves a trail, newest first", () => {
    const trail = appeared();

    advance(trail, at(6, 0, 0), 10);
    advance(trail, at(12, 0, 0), 10);

    expect(trail.samples.length).toBeGreaterThan(2);
    const oldest = trail.samples[trail.samples.length - 1];
    expect(trail.samples[0]?.age).toBeLessThanOrEqual(oldest?.age ?? 0);
  });

  test("a fast swipe cannot grow the tail without bound", () => {
    const trail = appeared();

    for (let i = 1; i <= 40; i += 1) advance(trail, at(i * 4, 0, 0), 3);

    expect(trail.samples.length).toBeLessThanOrEqual(MAX_SAMPLES);
  });

  test("beads expire once they are older than their life", () => {
    const trail = appeared();
    advance(trail, at(20, 0, 0), 20);
    expect(trail.samples.length).toBeGreaterThan(1);

    // The pointer is still there but has stopped moving, so the tail drains
    // away to nothing but the bead sitting under the head.
    advance(trail, at(20, 0, 0), Math.ceil((TRAIL_LIFE_SECONDS + 0.2) / FRAME));

    expect(trail.samples.length).toBeLessThanOrEqual(1);
    for (const sample of trail.samples) expect(sample.age).toBeLessThanOrEqual(TRAIL_LIFE_SECONDS);
    expect(trail.active).toBe(true);
    expect(trailIsVisible(trail)).toBe(true);
  });
});

describe("a pointer that stops", () => {
  test("fades out where it was instead of vanishing", () => {
    const trail = appeared();
    advance(trail, at(4, 0, 0), 10);
    const resting = { ...trail.head };

    advanceCursorTrail(trail, null, FRAME);

    // Still drawn, just leaving: this is what makes a player sliding off the
    // board look like a lifted pointer rather than a glitch.
    expect(trail.head).toEqual(resting);
    expect(trail.opacity).toBeLessThan(1);
    expect(trailIsVisible(trail)).toBe(true);
  });

  test("disappears once it has faded, keeping no beads behind", () => {
    const trail = appeared();
    advance(trail, at(4, 0, 0), 10);

    advance(trail, null, Math.ceil(FADE_OUT_SECONDS / FRAME) + 2);

    expect(trail.active).toBe(false);
    expect(trail.opacity).toBe(0);
    expect(trail.samples).toHaveLength(0);
    expect(trailIsVisible(trail)).toBe(false);
  });

  test("stays gone while nothing points", () => {
    const trail = createCursorTrail();

    advance(trail, null, 10);

    expect(trail.active).toBe(false);
    expect(trail.opacity).toBe(0);
  });

  test("reappears on the new cell rather than sliding across the board", () => {
    const trail = appeared();
    advance(trail, at(2, 0, 0), 10);
    advance(trail, null, Math.ceil(FADE_OUT_SECONDS / FRAME) + 2);

    advanceCursorTrail(trail, at(30, 0, 30), FRAME);

    // A pointer that came back somewhere else did not travel there.
    expect(trail.head).toEqual({ x: 30, y: 0, z: 30 });
    expect(trail.samples).toHaveLength(1);
  });
});
