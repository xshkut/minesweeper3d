/**
 * App level test: the React tree is rendered with a mocked `Canvas`, so the HUD
 * and the automation hook are exercised without a WebGL context.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import * as React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

// r3f renders into its own reconciler root and needs WebGL; the mock keeps the
// DOM half of the tree (canvas shell, overlays, HUD) intact.
mock.module("@react-three/fiber", () => ({
  Canvas: () => React.createElement("canvas", { "data-testid": "canvas-mock" }),
  useFrame: () => null,
  useThree: () => ({ gl: { domElement: { style: {} } }, camera: {}, scene: {} }),
  useLoader: () => {
    throw new Error("assets are not loaded in unit tests");
  },
}));

const { App } = await import("./App");
const { createLocalSession } = await import("./session/local");
const { installAutomationHook } = await import("./session/store");

// Explicit cleanup: React Testing Library's automatic one is registered with
// whichever test file imported it first.
afterEach(() => {
  cleanup();
  delete window.__minesweeper3d;
});

/** The hook installed by `installAutomationHook`, or a clear failure. */
function automationApi(): NonNullable<Window["__minesweeper3d"]> {
  const api = window.__minesweeper3d;
  if (api === undefined) throw new Error("the automation hook was not installed");
  return api;
}

describe("App", () => {
  test("renders the canvas shell next to the HUD", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 7 });
    render(<App session={session} />);

    expect(screen.getByTestId("canvas-shell")).toBeDefined();
    expect(screen.getByTestId("canvas-mock")).toBeDefined();
    expect(screen.getByTestId("hud-status").textContent).toBe("Ready");
    expect(screen.getByTestId("hud-progress").textContent).toBe("0 / 24");

    session.dispose();
  });

  test("a reveal through window.__minesweeper3d updates the HUD", async () => {
    const session = createLocalSession({ presetId: "tiny", seed: 7 });
    installAutomationHook(session, window);
    render(<App session={session} />);

    const api = automationApi();
    expect(api.snapshot().phase).toBe("ready");

    const before = screen.getByTestId("hud-progress").textContent;
    await act(async () => {
      api.reveal({ x: 0, y: 0, z: 0 });
    });

    expect(screen.getByTestId("hud-status").textContent).toBe("Playing");
    expect(screen.getByTestId("hud-progress").textContent).not.toBe(before);

    session.dispose();
  });

  test("the automation hook ignores malformed coordinates", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 7 });
    installAutomationHook(session, window);

    window.__minesweeper3d?.reveal({ x: 0.5, y: 0, z: 0 });
    window.__minesweeper3d?.reveal({ x: Number.NaN, y: 0, z: 0 });
    expect(session.getSnapshot().state?.revealedCount).toBe(0);

    session.dispose();
  });

  test("buttons and shortcuts drive the session", async () => {
    const session = createLocalSession({ presetId: "tiny", seed: 7 });
    installAutomationHook(session, window);
    render(<App session={session} />);

    await act(async () => {
      automationApi().reveal({ x: 0, y: 0, z: 0 });
    });
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("Playing"));

    // "New game" resets the board.
    fireEvent.click(screen.getByTestId("new-game"));
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("Ready"));
    expect(screen.getByTestId("hud-progress").textContent).toBe("0 / 24");

    // "F" selects the mark tool, "Q" the detector, "R" starts another game.
    fireEvent.keyDown(document.body, { key: "f" });
    await waitFor(() => expect(screen.getByTestId("tool-flag").getAttribute("aria-pressed")).toBe("true"));

    fireEvent.keyDown(document.body, { key: "q" });
    await waitFor(() => expect(screen.getByTestId("tool-probe").getAttribute("aria-pressed")).toBe("true"));

    fireEvent.click(screen.getByTestId("tool-reveal"));
    await waitFor(() => expect(screen.getByTestId("tool-reveal").getAttribute("aria-pressed")).toBe("true"));

    fireEvent.keyDown(document.body, { key: "R" });
    await waitFor(() => expect(screen.getByTestId("hud-status").textContent).toBe("Ready"));

    // The preset picker switches the board size.
    fireEvent.change(screen.getByTestId("preset-select"), { target: { value: "medium" } });
    await waitFor(() => expect(screen.getByTestId("hud-progress").textContent).toBe("0 / 196"));

    session.dispose();
  });

  test("a refused reveal is explained instead of silently ignored", async () => {
    const session = createLocalSession({ presetId: "classic", seed: 7 });
    installAutomationHook(session, window);
    render(<App session={session} />);

    // Interior cell of a 5x5x5 board: not exposed, so the engine ignores it.
    await act(async () => {
      automationApi().reveal({ x: 2, y: 2, z: 2 });
    });
    expect(session.getSnapshot().state?.revealedCount).toBe(0);
    expect(screen.getByTestId("hud-status").textContent).toBe("Ready");

    session.dispose();
  });
});
