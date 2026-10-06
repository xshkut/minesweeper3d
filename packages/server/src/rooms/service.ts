/**
 * The room service: the only place that mutates rooms.
 *
 * It is a thin multiplayer shell around the games module. A room owns the boards
 * of its round (created through {@link GameService}, so the board rules stay in
 * one place), tracks who is seated and how the round is going, and fans changes
 * out to subscribers - the seam the realtime layer plugs into. Games are
 * untouched by this module: it only remembers which ones the room is playing.
 *
 * A mode is a rule for turning board outcomes into match outcomes:
 *
 * - **co-op** shares one cube and races a countdown. The clock starts on the
 *   first reveal, not on creation, so a slow joiner does not lose time before
 *   they can see the board. Clear every safe cell before it runs out.
 * - **race** gives every player their own `createGame(room.config)`, i.e. the
 *   same cube. The first player to clear theirs wins and the round stops.
 * - **survival** shares one cube full of mines, played with `minesFatal: false`:
 *   opening a mine spends that one cell instead of ending the board, and costs
 *   the player who opened it. The last player still in wins.
 *
 * Every reveal and flag therefore goes through this service rather than straight
 * to the games module - only the room knows who acted, and survival cannot be
 * scored without that. The board update it produces carries the actor, which is
 * what the realtime layer broadcasts.
 *
 * Everything is in memory by construction: storage, ids, the clock, the timers
 * and the room code generator are injected, so the service is deterministic
 * under test and a database-backed store can replace the map without touching
 * the handlers.
 */
import {
  DEFAULT_MATCH_MODE,
  DEFAULT_PRESET_ID,
  DEFAULT_ROOM_VISIBILITY,
  DEFAULT_RULES,
  DIFFICULTIES,
  GAME_PRESETS,
  ROOM_VISIBILITIES,
  coopTimeLimitMs,
  defaultDifficultyForMode,
  difficultyOf,
  findPreset,
  hasEliminations,
  isDifficultyId,
  isMatchMode,
  isRoomVisibility,
  maxMineCount,
  mineCountFor,
  randomSeed,
  sharesBoard,
  usesClock,
  validateGameConfig,
} from "@minesweeper3d/game-core";
import type {
  CellIndex,
  DifficultyId,
  GameConfig,
  GameEvent,
  MatchMode,
  MatchStatus,
  RoomVisibility,
  Vec3,
} from "@minesweeper3d/game-core";
import type { Logger } from "../logger";
import { InvalidGameRequestError } from "../games/errors";
import { isRecord } from "../games/requests";
import type { GameService } from "../games/service";
import type { StoredGame } from "../games/store";
import {
  InvalidRoomRequestError,
  PlayerNotInRoomError,
  RoomFullError,
  RoomNotFoundError,
  RoomServiceClosedError,
} from "./errors";
import { boardIdsOf } from "./store";
import type { PlayerRecord, RoomRecord, RoomStore } from "./store";

/** Players a room holds unless configured otherwise. */
export const DEFAULT_MAX_PLAYERS = 8;
/** Longest accepted player name. */
export const MAX_PLAYER_NAME_LENGTH = 24;
/** Longest accepted room name. */
export const MAX_ROOM_NAME_LENGTH = 40;
/** Name a player gets when they do not pick one. */
export const DEFAULT_PLAYER_NAME = "Player";
/**
 * How long a room outlives its last change.
 *
 * Sliding, not absolute: every accepted change restamps `updatedAt`, so the
 * countdown restarts on each move, mark, join and (yes) presence change, and
 * only a room nobody has touched for a day is dropped. A day is long enough
 * that a group can walk away from a game overnight and find it in the morning,
 * and short enough that a public server does not accumulate rooms forever.
 */
export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** How often a long-lived server sweeps expired rooms. */
export const DEFAULT_ROOM_SWEEP_MS = 60 * 1000;
/**
 * Room codes avoid `0/O` and `1/I/L` so they survive being read aloud.
 *
 * Ten characters of this 31 symbol alphabet is 31^10 ≈ 8.2e14 codes, roughly 49
 * bits. That is deliberate: a private room is listed nowhere, so its code is the
 * only thing between a stranger and the room, and six characters (8.9e8, ~30
 * bits) would be enumerable by anyone willing to script the join endpoint.
 */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const ROOM_CODE_LENGTH = 10;

