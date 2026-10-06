/**
 * The three ways a room can be played, and the boring arithmetic that goes with
 * them (how many mines a tier means on a given board, how long a co-op round
 * gets).
 *
 * Modes live in the rules package rather than the server because both ends of
 * the wire need the same list: the lobby renders the picker from it and the
 * server validates against it. A second copy on either side would drift.
 */

import { cellCountOf, DEFAULT_DIFFICULTY_ID, type DifficultyId } from "./difficulty";
import type { Vec3 } from "./types";

/** How a room is scored. */
export type MatchMode = "coop" | "race" | "survival";

/** Lifecycle of a room's round, independent of any single board's status. */
export type MatchStatus = "ready" | "playing" | "won" | "lost";

/**
 * Every match status.
 *
 * Spelled out because a round is sometimes reconstructed from bytes we did not
 * write (a state file left by an older build), where a status has to be checked
 * against the same closed set the room service commits.
 */
export const MATCH_STATUSES: readonly MatchStatus[] = Object.freeze([
  "ready",
  "playing",
  "won",
  "lost",
]);

/** One row of the lobby's mode picker. */
export interface MatchModeInfo {
  readonly id: MatchMode;
  readonly label: string;
  /** One sentence explaining the rules, shown under the label. */
  readonly tagline: string;
  /** Mine density preselected for this mode. */
  readonly defaultDifficultyId: DifficultyId;
  /** Seats a fresh room of this mode offers. */
  readonly defaultMaxPlayers: number;
}

/** Every mode, in the order the lobby lists them. */
export const MATCH_MODES: readonly MatchModeInfo[] = Object.freeze([
  {
    id: "coop",
    label: "Co-op",
    tagline: "One cube, one clock. Clear every safe cell together before time runs out.",
    defaultDifficultyId: DEFAULT_DIFFICULTY_ID,
    defaultMaxPlayers: 8,
  },
  {
    id: "race",
    label: "Race",
    tagline: "Everyone gets the same cube. First to disarm it wins.",
    defaultDifficultyId: DEFAULT_DIFFICULTY_ID,
    defaultMaxPlayers: 8,
  },
  {
    id: "survival",
    label: "Survival",
    tagline: "One cube, thick with mines. Step on one and you are out - last player standing wins.",
    // Survival lives up to its name: it starts at the densest tier.
    defaultDifficultyId: "super-hard",
    defaultMaxPlayers: 8,
  },
]);

/** Mode used when the caller does not ask for one. */
export const DEFAULT_MATCH_MODE: MatchMode = "coop";

/** Looks up a mode by id. */
export function findMatchMode(id: string): MatchModeInfo | undefined {
  return MATCH_MODES.find((mode) => mode.id === id);
}

/** Narrows an untrusted value to a known mode. */
export function isMatchMode(value: unknown): value is MatchMode {
  return typeof value === "string" && findMatchMode(value) !== undefined;
}

/** Narrows an untrusted value to a known round status. */
export function isMatchStatus(value: unknown): value is MatchStatus {
  return typeof value === "string" && MATCH_STATUSES.some((status) => status === value);
}

/** The mode's row, falling back to the default so stale links still work. */
export function matchModeInfo(id: MatchMode): MatchModeInfo {
  return findMatchMode(id) ?? (findMatchMode(DEFAULT_MATCH_MODE) as MatchModeInfo);
}

/** Mode default difficulty, resolved through the ladder. */
export function defaultDifficultyForMode(id: MatchMode): DifficultyId {
  return matchModeInfo(id).defaultDifficultyId;
}

/** Not every mode is played against a clock. */
export function usesClock(mode: MatchMode): boolean {
  return mode === "coop";
}

/** A mine costs the player who opened it their seat, rather than the round. */
export function hasEliminations(mode: MatchMode): boolean {
  return mode === "survival";
}

/**
 * `true` when every player digs on the same board.
 *
 * Co-op and survival share one cube so the team (or the pack) can see what the
 * others uncovered; a race hands everybody a private copy of the same cube so
 * nobody can clear a path for a rival.
 */
export function sharesBoard(mode: MatchMode): boolean {
  return mode === "coop" || mode === "survival";
}

/** Time budget for a co-op round: roughly 1.2s per safe cell. */
export const COOP_MS_PER_SAFE_CELL = 1200;
/** Nobody should lose a co-op round in under a minute. */
export const COOP_MIN_TIME_MS = 60_000;
/** ...nor sit in front of one for more than a quarter of an hour. */
export const COOP_MAX_TIME_MS = 900_000;

/**
 * How long a co-op round on this board may last.
 *
 * Derived from the work on the board rather than fixed, so switching to a
 * bigger cube does not silently turn a comfortable limit into an impossible
 * one. Rounded to whole seconds and clamped to a sane window.
 */
export function coopTimeLimitMs(size: Vec3, mineCount: number): number {
  const safeCells = Math.max(1, cellCountOf(size) - mineCount);
  const raw = safeCells * COOP_MS_PER_SAFE_CELL;
  const clamped = Math.min(COOP_MAX_TIME_MS, Math.max(COOP_MIN_TIME_MS, raw));
  return Math.round(clamped / 1000) * 1000;
}
