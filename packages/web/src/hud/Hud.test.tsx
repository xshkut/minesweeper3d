import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GAME_PRESETS, createGame, presetConfig, revealCell, toClientView } from "@minesweeper3d/game-core";
import type { ClientGameState } from "@minesweeper3d/game-core";
import { Hud } from "./Hud";
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
    onToggleFlagMode: mock(() => undefined),
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
      flagMode={false}
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

  test("new game, flag mode and reset view call their handlers", () => {
    const handlers = renderHud();

    fireEvent.click(screen.getByTestId("new-game"));
    expect(handlers["onNewGame"]).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("flag-mode"));
    expect(handlers["onToggleFlagMode"]).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("reset-view"));
    expect(handlers["onResetView"]).toHaveBeenCalledTimes(1);
  });

  test("flag mode reflects its pressed state", () => {
    const { rerender } = render(
      <Hud
        snapshot={snapshotWith(board())}
        summary={summarize(board())}
        elapsedMs={0}
        presetId="tiny"
        flagMode={false}
        notice={null}
        onNewGame={() => undefined}
        onSelectPreset={() => undefined}
        onToggleFlagMode={() => undefined}
        onResetView={() => undefined}
        onPlayAgain={() => undefined}
      />,
    );
    expect(screen.getByTestId("flag-mode").getAttribute("aria-pressed")).toBe("false");

    rerender(
      <Hud
        snapshot={snapshotWith(board())}
        summary={summarize(board())}
        elapsedMs={0}
        presetId="tiny"
        flagMode
        notice={null}
        onNewGame={() => undefined}
        onSelectPreset={() => undefined}
        onToggleFlagMode={() => undefined}
        onResetView={() => undefined}
        onPlayAgain={() => undefined}
      />,
    );
    expect(screen.getByTestId("flag-mode").getAttribute("aria-pressed")).toBe("true");
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
});
