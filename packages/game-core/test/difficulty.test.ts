import { describe, expect, it } from "bun:test";
import type { DifficultyId, MatchMode } from "../src/index";
import {
  cellCountOf,
  coopTimeLimitMs,
  COOP_MAX_TIME_MS,
  COOP_MIN_TIME_MS,
  DEFAULT_DIFFICULTY_ID,
  DEFAULT_MATCH_MODE,
  defaultDifficultyForMode,
  DIFFICULTIES,
  difficultyOf,
  findDifficulty,
  formatDensity,
  GAME_PRESETS,
  hasEliminations,
  isDifficultyId,
  isMatchMode,
  isMatchStatus,
  matchModeInfo,
  MATCH_MODES,
  MATCH_STATUSES,
  maxMineCount,
  mineCountFor,
  mineCountForDensity,
  mineDensity,
  sharesBoard,
  usesClock,
  vec3,
} from "../src/index";

const SIZES = GAME_PRESETS.map((preset) => preset.size);

describe("difficulty tiers", () => {
  it("is ordered from fewest to most mines", () => {
    expect(DIFFICULTIES.map((tier) => tier.id)).toEqual(["easy", "normal", "hard", "super-hard"]);
    expect(DIFFICULTIES.map((tier) => tier.label)).toEqual(["Easy", "Normal", "Hard", "Super hard"]);

    for (let index = 1; index < DIFFICULTIES.length; index += 1) {
      const previous = DIFFICULTIES[index - 1];
      const current = DIFFICULTIES[index];
      expect(current?.density).toBeGreaterThan(previous?.density as number);
      expect(current?.maxDensity).toBeGreaterThan(previous?.maxDensity as number);
    }
  });

  it("guards the default tier id", () => {
    expect(findDifficulty(DEFAULT_DIFFICULTY_ID)?.id).toBe(DEFAULT_DIFFICULTY_ID);
    expect(isDifficultyId(DEFAULT_DIFFICULTY_ID)).toBe(true);
    expect(isDifficultyId("impossible")).toBe(false);
    expect(isDifficultyId(7)).toBe(false);
  });

  it("reads a mine count back as the tier that produced it, on every preset", () => {
    for (const size of SIZES) {
      for (const tier of DIFFICULTIES) {
        const mines = mineCountFor(size, tier.id);
        expect(`${size.x}^3 ${tier.id} -> ${difficultyOf(size, mines).id}`).toBe(
          `${size.x}^3 ${tier.id} -> ${tier.id}`,
        );
      }
    }
  });

  it("rounds a density to whole mines", () => {
    expect(mineCountForDensity(vec3(10, 10, 10), 0.09)).toBe(90);
    expect(mineCountFor(vec3(5, 5, 5), "easy")).toBe(6);
    expect(mineCountFor(vec3(5, 5, 5), "super-hard")).toBe(25);
  });

  it("never proposes more mines than the board can hold", () => {
    expect(maxMineCount(vec3(22, 1, 1))).toBe(21);
    expect(mineCountForDensity(vec3(1, 1, 1), 0.9)).toBe(0);
    expect(mineCountForDensity(vec3(1, 1, 1), 1)).toBe(0);
    expect(mineCountForDensity(vec3(3, 3, 3), 5)).toBe(26);
    expect(mineCountForDensity(vec3(3, 3, 3), -1)).toBe(0);
  });

  it("classifies by density, not by raw count", () => {
    // The same 20 mines are a busy small cube and a quiet large one.
    expect(difficultyOf(vec3(6, 6, 6), 20).id).toBe("normal");
    expect(difficultyOf(vec3(10, 10, 10), 20).id).toBe("easy");

    expect(mineDensity(vec3(8, 8, 8), 40)).toBeCloseTo(0.078, 3);
    expect(formatDensity(vec3(8, 8, 8), 40)).toBe("8% of cells");
  });

  it("treats a tier's ceiling density as still inside the tier", () => {
    const size = vec3(10, 10, 10);
    for (const tier of DIFFICULTIES) {
      if (!Number.isFinite(tier.maxDensity)) continue;
      const atCeiling = Math.floor(tier.maxDensity * cellCountOf(size));
      expect(difficultyOf(size, atCeiling).id).toBe(tier.id);
      expect(difficultyOf(size, atCeiling + 1).id).not.toBe(tier.id);
    }
  });

  it("falls back to the default tier for an unknown id", () => {
    const fallback = mineCountFor(vec3(5, 5, 5), "nonsense" as DifficultyId);
    expect(fallback).toBe(mineCountFor(vec3(5, 5, 5), DEFAULT_DIFFICULTY_ID));
  });

  it("counts the cells of a board", () => {
    expect(cellCountOf(vec3(4, 5, 6))).toBe(120);
  });
});

