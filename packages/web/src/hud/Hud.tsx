/**
 * The DOM HUD: status, board menu, actions, legend and the result banner.
 *
 * It is plain, accessible markup over the fullscreen canvas - no 3D, no
 * framework - so it can be tested without a WebGL context.
 */
import type { ReactElement } from "react";
import { ConnectionBadge } from "./ConnectionBadge";
import { ControlsLegend } from "./ControlsLegend";
import { PresetPicker } from "./PresetPicker";
import { ResultBanner } from "./ResultBanner";
import { StatusBar } from "./StatusBar";
import type { GameSummary } from "../session/summary";
import type { SessionSnapshot } from "../session/types";

/** Props of {@link Hud}. */
export interface HudProps {
  readonly snapshot: SessionSnapshot;
  readonly summary: GameSummary | null;
  readonly elapsedMs: number;
  /** Preset the current board corresponds to. */
  readonly presetId: string;
  readonly flagMode: boolean;
  /** Transient explanation of a refused action. */
  readonly notice: string | null;
  readonly onNewGame: () => void;
  readonly onSelectPreset: (presetId: string) => void;
  readonly onToggleFlagMode: () => void;
  readonly onResetView: () => void;
  readonly onPlayAgain: () => void;
  readonly onRetry?: (() => void) | undefined;
}

/** Left hand control panel plus the two overlays (notice and result). */
export function Hud(props: HudProps): ReactElement {
  const { snapshot, summary, elapsedMs, presetId, flagMode, notice } = props;
  const loading = snapshot.phase === "loading";

  return (
    <>
      <aside className="hud" aria-label="Game status and controls">
        <h1 className="hud__title">
          Minesweeper<span>3D</span>
        </h1>

        <StatusBar summary={summary} elapsedMs={elapsedMs} phase={snapshot.phase} />

        <div className="hud__actions">
          <PresetPicker value={presetId} onChange={props.onSelectPreset} disabled={loading} />
          <div className="hud__buttons">
            <button
              type="button"
              className="button button--primary"
              data-testid="new-game"
              onClick={props.onNewGame}
            >
              New game
            </button>
            <button
              type="button"
              className="button"
              data-testid="flag-mode"
              aria-pressed={flagMode}
              onClick={props.onToggleFlagMode}
            >
              {flagMode ? "Flag mode: on" : "Flag mode: off"}
            </button>
            <button type="button" className="button" data-testid="reset-view" onClick={props.onResetView}>
              Reset view
            </button>
          </div>
        </div>

        <ControlsLegend />
        <ConnectionBadge snapshot={snapshot} onRetry={props.onRetry} />
      </aside>

      {notice !== null && (
        <p className="notice" role="status" data-testid="hud-notice">
          {notice}
        </p>
      )}

      {summary !== null && (
        <ResultBanner status={summary.status} elapsedMs={elapsedMs} onPlayAgain={props.onPlayAgain} />
      )}
    </>
  );
}