/** One accepted board mutation, as the realtime layer needs to broadcast it. */
export interface BoardUpdate {
  readonly gameId: string;
  /** Player whose private board this is; `null` for the board everybody shares. */
  readonly ownerId: string | null;
  readonly game: StoredGame;
  readonly events: readonly GameEvent[];
  /** Player whose action caused it; `null` when no socket asked. */
  readonly actor: string | null;
}

/** One accepted change of a room: the new record, plus any boards it moved. */
export interface RoomChange {
  readonly room: RoomRecord;
  readonly updates: readonly BoardUpdate[];
}

/** The result of creating or joining a room: everything the client needs to play. */
export interface RoomSession {
  readonly room: RoomRecord;
  readonly player: PlayerRecord;
  /** The caller's own board: the shared cube, or their private copy of it. */
  readonly game: StoredGame;
}

/** Receives every accepted change of one room (players, round, boards). */
export type RoomListener = (change: RoomChange) => void;

/** Timer handle, so tests can drive the co-op countdown without waiting. */
export type TimerHandle = ReturnType<typeof setTimeout>;

/** Injected collaborators; all optional ones have sensible defaults. */
export interface RoomServiceDependencies {
  readonly store: RoomStore;
  readonly games: GameService;
  readonly logger: Logger;
  /** ISO timestamp source; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** Player id source; defaults to `crypto.randomUUID()`. */
  readonly generateId?: () => string;
  /** Room code source; defaults to a random {@link ROOM_CODE_LENGTH} character code. */
  readonly generateRoomId?: () => string;
  readonly maxPlayers?: number;
  /** How long a room survives without a change; defaults to {@link ROOM_TTL_MS}. */
  readonly roomTtlMs?: number;
  /**
   * How often expired rooms are swept.
   *
   * Left undefined by default: expiry is also checked when the lobby is read, so
   * an idle server does not need a background timer, and a test that injects
   * timers does not get one it never asked for.
   */
  readonly sweepIntervalMs?: number;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

/** Narrows what {@link RoomService.listRooms} returns. */
export interface RoomListFilter {
  /**
   * Only rooms with this visibility.
   *
   * The lobby passes `"public"`: a private room is unlisted, which is the whole
   * point of creating one, so it must never appear in the list somebody browses.
   */
  readonly visibility?: RoomVisibility;
}

/** Public surface of the rooms module. */
export interface RoomService {
  /** Creates a room, its round and its boards, seating the caller as the first player. */
  createRoom(request: unknown): RoomSession;
  /** Seats a player in an existing room and hands them their board. */
  joinRoom(roomId: string, request: unknown): RoomSession;
  /** @throws RoomNotFoundError when the code is unknown */
  getRoom(roomId: string): RoomRecord;
  /** The board a player is on; the room's shared board when `playerId` is unknown. */
  getBoard(roomId: string, playerId: string | null): StoredGame;
  /** Reveals a cell for a player and applies the mode's rules to the round. */
  reveal(roomId: string, playerId: string, cell: CellIndex): BoardUpdate | undefined;
  /** Cycles a cell's mark for a player; never changes the round, only the board. */
  cycleMark(roomId: string, playerId: string, cell: CellIndex): BoardUpdate | undefined;
  /** Spends one of a player's free reveals; never changes the round. */
  probe(roomId: string, playerId: string, cell: CellIndex): BoardUpdate | undefined;
  /** Every room that is not idle, in creation order, optionally filtered. */
  listRooms(filter?: RoomListFilter): readonly RoomRecord[];
  /** Starts the next round: fresh boards, everyone back in. */
  restart(roomId: string, request: unknown): RoomSession;
  /** Removes a player; deletes the room when the last one leaves. */
  leaveRoom(roomId: string, playerId: string): RoomRecord | undefined;
  /** Records an open socket for a player (presence). */
  connect(roomId: string, playerId: string): RoomRecord | undefined;
  /** Records a closed socket for a player (presence). */
  disconnect(roomId: string, playerId: string): RoomRecord | undefined;
  subscribe(roomId: string, listener: RoomListener): () => void;
  close(): void;
  readonly closed: boolean;
}

/** Creates a room service over the given stores. */
export function createRoomService(dependencies: RoomServiceDependencies): RoomService {
  const { store, games, logger } = dependencies;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const generateId = dependencies.generateId ?? (() => crypto.randomUUID());
  const generateRoomId = dependencies.generateRoomId ?? (() => randomRoomCode());
  const maxPlayers = dependencies.maxPlayers ?? DEFAULT_MAX_PLAYERS;
  const roomTtlMs = dependencies.roomTtlMs ?? ROOM_TTL_MS;
  const scheduleTimer = dependencies.scheduleTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = dependencies.clearTimer ?? ((handle) => clearTimeout(handle));

  const subscribers = new Map<string, Set<RoomListener>>();
  /** Co-op countdowns, one per room that has started its clock. */
  const timers = new Map<string, TimerHandle>();
  let sweepTimer: TimerHandle | undefined;
  let closed = false;

  const assertOpen = (): void => {
    if (closed) throw new RoomServiceClosedError();
  };

  const notify = (change: RoomChange): void => {
    const listeners = subscribers.get(change.room.id);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (error) {
        logger.warn("room listener failed", { roomId: change.room.id, error });
      }
    }
  };

