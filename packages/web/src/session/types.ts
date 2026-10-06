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
import type { RoomDto } from "./dto";
import type { CursorFeed } from "./presence";

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
  /** Remote rooms only: the room this session is seated in. */
  readonly room?: RoomDto | null;
  /** Remote rooms only: this client's seat id. */
  readonly playerId?: string;
}

/** Options accepted by {@link GameSession.newGame}. */
export interface NewGameOptions {
  readonly presetId?: string;
  readonly seed?: number;
  /** Charges the free-reveal aid grants; `0`, the default, turns it off. */
  readonly freeReveals?: number;
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
  /** Cycles a cell's mark: flag, question mark, then nothing again. */
  cycleMark(cell: CellIndex): void;
  /** Spends a free reveal to learn whether a covered cell hides a mine. */
  probe(cell: CellIndex): void;
  newGame(options?: NewGameOptions): void;
  dispose(): void;
  /**
   * Events of the most recent accepted action, for animation or sound.
   * Optional so alternative session implementations stay compatible.
   */
  readonly lastEvents?: readonly GameEvent[];
  /** Remote only: retry a failed connection attempt. */
  retry?(): void;
  /**
   * Remote rooms only: tells the room which cell this player is pointing at,
   * or that they stopped pointing (`null`).
   *
   * Advisory and best-effort: it is throttled, and a session with nowhere to
   * send it (a private game, a closed socket) simply drops the call.
   */
  setCursor?(cell: CellIndex | null): void;
  /**
   * Remote rooms only: the other seats' pointers, polled by the render loop.
   *
   * Stable for the whole session and mutated in place, so reading it never
   * needs a re-render.
   */
  readonly cursorFeed?: CursorFeed;
}

/** Which backend a session talks to. */
export type SessionMode = "local" | "remote";

/**
 * Session mode used when the URL does not ask for anything else.
 *
 * The server owns the board by default: the cube is authoritative on the Bun
 * process, which is what makes a shared room possible. `?mode=local` opts back
 * into the offline engine (handy for tests and for playing with no backend).
 */
export const DEFAULT_SESSION_MODE: SessionMode = "remote";

/**
 * Reads the session mode from a URL query string.
 *
 * `?mode=local` plays entirely in the browser; anything else (including
 * garbage) uses the server.
 */
export function parseSessionMode(search: string): SessionMode {
  const value = new URLSearchParams(search).get("mode");
  return value === "local" ? "local" : DEFAULT_SESSION_MODE;
}
