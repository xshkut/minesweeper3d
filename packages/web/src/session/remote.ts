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
import {
  describeError,
  parseErrorMessage,
  parseEvents,
  parseGameEnvelope,
  parseRoomEnvelope,
  parseServerMessage,
} from "./dto";
import type { GameDto, RoomDto, RoomJoinDto } from "./dto";
import { applyCursor, createCursorFeed, forgetCursors, sameCell } from "./presence";
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
  /** Charges the free-reveal aid grants; `0`, the default, turns it off. */
  readonly freeReveals?: number;
  /**
   * Attach to a room that already exists instead of creating a private game.
   *
   * The value is exactly what `POST /api/rooms` (or `/join`) returned, so the
   * socket can be opened with the player's seat id attached.
   */
  readonly room?: RoomJoinDto;
  readonly deps?: RemoteSessionDeps;
}

/**
 * Shortest gap between two pointer frames.
 *
 * A pointer is a hint, not an action, and it shares one socket with the moves
 * that do matter, so it is throttled to roughly a display frame.
 */
const CURSOR_MIN_GAP_MS = 70;

/** Every action maps to both a socket frame type and an HTTP path segment. */
type ActionKind = "reveal" | "mark" | "probe";
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
  /**
   * Where the other seats are pointing.
   *
   * Mutated in place and polled by the render loop, never put in the snapshot:
   * a pointer frame arrives at mouse speed and must not re-render the HUD.
   */
  const cursorFeed = createCursorFeed();
  let presetId = options.presetId ?? DEFAULT_PRESET_ID;
  let seed = options.seed;
  let freeReveals = options.freeReveals;
  let generation = 0;
  let gameId: string | null = options.room?.game.id ?? null;
  let roomId: string | null = options.room?.room.id ?? null;
  let playerId: string | null = options.room?.player.id ?? null;
  let room: RoomDto | null = options.room?.room ?? null;
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

  /** Latest pointer this player wants the room to see; `null` means "stopped". */
  let cursorWanted: CellIndex | null = null;
  let cursorRequested = false;
  let cursorSentAt = 0;
  let cursorTimer: ReturnType<typeof setTimeout> | null = null;

  function composeSnapshot(): SessionSnapshot {
    return {
      kind: "remote",
      phase,
      state,
      connected,
      room,
      ...(playerId === null ? {} : { playerId }),
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

  function applyRoom(next: RoomDto): void {
    room = next;
    roomId = next.id;
    if (next.gameId !== "") gameId = next.gameId;
    // The seating is the only thing that says who is still here: a player who
    // left never gets to clear their own pointer.
    const seated = new Set(next.players.map((player) => player.id));
    forgetCursors(cursorFeed, (id) => id === playerId || seated.has(id));
  }

  /**
   * Restarts the shared board of the attached room.
   *
   * Without a preset the server clones the current configuration, so "New game"
   * keeps the board size while a preset change resizes it for everyone.
   */
  async function restart(preset: string | undefined): Promise<void> {
    const id = roomId;
    if (id === null) return;
    const token = (generation += 1);
    pending.length = 0;
    events = [];
    phase = "loading";
    notify();

    try {
      const response = await doFetch(apiUrl(`/api/rooms/${encodeURIComponent(id)}/restart`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(preset === undefined ? {} : { presetId: preset }),
      });
      const payload: unknown = await readJson(response);
      if (!response.ok) throw new Error(parseErrorMessage(payload) ?? `server responded with ${response.status}`);
      if (disposed || token !== generation) return;

      const envelope = parseRoomEnvelope(payload);
      applyRoom(envelope.room);
      applyGame(envelope.game);
      setError(undefined);
      notify();
      openSocketFor(envelope.game.id);
    } catch (cause) {
      if (disposed || token !== generation) return;
      // Keep the old board on screen: only the restart failed.
      phase = state === null ? "error" : "ready";
      setError(describeError(cause, "Could not restart the room board"));
      notify();
    }
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
          ...(freeReveals === undefined ? {} : { freeReveals }),
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
        if (message.type === "welcome") {
          if (message.room !== undefined) applyRoom(message.room);
          if (message.playerId !== undefined) playerId = message.playerId;
        } else {
          // A race sends every player's board on the room channel; only the one
          // carrying our seat is ours to draw. Without a `board` the update is
          // the board the room shares, so it belongs to everybody.
          if (message.board !== undefined && message.board !== playerId) break;
          events = message.events;
        }
        applyGame(message.game);
        setError(undefined);
        notify();
        break;
      case "room":
        applyRoom(message.room);
        setError(undefined);
        notify();
        break;
      case "cursor":
        // No notify(): the trail reads the feed from the render loop, so a
        // pointer of another player never costs a React render.
        if (message.playerId !== playerId) applyCursor(cursorFeed, message.playerId, message.cell);
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
    const ws = base.replace(/^http/, "ws");
    if (roomId !== null) {
      const query = playerId === null ? "" : `?player=${encodeURIComponent(playerId)}`;
      return `${ws}/api/rooms/${encodeURIComponent(roomId)}/ws${query}`;
    }
    return `${ws}/api/games/${encodeURIComponent(id)}/ws`;
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

  /**
   * Publishes this player's pointer to the room.
   *
   * Throttled to one frame per {@link CURSOR_MIN_GAP_MS}, with the movement
   * inside that gap coalesced into a trailing frame so the pointer always ends
   * up where the player left it. Nothing is queued across a closed socket: the
   * next movement re-announces it, and a stale pointer is worse than none.
   */
  function setCursor(cell: CellIndex | null): void {
    if (disposed || roomId === null) return;
    const next = cell === null ? null : { x: cell.x, y: cell.y, z: cell.z };
    if (cursorRequested && sameCell(cursorWanted, next)) return;

    cursorWanted = next;
    cursorRequested = true;
    if (cursorTimer !== null) return;

    const wait = CURSOR_MIN_GAP_MS - (Date.now() - cursorSentAt);
    if (wait <= 0) {
      flushCursor();
      return;
    }
    cursorTimer = setTimeout(() => {
      cursorTimer = null;
      flushCursor();
    }, wait);
  }

  function flushCursor(): void {
    if (disposed || !cursorRequested || !socketOpen || socket === null) return;
    socket.send(JSON.stringify({ type: "cursor", cell: cursorWanted }));
    cursorSentAt = Date.now();
  }

  function cancelCursor(): void {
    if (cursorTimer !== null) {
      clearTimeout(cursorTimer);
      cursorTimer = null;
    }
  }

  // A private game is created eagerly (`POST /api/games`); an attached room is
  // already live, so the session only has to join its realtime channel.
  if (options.room === undefined) {
    void bootstrap();
  } else {
    applyGame(options.room.game);
    notify();
    openSocketFor(options.room.game.id);
  }

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

    cycleMark(cell: CellIndex): void {
      if (disposed) return;
      if (gameId === null) {
        queue({ kind: "mark", cell });
        return;
      }
      dispatch("mark", cell);
    },

    probe(cell: CellIndex): void {
      if (disposed) return;
      if (gameId === null) {
        queue({ kind: "probe", cell });
        return;
      }
      dispatch("probe", cell);
    },

    newGame(next: NewGameOptions = {}): void {
      if (disposed) return;
      if (roomId !== null) {
        void restart(next.presetId);
        return;
      }
      presetId = next.presetId ?? presetId;
      seed = next.seed;
      // A fresh board means a fresh budget, unless the caller keeps the old one.
      if (next.freeReveals !== undefined) freeReveals = next.freeReveals;
      pending.length = 0;
      events = [];
      cancelReconnect();
      closeSocket();
      gameId = null;
      void bootstrap();
    },

    retry(): void {
      if (disposed) return;
      if (roomId !== null) {
        if (gameId === null) return;
        setError(undefined);
        openSocketFor(gameId);
        return;
      }
      if (phase !== "error") return;
      cancelReconnect();
      void bootstrap();
    },

    dispose(): void {
      disposed = true;
      cancelReconnect();
      cancelCursor();
      closeSocket();
      listeners.clear();
      pending.length = 0;
    },

    setCursor,

    get cursorFeed() {
      return cursorFeed;
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