  const commit = (room: RoomRecord, updates: readonly BoardUpdate[] = []): RoomRecord => {
    const saved = store.save(room);
    notify({ room: saved, updates });
    return saved;
  };

  /**
   * Forgets a room and everything only it pointed at.
   *
   * Boards belong to the room that opened them, so they go with it: without
   * that the game store would grow by one board per room the server has ever
   * dropped, and a persisted state file would carry them all forever.
   */
  const dropRoom = (roomId: string, reason: string): void => {
    const room = store.get(roomId);
    cancelDeadline(roomId);
    store.delete(roomId);
    subscribers.delete(roomId);
    if (room === undefined) return;
    for (const boardId of boardIdsOf(room)) games.deleteGame(boardId);
    logger.info("room dropped", { roomId, reason, mode: room.mode, round: room.round });
  };

  /**
   * Drops rooms nobody has changed for longer than the TTL.
   *
   * Expiry is by staleness, deliberately not by emptiness: a room whose players
   * are still connected but who stopped playing an hour into a co-op round is
   * exactly the room the TTL is for. Presence is process-local, so a room that
   * survived a restart has no connections at all and still deserves its full
   * remaining day.
   */
  const pruneExpired = (): void => {
    const cutoff = Date.parse(now()) - roomTtlMs;
    for (const room of store.list()) {
      if (Date.parse(room.updatedAt) > cutoff) continue;
      dropRoom(room.id, "expired");
    }
  };

  const getRoom = (roomId: string): RoomRecord => {
    assertOpen();
    const room = store.get(roomId);
    if (room === undefined) throw new RoomNotFoundError(roomId);
    return room;
  };

