/**
 * Session factory: picks the local engine or the remote server.
 *
 * Default is local, so the client is fully playable without a backend;
 * `?mode=remote` switches to the authoritative server.
 */
import { createLocalSession } from "./local";
import type { LocalSessionOptions } from "./local";
import { createRemoteSession } from "./remote";
import type { RemoteSessionDeps } from "./remote";
import { parseSessionMode } from "./types";
import type { GameSession, SessionMode } from "./types";

/** Options accepted by {@link createSession}. */
export interface CreateSessionOptions extends LocalSessionOptions {
  /** Overrides the mode that would be read from the URL. */
  readonly mode?: SessionMode;
  /** Query string to read the mode from; defaults to the current location. */
  readonly search?: string;
  /** Injectable network primitives for the remote session (tests). */
  readonly deps?: RemoteSessionDeps;
}

/**
 * Creates the session described by the current URL.
 *
 * Unknown query strings and modes degrade to local play rather than failing.
 */
export function createSession(options: CreateSessionOptions = {}): GameSession {
  const mode = options.mode ?? parseSessionMode(options.search ?? currentSearch());
  const shared: LocalSessionOptions = {
    ...(options.presetId === undefined ? {} : { presetId: options.presetId }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.firstRevealSafe === undefined ? {} : { firstRevealSafe: options.firstRevealSafe }),
  };

  if (mode === "remote") {
    return createRemoteSession({
      ...shared,
      ...(options.deps === undefined ? {} : { deps: options.deps }),
    });
  }
  return createLocalSession(shared);
}

function currentSearch(): string {
  return typeof location === "undefined" ? "" : location.search;
}
