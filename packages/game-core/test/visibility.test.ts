import { describe, expect, it } from "bun:test";
import type { RoomVisibility } from "../src/index";
import {
  DEFAULT_ROOM_VISIBILITY,
  findRoomVisibility,
  isRoomVisibility,
  roomVisibilityInfo,
  ROOM_VISIBILITIES,
} from "../src/index";

describe("room visibility", () => {
  it("lists public before private, each with a label and a tagline", () => {
    expect(ROOM_VISIBILITIES.map((entry) => entry.id)).toEqual(["public", "private"]);
    expect(ROOM_VISIBILITIES.map((entry) => entry.label)).toEqual(["Public", "Private"]);
    for (const entry of ROOM_VISIBILITIES) {
      expect(entry.tagline.length).toBeGreaterThan(0);
    }
  });

  it("defaults to a listed room", () => {
    expect(DEFAULT_ROOM_VISIBILITY).toBe("public");
    expect(findRoomVisibility(DEFAULT_ROOM_VISIBILITY)?.id).toBe("public");
  });

  it("narrows untrusted values", () => {
    expect(isRoomVisibility("public")).toBe(true);
    expect(isRoomVisibility("private")).toBe(true);
    expect(isRoomVisibility("secret")).toBe(false);
    expect(isRoomVisibility(undefined)).toBe(false);
    expect(isRoomVisibility(7)).toBe(false);
  });

  it("falls back to the default row for an unknown id", () => {
    expect(roomVisibilityInfo("private").label).toBe("Private");
    expect(roomVisibilityInfo("secret" as RoomVisibility).id).toBe("public");
  });
});
