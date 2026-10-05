import { describe, expect, test } from "bun:test";
import { createGame, mineCells, presetConfig } from "@minesweeper3d/game-core";
import { createLocalSession } from "./local";

describe("local session", () => {
  test("starts ready with a playable board", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 3 });
    const snapshot = session.getSnapshot();

    expect(snapshot.kind).toBe("local");
    expect(snapshot.phase).toBe("ready");
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.state?.status).toBe("ready");
    expect(snapshot.state?.cells).toHaveLength(27);
    expect(snapshot.state?.config.mineCount).toBe(3);

    session.dispose();
  });

  test("revealing a surface cell replaces the snapshot and emits events", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 3 });
    const before = session.getSnapshot();

    session.reveal({ x: 0, y: 0, z: 0 });

    const after = session.getSnapshot();
    expect(after).not.toBe(before);
    expect(after.state?.status).toBe("playing");
    expect(after.state?.revealedCount).toBeGreaterThan(0);
    expect(session.lastEvents?.some((event) => event.type === "cellsRevealed")).toBe(true);

    session.dispose();
  });

  test("ignored reveals neither notify nor change the snapshot", () => {
    const session = createLocalSession({ presetId: "classic", seed: 11 });
    const before = session.getSnapshot();
    let notifications = 0;
    session.subscribe(() => {
      notifications += 1;
    });

    // Interior cell of a 5x5x5 board: covered by the "dig in from outside" rule.
    session.reveal({ x: 2, y: 2, z: 2 });
    session.reveal({ x: -1, y: 0, z: 0 });
    session.reveal({ x: 9, y: 9, z: 9 });

    expect(notifications).toBe(0);
    expect(session.getSnapshot()).toBe(before);
    expect(session.getSnapshot().state?.revealedCount).toBe(0);

    session.dispose();
  });

  test("flags toggle and are reflected in the counters", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 3 });
    session.toggleFlag({ x: 0, y: 0, z: 0 });

    const flagged = session.getSnapshot().state?.cells.find((cell) => cell.index.x === 0 && cell.index.y === 0 && cell.index.z === 0);
    expect(flagged?.isFlagged).toBe(true);
    expect(session.getSnapshot().state?.flagCount).toBe(1);

    session.toggleFlag({ x: 0, y: 0, z: 0 });
    expect(session.getSnapshot().state?.flagCount).toBe(0);

    session.dispose();
  });

  test("newGame resets progress and can switch preset", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 3 });
    session.reveal({ x: 0, y: 0, z: 0 });
    expect(session.getSnapshot().state?.revealedCount).toBeGreaterThan(0);

    session.newGame();
    expect(session.getSnapshot().state?.status).toBe("ready");
    expect(session.getSnapshot().state?.revealedCount).toBe(0);
    expect(session.getSnapshot().state?.config.mineCount).toBe(3);

    session.newGame({ presetId: "medium" });
    expect(session.getSnapshot().state?.cells).toHaveLength(216);
    expect(session.getSnapshot().state?.config.mineCount).toBe(20);

    session.dispose();
  });

  test("an unknown preset reports an error and keeps a playable board", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 3 });
    session.newGame({ presetId: "nope" });

    const snapshot = session.getSnapshot();
    expect(snapshot.state).not.toBeNull();
    // Falls back to the default preset instead of leaving a dead board.
    expect(snapshot.state?.cells).toHaveLength(125);
    expect(snapshot.error).toContain("nope");

    // The last valid preset is kept for the next game.
    session.newGame();
    expect(session.getSnapshot().error).toBeUndefined();
    expect(session.getSnapshot().state?.cells).toHaveLength(27);

    session.dispose();
  });

  test("unsubscribing stops notifications, dispose stops everything", () => {
    const session = createLocalSession({ presetId: "tiny", seed: 3 });
    let notifications = 0;
    const unsubscribe = session.subscribe(() => {
      notifications += 1;
    });

    session.reveal({ x: 0, y: 0, z: 0 });
    expect(notifications).toBe(1);

    unsubscribe();
    session.toggleFlag({ x: 2, y: 2, z: 2 });
    expect(notifications).toBe(1);

    session.dispose();
    const frozen = session.getSnapshot();
    session.newGame();
    expect(session.getSnapshot()).toBe(frozen);
  });

  test("revealing a mine ends the game and uncovers every mine", () => {
    const seed = seedWithMineAtOrigin();
    const session = createLocalSession({ presetId: "tiny", seed, firstRevealSafe: false });
    session.reveal({ x: 0, y: 0, z: 0 });

    const state = session.getSnapshot().state;
    expect(state?.status).toBe("lost");
    expect(state?.explodedAt).toEqual({ x: 0, y: 0, z: 0 });
    expect(state?.cells.filter((cell) => cell.hasMine)).toHaveLength(3);
    expect(session.lastEvents?.some((event) => event.type === "gameLost")).toBe(true);

    session.dispose();
  });
});

/** Finds a seed whose "tiny" board hides a mine in the origin cell. */
function seedWithMineAtOrigin(): number {
  for (let seed = 1; seed <= 200; seed += 1) {
    const state = createGame(presetConfig("tiny", { seed }));
    const mines = mineCells(state);
    if (mines.some((mine) => mine.x === 0 && mine.y === 0 && mine.z === 0)) return seed;
  }
  throw new Error("no seed with a mine at the origin found");
}
