/**
 * Realtime tests over real WebSockets: welcome frames, fan-out between sockets
 * of the same game, protocol errors that do not kill the connection, and the
 * refusal of upgrades for unknown games.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { GameEvent } from "@minesweeper3d/game-core";
import type { GameDto } from "../src/games/dto";
import {
  connectSocket,
  get,
  postJson,
  refusedUpgrade,
  startTestServer,
  waitFor,
  type TestServer,
  type TestSocket,
} from "./support";

let active: TestServer | undefined;
let sockets: TestSocket[] = [];

afterEach(async () => {
  for (const socket of sockets) socket.close();
  sockets = [];
  await active?.stop();
  active = undefined;
});

async function start(): Promise<TestServer> {
  active = await startTestServer();
  return active;
}

async function connect(server: TestServer, gameId: string): Promise<TestSocket> {
  const socket = await connectSocket(socketUrl(server, gameId));
  sockets.push(socket);
  return socket;
}

function socketUrl(server: TestServer, gameId: string): string {
  return `${server.url.replace(/^http/, "ws")}/api/games/${gameId}/ws`;
}

/** Creates a game over HTTP and returns its DTO. */
async function newGame(server: TestServer, body: unknown = { presetId: "tiny", seed: 1 }): Promise<GameDto> {
  const response = await postJson(`${server.url}/api/games`, body);
  expect(response.status).toBe(201);
  return (response.body as { game: GameDto }).game;
}

/** Narrows a received frame enough to assert on `type` and read fields. */
function frame(value: unknown): Record<string, unknown> & { type: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected a JSON frame, received ${JSON.stringify(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record["type"] !== "string") throw new Error("frame has no type");
  return record as Record<string, unknown> & { type: string };
}

describe("websocket channel", () => {
  test("welcomes a fresh socket with the current game", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);

    const welcome = frame(await socket.next());
    expect(welcome.type).toBe("welcome");
    expect((welcome["game"] as GameDto).id).toBe(game.id);
    expect((welcome["game"] as GameDto).revision).toBe(0);
    expect((welcome["game"] as GameDto).state.cells).toHaveLength(27);
  });

  test("an action sent by one socket reaches every socket of that game", async () => {
    const server = await start();
    const game = await newGame(server);
    const first = await connect(server, game.id);
    const second = await connect(server, game.id);
    expect(frame(await first.next()).type).toBe("welcome");
    expect(frame(await second.next()).type).toBe("welcome");

    first.send({ type: "reveal", cell: { x: 0, y: 0, z: 0 } });

    for (const socket of [first, second]) {
      const update = frame(await socket.next());
      expect(update.type).toBe("update");
      expect((update["game"] as GameDto).revision).toBe(1);
      expect((update["game"] as GameDto).state.status).toBe("playing");
      const events = update["events"] as GameEvent[];
      expect(events.map((event) => event.type)).toEqual(["cellsRevealed"]);
    }
    expect(server.store.get(game.id)?.revision).toBe(1);
  });

  test("an action sent over HTTP reaches every socket of that game", async () => {
    const server = await start();
    const game = await newGame(server);
    const first = await connect(server, game.id);
    const second = await connect(server, game.id);
    expect(frame(await first.next()).type).toBe("welcome");
    expect(frame(await second.next()).type).toBe("welcome");

    // A REST client (or a bot, or a future spectator UI) mutates the game.
    const response = await postJson(`${server.url}/api/games/${game.id}/flag`, {
      cell: { x: 0, y: 0, z: 0 },
    });
    expect(response.status).toBe(200);

    for (const socket of [first, second]) {
      const update = frame(await socket.next());
      expect(update.type).toBe("update");
      expect((update["game"] as GameDto).revision).toBe(1);
      expect((update["events"] as GameEvent[])[0]?.type).toBe("flagChanged");
    }
  });

  test("stops listening to a game once its last socket leaves", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);
    await socket.next();

    socket.close();
    await waitFor(() => server.hub.clientCount(game.id) === 0);

    // Nothing is watching, so an HTTP action must not throw or leak a listener.
    const response = await postJson(`${server.url}/api/games/${game.id}/flag`, {
      cell: { x: 0, y: 0, z: 0 },
    });
    expect(response.status).toBe(200);

    const reconnected = await connect(server, game.id);
    const welcome = frame(await reconnected.next());
    expect(welcome.type).toBe("welcome");
    expect((welcome["game"] as GameDto).state.flagCount).toBe(1);
  });

  test("flags travel over the socket as well", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);
    await socket.next();

    socket.send({ type: "flag", cell: { x: 0, y: 0, z: 0 } });

    const update = frame(await socket.next());
    expect(update.type).toBe("update");
    expect((update["events"] as GameEvent[])[0]?.type).toBe("flagChanged");
    expect(server.store.get(game.id)?.state.flagCount).toBe(1);
  });

  test("ignored actions produce no frame at all", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);
    await socket.next();

    // Revealing a covered, non-exposed cell is a no-op in the engine.
    socket.send({ type: "reveal", cell: { x: 1, y: 1, z: 1 } });
    socket.send({ type: "ping" });

    // The next frame must be the pong, i.e. nothing was broadcast in between.
    expect(frame(await socket.next()).type).toBe("pong");
  });

  test("answers ping with pong", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);
    await socket.next();

    socket.send({ type: "ping" });
    expect(frame(await socket.next()).type).toBe("pong");
  });

  test("reports malformed frames without dropping the socket", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);
    await socket.next();

    socket.send("this is not json");
    const invalidJson = frame(await socket.next());
    expect(invalidJson.type).toBe("error");
    expect(invalidJson["code"]).toBe("invalid_json");

    socket.send({ type: "teleport" });
    const unknownType = frame(await socket.next());
    expect(unknownType["code"]).toBe("invalid_message");

    socket.send({ type: "reveal" });
    const invalidCell = frame(await socket.next());
    expect(invalidCell["code"]).toBe("invalid_cell");
    expect(invalidCell["message"]).toContain("cell");

    socket.send([]);
    expect(frame(await socket.next())["code"]).toBe("invalid_message");

    // The connection is still healthy afterwards.
    socket.send({ type: "ping" });
    expect(frame(await socket.next()).type).toBe("pong");
  });

  test("refuses sockets for unknown games", async () => {
    const server = await start();
    const code = await refusedUpgrade(socketUrl(server, "missing-game"));

    expect(typeof code).toBe("number");
    expect(server.hub.clientCount("missing-game")).toBe(0);
  });

  test("refuses a plain GET on the socket endpoint with 426", async () => {
    const server = await start();
    const game = await newGame(server);
    const result = await get(`${server.url}/api/games/${game.id}/ws`);

    expect(result.status).toBe(426);
    expect(result.headers.get("upgrade")).toBe("websocket");
    expect((result.body as { error: { code: string } }).error.code).toBe("upgrade_required");
  });

  test("404s a socket request for an unknown game, without upgrading", async () => {
    const server = await start();
    const result = await get(`${server.url}/api/games/missing-game/ws`);

    expect(result.status).toBe(404);
    expect((result.body as { error: { code: string } }).error.code).toBe("game_not_found");
  });

  test("tracks the room membership of connected sockets", async () => {
    const server = await start();
    const game = await newGame(server);
    const socket = await connect(server, game.id);
    await socket.next();

    expect(server.hub.clientCount(game.id)).toBe(1);

    socket.close();
    await waitFor(() => server.hub.clientCount(game.id) === 0);
  });
});
