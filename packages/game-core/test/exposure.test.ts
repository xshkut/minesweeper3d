import { describe, expect, it } from "bun:test";
import { isCellExposed, revealCell, vec3 } from "../src/index";
import { at, game, gameWithMines, revealedKeys, snapshot } from "./helpers";

/**
 * The 3D twist of this minesweeper: a covered cell only opens up when one of
 * its six face neighbours is outside the board or already revealed. Players dig
 * in from the surface instead of clicking anywhere.
 */
describe("the 'dig in from the surface' rule", () => {
  it("exposes the boundary cells of a fresh board", () => {
    const state = game(vec3(5, 5, 5), 0, { seed: 1 });

    // Faces, edges and corners touch the void.
    expect(isCellExposed(state, at(0, 2, 2))).toBe(true);
    expect(isCellExposed(state, at(0, 0, 2))).toBe(true);
    expect(isCellExposed(state, at(0, 0, 0))).toBe(true);
    expect(isCellExposed(state, at(4, 4, 4))).toBe(true);
  });

  it("hides the inside of the cube until the surface is opened", () => {
    const state = game(vec3(5, 5, 5), 0, { seed: 1 });

    expect(isCellExposed(state, at(2, 2, 2))).toBe(false);
    expect(isCellExposed(state, at(1, 2, 2))).toBe(false);
    expect(isCellExposed(state, at(1, 1, 1))).toBe(false);
    // Second layer, but still touching a covered cell in every direction.
    expect(isCellExposed(state, at(1, 3, 3))).toBe(false);
  });

  it("reports nothing for cells outside the board", () => {
    const state = game(vec3(3, 3, 3), 0, { seed: 1 });
    expect(isCellExposed(state, at(3, 0, 0))).toBe(false);
    expect(isCellExposed(state, at(-1, 0, 0))).toBe(false);
  });

  it("ignores reveal attempts on covered interior cells", () => {
    const state = gameWithMines(vec3(5, 5, 5), [at(0, 0, 0)], { firstRevealSafe: false });
    const transition = revealCell(state, at(2, 2, 2));

    expect(transition.state).toBe(state);
    expect(transition.events).toEqual([]);
    expect(snapshot(transition.state)).toBe(snapshot(state));
  });

  it("unlocks the next layer once a face neighbour is open", () => {
    // Mines far away on the opposite side keep the flood fill local enough to
    // observe the effect.
    const state = gameWithMines(vec3(5, 5, 5), [at(4, 4, 4), at(4, 4, 3), at(4, 3, 4)]);
    expect(isCellExposed(state, at(1, 2, 2))).toBe(false);

    const opened = revealCell(state, at(0, 2, 2)).state;

    expect(opened.cells.some((cell) => cell.isRevealed)).toBe(true);
    // (1,2,2) now touches the revealed (0,2,2) and was opened by the fill.
    expect(isCellExposed(opened, at(1, 2, 2))).toBe(true);
    expect(revealedKeys(opened)).toContain("1,2,2");
  });

  it("protects the player from unexposed mines", () => {
    const state = gameWithMines(vec3(5, 5, 5), [at(2, 2, 2)], { firstRevealSafe: false });
    const transition = revealCell(state, at(2, 2, 2));

    expect(transition.state.status).toBe("ready");
    expect(transition.events).toEqual([]);
  });
});
