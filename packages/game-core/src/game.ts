import { computeAdjacency, createCells, mineCellsOf, mineOffsetsOf, placeMines } from "./board";
import { createGrid, NEIGHBOURS, neighboursOf, type Grid } from "./grid";
import { normalizeSeed, randomInt, randomSeed } from "./random";
import { DEFAULT_RULES, hasRevealedAllSafeCells, isExposed, isGameOver } from "./rules";
import { parseGameConfig } from "./serialization";
import type {
  Cell,
  CellIndex,
  ClientCell,
  ClientGameState,
  GameConfig,
  GameEvent,
  GameState,
  GameTransition,
  Vec3,
} from "./types";
import { vec3 } from "./vec3";

export { DEFAULT_RULES };


const NO_EVENTS: readonly GameEvent[] = Object.freeze([]);

/**
 * Creates a new game: mines are laid out from `config.seed` and every cell
 * starts covered.
 *
 * The returned state is plain, deeply serialisable data and the function is
 * pure - the same config always produces the same board. The config is
 * validated on the way in, so callers that pass untrusted input (an HTTP body,
 * a shared link) get a clear error instead of a broken board.
 *
 * @throws InvalidGameStateError when the config cannot describe a playable board
 */
export function createGame(input: GameConfig): GameState {
  const config = parseGameConfig(input);
  const grid = createGrid(config.size);
  const { mineOffsets, rngState } = placeMines(grid, config.mineCount, normalizeSeed(config.seed));
  return buildState(config, grid, mineOffsets, rngState);
}

/**
 * Creates a game from an explicit mine layout.
 *
 * Used by tests, by hand crafted levels and by any future map editor;
 * `config.mineCount` must match the layout.
 */
export function createGameWithMines(input: GameConfig, mines: readonly CellIndex[]): GameState {
  const config = parseGameConfig(input);
  const grid = createGrid(config.size);
  if (mines.length !== config.mineCount) {
    throw new RangeError(`Layout has ${mines.length} mines but the config declares ${config.mineCount}`);
  }
  const unique = new Set<number>();
  for (const mine of mines) {
    if (!grid.contains(mine)) throw new RangeError(`Mine ${formatCell(mine)} lies outside the board`);
    unique.add(grid.offsetOf(mine));
  }
  if (unique.size !== mines.length) throw new RangeError("Layout contains duplicate mines");
  return buildState(config, grid, [...unique], normalizeSeed(config.seed));
}

/** Replaces the mine layout of a state, keeping the generator in sync. */
function buildState(config: GameConfig, grid: Grid, mineOffsets: readonly number[], rngState: number): GameState {
  const adjacency = computeAdjacency(grid, mineOffsets);
  return {
    config,
    status: "ready",
    cells: createCells(grid, mineOffsets, adjacency),
    revealedCount: 0,
    flagCount: 0,
    explodedAt: null,
    rngState,
  };
}

/**
 * Reveals a covered cell.
 *
 * The action is ignored - returning the very same state and no events - when
 * the cell is outside the board, already revealed, flagged, not exposed, or
 * when the game is over.
 *
 * Revealing a mine ends the game and uncovers every mine; revealing a cell
 * without adjacent mines floods the connected safe region.
 */
export function revealCell(state: GameState, cell: CellIndex): GameTransition {
  const grid = createGrid(state.config.size);
  if (isGameOver(state.status) || !grid.contains(cell)) return unchanged(state);

  const offset = grid.offsetOf(cell);
  const target = state.cells[offset];
  if (target === undefined || target.isRevealed || target.isFlagged) return unchanged(state);
  if (!isExposed(grid, state.cells, offset)) return unchanged(state);

  let current = state;
  if (target.hasMine) {
    if (!(current.config.firstRevealSafe && current.status === "ready")) {
      return explode(current, target.index);
    }
    current = relocateMine(current, grid, offset);
    // Unreachable while `mineCount <= cellCount - 1` is enforced, but never let
    // a broken invariant turn into "opening" a mine.
    if ((current.cells[offset] as Cell).hasMine) return explode(current, target.index);
  }

  const status = current.status === "ready" ? "playing" : current.status;
  return revealRegion({ ...current, status }, grid, offset);
}

/**
 * Toggles the flag of a covered cell.
 *
 * Flags never limit how many can be placed (the prototype did the same); the
 * client derives "mines left" from {@link remainingMineCount}.
 */
