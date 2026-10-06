/**
 * In-browser session: runs the pure rules engine directly, no server involved.
 *
 * This is the default mode, which is why the client works offline and in the
 * e2e smoke test with no backend at all.
 */
import {
  DEFAULT_PRESET_ID,
  createGame,
  cycleMark,
  presetConfig,
  probeCell,
  revealCell,
  toClientView,
} from "@minesweeper3d/game-core";
import type { CellIndex, GameEvent, GameState } from "@minesweeper3d/game-core";
import type { GameSession, NewGameOptions, SessionSnapshot } from "./types";

/** Options accepted by {@link createLocalSession}. */
export interface LocalSessionOptions {
  readonly presetId?: string;
  readonly seed?: number;
  readonly firstRevealSafe?: boolean;
  /** Charges the free-reveal aid grants; `0`, the default, turns it off. */
  readonly freeReveals?: number;
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

  /** Applies one pure transition, ignoring the identical state of a no-op. */
  function apply(
    action: (state: GameState, cell: CellIndex) => { state: GameState; events: readonly GameEvent[] },
    cell: CellIndex,
  ): void {
    if (disposed) return;
    const transition = action(game, cell);
    if (transition.state === game) return;
    game = transition.state;
    events = transition.events;
    error = undefined;
    notify();
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
      // Reveals go through `apply` too; the engine returns the very same state
      // for an ignored action, which is what keeps a stray click cheap.
      apply(revealCell, cell);
    },

    cycleMark(cell: CellIndex): void {
      apply(cycleMark, cell);
    },

    probe(cell: CellIndex): void {
      apply(probeCell, cell);
    },

    newGame(next: NewGameOptions = {}): void {
      if (disposed) return;
      const requested = next.presetId ?? presetId;
      // A new board gets a fresh budget, but a caller that says nothing keeps
      // whatever this session was told to play with.
      const freeReveals = next.freeReveals ?? options.freeReveals;
      const nextOptions: LocalSessionOptions = {
        ...(next.seed === undefined ? {} : { seed: next.seed }),
        ...(freeReveals === undefined ? {} : { freeReveals }),
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
  options: { seed?: number; firstRevealSafe?: boolean; freeReveals?: number },
  onFailure: FailureReporter,
): StartedGame {
  const build = (id: string): GameState =>
    createGame(
      presetConfig(id, {
        ...(options.seed === undefined ? {} : { seed: options.seed }),
        ...(options.firstRevealSafe === undefined ? {} : { firstRevealSafe: options.firstRevealSafe }),
        ...(options.freeReveals === undefined ? {} : { freeReveals: options.freeReveals }),
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
