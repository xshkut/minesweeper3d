import { describe, expect, it } from "bun:test";
import {
  createDefaultGame,
  DEFAULT_PRESET_ID,
  findPreset,
  GAME_PRESETS,
  presetConfig,
  validateGameConfig,
} from "../src/index";

describe("presets", () => {
  it("offers a handful of boards with unique ids", () => {
    expect(GAME_PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(new Set(GAME_PRESETS.map((preset) => preset.id)).size).toBe(GAME_PRESETS.length);
    for (const preset of GAME_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it("keeps every preset playable", () => {
    for (const preset of GAME_PRESETS) {
      const result = validateGameConfig({ size: preset.size, mineCount: preset.mineCount, seed: 1 });
      expect(result.ok).toBe(true);
    }
  });

  it("keeps the mine density in a readable range", () => {
    for (const preset of GAME_PRESETS) {
      const cells = preset.size.x * preset.size.y * preset.size.z;
      const density = preset.mineCount / cells;
      expect(density).toBeGreaterThan(0.05);
      expect(density).toBeLessThan(0.2);
    }
  });

  it("looks presets up by id", () => {
    expect(findPreset(DEFAULT_PRESET_ID)?.id).toBe(DEFAULT_PRESET_ID);
    expect(findPreset("nope")).toBeUndefined();
  });

  it("builds configs from a preset", () => {
    const config = presetConfig("classic", { seed: 42 });
    expect(config).toEqual({
      size: { x: 5, y: 5, z: 5 },
      mineCount: 10,
      seed: 42,
      firstRevealSafe: true,
      minesFatal: true,
      freeReveals: 0,
    });

    expect(presetConfig("classic", { seed: 42, firstRevealSafe: false }).firstRevealSafe).toBe(false);
    expect(presetConfig("classic", { seed: 42, freeReveals: 3 }).freeReveals).toBe(3);
  });

  it("draws a fresh seed when none is given", () => {
    expect(presetConfig("tiny").seed).not.toBe(presetConfig("tiny").seed);
  });

  it("rejects unknown presets", () => {
    expect(() => presetConfig("gigantic")).toThrow(RangeError);
  });

  it("starts a classic game by default", () => {
    const state = createDefaultGame({ seed: 7 });
    expect(state.cells).toHaveLength(125);
    expect(state.cells.filter((cell) => cell.hasMine)).toHaveLength(10);
    expect(state.config.firstRevealSafe).toBe(true);
  });
});
