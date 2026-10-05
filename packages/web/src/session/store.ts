/**
 * Small glue between the session and the outside world: the automation hook
 * used by the e2e smoke test (and by anyone poking at the app from the console).
 */
import { isCellIndex } from "@minesweeper3d/game-core";
import type { CellIndex } from "@minesweeper3d/game-core";
import type { GameSession, SessionSnapshot } from "./types";

/** Shape installed on `window.__minesweeper3d`. */
export interface MinesweeperAutomationApi {
  /** Current session snapshot, including the redacted game state. */
  snapshot(): SessionSnapshot;
  /** Reveals a cell (ignored by the engine when the move is illegal). */
  reveal(cell: CellIndex): void;
  /** Toggles a flag on a covered cell. */
  toggleFlag(cell: CellIndex): void;
  /** Starts a new game, optionally on another preset. */
  newGame(presetId?: string): void;
}

declare global {
  interface Window {
    __minesweeper3d?: MinesweeperAutomationApi;
  }
}

/**
 * Publishes a session on `scope.__minesweeper3d`.
 *
 * Coordinates coming from the outside are validated so a typo in a test or in
 * the console cannot push garbage into the rules engine.
 *
 * @returns an uninstall function that removes the hook again
 */
export function installAutomationHook(session: GameSession, scope: Window = window): () => void {
  const api: MinesweeperAutomationApi = {
    snapshot: () => session.getSnapshot(),
    reveal: (cell) => {
      if (isCellIndex(cell)) session.reveal(cell);
    },
    toggleFlag: (cell) => {
      if (isCellIndex(cell)) session.toggleFlag(cell);
    },
    newGame: (presetId) => {
      session.newGame(presetId === undefined ? {} : { presetId });
    },
  };

  scope.__minesweeper3d = api;
  return () => {
    if (scope.__minesweeper3d === api) delete scope.__minesweeper3d;
  };
}
