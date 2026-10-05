/**
 * Server-backed session.
 *
 * The game lives on the Bun server: actions travel over the WebSocket when it
 * is open (low latency, server-pushed updates) and over plain HTTP otherwise.
 * When the server cannot be reached at all the session parks in
 * `phase: "error"` with a readable message so the HUD can explain what
 * happened instead of showing a dead board.
 */
import { DEFAULT_PRESET_ID } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState, GameEvent } from "@minesweeper3d/game-core";
import { describeError, parseErrorMessage, parseEvents, parseGameEnvelope, parseServerMessage } from "./dto";
import type { GameDto } from "./dto";
import type { GameSession, NewGameOptions, SessionSnapshot } from "./types";

/** The slice of `WebSocket` the session needs; injectable for tests. */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onOpen: (() => void) | null;
  onMessage: ((data: string) => void) | null;
  onClose: (() => void) | null;
  onError: ((error: unknown) => void) | null;
}

/** The slice of `fetch` the session uses; injectable for tests. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Injectable side effects so the session can be tested without a network. */
export interface RemoteSessionDeps {
  /** Defaults to the global `fetch`. */
  readonly fetch?: FetchLike;
  /** Defaults to a small adapter around the global `WebSocket`. */
  readonly openSocket?: (url: string) => SocketLike;
  /** Origin of the API, e.g. `http://localhost:8000`; empty means same origin. */
  readonly baseUrl?: string;
  /** First reconnect delay; doubles per failed attempt. Defaults to 300 ms. */
  readonly reconnectBaseMs?: number;
  /** Upper bound for the reconnect delay. Defaults to 5000 ms. */
  readonly maxReconnectMs?: number;
}

/** Options accepted by {@link createRemoteSession}. */
export interface RemoteSessionOptions {
  readonly presetId?: string;
  readonly seed?: number;
  readonly firstRevealSafe?: boolean;
  readonly deps?: RemoteSessionDeps;
}

type ActionKind = "reveal" | "flag";
interface PendingAction {
  readonly kind: ActionKind;
  readonly cell: CellIndex;
}

/**
 * Creates a session that mirrors a game hosted by the server.
 *
 * The game is created eagerly (the constructor kicks off `POST /api/games`) so
 * the board is ready as soon as the first render happens.
 */
