/**
 * Persistence: the state file, and what a restart makes of it.
 *
 * The round trip is checked through the *real* services rather than by writing
 * to the store twice, because the promise being made is that the store
 * interfaces did not change: a room is created and played with through one
 * service, and a second service - with its own stores, its own clock and its
 * own timers - has to see the same room and the same board.
 *
 * The file is a temporary file on a shared machine, so the unhappy paths matter
 * as much as the happy one: it can be truncated, hand-edited, or left behind by
 * another build. Each of those is expected to be reported and survived, never
 * to take the process down.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGame, createGrid, isExposed, mineCountFor, presetConfig, vec3 } from "@minesweeper3d/game-core";
import type { CellIndex, GameState } from "@minesweeper3d/game-core";
import { createGameService } from "../src/games/service";
import type { Logger } from "../src/logger";
import { createRoomService } from "../src/rooms/service";
import type { TimerHandle } from "../src/rooms/service";
import type { RoomRecord } from "../src/rooms/store";
import type { StoredGame } from "../src/games/store";
import { createStatePersistence, DEFAULT_STATE_FLUSH_MS } from "../src/state/persistence";
import type { StatePersistence } from "../src/state/persistence";
import { parseStateSnapshot, STATE_SCHEMA_VERSION } from "../src/state/snapshot";
import type { LoadedState } from "../src/state/snapshot";
import { recordingLogger, silentLogger, TMP_ROOT, waitFor } from "./support";

/** Scratch directories are removed after every test. */
const scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh state file path under the repository's git-ignored `.tmp`. */
async function scratch(name: string): Promise<string> {
  const dir = join(TMP_ROOT, "persistence", name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  scratchDirs.push(dir);
  return join(dir, "state.json");
}

/** The snapshot document, typed loosely: tests tamper with it on purpose. */
interface SnapshotDocument {
  version: number;
  savedAt: string;
  games: StoredGame[];
  rooms: RoomRecord[];
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one record");
  return item;
}

/** A cell the rules currently allow opening, so a restart can be played on. */
function openableCell(state: GameState): CellIndex {
  const grid = createGrid(state.config.size);
  const cell = state.cells.find(
    (candidate) =>
      !candidate.isRevealed &&
      !candidate.isFlagged &&
      !candidate.isQuestioned &&
      isExposed(grid, state.cells, grid.offsetOf(candidate.index)),
  );
  if (cell === undefined) throw new Error("the board has nothing left to open");
  return cell.index;
}

/** The persistence layer and the game service that writes through it. */
function stackAt(path: string, logger: Logger): { persistence: StatePersistence; games: ReturnType<typeof createGameService> } {
  const persistence = createStatePersistence({ path, logger });
  return { persistence, games: createGameService({ store: persistence.games, logger }) };
}

/** A recorder for armed timers, so a clock can be fired by hand. */
function timerRecorder(): {
  readonly armed: number[];
  scheduleTimer: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer: (handle: TimerHandle) => void;
  fire(): void;
} {
  const pending = new Map<number, () => void>();
  const armed: number[] = [];
  let sequence = 0;
  return {
    armed,
    scheduleTimer: (callback, delayMs) => {
      sequence += 1;
      pending.set(sequence, callback);
      armed.push(delayMs);
      return sequence as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      pending.delete(handle as unknown as number);
    },
    fire() {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback();
    },
  };
}

/** Creates one race room, starts its clock-free board, and leaves the file behind. */
async function seedSnapshot(path: string, mode: "race" | "coop" = "race"): Promise<LoadedState> {
  const logger = silentLogger();
  const { persistence, games } = stackAt(path, logger);
  const rooms = createRoomService({ store: persistence.rooms, games, logger });
  const session = rooms.createRoom({ playerName: "Ada", mode, difficultyId: "hard" });
  rooms.reveal(session.room.id, session.player.id, vec3(0, 0, 0));
  await persistence.close();
  return parseStateSnapshot(await readFile(path, "utf8"));
}

/** Writes a snapshot back out, with whole lists swapped out by the caller. */
async function writeSnapshot(
  path: string,
  state: LoadedState,
  overrides: { rooms?: readonly RoomRecord[]; games?: readonly StoredGame[] } = {},
): Promise<void> {
  const document: SnapshotDocument = {
    version: STATE_SCHEMA_VERSION,
    savedAt: state.savedAt ?? "2026-01-01T00:00:00.000Z",
    games: [...(overrides.games ?? state.games)],
    rooms: [...(overrides.rooms ?? state.rooms)],
  };
  await writeFile(path, JSON.stringify(document), "utf8");
}

describe("state file", () => {
  test("a room and its board come back after a restart", async () => {
    const path = await scratch("round-trip");
    const logger = silentLogger();
    const first = stackAt(path, logger);
    const roomsA = createRoomService({ store: first.persistence.rooms, games: first.games, logger });
    const session = roomsA.createRoom({ playerName: "Ada", mode: "race", difficultyId: "hard" });
    expect(roomsA.reveal(session.room.id, session.player.id, vec3(0, 0, 0))).toBeDefined();
    const before = roomsA.getBoard(session.room.id, session.player.id);
    await first.persistence.flush();

    const second = stackAt(path, silentLogger());
    const report = await second.persistence.restore();
    expect(report).toMatchObject({ loaded: true, games: 1, rooms: 1, skipped: [] });

    const roomsB = createRoomService({ store: second.persistence.rooms, games: second.games, logger: silentLogger() });
    const room = roomsB.getRoom(session.room.id);
    expect(room.mode).toBe("race");
    expect(room.status).toBe("playing");
    expect(room.config.mineCount).toBe(mineCountFor(vec3(5, 5, 5), "hard"));
    expect(room.players.map((player) => player.id)).toEqual([session.player.id]);

    const after = roomsB.getBoard(session.room.id, session.player.id);
    expect(after.state.revealedCount).toBe(before.state.revealedCount);
    expect(after.state.config).toEqual(before.state.config);
    // The restored board is playable, not just readable.
    expect(roomsB.reveal(session.room.id, session.player.id, openableCell(after.state))).toBeDefined();
  });

  test("a change is queued rather than written on the spot", async () => {
    const path = await scratch("deferred");
    const timers = timerRecorder();
    const persistence = createStatePersistence({
      path,
      logger: silentLogger(),
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    const game = persistence.games.create(createGame(presetConfig("tiny", { seed: 7 })));
    expect(persistence.dirty).toBe(true);
    expect(timers.armed).toEqual([DEFAULT_STATE_FLUSH_MS]);
    expect(existsSync(path)).toBe(false);

    // A flood fill is thousands of saves; they collapse into the one pending write.
    persistence.games.save({ ...game, revision: 1 });
    persistence.games.save({ ...game, revision: 2 });
    expect(timers.armed).toEqual([DEFAULT_STATE_FLUSH_MS]);

    await persistence.flush();
    expect(persistence.dirty).toBe(false);
    const document = JSON.parse(await readFile(path, "utf8")) as SnapshotDocument;
    expect(document.version).toBe(STATE_SCHEMA_VERSION);
    expect(document.games).toHaveLength(1);
    expect(first(document.games).revision).toBe(2);
  });

  test("the debounce writes the file without being asked", async () => {
    const path = await scratch("debounce");
    const persistence = createStatePersistence({ path, logger: silentLogger(), flushDelayMs: 1 });
    persistence.games.create(createGame(presetConfig("tiny", { seed: 1 })));

    await waitFor(() => existsSync(path));
    expect(persistence.dirty).toBe(false);
    // Replaced by rename, so the half-written document never has the real name.
    expect(existsSync(`${path}.tmp`)).toBe(false);
    await persistence.close();
  });

  test("a temporary file left behind by a crash is not read as state", async () => {
    const path = await scratch("stale-tmp");
    await writeFile(`${path}.tmp`, "{ truncated", "utf8");

    const persistence = createStatePersistence({ path, logger: silentLogger() });
    expect((await persistence.restore()).loaded).toBe(false);
    expect(persistence.games.size).toBe(0);
  });

  test("an absent file is simply a first boot", async () => {
    const path = await scratch("absent");
    const { logger, lines } = recordingLogger();
    const persistence = createStatePersistence({ path, logger });

    expect(await persistence.restore()).toEqual({ loaded: false, games: 0, rooms: 0, skipped: [] });
    expect(lines.some((line) => line.includes("no state file to restore"))).toBe(true);
  });

  test("a corrupt file is reported and the server starts empty", async () => {
    const path = await scratch("corrupt");
    await writeFile(path, "{ not json", "utf8");
    const { logger, lines } = recordingLogger();
    const persistence = createStatePersistence({ path, logger });

    expect(await persistence.restore()).toEqual({ loaded: false, games: 0, rooms: 0, skipped: [] });
    expect(persistence.games.size).toBe(0);
    expect(lines.some((line) => line.includes("state file ignored"))).toBe(true);

    // The bad document does not survive: the next write replaces it.
    persistence.games.create(createGame(presetConfig("tiny", { seed: 3 })));
    await persistence.close();
    expect((JSON.parse(await readFile(path, "utf8")) as SnapshotDocument).games).toHaveLength(1);
  });

  test("a file written by another build is not guessed at", async () => {
    const path = await scratch("version");
    await writeFile(
      path,
      JSON.stringify({ version: STATE_SCHEMA_VERSION + 1, savedAt: null, games: [], rooms: [] }),
      "utf8",
    );
    const { logger, lines } = recordingLogger();
    const persistence = createStatePersistence({ path, logger });

    expect((await persistence.restore()).loaded).toBe(false);
    expect(lines.some((line) => line.includes("state file ignored"))).toBe(true);
  });
});

describe("restored records", () => {
  test("one unreadable record does not cost the rest of the file", async () => {
    const path = await scratch("partial");
    const state = await seedSnapshot(path);
    await writeSnapshot(path, state, { rooms: [{ ...first(state.rooms), status: "paused" as never }] });

    const persistence = createStatePersistence({ path, logger: silentLogger() });
    const report = await persistence.restore();
    expect(report.loaded).toBe(true);
    expect(report.rooms).toBe(0);
    expect(report.games).toBe(1);
    expect(report.skipped.join(" ")).toContain("rooms[0].status must be one of ready, playing, won, lost");
  });

  test("a room whose board is gone is dropped, not handed another cube", async () => {
    const path = await scratch("missing-board");
    const state = await seedSnapshot(path);
    await writeSnapshot(path, state, { rooms: [{ ...first(state.rooms), gameId: "00000000-0000-4000-8000-000000000000" }] });

    const persistence = createStatePersistence({ path, logger: silentLogger() });
    const report = await persistence.restore();
    expect(report.rooms).toBe(0);
    expect(report.games).toBe(1);
    expect(report.skipped.join(" ")).toContain("missing board");
  });

  test("nobody is connected after a restart, whatever the file says", async () => {
    const path = await scratch("presence");
    const state = await seedSnapshot(path);
    const room = first(state.rooms);
    await writeSnapshot(path, state, {
      rooms: [{ ...room, players: room.players.map((player) => ({ ...player, connections: 5 })) }],
    });

    const logger = silentLogger();
    const { persistence, games } = stackAt(path, logger);
    await persistence.restore();
    const rooms = createRoomService({ store: persistence.rooms, games, logger });
    expect(rooms.getRoom(room.id).players[0]?.connections).toBe(0);
  });

  test("the advertised tier is re-derived from the mine count", async () => {
    const path = await scratch("tier");
    const state = await seedSnapshot(path);
    const room = first(state.rooms);
    await writeSnapshot(path, state, { rooms: [{ ...room, difficultyId: "easy" as never }] });

    const persistence = createStatePersistence({ path, logger: silentLogger() });
    const loaded = await persistence.restore();
    expect(loaded.rooms).toBe(1);
    expect(persistence.rooms.get(room.id)?.difficultyId).toBe("hard");
  });
});

describe("clocks across a restart", () => {
  /** A co-op room whose countdown has started, saved to disk. */
  async function seedRunningClock(path: string): Promise<{ roomId: string; playerId: string; timeLimitMs: number; clock: { ms: number } }> {
    const clock = { ms: Date.parse("2026-01-01T00:00:00.000Z") };
    const logger = silentLogger();
    const { persistence, games } = stackAt(path, logger);
    const rooms = createRoomService({ store: persistence.rooms, games, logger, now: () => new Date(clock.ms).toISOString() });
    const session = rooms.createRoom({ playerName: "Ada", mode: "coop", presetId: "classic" });
    rooms.reveal(session.room.id, session.player.id, vec3(0, 0, 0));
    const room = rooms.getRoom(session.room.id);
    expect(room.deadlineAt).not.toBeNull();
    await persistence.close();
    return { roomId: session.room.id, playerId: session.player.id, timeLimitMs: room.timeLimitMs, clock };
  }

  test("a countdown that was running resumes where it stopped", async () => {
    const path = await scratch("clock-resume");
    const seed = await seedRunningClock(path);
    seed.clock.ms += 60_000;

    const logger = silentLogger();
    const { persistence, games } = stackAt(path, logger);
    await persistence.restore();
    const timers = timerRecorder();
    const rooms = createRoomService({
      store: persistence.rooms,
      games,
      logger,
      now: () => new Date(seed.clock.ms).toISOString(),
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    expect(timers.armed).toEqual([seed.timeLimitMs - 60_000]);
    seed.clock.ms += seed.timeLimitMs;
    timers.fire();
    expect(rooms.getRoom(seed.roomId).status).toBe("lost");
  });

  test("a countdown that ran out while the server was down ends the round", async () => {
    const path = await scratch("clock-expired");
    const seed = await seedRunningClock(path);
    seed.clock.ms += seed.timeLimitMs + 5_000;

    const logger = silentLogger();
    const { persistence, games } = stackAt(path, logger);
    await persistence.restore();
    const timers = timerRecorder();
    const rooms = createRoomService({
      store: persistence.rooms,
      games,
      logger,
      now: () => new Date(seed.clock.ms).toISOString(),
      scheduleTimer: timers.scheduleTimer,
      clearTimer: timers.clearTimer,
    });

    // Already overdue: the timer is armed for "now", not for a negative delay.
    expect(timers.armed).toEqual([0]);
    timers.fire();
    const room = rooms.getRoom(seed.roomId);
    expect(room.status).toBe("lost");
    expect(room.players.every((player) => player.outcome === "out")).toBe(true);
  });
});
