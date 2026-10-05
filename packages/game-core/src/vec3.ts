import type { CellIndex, Vec3 } from "./types";

/** Creates a vector, mostly to keep fixtures readable. */
export function vec3(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Component-wise sum. */
export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

/** Strict value equality. */
export function equalsVec3(a: Vec3, b: Vec3): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

/** Stable string key, handy for sets, maps and test expectations. */
export function cellKey(cell: Vec3): string {
  return `${cell.x},${cell.y},${cell.z}`;
}

/** Human readable coordinates for log and error messages. */
export function formatVec3(cell: Vec3): string {
  return `(${cell.x}, ${cell.y}, ${cell.z})`;
}

/** Type guard for `{x, y, z}` shaped values with finite numbers. */
export function isVec3(value: unknown): value is Vec3 {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isFiniteNumber(candidate["x"]) && isFiniteNumber(candidate["y"]) && isFiniteNumber(candidate["z"]);
}

/** Type guard for integral lattice coordinates. */
export function isCellIndex(value: unknown): value is CellIndex {
  return isVec3(value) && Number.isInteger(value.x) && Number.isInteger(value.y) && Number.isInteger(value.z);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
