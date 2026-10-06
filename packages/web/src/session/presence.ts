/**
 * Multiplayer presence: where the other players of a room are pointing, and the
 * colour that stands for each of them.
 *
 * A pointer frame arrives as often as a mouse moves, so it is deliberately kept
 * out of React state: the remote session writes into a {@link CursorFeed} and
 * the render loop polls it once per frame. Re-rendering the HUD for every mouse
 * move of every player would be the expensive, wrong shape.
 */
import type { Vec3 } from "@minesweeper3d/game-core";
import type { SessionSnapshot } from "./types";

/** One player's pointer, as this client last heard of it. */
export interface CursorState {
  readonly playerId: string;
  /** `null` once the player stopped pointing or left; the marker fades out. */
  readonly cell: Vec3 | null;
}

/**
 * A mutable, render-loop-polled box of remote pointers.
 *
 * `revision` only ever grows, so a reader can tell "nothing changed" from
 * "changed to a cell that looks the same" without diffing maps.
 */
export interface CursorFeed {
  /** Latest pointer per player. Mutate only through {@link applyCursor}. */
  readonly cursors: Map<string, CursorState>;
  revision: number;
}

/** An empty feed; a private game never fills one. */
export function createCursorFeed(): CursorFeed {
  return { cursors: new Map(), revision: 0 };
}

/**
 * Records one player's pointer.
 *
 * @returns true when this was news, i.e. something visible changed
 */
export function applyCursor(feed: CursorFeed, playerId: string, cell: Vec3 | null): boolean {
  const previous = feed.cursors.get(playerId);
  if (previous === undefined && cell === null) return false;
  if (previous !== undefined && sameCell(previous.cell, cell)) return false;

  feed.cursors.set(playerId, { playerId, cell });
  feed.revision += 1;
  return true;
}

/**
 * Drops the pointers of players the room no longer seats.
 *
 * A player who left never gets to clear their own pointer, so the room frame
 * that announces the new seating is what retires it.
 *
 * @returns true when something was forgotten
 */
export function forgetCursors(feed: CursorFeed, keep: (playerId: string) => boolean): boolean {
  let changed = false;
  for (const playerId of [...feed.cursors.keys()]) {
    if (keep(playerId)) continue;
    feed.cursors.delete(playerId);
    changed = true;
  }
  if (changed) feed.revision += 1;
  return changed;
}

/** A remote player, as the roster and the scene need them. */
export interface RemoteSeat {
  readonly id: string;
  readonly name: string;
}

/**
 * Everything the scene needs in order to draw the rest of the room.
 *
 * Assembled by the app from the session snapshot and the session's feed, then
 * handed down unchanged; `undefined` in a private game, where there is nobody
 * else to draw.
 */
export interface PresenceView {
  readonly feed: CursorFeed;
  readonly seats: readonly RemoteSeat[];
}

const NO_SEATS: readonly RemoteSeat[] = [];

/**
 * The other seats of the room, in room order.
 *
 * The caller is always excluded: a client draws everybody's pointer but its
 * own, which is under its own hand.
 */
export function remoteSeats(snapshot: SessionSnapshot): readonly RemoteSeat[] {
  const players = snapshot.room?.players;
  if (players === undefined) return NO_SEATS;
  const selfId = snapshot.playerId;
  return players
    .filter((player) => player.id !== selfId)
    .map((player) => ({ id: player.id, name: player.name }));
}

/**
 * The palette a player is drawn in.
 *
 * Bright and saturated so a marker stays legible over the white board, and far
 * enough apart that two players on the same screen never look alike.
 */
export const PLAYER_COLORS = [
  "#1e88e5",
  "#e53935",
  "#43a047",
  "#8e24aa",
  "#f4511e",
  "#00897b",
  "#c0ca33",
  "#6d4c41",
] as const;

/** The colour standing for a player id: stable for the same id, always one of the eight. */
export function playerColor(playerId: string): string {
  // A tiny string hash, so a room of seats keeps the same colours on every
  // client without the server having to hand them out.
  let hash = 0;
  for (let index = 0; index < playerId.length; index += 1) {
    hash = (hash * 31 + playerId.charCodeAt(index)) >>> 0;
  }
  return PLAYER_COLORS[hash % PLAYER_COLORS.length] ?? PLAYER_COLORS[0];
}

/** True when two pointers name the same cell; `null` matches only `null`. */
export function sameCell(a: Vec3 | null, b: Vec3 | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.z === b.z;
}
