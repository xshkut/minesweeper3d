/**
 * Where the rest of the room is pointing.
 *
 * This is the one part of the session that is deliberately *not* React state: a
 * pointer moves with every beetle of the mouse, and a feed that re-rendered the
 * HUD at that rate would spend the whole frame budget on a decoration. The feed
 * is a mutable box with a revision counter that the render loop polls, which is
 * why these tests are all about what changes - and what is left untouched.
 */
import { describe, expect, test } from "bun:test";
import {
  PLAYER_COLORS,
  applyCursor,
  createCursorFeed,
  forgetCursors,
  playerColor,
  remoteSeats,
  sameCell,
} from "./presence";
import type { SessionSnapshot } from "./types";
import { testPlayer, testRoom, testState } from "../test/fixtures";

/** A snapshot with the given players seated in a room, viewed by `playerId`. */
function snapshotWith(ids: readonly string[], playerId: string): SessionSnapshot {
  return {
    kind: "remote",
    phase: "ready",
    state: testState(),
    room: testRoom({
      players: ids.map((id) => testPlayer({ id, name: `Player ${id}` })),
    }),
    playerId,
    connected: true,
  };
}

describe("cursor feed", () => {
  test("a new pointer is stored and bumps the revision", () => {
    const feed = createCursorFeed();

    expect(applyCursor(feed, "p2", { x: 1, y: 2, z: 3 })).toBe(true);

    expect(feed.cursors.get("p2")).toEqual({ playerId: "p2", cell: { x: 1, y: 2, z: 3 } });
    expect(feed.revision).toBe(1);
  });

  test("a pointer that did not move changes nothing", () => {
    const feed = createCursorFeed();
    applyCursor(feed, "p2", { x: 1, y: 2, z: 3 });

    // A room of idle players must not keep the renderer awake: an unchanged
    // cell is not a change.
    expect(applyCursor(feed, "p2", { x: 1, y: 2, z: 3 })).toBe(false);
    expect(feed.revision).toBe(1);
  });

  test("a moved pointer replaces the old cell", () => {
    const feed = createCursorFeed();
    applyCursor(feed, "p2", { x: 1, y: 2, z: 3 });

    expect(applyCursor(feed, "p2", { x: 4, y: 2, z: 3 })).toBe(true);
    expect(feed.cursors.get("p2")?.cell).toEqual({ x: 4, y: 2, z: 3 });
  });

  test("a player who stops pointing keeps a place in the feed, with no cell", () => {
    const feed = createCursorFeed();
    applyCursor(feed, "p2", { x: 1, y: 2, z: 3 });

    expect(applyCursor(feed, "p2", null)).toBe(true);
    expect(feed.cursors.get("p2")).toEqual({ playerId: "p2", cell: null });
  });

  test("a repeated 'stopped pointing' is not reported twice", () => {
    const feed = createCursorFeed();
    applyCursor(feed, "p2", { x: 1, y: 0, z: 0 });
    applyCursor(feed, "p2", null);

    expect(applyCursor(feed, "p2", null)).toBe(false);
    expect(feed.revision).toBe(2);
  });

  test("clearing a pointer that was never seen is not a change", () => {
    const feed = createCursorFeed();

    expect(applyCursor(feed, "p2", null)).toBe(false);
    expect(feed.cursors.size).toBe(0);
    expect(feed.revision).toBe(0);
  });
});

describe("forgetCursors", () => {
  test("drops the seats that left and keeps the rest", () => {
    const feed = createCursorFeed();
    applyCursor(feed, "p2", { x: 1, y: 0, z: 0 });
    applyCursor(feed, "p3", { x: 2, y: 0, z: 0 });

    expect(forgetCursors(feed, (id) => id === "p3")).toBe(true);

    expect([...feed.cursors.keys()]).toEqual(["p3"]);
    expect(feed.revision).toBe(3);
  });

  test("a seating that everyone survived is not a change", () => {
    const feed = createCursorFeed();
    applyCursor(feed, "p2", { x: 1, y: 0, z: 0 });

    expect(forgetCursors(feed, () => true)).toBe(false);
    expect(feed.revision).toBe(1);
  });
});

describe("remoteSeats", () => {
  test("lists the other seats, never this player", () => {
    expect(remoteSeats(snapshotWith(["p1", "p2", "p3"], "p1")).map((seat) => seat.id)).toEqual(["p2", "p3"]);
  });

  test("carries the name the roster shows", () => {
    expect(remoteSeats(snapshotWith(["p1", "p2"], "p1"))[0]).toEqual({ id: "p2", name: "Player p2" });
  });

  test("a private game has nobody to draw", () => {
    const alone: SessionSnapshot = { ...snapshotWith(["p1"], "p1"), room: null };
    expect(remoteSeats(alone)).toEqual([]);
  });
});

describe("playerColor", () => {
  test("is stable for one player and inside the palette", () => {
    const palette: readonly string[] = PLAYER_COLORS;
    const color = playerColor("player-42");

    expect(color).toBe(playerColor("player-42"));
    expect(palette).toContain(color);
  });

  test("spreads a handful of ids over more than one colour", () => {
    const ids = ["ada", "grace", "alan", "edsger", "barbara", "donald", "leslie", "john"];
    expect(new Set(ids.map(playerColor)).size).toBeGreaterThan(1);
  });
});

describe("sameCell", () => {
  test("compares cells by value", () => {
    expect(sameCell({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 3 })).toBe(true);
    expect(sameCell({ x: 1, y: 2, z: 3 }, { x: 1, y: 2, z: 4 })).toBe(false);
  });

  test("nothing only matches nothing", () => {
    expect(sameCell(null, null)).toBe(true);
    expect(sameCell({ x: 1, y: 2, z: 3 }, null)).toBe(false);
    expect(sameCell(null, { x: 1, y: 2, z: 3 })).toBe(false);
  });
});