export function toggleFlag(state: GameState, cell: CellIndex): GameTransition {
  const grid = createGrid(state.config.size);
  if (isGameOver(state.status) || !grid.contains(cell)) return unchanged(state);

  const offset = grid.offsetOf(cell);
  const target = state.cells[offset];
  if (target === undefined || target.isRevealed) return unchanged(state);

  const flagged = !target.isFlagged;
  const cells = [...state.cells];
  cells[offset] = { ...target, isFlagged: flagged };

  return {
    state: { ...state, cells, flagCount: state.flagCount + (flagged ? 1 : -1) },
    events: [{ type: "flagChanged", cell: target.index, flagged }],
  };
}

/** The cell at the given coordinates, or `undefined` when outside the board. */
export function cellAt(state: GameState, cell: CellIndex): Cell | undefined {
  const grid = createGrid(state.config.size);
  return grid.contains(cell) ? state.cells[grid.offsetOf(cell)] : undefined;
}

/** `true` when a covered cell may be opened right now (see {@link isExposed}). */
export function isCellExposed(state: GameState, cell: CellIndex): boolean {
  const grid = createGrid(state.config.size);
  return grid.contains(cell) && isExposed(grid, state.cells, grid.offsetOf(cell));
}

/** Mines that have not been flagged yet; may go negative on over-flagging. */
export function remainingMineCount(state: GameState): number {
  return state.config.mineCount - state.flagCount;
}

/** All mine positions; not safe to send to a player that is still playing. */
export function mineCells(state: GameState): readonly CellIndex[] {
  return mineCellsOf(state.cells);
}

/** `true` when the game is finished, either way. */
export function isFinished(state: GameState): boolean {
  return isGameOver(state.status);
}

/**
 * Strips the information a player must not see yet.
 *
 * A covered cell reports neither its mine nor its danger count: knowing "this
 * covered cell touches three mines" is as good as seeing through the cube, so
 * the server never sends it. Both become visible once the cell is opened or
 * once the game is over, which is all the renderer needs.
 */
export function toClientView(state: GameState): ClientGameState {
  const revealAll = isGameOver(state.status);
  const cells: ClientCell[] = state.cells.map((cell) => {
    const visible = cell.isRevealed || revealAll;
    return {
      index: cell.index,
      adjacentMines: visible ? cell.adjacentMines : 0,
      isRevealed: cell.isRevealed,
      isFlagged: cell.isFlagged,
      hasMine: visible && cell.hasMine,
    };
  });

  return {
    config: state.config,
    status: state.status,
    cells,
    revealedCount: state.revealedCount,
    flagCount: state.flagCount,
    explodedAt: state.explodedAt,
  };
}

/** Options accepted by {@link createConfig}. */
export interface CreateConfigOptions {
  readonly size: Vec3;
  readonly mineCount: number;
  /** Defaults to a fresh random seed. */
  readonly seed?: number;
  /** Defaults to {@link DEFAULT_RULES.firstRevealSafe}. */
  readonly firstRevealSafe?: boolean;
}

/** Builds a config from options, drawing a fresh seed when none is given. */
export function createConfig(options: CreateConfigOptions): GameConfig {
  return {
    size: vec3(options.size.x, options.size.y, options.size.z),
    mineCount: options.mineCount,
    seed: normalizeSeed(options.seed ?? randomSeed()),
    firstRevealSafe: options.firstRevealSafe ?? DEFAULT_RULES.firstRevealSafe,
  };
}

/**
 * Uncovers the clicked mine and every other mine on the board.
 *
 * Only the clicked cell is reported through `explodedAt`; the client uses it
 * for the "you stepped on this one" highlight.
 */
function explode(state: GameState, cell: CellIndex): GameTransition {
  const cells = [...state.cells];
  const mines: CellIndex[] = [];
  for (const offset of mineOffsetsOf(cells)) {
    const mine = cells[offset] as Cell;
    if (!mine.isRevealed) {
      cells[offset] = { ...mine, isRevealed: true };
      mines.push(mine.index);
    }
  }

  return {
    state: { ...state, status: "lost", cells, explodedAt: cell },
    events: [
      { type: "mineExploded", cell },
      { type: "minesRevealed", cells: mines },
      { type: "gameLost" },
    ],
  };
}

