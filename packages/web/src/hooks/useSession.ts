/**
 * Subscribes a component to a {@link GameSession}.
 *
 * `useSyncExternalStore` keeps React in charge of the subscription lifecycle
 * and guarantees the snapshot is read consistently, which is why the session
 * contract cares about snapshot identity in the first place.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { GameSession, SessionSnapshot } from "../session/types";

/** Current snapshot of the session; re-renders the caller when it changes. */
export function useSession(session: GameSession): SessionSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => session.subscribe(listener),
    [session],
  );
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
