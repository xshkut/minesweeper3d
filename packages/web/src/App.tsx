/**
 * Application shell: wires one {@link GameSession} to the HUD and the 3D view.
 *
 * The app holds only interface state (flag mode, reset token, transient
 * notices); every rule of the game lives in the session.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { DEFAULT_PRESET_ID } from "@minesweeper3d/game-core";
import type { CellIndex } from "@minesweeper3d/game-core";
import { Hud } from "./hud/Hud";
import { useElapsedTime } from "./hooks/useElapsedTime";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useSession } from "./hooks/useSession";
import { presetIdForConfig } from "./session/presets";
import { summarize } from "./session/summary";
import type { GameSession } from "./session/types";
import type { BlockedReason } from "./three/useBoardPointer";
import { GameCanvas } from "./three/GameCanvas";

/** Props of {@link App}. */
export interface AppProps {
  readonly session: GameSession;
}

/** How long a transient notice stays on screen. */
const NOTICE_MS = 3200;

/** Root component; the session is created by `main.tsx` (or by a test). */
export function App({ session }: AppProps): ReactElement {
  const snapshot = useSession(session);
  const state = snapshot.state;
  const summary = useMemo(() => summarize(state), [state]);
  const elapsed = useElapsedTime(state);

  const [flagMode, setFlagMode] = useState(false);
  const [resetToken, setResetToken] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }, []);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    },
    [],
  );

  const handleNewGame = useCallback(() => session.newGame(), [session]);
  const handlePlayAgain = useCallback(() => session.newGame(), [session]);
  const handleSelectPreset = useCallback(
    (presetId: string) => session.newGame({ presetId }),
    [session],
  );
  const handleToggleFlagMode = useCallback(() => setFlagMode((on) => !on), []);
  const handleResetView = useCallback(() => setResetToken((token) => token + 1), []);
  const handleReveal = useCallback((cell: CellIndex) => session.reveal(cell), [session]);
  const handleFlag = useCallback((cell: CellIndex) => session.toggleFlag(cell), [session]);
  const handleBlocked = useCallback(
    (_cell: CellIndex, reason: BlockedReason) => {
      showNotice(
        reason === "flagged"
          ? "That cell is flagged — unflag it first (Alt+click)."
          : "Not exposed yet — dig in from the outside.",
      );
    },
    [showNotice],
  );
  const handleRetry = useCallback(() => session.retry?.(), [session]);

  useKeyboardShortcuts({ onNewGame: handleNewGame, onToggleFlagMode: handleToggleFlagMode });

  const presetId = state === null ? DEFAULT_PRESET_ID : presetIdForConfig(state.config);

  return (
    <div className="app">
      <GameCanvas
        state={state}
        flagMode={flagMode}
        resetToken={resetToken}
        onReveal={handleReveal}
        onFlag={handleFlag}
        onBlocked={handleBlocked}
      />
      <Hud
        snapshot={snapshot}
        summary={summary}
        elapsedMs={elapsed.elapsedMs}
        presetId={presetId}
        flagMode={flagMode}
        notice={notice}
        onNewGame={handleNewGame}
        onSelectPreset={handleSelectPreset}
        onToggleFlagMode={handleToggleFlagMode}
        onResetView={handleResetView}
        onPlayAgain={handlePlayAgain}
        onRetry={session.retry === undefined ? undefined : handleRetry}
      />
    </div>
  );
}
