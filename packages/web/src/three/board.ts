/**
 * Board geometry and the prototype's visual language, kept free of three.js so
 * the numbers can be reasoned about (and tested) on their own.
 */
import type { CellIndex, Vec3 } from "@minesweeper3d/game-core";
import type { Point3 } from "./orbit";

/** Edge length of one cell in world units; the prototype's `basis`. */
export const CELL_SIZE = 10;

/** Colours ported from `scripts/entry.js`. */
export const BOARD_COLORS = Object.freeze({
  /** Covered cube tint.  Neutral: the generated block texture is the colour. */
  covered: 0xffffff,
  /** Hover overlay tint (translucent). */
  hover: 0x005555,
  /** Flagged cube tint. */
  flag: 0xffff00,
  /** Mine tint, red while playing and lost. */
  mine: 0xff0000,
  /** Mine tint once the game is won. */
  mineWon: 0x00ff00,
  /** Adjacency numbers. */
  number: 0x66ff00,
  /** Floating question mark of the hover indicator. */
  question: 0xffa100,
  /** Background used until the cubemap has loaded. */
  background: 0xbbbbbb,
  /** Ambient light colour. */
  ambient: 0x444444,
});

/** Centre of a cell in world space; the board itself is centred on the origin. */
export function cellCenter(cell: CellIndex, size: Vec3): Point3 {
  return {
    x: (cell.x + 0.5) * CELL_SIZE - (size.x * CELL_SIZE) / 2,
    y: (cell.y + 0.5) * CELL_SIZE - (size.y * CELL_SIZE) / 2,
    z: (cell.z + 0.5) * CELL_SIZE - (size.z * CELL_SIZE) / 2,
  };
}

/** Centre of the whole board, i.e. the origin. */
export function boardCenter(): Point3 {
  return { x: 0, y: 0, z: 0 };
}

/** Longest board edge in world units. */
export function boardExtent(size: Vec3): number {
  return Math.max(size.x, size.y, size.z) * CELL_SIZE;
}

/**
 * Camera distance used when a board is first shown.
 *
 * The prototype framed a 5x5x5 board from `(100, 100, 100)` around a target at
 * `(25, 25, 25)`, i.e. a distance of `1.5 * sqrt(3)` board extents; keeping that
 * ratio means every preset opens with the same amount of empty space around it.
 */
export function initialRadius(size: Vec3): number {
  return boardExtent(size) * 1.5 * Math.sqrt(3);
}

/** Azimuth of the prototype's opening camera. */
export const INITIAL_AZIMUTH = Math.PI / 4;

/** Polar angle of the prototype's opening camera (looking down at ~35 degrees). */
export const INITIAL_POLAR = Math.acos(Math.sqrt(2 / 3));

/** Orientation a board opens with. */
export function initialOrientation(): { readonly azimuth: number; readonly polar: number } {
  return { azimuth: INITIAL_AZIMUTH, polar: INITIAL_POLAR };
}
