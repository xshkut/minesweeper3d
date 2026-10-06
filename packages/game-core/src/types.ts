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

/**
 * How a player has annotated a covered cell.
 *
 * The two annotations are mutually exclusive - a cell is either claimed to hide
 * a mine or merely doubted - so a cell is never both flagged and questioned.
 * {@link markOf} reads the mark of a cell and `cycleMark` is the only place
 * that writes it, which is what keeps that invariant true.
 */
export type CellMark = "none" | "flag" | "question";

/** Immutable state of one board cell. */
export interface Cell {
  readonly index: CellIndex;
  readonly hasMine: boolean;
  /** Number of mines in the 26 surrounding cells (`0`..`25`). */
  readonly adjacentMines: number;
  readonly isRevealed: boolean;
  /** The player claims this cell hides a mine. Never set together with {@link isQuestioned}. */
  readonly isFlagged: boolean;
  /** The player is unsure about this cell. Never set together with {@link isFlagged}. */
  readonly isQuestioned: boolean;
  /**
   * A free reveal has been spent on this cell, so the player has been told
   * whether it hides a mine. The cell itself stays covered and still has to be
   * opened the normal way.
   */
  readonly isProbed: boolean;
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
  /**
   * When `false`, opening a mine uncovers that one cell instead of ending the
   * game.
   *
   * This is what survival rooms are built on: the cube is shared, so a fatal
   * mine would end the round for everybody. With `minesFatal: false` the
   * engine keeps playing and the room decides what the explosion costs the
   * player who caused it.
   */
  readonly minesFatal: boolean;
  /**
   * How many free reveals the board grants.
   *
   * A free reveal spends one charge to learn whether a single covered cell
   * hides a mine; the cell stays covered, so the answer is information, not a
   * shortcut. `0` (the default) turns the option off and the action becomes a
   * no-op.
   *
   * A charge is only ever spent on a cell that has not been probed before, so
   * `freeReveals` larger than the cell count simply means "always enough".
   */
  readonly freeReveals: number;
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
  /** Free reveals that have not been spent yet; see {@link GameConfig.freeReveals}. */
  readonly freeRevealsLeft: number;
  /**
   * The most recently revealed mine, if any.
   *
   * With the default fatal mines this is the cell that lost the game; when
   * `config.minesFatal` is `false` it is the last mine a player stepped on and
   * the game carries on.
   */
  readonly explodedAt: CellIndex | null;
  /** Current state of the deterministic random generator (mine relocation). */
  readonly rngState: number;
}

/** Something the presentation layer may want to react to (animation, sound). */
export type GameEvent =
  | { readonly type: "cellsRevealed"; readonly cells: readonly CellIndex[] }
  | { readonly type: "markChanged"; readonly cell: CellIndex; readonly mark: CellMark }
  | { readonly type: "cellProbed"; readonly cell: CellIndex; readonly hasMine: boolean }
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
   *
   * A free reveal does *not* expose it: the player learns mine-or-not, never
   * how crowded the neighbourhood is.
   */
  readonly adjacentMines: number;
  readonly isRevealed: boolean;
  readonly isFlagged: boolean;
  readonly isQuestioned: boolean;
  /** A free reveal has been spent here, so {@link hasMine} is the answer it bought. */
  readonly isProbed: boolean;
  /**
   * Only meaningful once the cell is revealed, probed, or the game is over.
   */
  readonly hasMine: boolean;
}

/** Redacted state that is safe to send to a player. */
export interface ClientGameState {
  readonly config: GameConfig;
  readonly status: GameStatus;
  readonly cells: readonly ClientCell[];
  readonly revealedCount: number;
  readonly flagCount: number;
  readonly freeRevealsLeft: number;
  readonly explodedAt: CellIndex | null;
}

/** A named board configuration offered by the client menus. */
export interface GamePreset {
  readonly id: string;
  readonly label: string;
  readonly size: Vec3;
  readonly mineCount: number;
}
