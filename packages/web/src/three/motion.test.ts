import { describe, expect, test } from "bun:test";
import { Motion, MotionVector } from "./motion";

const FRAME = 1 / 60;

describe("Motion", () => {
  test("converges to its target and stops exactly on it", () => {
    const motion = new Motion({ value: 0, T1: 0.2, T2: 0.1 });
    motion.setTarget(10);

    let elapsed = 0;
    while (!motion.settled && elapsed < 5) {
      motion.step(FRAME);
      elapsed += FRAME;
    }

    expect(motion.settled).toBe(true);
    expect(motion.value).toBe(10);
    expect(motion.velocity).toBe(0);
    expect(elapsed).toBeLessThan(2);
  });

  test("never overshoots the target", () => {
    const motion = new Motion({ value: 0, T1: 0.5, T2: 0.3 });
    motion.setTarget(1);

    for (let i = 0; i < 300; i += 1) {
      motion.step(FRAME);
      expect(motion.value).toBeLessThanOrEqual(1);
      expect(motion.value).toBeGreaterThanOrEqual(0);
    }
    expect(motion.value).toBe(1);
  });

  test("is deterministic for a fixed sequence of deltas", () => {
    const deltas = [1 / 60, 1 / 30, 1 / 120, 0.02, 0.05];
    const run = (): number[] => {
      const motion = new Motion({ value: 3, T1: 0.2, T2: 0.1 });
      motion.setTarget(-7);
      return deltas.map((delta) => motion.step(delta));
    };

    expect(run()).toEqual(run());
  });

  test("picks up a new target mid-flight", () => {
    const motion = new Motion({ value: 0, T1: 0.2, T2: 0.1 });
    motion.setTarget(10);
    for (let i = 0; i < 5; i += 1) motion.step(FRAME);
    const midway = motion.value;
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(10);

    motion.setTarget(0);
    expect(motion.settled).toBe(false);
    for (let i = 0; i < 300; i += 1) motion.step(FRAME);
    expect(motion.value).toBe(0);
  });

  test("first-order mode approaches without overshooting", () => {
    const motion = new Motion({ value: 0, T1: 0.1 });
    motion.setTarget(5);
    const samples: number[] = [];
    for (let i = 0; i < 60; i += 1) samples.push(motion.step(FRAME));

    expect(samples.every((value, index) => index === 0 || value >= (samples[index - 1] ?? 0))).toBe(true);
    expect(motion.value).toBe(5);
    expect(motion.settled).toBe(true);
  });

  test("ignores zero, negative and non-finite deltas", () => {
    const motion = new Motion({ value: 1, T1: 0.5 });
    motion.setTarget(2);
    expect(motion.step(0)).toBe(1);
    expect(motion.step(-1)).toBe(1);
    expect(motion.step(Number.NaN)).toBe(1);
    expect(motion.step(Number.POSITIVE_INFINITY)).toBe(1);
  });

  test("survives a tab-switch sized delta without exploding", () => {
    const motion = new Motion({ value: 0, T1: 0.2, T2: 0.1 });
    motion.setTarget(100);
    motion.step(30);
    expect(motion.value).toBeLessThanOrEqual(100);
    expect(Number.isFinite(motion.value)).toBe(true);
  });

  test("reset teleports and cancels the motion", () => {
    const motion = new Motion({ value: 0, T1: 0.2, T2: 0.1 });
    motion.setTarget(10);
    motion.step(FRAME);
    motion.reset(4);
    expect(motion.value).toBe(4);
    expect(motion.settled).toBe(true);
    expect(motion.step(FRAME)).toBe(4);
  });
});

describe("MotionVector", () => {
  test("moves all axes and reports settlement", () => {
    const vector = new MotionVector({ value: { x: 0, y: 0, z: 0 }, T1: 0.2, T2: 0.1 });
    vector.setTarget({ x: 5, y: -5, z: 2 });
    expect(vector.settled).toBe(false);

    for (let i = 0; i < 300; i += 1) vector.step(FRAME);

    expect(vector.settled).toBe(true);
    expect(vector.value).toEqual({ x: 5, y: -5, z: 2 });
  });
});
