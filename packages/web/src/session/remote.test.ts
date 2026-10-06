import { describe, expect, test } from "bun:test";
import { createGame, presetConfig, revealCell, toClientView } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { createRemoteSession } from "./remote";
import type { FetchLike, SocketLike } from "./remote";
import type { GameSession } from "./types";
import type { PlayerDto, RoomDto, RoomJoinDto } from "./dto";
import { testPlayer, testRoom } from "../test/fixtures";

/** A scriptable stand-in for a browser WebSocket. */
class FakeSocket implements SocketLike {
  readonly sent: string[] = [];
  closed = false;
  onOpen: (() => void) | null = null;
  onMessage: ((data: string) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: ((error: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.onOpen?.();
  }

  emitMessage(payload: unknown): void {
    this.onMessage?.(JSON.stringify(payload));
  }

  emitClose(): void {
    this.onClose?.();
  }
}

interface Harness {
  readonly session: GameSession;
  readonly sockets: FakeSocket[];
  readonly requests: { readonly url: string; readonly method: string; readonly body: string }[];
}

interface HarnessOptions {
  readonly respond?: (url: string, init: RequestInit | undefined) => Response;
}

/** Builds a remote session wired to fakes, mirroring the server contract. */
function createHarness(options: HarnessOptions = {}): Harness {
  const sockets: FakeSocket[] = [];
  const requests: { url: string; method: string; body: string }[] = [];
  let state = createGame(presetConfig("tiny", { seed: 5 }));

  const fetchStub: FetchLike = async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (options.respond !== undefined) return options.respond(url, init);
    if (url.endsWith("/api/games")) {
      const request = JSON.parse(String(init?.body ?? "{}")) as { presetId?: string };
      state = createGame(presetConfig(request.presetId ?? "tiny", { seed: 5 }));
      return jsonResponse({ game: gameDto(toClientView(state)) });
    }
    if (url.endsWith("/reveal")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { cell: CellIndex };
      const transition = revealCell(state, body.cell);
      state = transition.state;
      return jsonResponse({ game: gameDto(toClientView(transition.state)), events: transition.events });
    }
    return jsonResponse({ error: { code: "not_found", message: `no route for ${url}` } }, 404);
  };

  const session = createRemoteSession({
    presetId: "tiny",
    deps: {
      fetch: fetchStub,
      openSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      baseUrl: "http://game.test",
      reconnectBaseMs: 1,
    },
  });

  return { session, sockets, requests };
}

describe("remote session", () => {
  test("starts loading, creates a game and connects the socket", async () => {
    const harness = createHarness();
    expect(harness.session.getSnapshot().phase).toBe("loading");
    expect(harness.session.getSnapshot().state).toBeNull();

    await waitFor(() => harness.session.getSnapshot().phase === "ready");

    const ready = harness.session.getSnapshot();
    expect(ready.kind).toBe("remote");
    expect(ready.state?.cells).toHaveLength(27);
    expect(ready.connected).toBe(false);
    expect(harness.requests[0]?.url).toBe("http://game.test/api/games");

    const socket = harness.sockets[0];
    expect(socket?.url).toBe("ws://game.test/api/games/game-1/ws");

    socket?.emitOpen();
    expect(harness.session.getSnapshot().connected).toBe(true);

    harness.session.dispose();
  });

  test("reveals over the socket once it is open", async () => {
    const harness = createHarness();
    await waitFor(() => harness.sockets.length === 1);
    harness.sockets[0]?.emitOpen();

    harness.session.reveal({ x: 0, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent).toEqual([JSON.stringify({ type: "reveal", cell: { x: 0, y: 0, z: 0 } })]);

    harness.session.cycleMark({ x: 1, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent[1]).toBe(JSON.stringify({ type: "mark", cell: { x: 1, y: 0, z: 0 } }));

    harness.session.probe({ x: 2, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent[2]).toBe(JSON.stringify({ type: "probe", cell: { x: 2, y: 0, z: 0 } }));

    harness.session.dispose();
  });

  test("falls back to HTTP while the socket is not open and applies the response", async () => {
    const harness = createHarness();
    await waitFor(() => harness.session.getSnapshot().phase === "ready");

    harness.session.reveal({ x: 0, y: 0, z: 0 });
    await waitFor(() => (harness.session.getSnapshot().state?.revealedCount ?? 0) > 0);

    const post = harness.requests.find((request) => request.url.endsWith("/reveal"));
    expect(post?.method).toBe("POST");
    expect(JSON.parse(post?.body ?? "{}")).toEqual({ cell: { x: 0, y: 0, z: 0 } });
    expect(harness.session.getSnapshot().state?.status).toBe("playing");

    harness.session.dispose();
  });

  test("an unreachable server lands in phase error with a readable message", async () => {
    const harness = createHarness({
      respond: () => jsonResponse({ error: { code: "bad_request", message: "preset unknown" } }, 400),
    });

    await waitFor(() => harness.session.getSnapshot().phase === "error");
    const snapshot = harness.session.getSnapshot();
    expect(snapshot.state).toBeNull();
    expect(snapshot.error).toContain("preset unknown");

    harness.session.dispose();
  });

  test("a network failure is reported instead of thrown", async () => {
    const session = createRemoteSession({
      presetId: "tiny",
      deps: {
        fetch: () => Promise.reject(new Error("connect ECONNREFUSED")),
        openSocket: () => new FakeSocket("ws://unused"),
        baseUrl: "http://game.test",
      },
    });

    await waitFor(() => session.getSnapshot().phase === "error");
    expect(session.getSnapshot().error).toContain("ECONNREFUSED");
    session.dispose();
  });

  test("socket updates are applied to the snapshot", async () => {
    const harness = createHarness();
    await waitFor(() => harness.sockets.length === 1);
    harness.sockets[0]?.emitOpen();

    const before = harness.session.getSnapshot();
    const played = revealCell(createGame(presetConfig("tiny", { seed: 5 })), { x: 0, y: 0, z: 0 });
    harness.sockets[0]?.emitMessage({
      type: "update",
      game: gameDto(toClientView(played.state)),
      events: played.events,
    });

    const after = harness.session.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.state?.status).toBe("playing");
    expect(harness.session.lastEvents?.length).toBeGreaterThan(0);

    harness.session.dispose();
  });

  test("a closed socket is reconnected with a backoff", async () => {
    const harness = createHarness();
    await waitFor(() => harness.sockets.length === 1);
    harness.sockets[0]?.emitOpen();
    expect(harness.session.getSnapshot().connected).toBe(true);

    harness.sockets[0]?.emitClose();
    expect(harness.session.getSnapshot().connected).toBe(false);

    await waitFor(() => harness.sockets.length === 2);
    expect(harness.sockets[1]?.url).toBe("ws://game.test/api/games/game-1/ws");

    harness.session.dispose();
  });

  test("server error frames are surfaced without dropping the board", async () => {
    const harness = createHarness();
    await waitFor(() => harness.sockets.length === 1);
    harness.sockets[0]?.emitMessage({ type: "error", code: "illegal_move", message: "cell is not exposed" });

    const snapshot = harness.session.getSnapshot();
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.error).toContain("cell is not exposed");

    harness.session.dispose();
  });

  test("retry creates a fresh game after a failure", async () => {
    let attempts = 0;
    const harness = createHarness({
      respond: () => {
        attempts += 1;
        if (attempts === 1) return jsonResponse({ error: { code: "unavailable", message: "starting up" } }, 503);
        return jsonResponse({ game: gameDto(toClientView(createGame(presetConfig("tiny", { seed: 9 })))) });
      },
    });

    await waitFor(() => harness.session.getSnapshot().phase === "error");
    harness.session.retry?.();
    await waitFor(() => harness.session.getSnapshot().phase === "ready");
    expect(harness.session.getSnapshot().state).not.toBeNull();

    harness.session.dispose();
  });

  test("newGame replaces the game and disposes the old socket", async () => {
    const harness = createHarness();
    await waitFor(() => harness.sockets.length === 1);
    const first = harness.sockets[0] as FakeSocket;

    harness.session.newGame({ presetId: "medium" });
    await waitFor(() => harness.session.getSnapshot().phase === "ready" && harness.sockets.length === 2);

    expect(first.closed).toBe(true);
    expect(harness.session.getSnapshot().state?.cells).toHaveLength(216);

    harness.session.dispose();
  });
});

describe("remote room session", () => {
  test("attaches to an existing room without creating a game", () => {
    const harness = createRoomHarness();
    const snapshot = harness.session.getSnapshot();

    expect(snapshot.room?.id).toBe("ROOM01");
    expect(snapshot.playerId).toBe("p1");
    expect(snapshot.state?.cells).toHaveLength(27);
    expect(harness.requests).toHaveLength(0);
    expect(harness.sockets[0]?.url).toBe("ws://game.test/api/rooms/ROOM01/ws?player=p1");

    harness.session.dispose();
  });

  test("applies room presence frames", () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitMessage({
      type: "room",
      room: roomDto("ROOM01", "game-1", [player("p1", "Ada", true), player("p2", "Grace", false)]),
    });

    const players = harness.session.getSnapshot().room?.players ?? [];
    expect(players.map((entry) => [entry.name, entry.connected])).toEqual([
      ["Ada", true],
      ["Grace", false],
    ]);

    harness.session.dispose();
  });

  test("ignores another player's private board", () => {
    const harness = createRoomHarness();
    const other = toClientView(createGame(presetConfig("tiny", { seed: 11 })));

    harness.sockets[0]?.emitMessage({ type: "update", game: gameDto(other, "game-1"), events: [], board: "p2" });
    expect(harness.session.getSnapshot().state?.config.seed).toBe(5);

    harness.sockets[0]?.emitMessage({ type: "update", game: gameDto(other, "game-1"), events: [], board: "p1" });
    expect(harness.session.getSnapshot().state?.config.seed).toBe(11);

    harness.session.dispose();
  });

  test("applies an untagged update: that is the board the room shares", () => {
    const harness = createRoomHarness();
    const other = toClientView(createGame(presetConfig("tiny", { seed: 11 })));

    harness.sockets[0]?.emitMessage({ type: "update", game: gameDto(other, "game-1"), events: [] });

    expect(harness.session.getSnapshot().state?.config.seed).toBe(11);
    harness.session.dispose();
  });

  test("carries the match state of a room frame", () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitMessage({
      type: "room",
      room: testRoom({
        id: "ROOM01",
        mode: "coop",
        status: "playing",
        round: 2,
        deadlineAt: "2026-01-01T00:01:35.000Z",
        timeLimitMs: 95_000,
      }),
    });

    const room = harness.session.getSnapshot().room;
    expect(room?.mode).toBe("coop");
    expect(room?.status).toBe("playing");
    expect(room?.round).toBe(2);
    expect(room?.deadlineAt).toBe("2026-01-01T00:01:35.000Z");
    expect(room?.timeLimitMs).toBe(95_000);

    harness.session.dispose();
  });

  test("newGame restarts the shared board and reopens the socket", async () => {
    const harness = createRoomHarness();
    const first = harness.sockets[0] as FakeSocket;

    harness.session.newGame();
    await waitFor(() => harness.requests.length === 1);

    expect(harness.requests[0]?.url).toBe("http://game.test/api/rooms/ROOM01/restart");
    expect(JSON.parse(harness.requests[0]?.body ?? "{}")).toEqual({});

    await waitFor(() => harness.sockets.length === 2);
    expect(first.closed).toBe(true);
    expect(harness.session.getSnapshot().room?.gameId).toBe("game-2");
    expect(harness.session.getSnapshot().state?.status).toBe("ready");
    expect(harness.sockets[1]?.url).toBe("ws://game.test/api/rooms/ROOM01/ws?player=p1");

    harness.session.dispose();
  });

  test("newGame with a preset asks the server to resize", async () => {
    const harness = createRoomHarness();

    harness.session.newGame({ presetId: "medium" });
    await waitFor(() => harness.requests.length === 1);

    expect(JSON.parse(harness.requests[0]?.body ?? "{}")).toEqual({ presetId: "medium" });

    harness.session.dispose();
  });

  test("a welcome frame carries the room and the seated player", () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitMessage({
      type: "welcome",
      game: gameDto(harness.state),
      room: roomDto("ROOM01", "game-1", [player("p1", "Ada", true)]),
      playerId: "p1",
    });

    expect(harness.session.getSnapshot().room?.players).toHaveLength(1);
    expect(harness.session.getSnapshot().playerId).toBe("p1");

    harness.session.dispose();
  });

