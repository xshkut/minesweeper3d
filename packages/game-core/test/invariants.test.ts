import { describe, expect, it } from "bun:test";
import {
  createConfig,
  createGame,
  createGrid,
  cycleMark,
  isFinished,
  isGameOver,
  mineCells,
  NEIGHBOURS,
  neighboursOf,
  presetConfig,
  probeCell,
  randomInt,
  revealCell,
  vec3,
} from "../src/index";
import type { CellIndex, GameState, Vec3 } from "../src/index";
import { at } from "./helpers";

/**
 * Cross-checks a state against the rules it must always satisfy, independently
 * of how the engine got there (brute-force recount, not a re-read of the code).
 */
function expectConsistent(state: GameState): void {
  const grid = createGrid(state.config.size);

  // The board has the right shape and every cell knows its own coordinates.
  expect(state.cells).toHaveLength(grid.cellCount);
  for (let offset = 0; offset < state.cells.length; offset += 1) {
    expect(state.cells[offset]?.index).toEqual(grid.cellOf(offset));
  }

  // Counters agree with the cells they summarise.
  const mines = state.cells.filter((cell) => cell.hasMine);
  expect(mines).toHaveLength(state.config.mineCount);
  expect(state.cells.filter((cell) => cell.isRevealed && !cell.hasMine)).toHaveLength(state.revealedCount);
  expect(state.cells.filter((cell) => cell.isFlagged)).toHaveLength(state.flagCount);

  // A cell is either claimed or doubted, never both, because one cycling action
  // is the only writer of the two booleans.
  expect(state.cells.filter((cell) => cell.isFlagged && cell.isQuestioned)).toHaveLength(0);

  // Charges are spent one per probed cell and never come back, so the budget
  // and the probe marks have to agree exactly, at every point in a game.
  const probed = state.cells.filter((cell) => cell.isProbed).length;
  expect(probed).toBeLessThanOrEqual(state.config.freeReveals);
  expect(state.freeRevealsLeft).toBe(state.config.freeReveals - probed);

  // Every adjacency count matches a brute-force recount of its 26 neighbours.
  const mineOffsets = new Set(mines.map((cell) => grid.offsetOf(cell.index)));
  for (const cell of state.cells) {
    let expected = 0;
    for (const neighbour of neighboursOf(grid, cell.index, NEIGHBOURS)) {
      if (mineOffsets.has(grid.offsetOf(neighbour))) expected += 1;
    }
    expect(cell.adjacentMines).toBe(expected);
  }

  if (state.status === "ready") {
    expect(state.revealedCount).toBe(0);
    expect(state.explodedAt).toBeNull();
  }

  if (state.status === "playing" || state.status === "ready") {
    // Hidden information stays hidden while the game runs.
    expect(state.cells.some((cell) => cell.hasMine && cell.isRevealed)).toBe(false);
  }

  if (state.status === "won") {
    expect(state.revealedCount).toBe(grid.cellCount - state.config.mineCount);
    expect(state.explodedAt).toBeNull();
  }

  if (state.status === "lost") {
    expect(state.explodedAt).not.toBeNull();
    // Losing uncovers the whole layout.
    expect(state.cells.filter((cell) => cell.hasMine && cell.isRevealed)).toHaveLength(state.config.mineCount);
  }
}

/** Plays `steps` pseudo-random actions, checking the invariants after each. */
function playRandomly(state: GameState, steps: number, seed: number): GameState {
  let current = state;
  let rng = seed;
  const { x, y, z } = current.config.size;
  // Free reveals are only part of the action space of a board that grants them.
  const actions = current.config.freeReveals > 0 ? 3 : 2;

  for (let step = 0; step < steps; step += 1) {
    const action = randomInt(rng, 0, actions - 1);
    const pickX = randomInt(action.state, 0, x - 1);
    const pickY = randomInt(pickX.state, 0, y - 1);
    const pickZ = randomInt(pickY.state, 0, z - 1);
    rng = pickZ.state;

    const cell: CellIndex = vec3(pickX.value, pickY.value, pickZ.value);
    current =
      action.value === 0
        ? cycleMark(current, cell).state
        : action.value === 1
          ? revealCell(current, cell).state
          : probeCell(current, cell).state;
    expectConsistent(current);
  }

  return current;
}

function sized(
  size: Vec3,
  mineCount: number,
  seed: number,
  firstRevealSafe = false,
  freeReveals = 0,
): GameState {
  return createGame(createConfig({ size, mineCount, seed, firstRevealSafe, freeReveals }));
}

describe("state invariants", () => {
  it("hold for fresh boards of every preset", () => {
    for (const preset of ["tiny", "classic", "medium", "large", "expert"]) {
      expectConsistent(createGame(presetConfig(preset, { seed: 3, firstRevealSafe: false })));
    }
  });

  it("hold through long random games", () => {
    const sizes: readonly Vec3[] = [vec3(3, 3, 3), vec3(5, 5, 5), vec3(6, 6, 6), vec3(8, 8, 8)];

    for (let seed = 1; seed <= 12; seed += 1) {
      const size = sizes[seed % sizes.length] as Vec3;
      const cellCount = size.x * size.y * size.z;
      const state = sized(size, Math.max(1, Math.round(cellCount * 0.09)), seed);
      expectConsistent(playRandomly(state, 60, seed * 31));
    }
  });

  it("hold through long random games with free reveals in play", () => {
    const sizes: readonly Vec3[] = [vec3(3, 3, 3), vec3(5, 5, 5), vec3(6, 6, 6)];

    for (let seed = 1; seed <= 12; seed += 1) {
      const size = sizes[seed % sizes.length] as Vec3;
      const cellCount = size.x * size.y * size.z;
      const state = sized(size, Math.max(1, Math.round(cellCount * 0.09)), seed, false, 4);
      expectConsistent(playRandomly(state, 60, seed * 31));
    }
  });

  it("are frozen once the game is over", () => {
    const finished = playRandomly(sized(vec3(4, 4, 4), 5, 7), 80, 99);
    if (!isFinished(finished)) return;

    const cells = finished.cells.map((cell) => cell.index);
    const target = cells[cells.length - 1] as CellIndex;
    expect(revealCell(finished, target).state).toBe(finished);
    expect(cycleMark(finished, target).state).toBe(finished);
    expect(probeCell(finished, target).state).toBe(finished);
    expect(isGameOver(finished.status)).toBe(true);
  });

  it("keep the mine count stable when the opening click is relocated", () => {
    for (let seed = 1; seed <= 40; seed += 1) {
      const state = sized(vec3(4, 4, 4), 12, seed, true);
      const firstMine = state.cells.find((cell) => cell.hasMine);
      if (firstMine === undefined) continue;

      const opened = revealCell(state, firstMine.index).state;
      expect(opened.status).not.toBe("lost");
      expect(opened.cells.filter((cell) => cell.hasMine)).toHaveLength(12);
      expect(opened.revealedCount).toBeGreaterThan(0);
      expectConsistent(opened);
    }
  });

  it("stay fast on an expert sized board", () => {
    const started = performance.now();
    const state = playRandomly(sized(vec3(10, 10, 10), 80, 4242), 200, 7);
    const elapsed = performance.now() - started;

    expect(state.cells).toHaveLength(1000);
    expect(elapsed).toBeLessThan(5000);
    expect(mineCells(state)).toHaveLength(80);
    expect(at(0, 0, 0)).toEqual(vec3(0, 0, 0));
  });
});