export function createRemoteSession(options: RemoteSessionOptions = {}): GameSession {
  const deps = options.deps ?? {};
  const doFetch: FetchLike =
    deps.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const openSocket = deps.openSocket ?? browserSocket;
  const baseUrl = (deps.baseUrl ?? "").replace(/\/+$/, "");
  const reconnectBaseMs = deps.reconnectBaseMs ?? 300;
  const maxReconnectMs = deps.maxReconnectMs ?? 5000;

  const listeners = new Set<() => void>();
  const pending: PendingAction[] = [];
  let presetId = options.presetId ?? DEFAULT_PRESET_ID;
  let seed = options.seed;
  let generation = 0;
  let gameId: string | null = null;
  let socket: SocketLike | null = null;
  let socketOpen = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let disposed = false;
  let phase: SessionSnapshot["phase"] = "loading";
  let state: ClientGameState | null = null;
  let error: string | undefined;
  let connected = false;
  let events: readonly GameEvent[] = [];
  let snapshot = composeSnapshot();

  function composeSnapshot(): SessionSnapshot {
    return {
      kind: "remote",
      phase,
      state,
      connected,
      ...(error === undefined ? {} : { error }),
    };
  }

  function notify(): void {
    snapshot = composeSnapshot();
    for (const listener of [...listeners]) listener();
  }

  function setError(message: string | undefined): void {
    error = message;
  }

  function applyGame(game: GameDto): void {
    gameId = game.id;
    state = game.state;
    phase = "ready";
  }

  async function bootstrap(): Promise<void> {
    const token = (generation += 1);
    phase = "loading";
    state = null;
    connected = false;
    notify();

    try {
      const response = await doFetch(apiUrl("/api/games"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          presetId,
          ...(seed === undefined ? {} : { seed }),
          ...(options.firstRevealSafe === undefined ? {} : { firstRevealSafe: options.firstRevealSafe }),
        }),
      });
      const payload: unknown = await readJson(response);
      if (!response.ok) throw new Error(parseErrorMessage(payload) ?? `server responded with ${response.status}`);

      const game = parseGameEnvelope(payload);
      if (disposed || token !== generation) return;
      applyGame(game);
      setError(undefined);
      notify();
      openSocketFor(game.id);
      flushPending();
    } catch (cause) {
      if (disposed || token !== generation) return;
      phase = "error";
      state = null;
      setError(describeError(cause, `Cannot reach the game server at ${displayBase()}`));
      notify();
    }
  }

  function flushPending(): void {
    const queued = pending.splice(0, pending.length);
    for (const action of queued) dispatch(action.kind, action.cell);
  }

  function dispatch(kind: ActionKind, cell: CellIndex): void {
    if (socketOpen && socket !== null) {
      socket.send(JSON.stringify({ type: kind, cell }));
      return;
    }
    void postAction(kind, cell);
  }

  async function postAction(kind: ActionKind, cell: CellIndex): Promise<void> {
    const id = gameId;
    if (id === null) return;
    try {
      const response = await doFetch(apiUrl(`/api/games/${encodeURIComponent(id)}/${kind}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cell }),
      });
      const payload: unknown = await readJson(response);
      if (!response.ok) throw new Error(parseErrorMessage(payload) ?? `server responded with ${response.status}`);
      if (disposed) return;

      applyGame(parseGameEnvelope(payload));
      events = parseEvents(asRecord(payload)?.["events"]);
      setError(undefined);
      notify();
    } catch (cause) {
      if (disposed) return;
      // The game itself stays playable; only the action failed.
      setError(describeError(cause, `Could not send the ${kind} to the server`));
      notify();
    }
  }

  function openSocketFor(id: string): void {
    closeSocket();
    let next: SocketLike;
    try {
      next = openSocket(socketUrl(id));
    } catch (cause) {
      setError(describeError(cause, "Live updates are unavailable"));
      notify();
      return;
    }

    socket = next;
    next.onOpen = () => {
      if (disposed || socket !== next) return;
      socketOpen = true;
      connected = true;
      reconnectAttempt = 0;
      setError(undefined);
      notify();
    };
    next.onMessage = (data) => {
      if (disposed || socket !== next) return;
      handleMessage(data);
    };
    next.onClose = () => {
      if (disposed || socket !== next) return;
      socketOpen = false;
      connected = false;
      socket = null;
      notify();
      scheduleReconnect();
    };
    next.onError = () => {
      if (disposed || socket !== next) return;
      socketOpen = false;
      connected = false;
      notify();
    };
  }

  function handleMessage(raw: string): void {
    const message = parseServerMessage(raw);
    if (message === null) return;

    switch (message.type) {
      case "welcome":
      case "update":
        applyGame(message.game);
        if (message.type === "update") events = message.events;
        setError(undefined);
        notify();
        break;
      case "error":
        setError(`${message.code}: ${message.message}`);
        notify();
        break;
      case "pong":
        break;
    }
  }

  function scheduleReconnect(): void {
    if (disposed || gameId === null || reconnectTimer !== null) return;
    const delay = Math.min(maxReconnectMs, reconnectBaseMs * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!disposed && gameId !== null) openSocketFor(gameId);
    }, delay);
  }

  function closeSocket(): void {
    const current = socket;
    socket = null;
    socketOpen = false;
    connected = false;
    if (current !== null) {
      current.onOpen = null;
      current.onMessage = null;
      current.onClose = null;
      current.onError = null;
      try {
        current.close();
      } catch {
        // A socket that refuses to close must not break the session.
      }
    }
  }

  function cancelReconnect(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /** Joins the configured origin with an API path. */
  function apiUrl(path: string): string {
    return `${baseUrl}${path}`;
  }

  function socketUrl(id: string): string {
    const base = baseUrl === "" ? defaultOrigin() : baseUrl;
    return `${base.replace(/^http/, "ws")}/api/games/${encodeURIComponent(id)}/ws`;
  }

  function displayBase(): string {
    return baseUrl === "" ? defaultOrigin() : baseUrl;
  }

  function queue(action: PendingAction): void {
    // A click that arrives before the board exists is worth remembering; more
    // than a handful means something is wrong, so the oldest are dropped.
    if (pending.length >= 16) pending.shift();
    pending.push(action);
  }

  void bootstrap();

  return {
    kind: "remote",

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
      if (gameId === null) {
        queue({ kind: "reveal", cell });
        return;
      }
      dispatch("reveal", cell);
    },

    toggleFlag(cell: CellIndex): void {
      if (disposed) return;
      if (gameId === null) {
        queue({ kind: "flag", cell });
        return;
      }
      dispatch("flag", cell);
    },

    newGame(next: NewGameOptions = {}): void {
      if (disposed) return;
      presetId = next.presetId ?? presetId;
      seed = next.seed;
      pending.length = 0;
      events = [];
      cancelReconnect();
      closeSocket();
      gameId = null;
      void bootstrap();
    },

    retry(): void {
      if (disposed || phase !== "error") return;
      cancelReconnect();
      void bootstrap();
    },

    dispose(): void {
      disposed = true;
      cancelReconnect();
      closeSocket();
      listeners.clear();
      pending.length = 0;
    },

    get lastEvents(): readonly GameEvent[] {
      return events;
    },
  };
}

/** Adapts the global `WebSocket` to {@link SocketLike}. */
export function browserSocket(url: string): SocketLike {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is not available in this environment");
  }
  const socket = new WebSocket(url);
  const adapter: SocketLike = {
    send: (data) => socket.send(data),
    close: () => socket.close(),
    onOpen: null,
    onMessage: null,
    onClose: null,
    onError: null,
  };
  socket.onopen = () => adapter.onOpen?.();
  socket.onmessage = (event: MessageEvent) => {
    adapter.onMessage?.(typeof event.data === "string" ? event.data : String(event.data));
  };
  socket.onclose = () => adapter.onClose?.();
  socket.onerror = (event: Event) => adapter.onError?.(event);
  return adapter;
}

/** Origin used when the session is not pinned to an explicit base URL. */
function defaultOrigin(): string {
  return typeof location === "undefined" || location.origin === "null" ? "http://localhost" : location.origin;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}
