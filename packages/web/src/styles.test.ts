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

const DOCK = declarations(".hud-dock");
const HUD = declarations(".hud");
const HUD_COLLAPSED = declarations(".hud-dock:not([data-open]) .hud");

describe("sliding HUD panel", () => {
  test("the dock is a rail, so clicks reach the board behind it", () => {
    // The dock spans the panel's width even while the panel is translated out
    // of the way; without this a transparent div would swallow board clicks.
    expect(DOCK["pointer-events"]).toBe("none");
    expect(HUD["pointer-events"]).toBe("auto");
    expect(declarations(".hud-dock__toggle")["pointer-events"]).toBe("auto");
  });

  test("the collapsed panel slides fully off the left edge and animates", () => {
    expect(HUD["transition"]).toContain("transform");
    expect(HUD_COLLAPSED["visibility"]).toBe("hidden");

    const slide = /translateX\(calc\((-?[\d.]+)%/.exec(HUD_COLLAPSED["transform"] ?? "");
    expect(slide).not.toBeNull();
    // A partial slide would leave the panel hanging over the board.
    expect(Number(slide?.[1])).toBeLessThanOrEqual(-100);
  });

  test("hiding is delayed until the slide is over", () => {
    // `visibility: hidden` immediately would cut the animation short.
    const timing = HUD_COLLAPSED["transition"] ?? "";
    expect(timing).toContain("visibility 0s linear 220ms");
  });
});

describe("tool switch", () => {
  test("the three tools share the row and the panel's two columns", () => {
    const tools = declarations(".tools");
    // A grid child of `.hud__buttons`, which is two columns wide.
    expect(tools["grid-column"]).toBe("span 2");
    expect(tools["grid-template-columns"]).toBe("repeat(3, minmax(0, 1fr))");
  });

  test("reset view still spans the panel after the tool row", () => {
    expect(declarations(".hud__buttons .tools + .button")["grid-column"]).toBe("span 2");
  });

  test("a spent detector is visibly out of order rather than merely inert", () => {
    expect(declarations(".tools__button:disabled")["opacity"]).toBe("0.45");
  });
});

/*
 * Touch.
 *
 * A finger is also how a phone scrolls the page, so the canvas has to claim the
 * gesture for itself - without `touch-action: none` an orbit drag scrolls or
 * zooms the page instead. The HUD is left able to scroll, since a phone in
 * landscape cannot show the whole panel. The rest is ergonomics: taps have to
 * land on targets a fingertip can hit, and the panels stay clear of the notch.
 */
describe("touch screen", () => {
  test("the canvas claims the gesture instead of letting the page scroll", () => {
    expect(declarations(".canvas-shell canvas")["touch-action"]).toBe("none");
  });

  test("the page cannot be pulled or bounced out of the game", () => {
    // Asserted as a declaration rather than through `declarations()`: the root
    // selector list is wrapped over several lines.
    expect(CSS).toMatch(/overscroll-behavior:\s*none/);
  });

  test("the HUD clears the notch and the home indicator", () => {
    expect(DOCK["top"]).toContain("var(--safe-top)");
    expect(DOCK["left"]).toContain("var(--safe-left)");
  });

  test("a touch device gets controls sized for a fingertip", () => {
    // A block of its own, so the 44px floor cannot be lost in a later edit.
    const coarse = CSS.slice(CSS.indexOf("@media (pointer: coarse)"));
    expect(coarse.length).toBeGreaterThan(0);
    expect(coarse).toContain("min-height: 44px");
  });

  test("the notice overlay does not swallow the tap that follows it", () => {
    expect(declarations(".notice")["pointer-events"]).toBe("none");
  });

  test("the folded-panel strip clears the notch and takes no taps", () => {
    const strip = declarations(".compact-status");
    expect(strip["top"]).toContain("var(--safe-top)");
    expect(strip["right"]).toContain("var(--safe-right)");
    // It sits over the board, so a tap has to pass through it.
    expect(strip["pointer-events"]).toBe("none");
  });
});
