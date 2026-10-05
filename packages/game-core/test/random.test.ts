import { describe, expect, it } from "bun:test";
import { createRandom, nextRandom, normalizeSeed, randomInt, randomSeed } from "../src/index";

describe("deterministic random", () => {
  it("produces the same stream for the same seed", () => {
    const first = createRandom(1234);
    const second = createRandom(1234);
    const values = [first(), first(), first(), first()];
    expect(values).toEqual([second(), second(), second(), second()]);
  });

  it("produces different streams for different seeds", () => {
    const first = createRandom(1);
    const second = createRandom(2);
    expect(first()).not.toBe(second());
  });

  it("sticks to the half-open unit interval", () => {
    let state = normalizeSeed(7);
    for (let i = 0; i < 1000; i += 1) {
      const step = nextRandom(state);
      state = step.state;
      expect(step.value).toBeGreaterThanOrEqual(0);
      expect(step.value).toBeLessThan(1);
    }
  });

  it("advances its state on every draw", () => {
    const first = nextRandom(5);
    const second = nextRandom(first.state);
    expect(first.state).not.toBe(second.state);
    expect(first.value).not.toBe(second.value);
  });

  it("normalises seeds into a 32 bit space", () => {
    expect(normalizeSeed(1.9)).toBe(1);
    expect(normalizeSeed(-3.2)).toBe(-3);
    expect(normalizeSeed(Number.NaN)).toBe(0);
    expect(normalizeSeed(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("draws integers inclusively and only within the requested range", () => {
    let state = normalizeSeed(99);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i += 1) {
      const draw = randomInt(state, 3, 6);
      state = draw.state;
      expect(Number.isInteger(draw.value)).toBe(true);
      expect(draw.value).toBeGreaterThanOrEqual(3);
      expect(draw.value).toBeLessThanOrEqual(6);
      seen.add(draw.value);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
  });

  it("supports single value ranges", () => {
    expect(randomInt(1, 4, 4).value).toBe(4);
  });

  it("rejects empty or fractional ranges", () => {
    expect(() => randomInt(1, 5, 4)).toThrow(RangeError);
    expect(() => randomInt(1, 0.5, 4)).toThrow(RangeError);
  });

  it("creates unpredictable but valid seeds", () => {
    const seeds = new Set<number>();
    for (let i = 0; i < 50; i += 1) {
      const seed = randomSeed();
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThan(0);
      seeds.add(seed);
    }
    expect(seeds.size).toBeGreaterThan(40);
  });

  it("keeps a stable golden stream", () => {
    // Pins the generator: changing it would silently change every mine layout.
    const random = createRandom(2024);
    expect([random(), random(), random()]).toEqual([
      0.811762373894453, 0.7108214949257672, 0.6505258858669549,
    ]);
  });
});
