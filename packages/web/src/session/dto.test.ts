/**
 * Wire-format tests: the lobby renders rooms it did not create, so a room that
 * predates a field must still parse into something usable rather than throwing.
 */
import { describe, expect, test } from "bun:test";
import { parseRoomDto, parseRoomList, parseServerMessage } from "./dto";
import { testRoom, testState } from "../test/fixtures";

describe("parseRoomDto", () => {
  test("reads the match a room is playing", () => {
    const room = parseRoomDto(
      testRoom({ mode: "survival", status: "playing", round: 3, mineCount: 25, difficultyId: "super-hard", difficultyLabel: "Super hard", timeLimitMs: 0, deadlineAt: null }),
    );

    expect(room.mode).toBe("survival");
    expect(room.status).toBe("playing");
    expect(room.round).toBe(3);
    expect(room.mineCount).toBe(25);
    expect(room.difficultyId).toBe("super-hard");
    expect(room.difficultyLabel).toBe("Super hard");
    expect(room.size).toEqual({ x: 3, y: 3, z: 3 });
  });

  test("fills in match fields a plain room never sent", () => {
    const room = parseRoomDto({
      id: "ROOM01",
      name: "Ada's room",
      gameId: "game-1",
      players: [],
      maxPlayers: 8,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(room.mode).toBe("coop");
    expect(room.status).toBe("ready");
    expect(room.round).toBe(1);
    expect(room.mineCount).toBe(0);
    expect(room.difficultyId).toBe("normal");
    expect(room.difficultyLabel).toBe("Normal");
    expect(room.size).toEqual({ x: 0, y: 0, z: 0 });
    expect(room.deadlineAt).toBeNull();
    expect(room.timeLimitMs).toBe(0);
  });

  test("rejects an unknown tier in favour of the default", () => {
    const room = parseRoomDto(testRoom({ difficultyId: "insane" as never }));
    expect(room.difficultyId).toBe("normal");
  });

  test("falls back on the tier's own label when the server omits one", () => {
    const { difficultyLabel: _drop, ...withoutLabel } = testRoom({ difficultyId: "hard" });
    expect(parseRoomDto(withoutLabel).difficultyLabel).toBe("Hard");
  });

  test("lists rooms in a match", () => {
    const rooms = parseRoomList({ rooms: [testRoom({ mode: "race" })] });
    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.mode).toBe("race");
  });
});

describe("parseServerMessage", () => {
  test("carries the board an update belongs to", () => {
    const message = parseServerMessage(
      JSON.stringify({
        type: "update",
        game: { id: "game-1", revision: 1, createdAt: "", updatedAt: "", state: testState() },
        events: [],
        board: "p2",
      }),
    );

    expect(message?.type).toBe("update");
    expect(message?.type === "update" ? message.board : null).toBe("p2");
  });

  test("leaves the board off the board a room shares", () => {
    const message = parseServerMessage(
      JSON.stringify({
        type: "update",
        game: { id: "game-1", revision: 1, createdAt: "", updatedAt: "", state: testState() },
        events: [],
      }),
    );

    expect(message?.type === "update" ? "board" in message : true).toBe(false);
  });

  test("reads where another player is pointing", () => {
    const message = parseServerMessage(
      JSON.stringify({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2, z: 3 } }),
    );

    expect(message).toEqual({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2, z: 3 } });
  });

  test("reads a lifted pointer as no cell", () => {
    const message = parseServerMessage(JSON.stringify({ type: "cursor", playerId: "p2", cell: null }));

    expect(message).toEqual({ type: "cursor", playerId: "p2", cell: null });
  });

  test("a half-read cell is no cell, not the cell at the origin", () => {
    const message = parseServerMessage(JSON.stringify({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2 } }));

    // Drawing a pointer at (0,0,0) because the frame was malformed would put a
    // marker in a cell nobody chose.
    expect(message).toEqual({ type: "cursor", playerId: "p2", cell: null });
  });

  test("a pointer with nobody attached is dropped", () => {
    expect(parseServerMessage(JSON.stringify({ type: "cursor", cell: { x: 1, y: 2, z: 3 } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "cursor", playerId: "", cell: null }))).toBeNull();
  });
});
