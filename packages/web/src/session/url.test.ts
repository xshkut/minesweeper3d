import { describe, expect, it } from "bun:test";
import {
  currentRoomParam,
  normalizeRoomCode,
  readRoomParam,
  ROOM_PARAM,
  setRoomInLocation,
  writeRoomParam,
} from "./url";

interface HistoryCall {
  readonly kind: "push" | "replace";
  readonly url: string;
}

/** A fake address bar that records what a write did. */
function fakeWindow(pathname = "/", search = "") {
  const calls: HistoryCall[] = [];
  return {
    calls,
    location: { pathname, search },
    history: {
      pushState: (_data: unknown, _title: string, url: string) => void calls.push({ kind: "push", url }),
      replaceState: (_data: unknown, _title: string, url: string) => void calls.push({ kind: "replace", url }),
    },
  };
}

describe("the room parameter", () => {
  it("carries the code in a query string", () => {
    expect(ROOM_PARAM).toBe("room");
  });

  it("reads a code back, normalised", () => {
    expect(readRoomParam("?room=abc234")).toBe("ABC234");
    expect(readRoomParam("room=abc234")).toBe("ABC234");
    expect(readRoomParam("?room=%20abc234%20")).toBe("ABC234");
  });

  it("treats a missing or blank code as no code", () => {
    expect(readRoomParam("")).toBeNull();
    expect(readRoomParam("?mode=local")).toBeNull();
    expect(readRoomParam("?room=")).toBeNull();
    expect(readRoomParam("?room=%20%20")).toBeNull();
  });

  it("leaves the other parameters alone when writing", () => {
    expect(writeRoomParam("?mode=remote", "abc234")).toBe("?mode=remote&room=ABC234");
    expect(writeRoomParam("?mode=remote&room=OLD123", "new456")).toBe("?mode=remote&room=NEW456");
    expect(writeRoomParam("?room=ABC234", null)).toBe("");
    expect(writeRoomParam("?mode=local&room=ABC234", null)).toBe("?mode=local");
  });

  it("normalises a code the way the server does", () => {
    expect(normalizeRoomCode("  ab c ")).toBe("AB C");
    expect(normalizeRoomCode("")).toBe("");
  });
});

describe("writing the room into the address bar", () => {
  it("pushes a shareable link when entering a room", () => {
    const window = fakeWindow("/play", "?mode=remote");
    setRoomInLocation("abc234", window);

    expect(window.calls).toEqual([{ kind: "push", url: "/play?mode=remote&room=ABC234" }]);
  });

  it("replaces the entry when leaving, so back does not re-enter a dead room", () => {
    const window = fakeWindow("/", "?room=ABC234");
    setRoomInLocation(null, { replace: true, ...window });

    expect(window.calls).toEqual([{ kind: "replace", url: "/" }]);
  });

  it("writes to the real address bar when nothing is injected", () => {
    const before = window.location.search;
    try {
      setRoomInLocation("abc234");
      expect(currentRoomParam()).toBe("ABC234");
    } finally {
      window.history.replaceState(null, "", `${window.location.pathname}${before}`);
    }
  });
});
