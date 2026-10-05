/**
 * Preset helpers: mapping a running game back to the menu entry it came from.
 */
import { DEFAULT_PRESET_ID, GAME_PRESETS } from "@minesweeper3d/game-core";
import type { GameConfig, Vec3 } from "@minesweeper3d/game-core";

/**
 * Finds the preset a config corresponds to.
 *
 * Remote games are created from a preset id the client may not have sent, so
 * the picker derives the current selection from the board itself; unknown
 * boards fall back to the default preset.
 */
export function presetIdForConfig(config: Pick<GameConfig, "size" | "mineCount">): string {
  const match = GAME_PRESETS.find(
    (preset) => sameSize(preset.size, config.size) && preset.mineCount === config.mineCount,
  );
  return match?.id ?? DEFAULT_PRESET_ID;
}

/** Total number of cells on a board. */
export function cellCountOf(size: Vec3): number {
  return size.x * size.y * size.z;
}

function sameSize(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
