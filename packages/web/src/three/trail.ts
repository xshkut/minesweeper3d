/**
 * The trail a remote player's pointer leaves behind.
 *
 * Pure maths, no three.js: the renderer owns the spheres and simply reads a
 * {@link CursorTrail} once per frame. The model has two parts, because the
 * gesture has two parts — a *head* that slides towards the cell the other
 * player is pointing at instead of teleporting to it, and a *tail* of older
 * head positions that shrink and fade with age.
 *
 * A pointer that stops arriving completely (`null`) is not destroyed at once:
 * the trail fades out where it was, which is what makes a player sliding off
 * the board look like a pointer being lifted rather than a bug.
 */

/** A point in board space, i.e. the units {@link cellCenter} returns. */
export interface TrailPoint {
  x: number;
  y: number;
  z: number;
}

/** One past position of the head, aged in seconds. */
export interface TrailSample extends TrailPoint {
  age: number;
}

/** The mutable state of one player's pointer trail. */
export interface CursorTrail {
  /** Where the visible point currently is; it slides towards the target. */
  readonly head: TrailPoint;
  /** Past head positions, newest first, each with its own age. */
  readonly samples: TrailSample[];
  /** Fade level, `0` when invisible and `1` fully drawn. */
  opacity: number;
  /** False once a faded-out trail has nothing left to draw. */
  active: boolean;
}

/**
 * How fast the head closes the distance to its target, per second.
 *
 * Exponential rather than linear, so a pointer that hops one cell and a pointer
 * that hops ten both settle in about the same, short time.
 */
export const SLIDE_RATE = 14;

/** How long a bead stays in the tail before it has faded away. */
export const TRAIL_LIFE_SECONDS = 0.45;

/**
 * How far the head must travel before it drops another bead.
 *
 * Spacing beads by distance rather than by time is what keeps a comet shape: a
 * pointer that rests in one cell leaves no invisible pile of beads behind it.
 */
export const SAMPLE_MIN_DISTANCE = 0.4;

/** Hard cap on beads, so a fast swipe cannot grow the scene without bound. */
export const MAX_SAMPLES = 16;

/** Seconds a freshly appeared pointer spends fading in, and a lifted one fading out. */
export const FADE_IN_SECONDS = 0.12;
export const FADE_OUT_SECONDS = 0.35;

/** A trail with nothing to draw. */
export function createCursorTrail(): CursorTrail {
  return { head: { x: 0, y: 0, z: 0 }, samples: [], opacity: 0, active: false };
}

/**
 * Advances one trail by `dt` seconds towards `target`.
 *
 * A `null` target means the player stopped pointing (or left): the head stays
 * put and the whole trail fades, then reports itself inactive.
 */
export function advanceCursorTrail(trail: CursorTrail, target: TrailPoint | null, dt: number): void {
  const step = dt > 0 ? dt : 0;

  if (target === null) {
    if (!trail.active) return;
    ageSamples(trail, step);
    trail.opacity -= step / FADE_OUT_SECONDS;
    if (trail.opacity <= 0) {
      trail.opacity = 0;
      trail.active = false;
      trail.samples.length = 0;
    }
    return;
  }

  if (!trail.active) {
    // Nothing was on screen, so there is nothing to slide from: appear here.
    trail.head.x = target.x;
    trail.head.y = target.y;
    trail.head.z = target.z;
    trail.samples.length = 0;
    trail.active = true;
    trail.opacity = 0;
  }

  slide(trail.head, target, step);
  trail.opacity = Math.min(1, trail.opacity + step / FADE_IN_SECONDS);
  ageSamples(trail, step);
  dropBead(trail);
}

function slide(head: TrailPoint, target: TrailPoint, dt: number): void {
  const k = 1 - Math.exp(-SLIDE_RATE * dt);
  head.x += (target.x - head.x) * k;
  head.y += (target.y - head.y) * k;
  head.z += (target.z - head.z) * k;
}

function ageSamples(trail: CursorTrail, dt: number): void {
  for (const sample of trail.samples) sample.age += dt;
  while (trail.samples.length > 0) {
    const oldest = trail.samples[trail.samples.length - 1];
    if (oldest === undefined || oldest.age <= TRAIL_LIFE_SECONDS) break;
    trail.samples.pop();
  }
}

/** Records the head as a bead once it has moved far enough from the last one. */
function dropBead(trail: CursorTrail): void {
  const newest = trail.samples[0];
  if (newest !== undefined && distance(newest, trail.head) < SAMPLE_MIN_DISTANCE) return;

  trail.samples.unshift({ x: trail.head.x, y: trail.head.y, z: trail.head.z, age: 0 });
  if (trail.samples.length > MAX_SAMPLES) trail.samples.length = MAX_SAMPLES;
}

/** True when there is anything worth drawing. */
export function trailIsVisible(trail: CursorTrail): boolean {
  return trail.active && trail.opacity > 0;
}

function distance(a: TrailPoint, b: TrailPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
