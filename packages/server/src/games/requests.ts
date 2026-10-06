/**
 * Request validation and config resolution for the games module.
 *
 * Everything a client sends is untrusted, so this file answers two questions in
 * one place: "is this a well formed create request?" and "which rules config
 * does it describe?". Every path ends in the engine's own validators
 * (`validateGameConfig`), so the service can assume a playable board and the
 * HTTP layer can report the engine's issue list verbatim.
 */
import {
  DEFAULT_PRESET_ID,
  findPreset,
  GAME_PRESETS,
  isCellIndex,
  presetConfig,
  validateGameConfig,
} from "@minesweeper3d/game-core";
import type { CellIndex, GameConfig } from "@minesweeper3d/game-core";
import { InvalidGameRequestError } from "./errors";

/** Validated create options; `undefined` means "not provided". */
export interface CreateOptions {
  readonly presetId: string | undefined;
  readonly seed: number | undefined;
  readonly firstRevealSafe: boolean | undefined;
  /** Charges the free-reveal aid grants; `0` turns the aid off. */
  readonly freeReveals: number | undefined;
}

/** A resolved config plus the preset it came from (for logging). */
export interface ResolvedConfig {
  readonly config: GameConfig;
  readonly presetId: string | undefined;
}

/** Narrows a value to a JSON object (never an array or `null`). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates a cell payload.
 *
 * Out-of-board cells are *not* rejected here: the engine ignores them, so they
 * are a legitimate no-op. Fractional or missing coordinates are a client bug.
 */
export function parseCell(cell: unknown): CellIndex {
  if (!isCellIndex(cell)) {
    throw new InvalidGameRequestError("invalid_cell", "cell must be an object of three integers", [
      'expected a JSON object like { "x": 0, "y": 0, "z": 0 } with integer coordinates',
    ]);
  }
  return { x: cell.x, y: cell.y, z: cell.z };
}

/** Reads and type checks the optional create fields, reporting every issue at once. */
export function readCreateOptions(request: Record<string, unknown>): CreateOptions {
  const issues: string[] = [];

  const rawPresetId = request["presetId"];
  let presetId: string | undefined;
  if (rawPresetId === undefined || rawPresetId === null) presetId = undefined;
  else if (typeof rawPresetId === "string") presetId = rawPresetId;
  else issues.push("presetId must be a string");

  const rawSeed = request["seed"];
  let seed: number | undefined;
  if (rawSeed === undefined || rawSeed === null) seed = undefined;
  else if (typeof rawSeed === "number" && Number.isFinite(rawSeed)) seed = rawSeed;
  else issues.push("seed must be a finite number");

  const rawFirstRevealSafe = request["firstRevealSafe"];
  let firstRevealSafe: boolean | undefined;
  if (rawFirstRevealSafe === undefined || rawFirstRevealSafe === null) firstRevealSafe = undefined;
  else if (typeof rawFirstRevealSafe === "boolean") firstRevealSafe = rawFirstRevealSafe;
  else issues.push("firstRevealSafe must be a boolean");

  // A range check only: how many charges actually fit on a board depends on the
  // board, so the engine owns that bound and reports it through `invalid_config`.
  const rawFreeReveals = request["freeReveals"];
  let freeReveals: number | undefined;
  if (rawFreeReveals === undefined || rawFreeReveals === null) freeReveals = undefined;
  else if (Number.isInteger(rawFreeReveals) && (rawFreeReveals as number) >= 0) freeReveals = rawFreeReveals as number;
  else issues.push("freeReveals must be a non-negative integer");

  if (issues.length > 0) {
    throw new InvalidGameRequestError("invalid_body", "Request body is invalid", issues);
  }
  return { presetId, seed, firstRevealSafe, freeReveals };
}

/**
 * Resolves the rules config of a new game.
 *
 * An explicit `config` wins over `presetId`; `seed`, `firstRevealSafe` and
 * `freeReveals` override either source.
 */
export function resolveConfig(request: Record<string, unknown>, options: CreateOptions): ResolvedConfig {
  const rawConfig = request["config"];

  if (rawConfig !== undefined && rawConfig !== null) {
    const validation = validateGameConfig(rawConfig);
    if (!validation.ok) {
      throw new InvalidGameRequestError("invalid_config", "Game config is invalid", validation.issues);
    }
    const base = validation.config;
    return {
      config: validatedConfig({
        size: base.size,
        mineCount: base.mineCount,
        seed: options.seed ?? base.seed,
        firstRevealSafe: options.firstRevealSafe ?? base.firstRevealSafe,
        // Not overridable from the request body: the fatal-mine rule belongs to
        // the mode a room plays, and a private game simply keeps the default.
        minesFatal: base.minesFatal,
        freeReveals: options.freeReveals ?? base.freeReveals,
      }),
      presetId: undefined,
    };
  }

  const presetId = options.presetId ?? DEFAULT_PRESET_ID;
  if (findPreset(presetId) === undefined) {
    throw new InvalidGameRequestError("unknown_preset", `Unknown preset "${presetId}"`, [
      `known presets: ${presetIds()}`,
    ]);
  }

  // `presetConfig` picks a fresh random seed when none was pinned; re-validating
  // the result keeps both paths behind one guarantee.
  const base = presetConfig(presetId, {
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.firstRevealSafe === undefined ? {} : { firstRevealSafe: options.firstRevealSafe }),
    ...(options.freeReveals === undefined ? {} : { freeReveals: options.freeReveals }),
  });
  return { config: validatedConfig(base), presetId };
}

function validatedConfig(candidate: GameConfig): GameConfig {
  const validation = validateGameConfig(candidate);
  if (!validation.ok) {
    throw new InvalidGameRequestError("invalid_config", "Game config is invalid", validation.issues);
  }
  return validation.config;
}

function presetIds(): string {
  return GAME_PRESETS.map((preset) => preset.id).join(", ");
}
