/**
 * Where the game lives: the local engine or the server, including the reason a
 * remote session failed.
 */
import type { ReactElement } from "react";
import type { SessionSnapshot } from "../session/types";

/** Props of {@link ConnectionBadge}. */
export interface ConnectionBadgeProps {
  readonly snapshot: SessionSnapshot;
  /** Present for remote sessions that can be retried. */
  readonly onRetry?: (() => void) | undefined;
}

/** Mode badge plus the error text of a failed session. */
export function ConnectionBadge({ snapshot, onRetry }: ConnectionBadgeProps): ReactElement {
  const remote = snapshot.kind === "remote";
  const state =
    snapshot.phase === "error"
      ? "offline"
      : remote
        ? snapshot.connected === true
          ? "connected"
          : "connecting"
        : "offline mode";

  return (
    <div className="connection" data-testid="connection-badge" data-state={state}>
      <span className={`connection__dot connection__dot--${dotClass(state)}`} aria-hidden="true" />
      <span className="connection__label">
        {remote ? "Server" : "Local game"}
        {remote ? ` — ${state}` : ""}
      </span>
      {snapshot.error !== undefined && (
        <p className="connection__error" role="alert" data-testid="connection-error">
          {snapshot.error}
        </p>
      )}
      {snapshot.phase === "error" && onRetry !== undefined && (
        <button type="button" className="button button--ghost" data-testid="connection-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

function dotClass(state: string): string {
  if (state === "connected") return "ok";
  if (state === "offline") return "bad";
  return "idle";
}