  test("publishes where this player is pointing, but not once per pixel", async () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitOpen();

    harness.session.setCursor?.({ x: 0, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent).toEqual([JSON.stringify({ type: "cursor", cell: { x: 0, y: 0, z: 0 } })]);

    // Two moves inside the window collapse into the one frame that matters:
    // where the pointer ended up.
    harness.session.setCursor?.({ x: 1, y: 0, z: 0 });
    harness.session.setCursor?.({ x: 2, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent).toHaveLength(1);

    await waitFor(() => (harness.sockets[0]?.sent.length ?? 0) === 2);
    expect(harness.sockets[0]?.sent[1]).toBe(JSON.stringify({ type: "cursor", cell: { x: 2, y: 0, z: 0 } }));

    harness.session.dispose();
  });

  test("a move back to the same cell is not published again", async () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitOpen();

    harness.session.setCursor?.({ x: 0, y: 0, z: 0 });
    await Bun.sleep(120);
    harness.session.setCursor?.({ x: 0, y: 0, z: 0 });
    await Bun.sleep(120);

    expect(harness.sockets[0]?.sent).toHaveLength(1);

    harness.session.dispose();
  });

  test("a lifted pointer is published as no cell at all", async () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitOpen();

    harness.session.setCursor?.({ x: 0, y: 0, z: 0 });
    await Bun.sleep(120);
    harness.session.setCursor?.(null);

    expect(harness.sockets[0]?.sent[1]).toBe(JSON.stringify({ type: "cursor", cell: null }));

    harness.session.dispose();
  });

  test("nothing is published while the socket is down, and no stale cell is replayed", () => {
    const harness = createRoomHarness();

    harness.session.setCursor?.({ x: 0, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent).toEqual([]);

    // The pointer moved on while there was nowhere to send it; the room hears
    // where it is *now*, never where it was.
    harness.sockets[0]?.emitOpen();
    harness.session.setCursor?.({ x: 3, y: 0, z: 0 });

    expect(harness.sockets[0]?.sent).toEqual([JSON.stringify({ type: "cursor", cell: { x: 3, y: 0, z: 0 } })]);

    harness.session.dispose();
  });

  test("disposing drops the frame that was still waiting", async () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitOpen();

    harness.session.setCursor?.({ x: 0, y: 0, z: 0 });
    harness.session.setCursor?.({ x: 1, y: 0, z: 0 });
    harness.session.dispose();
    await Bun.sleep(120);

    expect(harness.sockets[0]?.sent).toHaveLength(1);
    expect(harness.sockets[0]?.closed).toBe(true);
  });

  test("keeps where the others point without re-rendering anything", () => {
    const harness = createRoomHarness();
    const before = harness.session.getSnapshot();

    harness.sockets[0]?.emitMessage({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2, z: 3 } });

    // A pointer moves with every beetle of the mouse, so a pointer frame may
    // not touch the snapshot: the HUD would re-render at that rate.
    expect(harness.session.getSnapshot()).toBe(before);
    expect(harness.session.cursorFeed?.cursors.get("p2")?.cell).toEqual({ x: 1, y: 2, z: 3 });

    harness.session.dispose();
  });

  test("keeps the seat of a player who stopped pointing, with no cell", () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitMessage({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2, z: 3 } });

    harness.sockets[0]?.emitMessage({ type: "cursor", playerId: "p2", cell: null });

    expect(harness.session.cursorFeed?.cursors.get("p2")?.cell).toBeNull();

    harness.session.dispose();
  });

  test("never takes its own pointer back from the server", () => {
    const harness = createRoomHarness();

    harness.sockets[0]?.emitMessage({ type: "cursor", playerId: "p1", cell: { x: 1, y: 2, z: 3 } });

    expect(harness.session.cursorFeed?.cursors.size).toBe(0);

    harness.session.dispose();
  });

  test("forgets the pointer of a player who left the room", () => {
    const harness = createRoomHarness();
    harness.sockets[0]?.emitMessage({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2, z: 3 } });
    expect(harness.session.cursorFeed?.cursors.size).toBe(1);

    harness.sockets[0]?.emitMessage({ type: "room", room: roomDto("ROOM01", "game-1", [player("p1", "Ada", true)]) });

    expect(harness.session.cursorFeed?.cursors.size).toBe(0);

    harness.session.dispose();
  });

  test("an unreadable pointer is treated as no pointer", () => {
    const harness = createRoomHarness();

    harness.sockets[0]?.emitMessage({ type: "cursor", playerId: "p2", cell: { x: 1, y: 2 } });

    // A marker drawn from a half-read cell would land in the wrong place; none
    // is better than one in the wrong place.
    expect(harness.session.cursorFeed?.cursors.size).toBe(0);

    harness.session.dispose();
  });
});

