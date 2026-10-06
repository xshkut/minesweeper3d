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
  CellMark,
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
  cycleMark,
  isCellExposed,
  isFinished,
  mineCells,
  probeCell,
  remainingMineCount,
  revealCell,
  toClientView,
} from "./game";
export type { CreateConfigOptions } from "./game";

export {
  computeAdjacency,
  createCells,
  markOf,
  mineCellsOf,
  mineOffsetsOf,
  nextMark,
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

export {
  cellCountOf,
  DEFAULT_DIFFICULTY_ID,
  DIFFICULTIES,
  difficultyOf,
  findDifficulty,
  formatDensity,
  isDifficultyId,
  maxMineCount,
  mineCountFor,
  mineCountForDensity,
  mineDensity,
} from "./difficulty";
export type { Difficulty, DifficultyId } from "./difficulty";

export {
  COOP_MAX_TIME_MS,
  COOP_MIN_TIME_MS,
  COOP_MS_PER_SAFE_CELL,
  coopTimeLimitMs,
  DEFAULT_MATCH_MODE,
  defaultDifficultyForMode,
  findMatchMode,
  hasEliminations,
  isMatchMode,
  isMatchStatus,
  matchModeInfo,
  MATCH_MODES,
  MATCH_STATUSES,
  sharesBoard,
  usesClock,
} from "./modes";
export type { MatchMode, MatchModeInfo, MatchStatus } from "./modes";

export {
  DEFAULT_ROOM_VISIBILITY,
  findRoomVisibility,
  isRoomVisibility,
  roomVisibilityInfo,
  ROOM_VISIBILITIES,
} from "./visibility";
export type { RoomVisibility, RoomVisibilityInfo } from "./visibility";

export { addVec3, cellKey, equalsVec3, formatVec3, isCellIndex, isVec3, vec3 } from "./vec3";