  const uniqueRoomId = (): string => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = generateRoomId();
      if (!store.get(candidate)) return candidate;
    }
    throw new Error("Could not allocate a free room code");
  };

  /**
   * Applies a board-only action - a mark, a free reveal - for one player.
   *
   * Neither action touches the clock, the standings or the round status: they
   * change the caller's own cube and nothing else. Keeping them in one place is
   * what keeps that promise true for the next such action somebody adds.
   */
  const applyToBoard = (
    roomId: string,
    playerId: string,
    action: (gameId: string) => {
      readonly game: StoredGame;
      readonly events: readonly GameEvent[];
      readonly changed: boolean;
    },
  ): BoardUpdate | undefined => {
    const room = getRoom(roomId);
    const player = requirePlayer(room, playerId);
    if (isRoundOver(room) || player.outcome !== "playing") return undefined;

    const result = action(boardIdOf(room, playerId));
    if (!result.changed) return undefined;

    const update = boardUpdate(room, playerId, result);
    commit({ ...room, updatedAt: now() }, [update]);
    return update;
  };

  /**
   * Re-arms the co-op clocks of rooms that were already in the store.
   *
   * A restored room carries a deadline but no timer - timers do not survive a
   * process - so without this a round restored mid-countdown would never expire.
   * A deadline already in the past is not special-cased: scheduling it yields a
   * zero delay, which is exactly right, because that clock really did run out
   * while the server was down.
   */
  for (const room of store.list()) {
    if (room.deadlineAt === null || isRoundOver(room)) continue;
    scheduleDeadline(room.id, room.deadlineAt);
    logger.debug("co-op clock re-armed", { roomId: room.id, deadlineAt: room.deadlineAt });
  }

  if (dependencies.sweepIntervalMs !== undefined) {
    const intervalMs = Math.max(1, dependencies.sweepIntervalMs);
    const sweep = (): void => {
      if (closed) return;
      // Re-armed before the sweep, so a throwing sweep cannot stop the clock.
      sweepTimer = scheduleTimer(sweep, intervalMs);
      pruneExpired();
    };
    sweepTimer = scheduleTimer(sweep, intervalMs);
  }

  return {
    createRoom(request) {
      assertOpen();
      const body = requireBody(request);
      const mode = readMode(body);
      const visibility = readVisibility(body);
      const playerName = readPlayerName(body);
      const roomName = readRoomName(body, playerName);
      const { config, presetId } = readRoomConfig(body, mode);
      const game = games.createGame({ config });

      const timestamp = now();
      const player = newPlayer(generateId(), playerName, timestamp);
      const room: RoomRecord = {
        id: uniqueRoomId(),
        name: roomName,
        mode,
        visibility,
        config,
        presetId,
        difficultyId: difficultyOf(config.size, config.mineCount).id,
        status: "ready",
        round: 1,
        gameId: game.id,
        // A race is the only mode where the first player's board is not the
        // one everybody plays on, so only a race needs the per-player index.
        boards: sharesBoard(mode) ? {} : { [player.id]: game.id },
        deadlineAt: null,
        timeLimitMs: coopTimeLimitMs(config.size, config.mineCount),
        players: [player],
        maxPlayers,
        createdAt: timestamp,
        updatedAt: timestamp,
      };

      store.create(room);
      logger.info("room created", { roomId: room.id, mode, gameId: game.id, player: player.id });
      return { room, player, game };
    },

    joinRoom(roomId, request) {
      const body = requireBody(request);
      const playerName = readPlayerName(body);
      const room = getRoom(roomId);

      // A client that kept its player id (a refresh, a direct link) reclaims its
      // seat instead of appearing twice under the same name.
      const existing = findPlayer(room, readOptionalString(body, "playerId"));
      if (existing !== undefined) {
        const renamed =
          existing.name === playerName
            ? room
            : commit({
                ...room,
                players: room.players.map((player) =>
                  player.id === existing.id ? { ...player, name: playerName } : player,
                ),
                updatedAt: now(),
              });
        const seated = findPlayer(renamed, existing.id) ?? existing;
        logger.info("player rejoined", { roomId: room.id, player: seated.id });
        return { room: renamed, player: seated, game: games.getGame(boardIdOf(renamed, seated.id)) };
      }

      const seated = seatPlayer(room, playerName);
      logger.info("player joined", { roomId: room.id, mode: room.mode, player: seated.player.id });
      return {
        room: seated.room,
        player: seated.player,
        game: games.getGame(boardIdOf(seated.room, seated.player.id)),
      };
    },

    getRoom,

    getBoard(roomId, playerId) {
      const room = getRoom(roomId);
      const player = findPlayer(room, playerId ?? undefined);
      return games.getGame(player === undefined ? room.gameId : boardIdOf(room, player.id));
    },

    reveal(roomId, playerId, cell) {
      const room = getRoom(roomId);
      const player = requirePlayer(room, playerId);
      if (isRoundOver(room) || player.outcome !== "playing") return undefined;

      const gameId = boardIdOf(room, playerId);
      const result = games.reveal(gameId, cell);
      if (!result.changed) return undefined;

      const update = boardUpdate(room, playerId, result);
      const timestamp = now();
      const events = result.events;
      let next = withPlayer(room, playerId, {
        revealedCount: player.revealedCount + revealedCells(events),
      });

      // Survival spends a mine instead of ending the board, so a detonation is a
      // player leaving the round rather than the round ending.
      if (room.mode === "survival" && events.some((event) => event.type === "mineExploded")) {
        next = withPlayer(next, playerId, { outcome: "out", finishedAt: timestamp });
      }
      // In a race a fatal mine only costs the player who stepped on it their own
      // cube: they can no longer win, but the others are still racing.
      if (room.mode === "race" && result.game.state.status === "lost") {
        next = withPlayer(next, playerId, { outcome: "out", finishedAt: timestamp });
      }

      if (usesClock(room.mode) && next.deadlineAt === null && result.game.state.status === "playing") {
        next = startClock(next, timestamp);
      }

      const status = roundStatus(next, result.game.state.status);
      if (status === "won") {
        // A shared board has one outcome for everybody, so a cleared cube clears
        // the surviving team; a race credits the one whose cube fell first.
        next = sharesBoard(room.mode)
          ? mapPlayers(next, (candidate) =>
              candidate.outcome === "playing" ? { ...candidate, outcome: "cleared", finishedAt: timestamp } : candidate,
            )
          : withPlayer(next, playerId, { outcome: "cleared", finishedAt: timestamp });
      }
      if (status !== next.status) next = { ...next, status };
      if (isRoundOver(next)) cancelDeadline(next.id);

      const saved = commit({ ...next, updatedAt: timestamp }, [update]);
      logger.debug("room reveal", { roomId: saved.id, mode: saved.mode, player: playerId, status: saved.status });
      return update;
    },

    cycleMark(roomId, playerId, cell) {
      return applyToBoard(roomId, playerId, (gameId) => games.cycleMark(gameId, cell));
    },

    probe(roomId, playerId, cell) {
      return applyToBoard(roomId, playerId, (gameId) => games.probe(gameId, cell));
    },

    listRooms(filter) {
      assertOpen();
      pruneExpired();
      const rooms = store.list();
      const visibility = filter?.visibility;
      if (visibility === undefined) return rooms;
      return rooms.filter((room) => room.visibility === visibility);
    },

    restart(roomId, request) {
      const body = requireBody(request);
      const room = getRoom(roomId);
      const requested = findPlayer(room, readOptionalString(body, "playerId"));
      const actor = requested ?? room.players[0];
      if (actor === undefined) throw new PlayerNotInRoomError(room.id, "");

      const { config, presetId } = readRoomConfig(body, room.mode, room.config);
      cancelDeadline(room.id);

      const timestamp = now();
      const players = room.players.map((player): PlayerRecord => ({
        ...player,
        outcome: "playing",
        finishedAt: null,
        revealedCount: 0,
      }));

      // A new round means new boards: one shared cube, or one identical copy per
      // player. They all come from the same config, so a race stays fair.
      const template = games.createGame({ config });
      const boards: Record<string, string> = {};
      const updates: BoardUpdate[] = [];
      if (sharesBoard(room.mode)) {
        updates.push({ gameId: template.id, ownerId: null, game: template, events: [], actor: null });
      } else {
        for (const player of players) {
          // The first player reuses the template board; everybody else gets an
          // identical copy of the same cube.
          const board = player === players[0] ? template : games.createGame({ config });
          boards[player.id] = board.id;
          updates.push({ gameId: board.id, ownerId: player.id, game: board, events: [], actor: null });
        }
      }

      const next = commit(
        {
          ...room,
          config,
          presetId,
          difficultyId: difficultyOf(config.size, config.mineCount).id,
          status: "ready",
          round: room.round + 1,
          gameId: template.id,
          boards,
          deadlineAt: null,
          timeLimitMs: coopTimeLimitMs(config.size, config.mineCount),
          players,
          updatedAt: timestamp,
        },
        updates,
      );

      const seated = findPlayer(next, actor.id) ?? actor;
      logger.info("room restarted", { roomId: next.id, round: next.round, mode: next.mode });
      return { room: next, player: seated, game: games.getGame(boardIdOf(next, seated.id)) };
    },

    leaveRoom(roomId, playerId) {
      const room = store.get(roomId);
      if (room === undefined) return undefined;
      const players = room.players.filter((player) => player.id !== playerId);
      if (players.length === room.players.length) throw new PlayerNotInRoomError(roomId, playerId);
      if (players.length === 0) {
        dropRoom(roomId, "empty");
        return undefined;
      }
      return commit({ ...room, players, updatedAt: now() });
    },

    connect(roomId, playerId) {
      return updateConnections(roomId, playerId, 1);
    },

    disconnect(roomId, playerId) {
      return updateConnections(roomId, playerId, -1);
    },

    subscribe(roomId, listener) {
      if (closed) return () => undefined;
      let listeners = subscribers.get(roomId);
      if (listeners === undefined) {
        listeners = new Set();
        subscribers.set(roomId, listeners);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) subscribers.delete(roomId);
      };
    },

    close() {
      if (closed) return;
      closed = true;
      if (sweepTimer !== undefined) {
        clearTimer(sweepTimer);
        sweepTimer = undefined;
      }
      for (const roomId of [...timers.keys()]) cancelDeadline(roomId);
      subscribers.clear();
      logger.debug("room service closed", { rooms: store.size });
    },

    get closed() {
      return closed;
    },
  };

  /**
   * What the round looks like after one accepted reveal.
   *
   * Pure: it reads the room and the board's new status and returns the status
   * the match is in. Outcomes are moved separately by the caller so "who is out"
   * and "is the round over" stay one decision each.
   */
  function roundStatus(room: RoomRecord, boardStatus: StoredGame["state"]["status"]): MatchStatus {
    // A finished round stays finished: no later reveal can reopen it.
    if (isRoundOver(room)) return room.status;

    if (boardStatus === "won") return "won";

    if (sharesBoard(room.mode)) {
      // Everybody plays the one board, so its loss is the round's loss.
      if (boardStatus === "lost") return "lost";
      if (room.mode === "survival") {
        const alive = room.players.filter((player) => player.outcome === "playing");
        const out = room.players.length - alive.length;
        // Last one standing only means something once somebody has fallen;
        // otherwise a solo room would be "won" before it was even played.
        if (out > 0 && alive.length <= 1) return alive.length === 1 ? "won" : "lost";
      }
      // Any accepted reveal means the round is under way.
      return "playing";
    }

    // A race dies when nobody is left able to finish their cube.
    return room.players.every((player) => player.outcome !== "playing") ? "lost" : "playing";
  }

  /** Starts the co-op countdown, arming the server-side timeout with it. */
  function startClock(room: RoomRecord, timestamp: string): RoomRecord {
    const deadlineAt = new Date(Date.parse(timestamp) + room.timeLimitMs).toISOString();
    const next = { ...room, deadlineAt };
    scheduleDeadline(room.id, deadlineAt);
    logger.info("co-op clock started", { roomId: room.id, deadlineAt });
    return next;
  }

  function scheduleDeadline(roomId: string, deadlineAt: string): void {
    cancelDeadline(roomId);
    const delay = Math.max(0, Date.parse(deadlineAt) - Date.parse(now()));
    timers.set(
      roomId,
      scheduleTimer(() => {
        timers.delete(roomId);
        expireRound(roomId);
      }, delay),
    );
  }

  function cancelDeadline(roomId: string): void {
    const handle = timers.get(roomId);
    if (handle === undefined) return;
    clearTimer(handle);
    timers.delete(roomId);
  }

  /**
   * Ends a co-op round whose clock ran out.
   *
   * Driven by a timer so the loss happens even if nobody is looking, which is the
   * whole point of playing against a clock rather than against a client.
   */
  function expireRound(roomId: string): void {
    if (closed) return;
    const room = store.get(roomId);
    if (room === undefined || !usesClock(room.mode) || room.deadlineAt === null) return;
    if (isRoundOver(room)) return;

    const timestamp = now();
    if (Date.parse(room.deadlineAt) > Date.parse(timestamp)) {
      scheduleDeadline(roomId, room.deadlineAt);
      return;
    }

    const expired = mapPlayers({ ...room, status: "lost", updatedAt: timestamp }, (player) =>
      player.outcome === "playing" ? { ...player, outcome: "out", finishedAt: timestamp } : player,
    );
    logger.info("co-op round timed out", { roomId, round: room.round });
    commit(expired);
  }

  function seatPlayer(room: RoomRecord, name: string): { room: RoomRecord; player: PlayerRecord } {
    if (room.players.length >= room.maxPlayers) throw new RoomFullError(room.id, room.maxPlayers);
    const timestamp = now();
    const player = newPlayer(generateId(), name, timestamp);
    // A race hands the newcomer their own copy of the same cube; the shared
    // modes hand them the board the room is already on.
    const boards = sharesBoard(room.mode)
      ? room.boards
      : { ...room.boards, [player.id]: games.createGame({ config: room.config }).id };
    const next = commit({ ...room, players: [...room.players, player], boards, updatedAt: timestamp });
    return { room: next, player };
  }

  /** Presence bookkeeping, shared by connect and disconnect. */
  function updateConnections(roomId: string, playerId: string, delta: number): RoomRecord | undefined {
    const room = store.get(roomId);
    if (room === undefined) return undefined;
    const player = room.players.find((candidate) => candidate.id === playerId);
    if (player === undefined) return undefined;

    const connections = Math.max(0, player.connections + delta);
    if (connections === player.connections) return room;
    return commit({
      ...room,
      players: room.players.map((candidate) =>
        candidate.id === playerId ? { ...candidate, connections } : candidate,
      ),
      updatedAt: now(),
    });
  }
}

