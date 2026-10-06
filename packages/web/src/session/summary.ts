/**
 * Derived numbers the HUD shows. Pure so the presentation layer stays dumb and
 * the arithmetic is covered by tests.
 */
import type { ClientGameState, GameStatus } from "@minesweeper3d/game-core";

/** Everything the status bar renders, derived from one client state. */
export interface GameSummary {
  readonly status: GameStatus;
  /** Mines that have not been flagged yet; may go negative on over-flagging. */
  readonly minesLeft: number;
  readonly mineCount: number;
  readonly flags: number;
  readonly revealed: number;
  /** Cells that must be revealed to win. */
  readonly total: number;
  /** Covered cells carrying a question mark. */
  readonly questions: number;
  /** Free reveals still available; `0` when the aid is off. */
  readonly freeRevealsLeft: number;
  /** Free reveals the board was created with; `0` turns the row off. */
  readonly freeReveals: number;
  /** Reveal progress in `0..1`. */
  readonly progress: number;
}

/** Derives the HUD numbers; `null` while no state has arrived yet. */
export function summarize(state: ClientGameState | null): GameSummary | null {
  if (state === null) return null;

  const { size, mineCount } = state.config;
  const total = Math.max(0, size.x * size.y * size.z - mineCount);
  return {
    status: state.status,
    minesLeft: mineCount - state.flagCount,
    mineCount,
    flags: state.flagCount,
    revealed: state.revealedCount,
    total,
    questions: state.cells.reduce((count, cell) => (cell.isQuestioned ? count + 1 : count), 0),
    freeRevealsLeft: state.freeRevealsLeft,
    freeReveals: state.config.freeReveals,
    progress: total === 0 ? 1 : Math.min(1, state.revealedCount / total),
  };
}

/** Human readable status label, also used by the e2e test. */
export function statusLabel(status: GameStatus): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "playing":
      return "Playing";
    case "won":
      return "Won";
    case "lost":
      return "Lost";
  }
}

/** `mm:ss` clock for the timer; hours are folded into minutes on purpose. */
export function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
