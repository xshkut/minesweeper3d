import { describe, expect, it } from "bun:test";
import {
  cycleMark,
  InvalidGameStateError,
  parseGameConfig,
  parseGameState,
  probeCell,
  revealCell,
  serializeGame,
  validateGameConfig,
  vec3,
} from "../src/index";
import { at, game, gameWithMines, snapshot } from "./helpers";

describe("game config validation", () => {
  it("accepts a well formed config", () => {
    const result = validateGameConfig({ size: vec3(5, 5, 5), mineCount: 10, seed: 42, firstRevealSafe: true });

    expect(result).toEqual({
      ok: true,
      config: {
        size: vec3(5, 5, 5),
        mineCount: 10,
        seed: 42,
        firstRevealSafe: true,
        minesFatal: true,
        freeReveals: 0,
      },
    });
  });

  it("defaults the safe opening rule when it is omitted", () => {
    const result = validateGameConfig({ size: vec3(3, 3, 3), mineCount: 1, seed: 1 });
    expect(result.ok && result.config.firstRevealSafe).toBe(true);
  });

  it("defaults mines to fatal and keeps an explicit choice", () => {
    const omitted = validateGameConfig({ size: vec3(3, 3, 3), mineCount: 1, seed: 1 });
    expect(omitted.ok && omitted.config.minesFatal).toBe(true);

    const optional = validateGameConfig({ size: vec3(3, 3, 3), mineCount: 1, seed: 1, minesFatal: false });
    expect(optional.ok && optional.config.minesFatal).toBe(false);
  });

  it("defaults free reveals off and keeps an explicit count", () => {
    const omitted = validateGameConfig({ size: vec3(3, 3, 3), mineCount: 1, seed: 1 });
    expect(omitted.ok && omitted.config.freeReveals).toBe(0);

    const optional = validateGameConfig({ size: vec3(3, 3, 3), mineCount: 1, seed: 1, freeReveals: 5 });
    expect(optional.ok && optional.config.freeReveals).toBe(5);
  });

  it("normalises the seed", () => {
    const result = validateGameConfig({ size: vec3(3, 3, 3), mineCount: 1, seed: 12.87 });
    expect(result.ok && result.config.seed).toBe(12);
  });

  it("rejects malformed payloads with precise issues", () => {
    const cases: readonly [unknown, RegExp][] = [
      [null, /must be an object/],
      [{ size: vec3(3, 3, 3), mineCount: 1, seed: 1, firstRevealSafe: "yes" }, /firstRevealSafe/],
      [{ size: vec3(3, 3, 3), mineCount: -1, seed: 1 }, /mineCount/],
      [{ size: vec3(3, 3, 3), mineCount: 1.5, seed: 1 }, /mineCount/],
      [{ size: vec3(3, 3, 3), mineCount: 1 }, /seed/],
      [{ size: vec3(3, 3, 3), mineCount: 1, seed: Number.NaN }, /seed/],
      [{ size: vec3(0, 3, 3), mineCount: 1, seed: 1 }, /size\.x/],
      [{ size: vec3(3, 33, 3), mineCount: 1, seed: 1 }, /size\.y/],
      [{ size: vec3(3, 3, 1.5), mineCount: 1, seed: 1 }, /size/],
      [{ size: "3x3x3", mineCount: 1, seed: 1 }, /size/],
      [{ size: vec3(2, 2, 2), mineCount: 8, seed: 1 }, /at least one safe cell/],
      [{ size: vec3(3, 3, 3), mineCount: 1, seed: 1, freeReveals: -1 }, /freeReveals/],
      [{ size: vec3(3, 3, 3), mineCount: 1, seed: 1, freeReveals: 1.5 }, /freeReveals/],
      [{ size: vec3(3, 3, 3), mineCount: 1, seed: 1, freeReveals: "3" }, /freeReveals/],
      // One charge is spent per cell, so more charges than cells cannot be used.
      [{ size: vec3(2, 2, 2), mineCount: 1, seed: 1, freeReveals: 9 }, /freeReveals/],
    ];

    for (const [input, pattern] of cases) {
      const result = validateGameConfig(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.join(" ")).toMatch(pattern);
    }
  });

  it("throws a typed error from the parsing entry point", () => {
    expect(() => parseGameConfig({ size: vec3(3, 3, 3), mineCount: 99, seed: 1 })).toThrow(
      InvalidGameStateError,
    );
  });
});