/** The board a player's actions land on. */
function boardIdOf(room: RoomRecord, playerId: string): string {
  if (sharesBoard(room.mode)) return room.gameId;
  return room.boards[playerId] ?? room.gameId;
}

/** Wraps one accepted game mutation as the realtime layer broadcasts it. */
function boardUpdate(
  room: RoomRecord,
  playerId: string,
  result: { game: StoredGame; events: readonly GameEvent[] },
): BoardUpdate {
  return {
    gameId: result.game.id,
    ownerId: sharesBoard(room.mode) ? null : playerId,
    game: result.game,
    events: result.events,
    actor: playerId,
  };
}

/** Cells a flood fill opened, i.e. the credit for one click. */
function revealedCells(events: readonly GameEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (event.type === "cellsRevealed") count += event.cells.length;
  }
  return count;
}

function isRoundOver(room: RoomRecord): boolean {
  return room.status === "won" || room.status === "lost";
}

function newPlayer(id: string, name: string, timestamp: string): PlayerRecord {
  return {
    id,
    name,
    joinedAt: timestamp,
    connections: 0,
    outcome: "playing",
    finishedAt: null,
    revealedCount: 0,
  };
}

function withPlayer(room: RoomRecord, playerId: string, patch: Partial<PlayerRecord>): RoomRecord {
  return {
    ...room,
    players: room.players.map((player) => (player.id === playerId ? { ...player, ...patch } : player)),
  };
}

