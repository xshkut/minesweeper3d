/**
 * HTTP endpoints of the game API.
 *
 * The handlers stay thin on purpose: parse and validate with the shared HTTP
 * helpers, delegate to the service, map domain errors through
 * {@link toHttpError}. They are registered onto a router supplied by the app,
 * which keeps this module free of `Bun.serve` and easy to unit test.
 */
import { GAME_PRESETS } from "@minesweeper3d/game-core";
import { HttpError, jsonResponse, readJsonBody } from "../http";
import type { Router } from "../router";
import { toHttpError } from "./errors";
import type { GameService } from "./service";
import { toGameDto } from "./dto";

/** Collaborators of the game routes. */
export interface GameRoutesDependencies {
  readonly service: GameService;
  /** Value reported by `GET /api/health`. */
  readonly version: string;
  /** Uptime source in seconds; defaults to the process uptime. */
  readonly uptimeSeconds?: () => number;
}

/** Registers every `/api` route on an existing router. */
export function registerGameRoutes(router: Router, dependencies: GameRoutesDependencies): void {
  const { service, version } = dependencies;
  const uptimeSeconds = dependencies.uptimeSeconds ?? (() => Math.round(process.uptime()));

  router.get("/api/health", () =>
    jsonResponse({ status: "ok", uptimeSeconds: uptimeSeconds(), version }),
  );

  router.get("/api/presets", () => jsonResponse({ presets: GAME_PRESETS }));

  router.post("/api/games", async ({ request }) => {
    // An empty body means "default game", so a client may POST without a payload.
    const body = await readJsonBody(request, { allowEmpty: true });
    const game = guard(() => service.createGame(body));
    return jsonResponse({ game: toGameDto(game) }, { status: 201 });
  });

  router.get("/api/games/:id", ({ params }) => {
    const game = guard(() => service.getGame(gameIdOf(params)));
    return jsonResponse({ game: toGameDto(game) });
  });

  router.post("/api/games/:id/reveal", async ({ params, request }) => {
    const body = await readJsonBody(request);
    const update = guard(() => service.reveal(gameIdOf(params), cellOf(body)));
    return jsonResponse({ game: toGameDto(update.game), events: update.events });
  });

  router.post("/api/games/:id/flag", async ({ params, request }) => {
    const body = await readJsonBody(request);
    const update = guard(() => service.toggleFlag(gameIdOf(params), cellOf(body)));
    return jsonResponse({ game: toGameDto(update.game), events: update.events });
  });
}

/** Runs a service call, converting domain errors into HTTP errors. */
function guard<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw toHttpError(error);
  }
}

/** The `:id` capture is guaranteed by the pattern; guard the type anyway. */
function gameIdOf(params: Readonly<Record<string, string>>): string {
  const id = params["id"];
  if (id === undefined || id.length === 0) {
    throw new HttpError(400, "invalid_game_id", "A game id is required");
  }
  return id;
}

/** Extracts `cell` from a JSON body; the service validates its shape. */
function cellOf(body: unknown): unknown {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "invalid_body", "Request body must be a JSON object");
  }
  return (body as Record<string, unknown>)["cell"];
}
