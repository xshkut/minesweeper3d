/**
 * Rooms: the multiplayer shell around a game.
 *
 * These tests exercise the whole path - HTTP create/join/leave/restart plus the
 * room WebSocket - against a real listener, because the point of the module is
 * that presence and board updates reach the *other* players. They also pin the
 * two promises the client relies on: a room always answers with a redacted game,
 * and a reveal from one seat is seen by every other seat.
 */
import { describe, expect, test } from "bun:test";
import { connectSocket, get, postJson, refusedUpgrade, startTestServer, waitFor } from "./support";
import type { TestServer, TestSocket } from "./support";

/** Deterministic room codes; the last entry repeats once exhausted. */
function roomCodes(...codes: string[]): () => string {
  let index = 0;
  return () => codes[Math.min(index++, codes.length - 1)] ?? "AAAAAA";
}

/** Deterministic player ids. */
function playerIds(...ids: string[]): () => string {
  let index = 0;
  return () => ids[Math.min(index++, ids.length - 1)] ?? "player-x";
}

interface RoomBody {
  readonly room: {
    id: string;
    name: string;
    gameId: string;
    mode: string;
    status: string;
    round: number;
    difficultyId: string;
    difficultyLabel: string;
    mineCount: number;
    players: readonly { id: string; name: string; connected: boolean }[];
    maxPlayers: number;
  };
  readonly player: { id: string; name: string };
  readonly game: {
    id: string;
    revision: number;
    state: { status: string; cells: readonly unknown[]; config: unknown };
  };
}

function asRoomBody(body: unknown): RoomBody {
  return body as RoomBody;
}

/** Reads frames until one has the wanted `type`; other frames are skipped. */
async function nextOfType(socket: TestSocket, type: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const frame = (await socket.next()) as Record<string, unknown>;
    if (frame["type"] === type) return frame;
  }
  throw new Error(`never received a "${type}" frame`);
}

function socketUrl(server: TestServer, roomId: string, playerId?: string): string {
  const base = server.url.replace(/^http/, "ws");
  const query = playerId === undefined ? "" : `?player=${playerId}`;
  return `${base}/api/rooms/${roomId}/ws${query}`;
}

