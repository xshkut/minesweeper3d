/**
 * Shared value types of the minesweeper rules engine.
 *
 * Everything in this package is plain data: states and snapshots survive
 * `JSON.stringify`/`JSON.parse` unchanged, which is what makes the engine
 * reusable by the browser client, the Bun server and (later) a networked
 * multiplayer session without any adapter layer.
 */

/** A point or vector in 3D space. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Integer lattice coordinates of a single cell of the board. */
export type CellIndex = Vec3;

/** Lifecycle of a single game. */
export type GameStatus = "ready" | "playing" | "won" | "lost";

/** Immutable state of one board cell. */
export interface Cell {
  readonly index: CellIndex;
  readonly hasMine: boolean;
  /** Number of mines in the 26 surrounding cells (`0`..`25`). */
  readonly adjacentMines: number;
  readonly isRevealed: boolean;
  readonly isFlagged: boolean;
}

/** Rules configuration of a game. Fully describes how a board is generated. */
export interface GameConfig {
  /** Board dimensions in cells. */
  readonly size: Vec3;
  /** Total number of mines hidden on the board. */
  readonly mineCount: number;
  /** Seed for the deterministic mine layout. */
  readonly seed: number;
  /**
   * When `true`, a mine hit on the first reveal of a game is relocated instead
   * of ending the game, so the opening click is always safe.
   */
  readonly firstRevealSafe: boolean;
}

/**
 * Immutable game state. Actions return a new state, the previous one is never
 * mutated, which makes the engine a drop-in reducer for React and for a
 * server-authoritative session.
 */
export interface GameState {
  readonly config: GameConfig;
  readonly status: GameStatus;
  /** Cells in `x`-major order; use the grid helpers to address them. */
  readonly cells: readonly Cell[];
  /** Number of revealed cells that do not contain a mine. */
  readonly revealedCount: number;
  readonly flagCount: number;
  /** Cell that ended the game, if it was lost by revealing a mine. */
  readonly explodedAt: CellIndex | null;
  /** Current state of the deterministic random generator (mine relocation). */
  readonly rngState: number;
}

/** Something the presentation layer may want to react to (animation, sound). */
export type GameEvent =
  | { readonly type: "cellsRevealed"; readonly cells: readonly CellIndex[] }
  | { readonly type: "flagChanged"; readonly cell: CellIndex; readonly flagged: boolean }
  | { readonly type: "mineExploded"; readonly cell: CellIndex }
  | { readonly type: "minesRevealed"; readonly cells: readonly CellIndex[] }
  | { readonly type: "gameWon" }
  | { readonly type: "gameLost" };

/** Result of applying an action: the next state plus what changed. */
export interface GameTransition {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
}

/** A cell as seen by a client that must not learn the mine layout. */
export interface ClientCell {
  readonly index: CellIndex;
  /**
   * Mines in the 26 surrounding cells. `0` while the cell is covered and the
   * game is still running, because that count is hidden information too.
   */
  readonly adjacentMines: number;
  readonly isRevealed: boolean;
  readonly isFlagged: boolean;
  /** Only meaningful once the cell is revealed or the game is over. */
  readonly hasMine: boolean;
}

/** Redacted state that is safe to send to a player. */
export interface ClientGameState {
  readonly config: GameConfig;
  readonly status: GameStatus;
  readonly cells: readonly ClientCell[];
  readonly revealedCount: number;
  readonly flagCount: number;
  readonly explodedAt: CellIndex | null;
}

/** A named board configuration offered by the client menus. */
export interface GamePreset {
  readonly id: string;
  readonly label: string;
  readonly size: Vec3;
  readonly mineCount: number;
}
