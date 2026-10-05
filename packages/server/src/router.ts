/**
 * Minimal typed router: enough for the game API, small enough to audit.
 *
 * Patterns are literal path segments plus `:name` captures (`/api/games/:id`).
 * A path that matches a pattern with the wrong method produces 405 with an
 * `Allow` header instead of a misleading 404, which is what browsers, curl and
 * proxy tools expect.
 */
import { HttpError } from "./http";

/**
 * The part of a `Bun.serve` server instance the router needs.
 *
 * Kept as a structural type so the router stays testable without Bun and does
 * not depend on websocket typings.
 */
export interface HttpServerLike {
  upgrade(request: Request, options?: { readonly data?: unknown }): boolean;
}

/** Everything a route handler needs to build a response. */
export interface RouteContext {
  /** Values captured from `:name` segments of the matched pattern. */
  readonly params: Readonly<Record<string, string>>;
  readonly request: Request;
  readonly url: URL;
  /** Present when the app was created for `Bun.serve`; absent in unit tests. */
  readonly server?: HttpServerLike;
}

/**
 * A route handler. Returning `undefined` means "handled out of band", which is
 * how a successful WebSocket upgrade is signalled to `Bun.serve`.
 */
export type RouteHandler = (context: RouteContext) => Response | undefined | Promise<Response | undefined>;

/** Mutable router; register all routes before serving traffic. */
export interface Router {
  get(pattern: string, handler: RouteHandler): void;
  post(pattern: string, handler: RouteHandler): void;
  /**
   * Dispatches a request.
   *
   * @throws HttpError 404 for unknown paths, 405 (with `Allow`) for known paths
   */
  handle(request: Request, server?: HttpServerLike): Promise<Response | undefined>;
}

/** HTTP methods the router understands. */
type Method = "GET" | "POST";

interface Route {
  readonly method: Method;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

/** Creates an empty router. */
export function createRouter(): Router {
  const routes: Route[] = [];

  const register = (method: Method, pattern: string, handler: RouteHandler): void => {
    if (!pattern.startsWith("/")) throw new Error(`Route pattern must start with "/": ${pattern}`);
    routes.push({ method, segments: splitPath(pattern), handler });
  };

  return {
    get: (pattern, handler) => register("GET", pattern, handler),
    post: (pattern, handler) => register("POST", pattern, handler),

    async handle(request, server) {
      const url = new URL(request.url);
      const path = splitPath(url.pathname);
      const allowed = new Set<Method>();

      for (const route of routes) {
        const params = matchSegments(route.segments, path);
        if (params === undefined) continue;
        allowed.add(route.method);
        if (route.method !== request.method) continue;

        const context: RouteContext = {
          params,
          request,
          url,
          ...(server === undefined ? {} : { server }),
        };
        return route.handler(context);
      }

      if (allowed.size > 0) {
        const allow = [...allowed].sort().join(", ");
        throw new HttpError(405, "method_not_allowed", `${request.method} is not allowed for ${url.pathname}`, {
          headers: { allow },
        });
      }
      throw new HttpError(404, "not_found", `No route for ${request.method} ${url.pathname}`);
    },
  };
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

/**
 * Matches a route pattern against request path segments.
 *
 * @returns the captured parameters, or `undefined` when the path does not match
 */
function matchSegments(pattern: readonly string[], path: readonly string[]): Record<string, string> | undefined {
  if (pattern.length !== path.length) return undefined;

  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    const actual = path[index] as string;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeSegment(actual);
      continue;
    }
    if (expected !== decodeSegment(actual)) return undefined;
  }
  return params;
}

/** Fragment identifiers arrive percent encoded; a malformed escape is kept verbatim. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
