/**
 * End-to-end tests of the HTTP API against a real `Bun.serve` instance on an
 * ephemeral port: statuses, JSON shapes, error codes and - crucially - that the
 * API never leaks the mine layout of a running game.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isCellExposed, mineCells, vec3 } from "@minesweeper3d/game-core";
import type { CellIndex, GameEvent } from "@minesweeper3d/game-core";
import type { GameDto } from "../src/games/dto";
import { call, get, postJson, startTestServer, type HttpResult, type TestServer } from "./support";

let active: TestServer | undefined;

afterEach(async () => {
  await active?.stop();
  active = undefined;
});

async function start(): Promise<TestServer> {
  active = await startTestServer();
  return active;
}

/** Extracts the `game` field of a response body, failing loudly when absent. */
function gameOf(result: HttpResult): GameDto {
  const body = result.body as { game?: GameDto } | null;
  if (body === null || typeof body !== "object" || body.game === undefined) {
    throw new Error(`response has no game: ${result.text}`);
  }
  return body.game;
}

/** Extracts an error code, failing loudly when the body is not an error. */
function errorOf(result: HttpResult): { code: string; message: string; details?: string[] } {
  const body = result.body as { error?: { code: string; message: string; details?: string[] } } | null;
  if (body === null || typeof body !== "object" || body.error === undefined) {
    throw new Error(`response has no error: ${result.text}`);
  }
  return body.error;
}

function eventsOf(result: HttpResult): GameEvent[] {
  const body = result.body as { events?: GameEvent[] } | null;
  if (body === null || typeof body !== "object" || body.events === undefined) {
    throw new Error(`response has no events: ${result.text}`);
  }
  return body.events;
}

/** A mutating call that must succeed, so tests can chain game states. */
async function expectOk(result: Promise<HttpResult>): Promise<HttpResult> {
  const resolved = await result;
  expect(resolved.status).toBe(200);
  return resolved;
}

function mustGame(server: TestServer, id: string): CellIndex[] {
  const game = server.store.get(id);
  if (game === undefined) throw new Error(`expected game ${id} in the store`);
  return [...mineCells(game.state)];
}

