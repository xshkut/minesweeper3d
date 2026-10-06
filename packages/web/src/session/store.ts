/**
 * Small glue between the app and the outside world: the automation hook used by
 * the e2e smoke test (and by anyone poking at the app from the console).
 *
 * It can be installed either directly over one session (unit tests) or over the
 * lobby-aware root, which also knows how to create and join a room (e2e).
 */
import { isCellIndex } from "@minesweeper3d/game-core";
import type { CellIndex, MatchMode, RoomVisibility } from "@minesweeper3d/game-core";
import type { RoomJoinDto } from "./dto";
import type { GameSession, NewGameOptions, SessionSnapshot } from "./types";

/** Options accepted by the lobby half of the automation hook. */
export interface AutomationRoomOptions {
  readonly playerName?: string;
  readonly presetId?: string;
  readonly mode?: MatchMode;
  readonly mineCount?: number;
  /** Charges the free-reveal aid grants; `0`, the default, turns it off. */
  readonly freeReveals?: number;
  /** Lets the smoke test create the unlisted kind of room. */
  readonly visibility?: RoomVisibility;
}

/**
 * What the hook needs from the lobby-aware app root.
 *
 * `getSession` returns `null` while the welcome screen is showing.
 */
export interface AutomationSessionSource {
  getSession(): GameSession | null;
  createRoom?(options?: AutomationRoomOptions): Promise<RoomJoinDto | null>;
  joinRoom?(roomId: string, options?: AutomationRoomOptions): Promise<RoomJoinDto | null>;
}

/** Either a live session or something that can produce one. */
export type AutomationTarget = GameSession | AutomationSessionSource;

/** Where one seat of a shared room says it is pointing. */
export interface CursorReading {
  readonly playerId: string;
  /** `null` once that player stopped pointing, or lifted their finger. */
  readonly cell: CellIndex | null;
}

/** Shape installed on `window.__minesweeper3d`. */
export interface MinesweeperAutomationApi {
  /** Current session snapshot; a loading snapshot while in the lobby. */
  snapshot(): SessionSnapshot;
  /**
   * Where the *other* seats of the room point, as last reported by the server.
   *
   * A copy, not the live feed: it is read from outside the app (a test, the
   * console) and the feed is mutated on every pointer frame.
   */
  cursors(): readonly CursorReading[];
  /** Reveals a cell (ignored by the engine when the move is illegal). */
  reveal(cell: CellIndex): void;
  /** Cycles a covered cell's mark: flag, question mark, then nothing again. */
  cycleMark(cell: CellIndex): void;
  /** Spends a free reveal to learn whether a covered cell hides a mine. */
  probe(cell: CellIndex): void;
  /** Starts a new game, optionally on another preset and with its own options. */
  newGame(presetId?: string, options?: NewGameOptions): void;
  /** Lobby: creates a room and enters its game. */
  createRoom(options?: AutomationRoomOptions): Promise<RoomJoinDto | null>;
  /** Lobby: joins an existing room and enters its game. */
  joinRoom(roomId: string, options?: AutomationRoomOptions): Promise<RoomJoinDto | null>;
}

declare global {
  interface Window {
    __minesweeper3d?: MinesweeperAutomationApi;
  }
}

/** A snapshot for "no game yet", so lobby callers never see `undefined`. */
const LOBBY_SNAPSHOT: SessionSnapshot = { kind: "remote", phase: "loading", state: null };

/**
 * Publishes a session (or a session source) on `scope.__minesweeper3d`.
 *
 * Coordinates coming from the outside are validated so a typo in a test or in
 * the console cannot push garbage into the rules engine.
 *
 * @returns an uninstall function that removes the hook again
 */
export function installAutomationHook(target: AutomationTarget, scope: Window = window): () => void {
  const source: AutomationSessionSource = "getSession" in target ? target : { getSession: () => target };

  const api: MinesweeperAutomationApi = {
    snapshot: () => source.getSession()?.getSnapshot() ?? LOBBY_SNAPSHOT,
    cursors: () => {
      const feed = source.getSession()?.cursorFeed;
      if (feed === undefined) return [];
      return [...feed.cursors.values()].map(({ playerId, cell }) => ({ playerId, cell }));
    },
    reveal: (cell) => {
      if (isCellIndex(cell)) source.getSession()?.reveal(cell);
    },
    cycleMark: (cell) => {
      if (isCellIndex(cell)) source.getSession()?.cycleMark(cell);
    },
    probe: (cell) => {
      if (isCellIndex(cell)) source.getSession()?.probe(cell);
    },
    newGame: (presetId, options) => {
      const requested = { ...options, ...(presetId === undefined ? {} : { presetId }) };
      source.getSession()?.newGame(requested);
    },
    createRoom: async (options) => (source.createRoom === undefined ? null : source.createRoom(options)),
    joinRoom: async (roomId, options) =>
      source.joinRoom === undefined ? null : source.joinRoom(roomId, options),
  };

  scope.__minesweeper3d = api;
  return () => {
    if (scope.__minesweeper3d === api) delete scope.__minesweeper3d;
  };
}
