import { describe, expect, it } from "bun:test";
import { probeCell, revealCell, toClientView, vec3 } from "../src/index";
import type { Cell } from "../src/index";
import { at, cell, eventTypes, game, gameWithMines } from "./helpers";

const MINE = at(2, 2, 2);
const SAFE = at(0, 0, 0);

describe("free reveals", () => {
  it("spends a charge and reports that the cell hides a mine", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 2 });

    const probed = probeCell(state, MINE);

    expect(probed.state.freeRevealsLeft).toBe(1);
    expect(probed.state.config.freeReveals).toBe(2);
    expect(eventTypes(probed.events)).toEqual(["cellProbed"]);
    expect(probed.events[0]).toEqual({ type: "cellProbed", cell: MINE, hasMine: true });

    const target = cell(probed.state, 2, 2, 2);
    expect(target.isProbed).toBe(true);
    // The cube stays shut: a free reveal is information, not a shortcut.
    expect(target.isRevealed).toBe(false);
  });

  it("reports a safe cell as safe without opening it", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 1 });

    const probed = probeCell(state, SAFE);

    expect(probed.events[0]).toEqual({ type: "cellProbed", cell: SAFE, hasMine: false });
    expect(probed.state.revealedCount).toBe(0);
    expect(cell(probed.state, 0, 0, 0).isRevealed).toBe(false);
  });

  it("does not start the round", () => {
    // Only opening a cube gets a round under way, so the co-op clock keeps its
    // single, simple rule: it starts on the first accepted reveal.
    const probed = probeCell(gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 1 }), SAFE);
    expect(probed.state.status).toBe("ready");
  });

  it("can answer for a buried cell, not just an exposed one", () => {
    // The detector answers a question about the board rather than about the
    // digging frontier, so a cell nothing has reached yet is fair game.
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 1 });
    expect(state.status).toBe("ready");

    const probed = probeCell(state, MINE);
    expect(probed.state).not.toBe(state);
    expect(probed.events[0]).toEqual({ type: "cellProbed", cell: MINE, hasMine: true });
  });

  it("is off by default", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE]);
    expect(state.config.freeReveals).toBe(0);
    expect(state.freeRevealsLeft).toBe(0);

    expect(probeCell(state, MINE).state).toBe(state);
    expect(probeCell(state, SAFE).state).toBe(state);
  });

  it("refuses to spend a charge on a second look at the same cell", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 2 });
    const once = probeCell(state, MINE).state;

    const twice = probeCell(once, MINE);

    expect(twice.state).toBe(once);
    expect(twice.events).toEqual([]);
    expect(once.freeRevealsLeft).toBe(1);
  });

  it("refuses to spend a charge on a cell that is already open", () => {
    const opened = revealCell(gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 1 }), SAFE).state;

    expect(probeCell(opened, SAFE).state).toBe(opened);
    expect(opened.freeRevealsLeft).toBe(1);
  });

  it("runs out after the granted number of looks", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 1 });
    const first = probeCell(state, SAFE).state;
    expect(first.freeRevealsLeft).toBe(0);

    const second = probeCell(first, MINE);

    expect(second.state).toBe(first);
    expect(second.events).toEqual([]);
    expect(cell(first, 2, 2, 2).isProbed).toBe(false);
  });

  it("is ignored outside the board and once the game is over", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 3 });
    expect(probeCell(state, at(9, 9, 9)).state).toBe(state);

    const lost = revealCell(
      gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 3, firstRevealSafe: false }),
      MINE,
    ).state;
    expect(lost.status).toBe("lost");
    expect(probeCell(lost, SAFE).state).toBe(lost);
  });

  it("never mutates the state it is given", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 2 });
    const before = JSON.stringify(state);

    probeCell(state, MINE);

    expect(JSON.stringify(state)).toBe(before);
  });

  it("discloses the one bit it paid for and nothing else", () => {
    // Mines in a corner, so plenty of untouched cells carry a real count.
    const state = gameWithMines(vec3(3, 3, 3), [at(0, 0, 0), at(0, 0, 1), at(0, 1, 0)], { freeReveals: 1 });
    const probed = probeCell(state, at(2, 2, 2)).state;
    const view = toClientView(probed);

    const disclosed: readonly Cell[] = view.cells.filter((entry) => entry.isRevealed || entry.isProbed);
    // Exactly the probed cell reports anything; it reports no count, because a
    // free reveal answers "mine here?" and never "how crowded is this spot?".
    expect(disclosed).toHaveLength(1);
    expect(disclosed[0]?.isProbed).toBe(true);
    expect(disclosed[0]?.adjacentMines).toBe(0);
    expect(disclosed[0]?.hasMine).toBe(false);

    const others = view.cells.filter((entry) => !entry.isProbed);
    expect(others.every((entry) => entry.adjacentMines === 0)).toBe(true);
    expect(others.every((entry) => entry.hasMine === false)).toBe(true);

    // The full state still knows the truth about every cell.
    expect(state.cells.filter((entry) => entry.hasMine)).toHaveLength(3);
  });

  it("keeps counting the free reveals left in the client view", () => {
    const state = gameWithMines(vec3(3, 3, 3), [MINE], { freeReveals: 2 });
    const probed = probeCell(state, MINE).state;

    expect(toClientView(state).freeRevealsLeft).toBe(2);
    expect(toClientView(probed).freeRevealsLeft).toBe(1);
  });

  it("works on a board with no mines at all", () => {
    const state = game(vec3(3, 3, 3), 0, { seed: 1, freeReveals: 1 });
    const probed = probeCell(state, at(1, 1, 1));

    expect(probed.events[0]).toEqual({ type: "cellProbed", cell: at(1, 1, 1), hasMine: false });
    expect(probed.state.freeRevealsLeft).toBe(0);
  });
});
