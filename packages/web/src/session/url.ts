/**
 * The room code in the page URL.
 *
 * Putting the code in the address bar is what makes a room shareable: the link
 * *is* the invitation, and for a private room - which the lobby never lists - it
 * is the only one. The functions here are pure string transforms so they can be
 * tested without a browser; {@link setRoomInLocation} is the thin wrapper that
 * touches `history`.
 */

/** Query parameter that carries the room code. */
export const ROOM_PARAM = "room";

/** Normalises a user- or URL-supplied code the way the server does. */
export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** Reads the room code out of a query string, or `null` when there is none. */
export function readRoomParam(search: string): string | null {
  const value = new URLSearchParams(search).get(ROOM_PARAM);
  if (value === null) return null;
  const code = normalizeRoomCode(value);
  return code === "" ? null : code;
}

/**
 * Rewrites a query string with (or without) a room code, leaving every other
 * parameter exactly where it was.
 */
export function writeRoomParam(search: string, roomId: string | null): string {
  const params = new URLSearchParams(search);
  if (roomId === null) params.delete(ROOM_PARAM);
  else params.set(ROOM_PARAM, normalizeRoomCode(roomId));
  const next = params.toString();
  return next === "" ? "" : `?${next}`;
}

/** Options of {@link setRoomInLocation}. */
export interface SetRoomOptions {
  /**
   * Replace the current entry instead of pushing a new one.
   *
   * Leaving a room replaces, so the back button does not walk into a room that
   * no longer exists; entering pushes, so it does walk back to the lobby.
   */
  readonly replace?: boolean;
  /** Injectable for tests; defaults to the current window. */
  readonly location?: { pathname: string; search: string };
  readonly history?: { pushState(data: unknown, title: string, url: string): void; replaceState(data: unknown, title: string, url: string): void };
}

/** Writes the room code into the address bar. */
export function setRoomInLocation(roomId: string | null, options: SetRoomOptions = {}): void {
  const location = options.location ?? (typeof window === "undefined" ? undefined : window.location);
  const history = options.history ?? (typeof window === "undefined" ? undefined : window.history);
  if (location === undefined || history === undefined) return;

  const url = `${location.pathname}${writeRoomParam(location.search, roomId)}`;
  if (options.replace === true) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
}

/** Calls `listener` whenever the browser navigates back or forward. */
export function onRoomParamChange(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
}

/** The room code of the current address bar, if any. */
export function currentRoomParam(): string | null {
  if (typeof window === "undefined") return null;
  return readRoomParam(window.location.search);
}