/**
 * Flood fill from a mine-free cell.
 *
 * Cells reachable through cells with no adjacent mines are opened one by one,
 * but - as everywhere else - only while they are exposed. Whenever a pass
 * opens at least one cell the previously blocked candidates are retried, so
 * the fill keeps digging towards the inside of the cube as the revealed
 * surface grows. The fill only ever reaches mine-free cells: a cell with no
 * adjacent mines has no mine within its 26 neighbours.
 */
function revealRegion(state: GameState, grid: Grid, startOffset: number): GameTransition {
  const cells = [...state.cells];
  const revealed: CellIndex[] = [];
  const settled = new Set<number>();
  const blocked = new Set<number>();
  const frontier: number[] = [startOffset];

  for (;;) {
    let progressed = false;

    while (frontier.length > 0) {
      const offset = frontier.pop() as number;
      if (settled.has(offset)) continue;

      const cell = cells[offset] as Cell;
      if (cell.isRevealed || cell.isFlagged) {
        settled.add(offset);
        continue;
      }
      if (!isExposed(grid, cells, offset)) {
        blocked.add(offset);
        continue;
      }

      settled.add(offset);
      cells[offset] = { ...cell, isRevealed: true };
      revealed.push(cell.index);
      progressed = true;

      if (cell.adjacentMines === 0) {
        for (const neighbour of neighboursOf(grid, cell.index, NEIGHBOURS)) {
          frontier.push(grid.offsetOf(neighbour));
        }
      }
    }

    if (!progressed || blocked.size === 0) break;
    for (const offset of blocked) frontier.push(offset);
    blocked.clear();
  }

  const revealedCount = state.revealedCount + revealed.length;
  const won = hasRevealedAllSafeCells(grid, state.config, revealedCount);
  const events: GameEvent[] = revealed.length > 0 ? [{ type: "cellsRevealed", cells: revealed }] : [];

  if (!won) {
    return { state: { ...state, cells, revealedCount }, events };
  }

  const mines: CellIndex[] = [];
  for (const offset of mineOffsetsOf(cells)) {
    const mine = cells[offset] as Cell;
    if (!mine.isRevealed) {
      cells[offset] = { ...mine, isRevealed: true };
      mines.push(mine.index);
    }
  }
  if (mines.length > 0) events.push({ type: "minesRevealed", cells: mines });
  events.push({ type: "gameWon" });

  return { state: { ...state, status: "won", cells, revealedCount }, events };
}

/**
 * Moves the mine that would end the game to another cell.
 *
 * Cells outside the 26-neighbourhood of the opening click are preferred, so
 * the first reveal opens a region instead of showing a lonely number.
 *
 * @returns a state whose mine layout no longer contains a mine on `mineOffset`
 */
function relocateMine(state: GameState, grid: Grid, mineOffset: number): GameState {
  const neighbourhood = new Set<number>();
  for (const neighbour of neighboursOf(grid, grid.cellOf(mineOffset), NEIGHBOURS)) {
    neighbourhood.add(grid.offsetOf(neighbour));
  }

  const preferred: number[] = [];
  const fallback: number[] = [];
  for (let offset = 0; offset < grid.cellCount; offset += 1) {
    if (offset === mineOffset) continue;
    const cell = state.cells[offset] as Cell;
    if (cell.hasMine) continue;
    (neighbourhood.has(offset) ? fallback : preferred).push(offset);
  }

  const pool = preferred.length > 0 ? preferred : fallback;
  if (pool.length === 0) return state;

  const draw = randomInt(state.rngState, 0, pool.length - 1);
  const destination = pool[draw.value] as number;
  const mineOffsets = mineOffsetsOf(state.cells).filter((offset) => offset !== mineOffset);
  mineOffsets.push(destination);

  const adjacency = computeAdjacency(grid, mineOffsets);
  const mineSet = new Set(mineOffsets);
  const cells = state.cells.map((cell, offset) => ({
    ...cell,
    hasMine: mineSet.has(offset),
    adjacentMines: adjacency[offset] ?? 0,
  }));

  return { ...state, cells, rngState: draw.state };
}

/** No-op transition; keeps referential equality so React can skip re-renders. */
function unchanged(state: GameState): GameTransition {
  return { state, events: NO_EVENTS };
}

function formatCell(cell: CellIndex): string {
  return `(${cell.x}, ${cell.y}, ${cell.z})`;
}
