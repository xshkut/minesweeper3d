/**
 * Static hosting tests, run against a throwaway `WEB_DIST` fixture so the real
 * (possibly missing) build output is never touched.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  call,
  createWebDistFixture,
  missingDistDir,
  startTestServer,
  type TestServer,
  type WebDistFixture,
} from "./support";

let fixture: WebDistFixture;
let active: TestServer | undefined;

beforeAll(async () => {
  fixture = await createWebDistFixture();
});

afterAll(async () => {
  await fixture.remove();
});

afterEach(async () => {
  await active?.stop();
  active = undefined;
});

async function start(webDist: string): Promise<TestServer> {
  active = await startTestServer({ webDist });
  return active;
}

describe("static hosting", () => {
  test("serves index.html at / with revalidation caching", async () => {
    const server = await start(fixture.dir);
    const result = await call("GET", `${server.url}/`);

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/html");
    expect(result.headers.get("cache-control")).toBe("no-cache");
    expect(result.text).toBe(fixture.indexHtml);
  });

  test("serves hashed assets with an immutable cache and the right type", async () => {
    const server = await start(fixture.dir);
    const result = await call("GET", `${server.url}${fixture.assetPath}`);

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("javascript");
    expect(result.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(result.headers.get("content-length")).toBe(String(fixture.assetBody.length));
    expect(result.text).toBe(fixture.assetBody);
  });

  test("answers HEAD with headers and no body", async () => {
    const server = await start(fixture.dir);
    const result = await call("HEAD", `${server.url}/`);

    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/html");
    expect(result.text).toBe("");
  });

  test("falls back to index.html for extension-less client routes", async () => {
    const server = await start(fixture.dir);

    for (const path of ["/play/tiny", "/some/deep/route"]) {
      const result = await call("GET", `${server.url}${path}`);
      expect(result.status).toBe(200);
      expect(result.text).toBe(fixture.indexHtml);
    }
  });

  test("serves non-asset files without the immutable cache", async () => {
    const server = await start(fixture.dir);
    const result = await call("GET", `${server.url}/favicon.ico`);

    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-cache");
  });

  test("404s missing files that have an extension", async () => {
    const server = await start(fixture.dir);
    const result = await call("GET", `${server.url}/missing.txt`);

    expect(result.status).toBe(404);
    expect(result.headers.get("content-type")).toContain("application/json");
    expect((result.body as { error: { code: string } }).error.code).toBe("not_found");

    const asset = await call("GET", `${server.url}/assets/nope-123.js`);
    expect(asset.status).toBe(404);
  });

  test("refuses path traversal", async () => {
    const server = await start(fixture.dir);
    const result = await call("GET", `${server.url}/assets/%2e%2e%2f%2e%2e%2fpackage.json`);

    expect(result.status).toBe(404);
  });

  test("405s non-GET methods", async () => {
    const server = await start(fixture.dir);
    const result = await call("POST", `${server.url}/`);

    expect(result.status).toBe(405);
    expect(result.headers.get("allow")).toBe("GET, HEAD");
  });

  test("explains a missing build instead of pretending the client exists", async () => {
    const server = await start(missingDistDir());

    const spa = await call("GET", `${server.url}/`);
    expect(spa.status).toBe(503);
    const error = (spa.body as { error: { code: string; message: string } }).error;
    expect(error.code).toBe("web_dist_missing");
    expect(error.message).toContain("bun run build");

    const asset = await call("GET", `${server.url}/assets/app-abc123.js`);
    expect(asset.status).toBe(404);
    expect((asset.body as { error: { message: string } }).error.message).toContain("bun run build");
  });
});
