/**
 * Style contract for the game-over overlay.
 *
 * After a loss the player wants to look at the mines the board still holds, so
 * the "Boom." panel has to stay translucent, sit above the middle of the board
 * and let the pointer through to the canvas. None of that is observable from
 * the rendered DOM (it lives in the stylesheet), so the numbers are asserted
 * here instead - a regression that made the panel opaque would hide the board
 * again, and this test is what catches it in `bun run test`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("./styles.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Declarations of the rule whose selector starts a line, e.g. `.result`. */
function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^{}]*)\\}`).exec(CSS);
  if (match === null) throw new Error(`styles.css has no rule for "${selector}"`);

  const found: Record<string, string> = {};
  for (const entry of (match[1] ?? "").split(";")) {
    const separator = entry.indexOf(":");
    if (separator === -1) continue;
    found[entry.slice(0, separator).trim()] = entry.slice(separator + 1).trim();
  }
  return found;
}

/** Substitutes `var(--x)` references, which is all the indirection the sheet uses. */
function resolve(value: string): string {
  return value
    .trim()
    .replace(/var\((--[\w-]+)\)/g, (_reference, name: string) => declarations(":root")[name] ?? "");
}

/** Alpha channel of an `rgb()`/`rgba()` colour, `1` when fully opaque. */
function alphaOf(color: string): number {
  const parts = /^rgba?\(([^)]*)\)$/.exec(resolve(color));
  if (parts === null) throw new Error(`"${color}" is not an rgb()/rgba() colour`);
  const channels = (parts[1] ?? "").split(",").map((channel) => channel.trim());
  return channels.length < 4 ? 1 : Number(channels[3]);
}

/** Length in `px`, e.g. `blur(2px)` -> `2`. */
function pxOf(value: string): number {
  const match = /(-?[\d.]+)px/.exec(resolve(value));
  if (match === null) throw new Error(`"${value}" has no px length`);
  return Number(match[1]);
}

const RESULT = declarations(".result");

describe("game-over overlay", () => {
  test("stays translucent so the board behind it remains readable", () => {
    const panel = alphaOf(declarations(":root")["--panel"] ?? "");
    const overlay = alphaOf(RESULT["background"] ?? "");

    expect(overlay).toBeLessThanOrEqual(0.5);
    expect(overlay).toBeLessThan(panel);
  });

  test("barely blurs the board it floats over", () => {
    // A strong backdrop blur smears the mines away just as effectively as an
    // opaque background would hide them.
    expect(pxOf(RESULT["backdrop-filter"] ?? "")).toBeLessThanOrEqual(4);
  });

  test("sits above the middle of the board", () => {
    const top = RESULT["top"] ?? "";
    const percent = Number(/([\d.]+)%/.exec(top)?.[1]);
    expect(percent).toBeLessThan(50);
    // At an 800px tall window the panel's centre has to clear the board centre
    // by a visible margin, otherwise it covers the mines in the middle band.
    expect(((50 - percent) / 100) * 800).toBeGreaterThanOrEqual(60);
  });

  test("lets the pointer reach the board but keeps the replay button clickable", () => {
    expect(RESULT["pointer-events"]).toBe("none");
    expect(declarations(".result .button")["pointer-events"]).toBe("auto");
  });
});
