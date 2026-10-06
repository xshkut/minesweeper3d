import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GAME_PRESETS, createGame, presetConfig, revealCell, toClientView } from "@minesweeper3d/game-core";
import type { ClientGameState } from "@minesweeper3d/game-core";
import { Hud, prefersCompactStart } from "./Hud";
import type { HudProps } from "./Hud";
import { summarize } from "../session/summary";
import type { SessionSnapshot } from "../session/types";

// Bun keeps one module registry for the whole run, so React Testing Library's
// automatic cleanup can end up bound to another test file's hooks; registering
// it here guarantees the DOM is empty before every test in this file.
afterEach(cleanup);

function snapshotWith(state: ClientGameState | null): SessionSnapshot {
  return { kind: "local", phase: state === null ? "loading" : "ready", state };
}

/** A tiny board, optionally after one reveal. */
function board(options: { play?: boolean; mines?: number } = {}): ClientGameState {
  const state = createGame(presetConfig("tiny", { seed: 4, firstRevealSafe: false }));
  if (options.play === true) return toClientView(revealCell(state, { x: 0, y: 0, z: 0 }).state);
  return toClientView(state);
}

function renderHud(overrides: Partial<HudProps> = {}): Record<string, ReturnType<typeof mock>> {
  const handlers = {
    onNewGame: mock(() => undefined),
    onSelectPreset: mock(() => undefined),
    onSelectTool: mock(() => undefined),
    onResetView: mock(() => undefined),
    onPlayAgain: mock(() => undefined),
    onRetry: mock(() => undefined),
  };
  const state = overrides.snapshot?.state ?? board();

  render(
    <Hud
      snapshot={snapshotWith(state)}
      summary={summarize(state)}
      elapsedMs={0}
      presetId="tiny"
      tool="reveal"
      freeRevealsLeft={0}
      notice={null}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

describe("Hud", () => {
  test("renders status, counters, progress and the clock", () => {
    renderHud({ elapsedMs: 65_000 });

    expect(screen.getByTestId("hud-status").textContent).toBe("Ready");
    expect(screen.getByTestId("hud-mines-left").textContent).toBe("3");
    expect(screen.getByTestId("hud-flags").textContent).toBe("0");
    expect(screen.getByTestId("hud-progress").textContent).toBe("0 / 24");
    expect(screen.getByTestId("hud-timer").textContent).toBe("01:05");
  });

  test("shows playing state and progress after a reveal", () => {
    const state = board({ play: true });
    renderHud({ snapshot: snapshotWith(state), summary: summarize(state) });

    expect(screen.getByTestId("hud-status").textContent).toBe("Playing");
    expect(screen.getByTestId("hud-progress").textContent).not.toBe("0 / 24");
    expect(screen.getByTestId("hud-mines-left").textContent).toBe("3");
  });

  test("lists every preset and reports the selection", () => {
    const handlers = renderHud();
    const select = screen.getByTestId("preset-select");

    const options = Array.from(select.querySelectorAll("option"));
    expect(options).toHaveLength(GAME_PRESETS.length);
    expect(options.map((option) => option.value)).toEqual(GAME_PRESETS.map((preset) => preset.id));
    expect((select as HTMLSelectElement).value).toBe("tiny");

    fireEvent.change(select, { target: { value: "medium" } });
    expect(handlers["onSelectPreset"]).toHaveBeenCalledWith("medium");
  });

  test("new game, the tool buttons and reset view call their handlers", () => {
    const handlers = renderHud();

    fireEvent.click(screen.getByTestId("new-game"));
    expect(handlers["onNewGame"]).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("tool-flag"));
    expect(handlers["onSelectTool"]).toHaveBeenCalledWith("flag");

    fireEvent.click(screen.getByTestId("reset-view"));
    expect(handlers["onResetView"]).toHaveBeenCalledTimes(1);
  });

  test("the tool switch reflects the pressed tool", () => {
    const state = board();
    const { rerender } = render(
      <Hud
        snapshot={snapshotWith(state)}
        summary={summarize(state)}
        elapsedMs={0}
        presetId="tiny"
        tool="flag"
        freeRevealsLeft={0}
        notice={null}
        onNewGame={() => undefined}
        onSelectPreset={() => undefined}
        onSelectTool={() => undefined}
        onResetView={() => undefined}
        onPlayAgain={() => undefined}
      />,
    );
    expect(screen.getByTestId("tool-flag").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tool-reveal").getAttribute("aria-pressed")).toBe("false");

    rerender(
      <Hud
        snapshot={snapshotWith(state)}
        summary={summarize(state)}
        elapsedMs={0}
        presetId="tiny"
        tool="reveal"
        freeRevealsLeft={0}
        notice={null}
        onNewGame={() => undefined}
        onSelectPreset={() => undefined}
        onSelectTool={() => undefined}
        onResetView={() => undefined}
        onPlayAgain={() => undefined}
      />,
    );
    expect(screen.getByTestId("tool-reveal").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tool-flag").getAttribute("aria-pressed")).toBe("false");
  });

  test("disables the detector when the board has no free reveals left", () => {
    renderHud({ tool: "reveal", freeRevealsLeft: 0 });
    expect((screen.getByTestId("tool-probe") as HTMLButtonElement).disabled).toBe(true);
  });

  test("keeps the detector available while charges remain", () => {
    renderHud({ tool: "probe", freeRevealsLeft: 2 });
    expect((screen.getByTestId("tool-probe") as HTMLButtonElement).disabled).toBe(false);
  });

  test("counts question marks and shows the free-reveal budget when the aid is on", () => {
    const state = toClientView(createGame(presetConfig("tiny", { seed: 4, freeReveals: 2 })));
    renderHud({ snapshot: snapshotWith(state), summary: summarize(state) });

    expect(screen.getByTestId("hud-questions").textContent).toBe("0");
    expect(screen.getByTestId("hud-free-reveals").textContent).toBe("2 / 2");
  });

  test("hides the free-reveal row when the aid is off", () => {
    renderHud();
    expect(screen.queryByTestId("hud-free-reveals")).toBeNull();
    expect(screen.getByTestId("hud-questions").textContent).toBe("0");
  });

  test("shows the result banner with a replay action once the game is over", () => {
    const played = board({ play: true });
    const lost = { ...played, status: "lost" as const };
    const handlers = renderHud({ snapshot: snapshotWith(lost), summary: summarize(lost), elapsedMs: 12_000 });

    expect(screen.getByTestId("result-banner").textContent).toContain("Boom");
    expect(screen.getByTestId("result-banner").textContent).toContain("00:12");

    fireEvent.click(screen.getByTestId("play-again"));
    expect(handlers["onPlayAgain"]).toHaveBeenCalledTimes(1);
  });

  test("keeps the banner hidden while the game is running", () => {
    renderHud({ snapshot: snapshotWith(board()), summary: summarize(board()) });
    expect(screen.queryByTestId("result-banner")).toBeNull();
  });

  test("renders a transient notice and the loading placeholders", () => {
    renderHud({ snapshot: { kind: "local", phase: "loading", state: null }, summary: null, notice: "Not exposed yet" });
    expect(screen.getByTestId("hud-status").textContent).toBe("loading");
    expect(screen.getByTestId("hud-mines-left").textContent).toBe("—");
    expect(screen.getByTestId("hud-timer").textContent).toBe("00:00");
    expect(screen.getByTestId("hud-notice").textContent).toBe("Not exposed yet");
  });

  test("reports a remote failure and offers a retry", () => {
    const handlers = renderHud({
      snapshot: { kind: "remote", phase: "error", state: null, error: "Cannot reach the game server", connected: false },
      summary: null,
    });

    expect(screen.getByTestId("connection-error").textContent).toBe("Cannot reach the game server");
    fireEvent.click(screen.getByTestId("connection-retry"));
    expect(handlers["onRetry"]).toHaveBeenCalledTimes(1);
  });

  test("slides the panel away and back with the dock toggle", () => {
    renderHud();
    const dock = screen.getByTestId("hud-toggle").parentElement;
    const toggle = screen.getByTestId("hud-toggle");

    // The dock is the panel's parent: the toggle has to be a sibling, or the
    // panel's own `overflow: auto` would clip it while it slides.
    expect(dock?.className).toBe("hud-dock");
    expect(dock?.querySelector("#hud-panel")).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dock?.hasAttribute("data-open")).toBe(true);

    fireEvent.click(toggle);
    expect(screen.getByTestId("hud-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(dock?.hasAttribute("data-open")).toBe(false);
    // Collapsing only moves the panel; it must stay mounted with its controls.
    expect(screen.getByTestId("new-game")).toBeDefined();

    fireEvent.click(screen.getByTestId("hud-toggle"));
    expect(dock?.hasAttribute("data-open")).toBe(true);
  });
});

/**
 * Where the panel starts.
 *
 * On a phone the panel is nearly the whole screen, so it opens folded away and
 * the cube gets the screen; with a mouse it costs a strip of the left edge and
 * stays open. The decision reads a media query, which the test environment
 * answers "no" to by default - hence the explicit stubs below.
 */
describe("panel start state", () => {
  /** Runs `body` with `window.matchMedia` answering `(pointer: coarse)` as asked. */
  function withCoarsePointer(matches: boolean, body: () => void): void {
    const host = globalThis.window as unknown as { matchMedia?: unknown };
    const original = host.matchMedia;
    host.matchMedia = ((query: string) => ({ matches, media: query })) as unknown as typeof host.matchMedia;
    try {
      body();
    } finally {
      host.matchMedia = original;
    }
  }

  test("a touch-first screen starts with the panel folded away", () => {
    withCoarsePointer(true, () => {
      expect(prefersCompactStart()).toBe(true);
      renderHud();

      const toggle = screen.getByTestId("hud-toggle");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");
      expect(toggle.parentElement?.hasAttribute("data-open")).toBe(false);
      // Folded away, not unmounted: the toggle is still there to open it.
      expect(screen.getByTestId("new-game")).toBeDefined();
    });
  });

  test("a mouse keeps the panel open", () => {
    withCoarsePointer(false, () => {
      expect(prefersCompactStart()).toBe(false);
      renderHud();

      expect(screen.getByTestId("hud-toggle").getAttribute("aria-expanded")).toBe("true");
    });
  });

  test("an environment without media queries keeps the panel open", () => {
    withCoarsePointer(true, () => {
      (globalThis.window as unknown as { matchMedia?: unknown }).matchMedia = undefined;

      expect(prefersCompactStart()).toBe(false);
    });
  });

  test("a folded panel keeps the clock and the mine counter in view", () => {
    withCoarsePointer(true, () => {
      renderHud({ elapsedMs: 65_000 });

      expect(screen.getByTestId("hud-compact-mines").textContent).toBe(
        screen.getByTestId("hud-mines-left").textContent,
      );
      expect(screen.getByTestId("hud-compact-timer").textContent).toBe("01:05");

      // The panel's own status bar is still the one the room and the automation
      // hook read; the strip carries its own ids so the two cannot be confused.
      expect(screen.getByTestId("hud-mines-left")).toBeDefined();
    });
  });

  test("opening the panel takes the strip away", () => {
    withCoarsePointer(true, () => {
      renderHud();

      fireEvent.click(screen.getByTestId("hud-toggle"));

      expect(screen.getByTestId("hud-toggle").getAttribute("aria-expanded")).toBe("true");
      expect(screen.queryByTestId("hud-compact")).toBeNull();
    });
  });

  test("a mouse screen never shows the strip", () => {
    withCoarsePointer(false, () => {
      renderHud();

      expect(screen.queryByTestId("hud-compact")).toBeNull();
    });
  });
});