describe("rooms over HTTP", () => {
  test("creates a room with its game and seats the host", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("ABC234"),
      generateId: playerIds("player-1"),
    });
    try {
      const response = await postJson(`${server.url}/api/rooms`, {
        presetId: "tiny",
        playerName: "Ada",
        name: "Ada's den",
      });

      expect(response.status).toBe(201);
      const { room, player, game } = asRoomBody(response.body);
      expect(room.id).toBe("ABC234");
      expect(room.name).toBe("Ada's den");
      expect(room.gameId).toBe(game.id);
      expect(room.maxPlayers).toBe(8);
      expect(room.players).toHaveLength(1);
      expect(room.players[0]).toMatchObject({ id: "player-1", name: "Ada", connected: false });
      expect(player).toMatchObject({ id: "player-1", name: "Ada" });

      // The board is the tiny preset, and mines never leave the server.
      expect(game.revision).toBe(0);
      expect(game.state.status).toBe("ready");
      expect(game.state.cells).toHaveLength(27);
      expect(server.store.get(game.id)?.state.cells.some((cell) => cell.hasMine)).toBe(true);
      for (const cell of game.state.cells) {
        expect((cell as { hasMine?: boolean }).hasMine).toBe(false);
        expect((cell as { danger?: number }).danger).toBeUndefined();
      }
    } finally {
      await server.stop();
    }
  });

  test("accepts a bodyless create with defaults", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("DEF567") });
    try {
      const response = await postJson(`${server.url}/api/rooms`);
      expect(response.status).toBe(201);
      const { room } = asRoomBody(response.body);
      expect(room.id).toBe("DEF567");
      expect(room.name).toBe("Player's room");
      expect(room.players[0]?.name).toBe("Player");
    } finally {
      await server.stop();
    }
  });

  test("lists open rooms with their player count and preset", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("AAA111", "BBB222") });
    try {
      await postJson(`${server.url}/api/rooms`, { presetId: "tiny", name: "First" });
      const second = asRoomBody(
        (await postJson(`${server.url}/api/rooms`, { presetId: "medium", name: "Second" })).body,
      );
      await postJson(`${server.url}/api/rooms/${second.room.id}/join`, { playerName: "Grace" });

      const listed = (await get(`${server.url}/api/rooms`)).body as {
        rooms: readonly { id: string; name: string; playerCount: number; presetId: string; status: string }[];
      };
      expect(listed.rooms.map((room) => room.id)).toEqual(["AAA111", "BBB222"]);
      expect(listed.rooms[0]).toMatchObject({ name: "First", playerCount: 1, presetId: "tiny", status: "ready" });
      expect(listed.rooms[1]).toMatchObject({ name: "Second", playerCount: 2, presetId: "medium" });
    } finally {
      await server.stop();
    }
  });

  test("joins an existing room as a second player", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("JOIN01"),
      generateId: playerIds("host", "guest"),
    });
    try {
      const created = asRoomBody((await postJson(`${server.url}/api/rooms`, { playerName: "Ada" })).body);
      const joined = await postJson(`${server.url}/api/rooms/JOIN01/join`, { playerName: "Grace" });

      expect(joined.status).toBe(200);
      const session = asRoomBody(joined.body);
      expect(session.room.id).toBe(created.room.id);
      expect(session.player).toMatchObject({ id: "guest", name: "Grace" });
      expect(session.room.players.map((player) => player.name)).toEqual(["Ada", "Grace"]);
      expect(session.game.id).toBe(created.game.id);
    } finally {
      await server.stop();
    }
  });

  test("reclaims a seat when a returning player presents their id", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("BACK01"),
      generateId: playerIds("host", "ignored"),
    });
    try {
      const created = asRoomBody((await postJson(`${server.url}/api/rooms`, { playerName: "Ada" })).body);
      const rejoined = asRoomBody(
        (
          await postJson(`${server.url}/api/rooms/BACK01/join`, {
            playerName: "Ada",
            playerId: created.player.id,
          })
        ).body,
      );

      expect(rejoined.room.players).toHaveLength(1);
      expect(rejoined.room.players[0]).toMatchObject({ id: "host", name: "Ada" });
    } finally {
      await server.stop();
    }
  });

  test("reports unknown rooms, full rooms and unknown players", async () => {
    const full = await startTestServer({
      generateRoomId: roomCodes("FULL01"),
      generateId: playerIds("host"),
      maxPlayers: 1,
    });
    try {
      const missing = await postJson(`${full.url}/api/rooms/NOPE00/join`, { playerName: "Nobody" });
      expect(missing.status).toBe(404);
      expect((missing.body as { error: { code: string } }).error.code).toBe("room_not_found");

      await postJson(`${full.url}/api/rooms`, { playerName: "Ada" });
      const rejected = await postJson(`${full.url}/api/rooms/FULL01/join`, { playerName: "Grace" });
      expect(rejected.status).toBe(409);
      expect((rejected.body as { error: { code: string } }).error.code).toBe("room_full");

      const kick = await postJson(`${full.url}/api/rooms/FULL01/leave`, { playerId: "not-seated" });
      expect(kick.status).toBe(403);
      expect((kick.body as { error: { code: string } }).error.code).toBe("unknown_player");
    } finally {
      await full.stop();
    }
  });

  test("restarts the board in place, keeping the room code", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("REST01") });
    try {
      const created = asRoomBody((await postJson(`${server.url}/api/rooms`, { presetId: "tiny" })).body);
      const restarted = await postJson(`${server.url}/api/rooms/REST01/restart`, { presetId: "tiny", seed: 99 });

      expect(restarted.status).toBe(200);
      const { room, game } = asRoomBody(restarted.body);
      expect(room.id).toBe("REST01");
      expect(room.gameId).toBe(game.id);
      expect(game.id).not.toBe(created.game.id);
      expect(game.revision).toBe(0);
      expect(game.state.cells).toHaveLength(27);
      expect(server.service.getGame(game.id).state.config.seed).toBe(99);

      const fetched = (await get(`${server.url}/api/rooms/REST01`)).body as { room: { gameId: string } };
      expect(fetched.room.gameId).toBe(game.id);
    } finally {
      await server.stop();
    }
  });

  test("rejects unknown presets when creating a room", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("BADP01") });
    try {
      const response = await postJson(`${server.url}/api/rooms`, { presetId: "gigantic" });
      expect(response.status).toBe(400);
      expect((response.body as { error: { code: string } }).error.code).toBe("unknown_preset");
    } finally {
      await server.stop();
    }
  });

  test("creates a room in a match mode with a density-derived mine count", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("SURV01") });
    try {
      const response = await postJson(`${server.url}/api/rooms`, {
        mode: "survival",
        presetId: "classic",
        difficultyId: "super-hard",
        playerName: "Ada",
      });

      expect(response.status).toBe(201);
      const { room, game } = asRoomBody(response.body);
      expect(room.mode).toBe("survival");
      expect(room.status).toBe("ready");
      expect(room.round).toBe(1);
      expect(room.difficultyId).toBe("super-hard");
      expect(room.difficultyLabel).toBe("Super hard");
      // 20% of a 5x5x5 cube.
      expect(room.mineCount).toBe(25);
      // Survival spends mines instead of ending the board, and that rule comes
      // from the mode rather than the request body.
      expect((game.state.config as { minesFatal: boolean }).minesFatal).toBe(false);
    } finally {
      await server.stop();
    }
  });

  test("labels a hand-picked mine count by what it actually is", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("EASY01") });
    try {
      const { room } = asRoomBody(
        (await postJson(`${server.url}/api/rooms`, { presetId: "classic", difficultyId: "hard", mineCount: 2 })).body,
      );

      // Two mines on 125 cells is not "hard" just because the caller said so.
      expect(room.mineCount).toBe(2);
      expect(room.difficultyId).toBe("easy");
    } finally {
      await server.stop();
    }
  });

  test("rejects an unknown mode or difficulty tier", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("BADM01") });
    try {
      const badMode = await postJson(`${server.url}/api/rooms`, { mode: "battle-royale" });
      expect(badMode.status).toBe(400);
      expect((badMode.body as { error: { code: string } }).error.code).toBe("invalid_body");

      const badTier = await postJson(`${server.url}/api/rooms`, { difficultyId: "brutal" });
      expect(badTier.status).toBe(400);
      expect((badTier.body as { error: { code: string } }).error.code).toBe("invalid_body");
    } finally {
      await server.stop();
    }
  });

  test("lists a room's mode and mine tier for the lobby", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("LIST01") });
    try {
      await postJson(`${server.url}/api/rooms`, { mode: "race", presetId: "tiny", difficultyId: "hard" });

      const listed = (await get(`${server.url}/api/rooms`)).body as {
        rooms: readonly { mode: string; difficultyId: string; difficultyLabel: string; mineCount: number; size: unknown }[];
      };
      expect(listed.rooms[0]).toMatchObject({
        mode: "race",
        difficultyId: "hard",
        difficultyLabel: "Hard",
        size: { x: 3, y: 3, z: 3 },
      });
    } finally {
      await server.stop();
    }
  });

  test("grants the free reveals a room asks for and reports the budget", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("AID0001") });
    try {
      const created = await postJson(`${server.url}/api/rooms`, {
        playerName: "Ada",
        presetId: "tiny",
        freeReveals: 3,
      });
      expect(created.status).toBe(201);
      const body = created.body as {
        room: { freeReveals: number };
        game: { state: { config: { freeReveals: number }; freeRevealsLeft: number } };
      };
      expect(body.room.freeReveals).toBe(3);
      // The room mirrors its config, and the board is the thing that spends it.
      expect(body.game.state.config.freeReveals).toBe(3);
      expect(body.game.state.freeRevealsLeft).toBe(3);
    } finally {
      await server.stop();
    }
  });

  test("leaves the aid off when a room does not ask for it", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("NOAID1") });
    try {
      const created = await postJson(`${server.url}/api/rooms`, { playerName: "Ada", presetId: "tiny" });
      const body = created.body as { room: { freeReveals: number }; game: { state: { freeRevealsLeft: number } } };
      expect(body.room.freeReveals).toBe(0);
      expect(body.game.state.freeRevealsLeft).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test("rejects a free reveal count the board cannot use", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("BADAID") });
    try {
      // A tiny cube has 27 cells, so 28 charges can never be spent.
      const tooMany = await postJson(`${server.url}/api/rooms`, { presetId: "tiny", freeReveals: 28 });
      expect(tooMany.status).toBe(400);
      expect(tooMany.body).toMatchObject({ error: { code: "invalid_config" } });

      const fractional = await postJson(`${server.url}/api/rooms`, { presetId: "tiny", freeReveals: 1.5 });
      expect(fractional.status).toBe(400);
      expect(fractional.body).toMatchObject({ error: { code: "invalid_config" } });
    } finally {
      await server.stop();
    }
  });

  test("keeps a restart's free reveals when the body says nothing about them", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("AIDKEEP"),
      generateId: playerIds("host"),
    });
    try {
      await postJson(`${server.url}/api/rooms`, { playerName: "Ada", presetId: "tiny", freeReveals: 2 });
      const restarted = await postJson(`${server.url}/api/rooms/AIDKEEP/restart`, { playerId: "host" });
      const body = restarted.body as { room: { freeReveals: number; round: number } };
      expect(body.room.freeReveals).toBe(2);
      expect(body.room.round).toBe(2);

      // An explicit count still wins over what the room was playing with.
      const changed = await postJson(`${server.url}/api/rooms/AIDKEEP/restart`, {
        playerId: "host",
        freeReveals: 0,
      });
      expect((changed.body as { room: { freeReveals: number } }).room.freeReveals).toBe(0);
    } finally {
      await server.stop();
    }
  });

  test("keeps a private room out of the lobby but joins it by code", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("PUBLIC01", "PRIV0001") });
    try {
      await postJson(`${server.url}/api/rooms`, { playerName: "Ada" });
      const secret = await postJson(`${server.url}/api/rooms`, {
        playerName: "Ada",
        visibility: "private",
      });
      expect(secret.status).toBe(201);
      expect((secret.body as { room: { visibility: string } }).room.visibility).toBe("private");

      const listed = (await get(`${server.url}/api/rooms`)).body as {
        rooms: readonly { id: string; visibility: string }[];
      };
      expect(listed.rooms.map((room) => room.id)).toEqual(["PUBLIC01"]);
      expect(listed.rooms[0]?.visibility).toBe("public");

      // Unlisted is not locked: the code is still a way in.
      const joined = await postJson(`${server.url}/api/rooms/PRIV0001/join`, { playerName: "Bo" });
      expect(joined.status).toBe(200);
      expect((joined.body as { room: { players: readonly unknown[] } }).room.players).toHaveLength(2);
    } finally {
      await server.stop();
    }
  });

  test("rejects an unknown visibility", async () => {
    const server = await startTestServer({ generateRoomId: roomCodes("VIS001") });
    try {
      const response = await postJson(`${server.url}/api/rooms`, { visibility: "secret" });
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        error: { code: "invalid_body", details: ["visibility must be one of public, private"] },
      });
    } finally {
      await server.stop();
    }
  });

  test("generates room codes long enough to resist guessing", async () => {
    const server = await startTestServer();
    try {
      const codes: string[] = [];
      for (let index = 0; index < 8; index += 1) {
        const created = await postJson(`${server.url}/api/rooms`, { playerName: "Ada" });
        codes.push((created.body as { room: { id: string } }).room.id);
      }

      // Ten characters, and never a glyph that reads as another one (0/O, 1/I/L).
      for (const code of codes) {
        expect(code).toMatch(/^[A-HJ-KM-NP-Z2-9]{10}$/);
      }
      expect(new Set(codes).size).toBe(codes.length);
    } finally {
      await server.stop();
    }
  });

  test("closes the room when its last player leaves", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("LAST01"),
      generateId: playerIds("solo"),
    });
    try {
      await postJson(`${server.url}/api/rooms`, { playerName: "Ada" });
      const left = await postJson(`${server.url}/api/rooms/LAST01/leave`, { playerId: "solo" });
      expect(left.status).toBe(200);
      expect((left.body as { room: unknown }).room).toBeNull();

      expect((await get(`${server.url}/api/rooms/LAST01`)).status).toBe(404);
      expect(server.roomStore.size).toBe(0);
    } finally {
      await server.stop();
    }
  });
});

