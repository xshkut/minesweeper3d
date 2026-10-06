/**
 * Configuration is the first thing the process touches, so the tests here pin
 * every default, every override and both failure modes (bad port, bad level).
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defaultStateFile, defaultWebDist, loadServerConfig, SERVER_VERSION } from "../src/config";
import { ROOM_TTL_MS } from "../src/rooms/service";
import { REPO_ROOT } from "./support";

describe("loadServerConfig", () => {
  test("applies defaults for an empty environment", () => {
    const config = loadServerConfig({});

    expect(config.port).toBe(8000);
    expect(config.host).toBe("0.0.0.0");
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("info");
    expect(config.version).toBe(SERVER_VERSION);
    expect(config.webDist).toBe(defaultWebDist());
    expect(config.webDist).toBe(resolve(REPO_ROOT, "packages", "web", "dist"));
  });

  test("returns a frozen object", () => {
    expect(Object.isFrozen(loadServerConfig({}))).toBe(true);
  });

  test("reads every override", () => {
    const config = loadServerConfig({
      PORT: "8123",
      HOST: "127.0.0.1",
      NODE_ENV: "production",
      WEB_DIST: "custom/dist",
      LOG_LEVEL: "DEBUG",
    });

    expect(config.port).toBe(8123);
    expect(config.host).toBe("127.0.0.1");
    expect(config.nodeEnv).toBe("production");
    expect(config.logLevel).toBe("debug");
    expect(config.webDist).toBe(resolve("custom/dist"));
  });

  test("treats blank variables as unset", () => {
    const config = loadServerConfig({ PORT: "  ", LOG_LEVEL: "", HOST: "" });

    expect(config.port).toBe(8000);
    expect(config.logLevel).toBe("info");
    expect(config.host).toBe("0.0.0.0");
  });

  test("rejects a non-numeric, fractional or out-of-range port", () => {
    for (const bad of ["abc", "0", "65536", "-1", "1.5", "8080x"]) {
      expect(() => loadServerConfig({ PORT: bad })).toThrow(/PORT/);
    }
  });

  test("accepts the port range boundaries", () => {
    expect(loadServerConfig({ PORT: "1" }).port).toBe(1);
    expect(loadServerConfig({ PORT: "65535" }).port).toBe(65535);
  });

  test("rejects an unknown log level", () => {
    expect(() => loadServerConfig({ LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });
});

describe("state file configuration", () => {
  test("defaults to a temporary file that belongs to this port", () => {
    const config = loadServerConfig({});

    expect(config.stateFile).toBe(defaultStateFile(8000));
    expect(config.stateFile).toContain("minesweeper3d");
    // Two servers on one host must not overwrite each other's rooms.
    expect(loadServerConfig({ PORT: "8001" }).stateFile).not.toBe(config.stateFile);
  });

  test("resolves a relative path against the working directory", () => {
    expect(loadServerConfig({ STATE_FILE: ".tmp/state.json" }).stateFile).toBe(resolve(".tmp/state.json"));
  });

  test("turns persistence off on request, and a blank value keeps the default", () => {
    for (const off of ["off", "none", "memory", "DISABLED", " off "]) {
      expect(loadServerConfig({ STATE_FILE: off }).stateFile).toBeUndefined();
    }
    expect(loadServerConfig({ STATE_FILE: "" }).stateFile).toBe(defaultStateFile(8000));
  });

  test("defaults the room TTL to a day", () => {
    expect(loadServerConfig({}).roomTtlMs).toBe(ROOM_TTL_MS);
    expect(ROOM_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });

  test("reads a room TTL override and rejects a nonsense one", () => {
    expect(loadServerConfig({ ROOM_TTL_MS: "60000" }).roomTtlMs).toBe(60_000);

    for (const bad of ["0", "-1", "1.5", "soon"]) {
      expect(() => loadServerConfig({ ROOM_TTL_MS: bad })).toThrow(/ROOM_TTL_MS/);
    }
  });
});