function mapPlayers(room: RoomRecord, map: (player: PlayerRecord) => PlayerRecord): RoomRecord {
  return { ...room, players: room.players.map(map) };
}

function requirePlayer(room: RoomRecord, playerId: string): PlayerRecord {
  const player = findPlayer(room, playerId);
  if (player === undefined) throw new PlayerNotInRoomError(room.id, playerId);
  return player;
}

/**
 * Resolves the board a room is created (or restarted) with.
 *
 * An explicit `mineCount` wins, then an explicit difficulty tier, then whatever
 * the room was already playing, then the mode's own default. The mine count is
 * what the board actually uses; the tier is always re-derived from it, so a
 * count that does not sit on a tier's nominal density is still labelled honestly.
 */
function readRoomConfig(
  body: Record<string, unknown>,
  mode: MatchMode,
  current?: GameConfig,
): { config: GameConfig; presetId: string } {
  const presetId =
    readOptionalString(body, "presetId") ??
    (current === undefined ? undefined : presetIdOfSize(current.size)) ??
    DEFAULT_PRESET_ID;
  const preset = findPreset(presetId);
  if (preset === undefined) {
    throw new InvalidRoomRequestError("unknown_preset", `Unknown preset "${presetId}"`, GAME_PRESETS.map((entry) => entry.id));
  }
  const size = preset.size;

  const difficultyId = readDifficulty(body);
  const explicitMines = readOptionalNumber(body, "mineCount");
  let mineCount: number;
  if (explicitMines !== undefined) {
    mineCount = clampMineCount(size, Math.round(explicitMines));
  } else if (difficultyId !== undefined) {
    mineCount = mineCountFor(size, difficultyId);
  } else if (current !== undefined && sameSize(current.size, size)) {
    mineCount = clampMineCount(size, current.mineCount);
  } else {
    mineCount = mineCountFor(size, defaultDifficultyForMode(mode));
  }

  const seed = readOptionalNumber(body, "seed") ?? randomSeed();
  const firstRevealSafe = readOptionalBoolean(body, "firstRevealSafe") ?? current?.firstRevealSafe ?? DEFAULT_RULES.firstRevealSafe;
  // The aid is opt-in, so a room that says nothing about it gets none - but a
  // restart keeps whatever the room was already playing with, because the body
  // of a restart only carries what the caller wants to change.
  const freeReveals =
    readOptionalNumber(body, "freeReveals") ?? current?.freeReveals ?? DEFAULT_RULES.freeReveals;

  // Survival is the mode that spends mines instead of losing on them, so the
  // rule comes from the mode and never from the request.
  const validation = validateGameConfig({
    size,
    mineCount,
    seed,
    firstRevealSafe,
    minesFatal: !hasEliminations(mode),
    // Not rounded on purpose: a fractional charge count is a client bug, and the
    // engine's own validator says so more precisely than a silent fix would.
    freeReveals,
  });
  if (!validation.ok) {
    throw new InvalidGameRequestError("invalid_config", "Game config is invalid", validation.issues);
  }
  return { config: validation.config, presetId: presetIdOfSize(size) };
}

