/**
 * Mine density tiers.
 *
 * The number of mines is adjustable, and a raw count says very little on its
 * own: 30 mines make a 10x10x10 board a stroll and a 6x6x6 board a minefield.
 * Every count therefore gets classified into one of four tiers by *density* -
 * the share of cells that hold a mine - so the lobby can label the slider
 * "Easy".."Super hard" while the player drags it.
 *
 * The four tiers are calibrated in {@link DIFFICULTIES}: each has a nominal
 * density (what picking the tier produces) and a ceiling (the largest density
 * that still reads as that tier). Ceilings sit between neighbouring nominals,
 * so {@link difficultyOf} and {@link mineCountFor} are inverse to each other on
 * every board size.
 */

import type { Vec3 } from "./types";

/** The four selectable mine densities, from fewest to most mines. */
export type DifficultyId = "easy" | "normal" | "hard" | "super-hard";

/** One rung of the difficulty ladder. */
export interface Difficulty {
  readonly id: DifficultyId;
  /** Human label, used in the lobby and the HUD. */
  readonly label: string;
  /** Share of the board that holds a mine when this tier is selected. */
  readonly density: number;
  /** Largest density that still classifies as this tier. */
  readonly maxDensity: number;
}

/** The difficulty ladder, easiest first. */
export const DIFFICULTIES: readonly Difficulty[] = Object.freeze([
  { id: "easy", label: "Easy", density: 0.05, maxDensity: 0.07 },
  { id: "normal", label: "Normal", density: 0.09, maxDensity: 0.12 },
  { id: "hard", label: "Hard", density: 0.14, maxDensity: 0.17 },
  { id: "super-hard", label: "Super hard", density: 0.2, maxDensity: Number.POSITIVE_INFINITY },
]);

/** Tier used when the caller does not ask for one. */
export const DEFAULT_DIFFICULTY_ID: DifficultyId = "normal";

/** Looks up a tier by id. */
export function findDifficulty(id: string): Difficulty | undefined {
  return DIFFICULTIES.find((difficulty) => difficulty.id === id);
}

/** Narrows an untrusted value to a known tier id. */
export function isDifficultyId(value: unknown): value is DifficultyId {
  return typeof value === "string" && findDifficulty(value) !== undefined;
}

/** Number of cells of a board. */
export function cellCountOf(size: Vec3): number {
  return size.x * size.y * size.z;
}

/**
 * Largest number of mines a board of this size can hold.
 *
 * One cell always stays safe, otherwise winning is impossible.
 */
export function maxMineCount(size: Vec3): number {
  return Math.max(0, cellCountOf(size) - 1);
}

/** Share of the board that holds a mine, in `0`..`1`. */
export function mineDensity(size: Vec3, mineCount: number): number {
  const cells = cellCountOf(size);
  return cells === 0 ? 0 : mineCount / cells;
}

/**
 * Turns a density into a mine count for this board, clamped to a legal range.
 *
 * Rounding means the tiers are only exactly invertible once a board is big
 * enough to resolve them: on an eight-cell cube two neighbouring tiers collapse
 * onto the same count. Every preset the lobby offers is comfortably above that
 * threshold.
 */
export function mineCountForDensity(size: Vec3, density: number): number {
  const cells = cellCountOf(size);
  const wanted = Math.round(Math.max(0, density) * cells);
  return Math.min(maxMineCount(size), Math.max(0, wanted));
}

/**
 * Mine count produced by picking a tier on this board.
 *
 * Unknown ids fall back to the default tier so a stale share link still opens
 * a playable board.
 */
export function mineCountFor(size: Vec3, difficultyId: DifficultyId): number {
  const tier = findDifficulty(difficultyId) ?? (findDifficulty(DEFAULT_DIFFICULTY_ID) as Difficulty);
  return mineCountForDensity(size, tier.density);
}

/** Classifies an arbitrary mine count by density; never fails. */
export function difficultyOf(size: Vec3, mineCount: number): Difficulty {
  const density = mineDensity(size, mineCount);
  for (const tier of DIFFICULTIES) {
    if (density <= tier.maxDensity) return tier;
  }
  return DIFFICULTIES[DIFFICULTIES.length - 1] as Difficulty;
}

/** `"14% of cells"` - the short explanation next to the mine slider. */
export function formatDensity(size: Vec3, mineCount: number): string {
  return `${Math.round(mineDensity(size, mineCount) * 100)}% of cells`;
}
