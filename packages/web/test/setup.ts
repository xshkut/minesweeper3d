/**
 * Test preload: installs a happy-dom browser environment on `globalThis` so
 * `@testing-library/react` can render DOM components under `bun test` without a
 * real browser or WebGL context.
 *
 * `@happy-dom/global-registrator` is not part of the dependency set, so the
 * handful of globals the React DOM test stack needs is installed explicitly
 * (plus every own enumerable property of the window, for good measure).
 */
import { Window } from "happy-dom";

const window = new Window({ url: "http://localhost/", width: 1280, height: 800 });
const globals = globalThis as unknown as Record<string, unknown>;

/** Globals that must never be shadowed by the sandbox window. */
const PROTECTED = new Set(["globalThis", "undefined", "NaN", "Infinity", "eval", "Function"]);

for (const key of Object.getOwnPropertyNames(window)) {
  if (PROTECTED.has(key)) continue;
  if (globals[key] !== undefined) continue;
  Object.defineProperty(globalThis, key, {
    value: (window as unknown as Record<string, unknown>)[key],
    writable: true,
    configurable: true,
  });
}

globals["window"] = window;
globals["document"] = window.document;
globals["navigator"] = window.navigator;

// DOM element classes live on the window prototype, not on the instance.
for (const key of [
  "Node",
  "Element",
  "HTMLElement",
  "HTMLCanvasElement",
  "HTMLInputElement",
  "HTMLSelectElement",
  "SVGElement",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "PointerEvent",
  "KeyboardEvent",
  "WheelEvent",
  "FocusEvent",
  "DOMRect",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "matchMedia",
]) {
  const value = (window as unknown as Record<string, unknown>)[key];
  if (value !== undefined) globals[key] = value;
}

// React 19 refuses to batch updates unless it knows it runs inside `act`.
globals["IS_REACT_ACT_ENVIRONMENT"] = true;
