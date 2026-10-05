/**
 * Tiny external store describing whether the 3D scene is ready to be shown.
 *
 * r3f v9 no longer ships `useProgress`, and the loading overlay lives in the
 * DOM while the assets are loaded inside the canvas (a different React root),
 * so both sides meet in this module-level store.
 */

/** What the loading overlay needs to know. */
export interface LoadingState {
  /** Number of asset groups currently suspended. */
  readonly pending: number;
  /** `true` once the first board frame has been rendered. */
  readonly ready: boolean;
}

/** Observable store created by {@link createLoadingStore}. */
export interface LoadingStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): LoadingState;
  /** Marks one asset group as loading. */
  begin(): void;
  /** Marks one asset group as done. */
  end(): void;
  /** Called by the board once it rendered its first frame. */
  markReady(): void;
  /** Returns the store to its initial state (used when the app remounts). */
  reset(): void;
}

/** Creates an isolated store; the app uses one module-level instance. */
export function createLoadingStore(): LoadingStore {
  const listeners = new Set<() => void>();
  let state: LoadingState = { pending: 0, ready: false };

  function publish(next: LoadingState): void {
    if (next.pending === state.pending && next.ready === state.ready) return;
    state = next;
    for (const listener of [...listeners]) listener();
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot() {
      return state;
    },
    begin() {
      publish({ pending: state.pending + 1, ready: state.ready });
    },
    end() {
      // Clamped: a mismatched end() must never hide the overlay for real work.
      publish({ pending: Math.max(0, state.pending - 1), ready: state.ready });
    },
    markReady() {
      publish({ pending: state.pending, ready: true });
    },
    reset() {
      publish({ pending: 0, ready: false });
    },
  };
}

/** Store shared by the canvas and the DOM overlay. */
export const sceneLoading = createLoadingStore();
