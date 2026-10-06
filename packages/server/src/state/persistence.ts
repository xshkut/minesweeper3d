/**
 * Durable state for an in-memory server.
 *
 * The server keeps every room and board in one process, which is what makes it
 * simple - and what makes a restart lose everything. This module closes that
 * gap without changing the services: it hands them the same `GameStore` and
 * `RoomStore` interfaces they already take, wraps both so that a write marks
 * the document dirty, and puts the actual I/O on a debounce and a queue.
 *
 * Three properties are worth being explicit about:
 *
 *  - **Writes never block a request.** `save` only sets a flag and (at most)
 *    arms a timer; the file is written from the event loop afterwards. The
 *    debounce also collapses the storm of `save` calls one flood fill produces
 *    into a single document.
 *  - **The file is replaced, never mutated.** A snapshot is written next to the
 *    target and then renamed over it, so a crash mid-write leaves the previous
 *    document readable rather than a truncated one.
 *  - **A broken file is not fatal.** It is a cache of live state: if it cannot
 *    be read, understood or written, the server logs it and carries on with the
 *    state it has.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInMemoryGameStore } from "../games/store";
import type { GameStore, StoredGame } from "../games/store";
import type { Logger } from "../logger";
import { createInMemoryRoomStore } from "../rooms/store";
import type { RoomRecord, RoomStore } from "../rooms/store";
import { buildSnapshot, InvalidStateSnapshotError, parseStateSnapshot, serializeSnapshot } from "./snapshot";
import type { LoadedState } from "./snapshot";

/** Timer handle, spelled out here so this module does not depend on a service. */
type TimerHandle = ReturnType<typeof setTimeout>;

/** How long a change waits for company before the file is rewritten. */
export const DEFAULT_STATE_FLUSH_MS = 250;

/** Injected collaborators; all optional ones have sensible defaults. */
export interface StatePersistenceOptions {
  /** File to snapshot into; its directory is created on demand. */
  readonly path: string;
  readonly logger: Logger;
  /** ISO timestamp source; defaults to `new Date().toISOString()`. */
  readonly now?: () => string;
  /** Debounce window; `0` writes as soon as the queue is free. */
  readonly flushDelayMs?: number;
  readonly scheduleTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  readonly clearTimer?: (handle: TimerHandle) => void;
}

/** What {@link StatePersistence.restore} found. */
export interface RestoreReport {
  /** `false` when there was nothing to load yet, i.e. a first boot. */
  readonly loaded: boolean;
  readonly games: number;
  readonly rooms: number;
  /** One reason per record that could not be trusted. */
  readonly skipped: readonly string[];
}