/** Names the preset a size matches, so the lobby can label a room without the game. */
function presetIdOfSize(size: Vec3): string {
  const match = GAME_PRESETS.find(
    (preset) => preset.size.x === size.x && preset.size.y === size.y && preset.size.z === size.z,
  );
  return match?.id ?? "custom";
}

function sameSize(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function clampMineCount(size: Vec3, count: number): number {
  return Math.min(maxMineCount(size), Math.max(0, count));
}

function readMode(body: Record<string, unknown>): MatchMode {
  const raw = body["mode"];
  if (raw === undefined || raw === null) return DEFAULT_MATCH_MODE;
  if (!isMatchMode(raw)) {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [
      `mode must be one of ${["coop", "race", "survival"].join(", ")}`,
    ]);
  }
  return raw;
}

function readDifficulty(body: Record<string, unknown>): DifficultyId | undefined {
  const raw = readOptionalString(body, "difficultyId");
  if (raw === undefined) return undefined;
  if (!isDifficultyId(raw)) {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [
      `difficultyId must be one of ${DIFFICULTIES.map((entry) => entry.id).join(", ")}`,
    ]);
  }
  return raw;
}

/**
 * Reads the requested visibility.
 *
 * An absent field means a listed room, the way an absent `mode` means co-op, so
 * an older client that knows nothing about privacy keeps working.
 */
