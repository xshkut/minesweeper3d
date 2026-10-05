import { describe, expect, test } from "bun:test";
import { createGame, presetConfig, revealCell, toClientView } from "@minesweeper3d/game-core";
import type { CellIndex, ClientGameState } from "@minesweeper3d/game-core";
import { createRemoteSession } from "./remote";
import type { FetchLike, SocketLike } from "./remote";
import type { GameSession } from "./types";

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

    harness.session.toggleFlag({ x: 1, y: 0, z: 0 });
    expect(harness.sockets[0]?.sent[1]).toBe(JSON.stringify({ type: "flag", cell: { x: 1, y: 0, z: 0 } }));

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

/** A DTO envelope with a stable id/revision, matching the server contract. */
function gameDto(state: ClientGameState) {
  return {
    id: "game-1",
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
