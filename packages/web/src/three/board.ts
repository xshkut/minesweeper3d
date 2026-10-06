/**
 * Board geometry and the prototype's visual language, kept free of three.js so
 * the numbers can be reasoned about (and tested) on their own.
 */
import type { CellIndex, Vec3 } from "@minesweeper3d/game-core";
import type { Point3 } from "./orbit";

/** Edge length of one cell in world units; the prototype's `basis`. */
export const CELL_SIZE = 10;

/**
 * How far a corner is rounded off a covered cube.
 *
 * Cubes sit exactly `CELL_SIZE` apart, so rounding the corners is what creates
 * the groove between neighbours: without it the board reads as one block with
 * lines drawn on it, and with it as a tray of separate objects.
 */
export const CORNER_RADIUS = CELL_SIZE * 0.14;

/**
 * Subdivisions of a rounded corner.
 *
 * Four is the point where the corner stops looking faceted at this size; more
 * only costs vertices, since the cubes are never seen from closer than the
 * camera's near plane allows.
 */
export const CORNER_SEGMENTS = 4;

/**
 * How far towards the camera a mark floats off its cell centre.
 *
 * A glyph at the centre sits *inside* an opaque cube and is simply not drawn,
 * so every mark (the question mark, the probe result, the hover indicator) is
 * pushed out along the view direction until it clears the surface it belongs
 * to. Clearing it is a real bound rather than an eyeballed one: a cube reaches
 * `CELL_SIZE * sqrt(3) / 2` (about 0.87 of a cell) from its centre towards a
 * corner, and the default camera looks at the board from exactly that diagonal.
 * Sitting at the half-diagonal would only *touch* the cube, so this adds a
 * little over seven tenths of a cell on top - enough for the probe ball to read
 * as a ball and the question mark to hold its shape against the face behind it,
 * while staying close enough that a mark still reads as belonging to its own
 * cube. `board.test.ts` pins the lower bound, because a tidier-looking fraction
 * such as `0.75` passes every other test and silently buries every mark.
 */
export const MARK_OFFSET = CELL_SIZE * 1.6;

/** Colours ported from `scripts/entry.js`. */
export const BOARD_COLORS = Object.freeze({
  /** Covered cube tint.  Neutral: the generated block texture is the colour. */
  covered: 0xffffff,
  /** Hover overlay tint (translucent). */
  hover: 0x005555,
  /** Flagged cube tint. */
  flag: 0xffff00,
  /** Question-marked cube tint. Same hue as the glyph, so the two read as one mark. */
  questioned: 0xffa100,
  /** Cube tint after a free reveal found a mine. */
  probedMine: 0xff3b30,
  /** Cube tint after a free reveal found nothing. */
  probedSafe: 0x18c964,
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
