/**
 * `@minesweeper3d/game-core` - the rules of 3D minesweeper.
 *
 * A pure, dependency-free engine: no DOM, no renderer, no I/O. The same code
 * runs in the browser (single player), on the Bun server (authoritative games,
 * future multiplayer) and in tests.
 *
 * ```ts
 * let state = createGame(presetConfig("classic", { seed: 42 }));
 * ({ state } = revealCell(state, { x: 0, y: 0, z: 0 }));
 * ```
 */

export type {
  Cell,
  CellIndex,
  ClientCell,
  ClientGameState,
  GameConfig,
  GameEvent,
  GamePreset,
  GameState,
  GameStatus,
  GameTransition,
  Vec3,
} from "./types";

export {
  DEFAULT_RULES,
  hasRevealedAllSafeCells,
  isExposed,
  isGameOver,
} from "./rules";

export {
  cellAt,
  createConfig,
  createGame,
  createGameWithMines,
  isCellExposed,
  isFinished,
  mineCells,
  remainingMineCount,
  revealCell,
  toClientView,
  toggleFlag,
} from "./game";
export type { CreateConfigOptions } from "./game";

export {
  computeAdjacency,
  createCells,
  mineCellsOf,
  mineOffsetsOf,
  placeMines,
} from "./board";
export type { MineLayout } from "./board";

export { createGrid, FACE_NEIGHBOURS, MAX_DIMENSION, NEIGHBOURS, neighboursOf } from "./grid";
export type { Grid } from "./grid";

export { createRandom, nextRandom, normalizeSeed, randomInt, randomSeed } from "./random";
export type { RandomStep } from "./random";

export {
  InvalidGameStateError,
  parseGameConfig,
  parseGameState,
  serializeGame,
  validateGameConfig,
} from "./serialization";
export type { ConfigValidationResult } from "./serialization";

export {
  createDefaultGame,
  DEFAULT_PRESET_ID,
  findPreset,
  GAME_PRESETS,
  presetConfig,
} from "./presets";

export { addVec3, cellKey, equalsVec3, formatVec3, isCellIndex, isVec3, vec3 } from "./vec3";
