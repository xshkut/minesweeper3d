import type { CellIndex, Vec3 } from "./types";
import { addVec3 } from "./vec3";

/** Upper bound for a single board dimension; protects against hostile input. */
export const MAX_DIMENSION = 32;

/**
 * Addresses cells of a box shaped board.
 *
 * Cells are stored in a flat array in `x`-major order
 * (`offset = (x * size.y + y) * size.z + z`), which keeps the state JSON
 * friendly and the lookups allocation free.
 */
export interface Grid {
  readonly size: Vec3;
  /** Total number of cells on the board. */
  readonly cellCount: number;
  /** `true` when the cell lies inside the board. */
  contains(cell: CellIndex): boolean;
  /**
   * Flat array offset of a cell. Only meaningful for cells that pass
   * {@link Grid.contains}.
   */
  offsetOf(cell: CellIndex): number;
  /** Inverse of {@link Grid.offsetOf}. */
  cellOf(offset: number): CellIndex;
}

/** Creates the addressing helper for a board of the given size. */
export function createGrid(size: Vec3): Grid {
  const { x: width, y: height, z: depth } = size;
  const cellCount = width * height * depth;

  return {
    size,
    cellCount,
    contains(cell) {
      return (
        cell.x >= 0 && cell.x < width && cell.y >= 0 && cell.y < height && cell.z >= 0 && cell.z < depth
      );
    },
    offsetOf(cell) {
      return (cell.x * height + cell.y) * depth + cell.z;
    },
    cellOf(offset) {
      const z = offset % depth;
      const rest = (offset - z) / depth;
      const y = rest % height;
      const x = (rest - y) / height;
      return { x, y, z };
    },
  };
}

/** The six face neighbours of a cell (orthogonal directions). */
export const FACE_NEIGHBOURS: readonly Vec3[] = buildNeighbourOffsets(false);

/** All 26 surrounding cells (faces, edges and corners). */
export const NEIGHBOURS: readonly Vec3[] = buildNeighbourOffsets(true);

/**
 * Iterates the neighbours of a cell that lie inside the board.
 *
 * Neighbour order is stable (`x`, then `y`, then `z`), which keeps reveal
 * order - and therefore the behaviour of the engine - deterministic.
 */
export function* neighboursOf(
  grid: Grid,
  cell: CellIndex,
  offsets: readonly Vec3[] = NEIGHBOURS,
): Generator<CellIndex> {
  for (const offset of offsets) {
    const neighbour = addVec3(cell, offset);
    if (grid.contains(neighbour)) yield neighbour;
  }
}

function buildNeighbourOffsets(includeDiagonals: boolean): readonly Vec3[] {
  const offsets: Vec3[] = [];
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        const distance = Math.abs(x) + Math.abs(y) + Math.abs(z);
        if (distance === 0) continue;
        if (!includeDiagonals && distance !== 1) continue;
        offsets.push({ x, y, z });
      }
    }
  }
  return Object.freeze(offsets);
}
