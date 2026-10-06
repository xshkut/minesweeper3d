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
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, CDPSession, Page } from "playwright-core";

const WEB_ROOT = resolve(import.meta.dir, "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const DIST_DIR = resolve(WEB_ROOT, "dist");
const SERVER_ENTRY = resolve(REPO_ROOT, "packages/server/src/index.ts");
const SHOTS_DIR = resolve(WEB_ROOT, "e2e/screenshots");
const SCREENSHOT = resolve(SHOTS_DIR, "board.png");
const LOST_SCREENSHOT = resolve(SHOTS_DIR, "lost.png");
const MARKS_SCREENSHOT = resolve(SHOTS_DIR, "marks.png");
const TOUCH_SCREENSHOT = resolve(SHOTS_DIR, "touch.png");
const CURSOR_SCREENSHOT = resolve(SHOTS_DIR, "cursor.png");
/**
 * Where the server snapshots its rooms.
 *
 * The default is a per-port temp file outside the repository; the restart check
 * wants a path it can delete before boot, and it must be repository-local
 * because the tool that runs this test gives each command its own `/tmp`.
 */
const STATE_FILE = resolve(REPO_ROOT, ".tmp", "e2e-state.json");

const PORT = Number(process.env["E2E_PORT"] ?? 8321);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const CHROME_PATH = process.env["CHROME_PATH"] ?? "/usr/bin/google-chrome";
const CHROME_ARGS = ["--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"];

const SERVER_START_TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 25_000;
/** Pixels of one wheel notch in Chromium, which reports `deltaMode === 0`. */
const ONE_WHEEL_NOTCH = 100;

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
    // A file left behind by an interrupted run would seed this one with rooms
    // nobody asked for; the restart check writes it a moment later.
    await rm(STATE_FILE, { force: true });
    server = startServer();
    let serverLog = attachLog(server);

    await waitForHealth(server, serverLog);
    record("server /api/health responds", true);

    await verifyClientIsServed();

    browser = await chromium.launch({ executablePath: CHROME_PATH, args: CHROME_ARGS, headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const consoleErrors = collectConsoleErrors(page);

    await openApp(page);
    await waitForReadyGame(page);
    record("canvas is mounted and sized", await waitForCanvasSize(page));

    const before = await readHud(page);
    record("HUD shows a fresh board", before.status === "Ready", `status=${before.status} progress=${before.progress}`);

    // Real clicks, so the board's instanced-mesh raycast is exercised as well:
    // one click must reach the front cell only, not every cell behind it.
    const flagged = await clickBoardCentreInFlagMode(page);
    record("one flag click marks exactly one cell", flagged === 1, `flags=${flagged}`);

    const unflagged = await clickBoardCentreInFlagMode(page);
    record("clicking the same cell again clears its flag", unflagged === 0, `flags=${unflagged}`);

    // The detector of a board without charges has to be visibly out of order
    // rather than a click that silently does nothing - and it must not be
    // clickable, so this reads the attribute instead of pressing it.
    record(
      "a board without charges disables the detector",
      await page.locator('[data-testid="tool-probe"]').isDisabled(),
    );

    // The tool switch is exclusive, and digging is what a fresh board starts on.
    await page.click('[data-testid="tool-flag"]');
    const flagOn = await page.getAttribute('[data-testid="tool-flag"]', "aria-pressed");
    const probeOff = await page.getAttribute('[data-testid="tool-probe"]', "aria-pressed");
    record("the tool switch is exclusive", flagOn === "true" && probeOff === "false", `flag=${flagOn} probe=${probeOff}`);

    await page.click('[data-testid="tool-reveal"]');
    record(
      "digging is selectable again",
      (await page.getAttribute('[data-testid="tool-reveal"]', "aria-pressed")) === "true",
    );

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

    const zoom = await zoomFromOverlay(page);
    record(
      "one wheel notch visibly zooms the board",
      zoom.moved,
      `board pixels moved by ${zoom.difference.toFixed(1)}/255`,
    );

    const orbit = await orbitFromOverlay(page);
    record(
      "a drag that starts on the overlay still orbits the board",
      orbit.moved,
      `board pixels moved by ${orbit.difference.toFixed(1)}/255`,
    );

    const replayed = await clickPlayAgain(page);
    record("Play again still works through the pass-through overlay", replayed);

    // "Real" cubes, and the two marks that sit on them: a question mark and the
    // verdict of a free reveal. Both are placed *outside* the cube's own volume
    // every frame, so a depth-occluded marker shows up here as a mark that never
    // appears. Last, because it swaps the room out from under the board checks.
    await page.evaluate(async () => {
      await (window as WindowWithAutomation).__minesweeper3d?.createRoom({
        presetId: "medium",
        freeReveals: 2,
      });
    });
    const marksReady = await page
      .waitForFunction(
        () => {
          const state = (window as WindowWithAutomation).__minesweeper3d?.snapshot().state;
          return state?.config.freeReveals === 2 && state.revealedCount === 0;
        },
        undefined,
        { timeout: 15000 },
      )
      .then(() => true)
      .catch(() => false);
    record("a room can be created with a free-reveal budget", marksReady);

    await page.evaluate(() => {
      const api = (window as WindowWithAutomation).__minesweeper3d;
      if (api === undefined) return;
      // On the top face, which the default camera looks straight at: a mark on
      // the far corner would be hidden behind the cube and prove nothing.
      // One flag and one question mark (the mark cycle is flag -> question -> none).
      api.cycleMark({ x: 1, y: 5, z: 1 });
      api.cycleMark({ x: 4, y: 5, z: 1 });
      api.cycleMark({ x: 4, y: 5, z: 1 });
      // And one free reveal, which spends a charge and colours the cube.
      api.probe({ x: 2, y: 5, z: 4 });
    });
    const marked = await page
      .waitForFunction(
        () =>
          (document.querySelector('[data-testid="hud-free-reveals"]')?.textContent ?? "") === "1 / 2" &&
          (document.querySelector('[data-testid="hud-questions"]')?.textContent ?? "") === "1" &&
          (document.querySelector('[data-testid="hud-flags"]')?.textContent ?? "") === "1",
        undefined,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    record("a flag, a question mark and a spent charge all reach the HUD", marked);

    await page.screenshot({ path: MARKS_SCREENSHOT });
    record("marked-board screenshot written", true, MARKS_SCREENSHOT);

    const errors = [...consoleErrors];
    record("no page errors and no unexpected console errors", errors.length === 0, errors.join(" | "));

    // The mouse checks above all ran on a desktop-sized page. A phone is the
    // case this whole feature exists for, and it takes a different input path -
    // so it gets its own context, its own page and real touch events.
    await checkTouchGestures(browser);

    // Another room, two clients again, and this time the point is what the
    // players tell each other. It needs the server up, like the checks above.
    await checkCursorSharing(browser);

    // The whole point of the state file is surviving a restart, so this goes
    // through a real process boundary: SIGTERM (which flushes the snapshot), a
    // fresh process, the same room read back. It runs last because it kills the
    // server the page above is still connected to.
    const created = await createRoomOverHttp();
    const restarted = await restartServer(server);
    server = restarted.server;
    serverLog = restarted.serverLog;
    const restored = await readRoomOverHttp(created.id);
    record(
      "a room survives a server restart",
      restored !== undefined &&
        restored.id === created.id &&
        restored.mode === created.mode &&
        restored.mineCount === created.mineCount &&
        restored.playerId === created.playerId,
      `before=${describeRoom(created)} after=${restored === undefined ? "gone" : describeRoom(restored)}`,
    );
    const rejoin = await rejoinOverHttp(created.id, created.playerId);
    record("the restored room still knows its player", rejoin === 200, `POST /join answered ${rejoin}`);

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

/**
 * Builds the client unless `dist/` is already newer than every client source.
 *
 * The freshness check matters: testing a stale bundle would report a passing
 * smoke test for code that is no longer on disk. `E2E_SKIP_BUILD=1` forces the
 * existing build to be used as is.
 */
async function ensureClientBuild(): Promise<void> {
  if (process.env["E2E_SKIP_BUILD"] === "1") {
    record("client build present", existsSync(resolve(DIST_DIR, "index.html")), `${DIST_DIR} (build skipped)`);
    return;
  }
  if (await isClientBuildFresh()) {
    record("client build is up to date", true, DIST_DIR);
    return;
  }

  note("client sources are newer than dist/ - building the client (bun run build)");
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
  record("client build is up to date", true, "built just now");
}

/** True when `dist/index.html` is at least as new as every client source file. */
async function isClientBuildFresh(): Promise<boolean> {
  const index = resolve(DIST_DIR, "index.html");
  if (!existsSync(index)) return false;
  const builtAt = (await stat(index)).mtimeMs;

  const roots = [resolve(WEB_ROOT, "src"), resolve(WEB_ROOT, "public")];
  const files = [resolve(WEB_ROOT, "index.html"), resolve(WEB_ROOT, "vite.config.ts")];
  let newest = 0;
  for (const file of files) {
    if (existsSync(file)) newest = Math.max(newest, (await stat(file)).mtimeMs);
  }
  for (const root of roots) {
    if (existsSync(root)) newest = Math.max(newest, await newestMtime(root));
  }
  return newest <= builtAt;
}

/** Newest modification time found anywhere under `directory`. */
async function newestMtime(directory: string): Promise<number> {
  let newest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(path));
    else if (entry.isFile()) newest = Math.max(newest, (await stat(path)).mtimeMs);
  }
  return newest;
}

/** Starts the server with the built client wired up. */
function startServer(): ServerProcess {
  if (!existsSync(SERVER_ENTRY)) {
    throw new SmokeFailure(
      `the server package is not implemented yet (${SERVER_ENTRY} is missing), so the browser smoke test cannot run`,
    );
  }

  note(`starting server on ${BASE_URL} (WEB_DIST=${DIST_DIR}, STATE_FILE=${STATE_FILE})`);
  return Bun.spawn({
    cmd: ["bun", "run", SERVER_ENTRY],
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT), WEB_DIST: DIST_DIR, STATE_FILE },
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

/**
 * Drives the real lobby controls, then creates a room through the form.
 *
 * The match mode and the mine count are the two choices the room cannot be
 * changed into later, so they are the ones worth proving reach the server. The
 * room is left again afterwards, so the rest of the smoke still starts from the
 * lobby and keeps using the automation hook to build its own classic board.
 */
async function checkLobbyControls(page: Page): Promise<void> {
  await page.click('[data-testid="welcome-mode-survival"]');
  const recommended = await page.getAttribute('[data-testid="welcome-difficulty"]', "data-difficulty");
  record("survival recommends the hardest tier", recommended === "super-hard", `tier=${recommended}`);

  // Resize first, then pick the tier: the cube rescales by density, which would
  // otherwise move the count out from under the tier that was just clicked.
  await page.selectOption('[data-testid="welcome-preset"]', "tiny");
  await page.click('[data-testid="welcome-tier-easy"]');
  const tier = await page.getAttribute('[data-testid="welcome-difficulty"]', "data-difficulty");
  const mines = ((await page.textContent('[data-testid="welcome-mines-value"]')) ?? "").trim();
  record(
    "a tier button sets the mine count and the badge follows",
    tier === "easy" && mines === "1",
    `tier=${tier} mines=${mines}`,
  );

  // An unlisted room: the code is the whole of its access control, so it has to
  // be long enough not to be guessed and it must stay out of the lobby listing.
  // The aid is opt-in and must reach the room with the create body.
  await page.fill('[data-testid="welcome-free-reveals"]', "2");
  const charges = ((await page.inputValue('[data-testid="welcome-free-reveals"]')) ?? "").trim();
  record("the lobby takes a free-reveal budget", charges === "2", `charges=${charges}`);

  await page.click('[data-testid="welcome-visibility-private"]');
  const label = ((await page.textContent('[data-testid="welcome-create"]')) ?? "").trim();
  record("picking private relabels the create button", label === "Create private room", `label=${label}`);

  await page.click('[data-testid="welcome-create"]');
  try {
    await page.waitForSelector('[data-testid="room-badge"]', { state: "visible" });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SmokeFailure(`creating a room through the lobby form never opened a room (${detail})`);
  }

  const aid = ((await page.textContent('[data-testid="room-free-reveals"]')) ?? "").trim();
  record("the room reports the free reveals the lobby asked for", aid === "2", `aid=${aid}`);

  // Spend one over the live socket: the HUD counter proves the charge reached
  // the room's board and came back.
  await page.waitForFunction(
    () => {
      const snapshot = (window as WindowWithAutomation).__minesweeper3d?.snapshot();
      return snapshot?.phase === "ready" && snapshot.state !== null;
    },
    undefined,
    { timeout: 15000 },
  );
  await page.evaluate(() => (window as WindowWithAutomation).__minesweeper3d?.probe({ x: 0, y: 0, z: 0 }));
  const spent = await page
    .waitForFunction(
      () => (document.querySelector('[data-testid="hud-free-reveals"]')?.textContent ?? "").startsWith("1"),
      undefined,
      { timeout: 5000 },
    )
    .then(() => true)
    .catch(() => false);
  record("the detector spends a free reveal over the live board", spent);

  const mode = ((await page.textContent('[data-testid="room-mode"]')) ?? "").trim();
  const played = await page.getAttribute('[data-testid="room-difficulty"]', "data-difficulty");
  const shown = ((await page.textContent('[data-testid="room-mines"]')) ?? "").trim();
  record(
    "the room plays the mode and mine tier the lobby asked for",
    mode.toLowerCase().includes("survival") && played === "easy" && shown.startsWith("1"),
    `mode=${mode} tier=${played} mines=${shown}`,
  );

  const code = ((await page.textContent('[data-testid="room-code"]')) ?? "").trim();
  const unlisted = ((await page.textContent('[data-testid="room-visibility"]')) ?? "").trim();
  record(
    "a private room is badged as private and gets a long share code",
    unlisted === "Private" && /^[A-HJ-KM-NP-Z2-9]{10}$/.test(code),
    `visibility=${unlisted} code=${code}`,
  );

  const inUrl = new URL(page.url()).searchParams.get("room");
  record("the share code is in the page URL", inUrl === code, `url room=${inUrl}`);

  const listed = await page.evaluate(async () => {
    const response = await fetch("/api/rooms");
    const body = (await response.json()) as { rooms?: { id: string }[] };
    return (body.rooms ?? []).map((room) => room.id);
  });
  record("a private room is absent from the lobby listing", !listed.includes(code), `listed=${listed.length}`);

  const toggle = '[data-testid="hud-toggle"]';
  await page.click(toggle);
  const collapsed = await page.getAttribute(toggle, "aria-expanded");
  const dockOpen = await page.$eval(".hud-dock", (element) => element.hasAttribute("data-open"));
  record("the panel toggle collapses the left panel", collapsed === "false" && !dockOpen, `expanded=${collapsed}`);

  await page.click(toggle);
  record("the panel toggle brings it back", (await page.getAttribute(toggle, "aria-expanded")) === "true");

  // Reloading with the code still in the URL must land back in the same seat.
  await page.reload({ waitUntil: "domcontentloaded" });
  try {
    await page.waitForSelector('[data-testid="room-badge"]', { state: "visible" });
  } catch {
    throw new SmokeFailure("reloading a /?room= link never rejoined the room");
  }
  const rejoined = ((await page.textContent('[data-testid="room-code"]')) ?? "").trim();
  const seats = await page.$$eval('[data-testid="room-players"] .room__player', (rows) =>
    rows.map((row) => row.getAttribute("data-self") === "true"),
  );
  record(
    "a reload of the room link reclaims the same seat",
    rejoined === code && seats.length === 1 && seats[0] === true,
    `code=${rejoined} seats=${seats.length}`,
  );

  await page.waitForSelector('[data-testid="scene-loading"]', { state: "detached" }).catch(() => undefined);
  await page.click('[data-testid="leave-room"]');
  try {
    await page.waitForSelector('[data-testid="welcome-screen"]', { state: "visible" });
  } catch {
    throw new SmokeFailure("leaving a room never returned to the lobby");
  }
  const staleRoom = new URL(page.url()).searchParams.get("room");
  record("leaving a room returns to the lobby and clears the URL", staleRoom === null, `url room=${staleRoom}`);
}

/**
 * Opens the app, proves the welcome screen came first and creates a room.
 *
 * The default mode is server-side, so there is no board until a room exists:
 * the lobby is the first thing a player sees.
 */
async function openApp(page: Page): Promise<void> {
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="welcome-screen"]', { state: "visible" });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SmokeFailure(`the welcome screen never appeared (${detail})`);
  }
  record("welcome screen is shown before any board", true);

  await checkLobbyControls(page);

  try {
    await page.evaluate(() =>
      (window as WindowWithAutomation).__minesweeper3d?.createRoom({ playerName: "Smoke", presetId: "classic" }),
    );
    await page.waitForSelector('[data-testid="room-badge"]', { state: "visible" });
    await page.waitForSelector("canvas", { state: "attached" });
    await page.waitForSelector('[data-testid="hud-status"]', { state: "visible" });
    // The overlay disappears once the first board frame has been rendered.
    await page.waitForSelector('[data-testid="scene-loading"]', { state: "detached" });
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SmokeFailure(`the app did not finish loading in ${PAGE_TIMEOUT_MS / 1000}s (${detail})`);
  }
  record("scene finished loading", true);

  const code = ((await page.textContent('[data-testid="room-code"]')) ?? "").trim();
  record("the room badge shows the share code", /^[A-HJ-KM-NP-Z2-9]{10}$/.test(code), `code=${code}`);
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
  const flagTool = page.locator('[data-testid="tool-flag"]');
  await flagTool.click();

  try {
    const box = await page.locator("canvas").first().boundingBox();
    if (box === null) throw new SmokeFailure("the canvas has no bounding box to click");
    const before = await readFlagCount(page);
    const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    // A click that lands on the HUD instead of the board would fail somewhere
    // far away from here (a flag that never appears), so it is caught up front.
    const onCanvas = await page.evaluate(([x, y]) => document.elementFromPoint(x as number, y as number)?.tagName === "CANVAS", [centre.x, centre.y]);
    if (!onCanvas) {
      throw new SmokeFailure(`the middle of the canvas (${centre.x}, ${centre.y}) is covered by the HUD`);
    }
    await page.mouse.click(centre.x, centre.y);
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
    await page.click('[data-testid="tool-reveal"]');
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
 * Loses the game the quickest way a player could, by revealing every cell the
 * digging rule currently allows until a mine explodes.
 *
 * The board is server-authoritative, so a reveal travels over the socket and the
 * state only changes once the update frame comes back. The sweep therefore reads
 * the state, batch-reveals the cells that are exposed right now, then waits for
 * the board to settle before looking again; repeating the pass digs inwards.
 * Mines sit on the outer shell of the cube often enough that an early pass
 * normally ends the game; the freak win restarts the board and tries again.
 */
async function loseGame(page: Page): Promise<void> {
  const status = await page.evaluate(async (): Promise<string> => {
    const api = (window as WindowWithAutomation).__minesweeper3d;
    if (api === undefined) throw new Error("the automation hook is missing");

    const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

    /** Waits until two consecutive reads agree, or the game ends. */
    const settle = async (): Promise<string | null> => {
      let previous: unknown = undefined;
      for (let i = 0; i < 400; i += 1) {
        const state = api.snapshot().state;
        if (state === null) return "no state";
        if (state.status !== "playing") return state.status;
        if (state === previous) return null;
        previous = state;
        await sleep(5);
      }
      return null;
    };

    for (let attempt = 0; attempt < 5; attempt += 1) {
      for (let pass = 0; pass < 64; pass += 1) {
        const state = api.snapshot().state;
        if (state === null) return "no state";
        if (state.status !== "playing") return state.status;

        const size = state.config.size;
        const revealed = new Set<number>();
        for (const cell of state.cells) {
          if (cell.isRevealed) revealed.add(cell.index.x + size.x * (cell.index.y + size.y * cell.index.z));
        }
        const offset = (x: number, y: number, z: number): number =>
          x + size.x * (y + size.y * z);
        const open = (x: number, y: number, z: number): boolean =>
          x >= 0 && y >= 0 && z >= 0 && x < size.x && y < size.y && z < size.z && revealed.has(offset(x, y, z));

        let swept = 0;
        for (const cell of state.cells) {
          if (cell.isRevealed || cell.isFlagged) continue;
          const { x, y, z } = cell.index;
          if (!open(x - 1, y, z) && !open(x + 1, y, z) && !open(x, y - 1, z) &&
              !open(x, y + 1, z) && !open(x, y, z - 1) && !open(x, y, z + 1)) {
            continue;
          }
          api.reveal(cell.index);
          swept += 1;
        }
        if (swept === 0) break;

        const settled = await settle();
        if (settled !== null) return settled;
      }

      api.newGame();
      await sleep(100);
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
/** Frame of the middle of the board, forgiving enough to stay on the cube. */
async function boardClip(page: Page): Promise<SampleRect> {
  return page.evaluate(() => {
    const box = document.querySelector("canvas")?.getBoundingClientRect();
    if (box === undefined) throw new Error("the canvas is missing");
    return {
      x: Math.round(box.x + box.width / 2 - 200),
      y: Math.round(box.y + box.height / 2 - 150),
      width: 400,
      height: 300,
    };
  });
}

/**
 * A point inside the result panel that still reaches the board behind it.
 *
 * The panel is translucent and does not take pointer events, so a drag or a
 * wheel here must reach the canvas - which is exactly what the camera checks
 * below rely on.
 */
async function overlayPassThroughPoint(page: Page): Promise<{ x: number; y: number }> {
  return page.evaluate(() => {
    const box = document.querySelector('[data-testid="result-banner"]')?.getBoundingClientRect();
    if (box === undefined) throw new Error("the result banner is missing");
    // Just inside the panel's left padding: panel, not board, and not the button.
    return { x: box.x + 10, y: box.y + box.height / 2 };
  });
}

async function orbitFromOverlay(page: Page): Promise<{ moved: boolean; difference: number }> {
  const clip = await boardClip(page);
  const start = await overlayPassThroughPoint(page);

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

/**
 * Zooms with a single wheel notch and reports how much the board pixels moved.
 *
 * One notch is deliberate: the complaint was that zooming felt sluggish, so the
 * check is that a *single* notch is already a visible move. The size of that
 * move - the part that a screenshot threshold cannot measure reliably - is
 * pinned by the unit tests in `src/three/orbit.test.ts` instead.
 */
async function zoomFromOverlay(page: Page): Promise<{ moved: boolean; difference: number }> {
  const clip = await boardClip(page);
  const point = await overlayPassThroughPoint(page);

  const before = await screenshot(page, clip);
  await page.mouse.move(point.x, point.y);
  // Scrolling up zooms in: the camera moves closer, so the board grows.
  await page.mouse.wheel(0, -ONE_WHEEL_NOTCH);
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

/** A point on the page, in CSS pixels. */
interface TouchPoint {
  readonly x: number;
  readonly y: number;
}

/** Flags and question marks, as the HUD shows them. */
interface MarkCounts {
  readonly flags: number;
  readonly questions: number;
}

/**
 * How long a finger must rest before the board marks a cell under it.
 *
 * Mirrors `LONG_PRESS_MS` in `src/three/useBoardPointer.ts`; the wait below adds
 * a margin, so this only has to be the same order of magnitude.
 */
const TOUCH_REST_MS = 450;

/**
 * Drives a phone-sized touch context through the gestures a finger makes.
 *
 * Chromium only reports `pointerType: "touch"` when the context has `hasTouch`,
 * so running these on the desktop page would silently exercise the mouse path
 * instead. The drags go through CDP's touch stream because Playwright's
 * `touchscreen` can tap but cannot express a swipe or a second finger.
 */
async function checkTouchGestures(browser: Browser): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  const consoleErrors = collectConsoleErrors(page);
  const touch = await context.newCDPSession(page);
  const toggle = '[data-testid="hud-toggle"]';

  /**
   * Taps the toggle and waits for the panel to reach the state a tap needs.
   *
   * Waiting a fixed time is not enough. The panel slides over 220ms, and the
   * slide only advances when the page produces a frame - which this renderer,
   * software-rasterising a WebGL scene, does a handful of times a second. A
   * control's box read mid-slide is where the control *was*, so the tap lands on
   * the panel behind it, or on the board once the panel has moved clear.
   */
  async function setPanel(open: boolean): Promise<void> {
    await tapTouch(touch, await centreOf(page, toggle));
    await waitForAttribute(page, toggle, "aria-expanded", open ? "true" : "false");
    await waitForPanel(page, open);
  }

  /** Opens the folded panel, taps `selector` inside it, then folds it away. */
  async function pickThroughPanel(selector: string): Promise<boolean> {
    await setPanel(true);
    await tapTouch(touch, await centreOf(page, selector));
    const picked = await waitForAttribute(page, selector, "aria-pressed", "true");
    await setPanel(false);
    return picked;
  }

  try {
    await openTouchBoard(page);

    // The panel is nearly the whole screen on a phone, so it is supposed to
    // start folded away with the board in view.
    const folded = await page.getAttribute(toggle, "aria-expanded");
    const dockOpen = await page.$eval(".hud-dock", (element) => element.hasAttribute("data-open"));
    record("a touch screen starts with the panel folded away", folded === "false" && !dockOpen, `expanded=${folded}`);

    // A folded panel takes the counters with it, so the strip along the top
    // carries the two a player checks mid-game.
    const stripMines = await page.textContent('[data-testid="hud-compact-mines"]').catch(() => null);
    const stripTimer = await page.textContent('[data-testid="hud-compact-timer"]').catch(() => null);
    record(
      "the folded panel still shows the mines and the clock",
      stripMines !== null && /^\d{2}:\d{2}$/.test(stripTimer ?? ""),
      `mines=${stripMines} timer=${stripTimer}`,
    );

    // Tapping the toggle is also the first proof that a tap reaches the HUD at
    // all rather than being swallowed by the canvas underneath it.
    await tapTouch(touch, await centreOf(page, toggle));
    record("a tap opens the folded panel", await waitForAttribute(page, toggle, "aria-expanded", "true"));
    await waitForPanel(page, true);
    record(
      "the open panel takes the strip away",
      (await page.$('[data-testid="hud-compact"]')) === null,
    );

    // The flag tool lives inside the panel, so this proves a tap drives the
    // panel's controls, not just its toggle.
    await tapTouch(touch, await centreOf(page, '[data-testid="tool-flag"]'));
    const flagPicked = await waitForAttribute(page, '[data-testid="tool-flag"]', "aria-pressed", "true");
    record("a tap picks a tool", flagPicked);

    // Fold the panel away again: at 390px wide it covers the board's centre.
    await setPanel(false);

    const board = await boardCentre(page);
    await tapTouch(touch, board);
    record("a tap marks the cell under the finger", await waitForFlagCount(page, 1), `flags=${await readFlagCount(page)}`);

    // The mark cycle is flag -> question -> none, so this leaves the cell with a
    // question mark, which is exactly the state the resting-finger check below
    // has to cope with. Only a tool that really is the flag reaches the first of
    // those two states, so the pair of checks rules out a tap that dug instead.
    await tapTouch(touch, board);
    record(
      "tapping the marked cell again advances its mark",
      await waitForFlagCount(page, 0),
      `flags=1->${await readFlagCount(page)}`,
    );

    // A phone-shaped record of the layout: folded panel, marked cell, safe-area
    // padding. The desktop screenshots show none of that.
    await mkdir(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: TOUCH_SCREENSHOT });
    record("touch screenshot written", true, TOUCH_SCREENSHOT);

    // Digging is what a fresh board starts on, so switching to it through the
    // folded panel proves the pick reaches a control that was not already on.
    const revealPicked = await pickThroughPanel('[data-testid="tool-reveal"]');
    record(
      "a tap switches the tool through the folded panel",
      revealPicked && (await page.getAttribute('[data-testid="tool-flag"]', "aria-pressed")) === "false",
    );

    // A finger that rests on a cell marks it. Which mark it lands on depends on
    // the cycle above, so the check is that the marks changed at all.
    const marksBeforeHold = await readMarkCounts(page);
    const revealedBeforeHold = await readRevealedCount(page);
    await dispatchTouch(touch, "touchStart", [board]);
    await page.waitForTimeout(TOUCH_REST_MS + 250);
    const markedByHold = await waitForMarkChange(page, marksBeforeHold);
    await dispatchTouch(touch, "touchEnd", []);
    const marksAfterHold = await readMarkCounts(page);
    record(
      "resting a finger on a cell marks it",
      markedByHold,
      `flags=${marksBeforeHold.flags}->${marksAfterHold.flags} questions=${marksBeforeHold.questions}->${marksAfterHold.questions}`,
    );
    await page.waitForTimeout(300);
    record(
      "the release after a rest does not dig as well",
      (await readRevealedCount(page)) === revealedBeforeHold,
      `revealed=${revealedBeforeHold}->${await readRevealedCount(page)}`,
    );

    // A swipe is a camera move, not a dig: the board pixels have to move while
    // the cells underneath stay exactly as they were.
    const clip = await touchBoardClip(page);
    const marksBeforeSwipe = await readMarkCounts(page);
    const revealedBeforeSwipe = await readRevealedCount(page);
    const beforeSwipe = await screenshot(page, clip);
    await swipeTouch(touch, board, { x: board.x + 110, y: board.y + 55 });
    // The camera eases into place, so give it a moment to settle.
    await page.waitForTimeout(1200);
    const swipeMove = await meanAbsoluteDifference(page, beforeSwipe, await screenshot(page, clip));
    record("a swipe turns the board instead of digging", swipeMove > 2, `board pixels moved by ${swipeMove.toFixed(1)}/255`);

    const marksAfterSwipe = await readMarkCounts(page);
    record(
      "the swipe left every cell alone",
      marksAfterSwipe.flags === marksBeforeSwipe.flags &&
        marksAfterSwipe.questions === marksBeforeSwipe.questions &&
        (await readRevealedCount(page)) === revealedBeforeSwipe,
      `flags=${marksAfterSwipe.flags} questions=${marksAfterSwipe.questions} revealed=${await readRevealedCount(page)}`,
    );

    // Two fingers are the only way to zoom without a wheel.
    const beforePinch = await screenshot(page, clip);
    await pinchTouch(touch, board, 45, 130);
    await page.waitForTimeout(1200);
    const pinchMove = await meanAbsoluteDifference(page, beforePinch, await screenshot(page, clip));
    record("a two-finger pinch zooms the board", pinchMove > 2, `board pixels moved by ${pinchMove.toFixed(1)}/255`);

    const touchErrors = [...consoleErrors];
    record("the touch page logs no unexpected console errors", touchErrors.length === 0, touchErrors.join(" | "));
  } finally {
    await touch.detach().catch(() => undefined);
    await context.close().catch(() => undefined);
  }
}

/**
 * Two players, one room, and the pointer of one reaching the other.
 *
 * The trail itself lives in the render loop, so a picture of it would prove
 * little. What is worth proving end to end is the path underneath: a real mouse
 * move across the board, through the app's own pointer handling and the socket,
 * relayed by the server, and stored where the other client's render loop reads
 * it every frame. And then it has to go away again, because a marker nobody is
 * driving would sit on the cube forever.
 */
async function checkCursorSharing(browser: Browser): Promise<void> {
  // Two contexts rather than two pages: a player *is* the client identity kept
  // in storage, so two pages of one context would be the same player twice.
  const hostContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const guestContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const host = await hostContext.newPage();
  const guest = await guestContext.newPage();

  try {
    await openLobby(host);
    const room = await host.evaluate(async () => {
      const joined = await (window as WindowWithAutomation).__minesweeper3d?.createRoom({
        playerName: "Host",
        presetId: "classic",
      });
      const id = (joined as { room?: { id?: string } } | null | undefined)?.room?.id;
      return id ?? null;
    });
    await waitForBoard(host);
    if (room === null) throw new SmokeFailure("the host never got a room to point inside");

    await openLobby(guest);
    await guest.evaluate(async (id: string) => {
      await (window as WindowWithAutomation).__minesweeper3d?.joinRoom(id, { playerName: "Guest" });
    }, room);
    await waitForBoard(guest);

    const seats = await guest.evaluate(
      () => (window as WindowWithAutomation).__minesweeper3d?.snapshot().room?.players.length ?? 0,
    );
    record("a room holds both players", seats === 2, `room=${room} seats=${seats}`);

    // A real mouse over a real canvas, so the raycast is in the path too.
    const centre = await boardCentre(host);
    await host.mouse.move(centre.x - 24, centre.y);
    await host.mouse.move(centre.x, centre.y);

    const pointing = await waitForSeatPointing(guest, true);
    record(
      "a pointer over the board reaches the other player",
      pointing !== null,
      pointing?.cell === null || pointing?.cell === undefined
        ? "the other seat never saw a pointer"
        : `cell=(${pointing.cell.x},${pointing.cell.y},${pointing.cell.z})`,
    );

    await guest.screenshot({ path: CURSOR_SCREENSHOT });
    record("remote-pointer screenshot written", true, CURSOR_SCREENSHOT);

    // Off the board and onto the HUD, which is what a player does when they
    // go back to the counters - the marker has to go with them.
    const away = await centreOf(host, '[data-testid="hud-status"]');
    await host.mouse.move(away.x, away.y);
    const lifted = await waitForSeatPointing(guest, false);
    record(
      "the marker goes when the mouse leaves the board",
      lifted !== null,
      lifted === null ? "the other seat still saw a pointer" : "cleared",
    );

    const swatches = await guest.$$eval(".room__swatch", (nodes) =>
      nodes.map((node) => node.getAttribute("data-player-color") ?? ""),
    );
    record(
      "the roster names a colour for every seat",
      swatches.length === 2 && swatches.every((color) => /^#[0-9a-f]{6}$/.test(color)),
      `swatches=${swatches.join(",")}`,
    );
  } finally {
    await hostContext.close().catch(() => undefined);
    await guestContext.close().catch(() => undefined);
  }
}

/** Gets a page to the lobby, where a room can be created or joined. */
async function openLobby(page: Page): Promise<void> {
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="welcome-screen"]', { state: "visible" });
}

/** Waits until a page holds a drawn, playable board. */
async function waitForBoard(page: Page): Promise<void> {
  try {
    await page.waitForSelector("canvas", { state: "attached" });
    await page.waitForSelector('[data-testid="hud-status"]', { state: "visible" });
    // The overlay disappears once the first board frame has been rendered.
    await page.waitForSelector('[data-testid="scene-loading"]', { state: "detached" });
    await page.waitForFunction(
      () => {
        const snapshot = (window as WindowWithAutomation).__minesweeper3d?.snapshot();
        return snapshot?.phase === "ready" && snapshot.state !== null;
      },
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SmokeFailure(`a page never reached a playable board (${detail})`);
  }
}

/** What one page's hook says about the other seats' pointers. */
interface CursorReading {
  readonly playerId: string;
  readonly cell: { readonly x: number; readonly y: number; readonly z: number } | null;
}

/**
 * Waits until some other seat is (or is no longer) pointing somewhere.
 *
 * @returns the reading that satisfied the wait, or `null` when it never did
 */
async function waitForSeatPointing(page: Page, pointed: boolean): Promise<CursorReading | null> {
  try {
    await page.waitForFunction(
      (want: boolean) => {
        const reading = (window as WindowWithAutomation).__minesweeper3d?.cursors() ?? [];
        return reading.some((entry) => (entry.cell !== null) === want);
      },
      pointed,
      { timeout: 8000 },
    );
  } catch {
    return null;
  }
  const reading = await page.evaluate(() => (window as WindowWithAutomation).__minesweeper3d?.cursors() ?? []);
  return reading.find((entry) => (entry.cell !== null) === pointed) ?? null;
}

/**
 * Opens the app in the touch context and creates a room.
 *
 * The lobby has its own desktop-sized checks; this page exists for the gestures,
 * so it creates its room through the automation hook and gets straight to the
 * board.
 */
async function openTouchBoard(page: Page): Promise<void> {
  page.setDefaultTimeout(PAGE_TIMEOUT_MS);
  try {
    await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="welcome-screen"]', { state: "visible" });
    await page.evaluate(() =>
      (window as WindowWithAutomation).__minesweeper3d?.createRoom({ playerName: "Touch", presetId: "classic" }),
    );
    // Attached, not visible: a phone opens with the panel folded away, and the
    // badge lives inside it. That folded start is itself checked below.
    await page.waitForSelector('[data-testid="room-badge"]', { state: "attached" });
    await page.waitForSelector("canvas", { state: "attached" });
    // The overlay disappears once the first board frame has been rendered.
    await page.waitForSelector('[data-testid="scene-loading"]', { state: "detached" });
    await page.waitForFunction(
      () => {
        const snapshot = (window as WindowWithAutomation).__minesweeper3d?.snapshot();
        return snapshot?.phase === "ready" && snapshot.state !== null;
      },
      undefined,
      { timeout: PAGE_TIMEOUT_MS },
    );
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
    throw new SmokeFailure(`the phone-sized page never finished loading (${detail})`);
  }
}

/** Centre of the canvas, which is where the camera looks. */
async function boardCentre(page: Page): Promise<TouchPoint> {
  const box = await page.locator("canvas").first().boundingBox();
  if (box === null) throw new SmokeFailure("the touch canvas has no box to tap");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Centre of a selector's box, in page coordinates. */
async function centreOf(page: Page, selector: string): Promise<TouchPoint> {
  const box = await page.locator(selector).first().boundingBox();
  if (box === null) throw new SmokeFailure(`${selector} has no box to tap`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Frame of the middle of the board that still fits a phone's viewport. */
async function touchBoardClip(page: Page): Promise<SampleRect> {
  return page.evaluate(() => {
    const box = document.querySelector("canvas")?.getBoundingClientRect();
    if (box === undefined) throw new Error("the canvas is missing");
    return {
      x: Math.round(box.x + box.width / 2 - 90),
      y: Math.round(box.y + box.height / 2 - 90),
      width: 180,
      height: 180,
    };
  });
}

/** Sends one frame of a raw touch stream. */
async function dispatchTouch(
  client: CDPSession,
  type: "touchStart" | "touchMove" | "touchEnd",
  points: readonly TouchPoint[],
): Promise<void> {
  await client.send("Input.dispatchTouchEvent", {
    type,
    // A radius and a force make Chromium treat these as real fingertips rather
    // than a stylus tip, which is what the board's pointer path keys off.
    touchPoints: points.map((point, index) => ({
      x: Math.round(point.x),
      y: Math.round(point.y),
      id: index,
      radiusX: 4,
      radiusY: 4,
      force: 1,
    })),
  });
}

/** Taps once: a finger down and up on the same spot. */
async function tapTouch(client: CDPSession, at: TouchPoint): Promise<void> {
  await dispatchTouch(client, "touchStart", [at]);
  await dispatchTouch(client, "touchEnd", []);
}

/** Swipes from one point to another in steps, so the app sees a real move. */
async function swipeTouch(client: CDPSession, from: TouchPoint, to: TouchPoint, steps = 10): Promise<void> {
  await dispatchTouch(client, "touchStart", [from]);
  for (let step = 1; step <= steps; step += 1) {
    await dispatchTouch(client, "touchMove", [
      { x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps },
    ]);
  }
  await dispatchTouch(client, "touchEnd", []);
}

/** Pinches two fingers around `centre`, widening them from `from` to `to`. */
async function pinchTouch(client: CDPSession, centre: TouchPoint, from: number, to: number, steps = 10): Promise<void> {
  const spread = (half: number): TouchPoint[] => [
    { x: centre.x - half, y: centre.y },
    { x: centre.x + half, y: centre.y },
  ];
  await dispatchTouch(client, "touchStart", spread(from));
  for (let step = 1; step <= steps; step += 1) {
    await dispatchTouch(client, "touchMove", spread(from + ((to - from) * step) / steps));
  }
  await dispatchTouch(client, "touchEnd", []);
}

/** Waits for an attribute to reach a value, reporting whether it did. */
async function waitForAttribute(
  page: Page,
  selector: string,
  attribute: string,
  value: string,
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    await page.waitForFunction(
      (want: { selector: string; attribute: string; value: string }) =>
        document.querySelector(want.selector)?.getAttribute(want.attribute) === want.value,
      { selector, attribute, value },
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits for the HUD panel to finish sliding, reporting whether it did.
 *
 * A fixed sleep cannot do this. The slide is a CSS transition, and a transition
 * only advances when the page paints a frame; this renderer software-rasterises
 * a WebGL scene through swiftshader and manages a handful of frames a second, so
 * 400ms of `waitForTimeout` can leave the panel exactly where it started. Asking
 * for its computed style in a loop is what moves it along - the read forces the
 * recalc that the transition needs - and it doubles as the assertion, because
 * the final values are the ones the stylesheet settles on.
 */
async function waitForPanel(page: Page, open: boolean, timeoutMs = 3000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (want: boolean) => {
        const panel = document.querySelector(".hud-dock .hud");
        if (panel === null) return false;
        const style = getComputedStyle(panel);
        return want
          ? style.transform === "none" && style.visibility === "visible"
          : style.visibility === "hidden";
      },
      open,
      { timeout: timeoutMs, polling: 40 },
    );
    return true;
  } catch {
    return false;
  }
}

/** Number of flagged cells reported by the automation hook, once it settles. */
async function waitForFlagCount(page: Page, want: number, timeoutMs = 3000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (target: number) => {
        const state = (window as WindowWithAutomation).__minesweeper3d?.snapshot().state;
        return (state?.flagCount ?? 0) === target;
      },
      want,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/** Flags and question marks as the HUD shows them. */
async function readMarkCounts(page: Page): Promise<MarkCounts> {
  return page.evaluate(() => {
    const read = (testId: string) =>
      Number.parseInt(document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "0", 10) || 0;
    return { flags: read("hud-flags"), questions: read("hud-questions") };
  });
}

/** Waits for the HUD's marks to differ from `before`, reporting whether they did. */
async function waitForMarkChange(page: Page, before: MarkCounts, timeoutMs = 3000): Promise<boolean> {
  try {
    await page.waitForFunction(
      (previous: MarkCounts) => {
        const read = (testId: string) =>
          Number.parseInt(document.querySelector(`[data-testid="${testId}"]`)?.textContent ?? "0", 10) || 0;
        return read("hud-flags") !== previous.flags || read("hud-questions") !== previous.questions;
      },
      before,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

/** Number of cells the player has opened. */
async function readRevealedCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as WindowWithAutomation).__minesweeper3d?.snapshot().state?.revealedCount ?? 0);
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

/**
 * True once the canvas covers the viewport *and* r3f has sized its buffer.
 *
 * Both halves matter. CSS fills the canvas shell immediately, so the layout box
 * is right from the first frame - but the drawing buffer and the pointer
 * pipeline are set up by r3f from a resize observer, and until that has run the
 * canvas is still the default 300x150 underneath and the board does not hear
 * the pointer at all. A click in that window is silently lost, which is exactly
 * what "bigger than a hundred pixels" used to let through.
 */
async function canvasHasSize(page: Page): Promise<boolean> {
  const measured = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (canvas === null) return null;
    const box = canvas.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      bufferWidth: canvas.width,
      bufferHeight: canvas.height,
    };
  });
  if (measured === null) return false;

  const viewport = page.viewportSize();
  if (viewport === null) return measured.width > 100 && measured.height > 100;
  return (
    measured.width >= viewport.width - 1 &&
    measured.height >= viewport.height - 1 &&
    measured.bufferWidth >= viewport.width - 1 &&
    measured.bufferHeight >= viewport.height - 1
  );
}

/** Waits for {@link canvasHasSize}, for a canvas that has only just mounted. */
async function waitForCanvasSize(page: Page, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canvasHasSize(page)) return true;
    await Bun.sleep(50);
  }
  return false;
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

/**
 * Stops the server and boots a fresh process against the same state file.
 *
 * `kill()` is `SIGTERM`, which the server handles by flushing the snapshot and
 * exiting, so a room created before the restart has to come back afterwards.
 */
async function restartServer(server: ServerProcess): Promise<{ server: ServerProcess; serverLog: string[] }> {
  await stopServer(server);
  const restarted = startServer();
  const serverLog = attachLog(restarted);
  await waitForHealth(restarted, serverLog);
  return { server: restarted, serverLog };
}

/** The part of a room the restart check compares. */
interface RoomFacts {
  readonly id: string;
  readonly mode: string;
  readonly mineCount: number;
  readonly playerId: string;
}

function describeRoom(room: RoomFacts): string {
  return `${room.id}/${room.mode}/${room.mineCount} mines/player ${room.playerId}`;
}

/** Creates a room through the API, exactly as the lobby does. */
async function createRoomOverHttp(): Promise<RoomFacts> {
  const response = await fetch(`${BASE_URL}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerName: "Ada", mode: "race", difficultyId: "hard", visibility: "public" }),
  });
  if (!response.ok) throw new SmokeFailure(`POST /api/rooms answered ${response.status}`);
  const body = (await response.json()) as {
    room: { id: string; mode: string; mineCount: number };
    player: { id: string };
  };
  return { id: body.room.id, mode: body.room.mode, mineCount: body.room.mineCount, playerId: body.player.id };
}

/** Reads a room by code; `undefined` when the server does not have it. */
async function readRoomOverHttp(roomId: string): Promise<RoomFacts | undefined> {
  const response = await fetch(`${BASE_URL}/api/rooms/${roomId}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new SmokeFailure(`GET /api/rooms/${roomId} answered ${response.status}`);
  const body = (await response.json()) as {
    room: { id: string; mode: string; mineCount: number; players: readonly { id: string }[] };
  };
  return {
    id: body.room.id,
    mode: body.room.mode,
    mineCount: body.room.mineCount,
    playerId: body.room.players[0]?.id ?? "",
  };
}

/** Reclaims a seat in a room, the way a reconnecting client does. */
async function rejoinOverHttp(roomId: string, playerId: string): Promise<number> {
  const response = await fetch(`${BASE_URL}/api/rooms/${roomId}/join`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ playerId, playerName: "Ada" }),
  });
  return response.status;
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
    readonly room?: { readonly id: string; readonly players: readonly { readonly id: string }[] } | null;
    readonly state: {
      readonly status: string;
      readonly revealedCount: number;
      readonly flagCount: number;
      readonly config: { readonly size: { readonly x: number; readonly y: number; readonly z: number } };
      readonly cells: readonly {
        readonly index: { readonly x: number; readonly y: number; readonly z: number };
        readonly isRevealed: boolean;
        readonly isFlagged: boolean;
      }[];
    } | null;
  };
  reveal(cell: { x: number; y: number; z: number }): void;
  /** Where the other seats of the room point, as the socket last reported it. */
  cursors(): readonly {
    readonly playerId: string;
    readonly cell: { readonly x: number; readonly y: number; readonly z: number } | null;
  }[];
  newGame(presetId?: string): void;
  createRoom(options?: {
    playerName?: string;
    presetId?: string;
    mode?: string;
    mineCount?: number;
    visibility?: string;
  }): Promise<unknown>;
  joinRoom(roomId: string, options?: { playerName?: string }): Promise<unknown>;
}

type WindowWithAutomation = Window & { __minesweeper3d?: PageAutomation };

process.exit(await main());
