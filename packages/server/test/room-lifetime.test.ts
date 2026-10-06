/**
 * Room lifetime: the sliding TTL, and the sweep that enforces it.
 *
 * The clock is injected, so these tests do not wait a day - they *are* a day
 * later. Two decisions are load-bearing and each has a test: the TTL slides, so
 * that any accepted change restarts it; and it is about staleness rather than
 * emptiness, so a room whose players are still connected but who stopped
 * playing is exactly the room it is for.
 */
import { describe, expect, test } from "bun:test";
import { vec3 } from "@minesweeper3d/game-core";
import { createGameService } from "../src/games/service";
import { createInMemoryGameStore } from "../src/games/store";
import type { GameStore } from "../src/games/store";
import { RoomNotFoundError } from "../src/rooms/errors";
import { createRoomService, ROOM_TTL_MS } from "../src/rooms/service";
import type { RoomService, TimerHandle } from "../src/rooms/service";
import { boardIdsOf, createInMemoryRoomStore } from "../src/rooms/store";
import type { RoomRecord, RoomStore } from "../src/rooms/store";
import { silentLogger } from "./support";

const START = Date.parse("2026-01-01T00:00:00.000Z");
const MINUTE = 60_000;

interface Clock {
  readonly rooms: RoomService;
  readonly roomStore: RoomStore;
  readonly gameStore: GameStore;
  /** Moves the injected wall clock forward. */
  advance(ms: number): void;
  /** Runs every timer the service armed, as the event loop eventually would. */
  fireTimers(): void;
  readonly armed: readonly number[];
}

/** A real room service over in-memory stores with a controllable clock. */
function clock(options: { roomTtlMs?: number; sweepIntervalMs?: number } = {}): Clock {
  const logger = silentLogger();
  const gameStore = createInMemoryGameStore();
  const roomStore = createInMemoryRoomStore();
  let clockMs = START;
  const now = (): string => new Date(clockMs).toISOString();
  const games = createGameService({ store: gameStore, logger, now });

  const timers = new Map<number, () => void>();
  const armed: number[] = [];
  let sequence = 0;

  const rooms = createRoomService({
    store: roomStore,
    games,
    logger,
    now,
    // Spread conditionally: `exactOptionalPropertyTypes` distinguishes an absent
    // option from one that is explicitly `undefined`.
    ...(options.roomTtlMs === undefined ? {} : { roomTtlMs: options.roomTtlMs }),
    ...(options.sweepIntervalMs === undefined ? {} : { sweepIntervalMs: options.sweepIntervalMs }),
    scheduleTimer: (callback, delayMs) => {
      sequence += 1;
      timers.set(sequence, callback);
      armed.push(delayMs);
      return sequence as unknown as TimerHandle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as unknown as number);
    },
  });

  return {
    rooms,
    roomStore,
    gameStore,
    advance(ms) {
      clockMs += ms;
    },
    fireTimers() {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    },
    armed,
  };
}

function storedRoom(test: Clock, roomId: string): RoomRecord {
  const room = test.roomStore.get(roomId);
  if (room === undefined) throw new Error(`unknown room ${roomId}`);
  return room;
}

describe("room TTL", () => {
  test("a room nobody has touched for a day is dropped", () => {
    const test = clock();
    const session = test.rooms.createRoom({ playerName: "Ada" });

    test.advance(ROOM_TTL_MS - 1);
    expect(test.rooms.listRooms().map((room) => room.id)).toEqual([session.room.id]);

    test.advance(1);
    expect(test.rooms.listRooms()).toEqual([]);
    expect(() => test.rooms.getRoom(session.room.id)).toThrow(RoomNotFoundError);
  });

  test("the TTL slides on every change", () => {
    const test = clock();
    const session = test.rooms.createRoom({ playerName: "Ada" });

    test.advance(ROOM_TTL_MS - MINUTE);
    // A mark moves the room no closer to winning, and still counts as a change.
    expect(test.rooms.cycleMark(session.room.id, session.player.id, vec3(0, 0, 1))).toBeDefined();

    test.advance(ROOM_TTL_MS - MINUTE);
    // A day since the room was created, but only a day minus a minute since it
    // was last touched - which is the whole point of a sliding window.
    expect(test.rooms.listRooms().map((room) => room.id)).toEqual([session.room.id]);

    test.advance(MINUTE + 1);
    expect(test.rooms.listRooms()).toEqual([]);
  });

  test("a shorter TTL is configurable", () => {
    const test = clock({ roomTtlMs: 5 * MINUTE });
    const session = test.rooms.createRoom({ playerName: "Ada" });

    test.advance(5 * MINUTE - 1);
    expect(test.rooms.listRooms()).toHaveLength(1);

    test.advance(1);
    expect(test.rooms.listRooms()).toEqual([]);
    expect(test.roomStore.get(session.room.id)).toBeUndefined();
  });

  test("an open socket does not keep a stale room alive", () => {
    const test = clock();
    const session = test.rooms.createRoom({ playerName: "Ada" });
    test.rooms.connect(session.room.id, session.player.id);
    expect(storedRoom(test, session.room.id).players[0]?.connections).toBe(1);

    test.advance(ROOM_TTL_MS);
    expect(test.rooms.listRooms()).toEqual([]);
  });

  test("dropping a room takes its boards with it", () => {
    const test = clock();
    const session = test.rooms.createRoom({ playerName: "Ada", mode: "race" });
    const boards = boardIdsOf(storedRoom(test, session.room.id));
    expect(boards.length).toBeGreaterThan(0);

    test.advance(ROOM_TTL_MS);
    test.rooms.listRooms();

    for (const boardId of boards) expect(test.gameStore.get(boardId)).toBeUndefined();
  });
});

describe("room sweep", () => {
  test("no sweep is armed unless one is asked for", () => {
    const test = clock();
    test.rooms.createRoom({ playerName: "Ada" });
    expect(test.armed).toEqual([]);
  });

  test("the sweep expires rooms without anyone asking for the lobby", () => {
    const test = clock({ sweepIntervalMs: MINUTE });
    const session = test.rooms.createRoom({ playerName: "Ada" });
    expect(test.armed).toEqual([MINUTE]);

    test.advance(ROOM_TTL_MS);
    test.fireTimers();

    expect(test.roomStore.get(session.room.id)).toBeUndefined();
    // The sweep re-arms itself first, so one failure cannot stop the next tick.
    expect(test.armed).toEqual([MINUTE, MINUTE]);
  });

  test("closing the service stops the sweep", () => {
    const test = clock({ sweepIntervalMs: MINUTE });
    const session = test.rooms.createRoom({ playerName: "Ada" });
    test.rooms.close();

    test.advance(ROOM_TTL_MS);
    test.fireTimers();

    // Nothing fired: the pending timer was cleared, so the room is still there.
    expect(test.roomStore.get(session.room.id)).toBeDefined();
    expect(test.rooms.closed).toBe(true);
  });
});