/** Public surface of the persistence module. */
export interface StatePersistence {
  readonly path: string;
  /** Games store to hand to the game service; writes through it are persisted. */
  readonly games: GameStore;
  /** Rooms store to hand to the room service; writes through it are persisted. */
  readonly rooms: RoomStore;
  /** Loads the file into the stores; call once, before the services start. */
  restore(): Promise<RestoreReport>;
  /** Writes anything pending, now. */
  flush(): Promise<void>;
  /** Stops scheduling writes and flushes one last time. */
  close(): Promise<void>;
  /** `true` while a change is waiting to be written. */
  readonly dirty: boolean;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Creates the persistence layer, with the stores it wraps. */
export function createStatePersistence(options: StatePersistenceOptions): StatePersistence {
  const { path, logger } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const flushDelayMs = options.flushDelayMs ?? DEFAULT_STATE_FLUSH_MS;
  const scheduleTimer = options.scheduleTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));

  const games = createInMemoryGameStore();
  const rooms = createInMemoryRoomStore();

  let dirty = false;
  let closed = false;
  let timer: TimerHandle | undefined;
  /** Every write in flight, chained so two snapshots never interleave. */
  let queue: Promise<void> = Promise.resolve();

  const cancelTimer = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };

  const write = async (): Promise<void> => {
    const snapshot = buildSnapshot({ games, rooms }, now());
    const text = serializeSnapshot(snapshot);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, path);
    logger.debug("state flushed", {
      path,
      games: snapshot.games.length,
      rooms: snapshot.rooms.length,
      bytes: text.length,
    });
  };

  const drain = async (): Promise<void> => {
    while (dirty) {
      // Cleared before the write: a change that lands while we are awaiting I/O
      // sets it again, and the loop then writes a second time.
      dirty = false;
      try {
        await write();
      } catch (error) {
        // Keep the change pending so a later mutation (or shutdown) retries, but
        // do not spin: an unwritable path stays unwritable.
        dirty = true;
        logger.error("state write failed", { path, error: messageOf(error) });
        return;
      }
    }
  };

  const flush = (): Promise<void> => {
    cancelTimer();
    queue = queue.then(drain, drain);
    return queue;
  };

  const markDirty = (): void => {
    if (closed) return;
    dirty = true;
    if (timer !== undefined) return;
    timer = scheduleTimer(() => {
      timer = undefined;
      void flush();
    }, flushDelayMs);
  };

  const observingGames: GameStore = {
    create(state, init) {
      const game = games.create(state, init);
      markDirty();
      return game;
    },
    get: (id) => games.get(id),
    save(game: StoredGame) {
      const saved = games.save(game);
      markDirty();
      return saved;
    },
    // Hydration: the record already is what the file says, so it is not a change.
    restore: (game: StoredGame) => games.restore(game),
    delete(id) {
      const removed = games.delete(id);
      if (removed) markDirty();
      return removed;
    },
    list: () => games.list(),
    get size() {
      return games.size;
    },
  };

  const observingRooms: RoomStore = {
    create(room) {
      const created = rooms.create(room);
      markDirty();
      return created;
    },
    get: (id) => rooms.get(id),
    save(room: RoomRecord) {
      const saved = rooms.save(room);
      markDirty();
      return saved;
    },
    restore: (room: RoomRecord) => rooms.restore(room),
    delete(id) {
      const removed = rooms.delete(id);
      if (removed) markDirty();
      return removed;
    },
    list: () => rooms.list(),
    get size() {
      return rooms.size;
    },
  };

  const restore = async (): Promise<RestoreReport> => {
    let text: string | undefined;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (!isMissingFile(error)) {
        logger.warn("state file could not be read; starting empty", { path, error: messageOf(error) });
        return { loaded: false, games: 0, rooms: 0, skipped: [] };
      }
    }
    if (text === undefined) {
      logger.debug("no state file to restore", { path });
      return { loaded: false, games: 0, rooms: 0, skipped: [] };
    }

    let loaded: LoadedState;
    try {
      loaded = parseStateSnapshot(text);
    } catch (error) {
      // Includes the wrong version: the layout this build does not understand is
      // not something to guess at.
      const reason = error instanceof InvalidStateSnapshotError ? error.message : messageOf(error);
      logger.warn("state file ignored; starting empty", { path, error: reason });
      return { loaded: false, games: 0, rooms: 0, skipped: [] };
    }

    for (const game of loaded.games) games.restore(game);
    for (const room of loaded.rooms) rooms.restore(room);
    // `restore` is the hydration path and marks nothing dirty: the stores now
    // hold exactly what the file held.
    dirty = false;
    if (loaded.skipped.length > 0) logger.warn("state records dropped", { path, skipped: loaded.skipped });
    logger.info("state restored", {
      path,
      savedAt: loaded.savedAt,
      games: loaded.games.length,
      rooms: loaded.rooms.length,
    });
    return { loaded: true, games: loaded.games.length, rooms: loaded.rooms.length, skipped: loaded.skipped };
  };

  const close = async (): Promise<void> => {
    cancelTimer();
    closed = true;
    await flush();
    logger.debug("state persistence closed", { path });
  };

  return {
    path,
    games: observingGames,
    rooms: observingRooms,
    restore,
    flush,
    close,
    get dirty() {
      return dirty;
    },
  };
}
