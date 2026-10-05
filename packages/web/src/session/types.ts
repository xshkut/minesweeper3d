/**
 * The contract between the UI and whatever produces game state.
 *
 * Two implementations exist: {@link createLocalSession} runs the pure
 * `@minesweeper3d/game-core` engine in the browser, {@link createRemoteSession}
 * talks to the Bun server. Everything above this layer (hooks, HUD, 3D scene)
 * only ever sees {@link GameSession}, which keeps local play working with no
 * server at all.
 */
import type { CellIndex, ClientGameState, GameEvent } from "@minesweeper3d/game-core";

/** Immutable view of a session, safe to hand to `useSyncExternalStore`. */
export interface SessionSnapshot {
  readonly kind: "local" | "remote";
  readonly phase: "loading" | "ready" | "error";
  /** Redacted game state; `null` until the first state arrives. */
  readonly state: ClientGameState | null;
  /** Human readable failure reason, present when something went wrong. */
  readonly error?: string;
  /** Remote only: `true` while the realtime socket is open. */
  readonly connected?: boolean;
}

/** Options accepted by {@link GameSession.newGame}. */
export interface NewGameOptions {
  readonly presetId?: string;
  readonly seed?: number;
}

/**
 * A live game. All mutating methods are fire-and-forget: results arrive back
 * through {@link GameSession.subscribe} and {@link GameSession.getSnapshot}.
 *
 * Implementations must keep the snapshot reference stable between changes so
 * React can skip re-renders.
 */
export interface GameSession {
  readonly kind: "local" | "remote";
  getSnapshot(): SessionSnapshot;
  subscribe(listener: () => void): () => void;
  reveal(cell: CellIndex): void;
  toggleFlag(cell: CellIndex): void;
  newGame(options?: NewGameOptions): void;
  dispose(): void;
  /**
   * Events of the most recent accepted action, for animation or sound.
   * Optional so alternative session implementations stay compatible.
   */
  readonly lastEvents?: readonly GameEvent[];
  /** Remote only: retry a failed connection attempt. */
  retry?(): void;
}

/** Which backend a session talks to. */
export type SessionMode = "local" | "remote";

/** Session mode used when the URL does not ask for anything else. */
export const DEFAULT_SESSION_MODE: SessionMode = "local";

/**
 * Reads the session mode from a URL query string.
 *
 * `?mode=remote` opts into the server; anything else (including garbage) keeps
 * the client fully offline.
 */
export function parseSessionMode(search: string): SessionMode {
  const value = new URLSearchParams(search).get("mode");
  return value === "remote" ? "remote" : DEFAULT_SESSION_MODE;
}