describe("rooms over the socket", () => {
  test("welcomes a player with the room, the board and their seat", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("WS0001"),
      generateId: playerIds("host"),
    });
    try {
      const created = asRoomBody((await postJson(`${server.url}/api/rooms`, { presetId: "tiny" })).body);
      const socket = await connectSocket(socketUrl(server, "WS0001", "host"));
      try {
        const welcome = await nextOfType(socket, "welcome");
        expect((welcome["game"] as { id: string }).id).toBe(created.game.id);
        expect(welcome["playerId"]).toBe("host");
        expect((welcome["room"] as { id: string }).id).toBe("WS0001");
        expect(
          (welcome["room"] as { players: readonly { connected: boolean }[] }).players[0]?.connected,
        ).toBe(true);
      } finally {
        socket.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("relays a reveal from one seat to every other seat", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("WS0002"),
      generateId: playerIds("host", "guest"),
    });
    try {
      // A fixed seed and an explicit mine count keep the flood fill
      // deterministic: the reveal opens the origin plus whatever safe cells
      // cascade from it, so assert membership, not an exact event count.
      await postJson(`${server.url}/api/rooms`, { presetId: "tiny", mineCount: 3, seed: 7 });
      await postJson(`${server.url}/api/rooms/WS0002/join`, { playerName: "Grace" });
      const host = await connectSocket(socketUrl(server, "WS0002", "host"));
      const guest = await connectSocket(socketUrl(server, "WS0002", "guest"));
      try {
        await nextOfType(host, "welcome");
        await nextOfType(guest, "welcome");

        host.send({ type: "reveal", cell: { x: 0, y: 0, z: 0 } });
        const update = await nextOfType(guest, "update");
        expect((update["game"] as { revision: number }).revision).toBe(1);
        expect(update["actor"]).toBe("host");
        const events = update["events"] as readonly {
          type: string;
          cells: readonly { x: number; y: number; z: number }[];
        }[];
        const revealed = events
          .filter((event) => event.type === "cellsRevealed")
          .flatMap((event) => event.cells);
        expect(revealed).toContainEqual({ x: 0, y: 0, z: 0 });
      } finally {
        host.close();
        guest.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("announces presence when another player joins and when one leaves", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("WS0003"),
      generateId: playerIds("host", "guest"),
    });
    try {
      await postJson(`${server.url}/api/rooms`, { playerName: "Ada" });
      const host = await connectSocket(socketUrl(server, "WS0003", "host"));
      try {
        await nextOfType(host, "welcome");

        // Joining over HTTP must reach the already-connected host.
        await postJson(`${server.url}/api/rooms/WS0003/join`, { playerName: "Grace" });
        const joined = await nextOfType(host, "room");
        expect((joined["room"] as { players: readonly unknown[] }).players).toHaveLength(2);

        const guest = await connectSocket(socketUrl(server, "WS0003", "guest"));
        await nextOfType(guest, "welcome");
        await waitFor(() => server.rooms.getRoom("WS0003").players.every((player) => player.connections > 0));
        guest.close();

        await waitFor(() =>
          server.rooms.getRoom("WS0003").players.some((player) => player.name === "Grace" && player.connections === 0),
        );
      } finally {
        host.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("pushes the new board to connected players when the host restarts", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("WS0004"),
      generateId: playerIds("host"),
    });
    try {
      const created = asRoomBody((await postJson(`${server.url}/api/rooms`, { presetId: "tiny" })).body);
      const socket = await connectSocket(socketUrl(server, "WS0004", "host"));
      try {
        await nextOfType(socket, "welcome");

        const restarted = asRoomBody((await postJson(`${server.url}/api/rooms/WS0004/restart`, {})).body);
        const update = await nextOfType(socket, "update");
        expect((update["game"] as { id: string }).id).toBe(restarted.game.id);
        expect((update["game"] as { id: string }).id).not.toBe(created.game.id);
      } finally {
        socket.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("refuses unknown rooms, unknown players and plain GETs", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("WS0005"),
      generateId: playerIds("host"),
    });
    try {
      await postJson(`${server.url}/api/rooms`, {});

      // Unknown room code.
      expect(await refusedUpgrade(socketUrl(server, "NOPE99"))).toBeGreaterThan(0);
      // Known room, but the socket claims a seat the room does not have.
      expect(await refusedUpgrade(socketUrl(server, "WS0005", "ghost"))).toBeGreaterThan(0);

      const plain = await get(`${server.url}/api/rooms/WS0005/ws`);
      expect(plain.status).toBe(426);
      expect(plain.headers.get("upgrade")).toBe("websocket");
    } finally {
      await server.stop();
    }
  });
});

/**
 * Frames a socket received, for the assertions of the shape "nothing was sent".
 *
 * `TestSocket.next` skips frames it does not want, which is exactly what a
 * negative assertion must not do.
 */
function recordFrames(socket: TestSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  socket.socket.addEventListener("message", (event) => {
    frames.push(JSON.parse(String(event.data)) as Record<string, unknown>);
  });
  return frames;
}

describe("room cursors over the socket", () => {
  const cursorsOf = (frames: readonly Record<string, unknown>[]): Record<string, unknown>[] =>
    frames.filter((frame) => frame["type"] === "cursor");

  /**
   * Creates a two-seat room and connects both seats.
   *
   * @returns both sockets, already past their `welcome` frame
   */
  async function twoSeatRoom(
    server: TestServer,
    roomId: string,
    hostId = "host",
    guestId = "guest",
  ): Promise<{ readonly host: TestSocket; readonly guest: TestSocket }> {
    await postJson(`${server.url}/api/rooms`, { presetId: "tiny" });
    await postJson(`${server.url}/api/rooms/${roomId}/join`, { playerName: "Grace" });
    const host = await connectSocket(socketUrl(server, roomId, hostId));
    const guest = await connectSocket(socketUrl(server, roomId, guestId));
    await nextOfType(host, "welcome");
    await nextOfType(guest, "welcome");
    return { host, guest };
  }

  test("relays a pointer to the other seats but not back to the mover", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("CUR001"),
      generateId: playerIds("host", "guest"),
    });
    try {
      const { host, guest } = await twoSeatRoom(server, "CUR001");
      try {
        const hostFrames = recordFrames(host);
        const guestFrames = recordFrames(guest);

        host.send({ type: "cursor", cell: { x: 1, y: 2, z: 0 } });

        await waitFor(() => cursorsOf(guestFrames).length === 1);
        expect(cursorsOf(guestFrames)[0]).toEqual({
          type: "cursor",
          playerId: "host",
          cell: { x: 1, y: 2, z: 0 },
        });

        // A ping round-trip is the fence: frames keep their per-socket order,
        // so anything the server sent to the host before the pong has arrived.
        host.send({ type: "ping" });
        await waitFor(() => hostFrames.some((frame) => frame["type"] === "pong"));
        expect(cursorsOf(hostFrames)).toEqual([]);
      } finally {
        host.close();
        guest.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("travels as null when a player stops pointing", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("CUR002"),
      generateId: playerIds("host", "guest"),
    });
    try {
      const { host, guest } = await twoSeatRoom(server, "CUR002");
      try {
        const hostFrames = recordFrames(host);
        const guestFrames = recordFrames(guest);

        host.send({ type: "cursor", cell: { x: 0, y: 0, z: 0 } });
        await waitFor(() => cursorsOf(guestFrames).length === 1);

        host.send({ type: "cursor", cell: null });
        await waitFor(() => cursorsOf(guestFrames).length === 2);
        expect(cursorsOf(guestFrames)[1]).toEqual({ type: "cursor", playerId: "host", cell: null });

        // Clearing twice has nothing left to clear, so the room hears it once.
        host.send({ type: "cursor", cell: null });
        host.send({ type: "ping" });
        await waitFor(() => hostFrames.some((frame) => frame["type"] === "pong"));
        expect(cursorsOf(guestFrames)).toHaveLength(2);
      } finally {
        host.close();
        guest.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("does not repeat a pointer that has not moved", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("CUR003"),
      generateId: playerIds("host", "guest"),
    });
    try {
      const { host, guest } = await twoSeatRoom(server, "CUR003");
      try {
        const hostFrames = recordFrames(host);
        const guestFrames = recordFrames(guest);

        host.send({ type: "cursor", cell: { x: 2, y: 1, z: 1 } });
        host.send({ type: "cursor", cell: { x: 2, y: 1, z: 1 } });
        host.send({ type: "ping" });
        await waitFor(() => hostFrames.some((frame) => frame["type"] === "pong"));

        expect(cursorsOf(guestFrames)).toHaveLength(1);
      } finally {
        host.close();
        guest.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("replays the pointer a late joiner missed", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("CUR004"),
      generateId: playerIds("host", "guest"),
    });
    try {
      await postJson(`${server.url}/api/rooms`, { presetId: "tiny" });
      const host = await connectSocket(socketUrl(server, "CUR004", "host"));
      try {
        await nextOfType(host, "welcome");
        host.send({ type: "cursor", cell: { x: 0, y: 0, z: 1 } });
        host.send({ type: "ping" });
        await nextOfType(host, "pong");

        // Only now is a second seat seated, so the pointer above predates it.
        await postJson(`${server.url}/api/rooms/CUR004/join`, { playerName: "Grace" });
        const guest = await connectSocket(socketUrl(server, "CUR004", "guest"));
        try {
          await nextOfType(guest, "welcome");
          expect(await nextOfType(guest, "cursor")).toEqual({
            type: "cursor",
            playerId: "host",
            cell: { x: 0, y: 0, z: 1 },
          });
        } finally {
          guest.close();
        }
      } finally {
        host.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("ignores a pointer from a socket that holds no seat", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("CUR005"),
      generateId: playerIds("host"),
    });
    try {
      await postJson(`${server.url}/api/rooms`, { presetId: "tiny" });
      const host = await connectSocket(socketUrl(server, "CUR005", "host"));
      const spectator = await connectSocket(socketUrl(server, "CUR005"));
      try {
        await nextOfType(host, "welcome");
        await nextOfType(spectator, "welcome");
        const hostFrames = recordFrames(host);

        spectator.send({ type: "cursor", cell: { x: 0, y: 0, z: 0 } });
        spectator.send({ type: "ping" });
        // The spectator's own pong proves the pointer frame was processed
        // before the host even asked; a relay would already be on its way.
        await nextOfType(spectator, "pong");
        host.send({ type: "ping" });
        await waitFor(() => hostFrames.some((frame) => frame["type"] === "pong"));

        expect(cursorsOf(hostFrames)).toEqual([]);
      } finally {
        host.close();
        spectator.close();
      }
    } finally {
      await server.stop();
    }
  });

  test("clears the pointer of a player whose last socket closes", async () => {
    const server = await startTestServer({
      generateRoomId: roomCodes("CUR006"),
      generateId: playerIds("host", "guest"),
    });
    try {
      const { host, guest } = await twoSeatRoom(server, "CUR006");
      try {
        const hostFrames = recordFrames(host);

        guest.send({ type: "cursor", cell: { x: 2, y: 2, z: 2 } });
        await waitFor(() => cursorsOf(hostFrames).some((frame) => frame["cell"] !== null));

        guest.close();
        await waitFor(() =>
          cursorsOf(hostFrames).some((frame) => frame["playerId"] === "guest" && frame["cell"] === null),
        );
      } finally {
        host.close();
      }
    } finally {
      await server.stop();
    }
  });
});
