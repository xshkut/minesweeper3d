/**
 * Game clock: starts with the first accepted reveal and stops when the game
 * ends (won or lost). Derived numbers come from {@link formatDuration}.
 */
import { useEffect, useRef, useState } from "react";
import type { ClientGameState } from "@minesweeper3d/game-core";

/** Result of {@link useElapsedTime}. */
export interface ElapsedTime {
  readonly elapsedMs: number;
  /** `true` while the clock runs, i.e. while the game is being played. */
  readonly running: boolean;
}

/** How often the displayed clock is refreshed; the value itself is exact. */
const TICK_MS = 200;

/**
 * Tracks how long the current game has been running.
 *
 * The clock is driven by wall-clock timestamps rather than tick counting, so it
 * stays correct when the tab is throttled or backgrounded.
 *
 * @param state current game state, or `null` while it is still loading
 * @param now injectable clock, for tests
 */
export function useElapsedTime(state: ClientGameState | null, now: () => number = Date.now): ElapsedTime {
  const status = state?.status ?? null;
  const [elapsedMs, setElapsedMs] = useState(0);
  const startedAt = useRef<number | null>(null);
  const stoppedAt = useRef<number | null>(null);

  useEffect(() => {
    if (status === null || status === "ready") {
      startedAt.current = null;
      stoppedAt.current = null;
      setElapsedMs(0);
      return undefined;
    }

    if (status === "playing") {
      stoppedAt.current = null;
      if (startedAt.current === null) startedAt.current = now();
      const tick = (): void => setElapsedMs(now() - (startedAt.current ?? now()));
      tick();
      const handle = setInterval(tick, TICK_MS);
      return () => clearInterval(handle);
    }

    // Won or lost: freeze the clock on the moment the game ended.
    if (startedAt.current === null) {
      setElapsedMs(0);
      return undefined;
    }
    const frozen = stoppedAt.current ?? now();
    stoppedAt.current = frozen;
    setElapsedMs(frozen - startedAt.current);
    return undefined;
  }, [status, now]);

  return { elapsedMs, running: status === "playing" };
}
