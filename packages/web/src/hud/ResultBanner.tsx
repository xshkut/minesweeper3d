/** Win / lose banner with the final time and a replay button. */
import type { ReactElement } from "react";
import type { GameStatus } from "@minesweeper3d/game-core";
import { formatDuration } from "../session/summary";

/** Props of {@link ResultBanner}. */
export interface ResultBannerProps {
  readonly status: GameStatus;
  readonly elapsedMs: number;
  readonly onPlayAgain: () => void;
}

/** Overlay shown once the game is over. */
export function ResultBanner({ status, elapsedMs, onPlayAgain }: ResultBannerProps): ReactElement | null {
  if (status !== "won" && status !== "lost") return null;
  const won = status === "won";

  return (
    <div className={`result result--${won ? "won" : "lost"}`} role="status" data-testid="result-banner">
      <p className="result__title">{won ? "Board cleared!" : "Boom."}</p>
      <p className="result__detail">
        {won ? "Every safe cell is open." : "You hit a mine."} Time: {formatDuration(elapsedMs)}
      </p>
      <button type="button" className="button button--primary" data-testid="play-again" onClick={onPlayAgain}>
        Play again
      </button>
    </div>
  );
}