describe("GET /api/health", () => {
  test("reports status, uptime and version", async () => {
    const server = await start();
    const result = await get(`${server.url}/api/health`);

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect(result.body).toEqual({ status: "ok", uptimeSeconds: expect.any(Number), version: "test" });
    expect((result.body as { uptimeSeconds: number }).uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe("GET /api/presets", () => {
  test("returns the engine preset list", async () => {
    const server = await start();
    const result = await get(`${server.url}/api/presets`);

    expect(result.status).toBe(200);
    const body = result.body as {
      presets: Array<{ id: string; label: string; size: unknown; mineCount: number }>;
    };
    expect(body.presets.map((preset) => preset.id)).toEqual([
      "tiny",
      "classic",
      "medium",
      "large",
      "expert",
    ]);
    expect(body.presets[0]).toEqual({ id: "tiny", label: "Tiny", size: vec3(3, 3, 3), mineCount: 3 });
  });
});

describe("POST /api/games", () => {
  test("creates a preset game with a redacted client state", async () => {
    const server = await start();
    const result = await postJson(`${server.url}/api/games`, { presetId: "tiny" });

    expect(result.status).toBe(201);
    const body = result.body as { game: GameDto };
    expect(Object.keys(body)).toEqual(["game"]);

    const game = gameOf(result);
    expect(game.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(game.revision).toBe(0);
    expect(game.createdAt).toBe(game.updatedAt);
    expect(game.state.status).toBe("ready");
    expect(game.state.config).toEqual({
      size: vec3(3, 3, 3),
      mineCount: 3,
      seed: expect.any(Number),
      firstRevealSafe: true,
    });
    expect(game.state.cells).toHaveLength(27);
    // Nothing may reveal where the mines are before the game is over.
    expect(game.state.cells.every((cell) => cell.hasMine === false)).toBe(true);
  });

  test("accepts a bodyless POST as the default game", async () => {
    const server = await start();
    const result = await call("POST", `${server.url}/api/games`);

    expect(result.status).toBe(201);
    expect(gameOf(result).state.config.size).toEqual(vec3(5, 5, 5));
  });

  test("accepts an explicit config", async () => {
    const server = await start();
    const result = await postJson(`${server.url}/api/games`, {
      config: { size: vec3(2, 2, 2), mineCount: 2, seed: 11, firstRevealSafe: false },
    });

    expect(result.status).toBe(201);
    const game = gameOf(result);
    expect(game.state.cells).toHaveLength(8);
    expect(game.state.config.mineCount).toBe(2);
    expect(game.state.config.firstRevealSafe).toBe(false);
  });

  test("is deterministic for a pinned seed", async () => {
    const server = await start();
    const first = gameOf(await postJson(`${server.url}/api/games`, { presetId: "tiny", seed: 1234 }));
    const second = gameOf(await postJson(`${server.url}/api/games`, { presetId: "tiny", seed: 1234 }));

    expect(first.id).not.toBe(second.id);
    expect(first.state.cells).toEqual(second.state.cells);
  });

  test("rejects malformed bodies with 400 and a typed code", async () => {
    const server = await start();
    const url = `${server.url}/api/games`;

    const brokenJson = await call("POST", url, {
      body: "{ not json",
      headers: { "content-type": "application/json" },
    });
    expect(brokenJson.status).toBe(400);
    expect(errorOf(brokenJson).code).toBe("invalid_body");

    const badPreset = await postJson(url, { presetId: "gigantic" });
    expect(badPreset.status).toBe(400);
    expect(errorOf(badPreset).code).toBe("unknown_preset");
    expect(errorOf(badPreset).details?.join(" ")).toContain("tiny");

    const badConfig = await postJson(url, {
      config: { size: vec3(2, 2, 2), mineCount: 99, seed: 1, firstRevealSafe: true },
    });
    expect(badConfig.status).toBe(400);
    expect(errorOf(badConfig).code).toBe("invalid_config");
    expect(errorOf(badConfig).details?.length).toBeGreaterThan(0);

    const badSeed = await postJson(url, { seed: "1234" });
    expect(badSeed.status).toBe(400);
    expect(errorOf(badSeed).code).toBe("invalid_body");
    expect(errorOf(badSeed).details?.join(" ")).toContain("seed");
  });

  test("rejects a non-JSON content type with 415", async () => {
    const server = await start();
    const result = await call("POST", `${server.url}/api/games`, {
      body: "presetId=tiny",
      headers: { "content-type": "text/plain" },
    });

    expect(result.status).toBe(415);
    expect(errorOf(result).code).toBe("unsupported_media_type");
  });

  test("rejects an oversized body with 413", async () => {
    const server = await start();
    const huge = JSON.stringify({ presetId: "tiny", padding: "x".repeat(70 * 1024) });
    const result = await call("POST", `${server.url}/api/games`, {
      body: huge,
      headers: { "content-type": "application/json" },
    });

    expect(result.status).toBe(413);
    expect(errorOf(result).code).toBe("payload_too_large");
  });
});

describe("GET /api/games/:id", () => {
  test("returns the created game and 404s for unknown ids", async () => {
    const server = await start();
    const created = gameOf(await postJson(`${server.url}/api/games`, { presetId: "tiny" }));

    const found = await get(`${server.url}/api/games/${created.id}`);
    expect(found.status).toBe(200);
    expect(gameOf(found).id).toBe(created.id);

    const missing = await get(`${server.url}/api/games/does-not-exist`);
    expect(missing.status).toBe(404);
    expect(errorOf(missing)).toEqual({
      code: "game_not_found",
      message: 'Game "does-not-exist" does not exist',
    });
  });
});

describe("POST /api/games/:id/reveal and /flag", () => {
  test("reveals a cell and returns the events", async () => {
    const server = await start();
    const created = gameOf(
      await postJson(`${server.url}/api/games`, { presetId: "tiny", seed: 1, firstRevealSafe: true }),
    );

    const result = await expectOk(
      postJson(`${server.url}/api/games/${created.id}/reveal`, { cell: vec3(0, 0, 0) }),
    );
    const game = gameOf(result);

    expect(game.revision).toBe(1);
    expect(game.state.status).toBe("playing");
    expect(eventsOf(result)[0]?.type).toBe("cellsRevealed");

    // A repeated reveal is a no-op: same revision, no events.
    const repeated = await expectOk(
      postJson(`${server.url}/api/games/${created.id}/reveal`, { cell: vec3(0, 0, 0) }),
    );
    expect(gameOf(repeated).revision).toBe(1);
    expect(eventsOf(repeated)).toEqual([]);
  });

  test("flags a covered cell and reports the change", async () => {
    const server = await start();
    const created = gameOf(
      await postJson(`${server.url}/api/games`, { presetId: "tiny", seed: 1, firstRevealSafe: true }),
    );
    await expectOk(postJson(`${server.url}/api/games/${created.id}/reveal`, { cell: vec3(0, 0, 0) }));

    const state = server.store.get(created.id)?.state;
    if (state === undefined) throw new Error("expected the game in the store");
    const target = state.cells.find(
      (cell) => !cell.isRevealed && !cell.isFlagged && isCellExposed(state, cell.index),
    );
    if (target === undefined) throw new Error("expected an exposed covered cell");

    const result = await expectOk(
      postJson(`${server.url}/api/games/${created.id}/flag`, { cell: target.index }),
    );
    expect(eventsOf(result)).toEqual([{ type: "flagChanged", cell: target.index, flagged: true }]);
    expect(gameOf(result).state.flagCount).toBe(1);
  });

  test("rejects malformed cells with 400", async () => {
    const server = await start();
    const created = gameOf(await postJson(`${server.url}/api/games`, { presetId: "tiny" }));
    const url = `${server.url}/api/games/${created.id}/reveal`;

    const missing = await postJson(url, {});
    expect(missing.status).toBe(400);
    expect(errorOf(missing).code).toBe("invalid_cell");

    const fractional = await postJson(url, { cell: { x: 0.5, y: 0, z: 0 } });
    expect(fractional.status).toBe(400);
    expect(errorOf(fractional).code).toBe("invalid_cell");

    const arrayBody = await postJson(url, [0, 0, 0]);
    expect(arrayBody.status).toBe(400);
    expect(errorOf(arrayBody).code).toBe("invalid_body");

    const emptyBody = await call("POST", url, { headers: { "content-type": "application/json" } });
    expect(emptyBody.status).toBe(400);
    expect(errorOf(emptyBody).code).toBe("invalid_body");
  });

  test("404s when the game does not exist", async () => {
    const server = await start();
    const result = await postJson(`${server.url}/api/games/nope/reveal`, { cell: vec3(0, 0, 0) });

    expect(result.status).toBe(404);
    expect(errorOf(result).code).toBe("game_not_found");
  });
});

describe("mine redaction", () => {
  test("no cell reports a mine while the game is running", async () => {
    const server = await start();
    const created = gameOf(
      await postJson(`${server.url}/api/games`, { presetId: "classic", seed: 9, firstRevealSafe: true }),
    );
    const revealed = await expectOk(
      postJson(`${server.url}/api/games/${created.id}/reveal`, { cell: vec3(0, 0, 0) }),
    );

    const game = gameOf(revealed);
    expect(game.state.status).toBe("playing");
    expect(game.state.cells.every((cell) => cell.hasMine === false)).toBe(true);

    // The store, in contrast, knows exactly where the mines are.
    expect(mustGame(server, created.id).length).toBe(10);
  });

  test("reveals the mines once the game is lost", async () => {
    const server = await start();
    const created = gameOf(
      await postJson(`${server.url}/api/games`, {
        config: { size: vec3(2, 2, 2), mineCount: 1, seed: 5, firstRevealSafe: false },
      }),
    );
    const [mine] = mustGame(server, created.id);
    if (mine === undefined) throw new Error("expected the board to have a mine");

    const lost = await expectOk(postJson(`${server.url}/api/games/${created.id}/reveal`, { cell: mine }));
    const game = gameOf(lost);

    expect(game.state.status).toBe("lost");
    expect(game.state.explodedAt).toEqual(mine);
    expect(eventsOf(lost).map((event) => event.type)).toEqual([
      "mineExploded",
      "minesRevealed",
      "gameLost",
    ]);
    expect(game.state.cells.filter((cell) => cell.hasMine)).toHaveLength(1);
  });
});

describe("routing", () => {
  test("404s unknown API routes with a JSON error", async () => {
    const server = await start();
    const result = await get(`${server.url}/api/nope`);

    expect(result.status).toBe(404);
    expect(errorOf(result).code).toBe("not_found");
  });

  test("405s a known path with the wrong method and sets Allow", async () => {
    const server = await start();

    const onHealth = await postJson(`${server.url}/api/health`, {});
    expect(onHealth.status).toBe(405);
    expect(onHealth.headers.get("allow")).toBe("GET");
    expect(errorOf(onHealth).code).toBe("method_not_allowed");

    const onGames = await get(`${server.url}/api/games`);
    expect(onGames.status).toBe(405);
    expect(onGames.headers.get("allow")).toBe("POST");
  });
});
