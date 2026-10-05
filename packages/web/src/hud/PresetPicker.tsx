/** Board size menu, driven by the presets of the rules engine. */
import type { ReactElement } from "react";
import { GAME_PRESETS } from "@minesweeper3d/game-core";

/** Props of {@link PresetPicker}. */
export interface PresetPickerProps {
  readonly value: string;
  readonly onChange: (presetId: string) => void;
  readonly disabled?: boolean;
}

/** `<select>` with one option per preset, sizes and mine counts included. */
export function PresetPicker({ value, onChange, disabled = false }: PresetPickerProps): ReactElement {
  return (
    <label className="field">
      <span className="field__label">Board</span>
      <select
        className="field__control"
        data-testid="preset-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {GAME_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>
            {`${preset.label} — ${preset.size.x}×${preset.size.y}×${preset.size.z}, ${preset.mineCount} mines`}
          </option>
        ))}
      </select>
    </label>
  );
}
