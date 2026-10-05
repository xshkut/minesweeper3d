/**
 * In-browser session: runs the pure rules engine directly, no server involved.
 *
 * This is the default mode, which is why the client works offline and in the
 * e2e smoke test with no backend at all.
 */
import {
  DEFAULT_PRESET_ID,
  createGame,
  presetConfig,
  revealCell,
  toClientView,
  toggleFlag,
} from "@minesweeper3d/game-core";
import type { CellIndex, GameEvent, GameState } from "@minesweeper3d/game-core";
import type { GameSession, NewGameOptions, SessionSnapshot } from "./types";

/** Options accepted by {@link createLocalSession}. */
export interface LocalSessionOptions {
  readonly presetId?: string;
  readonly seed?: number;
  readonly firstRevealSafe?: boolean;
}

/**
 * Creates a session backed by the pure engine.
 *
 * Actions are applied synchronously and the snapshot object is only replaced
 * when the engine accepted the action, so ignored reveals never re-render.
 */
export function createLocalSession(options: LocalSessionOptions = {}): GameSession {
  const listeners = new Set<() => void>();
  let disposed = false;
  let events: readonly GameEvent[] = [];
  let error: string | undefined;
  let presetId = options.presetId ?? DEFAULT_PRESET_ID;
  const initial = startGame(presetId, options, fail);
  let game = initial.state;
  if (!initial.ok) presetId = DEFAULT_PRESET_ID;
  let snapshot = composeSnapshot();

  function fail(message: string): void {
    error = message;
  }

  function composeSnapshot(): SessionSnapshot {
    return {
      kind: "local",
      phase: "ready",
      state: toClientView(game),
      ...(error === undefined ? {} : { error }),
    };
  }

  function notify(): void {
    snapshot = composeSnapshot();
    for (const listener of [...listeners]) listener();
  }

  return {
    kind: "local",

    getSnapshot(): SessionSnapshot {
      return snapshot;
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    reveal(cell: CellIndex): void {
      if (disposed) return;
      const transition = revealCell(game, cell);
      // The engine returns the very same state for ignored actions.
      if (transition.state === game) return;
      game = transition.state;
      events = transition.events;
      error = undefined;
      notify();
    },

    toggleFlag(cell: CellIndex): void {
      if (disposed) return;
      const transition = toggleFlag(game, cell);
      if (transition.state === game) return;
      game = transition.state;
      events = transition.events;
      error = undefined;
      notify();
    },

    newGame(next: NewGameOptions = {}): void {
      if (disposed) return;
      const requested = next.presetId ?? presetId;
      const nextOptions: LocalSessionOptions = {
        ...(next.seed === undefined ? {} : { seed: next.seed }),
        ...(options.firstRevealSafe === undefined ? {} : { firstRevealSafe: options.firstRevealSafe }),
      };
      error = undefined;
      const started = startGame(requested, nextOptions, fail);
      if (started.ok) presetId = requested;
      game = started.state;
      events = [];
      notify();
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
    },

    get lastEvents(): readonly GameEvent[] {
      return events;
    },
  };
}

type FailureReporter = (message: string) => void;

/** A freshly built game plus whether the requested preset was usable. */
interface StartedGame {
  readonly state: GameState;
  readonly ok: boolean;
}

/**
 * Builds a fresh game from a preset id.
 *
 * An unknown preset (only reachable through the automation hook or a hand
 * written link) falls back to a usable board and reports the reason instead of
 * throwing into a click handler.
 */
function startGame(
  presetId: string,
  options: { seed?: number; firstRevealSafe?: boolean },
  onFailure: FailureReporter,
): StartedGame {
  const build = (id: string): GameState =>
    createGame(
      presetConfig(id, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.firstRevealSafe === undefined ? {} : { firstRevealSafe: options.firstRevealSafe }),
      }),
    );

  try {
    return { state: build(presetId), ok: true };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    onFailure(`${message}; falling back to "${DEFAULT_PRESET_ID}"`);
    return { state: build(DEFAULT_PRESET_ID), ok: false };
  }
}
