/**
 * What the browser remembers between visits.
 *
 * All game state lives in memory on the server, so a page reload is a brand new
 * socket with no memory of who it was. Without this module that would mean a
 * *new seat*: the old one would linger as a disconnected ghost, and in a race
 * the returning player would be handed a fresh cube instead of their half-solved
 * one. Remembering the seat id lets `joinRoom` reclaim the same seat, and
 * remembering the name saves typing it again.
 *
 * Storage is optional and every access is guarded: `localStorage` throws in a
 * sandboxed iframe or when a browser has storage disabled, and losing a
 * convenience is never a reason to break the lobby.
 */

/** The slice of `localStorage` this module needs. */
export interface IdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Player name remembered from the last visit. */
export const IDENTITY_NAME_KEY = "minesweeper3d:name";

/** Seat remembered for one room. */
export function identitySeatKey(roomId: string): string {
  return `minesweeper3d:seat:${roomId.trim().toUpperCase()}`;
}

/** Identity surface used by the lobby and the app root. */
export interface Identity {
  /** The remembered name, or `null`. */
  name(): string | null;
  rememberName(name: string): void;
  /** The seat this browser holds in a room, or `null`. */
  seat(roomId: string): string | null;
  rememberSeat(roomId: string, playerId: string): void;
  forgetSeat(roomId: string): void;
}

/** In-memory stand-in used when a browser has no usable storage. */
function memoryStorage(): IdentityStorage {
  const entries = new Map<string, string>();
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

/** The real `localStorage`, or an in-memory stand-in when it is unusable. */
export function defaultIdentityStorage(): IdentityStorage {
  try {
    const candidate = (globalThis as { localStorage?: IdentityStorage }).localStorage;
    if (candidate === undefined || candidate === null) return memoryStorage();
    // Touch it: some browsers expose the object but throw on first use.
    candidate.getItem(IDENTITY_NAME_KEY);
    return candidate;
  } catch {
    return memoryStorage();
  }
}

/** Creates an identity backed by the given storage (defaults to `localStorage`). */
export function createIdentity(storage: IdentityStorage = defaultIdentityStorage()): Identity {
  const read = (key: string): string | null => {
    try {
      const value = storage.getItem(key);
      return value === null || value.trim() === "" ? null : value;
    } catch {
      return null;
    }
  };
  const write = (key: string, value: string): void => {
    try {
      storage.setItem(key, value);
    } catch {
      // A full or read-only store only costs the convenience.
    }
  };
  const drop = (key: string): void => {
    try {
      storage.removeItem(key);
    } catch {
      // Same as above.
    }
  };

  return {
    name: () => read(IDENTITY_NAME_KEY),
    rememberName: (name) => {
      const trimmed = name.trim();
      if (trimmed !== "") write(IDENTITY_NAME_KEY, trimmed);
    },
    seat: (roomId) => read(identitySeatKey(roomId)),
    rememberSeat: (roomId, playerId) => {
      if (playerId.trim() !== "") write(identitySeatKey(roomId), playerId);
    },
    forgetSeat: (roomId) => drop(identitySeatKey(roomId)),
  };
}