function readVisibility(body: Record<string, unknown>): RoomVisibility {
  const raw = body["visibility"];
  if (raw === undefined || raw === null) return DEFAULT_ROOM_VISIBILITY;
  if (!isRoomVisibility(raw)) {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [
      `visibility must be one of ${ROOM_VISIBILITIES.map((entry) => entry.id).join(", ")}`,
    ]);
  }
  return raw;
}

function requireBody(request: unknown): Record<string, unknown> {
  if (!isRecord(request)) {
    throw new InvalidRoomRequestError("invalid_body", "Request body must be a JSON object");
  }
  return request;
}

function readPlayerName(body: Record<string, unknown>): string {
  const raw = body["playerName"];
  if (raw === undefined || raw === null) return DEFAULT_PLAYER_NAME;
  if (typeof raw !== "string") {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [
      "playerName must be a string",
    ]);
  }
  return clampName(raw, DEFAULT_PLAYER_NAME, MAX_PLAYER_NAME_LENGTH);
}

function readRoomName(body: Record<string, unknown>, playerName: string): string {
  const raw = body["name"];
  if (raw === undefined || raw === null) return `${playerName}'s room`;
  if (typeof raw !== "string") {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", ["name must be a string"]);
  }
  return clampName(raw, `${playerName}'s room`, MAX_ROOM_NAME_LENGTH);
}

function readOptionalString(body: Record<string, unknown>, key: string): string | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [`${key} must be a string`]);
  }
  const trimmed = raw.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readOptionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [`${key} must be a finite number`]);
  }
  return raw;
}

function readOptionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const raw = body[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "boolean") {
    throw new InvalidRoomRequestError("invalid_body", "Request body is invalid", [`${key} must be a boolean`]);
  }
  return raw;
}

/** Trims, falls back when blank and truncates to the limit. */
function clampName(raw: string, fallback: string, maxLength: number): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, maxLength);
}

function findPlayer(room: RoomRecord, playerId: string | undefined): PlayerRecord | undefined {
  if (playerId === undefined) return undefined;
  return room.players.find((player) => player.id === playerId);
}

/** {@link ROOM_CODE_LENGTH} characters from an unambiguous alphabet. */
function randomRoomCode(): string {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const pick = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[pick] ?? "A";
  }
  return code;
}
