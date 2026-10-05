/**
 * Deterministic pseudo random numbers.
 *
 * The engine never calls `Math.random()`: every random decision is derived from
 * a seed that lives in the game state, so a game can be replayed, shared by
 * seed, or reproduced on the server for an authoritative check.
 */

/** Result of advancing the generator: the new state and the drawn value. */
export interface RandomStep {
  readonly state: number;
  readonly value: number;
}

/** Normalises any number into the 32-bit seed space used by the generator. */
export function normalizeSeed(seed: number): number {
  return Number.isFinite(seed) ? Math.trunc(seed) | 0 : 0;
}

/** Creates a seed suitable for a fresh game (not reproducible, by design). */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff) + 1;
}

/**
 * Advances a mulberry32 generator.
 *
 * @param state current generator state
 * @returns the next state and a value in `[0, 1)`
 */
export function nextRandom(state: number): RandomStep {
  const nextState = (normalizeSeed(state) + 0x6d2b79f5) | 0;
  let t = nextState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { state: nextState, value };
}

/**
 * Draws an integer in the inclusive range `[min, max]`.
 *
 * @throws RangeError when the range is empty or not made of integers.
 */
export function randomInt(state: number, min: number, max: number): { state: number; value: number } {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new RangeError(`Invalid random range [${min}, ${max}]`);
  }
  const { state: nextState, value } = nextRandom(state);
  return { state: nextState, value: min + Math.floor(value * (max - min + 1)) };
}

/** Convenience wrapper for callers that just want a stream of numbers. */
export function createRandom(seed: number): () => number {
  let state = normalizeSeed(seed);
  return () => {
    const step = nextRandom(state);
    state = step.state;
    return step.value;
  };
}
