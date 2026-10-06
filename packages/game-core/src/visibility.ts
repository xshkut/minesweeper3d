/**
 * Who can find a room.
 *
 * Like the match modes, this list lives in the rules package rather than on
 * either end of the wire: the lobby renders the picker from it and the server
 * validates against it. A second copy on either side would drift.
 *
 * A private room is not a *locked* room - there are no accounts to lock it
 * with - it is an unlisted one. It is left out of the lobby's list and is
 * reachable only by its code, which is why the code is long enough that it
 * cannot be guessed: for a private room, the code *is* the access control.
 */

/** Whether the lobby lists a room. */
export type RoomVisibility = "public" | "private";

/** One row of the lobby's visibility picker. */
export interface RoomVisibilityInfo {
  readonly id: RoomVisibility;
  readonly label: string;
  /** One sentence explaining who can get in, shown under the label. */
  readonly tagline: string;
}

/** Every visibility, in the order the lobby lists them. */
export const ROOM_VISIBILITIES: readonly RoomVisibilityInfo[] = Object.freeze([
  {
    id: "public",
    label: "Public",
    tagline: "Listed in the lobby, so anyone can join.",
  },
  {
    id: "private",
    label: "Private",
    tagline: "Hidden from the lobby. Only the code or the link gets you in.",
  },
]);

/** Visibility a room gets when the caller does not ask for one. */
export const DEFAULT_ROOM_VISIBILITY: RoomVisibility = "public";

/** Looks up a visibility by id. */
export function findRoomVisibility(id: string): RoomVisibilityInfo | undefined {
  return ROOM_VISIBILITIES.find((entry) => entry.id === id);
}

/** Narrows an untrusted value to a known visibility. */
export function isRoomVisibility(value: unknown): value is RoomVisibility {
  return typeof value === "string" && findRoomVisibility(value) !== undefined;
}

/** The row for a visibility, falling back to the default so stale links work. */
export function roomVisibilityInfo(id: RoomVisibility): RoomVisibilityInfo {
  return findRoomVisibility(id) ?? (findRoomVisibility(DEFAULT_ROOM_VISIBILITY) as RoomVisibilityInfo);
}
