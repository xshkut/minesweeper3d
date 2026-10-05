#!/usr/bin/env bun
/**
 * End-to-end smoke test.
 *
 * Builds the client if needed, starts the Bun server on a private port, drives
 * a real game through `window.__minesweeper3d` in headless Chromium and writes
 * a screenshot of the result.
 *
 * Run with `bun run test:e2e`. Exits non-zero with a readable reason when
 * anything - including a missing build or a server that cannot serve the client
 * - goes wrong, and always tears the server down again.
 */
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";

const WEB_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const DIST_DIR = resolve(WEB_ROOT, "dist");
const SERVER_ENTRY = resolve(REPO_ROOT, "packages/server/src/index.ts");
const SHOTS_DIR = resolve(WEB_ROOT, "e2e/screenshots");
const SCREENSHOT = resolve(SHOTS_DIR, "board.png");
const LOST_SCREENSHOT = resolve(SHOTS_DIR, "lost.png");

const PORT = Number(process.env["E2E_PORT"] ?? 8321);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome";
const CHROME_ARGS = ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];

const SERVER_START_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 25_000;

/** A failure the operator can act on. */
class SmokeFailure extends Error {}

type ServerProcess = ReturnType<typeof Bun.spawn>;

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];

/** Console noise that is expected in headless Chromium. */
const IGNORED_CONSOLE = [/Download the React DevTools/i, /favicon/i];

function note(message: string): void {
  process.stdout.write(`[e2e] ${message}\n`);
}

function record(name: string, ok: boolean, detail = ""): boolean {
  checks.push({ name, ok, detail });
  return ok;
}

async function main(): Promise<number> {
  let server: ServerProcess | null = null;
  let browser: Browser | null = null;

  try {
    await ensureClientBuild();
    server = startServer();
    const serverLog = attachLog(server);

    await waitForHealth(server, serverLog);
    record("server /api/health responds", true);

    await verifyClientIsServed();

    browser = await chromium.launch({ executablePath: CHROME_PATH, args: CHROME_ARGS, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrors = collectConsoleErrors(page);

    await openApp(page);
    await waitForReadyGame(page);
    record("canvas is mounted and sized", await canvasHasSize(page));

    const before = await readHud(page);
    record("HUD shows a fresh board", before.status === "Ready", `status=${before.status} progress=${before.progress}`);

    // Real clicks, so the board's instanced-mesh raycast is exercised as well:
    // one click must reach the front cell only, not every cell behind it.
    const flagged = await clickBoardCentreInFlagMode(page);
    record("one flag click marks exactly one cell", flagged === 1, `flags=${flagged}`);

    const unflagged = await clickBoardCentreInFlagMode(page);
    record("clicking the same cell again clears its flag", unflagged === 0, `flags=${unflagged}`);

    await driveReveal(page);
    const after = await readHud(page);

    record("HUD reports the game as playing", after.status === "Playing", `status=${after.status}`);
    record("reveal changed the progress counter", after.progress !== before.progress, `${before.progress} -> ${after.progress}`);
    record("timer runs in mm:ss", /^\d{2}:\d{2}$/.test(after.timer), `timer=${after.timer}`);
    record("mine counter is unchanged by a reveal", after.minesLeft === before.minesLeft, `mines=${after.minesLeft}`);

    await mkdir(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: SCREENSHOT });
    record("screenshot written", true, SCREENSHOT);

    // Losing the game must not hide the board: the player wants to inspect the
    // mines that are left, which means the "Boom." panel has to stay
    // translucent, keep clear of the middle of the board and let the pointer
    // through to the board behind it.
    await loseGame(page);
    const overlay = await readOverlay(page);
    record("a lost game shows the result overlay", overlay.status.includes("Boom"), `text=${overlay.status}`);
    record(
      "the result overlay is translucent",
      overlay.backgroundAlpha <= 0.5,
      `background=${overlay.background}`,
    );
    record(
      "the result overlay sits above the middle of the board",
      overlay.centreOffsetY >= 60,
      `panel centre ${overlay.centreOffsetY.toFixed(0)}px above the board centre`,
    );

    const showThrough = await measureBoardShowThrough(page);
    record(
      "the board behind the overlay is still readable",
      showThrough >= 0.35,
      `contrast kept=${showThrough.toFixed(3)} (0.10 before this was fixed)`,
    );

    await page.screenshot({ path: LOST_SCREENSHOT });
    record("loss screenshot written", true, LOST_SCREENSHOT);

    const orbit = await orbitFromOverlay(page);
    record(
      "a drag that starts on the overlay still orbits the board",
      orbit.moved,
      `board pixels moved by ${orbit.difference.toFixed(1)}/255`,
    );

    const replayed = await clickPlayAgain(page);
    record("Play again still works through the pass-through overlay", replayed);

    const errors = [...consoleErrors];
    record("no page errors and no unexpected console errors", errors.length === 0, errors.join(" | "));

    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0) {
      note("server output (last lines):");
      for (const line of serverLog.slice(-15)) note(`  | ${line}`);
    }
    return report(failed.length === 0);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    record(cause instanceof SmokeFailure ? "smoke test" : "unexpected failure", false, message);
    return report(false);
  } finally {
    if (browser !== null) await browser.close().catch(() => undefined);
    if (server !== null) await stopServer(server);
  }
}

