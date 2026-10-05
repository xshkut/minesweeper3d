/**
 * Second-order smoothing, a delta-time based port of the prototype's
 * `scripts/motion.js`.
 *
 * The original integrated against `Date.now()` and could overshoot its target;
 * this version is a pure function of the time steps it is given (so it is
 * deterministic in tests and identical on every machine) and it stops exactly
 * on the target instead of oscillating around it.
 */

/** Distance at which a motion snaps onto its target. */
export const DEFAULT_SNAP_DISTANCE = 0.01;
/** Speed below which a motion is considered at rest. */
export const DEFAULT_SNAP_VELOCITY = 0.05;
/**
 * Largest time step a single `step` call integrates.
 *
 * Explicit integration of a stiff spring explodes when the frame delta is much
 * larger than `T2` (a background tab produces deltas of seconds), so longer
 * frames are clamped instead of launching the camera into space.
 */
export const MAX_STEP_SECONDS = 1 / 30;

/** Construction options of a {@link Motion}. */
export interface MotionOptions {
  /** Initial value. */
  readonly value: number;
  /** First-order time constant; with `T2 = 0` this is "time to reach target". */
  readonly T1?: number;
  /** Second-order time constant; `0` disables the spring (first-order mode). */
  readonly T2?: number;
  /** Initial speed, in units per second. */
  readonly velocity?: number;
  readonly snapDistance?: number;
  readonly snapVelocity?: number;
}

/**
 * Smoothly moves a single scalar towards a target.
 *
 * Mirrors the prototype's two modes: `T2 = 0` is an exponential approach,
 * `T2 > 0` is the critically damped spring used for the camera position.
 */
export class Motion {
  readonly T1: number;
  readonly T2: number;
  readonly snapDistance: number;
  readonly snapVelocity: number;

  private current: number;
  private goal: number;
  private speed: number;
  private atRest: boolean;

  constructor(options: MotionOptions) {
    this.T1 = options.T1 ?? 0.5;
    this.T2 = options.T2 ?? 0;
    this.snapDistance = options.snapDistance ?? DEFAULT_SNAP_DISTANCE;
    this.snapVelocity = options.snapVelocity ?? DEFAULT_SNAP_VELOCITY;
    this.current = options.value;
    this.goal = options.value;
    this.speed = options.velocity ?? 0;
    this.atRest = true;
  }

  /** Current value. */
  get value(): number {
    return this.current;
  }

  /** Value the motion is heading for. */
  get target(): number {
    return this.goal;
  }

  /** Current speed in units per second. */
  get velocity(): number {
    return this.speed;
  }

  /** `true` once the motion sits exactly on its target. */
  get settled(): boolean {
    return this.atRest && this.current === this.goal;
  }

  /** Starts moving towards `target`; a new target mid-flight is picked up immediately. */
  setTarget(target: number): void {
    if (target === this.goal) return;
    this.goal = target;
    this.atRest = false;
  }

  /** Teleports to a value, cancelling any motion. */
  reset(value: number, target: number = value): void {
    this.current = value;
    this.goal = target;
    this.speed = 0;
    this.atRest = value === target;
  }

  /**
   * Advances the motion.
   *
   * @param dtSeconds elapsed time; non-finite and negative values are ignored
   * @returns the new value
   */
  step(dtSeconds: number): number {
    if (this.atRest || !Number.isFinite(dtSeconds) || dtSeconds <= 0) return this.current;

    const dt = Math.min(dtSeconds, MAX_STEP_SECONDS);
    if (this.T2 === 0) {
      this.speed = (this.goal - this.current) / this.T1;
    } else {
      const acceleration = (this.goal - this.current - this.T1 * this.speed) / (this.T2 * this.T2);
      this.speed += acceleration * dt;
    }

    const previous = this.current;
    const next = previous + this.speed * dt;
    const distance = Math.abs(next - this.goal);
    const crossed = (next - this.goal) * (previous - this.goal) < 0;

    this.current = next;
    if (crossed || (distance <= this.snapDistance && Math.abs(this.speed) <= this.snapVelocity)) {
      this.snap();
    }
    return this.current;
  }

  /** Jumps straight onto the target and stops. */
  snap(): void {
    this.current = this.goal;
    this.speed = 0;
    this.atRest = true;
  }
}

/** A {@link Point3} shaped value, kept three.js free. */
export interface Vector3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Three {@link Motion}s moved together, used for camera position and aim. */
export class MotionVector {
  private readonly x: Motion;
  private readonly y: Motion;
  private readonly z: Motion;

  constructor(options: Omit<MotionOptions, "value"> & { readonly value: Vector3Like }) {
    const { value, ...rest } = options;
    this.x = new Motion({ ...rest, value: value.x });
    this.y = new Motion({ ...rest, value: value.y });
    this.z = new Motion({ ...rest, value: value.z });
  }

  get value(): Vector3Like {
    return { x: this.x.value, y: this.y.value, z: this.z.value };
  }

  get settled(): boolean {
    return this.x.settled && this.y.settled && this.z.settled;
  }

  /** Retargets all three axes. */
  setTarget(target: Vector3Like): void {
    this.x.setTarget(target.x);
    this.y.setTarget(target.y);
    this.z.setTarget(target.z);
  }

  /** Teleports all three axes, cancelling any motion. */
  reset(value: Vector3Like, target: Vector3Like = value): void {
    this.x.reset(value.x, target.x);
    this.y.reset(value.y, target.y);
    this.z.reset(value.z, target.z);
  }

  /** Advances all three axes and returns the new value. */
  step(dtSeconds: number): Vector3Like {
    this.x.step(dtSeconds);
    this.y.step(dtSeconds);
    this.z.step(dtSeconds);
    return this.value;
  }
}
