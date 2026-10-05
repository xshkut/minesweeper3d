/**
 * Global keyboard shortcuts. The prototype had none; they make the 3D board
 * playable without reaching for the mouse.
 *
 *   R - new game on the current preset
 *   F - toggle flag mode
 */
import { useEffect } from "react";

/** Handlers invoked by {@link useKeyboardShortcuts}. */
export interface KeyboardShortcutOptions {
  readonly onNewGame: () => void;
  readonly onToggleFlagMode: () => void;
  /** Set to `false` to detach the listener (used by tests and modals). */
  readonly enabled?: boolean;
}

/** Keys a shortcut must never steal from a form control. */
const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** Installs the global key listener. */
export function useKeyboardShortcuts(options: KeyboardShortcutOptions): void {
  const { onNewGame, onToggleFlagMode, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return undefined;

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (FORM_TAGS.has(target.tagName) || target.isContentEditable) return;
      }

      switch (event.key.toLowerCase()) {
        case "r":
          event.preventDefault();
          onNewGame();
          break;
        case "f":
          event.preventDefault();
          onToggleFlagMode();
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [enabled, onNewGame, onToggleFlagMode]);
}
