/**
 * Global keyboard shortcuts. The prototype had none; they make the 3D board
 * playable without reaching for the mouse.
 *
 *   R         - new game on the current preset
 *   1         - reveal tool
 *   2 / F     - mark tool (flag, question, none)
 *   3 / Q     - free-reveal detector
 */
import { useEffect } from "react";
import type { BoardTool } from "../three/useBoardPointer";

/** Handlers invoked by {@link useKeyboardShortcuts}. */
export interface KeyboardShortcutOptions {
  readonly onNewGame: () => void;
  readonly onSelectTool: (tool: BoardTool) => void;
  /** Set to `false` to detach the listener (used by tests and modals). */
  readonly enabled?: boolean;
}

/** Keys a shortcut must never steal from a form control. */
const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** Number keys are the direct pick, letters the mnemonic one. */
const TOOL_KEYS: Readonly<Record<string, BoardTool>> = {
  "1": "reveal",
  "2": "flag",
  "3": "probe",
  f: "flag",
  q: "probe",
};

/** Installs the global key listener. */
export function useKeyboardShortcuts(options: KeyboardShortcutOptions): void {
  const { onNewGame, onSelectTool, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return undefined;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (FORM_TAGS.has(target.tagName) || target.isContentEditable) return;
      }

      const key = event.key.toLowerCase();
      if (key === "r") {
        event.preventDefault();
        onNewGame();
        return;
      }

      const tool = TOOL_KEYS[key];
      if (tool !== undefined) {
        event.preventDefault();
        onSelectTool(tool);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onNewGame, onSelectTool]);
}
