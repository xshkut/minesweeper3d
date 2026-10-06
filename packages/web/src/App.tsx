/**
 * Application shell: wires one {@link GameSession} to the HUD and the 3D view.
 *
 * The app holds only interface state (the active tool, reset token, transient
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
import { remoteSeats } from "./session/presence";
import type { PresenceView } from "./session/presence";
import { summarize } from "./session/summary";
import type { GameSession } from "./session/types";
import type { BlockedReason, BoardTool } from "./three/useBoardPointer";
import { GameCanvas } from "./three/GameCanvas";

/** Props of {@link App}. */
export interface AppProps {
  readonly session: GameSession;
  /** Leaves the current room; omitted for offline sessions. */
  readonly onLeave?: (() => void) | undefined;
}

/** How long a transient notice stays on screen. */
const NOTICE_MS = 3200;

/** What the HUD says when the board refuses a click. */
const BLOCKED_NOTICES: Readonly<Record<BlockedReason, string>> = {
  flagged: "That cell is flagged — clear its mark first (Alt+click).",
  buried: "Not exposed yet — dig in from the outside.",
  "no-charges": "No free reveals left on this board.",
  probed: "That cell has already been probed.",
};

/** Root component; the session is created by `main.tsx` (or by a test). */
export function App({ session, onLeave }: AppProps): ReactElement {
  const snapshot = useSession(session);
  const state = snapshot.state;
  const summary = useMemo(() => summarize(state), [state]);
  const elapsed = useElapsedTime(state);

  const [tool, setTool] = useState<BoardTool>("reveal");
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
  const handleSelectTool = useCallback((next: BoardTool) => setTool(next), []);
  const handleResetView = useCallback(() => setResetToken((token) => token + 1), []);
  const handleReveal = useCallback((cell: CellIndex) => session.reveal(cell), [session]);
  const handleMark = useCallback((cell: CellIndex) => session.cycleMark(cell), [session]);
  const handleProbe = useCallback((cell: CellIndex) => session.probe(cell), [session]);
  const handleBlocked = useCallback(
    (_cell: CellIndex, reason: BlockedReason) => showNotice(BLOCKED_NOTICES[reason]),
    [showNotice],
  );
  const handleRetry = useCallback(() => session.retry?.(), [session]);
  const handleCursor = useCallback((cell: CellIndex | null) => session.setCursor?.(cell), [session]);

  useKeyboardShortcuts({ onNewGame: handleNewGame, onSelectTool: handleSelectTool });

  const presetId = state === null ? DEFAULT_PRESET_ID : presetIdForConfig(state.config);
  const freeRevealsLeft = state?.freeRevealsLeft ?? 0;

  // Where the rest of the room is pointing. Rebuilt only when the seating (or
  // the feed itself) changes, never on a pointer frame: the trail polls the feed
  // from the render loop instead.
  const cursorFeed = session.cursorFeed;
  const presence = useMemo<PresenceView | undefined>(() => {
    if (cursorFeed === undefined) return undefined;
    const seats = remoteSeats(snapshot);
    return seats.length === 0 ? undefined : { feed: cursorFeed, seats };
  }, [cursorFeed, snapshot]);

  return (
    <div className="app">
      <GameCanvas
        state={state}
        tool={tool}
        resetToken={resetToken}
        onReveal={handleReveal}
        onMark={handleMark}
        onProbe={handleProbe}
        onBlocked={handleBlocked}
        presence={presence}
        onCursor={session.setCursor === undefined ? undefined : handleCursor}
      />
      <Hud
        snapshot={snapshot}
        summary={summary}
        elapsedMs={elapsed.elapsedMs}
        presetId={presetId}
        tool={tool}
        freeRevealsLeft={freeRevealsLeft}
        notice={notice}
        onNewGame={handleNewGame}
        onSelectPreset={handleSelectPreset}
        onSelectTool={handleSelectTool}
        onResetView={handleResetView}
        onPlayAgain={handlePlayAgain}
        onRetry={session.retry === undefined ? undefined : handleRetry}
        onLeaveRoom={onLeave}
      />
    </div>
  );
}
