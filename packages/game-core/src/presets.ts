import { createConfig, createGame } from "./game";
import { DEFAULT_RULES } from "./rules";
import type { GameConfig, GamePreset, GameState } from "./types";
import { vec3 } from "./vec3";

/**
 * Board sizes offered by the client menu.
 *
 * Mine density stays around 8-11% of the cells, which keeps the 26-neighbour
 * danger counts in a readable range.
 */
export const GAME_PRESETS: readonly GamePreset[] = Object.freeze([
  { id: "tiny", label: "Tiny", size: vec3(3, 3, 3), mineCount: 3 },
  { id: "classic", label: "Classic", size: vec3(5, 5, 5), mineCount: 10 },
  { id: "medium", label: "Medium", size: vec3(6, 6, 6), mineCount: 20 },
  { id: "large", label: "Large", size: vec3(8, 8, 8), mineCount: 40 },
  { id: "expert", label: "Expert", size: vec3(10, 10, 10), mineCount: 80 },
]);

/** Preset used when the client does not ask for a specific one. */
export const DEFAULT_PRESET_ID = "classic";

/** Looks up a preset by id. */
export function findPreset(id: string): GamePreset | undefined {
  return GAME_PRESETS.find((preset) => preset.id === id);
}

/**
 * Builds the rules config of a preset.
 *
 * @throws RangeError when the preset id is unknown
 */
export function presetConfig(
  id: string,
  options: { seed?: number; firstRevealSafe?: boolean; freeReveals?: number } = {},
): GameConfig {
  const preset = findPreset(id);
  if (preset === undefined) throw new RangeError(`Unknown preset "${id}"`);

  return createConfig({
    size: preset.size,
    mineCount: preset.mineCount,
    firstRevealSafe: options.firstRevealSafe ?? DEFAULT_RULES.firstRevealSafe,
    ...(options.freeReveals === undefined ? {} : { freeReveals: options.freeReveals }),
    // Only forward the seed when the caller pinned one; otherwise let
    // `createConfig` pick a fresh random seed.
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });
}

/** Starts a game on the default preset with a fresh random seed. */
export function createDefaultGame(
  options: { presetId?: string; seed?: number; freeReveals?: number } = {},
): GameState {
  return createGame(presetConfig(options.presetId ?? DEFAULT_PRESET_ID, options));
}