describe("match modes", () => {
  it("offers co-op, race and survival", () => {
    expect(MATCH_MODES.map((mode) => mode.id)).toEqual(["coop", "race", "survival"]);
    expect(MATCH_MODES.map((mode) => mode.label)).toEqual(["Co-op", "Race", "Survival"]);
    expect(MATCH_MODES.every((mode) => mode.tagline.length > 20)).toBe(true);
    expect(DEFAULT_MATCH_MODE).toBe("coop");
  });

  it("guards mode ids", () => {
    expect(isMatchMode("survival")).toBe(true);
    expect(isMatchMode("battle-royale")).toBe(false);
    expect(isMatchMode(undefined)).toBe(false);
  });

  it("guards round statuses against the same closed set the rooms commit", () => {
    expect(MATCH_STATUSES).toEqual(["ready", "playing", "won", "lost"]);
    for (const status of MATCH_STATUSES) {
      expect(isMatchStatus(status)).toBe(true);
    }
    expect(isMatchStatus("paused")).toBe(false);
    expect(isMatchStatus("")).toBe(false);
    expect(isMatchStatus(undefined)).toBe(false);
    expect(isMatchStatus(3)).toBe(false);
  });

  it("starts survival dense and the others at the default tier", () => {
    expect(defaultDifficultyForMode("survival")).toBe("super-hard");
    expect(defaultDifficultyForMode("coop")).toBe(DEFAULT_DIFFICULTY_ID);
    expect(defaultDifficultyForMode("race")).toBe(DEFAULT_DIFFICULTY_ID);
  });

  it("shares the cube where it should", () => {
    expect(sharesBoard("coop")).toBe(true);
    expect(sharesBoard("survival")).toBe(true);
    expect(sharesBoard("race")).toBe(false);
  });

  it("plays against a clock only in co-op", () => {
    expect(usesClock("coop")).toBe(true);
    expect(usesClock("race")).toBe(false);
    expect(usesClock("survival")).toBe(false);
  });

  it("eliminates players only in survival", () => {
    expect(hasEliminations("survival")).toBe(true);
    expect(hasEliminations("coop")).toBe(false);
    expect(hasEliminations("race")).toBe(false);
  });

  it("resolves a mode row with a fallback", () => {
    expect(matchModeInfo("race").label).toBe("Race");
    expect(matchModeInfo("nonsense" as MatchMode).id).toBe(DEFAULT_MATCH_MODE);
  });
});

describe("co-op time limits", () => {
  it("grows with the board and stays inside the window", () => {
    const tiny = coopTimeLimitMs(vec3(3, 3, 3), 3);
    const classic = coopTimeLimitMs(vec3(5, 5, 5), 10);
    const expert = coopTimeLimitMs(vec3(10, 10, 10), 80);

    expect(tiny).toBe(COOP_MIN_TIME_MS);
    expect(classic).toBeGreaterThan(tiny);
    expect(expert).toBeLessThanOrEqual(COOP_MAX_TIME_MS);
    expect(expert).toBe(COOP_MAX_TIME_MS);
  });

  it("counts only the safe cells and snaps to whole seconds", () => {
    expect(coopTimeLimitMs(vec3(5, 5, 5), 0)).toBe((125 * 1200));
    expect(coopTimeLimitMs(vec3(5, 5, 5), 10) % 1000).toBe(0);
    // A board that is nothing but mines still gets the floor, not zero.
    expect(coopTimeLimitMs(vec3(2, 2, 2), 7)).toBe(COOP_MIN_TIME_MS);
  });
});
