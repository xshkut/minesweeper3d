/**
 * Which action a left click on a covered cube performs.
 *
 * Three tools act on the same cubes, so the choice has to be visible and
 * switchable at a glance: the buttons are `aria-pressed` toggles, each carries
 * its shortcut in the label, and the probe button disables itself when the
 * board has no charges left.
 */
import type { ReactElement } from "react";
import type { BoardTool } from "../three/useBoardPointer";

/** Props of {@link ToolPicker}. */
export interface ToolPickerProps {
  readonly value: BoardTool;
  readonly onChange: (tool: BoardTool) => void;
  /** Free reveals still available; `0` disables the detector. */
  readonly freeRevealsLeft: number;
  readonly disabled?: boolean;
}

interface ToolOption {
  readonly id: BoardTool;
  readonly label: string;
  readonly title: string;
}

const TOOLS: readonly ToolOption[] = [
  {
    id: "reveal",
    label: "Dig",
    title: "Dig a cell open (1). Alt+click or the middle button always marks instead.",
  },
  {
    id: "flag",
    label: "Mark",
    title: "Cycle a cell's mark: flag, question mark, nothing (2 or F).",
  },
  {
    id: "probe",
    label: "Detector",
    title: "Spend a free reveal to learn whether a covered cell hides a mine (3 or Q).",
  },
];

/** Three-way tool switch. */
export function ToolPicker({
  value,
  onChange,
  freeRevealsLeft,
  disabled = false,
}: ToolPickerProps): ReactElement {
  return (
    <div className="tools" role="group" aria-label="Cell tool">
      {TOOLS.map((tool) => {
        const outOfCharges = tool.id === "probe" && freeRevealsLeft <= 0;
        return (
          <button
            key={tool.id}
            type="button"
            className="button tools__button"
            data-testid={`tool-${tool.id}`}
            aria-pressed={value === tool.id}
            title={outOfCharges ? "No free reveals left on this board" : tool.title}
            disabled={disabled || outOfCharges}
            onClick={() => onChange(tool.id)}
          >
            {tool.label}
          </button>
        );
      })}
    </div>
  );
}
