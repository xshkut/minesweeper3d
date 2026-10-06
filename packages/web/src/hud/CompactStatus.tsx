/**
 * The two numbers a player checks constantly, pinned to the top edge.
 *
 * On a touch-first screen the panel starts folded away, because an open panel
 * covers most of a phone. That would otherwise take the clock and the mine
 * counter with it, so this strip carries them while the panel is shut; the
 * panel still holds everything else. It is inert - a tap goes to the board
 * behind it - and it borrows its own test ids so that the full status bar stays
 * the only source the automation hook reads.
 */
import type { ReactElement } from "react";
import { formatDuration } from "../session/summary";
import type { GameSummary } from "../session/summary";
import type { SessionSnapshot } from "../session/types";

/** Props of {@link CompactStatus}. */
export interface CompactStatusProps {
  readonly summary: GameSummary | null;
  readonly elapsedMs: number;
  readonly phase: SessionSnapshot["phase"];
}

/** Mines left and the clock, sized for a strip along the top of a phone. */
export function CompactStatus({ summary, elapsedMs, phase }: CompactStatusProps): ReactElement {
  return (
    <div
      className="compact-status"
      data-testid="hud-compact"
      data-status={summary?.status ?? phase}
      role="group"
      aria-label="Game status"
    >
      <span className="compact-status__item">
        <span className="compact-status__label">Mines</span>
        <span className="compact-status__value" data-testid="hud-compact-mines">
          {summary === null ? "—" : summary.minesLeft}
        </span>
      </span>
      <span className="compact-status__item">
        <span className="compact-status__label">Time</span>
        <span className="compact-status__value" data-testid="hud-compact-timer">
          {formatDuration(elapsedMs)}
        </span>
      </span>
    </div>
  );
}