describe("state serialisation", () => {
  it("survives a JSON round trip unchanged", () => {
    const state = revealCell(game(vec3(4, 4, 4), 6, { seed: 3 }), at(0, 0, 0)).state;
    const restored = parseGameState(JSON.parse(serializeGame(state)));

    expect(snapshot(restored)).toBe(snapshot(state));
  });

  it("carries question marks, probes and the charge budget across a round trip", () => {
    const state = revealCell(game(vec3(3, 3, 3), 2, { seed: 4, freeReveals: 3 }), at(0, 0, 0)).state;
    // A question mark on one cell, a probe on another, so both new fields are
    // exercised by the same payload.
    const questioned = cycleMark(state, at(2, 2, 2)).state;
    const probed = probeCell(cycleMark(questioned, at(2, 2, 2)).state, at(2, 2, 1)).state;
    expect(probed.freeRevealsLeft).toBe(2);
    expect(probed.cells.filter((cell) => cell.isQuestioned)).toHaveLength(1);

    const restored = parseGameState(JSON.parse(serializeGame(probed)));

    expect(snapshot(restored)).toBe(snapshot(probed));
    expect(restored.freeRevealsLeft).toBe(2);
  });

  it("rejects a state that claims to have spent more charges than it was granted", () => {
    const valid = JSON.parse(serializeGame(game(vec3(3, 3, 3), 1, { seed: 1, freeReveals: 1 }))) as Record<
      string,
      unknown
    >;

    expect(() => parseGameState({ ...valid, freeRevealsLeft: 2 })).toThrow(/freeRevealsLeft/);
    expect(() => parseGameState({ ...valid, freeRevealsLeft: -1 })).toThrow(/freeRevealsLeft/);
  });

  it("rejects a cell that is both flagged and questioned", () => {
    const valid = JSON.parse(serializeGame(game(vec3(3, 3, 3), 1, { seed: 1 }))) as Record<string, unknown>;
    const cells = valid["cells"] as unknown[];
    const first = cells[0] as Record<string, unknown>;

    expect(() =>
      parseGameState({
        ...valid,
        cells: [{ ...first, isFlagged: true, isQuestioned: true }, ...cells.slice(1)],
      }),
    ).toThrow(/both flagged and questioned/);
  });

  it("survives a round trip after flags and a loss", () => {
    const lost = revealCell(
      gameWithMines(vec3(3, 3, 3), [at(0, 0, 0)], { firstRevealSafe: false }),
      at(0, 0, 0),
    ).state;
    const flagged = cycleMark(lost, at(1, 1, 1)).state;
    const restored = parseGameState(JSON.parse(serializeGame(flagged)));

    expect(snapshot(restored)).toBe(snapshot(flagged));
    expect(restored.status).toBe("lost");
    expect(restored.explodedAt).toEqual(at(0, 0, 0));
  });

  it("rejects payloads that do not describe a state", () => {
    const valid = JSON.parse(serializeGame(game(vec3(3, 3, 3), 1, { seed: 1 }))) as Record<string, unknown>;

    expect(() => parseGameState("nope")).toThrow(InvalidGameStateError);
    expect(() => parseGameState({ ...valid, status: "paused" })).toThrow(/status/);
    expect(() => parseGameState({ ...valid, cells: [] })).toThrow(/27 entries/);
    expect(() => parseGameState({ ...valid, flagCount: -1 })).toThrow(/flagCount/);
    expect(() => parseGameState({ ...valid, explodedAt: { x: 1 } })).toThrow(/explodedAt/);

    const cells = valid["cells"] as unknown[];
    const first = cells[0] as Record<string, unknown>;
    expect(() => parseGameState({ ...valid, cells: [{ ...first, index: at(9, 9, 9) }, ...cells.slice(1)] })).toThrow(
      /index/,
    );
    expect(() => parseGameState({ ...valid, cells: [{ ...first, adjacentMines: 42 }, ...cells.slice(1)] })).toThrow(
      /adjacentMines/,
    );
    expect(() => parseGameState({ ...valid, cells: [{ ...first, isRevealed: "yes" }, ...cells.slice(1)] })).toThrow(
      /isRevealed/,
    );
  });
});
