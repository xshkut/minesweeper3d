/**
 * The DOM HUD: status, board menu, actions, legend and the result banner.
 *
 * It is plain, accessible markup over the fullscreen canvas - no 3D, no
 * framework - so it can be tested without a WebGL context.
 *
 * The panel sits in a {@link "./Hud"} dock so it can slide out of the way on a
 * narrow screen: the toggle is a sibling of the panel rather than a child, so
 * the panel's own `overflow: auto` cannot clip it, and it stays put while the
 * panel moves behind it.
 */
import { useState } from "react";
import type { ReactElement } from "react";
import { CompactStatus } from "./CompactStatus";
import { ConnectionBadge } from "./ConnectionBadge";
import { ControlsLegend } from "./ControlsLegend";
import { PresetPicker } from "./PresetPicker";
import { ResultBanner } from "./ResultBanner";
import { RoomBadge } from "./RoomBadge";
import { StatusBar } from "./StatusBar";
import { ToolPicker } from "./ToolPicker";
import type { GameSummary } from "../session/summary";
import type { SessionSnapshot } from "../session/types";
import type { BoardTool } from "../three/useBoardPointer";

/** Props of {@link Hud}. */
export interface HudProps {
  readonly snapshot: SessionSnapshot;
  readonly summary: GameSummary | null;
  readonly elapsedMs: number;
  /** Preset the current board corresponds to. */
  readonly presetId: string;
  readonly tool: BoardTool;
  /** Free reveals the current board has left; `0` disables the detector. */
  readonly freeRevealsLeft: number;
  /** Transient explanation of a refused action. */
  readonly notice: string | null;
  readonly onNewGame: () => void;
  readonly onSelectPreset: (presetId: string) => void;
  readonly onSelectTool: (tool: BoardTool) => void;
  readonly onResetView: () => void;
  readonly onPlayAgain: () => void;
  readonly onRetry?: (() => void) | undefined;
  /** Leaves the current room and returns to the welcome screen. */
  readonly onLeaveRoom?: (() => void) | undefined;
}

/**
 * `true` on a touch-first screen, where an open panel would cover the board.
 *
 * A phone is held in the hands and the panel is nearly the whole screen: the
 * cube is the game, so the rail starts folded away with its toggle right there.
 * Anything with a mouse - and a test environment with no media queries - keeps
 * the panel open, because there it costs a strip of the edge and nothing else.
 */
export function prefersCompactStart(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
}

/** Left hand control panel plus the two overlays (notice and result). */
export function Hud(props: HudProps): ReactElement {
  const { snapshot, summary, elapsedMs, presetId, tool, freeRevealsLeft, notice } = props;
  const loading = snapshot.phase === "loading";
  // Read once: the media query is the starting layout, and from then on the
  // toggle is what decides. A folded panel hides the counters with it, so a
  // compact start is also what earns the strip below.
  const [compactStart] = useState(prefersCompactStart);
  const [open, setOpen] = useState(() => !compactStart);

  return (
    <>
      {compactStart && !open && (
        <CompactStatus summary={summary} elapsedMs={elapsedMs} phase={snapshot.phase} />
      )}

      <div className="hud-dock" data-open={open || undefined}>
        <button
          type="button"
          className="hud-dock__toggle"
          data-testid="hud-toggle"
          aria-expanded={open}
          aria-controls="hud-panel"
          title={open ? "Hide the panel" : "Show the panel"}
          onClick={() => setOpen((current) => !current)}
        >
          <span aria-hidden="true">{open ? "‹" : "›"}</span>
          <span className="visually-hidden">{open ? "Hide the panel" : "Show the panel"}</span>
        </button>

        <aside className="hud" id="hud-panel" aria-label="Game status and controls">
          <h1 className="hud__title">
            Minesweeper<span>3D</span>
          </h1>

          <RoomBadge
            room={snapshot.room ?? null}
            playerId={snapshot.playerId ?? null}
            onLeave={props.onLeaveRoom}
          />

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
              <ToolPicker
                value={tool}
                onChange={props.onSelectTool}
                freeRevealsLeft={freeRevealsLeft}
                disabled={loading}
              />
              <button type="button" className="button" data-testid="reset-view" onClick={props.onResetView}>
                Reset view
              </button>
            </div>
          </div>

          <ControlsLegend />
          <ConnectionBadge snapshot={snapshot} onRetry={props.onRetry} />
        </aside>
      </div>

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
