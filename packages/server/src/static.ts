/**
 * Static hosting of the built web client.
 *
 * The API and the client share an origin, so the same server answers `/` with
 * `index.html` and hashed bundles with a year-long immutable cache. Dev mode is
 * a first-class case: until `packages/web/dist` exists the SPA routes answer
 * 503 with the command to build the client, which is far more useful than a
 * bare 404 while another agent (or a fresh clone) has not built yet.
 */
import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { errorResponse } from "./http";
import type { Logger } from "./logger";

/** Options of {@link createStaticHandler}. */
export interface StaticHandlerOptions {
  /** Absolute path of the built client. */
  readonly distDir: string;
  readonly logger: Logger;
  /** SPA entry, relative to `distDir`; defaults to `index.html`. */
  readonly indexFile?: string;
}

/** Serves a static request; never throws for client mistakes. */
export type StaticHandler = (request: Request) => Promise<Response>;

/** Long-lived caching for Vite's content-hashed bundles. */
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/** Everything else may change between builds, so revalidate. */
const REVALIDATE_CACHE = "no-cache";

/** Creates the static handler for one dist directory. */
export function createStaticHandler(options: StaticHandlerOptions): StaticHandler {
  const distDir = resolve(options.distDir);
  const indexFile = options.indexFile ?? "index.html";

  return async (request) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return errorResponse(405, "method_not_allowed", `${request.method} is not allowed for static files`, undefined, {
        allow: "GET, HEAD",
      });
    }

    const pathname = decodePath(new URL(request.url).pathname);
    if (pathname === undefined) return notFound("Invalid request path");

    const target = pathname === "/" ? undefined : resolveWithin(distDir, pathname);
    if (pathname !== "/" && target === undefined) return notFound(`Invalid request path ${pathname}`);

    const indexPath = resolve(distDir, indexFile);
    const index = await statFile(indexPath);

    if (target !== undefined) {
      const file = await statFile(target);
      if (file !== undefined) {
        return serveFile(request, target, file.size, cacheControlFor(pathname), immutableHeaders(file.mtimeMs));
      }
      // A missing file with an extension is an asset, never a client route.
      // When the whole build is absent, say so instead of a bare 404.
      if (hasExtension(pathname)) {
        return index === undefined
          ? missingDist(pathname, distDir, indexFile, options.logger)
          : notFound(`No file at ${pathname}`);
      }
    }

    if (index === undefined) return missingDist(pathname, distDir, indexFile, options.logger);

    // SPA fallback: extension-less paths are client routes, not files.
    return serveFile(request, indexPath, index.size, REVALIDATE_CACHE, immutableHeaders(index.mtimeMs));
  };
}

/**
 * Builds the response for a file that exists.
 *
 * `HEAD` returns the same headers with no body, which is what caches and
 * health probes expect.
 */
function serveFile(
  request: Request,
  path: string,
  size: number,
  cacheControl: string,
  extraHeaders: Record<string, string>,
): Response {
  const type = Bun.file(path).type;
  const headers = new Headers({
    "content-type": type.length > 0 ? type : "application/octet-stream",
    "content-length": String(size),
    "cache-control": cacheControl,
    ...extraHeaders,
  });

  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(Bun.file(path), { status: 200, headers });
}

/** `index.html` is what the missing-dist message talks about, so name it. */
function missingDist(
  pathname: string,
  distDir: string,
  indexFile: string,
  logger: Logger,
): Response {
  const help = `Web client build not found at ${distDir}. Run \`bun run build\` (or the Vite dev server) to create it.`;
  logger.warn("web dist missing", { distDir, indexFile, path: pathname });

  // A request for a real file (an asset, a favicon) is a 404; a client route
  // is a 503 because the server is fine, only the build is absent.
  return hasExtension(pathname)
    ? errorResponse(404, "not_found", `No file at ${pathname}. ${help}`)
    : errorResponse(503, "web_dist_missing", help);
}

function notFound(message: string): Response {
  return errorResponse(404, "not_found", message);
}

function cacheControlFor(pathname: string): string {
  return pathname.startsWith("/assets/") ? IMMUTABLE_CACHE : REVALIDATE_CACHE;
}

function immutableHeaders(mtimeMs: number): Record<string, string> {
  return { "last-modified": new Date(mtimeMs).toUTCString() };
}

/** Percent-decodes a path, rejecting malformed escapes and NUL bytes. */
function decodePath(pathname: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
  return decoded.includes("\0") ? undefined : decoded;
}

/** Resolves a URL path inside `distDir`, refusing traversal outside of it. */
function resolveWithin(distDir: string, pathname: string): string | undefined {
  const target = resolve(distDir, `.${pathname}`);
  return target === distDir || target.startsWith(distDir + sep) ? target : undefined;
}

/** File size and mtime, or `undefined` for missing paths and directories. */
async function statFile(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    return undefined;
  }
}

function hasExtension(pathname: string): boolean {
  return extname(pathname).length > 0;
}
