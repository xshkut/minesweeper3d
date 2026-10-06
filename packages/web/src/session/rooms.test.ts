import { describe, expect, test } from "bun:test";
import { createGame, presetConfig, toClientView } from "@minesweeper3d/game-core";
import { createRoomClient } from "./rooms";
import type { FetchLike } from "./remote";

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

interface Harness {
  readonly client: ReturnType<typeof createRoomClient>;
  readonly requests: Recorded[];
  readonly setResponse: (url: string, response: Response) => void;
}

const ROOM_ID = "ROOM01";
const ATTACHMENT = {
  room: {
    id: ROOM_ID,
    name: "Ada's room",
    gameId: "game-1",
    players: [{ id: "p1", name: "Ada", joinedAt: "2026-01-01T00:00:00.000Z", connected: true }],
    maxPlayers: 8,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
  player: { id: "p1", name: "Ada", joinedAt: "2026-01-01T00:00:00.000Z", connected: true },
  game: {
    id: "game-1",
    revision: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state: toClientView(createGame(presetConfig("tiny", { seed: 5 }))),
  },
};

const SUMMARY = {
  id: ROOM_ID,
  name: "Ada's room",
  gameId: "game-1",
  playerCount: 1,
  maxPlayers: 8,
  status: "ready",
  presetId: "tiny",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function createHarness(routes: Record<string, Response> = {}): Harness {
  const requests: Recorded[] = [];
  const table = new Map(Object.entries(routes));
  const fetchStub: FetchLike = async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const response = table.get(url);
    if (response === undefined) throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
    return response;
  };
  return {
    client: createRoomClient({ fetch: fetchStub, baseUrl: "http://lobby.test" }),
    requests,
    setResponse: (url, response) => table.set(url, response),
  };
}

describe("lobby client", () => {
  test("lists rooms", async () => {
    const harness = createHarness({ "http://lobby.test/api/rooms": jsonResponse({ rooms: [SUMMARY] }) });

    const rooms = await harness.client.listRooms();

    expect(rooms).toHaveLength(1);
    expect(rooms[0]?.id).toBe(ROOM_ID);
    expect(harness.requests[0]?.url).toBe("http://lobby.test/api/rooms");
  });

  test("creates a room with only the provided fields", async () => {
    const harness = createHarness({ "http://lobby.test/api/rooms": jsonResponse(ATTACHMENT, 201) });

    const join = await harness.client.createRoom({ playerName: "Ada", presetId: "tiny" });

    expect(join.room.id).toBe(ROOM_ID);
    expect(join.game.state.cells).toHaveLength(27);
    expect(harness.requests[0]?.method).toBe("POST");
    expect(harness.requests[0]?.body).toEqual({ playerName: "Ada", presetId: "tiny" });
  });

  test("normalises the room code when joining", async () => {
    const harness = createHarness({ "http://lobby.test/api/rooms/ROOM01/join": jsonResponse(ATTACHMENT) });

    await harness.client.joinRoom("  room01 ", { playerName: "Grace" });

    expect(harness.requests[0]?.url).toBe("http://lobby.test/api/rooms/ROOM01/join");
    expect(harness.requests[0]?.body).toEqual({ playerName: "Grace" });
  });

  test("surfaces the server error message", async () => {
    const harness = createHarness({
      "http://lobby.test/api/rooms/ROOM01/join": jsonResponse(
        { error: { code: "room_not_found", message: `Room "${ROOM_ID}" does not exist` } },
        404,
      ),
    });

    await expect(harness.client.joinRoom(ROOM_ID)).rejects.toThrow(`Room "${ROOM_ID}" does not exist`);
  });

  test("leaves a room with the player id", async () => {
    const harness = createHarness({ "http://lobby.test/api/rooms/ROOM01/leave": jsonResponse({ ok: true, room: null }) });

    await harness.client.leaveRoom(ROOM_ID, "p1");

    expect(harness.requests[0]?.body).toEqual({ playerId: "p1" });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
