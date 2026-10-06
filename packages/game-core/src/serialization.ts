import { createGrid, MAX_DIMENSION } from "./grid";
import { normalizeSeed } from "./random";
import { DEFAULT_RULES } from "./rules";
import type { Cell, CellIndex, GameConfig, GameState, GameStatus } from "./types";
import { equalsVec3, isCellIndex } from "./vec3";

/** Thrown when a payload cannot be trusted to be a valid game state. */
export class InvalidGameStateError extends Error {
  override readonly name = "InvalidGameStateError";

  constructor(message: string) {
    super(message);
  }
}

/** Outcome of validating untrusted input against the rules configuration. */
export type ConfigValidationResult =
  | { readonly ok: true; readonly config: GameConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Validates an untrusted value as a {@link GameConfig}.
 *
 * Used at every trust boundary (HTTP request bodies, WebSocket messages,
 * `localStorage`) so the engine itself can assume a well formed config.
 */
export function validateGameConfig(input: unknown): ConfigValidationResult {
  const issues: string[] = [];
  if (!isRecord(input)) return { ok: false, issues: ["config must be an object"] };

  const size = input["size"];
  if (!isCellIndex(size)) {
    issues.push("size must be an object of three integers");
  } else {
    for (const axis of ["x", "y", "z"] as const) {
      const dimension = size[axis];
      if (dimension < 1 || dimension > MAX_DIMENSION) {
        issues.push(`size.${axis} must be between 1 and ${MAX_DIMENSION}`);
      }
    }
  }

  const mineCount = input["mineCount"];
  if (!Number.isInteger(mineCount) || (mineCount as number) < 0) {
    issues.push("mineCount must be a non-negative integer");
  }

  const seed = input["seed"];
  if (typeof seed !== "number" || !Number.isFinite(seed)) {
    issues.push("seed must be a finite number");
  }

  const firstRevealSafe = input["firstRevealSafe"] ?? DEFAULT_RULES.firstRevealSafe;
  if (typeof firstRevealSafe !== "boolean") {
    issues.push("firstRevealSafe must be a boolean");
  }

  const minesFatal = input["minesFatal"] ?? DEFAULT_RULES.minesFatal;
  if (typeof minesFatal !== "boolean") {
    issues.push("minesFatal must be a boolean");
  }

  const freeReveals = input["freeReveals"] ?? DEFAULT_RULES.freeReveals;
  if (!Number.isInteger(freeReveals) || (freeReveals as number) < 0) {
    issues.push("freeReveals must be a non-negative integer");
  }

  if (issues.length > 0) return { ok: false, issues };

  const config: GameConfig = {
    size: { x: (size as CellIndex).x, y: (size as CellIndex).y, z: (size as CellIndex).z },
    mineCount: mineCount as number,
    seed: normalizeSeed(seed as number),
    firstRevealSafe: firstRevealSafe as boolean,
    minesFatal: minesFatal as boolean,
    freeReveals: freeReveals as number,
  };

  const cellCount = config.size.x * config.size.y * config.size.z;
  if (config.mineCount > cellCount - 1) {
    return { ok: false, issues: [`mineCount must leave at least one safe cell (max ${cellCount - 1})`] };
  }
  // A charge is spent one per cell, so more of them than cells cannot be used.
  if (config.freeReveals > cellCount) {
    return { ok: false, issues: [`freeReveals cannot exceed the cell count (max ${cellCount})`] };
  }

  return { ok: true, config };
}

/** Like {@link validateGameConfig} but throws instead of returning issues. */
export function parseGameConfig(input: unknown): GameConfig {
  const result = validateGameConfig(input);
  if (!result.ok) throw new InvalidGameStateError(`Invalid game config: ${result.issues.join("; ")}`);
  return result.config;
}

/** Serialises a state; the result can be sent over the wire as is. */
export function serializeGame(state: GameState): string {
  return JSON.stringify(state);
}

/**
 * Parses an untrusted payload into a {@link GameState}.
 *
 * Every invariant the engine relies on is checked here: cell count, lattice
 * coordinates, adjacency range and counters.
 *
 * @throws InvalidGameStateError when the payload is not a valid state
 */
export function parseGameState(input: unknown): GameState {
  if (!isRecord(input)) throw new InvalidGameStateError("Game state must be an object");

  const config = parseGameConfig(input["config"]);
  const grid = createGrid(config.size);

  const status = input["status"];
  if (!isGameStatus(status)) {
    throw new InvalidGameStateError(`status must be one of ready, playing, won, lost (got ${String(status)})`);
  }

  const rawCells = input["cells"];
  if (!Array.isArray(rawCells)) throw new InvalidGameStateError("cells must be an array");
  if (rawCells.length !== grid.cellCount) {
    throw new InvalidGameStateError(`cells must hold ${grid.cellCount} entries, got ${rawCells.length}`);
  }

  const cells = rawCells.map((raw, offset) => parseCell(raw, offset, grid.cellOf(offset)));

  const explodedAtRaw = input["explodedAt"];
  const explodedAt = explodedAtRaw === null || explodedAtRaw === undefined ? null : parseCellIndex(explodedAtRaw, "explodedAt");

  const freeRevealsLeft = parseCounter(input["freeRevealsLeft"], "freeRevealsLeft");
  if (freeRevealsLeft > config.freeReveals) {
    throw new InvalidGameStateError(
      `freeRevealsLeft must not exceed the granted ${config.freeReveals}`,
    );
  }

  return {
    config,
    status,
    cells,
    revealedCount: parseCounter(input["revealedCount"], "revealedCount"),
    flagCount: parseCounter(input["flagCount"], "flagCount"),
    freeRevealsLeft,
    explodedAt,
    // The generator state is a signed 32 bit integer, unlike the counters.
    rngState: parseInteger(input["rngState"], "rngState"),
  };
}

function parseCell(raw: unknown, offset: number, expected: CellIndex): Cell {
  if (!isRecord(raw)) throw new InvalidGameStateError(`cells[${offset}] must be an object`);

  const index = raw["index"];
  if (!isCellIndex(index) || !equalsVec3(index, expected)) {
    throw new InvalidGameStateError(`cells[${offset}].index must be ${formatCell(expected)}`);
  }

  const adjacentMines = raw["adjacentMines"];
  if (!Number.isInteger(adjacentMines) || (adjacentMines as number) < 0 || (adjacentMines as number) > 26) {
    throw new InvalidGameStateError(`cells[${offset}].adjacentMines must be an integer between 0 and 26`);
  }

  const isFlagged = parseBoolean(raw["isFlagged"], `cells[${offset}].isFlagged`);
  const isQuestioned = parseBoolean(raw["isQuestioned"], `cells[${offset}].isQuestioned`);
  // Flags and question marks are the same slot seen from two sides; the engine
  // writes them through one cycling action, so a payload holding both at once
  // was not produced here and cannot be trusted further.
  if (isFlagged && isQuestioned) {
    throw new InvalidGameStateError(`cells[${offset}] cannot be both flagged and questioned`);
  }

  return {
    index: { x: index.x, y: index.y, z: index.z },
    hasMine: parseBoolean(raw["hasMine"], `cells[${offset}].hasMine`),
    adjacentMines: adjacentMines as number,
    isRevealed: parseBoolean(raw["isRevealed"], `cells[${offset}].isRevealed`),
    isFlagged,
    isQuestioned,
    isProbed: parseBoolean(raw["isProbed"], `cells[${offset}].isProbed`),
  };
}

function parseCellIndex(raw: unknown, field: string): CellIndex {
  if (!isCellIndex(raw)) throw new InvalidGameStateError(`${field} must be an object of three integers`);
  return { x: raw.x, y: raw.y, z: raw.z };
}

function parseCounter(raw: unknown, field: string): number {
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    throw new InvalidGameStateError(`${field} must be a non-negative integer`);
  }
  return raw as number;
}

function parseInteger(raw: unknown, field: string): number {
  if (!Number.isInteger(raw) || !Number.isFinite(raw)) {
    throw new InvalidGameStateError(`${field} must be an integer`);
  }
  return raw as number;
}

function parseBoolean(raw: unknown, field: string): boolean {
  if (typeof raw !== "boolean") throw new InvalidGameStateError(`${field} must be a boolean`);
  return raw;
}

function isGameStatus(value: unknown): value is GameStatus {
  return value === "ready" || value === "playing" || value === "won" || value === "lost";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCell(cell: CellIndex): string {
  return `(${cell.x}, ${cell.y}, ${cell.z})`;
}