/** A room attachment as returned by the create/join endpoints. */
function attachment(state: ClientGameState): RoomJoinDto {
  return {
    room: roomDto("ROOM01", "game-1", [player("p1", "Ada", true)]),
    player: player("p1", "Ada", true),
    game: gameDto(state),
  };
}

function player(id: string, name: string, connected: boolean): PlayerDto {
  return testPlayer({ id, name, connected });
}

function roomDto(id: string, gameId: string, players: readonly PlayerDto[]): RoomDto {
  return testRoom({ id, gameId, players, name: `${players[0]?.name ?? "Player"}'s room` });
}

interface RoomHarness {
  readonly session: GameSession;
  readonly sockets: FakeSocket[];
  readonly requests: { url: string; method: string; body: string }[];
  readonly state: ClientGameState;
}

/** Builds a room-attached session whose only HTTP route is the restart. */
function createRoomHarness(): RoomHarness {
  const sockets: FakeSocket[] = [];
  const requests: { url: string; method: string; body: string }[] = [];
  const first = createGame(presetConfig("tiny", { seed: 5 }));
  const second = createGame(presetConfig("tiny", { seed: 11 }));

  const fetchStub: FetchLike = async (url, init) => {
    requests.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? "") });
    if (url.endsWith("/api/rooms/ROOM01/restart")) {
      return jsonResponse({
        room: roomDto("ROOM01", "game-2", [player("p1", "Ada", true)]),
        game: gameDto(toClientView(second), "game-2"),
      });
    }
    return jsonResponse({ error: { code: "not_found", message: `no route for ${url}` } }, 404);
  };

  const session = createRemoteSession({
    room: attachment(toClientView(first)),
    deps: {
      fetch: fetchStub,
      openSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        return socket;
      },
      baseUrl: "http://game.test",
      reconnectBaseMs: 1,
    },
  });

  return { session, sockets, requests, state: toClientView(first) };
}

/** A DTO envelope with a stable id/revision, matching the server contract. */
function gameDto(state: ClientGameState, id = "game-1") {
  return {
    id,
    revision: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    state,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Polls until the assertion holds or the budget runs out. */
async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the remote session");
    await Bun.sleep(2);
  }
}
