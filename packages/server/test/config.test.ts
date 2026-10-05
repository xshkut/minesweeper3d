/**
 * Configuration is the first thing the process touches, so the tests here pin
 * every default, every override and both failure modes (bad port, bad level).
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { defaultWebDist, loadServerConfig, SERVER_VERSION } from "../src/config";
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
