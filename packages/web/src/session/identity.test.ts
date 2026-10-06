import { describe, expect, it } from "bun:test";
import {
  createIdentity,
  defaultIdentityStorage,
  IDENTITY_NAME_KEY,
  identitySeatKey,
  type IdentityStorage,
} from "./identity";

/** A storage that records what was written to it. */
function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => void entries.set(key, value),
    removeItem: (key: string) => void entries.delete(key),
  };
}

/** A storage that throws on every access, like a locked-down browser. */
const hostileStorage: IdentityStorage = {
  getItem: () => {
    throw new Error("storage is disabled");
  },
  setItem: () => {
    throw new Error("storage is disabled");
  },
  removeItem: () => {
    throw new Error("storage is disabled");
  },
};

describe("remembered identity", () => {
  it("keeps the player name across visits", () => {
    const storage = fakeStorage();
    createIdentity(storage).rememberName("  Ada  ");
    expect(storage.entries.get(IDENTITY_NAME_KEY)).toBe("Ada");
    expect(createIdentity(storage).name()).toBe("Ada");
  });

  it("ignores a blank name rather than storing one", () => {
    const storage = fakeStorage();
    createIdentity(storage).rememberName("   ");
    expect(storage.entries.size).toBe(0);
    expect(createIdentity(storage).name()).toBeNull();
  });

  it("remembers which seat this browser holds in each room", () => {
    const storage = fakeStorage();
    const identity = createIdentity(storage);
    identity.rememberSeat("abc234", "player-1");
    identity.rememberSeat("OTHER1", "player-9");

    expect(identity.seat("ABC234")).toBe("player-1");
    expect(identity.seat("other1")).toBe("player-9");
    expect(storage.entries.has(identitySeatKey("ABC234"))).toBe(true);

    identity.forgetSeat("abc234");
    expect(identity.seat("ABC234")).toBeNull();
    expect(identity.seat("OTHER1")).toBe("player-9");
  });

  it("treats a blank stored value as absent", () => {
    const storage = fakeStorage({ [IDENTITY_NAME_KEY]: "   " });
    expect(createIdentity(storage).name()).toBeNull();
  });

  it("loses only the convenience when storage refuses to work", () => {
    const identity = createIdentity(hostileStorage);
    expect(identity.name()).toBeNull();
    expect(identity.seat("ABC234")).toBeNull();
    expect(() => identity.rememberName("Ada")).not.toThrow();
    expect(() => identity.rememberSeat("ABC234", "player-1")).not.toThrow();
    expect(() => identity.forgetSeat("ABC234")).not.toThrow();
  });

  it("falls back to an in-memory store when the browser has none", () => {
    const storage = defaultIdentityStorage();
    expect(typeof storage.getItem).toBe("function");
  });
});
