/**
 * Status bar: the numbers a minesweeper player expects at a glance.
 *
 * Every value is a real DOM text node with a `data-testid`, so both the e2e
 * test and screen readers see the same thing.
 */
import type { ReactElement } from "react";
import { formatDuration, statusLabel } from "../session/summary";
import type { GameSummary } from "../session/summary";
import type { SessionSnapshot } from "../session/types";

/** Props of {@link StatusBar}. */
export interface StatusBarProps {
  readonly summary: GameSummary | null;
  readonly elapsedMs: number;
  readonly phase: SessionSnapshot["phase"];
}

/** Renders mines left, flags, progress, clock and the status badge. */
export function StatusBar({ summary, elapsedMs, phase }: StatusBarProps): ReactElement {
  const status = summary === null ? (phase === "error" ? "offline" : "loading") : statusLabel(summary.status);

  return (
    <div className="statusbar">
      <span className="statusbar__badge" data-testid="hud-status" data-status={summary?.status ?? phase}>
        {status}
      </span>

      <dl className="statusbar__grid">
        <div className="statusbar__item">
          <dt>Mines left</dt>
          <dd data-testid="hud-mines-left">{summary === null ? "—" : summary.minesLeft}</dd>
        </div>
        <div className="statusbar__item">
          <dt>Flags</dt>
          <dd data-testid="hud-flags">{summary === null ? "—" : summary.flags}</dd>
        </div>
        <div className="statusbar__item">
          <dt>Revealed</dt>
          <dd data-testid="hud-progress">
            {summary === null ? "—" : `${summary.revealed} / ${summary.total}`}
          </dd>
        </div>
        <div className="statusbar__item">
          <dt>Time</dt>
          <dd data-testid="hud-timer">{formatDuration(elapsedMs)}</dd>
        </div>
      </dl>
    </div>
  );
}