/** Builds the client when `dist/` is missing or empty. */
async function ensureClientBuild(): Promise<void> {
  if (existsSync(resolve(DIST_DIR, "index.html"))) {
    record("client build present", true, DIST_DIR);
    return;
  }

  note("dist/ is missing - building the client (bun run build)");
  const build = Bun.spawnSync({
    cmd: ["bun", "run", "build"],
    cwd: WEB_ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new SmokeFailure(`client build failed with exit code ${build.exitCode}:\n${build.stderr.toString()}`);
  }
  if (!existsSync(resolve(DIST_DIR, "index.html"))) {
    throw new SmokeFailure("the client build finished but dist/index.html is still missing");
  }
  record("client build present", true, "built just now");
}

/** Starts the server with the built client wired up. */
function startServer(): ServerProcess {
  if (!existsSync(SERVER_ENTRY)) {
    throw new SmokeFailure(
      `the server package is not implemented yet (${SERVER_ENTRY} is missing), so the browser smoke test cannot run`,
    );
  }

  note(`starting server on ${BASE_URL} (WEB_DIST=${DIST_DIR})`);
  return Bun.spawn({
    cmd: ["bun", "run", SERVER_ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), WEB_DIST: DIST_DIR },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** Keeps the last lines of server output for diagnostics. */
function attachLog(server: ServerProcess): string[] {
  const sink: string[] = [];
  const forward = async (stream: ReadableStream<Uint8Array> | number | undefined): Promise<void> => {
    if (stream === undefined || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      for (const line of decoder.decode(value).split("\n")) {
        if (line.trim().length === 0) continue;
        sink.push(line.trimEnd());
        if (sink.length > 120) sink.shift();
      }
    }
  };
  void forward(server.stdout);
  void forward(server.stderr);
  return sink;
}

/** Polls `/api/health` until the server answers or gives up. */
async function waitForHealth(server: ServerProcess, serverLog: string[]): Promise<void> {
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new SmokeFailure(
        `the server exited with code ${server.exitCode} before becoming healthy:\n${serverLog.slice(-15).join("\n")}`,
      );
    }
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await Bun.sleep(200);
  }
  throw new SmokeFailure(
    `no healthy server on ${BASE_URL}/api/health after ${SERVER_START_TIMEOUT_MS / 1000}s:\n${serverLog.slice(-15).join("\n")}`,
  );
}

/** Confirms the server actually serves the built client. */
async function verifyClientIsServed(): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}/`);
  } catch (cause) {
    throw new SmokeFailure(`the server does not answer GET / (${String(cause)})`);
  }

  const html = await response.text();
  if (!response.ok || !html.includes('id="root"')) {
    throw new SmokeFailure(
      `the server does not serve the web client: GET / returned HTTP ${response.status} ` +
        `(expected the built index.html from ${DIST_DIR}; is WEB_DIST honoured?)`,
    );
  }
  record("server serves the built client", true);
}

/** Opens the app and waits for the HUD to exist. */
async function openApp(page: Page): Promise<void> {
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("canvas", { state: "attached" });
    await page.waitForSelector('[data-testid="hud-status"]', { state: "visible" });
    // The overlay disappears once the first board frame has been rendered.
    await page.waitForSelector('[data-testid="scene-loading"]', { state: "detached" });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SmokeFailure(`the app did not finish loading in ${PAGE_TIMEOUT_MS / 1000}s (${detail})`);
  }
  record("scene finished loading", true);
}

/** Waits until the automation hook reports a ready game. */
async function waitForReadyGame(page: Page): Promise<void> {
  try {
    await page.waitForFunction(
      () => {
        const api = (window as WindowWithAutomation).__minesweeper3d;
        const snapshot = api?.snapshot();
        return snapshot?.phase === "ready" && snapshot.state !== null;
      },
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
  } catch {
    throw new SmokeFailure("window.__minesweeper3d never reported a ready game (is the app stuck loading?)");
  }
  record("automation hook reports a ready game", true);
}

/**
 * Clicks the middle of the board with flag mode on and returns the number of
 * flagged cells afterwards.
 *
 * The board is a single instanced mesh, so the click's ray crosses the front
 * covered cell *and every covered cell behind it* - only the front one may be
 * flagged. The automation hook cannot catch this: it bypasses the raycast.
 */
async function clickBoardCentreInFlagMode(page: Page): Promise<number> {
  const flagModeButton = page.locator('[data-testid="flag-mode"]');
  await flagModeButton.click();

  try {
    const box = await page.locator("canvas").first().boundingBox();
    if (box === null) throw new SmokeFailure("the canvas has no bounding box to click");
    const before = await readFlagCount(page);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    // Let the click reach the session before reading the state back.
    await page
      .waitForFunction(
        (previous) => {
          const state = (window as WindowWithAutomation).__minesweeper3d?.snapshot().state;
          return state !== null && state !== undefined && state.flagCount !== previous;
        },
        before,
        { timeout: 5000 },
      )
      .catch(() => undefined);
  } finally {
    await flagModeButton.click();
  }

  return readFlagCount(page);
}

/** Number of flagged cells reported by the automation hook. */
async function readFlagCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const state = (window as WindowWithAutomation).__minesweeper3d?.snapshot().state;
    return state?.flagCount ?? 0;
  });
}

/** Reveals a surface cell through the real session. */
async function driveReveal(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as WindowWithAutomation).__minesweeper3d?.reveal({ x: 0, y: 0, z: 0 });
  });
  try {
    await page.waitForFunction(
      () => {
        const state = (window as WindowWithAutomation).__minesweeper3d?.snapshot().state;
        return state !== null && state !== undefined && state.status === "playing" && state.revealedCount > 0;
      },
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
  } catch {
    throw new SmokeFailure("revealing {x:0,y:0,z:0} did not start the game");
  }
}

/**
 * Loses the game the quickest way a player could, by sweeping every cell until
 * a mine explodes.
 *
 * Cells only open from the outside in, so the sweep is repeated until a pass
 * opens nothing new. Mines sit on the outer shell of the cube often enough that
 * the first pass normally ends the game; the freak win restarts the board and
 * tries again.
 */
async function loseGame(page: Page): Promise<void> {
  const status = await page.evaluate(() => {
    const api = (window as WindowWithAutomation).__minesweeper3d;
    if (api === undefined) throw new Error("the automation hook is missing");

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const size = api.snapshot().state?.config.size;
      if (size === undefined) return "no state";

      for (let pass = 0; pass < 64; pass += 1) {
        let progressed = false;
        for (let z = 0; z < size.z; z += 1) {
          for (let y = 0; y < size.y; y += 1) {
            for (let x = 0; x < size.x; x += 1) {
              const before = api.snapshot().state?.revealedCount ?? 0;
              api.reveal({ x, y, z });
              const state = api.snapshot().state;
              if (state === null) return "no state";
              if (state.status === "lost" || state.status === "won") return state.status;
              if (state.revealedCount !== before) progressed = true;
            }
          }
        }
        if (!progressed) break;
      }

      api.newGame();
    }
    return "playing";
  });

  if (status !== "lost") throw new SmokeFailure(`sweeping the board ended as "${status}" instead of "lost"`);
  await page.waitForSelector('[data-testid="result-banner"]', { state: "visible" });
  // The revealed mines load through Suspense after the explosion, and the
  // measurement below compares pixels before and after hiding the panel.
  await page.waitForTimeout(2000);
}

interface OverlayReading {
  readonly status: string;
  readonly background: string;
  readonly backgroundAlpha: number;
  /** Pixels between the centre of the panel and the centre of the board. */
  readonly centreOffsetY: number;
}

/** Geometry and computed style of the game-over overlay. */
async function readOverlay(page: Page): Promise<OverlayReading> {
  const text = ((await page.textContent('[data-testid="result-banner"]')) ?? "").trim();
  const style = await page.evaluate(() => {
    const banner = document.querySelector('[data-testid="result-banner"]');
    const canvas = document.querySelector("canvas");
    if (banner === null || canvas === null) throw new Error("the overlay or the canvas is missing");

    const background = getComputedStyle(banner).backgroundColor;
    const channels = background.replace(/^rgba?\(|\)$/g, "").split(",");
    const bannerBox = banner.getBoundingClientRect();
    const canvasBox = canvas.getBoundingClientRect();

    return {
      background,
      backgroundAlpha: channels.length < 4 ? 1 : Number(channels[3] ?? 1),
      centreOffsetY: canvasBox.y + canvasBox.height / 2 - (bannerBox.y + bannerBox.height / 2),
    };
  });

  return { status: text, ...style };
}

/**
 * How much of the board's contrast survives behind the result panel.
 *
 * The panel's own text is hidden for the measurement, so this is about the
 * board showing through and not about the panel's contents. The ratio compares
 * the luminance spread of the region with the panel in place against the spread
 * of the very same region with the panel hidden: a fully opaque panel scores
 * ~0, the 0.78 alpha / 10px blur this replaced scored 0.10, and the current
 * styling scores ~0.5.
 */
async function measureBoardShowThrough(page: Page): Promise<number> {
  const rect = await bannerRect(page, 4);
  await setOverlayVisibility(page, "contents", true);
  const through = await luminanceSpread(page, await screenshot(page, rect));
  await setOverlayVisibility(page, "panel", true);
  const board = await luminanceSpread(page, await screenshot(page, rect));
  await setOverlayVisibility(page, "panel", false);
  await setOverlayVisibility(page, "contents", false);

  return board.stdDev < 1 ? 0 : through.stdDev / board.stdDev;
}

/**
 * Right-drags from a point *on* the overlay and reports how far the board moved.
 *
 * Orbiting starts on the canvas, so a panel that captured pointer events would
 * make the board impossible to turn while the result is up - and turning it is
 * how the player looks at the mines the overlay covers.
 */
async function orbitFromOverlay(page: Page): Promise<{ moved: boolean; difference: number }> {
  const clip = await page.evaluate(() => {
    const box = document.querySelector("canvas")?.getBoundingClientRect();
    if (box === undefined) throw new Error("the canvas is missing");
    return {
      x: Math.round(box.x + box.width / 2 - 200),
      y: Math.round(box.y + box.height / 2 - 150),
      width: 400,
      height: 300,
    };
  });
  const start = await page.evaluate(() => {
    const box = document.querySelector('[data-testid="result-banner"]')?.getBoundingClientRect();
    if (box === undefined) throw new Error("the result banner is missing");
    // Just inside the panel's left padding: panel, not board, and not the button.
    return { x: box.x + 10, y: box.y + box.height / 2 };
  });

  const before = await screenshot(page, clip);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(start.x + 140, start.y + 60, { steps: 8 });
  await page.mouse.up({ button: "right" });
  // The camera eases into place, so give it a moment to settle.
  await page.waitForTimeout(1000);
  const after = await screenshot(page, clip);

  const difference = await meanAbsoluteDifference(page, before, after);
  return { moved: difference > 2, difference };
}

/** Frame of the overlay, inset by `inset` pixels on every side. */
async function bannerRect(page: Page, inset: number): Promise<SampleRect> {
  return page.evaluate((margin) => {
    const box = document.querySelector('[data-testid="result-banner"]')?.getBoundingClientRect();
    if (box === undefined) throw new Error("the result banner is missing");
    return {
      x: Math.round(box.x + margin),
      y: Math.round(box.y + margin),
      width: Math.round(box.width - 2 * margin),
      height: Math.round(box.height - 2 * margin),
    };
  }, inset);
}

/** Hides the panel itself or only its contents again. */
async function setOverlayVisibility(page: Page, part: "panel" | "contents", hidden: boolean): Promise<void> {
  await page.evaluate(
    ([target, hide]) => {
      const banner = document.querySelector('[data-testid="result-banner"]');
      if (banner === null) return;
      const elements: Element[] = target === "panel" ? [banner] : Array.from(banner.children);
      for (const element of elements) {
        const style = (element as HTMLElement).style;
        if (hide) style.setProperty("visibility", "hidden");
        else style.removeProperty("visibility");
      }
    },
    [part, hidden] as const,
  );
}

interface SampleRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Base64 PNG of one region of the page. */
async function screenshot(page: Page, clip: SampleRect): Promise<string> {
  return (await page.screenshot({ clip })).toString("base64");
}

/**
 * Mean and standard deviation of the luminance of a base64 PNG.
 *
 * The image is handed back to the page to decode: Chromium already has a PNG
 * decoder, and the test runner does not need one just to average pixels. The
 * callback runs in the browser, so the decoding lives inside it.
 */
async function luminanceSpread(page: Page, base64: string): Promise<{ mean: number; stdDev: number }> {
  return page.evaluate(async (encoded) => {
    const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
    if (context === null) throw new Error("no 2d context to read the screenshot with");
    context.drawImage(bitmap, 0, 0);

    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    let sum = 0;
    let sumOfSquares = 0;
    let samples = 0;
    for (let index = 0; index + 3 < pixels.length; index += 4) {
      const luminance =
        0.2126 * (pixels[index] ?? 0) + 0.7152 * (pixels[index + 1] ?? 0) + 0.0722 * (pixels[index + 2] ?? 0);
      sum += luminance;
      sumOfSquares += luminance * luminance;
      samples += 1;
    }

    const mean = sum / samples;
    return { mean, stdDev: Math.sqrt(Math.max(0, sumOfSquares / samples - mean * mean)) };
  }, base64);
}

/** Mean absolute luminance difference between two base64 PNGs of the same size. */
async function meanAbsoluteDifference(page: Page, first: string, second: string): Promise<number> {
  return page.evaluate(
    async ([beforePng, afterPng]) => {
      const decode = async (encoded: string): Promise<Uint8ClampedArray> => {
        const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext("2d");
        if (context === null) throw new Error("no 2d context to read the screenshot with");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };

      const before = await decode(beforePng);
      const after = await decode(afterPng);
      let sum = 0;
      let samples = 0;
      for (let index = 0; index + 3 < before.length; index += 4) {
        const luminance =
          0.2126 * (before[index] ?? 0) + 0.7152 * (before[index + 1] ?? 0) + 0.0722 * (before[index + 2] ?? 0);
        const later =
          0.2126 * (after[index] ?? 0) + 0.7152 * (after[index + 1] ?? 0) + 0.0722 * (after[index + 2] ?? 0);
        sum += Math.abs(luminance - later);
        samples += 1;
      }
      return sum / samples;
    },
    [first, second] as const,
  );
}

/**
 * Clicks the replay button with a real mouse and waits for a fresh board.
 *
 * The panel around the button does not take pointer events, so this also proves
 * the button itself still does - a click that fell through to the canvas would
 * leave the result overlay in place.
 */
async function clickPlayAgain(page: Page): Promise<boolean> {
  await page.locator('[data-testid="play-again"]').click();
  try {
    await page.waitForFunction(
      () => {
        const state = (window as WindowWithAutomation).__minesweeper3d?.snapshot().state;
        return state?.status === "ready" && state.revealedCount === 0;
      },
      undefined,
      { timeout: 5000 },
    );
  } catch {
    return false;
  }

  return (await page.locator('[data-testid="result-banner"]').count()) === 0;
}

interface HudReading {
  readonly status: string;
  readonly progress: string;
  readonly minesLeft: string;
  readonly timer: string;
}

async function readHud(page: Page): Promise<HudReading> {
  return {
    status: ((await page.textContent('[data-testid="hud-status"]')) ?? "").trim(),
    progress: ((await page.textContent('[data-testid="hud-progress"]')) ?? "").trim(),
    minesLeft: ((await page.textContent('[data-testid="hud-mines-left"]')) ?? "").trim(),
    timer: ((await page.textContent('[data-testid="hud-timer"]')) ?? "").trim(),
  };
}

async function canvasHasSize(page: Page): Promise<boolean> {
  const box = await page.locator("canvas").first().boundingBox();
  return box !== null && box.width > 100 && box.height > 100;
}

/** Collects console errors and uncaught page errors. */
function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const text = message.text();
    if (IGNORED_CONSOLE.some((pattern) => pattern.test(text))) return;
    errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`));
  return errors;
}

async function stopServer(server: ServerProcess): Promise<void> {
  if (server.exitCode !== null) return;
  server.kill();
  await Promise.race([server.exited, Bun.sleep(3000)]);
}

/** Prints the summary and returns the process exit code. */
function report(ok: boolean): number {
  for (const check of checks) {
    const mark = check.ok ? "ok  " : "FAIL";
    note(`${mark} ${check.name}${check.detail === "" ? "" : ` — ${check.detail}`}`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  note(ok ? `PASS — ${checks.length} checks, screenshot: ${SCREENSHOT}` : `FAIL — ${failed} of ${checks.length} checks failed`);
  return ok ? 0 : 1;
}

/** Minimal typing of the automation hook inside the page. */
interface PageAutomation {
  snapshot(): {
    readonly phase: string;
    readonly state: {
      readonly status: string;
      readonly revealedCount: number;
      readonly flagCount: number;
      readonly config: { readonly size: { readonly x: number; readonly y: number; readonly z: number } };
    } | null;
  };
  reveal(cell: { x: number; y: number; z: number }): void;
  newGame(presetId?: string): void;
}

type WindowWithAutomation = Window & { __minesweeper3d?: PageAutomation };

process.exit(await main());
